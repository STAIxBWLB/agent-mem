import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SetupTarget } from "./setup.ts";
import { SETUP_CONFIG_BYTES } from "./setup-toml.ts";
import { managedAfter, managedHookEntries, mcpRecord, type ConfigImage } from "./setup-owned.ts";
import { resolveSetupPaths, type SetupEnvironment } from "./setup-paths.ts";
import { HOOK_EVENTS } from "./hook-contract.ts";
import { realPath } from "./memory/platform.ts";

export type SetupDriftStatus = "ok" | "attention" | "skipped" | "unavailable";
export interface SetupDriftEntry {
  target: SetupTarget;
  file: string;
  entry: string;
  reason: string;
  kind: "drift" | "unavailable" | "review-needed";
  expectedFile?: string;
}
export interface SetupDriftReport {
  status: SetupDriftStatus;
  checked: number;
  entries: SetupDriftEntry[];
  reason?: string;
}

interface ReceiptChange { key: string; path: string; before: ConfigImage; after: ConfigImage }
interface Receipt { version: 1; target: SetupTarget; phase: "prepared" | "applied"; changes: ReceiptChange[] }
const JOURNAL_BYTES = 12 * SETUP_CONFIG_BYTES;
// ponytail: at most 32 MiB of receipt/config input per doctor call; use metadata-only receipts before widening.
const READ_BYTES = 32 * 1024 * 1024;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function safeImage(path: string, max = SETUP_CONFIG_BYTES, budget?: { remaining: number }): ConfigImage {
  let cursor = resolve(path);
  while (true) {
    try { if (lstatSync(cursor).isSymbolicLink()) throw Error("unsafe"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, mode: 0o600 }; throw error; }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > max || budget && before.size > budget.remaining) throw Error("unsafe");
    if (budget) budget.remaining -= before.size;
    const data = Buffer.alloc(before.size + 1), size = readSync(fd, data, 0, data.length, 0), after = fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) throw Error("changed");
    return { bytes: data.subarray(0, size).toString("base64"), mode: before.mode & 0o777 };
  } finally { closeSync(fd); }
}

function parseImage(value: unknown): ConfigImage {
  if (!plain(value) || !Number.isInteger(value.mode) || Number(value.mode) < 0 || Number(value.mode) > 0o777) throw Error("invalid receipt");
  if (value.bytes !== null && (typeof value.bytes !== "string" || value.bytes.length > 2 * SETUP_CONFIG_BYTES || Buffer.from(value.bytes, "base64").toString("base64") !== value.bytes)) throw Error("invalid receipt");
  return { bytes: value.bytes as string | null, mode: Number(value.mode) };
}

function parseReceipt(value: unknown, target: SetupTarget, expectedPaths: readonly string[]): Receipt {
  if (!plain(value) || value.version !== 1 || value.target !== target || !/^[a-f0-9]{64}$/.test(String(value.intent)) || !["applied", "prepared"].includes(String(value.phase)) || !Array.isArray(value.changes) || value.changes.length !== expectedPaths.length) throw Error("invalid receipt");
  const changes: ReceiptChange[] = [];
  for (let index = 0; index < value.changes.length; index++) {
    const item: unknown = value.changes[index];
    if (!plain(item) || item.key !== `${target}:${index}` || typeof item.path !== "string" || !isAbsolute(item.path) || item.path.length > 4096 || item.path.includes("\0")) throw Error("invalid receipt");
    changes.push({ key: `${target}:${index}`, path: item.path, before: parseImage(item.before), after: parseImage(item.after) });
  }
  return { version: 1, target, phase: value.phase as Receipt["phase"], changes };
}

