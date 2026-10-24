import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, chmodSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { CaptureStore, type CaptureInput } from "./memory/capture.ts";
import { memoryHome } from "./memory/home.ts";
import { canonicalPath, processLiveness, processSignature, realPath } from "./memory/platform.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "./memory/policy.ts";
import { configuredPolicyOptions } from "./memory/config.ts";
import { memoryProjectKey } from "./memory/project.ts";
import { effectiveAliases } from "./memory/shard.ts";

export type IngestKind = "codex" | "kimi" | "pi";
export interface IngestOptions {
  cwd: string; base?: string;
  /** Trusted host/test seam. The ordinary CLI discovers native roots instead. */
  files?: readonly string[];
  since?: string; policy?: StandalonePolicyOptions; maxBytes?: number; maxFiles?: number;
}
export interface IngestReceipt {
  files: number; read: number; imported: number; skipped: number; spooled: number; remaining: boolean; errors: number;
  reason?: "source_bound" | "source_unavailable" | "schema_or_time" | "cursor_busy" | "scope_changed";
}

type Scope = "own" | "foreign" | "unknown";
interface Position { identity: string; offset: number; anchor: string; scope: Scope; protocol: string; cutoff: string; skipping: 0 | 1 }
interface Cursor extends Position { token: string | null; pid: number | null; signature: string | null }
const MAX_BYTES = 16 * 1024 * 1024, DEFAULT_BYTES = 4 * 1024 * 1024, MAX_FILES = 128, DEFAULT_FILES = 32;
const MAX_CURSOR_BYTES = 128 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const MAX_RECORD = 256 * 1024, MAX_RECORDS = 4096, MAX_DISCOVERY = 4096, MAX_DEPTH = 8, ANCHOR_BYTES = 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const blank = (): Position => ({ identity: "", offset: 0, anchor: "", scope: "unknown", protocol: "", cutoff: "", skipping: 0 });
const sourceIdentity = (stat: Stats) => hash(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`);
function publicFile(file: string): number {
  // O_NONBLOCK prevents a planted FIFO from hanging before fstat can refuse it.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd), named = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || !same(stat, named) || named.isSymbolicLink()) throw new Error("source unavailable");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function readBytes(fd: number, offset: number, count: number): Buffer {
  const bytes = Buffer.alloc(count), size = readSync(fd, bytes, 0, count, offset);
  return bytes.subarray(0, size);
}
function anchor(fd: number, offset: number): string {
  const from = Math.max(0, offset - ANCHOR_BYTES);
  return hash(readBytes(fd, from, offset - from));
}
function privateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error("cursor unavailable");
  chmodSync(dir, 0o700);
}

/** A transaction-owned per-source lease prevents concurrent awaited screens from regressing a cursor. */
function lease(file: string): { position: Position; save(value: Position): void; close(): void } | undefined {
  let fd: number | undefined = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let db: Database | undefined;
  try {
    const stat = fstatSync(fd), named = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CURSOR_BYTES || !same(stat, named) || named.isSymbolicLink()) throw new Error("cursor unavailable");
    fchmodSync(fd, 0o600);
    // SQLite may open these names itself: reject a planted link/device before handing it the private path.
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const sidecar = lstatSync(file + suffix, { throwIfNoEntry: false });
      if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1 || sidecar.size > MAX_CURSOR_BYTES)) throw new Error("cursor unavailable");
      if (sidecar) chmodSync(file + suffix, 0o600);
    }
    closeSync(fd); fd = undefined;
    db = new Database(file);
    db.run("PRAGMA busy_timeout = 25");
    db.run("CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id=1), identity TEXT NOT NULL, offset INTEGER NOT NULL, anchor TEXT NOT NULL, scope TEXT NOT NULL, protocol TEXT NOT NULL, cutoff TEXT NOT NULL DEFAULT '', skipping INTEGER NOT NULL DEFAULT 0 CHECK (skipping IN (0,1)), token TEXT, pid INTEGER, signature TEXT)");
    const columns = db.query("PRAGMA table_info(cursor)").all() as { name: string }[];
    if (!columns.some(column => column.name === "cutoff")) db.run("ALTER TABLE cursor ADD COLUMN cutoff TEXT NOT NULL DEFAULT ''");
    if (!columns.some(column => column.name === "skipping")) db.run("ALTER TABLE cursor ADD COLUMN skipping INTEGER NOT NULL DEFAULT 0 CHECK (skipping IN (0,1))");
    const signature = processSignature(process.pid);
    if (!signature) { db.close(); return undefined; }
    const token = randomUUID(), database = db;
    const acquired = database.transaction(() => {
      const current = database.query("SELECT * FROM cursor WHERE id=1").get() as Cursor | null;
      if (current?.token && processLiveness(current.pid, current.signature) !== "gone") return undefined;
      const position = current && /^[0-9a-f]{64}$/.test(current.identity) && Number.isSafeInteger(current.offset) && current.offset >= 0 && /^[0-9a-f]{64}$/.test(current.anchor)
        && ["own", "foreign", "unknown"].includes(current.scope) && typeof current.protocol === "string" && current.protocol.length <= 32 && typeof current.cutoff === "string"
        && (current.cutoff === "" || Number.isFinite(Date.parse(current.cutoff))) && (current.skipping === 0 || current.skipping === 1) ? current : blank();
      database.query("INSERT INTO cursor (id,identity,offset,anchor,scope,protocol,cutoff,skipping,token,pid,signature) VALUES (1,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid,signature=excluded.signature")
        .run(position.identity, position.offset, position.anchor, position.scope, position.protocol, position.cutoff, position.skipping, token, process.pid, signature);
      return position;
    }).immediate();
    if (!acquired) { database.close(); return undefined; }
    return {
      position: acquired,
      save(value) {
        const result = database.query("UPDATE cursor SET identity=?,offset=?,anchor=?,scope=?,protocol=?,cutoff=?,skipping=? WHERE id=1 AND token=?")
          .run(value.identity, value.offset, value.anchor, value.scope, value.protocol, value.cutoff, value.skipping, token);
        if (result.changes !== 1) throw new Error("cursor ownership changed");
      },
      close() {
        try { database.query("UPDATE cursor SET token=NULL,pid=NULL,signature=NULL WHERE id=1 AND token=?").run(token); }
        finally { database.close(); }
      },
    };
  } catch (error) {
    // fd may already have been closed before Database construction.
    try { if (fd !== undefined) closeSync(fd); } catch { /* closed */ }
    try { db?.close(); } catch { /* closed */ }
    throw error;
  }
}

/** Native roots only. Discovery never follows a directory symlink or enters an unbounded tree. */
function discover(kind: IngestKind): { files: string[]; bounded: boolean; unavailable: boolean } {
  const root = kind === "codex" ? process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")
    : kind === "kimi" ? process.env.KIMI_CODE_HOME?.trim() || join(homedir(), ".kimi-code")
      : process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const roots = [join(root, "sessions"), ...(kind === "codex" ? [join(root, "archived_sessions")] : [])];
  const files: string[] = []; let visited = 0, bounded = false, rootsRead = 0;
  const walk = (folder: string, depth: number) => {
    if (depth > MAX_DEPTH) { bounded = true; return; }
    let dir: ReturnType<typeof opendirSync>;
    try { if (lstatSync(folder).isSymbolicLink()) return; dir = opendirSync(folder); if (depth === 0) rootsRead++; } catch { return; }
    try {
      for (let item = dir.readSync(); item; item = dir.readSync()) {
        if (++visited > MAX_DISCOVERY) { bounded = true; break; }
        if (item.isSymbolicLink()) continue;
        const file = join(folder, item.name);
        if (item.isDirectory()) walk(file, depth + 1);
        else if (item.isFile() && (kind === "kimi" ? item.name === "wire.jsonl" : item.name.endsWith(".jsonl"))) files.push(file);
        if (bounded && visited > MAX_DISCOVERY) break;
      }
    } finally { dir.closeSync(); }
  };
  for (const folder of roots) walk(folder, 0);
  return { files: files.sort(), bounded, unavailable: rootsRead === 0 };
}

function timeOf(record: Record<string, any>, kind: IngestKind): string | undefined {
  const value = kind === "kimi" ? record.time : record.timestamp;
  const millis = typeof value === "number" && kind === "kimi" && Number.isFinite(value) && value >= 100_000_000_000 ? value
    : typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(millis)) return undefined;
  try { return new Date(millis).toISOString(); } catch { return undefined; }
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(item => object(item) && ["text", "input_text", "output_text"].includes(item.type) && typeof item.text === "string").map(item => item.text).join("\n");
}
function extract(kind: IngestKind, raw: Record<string, any>, project: string): CaptureInput | undefined {
  const message = kind === "codex" && raw.type === "response_item" ? raw.payload
    : kind === "pi" && raw.type === "message" ? raw.message
      : kind === "kimi" && raw.type === "context.append_message" ? raw.message : undefined;
  if (!object(message)) return undefined;
  if (kind === "codex" && ["function_call", "function_call_output"].includes(message.type)) {
    const excerpt = typeof message.arguments === "string" ? message.arguments : typeof message.output === "string" ? message.output : "";
    return { project, agent: kind, event: message.type, ...(typeof message.name === "string" ? { tool: message.name.slice(0, 64) } : {}), excerpt: excerpt.slice(0, 2000) };
  }
  if (!["assistant", "user", "tool", "toolResult"].includes(message.role)) return undefined;
  const excerpt = contentText(message.content);
  if (!excerpt) return undefined;
  return { project, agent: kind, event: "message", excerpt: excerpt.slice(0, 2000),
    ...(typeof message.toolName === "string" ? { tool: message.toolName.slice(0, 64) } : {}),
    ...(typeof message.isError === "boolean" ? { status: message.isError ? "error" : "success" } : {}) };
}

/**
 * Incremental deterministic native-message ingestion; no watcher, account, model or network operation.
 * Native source contracts: Codex rust-v0.163.0 protocol RolloutItem; Pi session-manager v3;
 * Kimi b5e28fd6 human/persist/v2/wire.ts (protocol 1.5) and sessionIndexSource.recoverCwd.
 * ponytail: discovery covers at most 4096 directory entries and depth 8. A larger native tree reports
 * remaining/source_bound; a future native index cursor can extend coverage without a resident watcher.
 * Within that bound a durable hash-only rotation admits at most maxFiles source attempts per call, including
 * completed and partial files. A stable full tour without unfinished data may report remaining false.
 * Cursors assume append-only native logs, checking the last 1024 committed bytes plus inode/birthtime. In-place
 * historical edits outside that anchor are not tracked; use a new native file identity for rewritten history.
 * Oversized physical records retain only a discard flag and byte offset until the newline; ordinary partial
 * records remain uncommitted. Broader cutoff/replacement/truncation resets clear that discard state.
 */
export async function ingestTranscript(kind: IngestKind, options: IngestOptions): Promise<IngestReceipt> {
  const result: IngestReceipt = { files: 0, read: 0, imported: 0, skipped: 0, spooled: 0, remaining: false, errors: 0 };
  const fail = (reason: NonNullable<IngestReceipt["reason"]>, remaining = false) => { result.errors++; result.reason ??= reason; result.remaining ||= remaining; };
  const bytes = options.maxBytes ?? DEFAULT_BYTES, count = options.maxFiles ?? DEFAULT_FILES;
  if (!["codex", "kimi", "pi"].includes(kind) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES || !Number.isSafeInteger(count) || count < 1 || count > MAX_FILES
    || options.files !== undefined && (!Array.isArray(options.files) || options.files.length > MAX_FILES || options.files.some(file => typeof file !== "string" || !isAbsolute(file) || file.includes("\0")))
    || options.since !== undefined && !Number.isFinite(Date.parse(options.since))) { fail("source_bound"); return result; }
  const since = options.since === undefined ? undefined : new Date(options.since).toISOString();
  let capture: CaptureStore | undefined, rotation: ReturnType<typeof lease> = undefined;
  try {
    const cwd = realPath(options.cwd), base = canonicalPath(options.base ?? memoryHome()), aliases = effectiveAliases(base);
    const aliasStamp = JSON.stringify([...aliases].sort()), requested = memoryProjectKey(cwd, { repositoryIsolation: true }), project = aliases.get(requested) ?? requested;
    const policy = createStandalonePolicy(configuredPolicyOptions(base, cwd, options.policy));
    const scopes = new Map<string, Scope>();
    const guard = () => { if (JSON.stringify([...effectiveAliases(base)].sort()) !== aliasStamp) throw new Error("scope changed"); };
    const scopeOf = (value: unknown): Scope => {
      if (typeof value !== "string" || !isAbsolute(value)) return "unknown";
      if (scopes.has(value)) return scopes.get(value)!;
      let scope: Scope = "unknown";
      try { const key = memoryProjectKey(realPath(value), { repositoryIsolation: true }); scope = (aliases.get(key) ?? key) === project ? "own" : "foreign"; } catch { /* unavailable cwd */ }
      if (scopes.size < 64) scopes.set(value, scope);
      return scope;
    };
    capture = new CaptureStore({ memoryDir: base, project, cwd });
    const directory = join(capture.dir, "ingest"); privateDirectory(directory);
    const found = options.files === undefined ? discover(kind) : { files: [...new Set(options.files)], bounded: false, unavailable: false };
    if (found.unavailable) fail("source_unavailable");
    if (found.bounded) { result.remaining = true; result.reason = "source_bound"; }
    const candidates = found.files.map(file => {
      const id = hash(`${kind}\n${file}`);
      try { const stat = lstatSync(file); return { file, id, stamp: hash(`${id}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`) }; }
      catch { return { file, id, stamp: "unavailable" }; }
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (!candidates.length) return result;
    rotation = lease(join(directory, `.rotation-${kind}.db`));
    if (!rotation) { fail("cursor_busy", true); return result; }
    const fingerprint = hash(JSON.stringify([since ?? "", candidates.map(item => [item.id, item.stamp])]));
    const tour = rotation.position;
    if (tour.anchor !== fingerprint || tour.offset >= candidates.length) { tour.offset = 0; tour.scope = "unknown"; }
    tour.anchor = fingerprint; tour.protocol = "rotation-v1"; tour.cutoff = since ?? "";
    const nextIndex = candidates.findIndex(item => item.id > tour.identity), start = nextIndex < 0 ? 0 : nextIndex;
    const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
    const allowance = Math.min(count, candidates.length - tour.offset);
    let budget = bytes, records = 0, attempted = 0, unfinished = tour.scope === "own";
    for (const { file, id: sourceId } of ordered) {
      if (budget <= 0 || records >= MAX_RECORDS || attempted >= allowance) break;
      attempted++;
      const errorsBefore = result.errors;
      let sourceRemaining = false;
      let fd: number | undefined, cursor: ReturnType<typeof lease> = undefined;
      try {
        fd = publicFile(file);
        const canonical = realPath(file), initial = fstatSync(fd), identity = sourceIdentity(initial);
        cursor = lease(join(directory, hash(`${kind}\n${canonical}`) + ".db"));
        if (!cursor) { fail("cursor_busy", true); continue; }
        let position = cursor.position;
        const cutoff = since ?? "", broader = position.cutoff !== "" && (cutoff === "" || cutoff < position.cutoff);
        if (position.identity !== identity || position.offset > initial.size || position.anchor !== anchor(fd, position.offset) || broader) position = { ...blank(), identity };
        position.cutoff = cutoff;
        if (!position.anchor) position.anchor = anchor(fd, position.offset);
        cursor.save(position); result.files++;
        if (position.offset === initial.size) {
          if (position.skipping) { sourceRemaining = true; result.reason ??= "source_bound"; }
          continue;
        }
        let metadataGuard = () => {};
        if (kind === "kimi") {
          let metadata: Record<string, any> | undefined;
          for (let folder = dirname(file), depth = 0; depth < 3 && !metadata; depth++, folder = dirname(folder)) {
            let stateFd: number | undefined;
            try {
              const stateFile = join(folder, "state.json"); stateFd = publicFile(stateFile);
              const stat = fstatSync(stateFd); if (stat.size > MAX_RECORD) throw new Error("metadata bound");
              const body = readBytes(stateFd, 0, stat.size), decoded: unknown = JSON.parse(utf8.decode(body));
              if (!object(decoded) || !await policy.screen(decoded)) throw new Error("metadata unavailable");
              metadata = decoded;
              metadataGuard = () => { const now = lstatSync(stateFile); if (!same(stat, now) || stat.size !== now.size || stat.mtimeMs !== now.mtimeMs) throw new Error("metadata changed"); };
              position.scope = scopeOf(metadata.cwd ?? metadata.workDir ?? (object(metadata.custom) ? metadata.custom.cwd : undefined));
            } catch { /* Only a known, public native metadata record may bind this wire. */ }
            finally { if (stateFd !== undefined) closeSync(stateFd); }
          }
          if (!metadata) position.scope = "unknown";
        }
        const window = readBytes(fd, position.offset, Math.min(budget, initial.size - position.offset)); budget -= window.length;
        let consumed = 0;
        while (consumed < window.length && records < MAX_RECORDS) {
          const end = window.indexOf(10, consumed);
          if (position.skipping) {
            // This physical record was already counted and rejected. Persist only its scan offset, never bytes.
            const next = end < 0 ? window.length : end + 1;
            position.offset += next - consumed;
            position.skipping = end < 0 ? 1 : 0;
            position.anchor = anchor(fd, position.offset); cursor.save(position);
            consumed = next;
            if (end < 0) { sourceRemaining = true; result.reason ??= "source_bound"; break; }
            continue;
          }
          if (end < 0) {
            sourceRemaining = true;
            const unread = window.length - consumed;
            if (unread > MAX_RECORD) {
              // Confirmed oversized without parsing it. Later calls discard bounded chunks through its newline.
              records++; result.read++; result.skipped++; fail("source_bound");
              position.offset += unread; position.skipping = 1;
              position.anchor = anchor(fd, position.offset); cursor.save(position);
            }
            break;
          }
          const offset = position.offset, line = window.subarray(consumed, end), next = offset + line.length + 1;
          records++; result.read++;
          let raw: unknown;
          try { if (line.length > MAX_RECORD) throw new Error("record bound"); raw = JSON.parse(utf8.decode(line)); if (!object(raw)) throw new Error("record shape"); }
          catch { fail("schema_or_time"); result.skipped++; }
          if (object(raw)) {
            const context = kind === "codex" && ["session_meta", "turn_context"].includes(raw.type) ? raw.payload
              : kind === "pi" && raw.type === "session" ? raw : undefined;
            const permitted = await policy.screen(raw);
            guard(); metadataGuard();
            if (context !== undefined) position.scope = permitted && object(context) ? scopeOf(context.cwd) : "unknown";
            else if (raw.cwd !== undefined) position.scope = permitted ? scopeOf(raw.cwd) : "unknown";
            if (kind === "kimi" && raw.type === "metadata") {
              position.protocol = typeof raw.protocol_version === "string" && ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5"].includes(raw.protocol_version) ? raw.protocol_version : "unknown";
            }
            const input = extract(kind, raw, project);
            if (input) {
              const at = timeOf(raw, kind);
              if (!at || position.scope === "unknown" || kind === "kimi" && !/^1\.[0-5]$/.test(position.protocol)) { fail("schema_or_time"); result.skipped++; }
              else if (!permitted || position.scope !== "own" || since !== undefined && at < since) result.skipped++;
              else {
                input.at = at;
                if (!await policy.screen(input)) result.skipped++;
                else {
                  guard(); metadataGuard();
                  const now = fstatSync(fd), named = lstatSync(file);
                  if (!same(initial, now) || !same(initial, named) || now.size !== initial.size || now.mtimeMs !== initial.mtimeMs
                    || hash(readBytes(fd, offset, line.length)) !== hash(line)) throw new Error("source changed");
                  const receipt = hash(`${kind}\n${identity}\n${offset}\n${hash(line)}`);
                  const appended = capture.append(input, { receipt });
                  if ("spooled" in appended) result.spooled++;
                  else if (appended.already) result.skipped++;
                  else result.imported++;
                }
              }
            } else result.skipped++;
          }
          position.offset = next; position.anchor = anchor(fd, next); cursor.save(position);
          consumed = end + 1;
        }
        if (position.offset < initial.size) sourceRemaining = true;
      } catch { fail("source_unavailable", true); }
      finally {
        try { cursor?.close(); }
        finally {
          if (fd !== undefined) closeSync(fd);
          unfinished ||= sourceRemaining || result.errors > errorsBefore;
          tour.identity = sourceId; tour.offset++; tour.scope = unfinished ? "own" : "unknown";
          rotation.save(tour);
        }
      }
    }
    const completeTour = tour.offset >= candidates.length;
    result.remaining ||= !completeTour || unfinished;
    if (completeTour) { tour.offset = 0; tour.scope = "unknown"; rotation.save(tour); }
    guard();
  } catch { fail("scope_changed"); }
  finally { try { rotation?.close(); } finally { capture?.close(); } }
  return result;
}
