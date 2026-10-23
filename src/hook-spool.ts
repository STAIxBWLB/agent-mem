import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
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
function entries(base: string): { name: string; size: number; modified: number }[] {
  const dir = directory(base), stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("hook storage unavailable");
  const reader = opendirSync(dir), rows: { name: string; size: number; modified: number }[] = [];
  try {
    for (let scanned = 0; scanned <= MAX_FILES + 2; scanned++) {
      const entry = reader.readSync(); if (!entry) return rows;
      if ([".writing", ".quarantine"].includes(entry.name) && entry.isDirectory()) continue;
      if (rows.length === MAX_FILES) return rows;
      const item = lstatSync(join(dir, entry.name), { throwIfNoEntry: false });
      if (item) rows.push({ name: entry.name, size: item.size, modified: item.mtimeMs });
    }
    return rows;
  } finally { reader.closeSync(); }
}

/** Validate ordinary Git value syntax even for ignored keys: invalid unused configuration can make
 * native Git refuse the whole file, so ignoring its syntax could falsely certify project resolution. */
function validateConfigValue(value: string): void {
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "\\") {
      const escaped = value[++index];
      if (escaped === undefined || !["n", "t", "b", "\\", '"'].includes(escaped)) throw new Error("unsupported Git config escape");
    } else if (character === '"') quoted = !quoted;
    else if (!quoted && (character === "#" || character === ";")) break;
  }
  if (quoted) throw new Error("unclosed Git config quote");
}

/** Strict subset, not a substitute Git parser. Relevant escapes, continuations, includes and ambiguous origins
 * remain unknown; silently guessing one could bind a pending private event to another project. */
function identityConfig(text: string): [string, string][] {
  const relevant: [string, string][] = [];
  let section = "", subsection = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith("[")) {
      const match = /^\[([a-zA-Z0-9-]+)(?:\s+"([^"\\]*)")?\]\s*(?:[#;].*)?$/.exec(line);
      if (!match) throw new Error("unsupported Git config section");
      section = match[1]!.toLowerCase(); subsection = match[2] ?? "";
      if (section === "include" || section === "includeif") throw new Error("unsupported Git config include");
      continue;
    }
    const match = /^([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(.*))?$/.exec(line);
    if (!section || !match) throw new Error("unsupported Git config entry");
    const key = match[1]!.toLowerCase();
    let value = match[2] ?? "true";
    validateConfigValue(value);
    const deciding = section === "remote" && subsection === "origin" && key === "url"
      || section === "url" && key === "insteadof"
      || section === "core" && ["bare", "worktree"].includes(key)
      || section === "extensions" && key === "worktreeconfig";
    if (!deciding) continue; // Valid alias/user/etc. values never affect project identity.
    if (value.includes("\\")) throw new Error("unsupported identity config escape");
    if (value.startsWith('"')) {
      const quoted = /^"([^"\\]*)"\s*(?:[#;].*)?$/.exec(value);
      if (!quoted) throw new Error("unsupported Git config value");
      value = quoted[1]!;
    } else {
      if (value.includes('"')) throw new Error("unsupported Git config value");
      value = value.split(/[#;]/, 1)[0]!.trim();
    }
    if (section === "remote" && subsection === "origin" && key === "url") relevant.push(["origin", value]);
    else if (section === "url" && key === "insteadof") relevant.push([`rewrite:${subsection}`, value]);
    else if (section === "core" && ["bare", "worktree"].includes(key) || section === "extensions" && key === "worktreeconfig") {
      if (key !== "worktree") {
        const folded = value.toLowerCase();
        if (!["true", "false", "yes", "no", "on", "off", "1", "0", ""].includes(folded)) throw new Error("invalid Git boolean");
        value = ["true", "yes", "on", "1"].includes(folded) ? "true" : "false";
      }
      relevant.push([`${section}.${key}`, value]);
    }
  }
  return relevant;
}

/** Physical cwd/common-dir identity plus project-deciding configuration, never branch HEAD or config inode.
 * ponytail: strict unsupported Git configuration remains unknown, not guessed. A native historical-origin
 * receipt would broaden that supported subset without relaxing the physical replacement boundary. */
