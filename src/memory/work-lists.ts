import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { mutationDatabase } from "./mutation.ts";
import { canonicalPath } from "./platform.ts";
import { looksSecret } from "./screen.ts";
import { ensureShardDescriptor, resolveAlias, shardDir } from "./shard.ts";
import { machineId } from "./machine.ts";

const SCHEMA = "agent-mem.work-list/v1", ROW_BYTES = 16_384;
export type WorkListFields = Record<string, string | number | boolean | null>;
export type WorkListPolicy = (row: unknown) => boolean | Promise<boolean>;
export interface WorkListSource { source: string; id: string; machine?: string; at?: number }
export interface WorkListView { list: string; fields: WorkListFields; items: { task: string; fields: WorkListFields }[]; closed: boolean }
interface WorkRow { schema: typeof SCHEMA; project: string; machine: string; at: number; nonce: string; list: string; fields: WorkListFields; source?: WorkListSource; id: string }
interface IndexedRow { row: WorkRow; position: number; order: string }
interface Head { file: string; bytes: number; hash: string }
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const invalid = (): never => { throw new Error("invalid work-list input"); };
function regular(path: string, directory = false): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw new Error("work log path is invalid");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function fieldsOf(input: unknown): WorkListFields {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 64 || Object.keys(input).length === 0) return invalid();
  const out: WorkListFields = {};
  for (const [key, value] of Object.entries(input)) {
    if (!bounded(key, 100) || forbidden.has(key) || !(value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 8000 && !value.includes("\0"))) return invalid();
    out[key] = value;
  }
  if (Object.hasOwn(out, "task") && !bounded(out.task, 300)) return invalid();
  if (typeof out.task === "string" && Object.hasOwn(out, "status") && out.status !== null && !["todo", "doing", "done", "dropped"].includes(String(out.status))) return invalid();
  return out;
}
function sourceOf(input: unknown): WorkListSource | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["source", "id", "machine", "at"].includes(key))) return invalid();
  const source = input as WorkListSource;
  if (!bounded(source.source, 500) || !bounded(source.id, 500) || source.machine !== undefined && !bounded(source.machine, 300) || source.at !== undefined && (!Number.isSafeInteger(source.at) || source.at < 0)) return invalid();
  return { source: source.source, id: source.id, ...(source.machine === undefined ? {} : { machine: source.machine }), ...(source.at === undefined ? {} : { at: source.at }) };
}
const receipt = (row: Pick<WorkRow, "source">): string | null => row.source ? hashJSON({ source: row.source.source, id: row.source.id, machine: row.source.machine ?? null }) : null;
const importPayload = (row: Pick<WorkRow, "list" | "fields" | "source">): string => hashJSON({ list: row.list, fields: row.fields, source: row.source });
/** SQLite BINARY sorts UTF-8, unlike the existing JS UTF-16 replay order. Hex code units retain that order,
 * and the terminator sorts before another code unit so a string prefix still comes first. */
function lexicalKey(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) out += value.charCodeAt(i).toString(16).padStart(4, "0");
  return out + "!";
}
/** Numeric source components compare by value; leading zeroes only break an otherwise equal full source id. */
function sourceKey(value: string): string {
  const parts = (value.match(/\d+|\D+/g) ?? []).map(part => {
    if (!/^\d+$/.test(part)) return lexicalKey(part);
    const digits = part.replace(/^0+(?=\d)/, "");
    return `0030${digits.length.toString().padStart(3, "0")}${digits}!`;
  });
  return parts.join("") + " " + lexicalKey(value);
}
// ponytail: the key spells machine, source and id as 4 hex digits a UTF-16 unit, and the source id twice
// (sourceKey keeps the full id as its tie-break), so a row at the 500-character input limits carries a key
// of several KB. Upgrade path: past a length, replace the full-id tie-break with a fixed-width hash of it.
/** Derived only: timestamp, import/native origin, natural source id, machine, append position, row hash.
 * Fixed-width safe integers and encoded strings let the persisted index supply the legacy replay order. */
