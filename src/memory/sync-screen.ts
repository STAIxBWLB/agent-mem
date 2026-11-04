import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { join } from "node:path";
import { checkedEntry } from "./bridge.ts";
import { loadAmemConfig } from "./config.ts";
import { createStandalonePolicy, type StandalonePolicyDecline } from "./policy.ts";
import type { MemoryStore } from "./store.ts";

/**
 * F4 (agent-mem#40): what leaves this machine is screened by the person's configured policy. Sync pushes this machine's own long-term segment
 * (`log/<machine>.jsonl`) to a private remote. Before it does, every note in that segment is read through the configured standalone policy (secrets,
 * personal data, the configured PII patterns and deny paths). One declined entry refuses the whole sync and names the ids (never the text), because a
 * partial push would silently drop it while it stays in the log.
 *
 * What is read is what goes out. A single-log home pushes this machine's own segment, so that file is read. A generation or sharded home publishes rows from the
 * verified snapshot (this machine's own rows and its bridged legacy rows, wherever they sit on disk, e.g. under `legacy/log/` after a shard migration), so those
 * rows are read, for the canonical shard and its user overlay alike. The other machines' rows came from the remote and were screened where they were written.
 * The policy is the machine's configured one AND whatever the caller adds (the CLI adds the repository-narrowed policy), so a repository's `.amem/config` binds sync too.
 * Reads only (the log is append-only). Bounded: over `MAX_ROWS` rows or `MAX_BYTES` it refuses, since an unscreened row must not pass because the
 * scan gave up.
 * ponytail: a person clears a declined entry by removing the offending pattern or editing the policy; sync does not skip a row, and `amem forget` is an
 * append-only op that leaves the original row in the log. Upgrade: a per-row placement that keeps a declined note local without refusing the sync.
 */
export const SYNC_SCREEN_MAX_BYTES = 8 * 1024 * 1024, SYNC_SCREEN_MAX_ROWS = 20_000;
const MAX_BYTES = SYNC_SCREEN_MAX_BYTES, MAX_ROWS = SYNC_SCREEN_MAX_ROWS;

export type SyncScreen = { ok: true } | { ok: false; reason: string };

/**
 * What a row says: everything except the fields the library itself generates (ids, hashes, times, the op and enum names, machine and actor ids). Left IN on purpose
 * are `project`, `peer`, `task`, `about`, `title`, `text`, `milestones` and any field this file has never heard of: an unknown text field must be screened, never skipped.
 */