function workspaceRoot(cwd: string): string | undefined {
  let current = realPath(resolve(cwd));
  while (true) {
    try {
      const marker = lstatSync(join(current, ".git"));
      if (marker.isDirectory() || marker.isFile()) return realPath(current);
    } catch { /* Continue toward the filesystem root. */ }
    const parent = dirname(current); if (parent === current) return undefined; current = parent;
  }
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function launch(record: unknown): string | undefined {
  if (!plain(record) || typeof record.command !== "string" || !Array.isArray(record.args) || !record.args.every(arg => typeof arg === "string")) return undefined;
  const args = [...record.args as string[]];
  if (args.at(-1) === "mcp") args.pop();
  return [shellQuote(record.command), ...args.map(arg => arg === "--smol" ? arg : shellQuote(arg))].join(" ");
}

function expectedManagedHookCommands(target: SetupTarget, after: ConfigImage): { event: string; command: string }[] {
  if (["jcode", "opencode", "gemini", "agy"].includes(target)) return [];
  const base = launch(mcpRecord(target, after));
  if (!base) return [];
  if (target === "claude") return HOOK_EVENTS.map(event => ({ event, command: `${base} hook ${event}` }));
  if (target === "pi") return [];
  return [{ event: "SessionEnd", command: `${base} ingest ${target}${target === "codex" || target === "kimi" || target === "qwen" ? " --json" : ""}` }];
}

/** Codex stores trust in config.toml under hooks.state, keyed by hooks.json path and handler position. */
function codexMissingTrust(hooksPath: string, hooksImage: ConfigImage, configImage: ConfigImage, expected: { event: string; command: string }[]): string[] {
  if (hooksImage.bytes === null || configImage.bytes === null) return [];
  const hooksDocument: unknown = JSON.parse(Buffer.from(hooksImage.bytes, "base64").toString("utf8"));
  const configDocument: unknown = Bun.TOML.parse(Buffer.from(configImage.bytes, "base64").toString("utf8"));
  if (!plain(hooksDocument) || !plain(configDocument)) throw Error("invalid Codex configuration");
  const groups: unknown[] = plain(hooksDocument.hooks) && Array.isArray(hooksDocument.hooks.SessionEnd) ? hooksDocument.hooks.SessionEnd : [];
  const stateRoot: Record<string, unknown> = plain(configDocument.hooks) && plain(configDocument.hooks.state) ? configDocument.hooks.state : Object.create(null);
  const wanted = new Set(expected.filter(row => row.event === "SessionEnd").map(row => row.command));
  const missing: string[] = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex]; if (!plain(group) || !Array.isArray(group.hooks)) continue;
    for (let handlerIndex = 0; handlerIndex < group.hooks.length; handlerIndex++) {
      const handler = group.hooks[handlerIndex];
      if (!plain(handler) || typeof handler.command !== "string" || !wanted.has(handler.command)) continue;
      const key = `${hooksPath}:session_end:${groupIndex}:${handlerIndex}`;
      const state = stateRoot[key];
      // Presence is not proof that the stored digest still matches; amem only detects a missing record.
      if (!plain(state) || typeof state.trusted_hash !== "string") missing.push(key);
    }
  }
  return missing;
}

function entry(target: SetupTarget, file: string, name: string, reason: string, kind: SetupDriftEntry["kind"]): SetupDriftEntry {
  return { target, file, entry: name, reason, kind };
}