export function hookCaptureScope(cwd: string, base: string): string | undefined {
  try {
    const parts: string[] = [], identity = (file: string) => {
      const stat = lstatSync(file);
      if (!stat.isDirectory()) throw new Error("physical scope unavailable");
      return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    };
    const content = (file: string, maximum = 64 * 1024): string => {
      const named = lstatSync(file, { throwIfNoEntry: false });
      if (!named) return "";
      const actual = realPath(file), fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > maximum) throw new Error("control bound");
        const bytes = Buffer.alloc(stat.size), length = readSync(fd, bytes, 0, bytes.length, 0), after = lstatSync(actual);
        if (length !== stat.size || stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error("control changed");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } finally { closeSync(fd); }
    };
    cwd = realPath(cwd);
    parts.push(`${cwd}:${identity(cwd)}`);
    // The fixed worker keeps HOME but strips inherited Git routing/override environment. Check the ordinary
    // system locations conservatively too; unsupported identity-affecting configuration refuses resolution.
    const configuration: [string, string][] = [];
    for (const file of ["/etc/gitconfig", "/usr/local/etc/gitconfig", "/opt/homebrew/etc/gitconfig"]) configuration.push(...identityConfig(content(file)));
    if (process.env.HOME) for (const file of [join(process.env.HOME, ".gitconfig"), join(process.env.HOME, ".config", "git", "config")]) configuration.push(...identityConfig(content(file)));
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
        const common = content(join(gitDir, "commondir"), 4096).trim();
        const commonDir = common ? realPath(resolve(gitDir, common)) : gitDir;
        parts.push(`${gitDir}:${identity(gitDir)}`, `${commonDir}:${identity(commonDir)}`);
        configuration.push(...identityConfig(content(join(commonDir, "config"))));
        const worktreeConfig = configuration.filter(([key]) => key === "extensions.worktreeconfig").at(-1)?.[1];
        if (worktreeConfig === "true") configuration.push(...identityConfig(content(join(gitDir, "config.worktree"))));
        break;
      }
      const parent = dirname(folder); if (parent === folder) { reachedRoot = true; break; } folder = parent;
    }
    if (!found && !reachedRoot) return undefined;
    if (configuration.filter(([key]) => key === "origin").length > 1) return undefined;
    const scalars = new Map(configuration.filter(([key]) => !key.startsWith("rewrite:")));
    const rewrites = configuration.filter(([key]) => key.startsWith("rewrite:"));
    parts.push(found ? "git" : "no-git", JSON.stringify([...scalars].sort()), JSON.stringify(rewrites));
    // Opaque bounded binding only. Actual schema/project interpretation stays with the worker's core readers;
    // importing those here would load SQLite in the low-RSS parent. File replacement alone is irrelevant.
    for (const file of ["aliases.jsonl", "profile.json", "shards.json"]) parts.push(`${file}:${hash(content(join(base, file)))}`);
    return hash(parts.join("\n"));
  } catch { return undefined; }
}

