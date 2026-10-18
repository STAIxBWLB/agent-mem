import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { mutationDatabase } from "./mutation.ts";
import { canonicalPath } from "./platform.ts";
import { looksSecret } from "./screen.ts";
import { ensureShardDescriptor, resolveAlias, shardDir } from "./shard.ts";
import { machineId } from "./store.ts";

const SCHEMA = "agent-mem.work-list/v1", ROW_BYTES = 16_384;
export type WorkListFields = Record<string, string | number | boolean | null>;
export type WorkListPolicy = (row: unknown) => boolean | Promise<boolean>;
export interface WorkListSource { source: string; id: string; machine?: string; at?: number }
export interface WorkListView { list: string; fields: WorkListFields; items: { task: string; fields: WorkListFields }[]; closed: boolean }
interface WorkRow { schema: typeof SCHEMA; project: string; machine: string; at: number; nonce: string; list: string; fields: WorkListFields; source?: WorkListSource; id: string }
interface IndexedRow { row: WorkRow; position: number }
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
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
/** Source row ids retain their numeric sequence, including ids such as work-9 and work-10. */
function sourceOrder(a: string, b: string): number {
  const left = a.match(/\d+|\D+/g) ?? [], right = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!, y = right[i]!;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const n = BigInt(x), m = BigInt(y); if (n !== m) return n < m ? -1 : 1;
    } else { const order = lexical(x, y); if (order) return order; }
  }
  return left.length - right.length || lexical(a, b);
}
/**
 * Equal epochs have no causal order across origins: imports sort before authored rows, then by source device and
 * source identity (lexically). Within one import origin, source ids use numeric order. Authored same-machine ties
 * retain physical append position. Position is derived, never added to or changed inside the screened/hash row.
 */
function replayOrder(a: IndexedRow, b: IndexedRow): number {
  const x = a.row, y = b.row;
  if (x.at !== y.at) return x.at - y.at;
  const groupX = x.source ? ["import", x.source.machine ?? "", x.source.source] : ["native", x.machine, ""];
  const groupY = y.source ? ["import", y.source.machine ?? "", y.source.source] : ["native", y.machine, ""];
  for (let i = 0; i < groupX.length; i++) { const order = lexical(groupX[i]!, groupY[i]!); if (order) return order; }
  if (x.source && y.source) { const order = sourceOrder(x.source.id, y.source.id); if (order) return order; }
  return lexical(x.machine, y.machine) || a.position - b.position || lexical(x.id, y.id);
}

