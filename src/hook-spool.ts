import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CaptureAppend, CaptureInput } from "./memory/capture.ts";
import { normalizeCaptureFields, type NormalizedCaptureFields } from "./memory/capture-input.ts";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "./memory/policy.ts";
import { HOOK_EVENTS, HOOK_INPUT_BYTES } from "./hook-contract.ts";

const SCHEMA = "agent-mem.hook-capture/v1";
const RECORD_BYTES = HOOK_INPUT_BYTES + 8192, MAX_FILES = 256, MAX_BYTES = 2 * 1024 * 1024;
const DRAIN_FILES = 32, DRAIN_BYTES = 256 * 1024;
const namePattern = /^(hook-([a-f0-9]{64})-([a-f0-9]{64})-([a-f0-9]{32})\.json)(?:\.draining-[a-f0-9]{24})?$/;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
interface Record { schema: typeof SCHEMA; cwd: string; scope: string | null; nonce: string; capture: NormalizedCaptureFields }
export interface PendingHookCapture { name: string; cwd: string; receipt: string }
export class HookSpoolFull extends Error { constructor() { super("hook storage full"); } }
interface Options { cwd: string; base: string; policy?: StandalonePolicyOptions }
const directory = (base: string) => join(base, "hook-spool");

function privateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("hook storage unavailable");
  chmodSync(dir, 0o700);
}
function entries(base: string): { name: string; size: number }[] {
  const dir = directory(base), stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("hook storage unavailable");
  const reader = opendirSync(dir), rows: { name: string; size: number }[] = [];
  try {
    for (let scanned = 0; scanned <= MAX_FILES + 1; scanned++) {
      const entry = reader.readSync(); if (!entry) return rows;
      if (entry.name === ".writing" && entry.isDirectory()) continue;
      if (rows.length === MAX_FILES) return rows;
      const item = lstatSync(join(dir, entry.name), { throwIfNoEntry: false });
      if (item) rows.push({ name: entry.name, size: item.size });
    }
    return rows;
  } finally { reader.closeSync(); }
}

/** Physical cwd and local control metadata bind a pending record before a Git subprocess is available.
 * ponytail: included Git configuration outside these control files is not historical attestation.
 * A changed stamp remains unresolved; full native Git-origin attestation is the upgrade path. */
export function hookCaptureScope(cwd: string, base: string): string | undefined {
  try {
    const parts: string[] = [], identity = (file: string) => {
      const stat = lstatSync(file); return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    };
    const content = (file: string, maximum = 64 * 1024): string => {
      const named = lstatSync(file, { throwIfNoEntry: false });
      if (!named) { parts.push("missing"); return ""; }
      const actual = realPath(file), fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > maximum) throw new Error("control bound");
        const bytes = Buffer.alloc(stat.size), length = readSync(fd, bytes, 0, bytes.length, 0);
        if (length !== stat.size) throw new Error("control changed");
        parts.push(`${actual}:${identity(actual)}:${hash(bytes)}`);
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } finally { closeSync(fd); }
    };
    parts.push(`${cwd}:${identity(cwd)}`);
    let found = false, reachedRoot = false;
    for (let folder = cwd, depth = 0; depth < 32; depth++) {
      const git = join(folder, ".git"), stat = lstatSync(git, { throwIfNoEntry: false });
      if (stat) {
        found = true;
        const actual = realPath(git), actualStat = lstatSync(actual);
        let gitDir = actual;
        if (actualStat.isFile()) {
          const pointer = /^gitdir:\s*(.+)\s*$/i.exec(content(actual, 4096).trim());
          if (!pointer) throw new Error("git pointer unavailable");
          gitDir = realPath(resolve(folder, pointer[1]!));
        } else if (!actualStat.isDirectory()) throw new Error("git directory unavailable");
        parts.push(`${gitDir}:${identity(gitDir)}`);
        content(join(gitDir, "HEAD"), 4096); content(join(gitDir, "config"));
        const common = content(join(gitDir, "commondir"), 4096).trim();
        if (common) content(join(realPath(resolve(gitDir, common)), "config"));
        break;
      }
      const parent = dirname(folder); if (parent === folder) { reachedRoot = true; break; } folder = parent;
    }
    if (!found && !reachedRoot) return undefined;
    parts.push(found ? "git" : "no-git");
    for (const file of ["aliases.jsonl", "profile.json", "shards.json"]) content(join(base, file));
    if (process.env.HOME) {
      content(join(process.env.HOME, ".gitconfig")); content(join(process.env.HOME, ".config", "git", "config"));
    }
    return hash(parts.join("\n"));
  } catch { return undefined; }
}