function replayKey(row: WorkRow, position: number): string {
  if (!Number.isSafeInteger(position) || position < 0) throw new Error("work index has an invalid append position");
  const source = row.source;
  return [String(row.at).padStart(16, "0"), source ? "0" : "1", lexicalKey(source ? source.machine ?? "" : row.machine),
    lexicalKey(source?.source ?? ""), source ? sourceKey(source.id) : "", row.machine, String(position).padStart(16, "0"), row.id].join(" ");
}

/** Stream log bytes with bounded carry; neither a long history nor an invalid oversized row is loaded at once. */
function scan(path: string, consume?: (text: string, end: number) => void, prefixBytes = 0, check: () => void = () => {}): { bytes: number; hash: string; prefix: string } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("work log is not a regular file");
  const fd = openSync(path, "r"), buffer = Buffer.alloc(64 * 1024), full = createHash("sha256"), prefix = createHash("sha256"), decoder = new StringDecoder("utf8");
  let bytes = 0, text = "", lineEnd = 0;
  try {
    for (;;) {
      check();
      const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break;
      const chunk = buffer.subarray(0, n); full.update(chunk);
      if (bytes < prefixBytes) prefix.update(chunk.subarray(0, Math.min(n, prefixBytes - bytes)));
      bytes += n;
      if (consume) {
        text += decoder.write(chunk);
        let end: number;
        while ((end = text.indexOf("\n")) >= 0) {
          check();
          const line = text.slice(0, end); lineEnd += Buffer.byteLength(line + "\n"); text = text.slice(end + 1);
          if (!line || Buffer.byteLength(line) > ROW_BYTES) throw new Error("work log contains an invalid row");
          consume(line, lineEnd);
        }
        if (Buffer.byteLength(text) > ROW_BYTES) throw new Error("work log contains an oversized row");
      }
    }
    check();
    if (consume && (text + decoder.end()).length) throw new Error("work log has an incomplete row");
    return { bytes, hash: full.digest("hex"), prefix: prefix.digest("hex") };
  } finally { closeSync(fd); }
}

/** Project-scoped append truth; the index and writer lock are independent of generations and capture eviction. */
export class WorkListStore {
  readonly dir: string;
  readonly project: string;
  private readonly db: Database;
  private readonly mutation: Database;
  private readonly machine: string;
  private readonly policy: WorkListPolicy;
  private readonly now: () => number;
  private readonly timeRemaining: (() => number) | undefined;
  private readonly busyTimeoutMs: number;
  private readonly readers = new Set<() => void>();
  private closed = false;
  /** #27: the work logs of keys aliased to this project that already have one; read beside this log through their own snapshot cursors, never written. */
  private readonly aliased: WorkListStore[] = [];