interface OwnedFile { file: string; fd: number; initial: Stats }
interface Quarantined { name: string; size: number; modified: number; dev: number; ino: number }
function owns(file: OwnedFile): boolean {
  const named = lstatSync(file.file, { throwIfNoEntry: false }), now = fstatSync(file.fd), initial = file.initial;
  return !!named && named.isFile() && !named.isSymbolicLink() && named.nlink === 1
    && named.dev === initial.dev && named.ino === initial.ino && named.size === initial.size && named.mtimeMs === initial.mtimeMs
    && now.dev === initial.dev && now.ino === initial.ino && now.size === initial.size && now.mtimeMs === initial.mtimeMs;
}
function openOwned(file: string): OwnedFile {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = fstatSync(fd), owned = { file, fd, initial };
    if (!initial.isFile() || initial.nlink !== 1 || !owns(owned)) throw new Error("hook record unavailable");
    return owned;
  } catch (error) { closeSync(fd); throw error; }
}
/** Claim only the inode just inspected; subsequent cleanup addresses this unique name, never the old one. */
function claimOwned(base: string, name: string, file: OwnedFile): OwnedFile | undefined {
  const match = namePattern.exec(name);
  if (!match || !owns(file)) return undefined;
  const claim = join(directory(base), `${match[1]}.draining-${randomBytes(12).toString("hex")}`);
  renameSync(file.file, claim);
  const owned = { ...file, file: claim };
  return owns(owned) ? owned : undefined;
}
function decoded(file: OwnedFile): { value: Record; bytes: Buffer } | undefined {
  if (file.initial.size > RECORD_BYTES) return undefined; // Positively oversized: do not materialize its body.
  const bytes = Buffer.alloc(file.initial.size);
  if (readSync(file.fd, bytes, 0, bytes.length, 0) !== bytes.length || !owns(file)) throw new Error("hook record changed");
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 5
      || Object.keys(value).some(key => !["schema", "cwd", "scope", "nonce", "capture"].includes(key))
      || value.schema !== SCHEMA || typeof value.cwd !== "string" || !/^[a-f0-9]{32}$/.test(value.nonce)
      || value.scope !== null && (typeof value.scope !== "string" || !/^[a-f0-9]{64}$/.test(value.scope))) return undefined;
    const c = value.capture;
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).length !== 8
      || Object.keys(c).some(key => !["at", "agent", "event", "tool", "paths", "status", "excerpt", "bytes"].includes(key))
      || c.agent !== "claude" || !(HOOK_EVENTS as readonly string[]).includes(c.event)
      || typeof c.at !== "string" || !Number.isFinite(Date.parse(c.at)) || typeof c.excerpt !== "string"
      || !Array.isArray(c.paths) || c.paths.some(path => typeof path !== "string")) return undefined;
    const normalized = normalizeCaptureFields({ agent: c.agent, event: c.event, at: c.at, paths: c.paths, excerpt: c.excerpt,
      ...(c.tool === null ? {} : { tool: c.tool }), ...(c.status === null ? {} : { status: c.status }) });
    const actual = c as unknown as {[key: string]: unknown};
    if (Object.entries(normalized).some(([key, item]) => JSON.stringify(actual[key]) !== JSON.stringify(item))) return undefined;
    return { value, bytes };
  } catch { return undefined; }
}
function quarantineEntries(dir: string): Quarantined[] {
  const reader = opendirSync(dir), rows: Quarantined[] = [];
  try {
    for (let scanned = 0; scanned <= MAX_FILES; scanned++) {
      const entry = reader.readSync(); if (!entry) break;
      const item = lstatSync(join(dir, entry.name), { throwIfNoEntry: false });
      if (!item || !item.isFile() || item.isSymbolicLink() || item.nlink !== 1) continue;
      rows.push({ name: entry.name, size: item.size, modified: item.mtimeMs, dev: item.dev, ino: item.ino });
    }
  } finally { reader.closeSync(); }
  return rows.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
}
function trimQuarantine(base: string, files = 0, bytes = 0): boolean {
  const dir = join(directory(base), ".quarantine");
  if (!lstatSync(dir, { throwIfNoEntry: false })) return true;
  privateDirectory(dir);
  const held = quarantineEntries(dir);
  let size = held.reduce((sum, row) => sum + row.size, 0), count = held.length;
  for (const row of held) {
    if (count + files <= MAX_FILES && size + bytes <= MAX_BYTES) return true;
    let file: OwnedFile | undefined;
    try {
      file = openOwned(join(dir, row.name));
      if (file.initial.dev !== row.dev || file.initial.ino !== row.ino || file.initial.size !== row.size || file.initial.mtimeMs !== row.modified) continue;
      if (owns(file)) { rmSync(file.file); size -= row.size; count--; }
    } catch { /* A replacement is never removed using an older inventory receipt. */ }
    finally { if (file) closeSync(file.fd); }
  }
  return count + files <= MAX_FILES && size + bytes <= MAX_BYTES;
}
/** Only this exact owned unique claim is retired. Invalid/oversized records age out without retaining a raw
 * body. Valid normalized rows are held privately outside active admission and never read as brief context.
 * ponytail: active and quarantine each have a 2MiB/256-file soft cap plus already in-flight publications;
 * cross-process hard admission accounting is the upgrade path. Bounded trims run on healthy admission too. */
function retireClaim(base: string, file: OwnedFile, preserve: boolean): boolean {
  if (!owns(file)) return false;
  if (!preserve) { rmSync(file.file); return true; }
  const quarantine = join(directory(base), ".quarantine"); privateDirectory(quarantine);
  if (!trimQuarantine(base, 1, file.initial.size) || !owns(file)) return false;
  const name = `${file.file.slice(file.file.lastIndexOf("/") + 1)}.quarantined-${randomBytes(12).toString("hex")}`;
  const destination = join(quarantine, name);
  renameSync(file.file, destination); chmodSync(destination, 0o600);
  return true;
}

/** Inspect at most the bounded active inventory before admission. Malformed matching publications cannot
 * occupy active capacity forever; current-policy rejection during drain uses the same retirement boundary. */
