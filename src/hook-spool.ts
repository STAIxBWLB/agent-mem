import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { CaptureAppend, CaptureInput } from "./memory/capture.ts";
import { normalizeCaptureFields, type NormalizedCaptureFields } from "./memory/capture-input.ts";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "./memory/policy.ts";
import { appendMetrics, type CaptureDropReason } from "./memory/metrics.ts";
import { HOOK_EVENTS, HOOK_INPUT_BYTES } from "./hook-contract.ts";

const SCHEMA = "agent-mem.hook-capture/v1";
const RECORD_BYTES = HOOK_INPUT_BYTES + 8192, MAX_FILES = 256, MAX_BYTES = 2 * 1024 * 1024;
const DRAIN_FILES = 32, DRAIN_BYTES = 256 * 1024;
// ponytail: a finite native admission reserve covers deferred replay, not unlimited locked intake.
// Upgrade: coordinated append-only capacity accounting and observable backpressure at exhaustion.
const CAPACITY_FILES = 32, CAPACITY_BYTES = 256 * 1024;
const namePattern = /^(hook-([a-f0-9]{64})-([a-f0-9]{64})-([a-f0-9]{32})\.json)(?:\.draining-[a-f0-9]{24})?$/;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
interface Record { schema: typeof SCHEMA; cwd: string; scope: string | null; root?: string; nonce: string; capture: NormalizedCaptureFields }
export interface PendingHookCapture { name: string; cwd: string; receipt: string; deferred?: true; backlog?: true }
export class HookSpoolFull extends Error { constructor() { super("hook storage full"); } }
interface Options { cwd: string; base: string; policy?: StandalonePolicyOptions; deferAtCapacity?: true }
const directory = (base: string) => join(base, "hook-spool");
function physicalRoot(cwd: string): string {
  const stat = lstatSync(cwd);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("hook root unavailable");
  return hash(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`);
}

function privateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("hook storage unavailable");
  chmodSync(dir, 0o700);
}
function entries(base: string, capacity = false): { name: string; size: number; modified: number }[] {
  const dir = capacity ? join(directory(base), ".capacity") : directory(base), maximum = capacity ? CAPACITY_FILES : MAX_FILES, stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("hook storage unavailable");
  const reader = opendirSync(dir), rows: { name: string; size: number; modified: number }[] = [];
  try {
    for (let scanned = 0; scanned <= maximum + 4; scanned++) {
      const entry = reader.readSync(); if (!entry) return rows;
      if ([".writing", ".quarantine", ".capacity", ".maintenance"].includes(entry.name) && entry.isDirectory()) continue;
      if (rows.length === maximum) return rows;
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

/** Strict subset, not a substitute Git parser. Native Git decides include conditions and values;
 * this parser discovers bounded candidate dependencies without applying them as active config. */
function identityConfig(text: string, include?: (path: string, condition?: string) => void): [string, string][] {
  const relevant: [string, string][] = [];
  let section = "", subsection = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith("[")) {
      const match = /^\[([a-zA-Z0-9-]+)(?:\s+"([^"\\]*)")?\]\s*(?:[#;].*)?$/.exec(line);
      if (!match) throw new Error("unsupported Git config section");
      section = match[1]!.toLowerCase(); subsection = match[2] ?? "";
      continue;
    }
    const match = /^([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(.*))?$/.exec(line);
    if (!section || !match) throw new Error("unsupported Git config entry");
    const key = match[1]!.toLowerCase();
    let value = match[2] ?? "true";
    validateConfigValue(value);
    const includePath = (section === "include" || section === "includeif") && key === "path";
    const deciding = includePath || section === "remote" && subsection === "origin" && key === "url"
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
    if (includePath) {
      if (!value || section === "includeif" && !subsection) throw new Error("unsupported Git include path");
      include?.(value, section === "includeif" ? subsection : undefined);
    } else if (section === "remote" && subsection === "origin" && key === "url") relevant.push(["origin", value]);
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
export function hookCaptureScope(cwd: string, base: string, cacheValidity = false, extraGitConfig?: string): string | undefined {
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
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        // Pending capture survives harmless Git rewrites. A derived native-identity cache
        // has a stricter validity binding: even an ignored/unsupported config change must miss.
        if (cacheValidity) parts.push(`${file}:${hash(text)}`);
        return text;
      } finally { closeSync(fd); }
    };
    cwd = realPath(cwd);
    const home = canonicalPath(process.env.HOME?.trim() || homedir());
    parts.push(`${cwd}:${identity(cwd)}`, `home:${home}`);
    // The fixed worker keeps HOME but strips inherited Git routing/override environment. Check the ordinary
    // system locations conservatively too; unsupported identity-affecting configuration refuses resolution.
    const configuration: [string, string][] = [];
    let hasIncludes = false;
    const includedFiles = new Map<string, { digest: string; depth: number; deciding: boolean }>();
    // ponytail: at most four nested include levels and sixteen candidate files (64 KiB each).
    // Conditions are not interpreted here; identity-changing dynamic conditions stay unknown
    // until a bounded native activation receipt can bind their effect without hashing branch state.
    const configurationFile = (file: string, depth = 0, ancestors = new Set<string>()): { relevant: [string, string][]; digest: string; depth: number; deciding: boolean } => {
      const text = content(file);
      if (ancestors.has(file)) throw new Error("cyclic Git config include");
      const next = new Set(ancestors).add(file), dependencies: [string, string][] = [];
      let nesting = 0, nestedDeciding = false;
      const relevant = identityConfig(text, (candidate, condition) => {
        hasIncludes = true;
        if (depth >= 4 || candidate.startsWith("~") && !candidate.startsWith("~/") || candidate.includes("%(")) throw new Error("unsupported Git config include");
        const target = candidate.startsWith("~/") ? resolve(home, candidate.slice(2)) : resolve(dirname(file), candidate);
        if (next.has(target)) throw new Error("cyclic Git config include");
        let dependency = includedFiles.get(target);
        if (!dependency) {
          if (includedFiles.size >= 16) throw new Error("Git config include file bound");
          // Reserve before recursion: the bound covers all candidates, not just completed subtrees.
          includedFiles.set(target, { digest: "", depth: 0, deciding: false });
          dependency = configurationFile(target, depth + 1, next);
          includedFiles.set(target, dependency);
        }
        nesting = Math.max(nesting, 1 + dependency.depth);
        if (depth + nesting > 4) throw new Error("Git config include depth bound");
        if (!cacheValidity && dependency.deciding && condition && !/^gitdir(?:\/i)?:/i.test(condition)) throw new Error("dynamic Git identity condition unavailable");
        nestedDeciding ||= dependency.deciding;
        // Bind only the same deciding subset as ordinary config. Included origins are
        // dependencies, never active values used by the direct-origin ambiguity check.
        if (dependency.deciding) dependencies.push([condition ?? "", dependency.digest]);
      });
      return { relevant, digest: hash(JSON.stringify([relevant, dependencies])), depth: nesting, deciding: relevant.length > 0 || nestedDeciding };
    };
    const addConfiguration = (file: string) => { const parsed = configurationFile(file); configuration.push(...parsed.relevant); parts.push(`configuration:${file}:${parsed.digest}`); };
    for (const file of new Set(["/etc/gitconfig", "/usr/local/etc/gitconfig", "/opt/homebrew/etc/gitconfig", ...(cacheValidity && extraGitConfig ? [extraGitConfig] : [])])) addConfiguration(file);
    for (const file of [join(home, ".config", "git", "config"), join(home, ".gitconfig")]) addConfiguration(file);
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
        if (cacheValidity) {
          const head = lstatSync(join(gitDir, "HEAD"));
          if (!head.isFile() || head.isSymbolicLink()) return undefined;
          parts.push(`HEAD:${hash(content(join(gitDir, "HEAD"), 4096))}`);
          for (const name of ["objects", "refs"]) parts.push(`${name}:${identity(join(commonDir, name))}`);
        }
        // Git still consults legacy remote definitions when config has no origin.
        // Bind bytes for both pending capture and the stricter identity cache.
        for (const dir of new Set([commonDir, gitDir])) for (const legacy of ["remotes", "branches"]) {
          const file = join(dir, legacy, "origin");
          parts.push(`${file}:${hash(content(file))}`);
        }
        addConfiguration(join(commonDir, "config"));
        const worktreeConfig = configuration.filter(([key]) => key === "extensions.worktreeconfig").at(-1)?.[1];
        if (worktreeConfig === "true") addConfiguration(join(gitDir, "config.worktree"));
        else if (hasIncludes) {
          // An included candidate may enable this source; bind it without guessing whether it does.
          const file = join(gitDir, "config.worktree"), candidate = configurationFile(file); if (candidate.deciding) parts.push(`worktree-candidate:${candidate.digest}`);
        }
        break;
      }
      const parent = dirname(folder); if (parent === folder) { reachedRoot = true; break; } folder = parent;
    }
    if (!found && (!reachedRoot || cacheValidity)) return undefined;
    if (configuration.filter(([key]) => key === "origin").length > 1) return undefined;
    const scalars = new Map(configuration.filter(([key]) => !key.startsWith("rewrite:")));
    const rewrites = configuration.filter(([key]) => key.startsWith("rewrite:"));
    parts.push(found ? "git" : "no-git", JSON.stringify([...scalars].sort()), JSON.stringify(rewrites));
    // Opaque bounded binding only. Actual schema/project interpretation stays with the worker's core readers;
    // importing those here would load SQLite in the low-RSS parent. File replacement alone is irrelevant.
    if (cacheValidity) for (const file of ["aliases.jsonl", "profile.json", "shards.json"]) parts.push(`${file}:${hash(content(join(base, file)))}`);
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
  const claim = join(dirname(file.file), `${match[1]}.draining-${randomBytes(12).toString("hex")}`);
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
    if (!value || typeof value !== "object" || Array.isArray(value) || ![5, 6].includes(Object.keys(value).length)
      || Object.keys(value).some(key => !["schema", "cwd", "scope", "root", "nonce", "capture"].includes(key))
      || value.root !== undefined && (typeof value.root !== "string" || !/^[a-f0-9]{64}$/.test(value.root))
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
interface QuarantineBatch { held?: Quarantined[] }
function trimQuarantine(base: string, files = 0, bytes = 0, batch?: QuarantineBatch): boolean {
  const dir = join(directory(base), ".quarantine");
  if (!lstatSync(dir, { throwIfNoEntry: false })) { if (batch) batch.held = []; return true; }
  privateDirectory(dir);
  const held = batch?.held ?? quarantineEntries(dir);
  if (batch) batch.held = held;
  let size = held.reduce((sum, row) => sum + row.size, 0), count = held.length;
  for (const row of held) {
    if (count + files <= MAX_FILES && size + bytes <= MAX_BYTES) return true;
    let file: OwnedFile | undefined;
    try {
      file = openOwned(join(dir, row.name));
      if (file.initial.dev !== row.dev || file.initial.ino !== row.ino || file.initial.size !== row.size || file.initial.mtimeMs !== row.modified) continue;
      if (owns(file)) {
        rmSync(file.file); size -= row.size; count--;
        if (batch) batch.held = batch.held!.filter(kept => kept !== row);
      }
    } catch { /* A replacement is never removed using an older inventory receipt. */ }
    finally { if (file) closeSync(file.fd); }
  }
  return count + files <= MAX_FILES && size + bytes <= MAX_BYTES;
}
/** Policy refusals retain only a bounded numeric receipt, never the rejected capture body. */
function retireClaim(base: string, file: OwnedFile, preserve: boolean, batch?: QuarantineBatch): boolean {
  if (!owns(file)) return false;
  if (!preserve) { rmSync(file.file); return true; }
  const quarantine = join(directory(base), ".quarantine"); privateDirectory(quarantine);
  const body = JSON.stringify({ schema: "agent-mem.hook-quarantine/v1", reason: "policy", bytes: file.initial.size, at: Date.now() });
  if (!trimQuarantine(base, 1, Buffer.byteLength(body), batch) || !owns(file)) return false;
  const name = `${file.file.slice(file.file.lastIndexOf("/") + 1)}.quarantined-${randomBytes(12).toString("hex")}`;
  const destination = join(quarantine, name);
  writeFileSync(destination, body, { mode: 0o600, flag: "wx" });
  if (!owns(file)) { rmSync(destination); return false; }
  rmSync(file.file);
  if (batch) {
    const stat = lstatSync(destination);
    batch.held!.push({ name, size: stat.size, modified: stat.mtimeMs, dev: stat.dev, ino: stat.ino });
    batch.held!.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
  }
  return true;
}

const RETIRE_AFTER_MS = 7 * 24 * 3600_000;
/** Private numeric maintenance cursor: each invocation inspects a different bounded slice. */
function retirementCursor(base: string, capacity: boolean, length: number): { start: number; save(n: number): void } {
  const dir = join(directory(base), ".maintenance"); privateDirectory(dir);
  const name = join(dir, capacity ? "reserve" : "active");
  let start = 0, file: OwnedFile | undefined;
  try {
    file = openOwned(name);
    if (file.initial.size <= 16) {
      const bytes = Buffer.alloc(file.initial.size);
      if (readSync(file.fd, bytes, 0, bytes.length, 0) === bytes.length && owns(file) && /^\d+$/.test(bytes.toString())) start = Number(bytes.toString()) % Math.max(1, length);
    }
  } catch { /* A missing or invalid derived cursor starts at the first slice. */ }
  finally { if (file) closeSync(file.fd); }
  return { start, save(n) {
    const temporary = join(dir, `.cursor-${randomBytes(12).toString("hex")}`);
    try { writeFileSync(temporary, String(n % Math.max(1, length)), { mode: 0o600, flag: "wx" }); renameSync(temporary, name); }
    finally { rmSync(temporary, { force: true }); }
  } };
}
/** ponytail: remove undrainable data only after seven days, at
 * most32 files/256KiB per admission. Count loss before deleting bodies. Upgrade:
 * a person-visible durable dead-letter export and coordinated maintenance accounting. */
function retireUnresolved(base: string, _admittingCwd: string | undefined, inventory: ReturnType<typeof entries>, incomingBytes: number, minimal: boolean, capacity = false, _sharedBatch?: QuarantineBatch): Set<string> {
  const retired = new Set<string>();
  let count = inventory.length, bytes = inventory.reduce((sum, row) => sum + row.size, 0);
  const fits = () => count < (capacity ? CAPACITY_FILES : MAX_FILES) && bytes + incomingBytes <= (capacity ? CAPACITY_BYTES : MAX_BYTES);
  const due = inventory.some(row => Date.now() - row.modified >= RETIRE_AFTER_MS);
  if (!inventory.length || minimal && fits() && !due) return retired;
  const active = [...inventory].sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
  let cursor: ReturnType<typeof retirementCursor>;
  try { cursor = retirementCursor(base, capacity, active.length); } catch { return retired; }
  let remaining = DRAIN_BYTES, scanned = 0;
  const scopes = new Map<string, string | undefined>();
  try {
    for (; scanned < Math.min(DRAIN_FILES, active.length); scanned++) {
      if (minimal && fits() && !due) break;
      const row = active[(cursor.start + scanned) % active.length]!;
      const match = namePattern.exec(row.name); if (!match) continue;
      if (row.size <= RECORD_BYTES && row.size > remaining) break;
      let file: OwnedFile | undefined;
      try {
        file = openOwned(join(capacity ? join(directory(base), ".capacity") : directory(base), row.name));
        if (file.initial.size !== row.size || file.initial.mtimeMs !== row.modified) continue;
        if (row.size <= RECORD_BYTES) remaining -= row.size;
        const record = decoded(file);
        const valid = record && hash(record.value.cwd) === match[2] && record.value.nonce === match[4] && (record.value.scope ?? "0".repeat(64)) === match[3];
        let reason: CaptureDropReason | undefined;
        if (valid) {
          if (Date.now() - Date.parse(record.value.capture.at) < RETIRE_AFTER_MS) continue;
          try { const cwd = lstatSync(record.value.cwd); if (!cwd.isDirectory() || cwd.isSymbolicLink()) reason = "cwd_removed"; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") reason = "cwd_removed"; }
          if (!reason) {
            if (record.value.scope === null) reason = "scope_unknown";
            else {
              if (!scopes.has(record.value.cwd)) scopes.set(record.value.cwd, hookCaptureScope(record.value.cwd, base));
              const currentScope = scopes.get(record.value.cwd);
              if (currentScope === undefined) reason = "scope_unknown";
              else if (currentScope !== record.value.scope) reason = "undrainable_expired";
            }
          }
          if (!reason) continue;
        }
        const claim = claimOwned(base, row.name, file);
        if (!claim || !owns(claim)) continue;
        // Failure to persist this numeric receipt keeps the body pending, never silently lost.
        if (reason) appendMetrics(base, [{ at: new Date().toISOString(), kind: "hook", captureDrops: 1, captureDropReason: reason }]);
        if (retireClaim(base, claim, false)) { retired.add(row.name); count--; bytes -= row.size; }
      } catch { /* Transient I/O and changed evidence stay pending. */ }
      finally { if (file) closeSync(file.fd); }
    }
  } finally { try { cursor.save(cursor.start + Math.max(1, scanned)); } catch { /* Derived cursor failure never deletes data. */ } }
  return retired;
}

/** INTERNAL malformed-publication maintenance. A native Git failure is not permission to
 * discard a valid pending record; only positively invalid publications leave admission. */
export function quarantineHookScope(options: { cwd: string; base: string; scope: string }): { retired: number } {
  let retired = 0;
  if (!/^[a-f0-9]{64}$/.test(options.scope)) return { retired };
  const cwd = realPath(options.cwd), base = canonicalPath(options.base), cwdHash = hash(cwd);
  trimQuarantine(base);
  const rows = entries(base).filter(row => {
    const match = namePattern.exec(row.name); return match && match[2] === cwdHash && match[3] === options.scope;
  }).sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
  let remaining = DRAIN_BYTES;
  for (const row of rows.slice(0, DRAIN_FILES)) {
    if (row.size <= RECORD_BYTES && row.size > remaining) break;
    let file: OwnedFile | undefined;
    try {
      file = openOwned(join(directory(base), row.name));
      if (file.initial.size !== row.size || file.initial.mtimeMs !== row.modified) continue;
      const claim = claimOwned(base, row.name, file); if (!claim) continue;
      if (claim.initial.size <= RECORD_BYTES) remaining -= claim.initial.size;
      const record = decoded(claim), match = namePattern.exec(row.name)!;
      const valid = !!record && record.value.cwd === cwd && record.value.scope === options.scope && record.value.nonce === match[4];
      if (!valid && retireClaim(base, claim, false)) retired++;
    } catch { /* A transient failure or foreign replacement is never treated as acknowledgement. */ }
    finally { if (file) closeSync(file.fd); }
  }
  return { retired };
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
  const record: Record = { schema: SCHEMA, cwd, scope, root: physicalRoot(cwd), nonce, capture }, bytes = JSON.stringify(record);
  if (Buffer.byteLength(bytes) > RECORD_BYTES) throw new Error("hook record bound");
  const dir = directory(base), writing = join(dir, ".writing"); privateDirectory(dir); privateDirectory(writing);
  const inventory = entries(base);
  const full = inventory.length >= MAX_FILES || inventory.reduce((sum, row) => sum + row.size, 0) + Buffer.byteLength(bytes) > MAX_BYTES;
  // Valid foreign data stays pending in the active tier. The separate bounded reserve
  // admits this project's event without erasing that backlog or rebinding its project.
  // Use one retirement pass, including at capacity; two passes duplicate cold I/O before the worker.
  const quarantineBatch: QuarantineBatch = {};
  const retired = retireUnresolved(base, cwd, inventory, Buffer.byteLength(bytes), event === "SessionStart", false, quarantineBatch);
  const queued = inventory.filter(row => !retired.has(row.name));
  let reserved = entries(base, true), destination = dir, deferred = false;
  const backlog = queued.length > 0 || reserved.length > 0;
  // A bounded cwd/scope-bound reserve admits the already-screened current event before
  // project resolution or optional replay. It is not privacy quarantine and is replayable.
  if (queued.length >= MAX_FILES || queued.reduce((sum, row) => sum + row.size, 0) + Buffer.byteLength(bytes) > MAX_BYTES) {
    if (options.deferAtCapacity !== true) throw new HookSpoolFull();
    destination = join(dir, ".capacity"); privateDirectory(destination);
    const retiredCapacity = retireUnresolved(base, cwd, reserved, Buffer.byteLength(bytes), true, true, quarantineBatch);
    reserved = reserved.filter(row => !retiredCapacity.has(row.name));
    if (reserved.length >= CAPACITY_FILES || reserved.reduce((sum, row) => sum + row.size, 0) + Buffer.byteLength(bytes) > CAPACITY_BYTES) throw new HookSpoolFull();
    deferred = true;
  }
  const name = `hook-${hash(cwd)}-${scope ?? "0".repeat(64)}-${nonce}.json`, temporary = join(writing, name);
  try { writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); renameSync(temporary, join(destination, name)); }
  finally { rmSync(temporary, { force: true }); }
  return { name, cwd, receipt: hash(bytes), ...(deferred ? { deferred: true as const } : {}), ...(backlog ? { backlog: true as const } : {}) };
}

export function hookCapturePending(base: string, name: string): boolean {
  try {
    if ([...entries(base), ...entries(base, true)].some(row => row.name === name || row.name.startsWith(name + "."))) return true;
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
  const matching = (rows: ReturnType<typeof entries>, capacity: boolean) => rows.filter(row => {
    const m = namePattern.exec(row.name); return m && m[2] === hash(cwd) && m[3] === stamp;
  }).sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name)).map(row => ({ ...row, capacity }));
  const rows = [...matching(entries(base, true), true), ...matching(entries(base), false)]
    .sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
  let remaining = DRAIN_BYTES, blocked = 0;
  for (const row of rows.slice(0, DRAIN_FILES)) {
    if (options.timeRemaining && options.timeRemaining() < 8 || row.size <= RECORD_BYTES && row.size > remaining) break;
    const match = namePattern.exec(row.name)!, name = match[1]!;
    let file: OwnedFile | undefined;
    try {
      file = openOwned(join(row.capacity ? join(dir, ".capacity") : dir, row.name));
      if (file.initial.size !== row.size || file.initial.mtimeMs !== row.modified) { blocked++; continue; }
      const claim = claimOwned(base, row.name, file);
      if (!claim) { blocked++; continue; }
      if (claim.initial.size <= RECORD_BYTES) remaining -= claim.initial.size;
      const record = decoded(claim);
      if (!record || record.value.cwd !== cwd || record.value.scope !== null && record.value.scope !== stamp || record.value.nonce !== match[4]) {
        retireClaim(base, claim, false); blocked++; continue;
      }
      const value = record.value, c = value.capture;
      if (value.scope === null) { blocked++; continue; }
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