/** Stream log bytes with bounded carry; neither a long history nor an invalid oversized row is loaded at once. */
function scan(path: string, consume?: (text: string, end: number) => void, prefixBytes = 0): { bytes: number; hash: string; prefix: string } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("work log is not a regular file");
  const fd = openSync(path, "r"), buffer = Buffer.alloc(64 * 1024), full = createHash("sha256"), prefix = createHash("sha256"), decoder = new StringDecoder("utf8");
  let bytes = 0, text = "", lineEnd = 0;
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break;
      const chunk = buffer.subarray(0, n); full.update(chunk);
      if (bytes < prefixBytes) prefix.update(chunk.subarray(0, Math.min(n, prefixBytes - bytes)));
      bytes += n;
      if (consume) {
        text += decoder.write(chunk);
        let end: number;
        while ((end = text.indexOf("\n")) >= 0) {
          const line = text.slice(0, end); lineEnd += Buffer.byteLength(line + "\n"); text = text.slice(end + 1);
          if (!line || Buffer.byteLength(line) > ROW_BYTES) throw new Error("work log contains an invalid row");
          consume(line, lineEnd);
        }
        if (Buffer.byteLength(text) > ROW_BYTES) throw new Error("work log contains an oversized row");
      }
    }
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
  private closed = false;

  constructor(options: { base: string; project: string; policy: WorkListPolicy; now?: () => number }) {
    if (!bounded(options.project, 1000) || typeof options.policy !== "function") throw new Error("invalid work-list input");
    const base = canonicalPath(options.base);
    this.project = resolveAlias(base, options.project);
    regular(join(base, "projects"), true); regular(shardDir(base, this.project), true);
    ensureShardDescriptor(base, this.project);
    this.dir = join(shardDir(base, this.project), "work");
    regular(this.dir, true); regular(join(this.dir, "log"), true);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 }); chmodSync(this.dir, 0o700);
    mkdirSync(join(this.dir, "log"), { recursive: true, mode: 0o700 });
    if (lstatSync(this.dir).isSymbolicLink() || lstatSync(join(this.dir, "log")).isSymbolicLink()) throw new Error("work log directory is invalid");
    this.machine = machineId(base).id;
    this.policy = options.policy; this.now = options.now ?? Date.now;
    for (const name of ["mutation-lock.db", "index.db", "index.db-wal", "index.db-shm"]) regular(join(this.dir, name));
    this.mutation = mutationDatabase(this.dir);
    this.db = new Database(join(this.dir, "index.db"), { create: true }); chmodSync(join(this.dir, "index.db"), 0o600);
    this.db.run("PRAGMA busy_timeout = 3000"); this.db.run("PRAGMA journal_mode = WAL");
    // The index is disposable. An older derived schema is replayed without changing a log row.
    const columns = this.db.query("PRAGMA table_info(work_ops)").all() as { name: string }[];
    if (columns.length && !columns.some(column => column.name === "position")) { this.db.run("DROP TABLE work_ops"); this.db.run("DROP TABLE IF EXISTS work_heads"); }
    this.db.run("CREATE TABLE IF NOT EXISTS work_ops (id TEXT PRIMARY KEY, at INTEGER NOT NULL, machine TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT, position INTEGER NOT NULL)");
    this.db.run("CREATE INDEX IF NOT EXISTS work_receipts ON work_ops(receipt)");
    this.db.run("CREATE TABLE IF NOT EXISTS work_heads (file TEXT PRIMARY KEY, bytes INTEGER NOT NULL, hash TEXT NOT NULL)");
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); this.mutation.close(); } }
  private locked<T>(run: () => T): T {
    if (this.closed) throw new Error("work-list store is closed");
    return this.mutation.transaction(run).immediate();
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
    const key = receipt(row);
    if (key) for (const prior of this.db.query("SELECT payload FROM work_ops WHERE receipt = ?").all(key) as { payload: string }[]) {
      if (importPayload(this.decode(prior.payload)) !== importPayload(row)) throw new Error("work log contains conflicting source receipts");
    }
    this.db.query("INSERT OR IGNORE INTO work_ops (id, at, machine, payload, receipt, position) VALUES (?, ?, ?, ?, ?, ?)").run(row.id, row.at, row.machine, canonicalJSON(row), key, position);
  }
  private refresh(force = false): void {
    const files = readdirSync(join(this.dir, "log")).sort();
    if (files.some(file => !/^[a-f0-9]{16}\.jsonl$/.test(file))) throw new Error("work log has an invalid segment name");
    const heads = new Map((this.db.query("SELECT file, bytes, hash FROM work_heads").all() as Head[]).map(head => [head.file, head]));
    const scans = new Map(files.map(file => [file, scan(join(this.dir, "log", file), undefined, heads.get(file)?.bytes ?? 0)]));
    const reset = force || [...heads].some(([file, head]) => !scans.has(file) || scans.get(file)!.bytes < head.bytes || scans.get(file)!.prefix !== head.hash);
    this.db.transaction(() => {
      if (reset) { this.db.run("DELETE FROM work_ops"); this.db.run("DELETE FROM work_heads"); }
      for (const file of files) {
        const old = reset ? 0 : heads.get(file)?.bytes ?? 0, current = scans.get(file)!;
        if (old !== current.bytes) scan(join(this.dir, "log", file), (line, end) => { if (end > old) this.index(this.decode(line), end); });
        this.db.query("INSERT OR REPLACE INTO work_heads (file, bytes, hash) VALUES (?, ?, ?)").run(file, current.bytes, current.hash);
      }
    }).immediate();
  }
  rebuild(): void { this.locked(() => this.refresh(true)); }
  private async permitted(row: WorkRow): Promise<boolean> {
    if (looksSecret(canonicalJSON(row))) return false;
    const copy = structuredClone(row); Object.freeze(copy.fields); if (copy.source) Object.freeze(copy.source); Object.freeze(copy);
    try { return await this.policy(copy) === true; } catch { return false; }
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
    if (list !== undefined && !bounded(list, 300) || typeof includeClosed !== "boolean") return invalid();
    const rows = this.locked(() => { this.refresh(); return (this.db.query("SELECT payload, position FROM work_ops").all() as { payload: string; position: number }[]).map(row => ({ row: this.decode(row.payload), position: row.position })).sort(replayOrder); });
    const views = new Map<string, { fields: WorkListFields; items: Map<string, WorkListFields> }>();
    for (const { row } of rows) {
      if (!await this.permitted(row)) continue;
      if (list !== undefined && row.list !== list) continue;
      let view = views.get(row.list); if (!view) { view = { fields: {}, items: new Map() }; views.set(row.list, view); }
      const task = row.fields.task;
      const target = typeof task === "string" ? view.items.get(task) ?? {} : view.fields;
      if (typeof task === "string") view.items.set(task, target);
      for (const [key, value] of Object.entries(row.fields)) if (key !== "task") { if (value === null) delete target[key]; else target[key] = value; }
    }
    return [...views].sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, view]) => {
      const closed = view.fields.status === "done";
      return closed && !includeClosed ? [] : [{ list: name, fields: view.fields, items: [...view.items].sort(([a], [b]) => a.localeCompare(b)).map(([task, fields]) => ({ task, fields })), closed }];
    });
  }
}