/** Read setup receipts and only the resolver-selected native config files. This function never writes. */
export function readSetupDrift(options: { home: string; env?: SetupEnvironment; cwd?: string }): SetupDriftReport {
  const env = options.env ?? process.env;
  const root = workspaceRoot(options.cwd ?? process.cwd());
  let resolved: ReturnType<typeof resolveSetupPaths>;
  try { resolved = resolveSetupPaths(env, undefined, root); }
  catch { return { status: "unavailable", checked: 0, entries: [], reason: "setup paths could not be resolved" }; }
  const entries: SetupDriftEntry[] = [], budget = { remaining: READ_BYTES };
  let checked = 0, unavailable = false, anyReceipt = false;
  for (const target of Object.keys(resolved.paths) as SetupTarget[]) {
    const expectedPaths = resolved.paths[target];
    if (!expectedPaths.length) continue;
    const receiptPath = join(options.home, "setup", target === "agy" ? `agy-${hash(root)}.json` : `${target}.json`);
    let raw: ConfigImage;
    try { raw = safeImage(receiptPath, JOURNAL_BYTES, budget); }
    catch {
      entries.push(entry(target, receiptPath, "receipt", "receipt cannot be read safely or exceeds the read bound", "unavailable")); unavailable = true;
      continue;
    }
    if (raw.bytes === null) continue;
    let receipt: Receipt;
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(raw.bytes, "base64")));
      if (plain(value) && value.target === target && value.phase === "prepared") continue;
      anyReceipt = true; checked++;
      receipt = parseReceipt(value, target, expectedPaths);
    } catch {
      entries.push(entry(target, receiptPath, "receipt", "receipt is invalid or unavailable", "unavailable")); unavailable = true; continue;
    }
    // Never open a manifest-selected file before the full set of paths matches the shared resolver.
    const mismatches = receipt.changes.filter((change, index) => change.path !== expectedPaths[index]);
    if (mismatches.length) {
      for (const change of mismatches) entries.push({ ...entry(target, change.path, change.key,
        "manifest path no longer matches the resolved target; referenced files were not opened", "drift"),
        expectedFile: expectedPaths[receipt.changes.indexOf(change)] });
      continue;
    }
    const liveImages: (ConfigImage | undefined)[] = [];
    for (const change of receipt.changes) {
      let current: ConfigImage;
      try { current = safeImage(change.path, SETUP_CONFIG_BYTES, budget); }
      catch {
        liveImages.push(undefined);
        entries.push(entry(target, change.path, change.key, "resolved configuration cannot be read safely", "unavailable")); unavailable = true; continue;
      }
      liveImages.push(current);
      const isMcp = change.key === `${target}:0`;
      if (isMcp) {
        const name = target === "codex" ? "mcp_servers.amem" : target === "jcode" ? "servers.amem" : target === "opencode" ? "mcp.amem" : "mcpServers.amem";
        try {
          const expected = mcpRecord(target, change.after);
          if (expected === undefined) throw Error("receipt has no MCP registration");
          if (!isDeepStrictEqual(expected, mcpRecord(target, current))) entries.push(entry(target, change.path, name, "managed MCP registration is missing or changed", "drift"));
        } catch { entries.push(entry(target, change.path, name, "managed MCP registration could not be checked", "unavailable")); unavailable = true; }
      }
      const hasHookSurface = target === "qwen" && change.key === `${target}:0` || target === "claude" && change.key === `${target}:1` || target === "codex" && change.key === `${target}:1` || target === "kimi" && change.key === `${target}:1`;
      if (hasHookSurface) {
        try {
          const expected = expectedManagedHookCommands(target, receipt.changes[0]!.after);
          for (const row of managedHookEntries(target, change.before, change.after, current, expected)) {
            if (!row.present) entries.push(entry(target, change.path, row.entry, "managed hook is missing or changed", "drift"));
          }
        } catch { entries.push(entry(target, change.path, "hooks", "managed hooks could not be checked", "unavailable")); unavailable = true; }
      }
      if (target === "pi" && change.key === "pi:1" && !managedAfter(target, 1, change.before, change.after, current)) entries.push(entry(target, change.path, "session_shutdown extension", "managed hook extension is missing or changed", "drift"));
      if (target === "codex" && change.key === "codex:1") {
        // Codex owns trust state. Doctor checks only whether an entry exists; it never writes or verifies trusted_hash.
        try {
          const configImage = liveImages[0];
          if (!configImage) throw Error("Codex config is unavailable");
          const expected = expectedManagedHookCommands(target, receipt.changes[0]!.after);
          for (const key of codexMissingTrust(change.path, current, configImage, expected)) entries.push(entry(target, change.path, `hooks.state.${key}`, "no Codex trust record exists; treat the hook as untrusted and review it in Codex", "review-needed"));
        } catch { entries.push(entry(target, change.path, "hooks.state", "Codex hook trust could not be checked safely", "unavailable")); unavailable = true; }
      }
    }
  }
  const status: SetupDriftStatus = entries.some(value => value.kind === "drift" || value.kind === "review-needed") ? "attention"
    : unavailable ? "unavailable" : anyReceipt ? "ok" : "skipped";
  return { status, checked, entries, ...(!anyReceipt && !entries.length ? { reason: "no applied setup receipts found" } : {}) };
}