const GENERATED = new Set(["id", "schema", "op", "at", "machine", "actor", "target", "promotedFrom", "supersedes", "expires", "by", "tier", "scope", "kind", "source"]);
export function syncOutboundContent(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row) || types.isProxy(row) || Object.getOwnPropertySymbols(row).length) throw new Error("outbound row unavailable");
  const out: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(row))) {
    if (GENERATED.has(key)) continue;
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error("outbound row unavailable");
    Object.defineProperty(out, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** A row passes when the machine's configured policy and the caller's extra screen (if any) both accept its text. */
export type RowScreen = (row: Record<string, unknown>) => boolean;
export type SyncPolicyCategory = StandalonePolicyDecline | "host";
export type OutboundVerdict = { ok: true } | { ok: false; category: SyncPolicyCategory };
/** One evaluator for actual sync and public inspection, with the same projection and AND composition. */
export function outboundPolicyEvaluator(home: string, extra?: RowScreen): (row: Record<string, unknown>) => OutboundVerdict {
  const { config } = loadAmemConfig(home);
  const policy = createStandalonePolicy({ denyPaths: config.denyPaths, piiPatterns: config.piiPatterns });
  return row => {
    const text = syncOutboundContent(row), own = policy.inspectStandalone(text);
    if (!own.ok) return own;
    const accepted = extra === undefined ? true : extra(text);
    if (typeof accepted !== "boolean") throw new Error("outbound policy unavailable");
    return accepted ? { ok: true } : { ok: false, category: "host" };
  };
}
export function outboundScreen(home: string, extra?: RowScreen): RowScreen {
  const evaluate = outboundPolicyEvaluator(home, extra);
  return row => evaluate(row).ok;
}
const refusal = (declined: string[]): SyncScreen => declined.length ? { ok: false, reason: `the configured privacy policy declines ${declined.length} long-term entr${declined.length === 1 ? "y" : "ies"} (${declined.slice(0, 8).join(", ")}${declined.length > 8 ? ", ..." : ""}); fix the entry or the policy, then sync again` } : { ok: true };
const idOf = (row: Record<string, unknown>) => typeof row.id === "string" ? row.id.slice(0, 8) : "(no id)";

/** Screen the rows a generation or sharded store would publish: its snapshot's synced rows that are this machine's own or bridged from its legacy input. */
export function screenOutboundRows(store: MemoryStore, pass: RowScreen): SyncScreen {
  const declined: string[] = [];
  let rows = 0;
  // Actual sync retains its existing canonical refresh/recovery snapshot. Public inspection uses the read-only
  // source visitor instead, so it never performs this derived-state mutation or adopts a torn prune recovery tail.
  try {
    const snapshot = store.prunePort().snapshot();
    for (const source of snapshot.rows) {
      if (source.placement !== "synced" || !(source.own || source.legacy)) continue;
      if (++rows > MAX_ROWS) return { ok: false, reason: `more than ${MAX_ROWS} long-term rows, so they were not screened` };
      if (!pass(source.row as unknown as Record<string, unknown>)) declined.push(idOf(source.row as unknown as Record<string, unknown>));
    }
  } catch { return { ok: false, reason: "this store's long-term rows cannot be read, so they were not screened; inspect the local inputs and reopen the store before retrying" }; }
  return refusal(declined);
}

export class SyncScreenInputError extends Error {
  constructor(readonly code: "input-unavailable" | "input-bound" | "input-changed", readonly bound?: "bytes" | "rows") { super(code); }
}
const sameStat = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** One bounded physical segment. The returned check pins it across the other opened targets and host callbacks too. */
export function visitOwnSegment(dir: string, machineId: string, visit: (row: Record<string, unknown>) => void): () => void {
  const parent = join(dir, "log"), parentStat = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
  if (parentStat && (!parentStat.isDirectory() || parentStat.isSymbolicLink())) throw new SyncScreenInputError("input-unavailable");
  const checkParent = () => {
    const now = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
    if (parentStat ? !now || !now.isDirectory() || now.isSymbolicLink() || now.dev !== parentStat.dev || now.ino !== parentStat.ino : now !== undefined) throw new SyncScreenInputError("input-changed");
  };
  const file = join(parent, `${machineId}.jsonl`);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return () => {
      checkParent();
      if (lstatSync(file, { throwIfNoEntry: false })) throw new SyncScreenInputError("input-changed");
    };
    throw new SyncScreenInputError("input-unavailable");
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new SyncScreenInputError("input-unavailable");
    if (stat.size > BigInt(MAX_BYTES)) throw new SyncScreenInputError("input-bound", "bytes");
    const check = () => {
      checkParent();
      const named = lstatSync(file, { bigint: true });
      if (!named.isFile() || named.isSymbolicLink() || !sameStat(stat, named)) throw new SyncScreenInputError("input-changed");
    };
    check();
    // No whole-file string/split array: the stat bound precedes allocation; the row bound precedes parsing each row.
    const bytes = Buffer.alloc(Number(stat.size));
    let at = 0;
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, at); if (!n) throw new SyncScreenInputError("input-changed"); at += n; }
    if (bytes.length && bytes.at(-1) !== 10) throw new SyncScreenInputError("input-unavailable");
    let start = 0, rows = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let end = 0; end < bytes.length; end++) {
      if (bytes[end] !== 10) continue;
      if (start === end) { start = end + 1; continue; }
      const line = decoder.decode(bytes.subarray(start, end)); start = end + 1;
      if (!line.trim()) continue;
      if (++rows > MAX_ROWS) throw new SyncScreenInputError("input-bound", "rows");
      let row: unknown;
      try { row = checkedEntry(JSON.parse(line)); } catch { throw new SyncScreenInputError("input-unavailable"); }
      visit(row as Record<string, unknown>);
    }
    const expected = createHash("sha256").update(bytes).digest("hex"), digest = createHash("sha256"), buffer = Buffer.alloc(65_536);
    at = 0;
    while (at < bytes.length) { const n = readSync(fd, buffer, 0, Math.min(buffer.length, bytes.length - at), at); if (!n) throw new SyncScreenInputError("input-changed"); digest.update(buffer.subarray(0, n)); at += n; }
    if (expected !== digest.digest("hex") || !sameStat(stat, fstatSync(fd, { bigint: true }))) throw new SyncScreenInputError("input-changed");
    check(); return check;
  } finally { closeSync(fd); }
}

/** Screen one machine's own long-term segment under `dir`, using the inspector's same bounded reader. */
export function screenOwnSegment(dir: string, machineId: string, pass: RowScreen): SyncScreen {
  const declined: string[] = [];
  try { visitOwnSegment(dir, machineId, row => { if (!pass(row)) declined.push(idOf(row)); })(); }
  catch (error) {
    let code: unknown, bound: unknown;
    if (error && typeof error === "object" && !types.isProxy(error)) {
      code = Object.getOwnPropertyDescriptor(error, "code")?.value;
      bound = Object.getOwnPropertyDescriptor(error, "bound")?.value;
    }
    const inspect = "; inspect the local input and reopen the store before retrying";
    if (code === "input-bound" && bound === "rows") return { ok: false, reason: `more than ${MAX_ROWS} long-term rows, so they were not screened${inspect}` };
    if (code === "input-bound" && bound === "bytes") return { ok: false, reason: `this machine's long-term segment exceeds ${MAX_BYTES} bytes, so it was not screened${inspect}` };
    if (code === "input-changed") return { ok: false, reason: "this machine's long-term segment changed while being screened, so it was not screened; wait for writers to finish and retry" };
    return { ok: false, reason: "this machine's long-term segment is not readable as complete valid rows, so it was not screened" + inspect };
  }
  return refusal(declined);
}