  constructor(options: { base: string; project: string; policy: WorkListPolicy; now?: () => number; aliases?: readonly string[]; exact?: boolean; timeRemaining?: () => number; busyTimeoutMs?: number }) {
    if (!bounded(options.project, 1000) || typeof options.policy !== "function") throw new Error("invalid work-list input");
    this.timeRemaining = options.timeRemaining;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 3000;
    if (this.timeRemaining !== undefined && typeof this.timeRemaining !== "function"
      || !Number.isSafeInteger(this.busyTimeoutMs) || this.busyTimeoutMs < 0 || this.busyTimeoutMs > 3000) throw new Error("invalid work-list budget");
    this.checkBudget();
    const base = canonicalPath(options.base);
    this.project = options.exact === true ? options.project : resolveAlias(base, options.project);
    regular(join(base, "projects"), true); regular(shardDir(base, this.project), true);
    this.checkBudget();
    ensureShardDescriptor(base, this.project);
    this.dir = join(shardDir(base, this.project), "work");
    regular(this.dir, true); regular(join(this.dir, "log"), true);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 }); chmodSync(this.dir, 0o700);
    mkdirSync(join(this.dir, "log"), { recursive: true, mode: 0o700 });
    if (lstatSync(this.dir).isSymbolicLink() || lstatSync(join(this.dir, "log")).isSymbolicLink()) throw new Error("work log directory is invalid");
    this.checkBudget();
    this.machine = machineId(base).id;
    this.policy = options.policy; this.now = options.now ?? Date.now;
    for (const name of ["mutation-lock.db", "index.db", "index.db-wal", "index.db-shm"]) regular(join(this.dir, name));
    let openedMutation: Database | undefined, openedDb: Database | undefined;
    try {
      this.mutation = openedMutation = mutationDatabase(this.dir, this.busyTimeoutMs);
      this.checkBudget();
      this.db = openedDb = new Database(join(this.dir, "index.db"), { create: true }); chmodSync(join(this.dir, "index.db"), 0o600);
      this.db.run(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`); this.db.run("PRAGMA journal_mode = WAL");
      // The index is disposable. An older derived schema is replayed without changing a log row.
      this.checkBudget();
      const columns = this.db.query("PRAGMA table_info(work_ops)").all() as { name: string }[];
      if (columns.length && !columns.some(column => column.name === "position")) { this.db.run("DROP TABLE work_ops"); this.db.run("DROP TABLE IF EXISTS work_heads"); }
      this.db.run("CREATE TABLE IF NOT EXISTS work_ops (id TEXT PRIMARY KEY, at INTEGER NOT NULL, machine TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT, position INTEGER NOT NULL, replay TEXT NOT NULL DEFAULT '')");
      this.db.run("CREATE INDEX IF NOT EXISTS work_receipts ON work_ops(receipt)");
      this.db.run("CREATE TABLE IF NOT EXISTS work_heads (file TEXT PRIMARY KEY, bytes INTEGER NOT NULL, hash TEXT NOT NULL)");
      // Take the write transaction only when the replay column or its index is missing, so an ordinary open never
      // waits on another process's refresh or rebuild (#383). The check repeats inside the transaction.
      const migrated = () => (this.db.query("PRAGMA table_info(work_ops)").all() as { name: string }[]).some(column => column.name === "replay")
        && (this.db.query("PRAGMA index_list(work_ops)").all() as { name: string }[]).some(index => index.name === "work_replay");
      this.checkBudget();
      if (!migrated()) this.db.transaction(() => {
        this.checkBudget();
        const columns = this.db.query("PRAGMA table_info(work_ops)").all() as { name: string }[];
        if (!columns.some(column => column.name === "replay")) this.db.run("ALTER TABLE work_ops ADD COLUMN replay TEXT NOT NULL DEFAULT ''");
        this.db.run("CREATE INDEX IF NOT EXISTS work_replay ON work_ops(replay)");
      }).immediate();
      this.checkBudget();
      for (const alias of options.exact === true ? [] : options.aliases ?? []) {
        this.checkBudget();
        if (alias === this.project || !existsSync(join(shardDir(base, alias), "work", "log"))) continue;
        this.aliased.push(new WorkListStore({ base, project: alias, policy: options.policy, ...(options.now ? { now: options.now } : {}), exact: true,
          timeRemaining: this.timeRemaining, busyTimeoutMs: this.busyTimeoutMs }));
      }
      this.checkBudget();
    } catch (error) {
      for (const store of this.aliased) try { store.close(); } catch { /* Preserve the construction failure. */ }
      try { openedDb?.close(); } catch { /* Preserve the construction failure. */ }
      try { openedMutation?.close(); } catch { /* Preserve the construction failure. */ }
      throw error;
    }
  }

  private checkBudget(): void {
    if (this.timeRemaining) {
      const remaining = this.timeRemaining();
      if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("work-list read deadline");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let failure: unknown;
    for (const close of [...this.readers, () => this.db.close(), () => this.mutation.close(), ...this.aliased.map(store => () => store.close())]) {
      try { close(); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }
  private locked<T>(run: () => T): T {
    if (this.closed) throw new Error("work-list store is closed");
    this.checkBudget();
    return this.mutation.transaction(() => { const result = run(); this.checkBudget(); return result; }).immediate();
  }
  private decode(text: string): WorkRow {
    try {
      const row = JSON.parse(text) as WorkRow;
      if (!row || row.schema !== SCHEMA || row.project !== this.project || !/^[a-f0-9]{16}$/.test(row.machine) || !Number.isSafeInteger(row.at) || row.at < 0 || !/^[a-f0-9]{32}$/.test(row.nonce) || !bounded(row.list, 300) || !/^[a-f0-9]{64}$/.test(row.id) || Object.keys(row).some(key => !["schema", "project", "machine", "at", "nonce", "list", "fields", "source", "id"].includes(key))) throw new Error();
      fieldsOf(row.fields); sourceOf(row.source);
      const { id, ...body } = row;
      if (hashJSON(body) !== id || Buffer.byteLength(text) > ROW_BYTES) throw new Error();
      return row;
    } catch { throw new Error("work log contains an invalid hashed row"); }
  }
  private index(row: WorkRow, position: number): void {
    this.checkBudget();
    const key = receipt(row);
    if (key) for (const prior of this.db.query("SELECT payload FROM work_ops WHERE receipt = ?").iterate(key) as Iterable<{ payload: string }>) {
      this.checkBudget();
      if (importPayload(this.decode(prior.payload)) !== importPayload(row)) throw new Error("work log contains conflicting source receipts");
    }
    this.db.query("INSERT OR IGNORE INTO work_ops (id, at, machine, payload, receipt, position, replay) VALUES (?, ?, ?, ?, ?, ?, ?)").run(row.id, row.at, row.machine, canonicalJSON(row), key, position, replayKey(row, position));
  }
  private refresh(force = false): void {
    this.checkBudget();
    const files = readdirSync(join(this.dir, "log")).sort((a, b) => { this.checkBudget(); return a < b ? -1 : a > b ? 1 : 0; });
    if (files.some(file => !/^[a-f0-9]{16}\.jsonl$/.test(file))) throw new Error("work log has an invalid segment name");
    const heads = new Map((this.db.query("SELECT file, bytes, hash FROM work_heads").all() as Head[]).map(head => [head.file, head]));
    const scans = new Map(files.map(file => [file, scan(join(this.dir, "log", file), undefined, heads.get(file)?.bytes ?? 0, () => this.checkBudget())]));
    const reset = force || [...heads].some(([file, head]) => !scans.has(file) || scans.get(file)!.bytes < head.bytes || scans.get(file)!.prefix !== head.hash);
    this.db.transaction(() => {
      if (reset) { this.db.run("DELETE FROM work_ops"); this.db.run("DELETE FROM work_heads"); }
      for (const file of files) {
        this.checkBudget();
        const old = reset ? 0 : heads.get(file)?.bytes ?? 0, current = scans.get(file)!;
        if (old !== current.bytes) scan(join(this.dir, "log", file), (line, end) => { if (end > old) this.index(this.decode(line), end); }, 0, () => this.checkBudget());
        this.db.query("INSERT OR REPLACE INTO work_heads (file, bytes, hash) VALUES (?, ?, ?)").run(file, current.bytes, current.hash);
      }
      // Old readers may rebuild/append this disposable index without the additive replay column. Backfill one
      // row at a time, including on an otherwise unchanged refresh; no payload history is materialized.
      const missing = this.db.query("SELECT id, payload, position FROM work_ops WHERE replay = '' LIMIT 1");
      const update = this.db.query("UPDATE work_ops SET replay = ? WHERE id = ?");
      for (;;) {
        this.checkBudget();
        const old = missing.get() as { id: string; payload: string; position: number } | null;
        if (!old) break;
        update.run(replayKey(this.decode(old.payload), old.position), old.id);
      }
      this.checkBudget();
    }).immediate();
  }
  rebuild(): void { this.locked(() => this.refresh(true)); }
  private async permitted(row: WorkRow): Promise<boolean> {
    this.checkBudget();
    if (looksSecret(canonicalJSON(row))) return false;
    const copy = structuredClone(row); Object.freeze(copy.fields); if (copy.source) Object.freeze(copy.source); Object.freeze(copy);
    let allowed = false;
    try { allowed = await this.policy(copy) === true; } catch { /* Refusal remains a refusal. */ }
    this.checkBudget();
    return allowed;
  }

  /** An ordered, stable read snapshot. The separate read-only connection never holds the mutation lock across
   * a host policy await, so a concurrent append succeeds without changing this read's history frontier. */
  private operations(): IterableIterator<IndexedRow> {
    let opened: Database | undefined;
    let state: { db: Database; rows: IterableIterator<{ payload: string; position: number; replay: string }>; first: IteratorResult<{ payload: string; position: number; replay: string }> };
    try { state = this.locked(() => {
      this.refresh();
      regular(join(this.dir, "index.db"));
      const db = opened = new Database(join(this.dir, "index.db"), { readonly: true });
      try {
        db.run(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`); db.run("PRAGMA cache_size = -2048"); db.run("PRAGMA mmap_size = 0");
        this.checkBudget();
        db.run("BEGIN");
        const rows = db.query("SELECT payload, position, replay FROM work_ops ORDER BY replay").iterate() as IterableIterator<{ payload: string; position: number; replay: string }>;
        return { db, rows, first: rows.next() }; // Establish the snapshot before releasing the writer lock.
      } catch (error) { opened = undefined; db.close(); throw error; }
    }); }
    // The mutation transaction's COMMIT can fail after the snapshot connection opened; close it then (#383).
    catch (error) { opened?.close(); throw error; }
    let first = true, closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.readers.delete(close);
      try { state.rows.return?.(); } finally { try { state.db.run("ROLLBACK"); } finally { state.db.close(); } }
    };
    this.readers.add(close);
    return {
      next: () => {
        if (closed) return { done: true, value: undefined };
        try {
          this.checkBudget();
          const next = first ? state.first : state.rows.next(); first = false;
          this.checkBudget();
          if (next.done) { close(); return { done: true, value: undefined }; }
          return { done: false, value: { row: this.decode(next.value.payload), position: next.value.position, order: next.value.replay } };
        } catch (error) { close(); throw error; }
      },
      return: () => { close(); return { done: true, value: undefined }; },
      [Symbol.iterator]() { return this; },
    };
  }

  /** #27: this log and the aliased keys' logs as one stream in replay order. Each store streams its own snapshot cursor ordered by the derived replay key, so a k-way merge needs no sort and no ceiling. The merge ends the cursors it opened. */
  private merged(): IterableIterator<IndexedRow> {
    if (!this.aliased.length) return this.operations();
    const cursors: IterableIterator<IndexedRow>[] = [];
    try { for (const store of [this, ...this.aliased]) cursors.push(store.operations()); }
    catch (error) { for (const cursor of cursors) cursor.return?.(); throw error; }
    let heads: IteratorResult<IndexedRow>[];
    try { heads = cursors.map(cursor => { this.checkBudget(); return cursor.next(); }); }
    catch (error) { for (const cursor of cursors) try { cursor.return?.(); } catch { /* Preserve the first failure. */ } throw error; }
    const end = () => { for (const cursor of cursors) { try { cursor.return?.(); } catch { /* the first failure is the one reported */ } } };
    return {
      next: () => {
        try {
          this.checkBudget();
          let pick = -1;
          for (let i = 0; i < heads.length; i++) {
            this.checkBudget();
            const head = heads[i]!;
            if (!head.done && (pick < 0 || head.value.order < (heads[pick]! as IteratorYieldResult<IndexedRow>).value.order)) pick = i;
          }
          if (pick < 0) { end(); return { done: true, value: undefined }; }
          const out = heads[pick]! as IteratorYieldResult<IndexedRow>;
          heads[pick] = cursors[pick]!.next();
          return { done: false, value: out.value };
        } catch (error) { end(); throw error; }
      },
      return: () => { end(); return { done: true, value: undefined }; },
      [Symbol.iterator]() { return this; },
    };
  }

  async write(list: string, input: WorkListFields, source?: WorkListSource): Promise<{ id: string; already: boolean }> {
    if (!bounded(list, 300)) return invalid();
    const fields = fieldsOf(input), origin = sourceOf(source);
    const at = origin?.at ?? this.locked(() => {
      this.refresh();
      const previous = this.db.query("SELECT max(at) AS at FROM work_ops WHERE machine = ?").get(this.machine) as { at: number | null };
      return Math.max(this.now(), (previous.at ?? -1) + 1);
    });
    if (!Number.isSafeInteger(at) || at < 0) return invalid();
    const body: Omit<WorkRow, "id"> = { schema: SCHEMA, project: this.project, machine: this.machine, at, nonce: randomBytes(16).toString("hex"), list, fields, ...(origin ? { source: origin } : {}) };
    const row: WorkRow = { ...body, id: hashJSON(body) };
    if (Buffer.byteLength(canonicalJSON(row)) > ROW_BYTES) return invalid();
    if (!await this.permitted(row)) throw new Error("work-list privacy policy refused the write");
    return this.locked(() => {
      this.refresh();
      const key = receipt(row);
      if (key) {
        const found = this.db.query("SELECT payload FROM work_ops WHERE receipt = ? ORDER BY id LIMIT 1").get(key) as { payload: string } | null;
        if (found) {
          const prior = this.decode(found.payload);
          if (importPayload(prior) !== importPayload(row)) throw new Error("work-list source receipt conflicts with an earlier import");
          return { id: prior.id, already: true };
        }
      }
      // No metadata changes after screening: the derived index records same-machine append order.
      regular(join(this.dir, "log", `${this.machine}.jsonl`));
      appendFileSync(join(this.dir, "log", `${this.machine}.jsonl`), canonicalJSON(row) + "\n", { mode: 0o600 });
      this.refresh();
      return { id: row.id, already: false };
    });
  }

  async read(list?: string, includeClosed = false): Promise<WorkListView[]> {
    this.checkBudget();
    if (list !== undefined && !bounded(list, 300) || typeof includeClosed !== "boolean") return invalid();
    const rows = this.merged();
    const views = new Map<string, { fields: WorkListFields; items: Map<string, WorkListFields> }>();
    // ponytail: memory scales with the current distinct lists/items/fields, not historical operations. A caller
    // requesting an enormous current result still needs that result's memory; paged views are the upgrade path.
    try {
      for (const { row } of rows) {
        this.checkBudget();
        const allowed = await this.permitted(row);
        if (this.closed) throw new Error("work-list store is closed");
        if (!allowed) continue;
        if (list !== undefined && row.list !== list) continue;
        let view = views.get(row.list); if (!view) { view = { fields: {}, items: new Map() }; views.set(row.list, view); }
        const task = row.fields.task;
        const target = typeof task === "string" ? view.items.get(task) ?? {} : view.fields;
        if (typeof task === "string") view.items.set(task, target);
        for (const [key, value] of Object.entries(row.fields)) if (key !== "task") { this.checkBudget(); if (value === null) delete target[key]; else target[key] = value; }
      }
    } finally { rows.return?.(); }
    this.checkBudget();
    const result = [...views].sort(([a], [b]) => { this.checkBudget(); return a.localeCompare(b); }).flatMap(([name, view]) => {
      this.checkBudget();
      const closed = view.fields.status === "done";
      return closed && !includeClosed ? [] : [{ list: name, fields: view.fields, items: [...view.items].sort(([a], [b]) => { this.checkBudget(); return a.localeCompare(b); }).map(([task, fields]) => { this.checkBudget(); return { task, fields }; }), closed }];
    });
    this.checkBudget();
    return result;
  }
}