/** Only screened normalized capture fields are retained, never the native input envelope. */
export async function stageHookCapture(event: string, input: unknown, options: Options): Promise<PendingHookCapture | undefined> {
  if (!(HOOK_EVENTS as readonly string[]).includes(event) || options.policy?.host) return undefined;
  const policy = createStandalonePolicy(options.policy);
  if (!await policy.screen(input)) return undefined;
  const value = structuredClone(input) as {[key: string]: unknown};
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > HOOK_INPUT_BYTES || !await policy.screen(value)) return undefined;
  const cwd = realPath(options.cwd), base = canonicalPath(options.base);
  if (value.hook_event_name !== undefined && value.hook_event_name !== event) return undefined;
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || realPath(value.cwd) !== cwd)) return undefined;
  const tool = value.tool_input && typeof value.tool_input === "object" && !Array.isArray(value.tool_input) ? value.tool_input as {[key: string]: unknown} : {};
  const paths = [tool.file_path, tool.path, ...(Array.isArray(tool.paths) ? tool.paths : [])].filter((p): p is string => typeof p === "string");
  const content = event === "PostToolUseFailure" ? value.error ?? value.tool_response ?? "" : value.prompt ?? value.last_assistant_message ?? value.tool_response ?? "";
  const capture = normalizeCaptureFields({ agent: "claude", event, paths, status: event === "PostToolUseFailure" ? "failed" : "ok",
    ...(typeof value.tool_name === "string" ? { tool: value.tool_name } : {}), excerpt: typeof content === "string" ? content : JSON.stringify(content) });
  if (!await policy.screen({ cwd, capture })) return undefined;
  const scope = hookCaptureScope(cwd, base) ?? null, nonce = randomBytes(16).toString("hex");
  const record: Record = { schema: SCHEMA, cwd, scope, nonce, capture }, bytes = JSON.stringify(record);
  if (Buffer.byteLength(bytes) > RECORD_BYTES) throw new Error("hook record bound");
  const dir = directory(base), writing = join(dir, ".writing"); privateDirectory(dir); privateDirectory(writing);
  const queued = entries(base);
  // Soft per-home cap: concurrent publishers can exceed it by their already in-flight records, never by eviction.
  if (queued.length >= MAX_FILES || queued.reduce((sum, row) => sum + row.size, 0) + Buffer.byteLength(bytes) > MAX_BYTES) throw new HookSpoolFull();
  const name = `hook-${hash(cwd)}-${scope ?? "0".repeat(64)}-${nonce}.json`, temporary = join(writing, name);
  try { writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); renameSync(temporary, join(dir, name)); }
  finally { rmSync(temporary, { force: true }); }
  return { name, cwd, receipt: hash(bytes) };
}

export function hookCapturePending(base: string, name: string): boolean {
  try { return entries(base).some(row => row.name === name || row.name.startsWith(name + ".")); }
  catch { return true; } // Unreadable evidence is pending, never an acknowledgement.
}

export async function drainHookCaptures(options: Options & { project: string; expectedScope?: string; current?: string; timeRemaining?: () => number },
  append: (input: CaptureInput, receipt: string) => CaptureAppend): Promise<{ captured: string[]; blocked: number }> {
  const cwd = realPath(options.cwd), base = canonicalPath(options.base), stamp = hookCaptureScope(cwd, base), captured: string[] = [];
  if (!stamp || options.expectedScope !== undefined && options.expectedScope !== stamp) return { captured, blocked: 1 };
  const policy = createStandalonePolicy(options.policy), dir = directory(base);
  const rows = entries(base).filter(row => {
    const m = namePattern.exec(row.name); return m && m[2] === hash(cwd) && m[3] === stamp;
  }).sort((a, b) => Number(b.name === options.current) - Number(a.name === options.current) || a.name.localeCompare(b.name));
  let remaining = DRAIN_BYTES, blocked = 0;
  for (const row of rows.slice(0, DRAIN_FILES)) {
    if (options.timeRemaining && options.timeRemaining() < 8 || row.size > remaining) break;
    const match = namePattern.exec(row.name)!, name = match[1]!, claim = join(dir, `${name}.draining-${randomBytes(12).toString("hex")}`);
    try { renameSync(join(dir, row.name), claim); } catch { continue; }
    let fd: number | undefined;
    try {
      fd = openSync(claim, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const initial = fstatSync(fd);
      if (!initial.isFile() || initial.nlink !== 1 || initial.size > RECORD_BYTES) throw new Error("hook record unavailable");
      const bytes = Buffer.alloc(initial.size), length = readSync(fd, bytes, 0, bytes.length, 0); remaining -= length;
      if (length !== initial.size) throw new Error("hook record changed");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record;
      if (value.schema !== SCHEMA || value.cwd !== cwd || value.scope !== stamp || value.nonce !== match[4] || !value.capture
        || value.capture.agent !== "claude" || !(HOOK_EVENTS as readonly string[]).includes(value.capture.event) || !Number.isFinite(Date.parse(value.capture.at))) throw new Error("hook record shape");
      const c = value.capture;
      const input: CaptureInput = { project: options.project, agent: c.agent, event: c.event, at: c.at, paths: c.paths,
        ...(c.tool === null ? {} : { tool: c.tool }), ...(c.status === null ? {} : { status: c.status }), excerpt: c.excerpt };
      if (!await policy.screen(value) || !await policy.screen(input)) { blocked++; continue; }
      const named = lstatSync(claim, { throwIfNoEntry: false }), now = fstatSync(fd);
      if (!named || named.isSymbolicLink() || named.dev !== initial.dev || named.ino !== initial.ino || now.size !== initial.size
        || now.mtimeMs !== initial.mtimeMs || hookCaptureScope(cwd, base) !== stamp) { blocked++; continue; }
      append(input, hash(bytes));
      rmSync(claim); captured.push(name);
    } catch { blocked++; } // Keep the unique claim for retry; a later reader uses the same receipt.
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return { captured, blocked };
}