function retireUnresolved(base: string): void {
  trimQuarantine(base);
  const active = entries(base), scopes = new Map<string, string | undefined>();
  let remaining = MAX_BYTES;
  for (const row of active) {
    const match = namePattern.exec(row.name); if (!match) continue;
    if (row.size <= RECORD_BYTES && row.size > remaining) break;
    let file: OwnedFile | undefined;
    try {
      file = openOwned(join(directory(base), row.name));
      if (file.initial.size !== row.size || file.initial.mtimeMs !== row.modified) continue;
      if (row.size <= RECORD_BYTES) remaining -= row.size;
      const record = decoded(file);
      if (record && (hash(record.value.cwd) !== match[2] || record.value.nonce !== match[4]
        || (record.value.scope ?? "0".repeat(64)) !== match[3])) {
        const claim = claimOwned(base, row.name, file); if (claim) retireClaim(base, claim, false);
        continue;
      }
      if (record) {
        const value = record.value;
        if (!scopes.has(value.cwd)) scopes.set(value.cwd, hookCaptureScope(value.cwd, base));
        if (value.scope !== null && value.scope === scopes.get(value.cwd)) continue;
      }
      const claim = claimOwned(base, row.name, file);
      if (claim) retireClaim(base, claim, !!record);
    } catch { /* Transient I/O and changed evidence remain retryable; capture bodies never enter logs. */ }
    finally { if (file) closeSync(file.fd); }
  }
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
  retireUnresolved(base);
  const queued = entries(base);
  // Soft per-home cap: concurrent publishers can exceed it by their already in-flight records, never by eviction.
  if (queued.length >= MAX_FILES || queued.reduce((sum, row) => sum + row.size, 0) + Buffer.byteLength(bytes) > MAX_BYTES) throw new HookSpoolFull();
  const name = `hook-${hash(cwd)}-${scope ?? "0".repeat(64)}-${nonce}.json`, temporary = join(writing, name);
  try { writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); renameSync(temporary, join(dir, name)); }
  finally { rmSync(temporary, { force: true }); }
  return { name, cwd, receipt: hash(bytes) };
}

export function hookCapturePending(base: string, name: string): boolean {
  try {
    if (entries(base).some(row => row.name === name || row.name.startsWith(name + "."))) return true;
    const quarantine = join(directory(base), ".quarantine");
    if (!lstatSync(quarantine, { throwIfNoEntry: false })) return false;
    return quarantineEntries(quarantine).some(row => row.name === name || row.name.startsWith(name + "."));
  } catch { return true; } // Unreadable evidence is pending, never an acknowledgement.
}

export async function drainHookCaptures(options: Options & { project: string; expectedScope?: string; current?: string; timeRemaining?: () => number },
  append: (input: CaptureInput, receipt: string) => CaptureAppend): Promise<{ captured: string[]; blocked: number }> {
  const cwd = realPath(options.cwd), base = canonicalPath(options.base), stamp = hookCaptureScope(cwd, base), captured: string[] = [];
  if (!stamp || options.expectedScope !== undefined && options.expectedScope !== stamp) return { captured, blocked: 1 };
  const policy = createStandalonePolicy(options.policy), dir = directory(base);
  const rows = entries(base).filter(row => {
    const m = namePattern.exec(row.name); return m && m[2] === hash(cwd) && m[3] === stamp;
  }).sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
  let remaining = DRAIN_BYTES, blocked = 0;
  for (const row of rows.slice(0, DRAIN_FILES)) {
    if (options.timeRemaining && options.timeRemaining() < 8 || row.size <= RECORD_BYTES && row.size > remaining) break;
    const match = namePattern.exec(row.name)!, name = match[1]!;
    let file: OwnedFile | undefined;
    try {
      file = openOwned(join(dir, row.name));
      if (file.initial.size !== row.size || file.initial.mtimeMs !== row.modified) { blocked++; continue; }
      const claim = claimOwned(base, row.name, file);
      if (!claim) { blocked++; continue; }
      if (claim.initial.size <= RECORD_BYTES) remaining -= claim.initial.size;
      const record = decoded(claim);
      if (!record || record.value.cwd !== cwd || record.value.scope !== stamp || record.value.nonce !== match[4]) {
        retireClaim(base, claim, false); blocked++; continue;
      }
      const value = record.value, c = value.capture;
      const input: CaptureInput = { project: options.project, agent: c.agent, event: c.event, at: c.at, paths: c.paths,
        ...(c.tool === null ? {} : { tool: c.tool }), ...(c.status === null ? {} : { status: c.status }), excerpt: c.excerpt };
      if (!await policy.screen(value) || !await policy.screen(input)) { retireClaim(base, claim, true); blocked++; continue; }
      if (!owns(claim) || hookCaptureScope(cwd, base) !== stamp) { blocked++; continue; }
      append(input, hash(record.bytes));
      if (owns(claim)) { rmSync(claim.file); captured.push(name); }
      else blocked++;
    } catch { blocked++; } // Transient failure keeps the unique claim for a later idempotent retry.
    finally { if (file) closeSync(file.fd); }
  }
  return { captured, blocked };
}
