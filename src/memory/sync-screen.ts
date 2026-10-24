import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAmemConfig } from "./config.ts";
import { createStandalonePolicy } from "./policy.ts";
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
const MAX_BYTES = 8 * 1024 * 1024, MAX_ROWS = 20_000;

export type SyncScreen = { ok: true } | { ok: false; reason: string };

/**
 * What a row says: everything except the fields the library itself generates (ids, hashes, times, the op and enum names, machine and actor ids). Left IN on purpose
 * are `project`, `peer`, `task`, `about`, `title`, `text`, `milestones` and any field this file has never heard of: an unknown text field must be screened, never skipped.
 */
const GENERATED = new Set(["id", "schema", "op", "at", "machine", "actor", "target", "promotedFrom", "supersedes", "expires", "by", "tier", "scope", "kind", "source"]);
function textOf(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (!GENERATED.has(key)) out[key] = value;
  return out;
}

/** A row passes when the machine's configured policy and the caller's extra screen (if any) both accept its text. */
export type RowScreen = (row: Record<string, unknown>) => boolean;
export function outboundScreen(home: string, extra?: RowScreen): RowScreen {
  const { config } = loadAmemConfig(home);
  const policy = createStandalonePolicy({ denyPaths: config.denyPaths, piiPatterns: config.piiPatterns });
  return row => { const text = textOf(row); return policy.screenStandalone(text) && (extra?.(text) ?? true); };
}
const refusal = (declined: string[]): SyncScreen => declined.length ? { ok: false, reason: `the configured privacy policy declines ${declined.length} long-term entr${declined.length === 1 ? "y" : "ies"} (${declined.slice(0, 8).join(", ")}${declined.length > 8 ? ", ..." : ""}); fix the entry or the policy, then sync again` } : { ok: true };
const idOf = (row: Record<string, unknown>) => typeof row.id === "string" ? row.id.slice(0, 8) : "(no id)";

/** Screen the rows a generation or sharded store would publish: its snapshot's synced rows that are this machine's own or bridged from its legacy input. */
export function screenOutboundRows(store: MemoryStore, pass: RowScreen): SyncScreen {
  const declined: string[] = [];
  let rows = 0;
  let snapshot: ReturnType<ReturnType<MemoryStore["prunePort"]>["snapshot"]>;
  // A bootstrap-only handle has no snapshot: that is a refusal like any unreadable source, never an exception out of sync (which promises a result).
  try { snapshot = store.prunePort().snapshot(); } catch { return { ok: false, reason: "this store's long-term rows cannot be read, so they were not screened" }; }
  for (const source of snapshot.rows) {
    if (source.placement !== "synced" || !(source.own || source.legacy)) continue;
    if (++rows > MAX_ROWS) return { ok: false, reason: `more than ${MAX_ROWS} long-term rows, so they were not screened` };
    if (!pass(source.row as unknown as Record<string, unknown>)) declined.push(idOf(source.row as unknown as Record<string, unknown>));
  }
  return refusal(declined);
}

/** Screen one machine's own long-term segment under `dir`. */
export function screenOwnSegment(dir: string, machineId: string, pass: RowScreen): SyncScreen {
  const file = join(dir, "log", `${machineId}.jsonl`);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };   // nothing authored here: nothing to push
    return { ok: false, reason: "this machine's long-term segment cannot be read, so it was not screened" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return { ok: false, reason: `this machine's long-term segment is not a plain file within ${MAX_BYTES} bytes, so it was not screened` };
    const declined: string[] = [];
    let rows = 0;
    for (const line of readFileSync(fd, "utf8").split("\n")) {
      if (!line.trim()) continue;
      if (++rows > MAX_ROWS) return { ok: false, reason: `more than ${MAX_ROWS} long-term rows, so they were not screened` };
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { return { ok: false, reason: "a line of this machine's long-term segment does not parse, so it was not screened" }; }
      // Every row kind is read, not only notes: a goal's title and milestones sync too, and so does any text an op adds later (see `textOf`).
      if (!pass(row)) declined.push(idOf(row));
    }
    return refusal(declined);
  } finally { closeSync(fd); }
}
