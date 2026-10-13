import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { isDenied } from "../local/deny.ts";
import { hubHome } from "../hub/project.ts";

/**
 * #258: the hub's own memory. Append-only JSONL logs are the truth: `log/<machine>.jsonl` holds long-term entries and
 * is what machines sync (each machine writes only its own segment), `local/<machine>.jsonl` holds short-term entries
 * and never leaves the machine. `index.db` is derived from the logs: rows are content-addressed and inserted with
 * INSERT OR IGNORE, and every state (superseded, forgotten, promoted, demoted, expired) is computed from the rows, so
 * applying the segments in any order gives the same index and `rebuild()` equals the incremental index.
 */
export const MEMORY_SCHEMA = "agent-hub.memory/v1";
export const MEMORY_DB_BUSY_TIMEOUT_MS = 3000;
export const KINDS = ["decision", "finding", "contract", "fail"] as const;
export type Kind = (typeof KINDS)[number];
/** Kinds that move to long-term when their task is approved; findings stay short-term unless a person promotes them. */
export const PROMOTED_KINDS: readonly Kind[] = ["decision", "contract", "fail"];
export type Tier = "short" | "long";
export type Scope = "project" | "shared";
export const DEFAULT_TTL_MS = 14 * 24 * 3600_000;
/** A note on a task that is never approved (abandoned, or lost to `ahub reset --all`) leaves after this, the same for every reader. */
export const UNSETTLED_MS = 180 * 24 * 3600_000;
/** Bumped when the index's tables change: an index with another version is dropped and rebuilt from the logs. */
const INDEX_VERSION = 1;
const MAX_TEXT = 4000, MAX_TITLE = 200, MAX_TARGETS = 64;

/** A graph node another entry can be about: `path:src/a.ts`, `symbol:parse@src/a.ts`, `issue:owner/repo#12`, `task:<project>#3`. */
export type Node = string;
export interface NoteEntry {
  schema: typeof MEMORY_SCHEMA; op: "note"; id: string; at: string; machine: string;
  project: string; scope: Scope; tier: Tier; kind: Kind; peer: string; title?: string; text: string;
  /** The board task it was saved against: `<project>#<id>@<created ms>`, unique across `ahub reset --all`. */
  task?: string;
  about: Node[];
  supersedes?: string; promotedFrom?: string;
  source: "hub" | "person" | "claude-mem";
  /** A short-term note with no task: when it leaves the index, fixed when it was written so every reader agrees. */
  expires?: string;
}
export interface OpEntry {
  schema: typeof MEMORY_SCHEMA; op: "forget" | "supersede" | "demote" | "settle"; id: string; at: string; machine: string;
  /** An entry id, or for `settle` a task key. */
  target: string;
  /** `supersede`: the newer entry; `settle`, `demote`: when the short-term entries leave the index (ISO), fixed when written. */
  by?: string;
  actor: string;
}
export type Entry = NoteEntry | OpEntry;
export type NoteInput = Omit<NoteEntry, "schema" | "id" | "at" | "machine">;
export type OpInput = Omit<OpEntry, "schema" | "id" | "at" | "machine">;

/** Key order fixed, so the same content always hashes to the same id. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const entryId = (e: Omit<Entry, "id">): string => createHash("sha256").update(canonical(e)).digest("hex").slice(0, 32);

const SECRETS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{40,}/, /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i];
/** A secret-looking string: refused before anything is written, since long-term entries leave the machine. */
export const looksSecret = (text: string): boolean => SECRETS.some((re) => re.test(text));

/** `task`: the board task's id and proposal time; its node carries both, so a task id reused after `ahub reset --all` is another node. */
export interface Extract { cwd: string; project: string; repo: string; deny?: string[]; paths?: string[]; symbols?: string[]; task?: { id: number; created: number } }
/**
 * Deterministic edges, fixed at write time so a rebuild never depends on the file system: the task's refs and plan
 * paths, plan symbols (with the path when the plan names exactly one), paths in the text that exist in the project then,
 * `#N` as an issue of `repo`, and `task #N` as a board task. Paths stay relative to the project root; denylisted ones
 * are left out.
 */
export function extractNodes(text: string, x: Extract): Node[] {
  const out = new Set<Node>();
  const path = (p: string): string | undefined => {
    const n = normalize(p.trim()).replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!n || n === "." || isAbsolute(n) || n.startsWith("..") || isDenied(n, x.deny)) return undefined;
    out.add(`path:${n}`);
    return n;
  };
  const declared = [...new Set((x.paths ?? []).flatMap((p) => path(p) ?? []))];
  const only = declared.length === 1 ? declared[0] : undefined;
  for (const s of x.symbols ?? []) { const name = s.trim().slice(0, 120); if (name) out.add(`symbol:${name}${only && !name.includes("@") ? `@${only}` : ""}`); }
  for (const m of text.matchAll(/(?:^|[\s(`'"])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s)`'",:;])/g)) {
    const p = m[1]!;
    if (!p.includes("/") && !/\.(ts|js|tsx|jsx|py|rs|go|md|json|toml|yaml|yml|sh|html|css)$/.test(p)) continue;
    try { if (!isAbsolute(p) && !p.startsWith("..") && existsSync(join(x.cwd, p))) path(p); } catch { /* unreadable: not an edge */ }
  }
  for (const m of text.matchAll(/\btask #(\d{1,9})\b/gi)) out.add(`task:${x.project}#${m[1]}`);
  for (const m of text.matchAll(/(?<![\w/]|task )#(\d{1,9})\b/gi)) out.add(`issue:${x.repo}#${m[1]}`);
  if (x.task !== undefined) out.add(`task:${x.project}#${x.task.id}@${x.task.created}`);
  return [...out].sort().slice(0, MAX_TARGETS);
}

export interface Machine { id: string; label: string }
/** Random per `~/.agenthub`, with a person-given label; created on first use. */
export function machineId(dir: string): Machine {
  const file = join(dir, "machine.json");
  const read = (): Machine | undefined => {
    try {
      const m = JSON.parse(readFileSync(file, "utf8")) as Machine;
      if (/^[0-9a-f]{16}$/.test(m?.id)) return { id: m.id, label: typeof m.label === "string" ? m.label : m.id };
    } catch { /* none, or unreadable */ }
    return undefined;
  };
  const found = read();
  if (found) return found;
  // Hubs of several projects can start at once on a fresh home: each writes its own temp file and links it into place,
  // which fails if another got there first; then everyone reads the one identity that won.
  const id = randomBytes(8).toString("hex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ id, label: id }) + "\n", { mode: 0o600 });
  try { linkSync(tmp, file); } catch { /* another process created it: its identity wins */ } finally { rmSync(tmp, { force: true }); }
  // A file that is there but holds no valid id is never overwritten (another process may be reading it): the store
  // fails to open, so the hub says hub memory is unavailable instead of filing notes under no machine.
  const won = read();
  if (!won) throw new Error(`${file} holds no valid machine id; remove it and a new one is made`);
  return won;
}

export interface View {
  id: string; at: string; machine: string; project: string; scope: Scope; tier: Tier; kind: Kind; peer: string; title: string | null; text: string;
  task: string | null; about: Node[]; source: string; supersededBy: string | null; supersedes: string[]; promotedFrom: string | null; expiresAt: string | null;
  /** Written as short-term, so it lives in this machine's local segment and never syncs. */
  local: boolean;
}
export interface Filter { project?: string; tier?: Tier; kind?: Kind; peer?: string; machine?: string; since?: string; q?: string; limit?: number; includeSuperseded?: boolean }
export interface Graph { nodes: { id: Node; type: string; label: string; kind?: string; tier?: Tier }[]; edges: { from: Node; to: Node; rel: string }[] }

/**
 * Whether a short-term note may move to the synced long-term log, under the reading project's current policy: `skip` for
 * a note this process cannot judge (another project's), `keep` for one that must stay on this machine.
 */
export type PromotionScreen = (v: View) => "promote" | "keep" | "skip";
/**
 * `screen`: applied to every promotion. Without one, automatic promotions (a settlement, a held note whose replacement
 * went) wait for a process that has one; a person's explicit promote goes through.
 */
export interface StoreOptions { home?: string; ttlMs?: number; now?: () => number; log?: (line: string) => void; screen?: PromotionScreen }

export class MemoryStore {
  readonly dir: string;
  readonly machine: Machine;
  private readonly db: Database;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(opts: StoreOptions = {}) {
    this.dir = join(opts.home ?? hubHome(), "memory");
    mkdirSync(join(this.dir, "log"), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.dir, "local"), { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700); // mkdir's mode applies only when it creates the directory
    this.machine = machineId(this.dir);
    this.ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.screen = opts.screen;
    const db = new Database(join(this.dir, "index.db"), { create: true });
    db.run(`PRAGMA busy_timeout = ${MEMORY_DB_BUSY_TIMEOUT_MS}`);
    db.run("PRAGMA journal_mode = WAL");
    if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version !== INDEX_VERSION) {
      for (const t of ["segments", "entries", "ops", "edges"]) db.run(`DROP TABLE IF EXISTS ${t}`);
      db.run(`PRAGMA user_version = ${INDEX_VERSION}`);
    }
    db.run("CREATE TABLE IF NOT EXISTS segments (file TEXT PRIMARY KEY, offset INTEGER NOT NULL)");
    // The hash of each segment's whole indexed prefix: a segment rewritten in place (same size or larger) is caught.
    db.run("CREATE TABLE IF NOT EXISTS heads (file TEXT PRIMARY KEY, hash TEXT NOT NULL)");
    db.run(`CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, at TEXT NOT NULL, machine TEXT NOT NULL, project TEXT NOT NULL, scope TEXT NOT NULL, tier TEXT NOT NULL,
      kind TEXT NOT NULL, peer TEXT NOT NULL, title TEXT, text TEXT NOT NULL, task TEXT, about TEXT NOT NULL, supersedes TEXT, promoted_from TEXT, source TEXT NOT NULL, expires TEXT)`);
    db.run("CREATE TABLE IF NOT EXISTS ops (id TEXT PRIMARY KEY, op TEXT NOT NULL, at TEXT NOT NULL, machine TEXT NOT NULL, target TEXT NOT NULL, by TEXT, actor TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS edges (src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst))");
    db.run("CREATE INDEX IF NOT EXISTS edges_dst ON edges (dst)");
    this.db = db;
    try { chmodSync(join(this.dir, "index.db"), 0o600); } catch { /* best effort */ }
    this.refresh();
  }

  close(): void { this.db.close(); }

  /** When a short-term entry written now leaves the index. */
  private until(): string { return new Date(this.now() + this.ttl).toISOString(); }

  /** Append one entry to this machine's long-term (synced) or local segment and index it. Returns its id. */
  private append(entry: NoteInput | OpInput, local: boolean, at = new Date(this.now()).toISOString(), machine = this.machine.id): string {
    const capped = entry.op === "note" ? { ...entry, text: entry.text.slice(0, MAX_TEXT), ...(entry.title ? { title: entry.title.slice(0, MAX_TITLE) } : {}) } : entry;
    const body = { schema: MEMORY_SCHEMA, at, machine, ...capped } as Omit<Entry, "id">;
    const id = entryId(body);
    appendFileSync(join(this.dir, local ? "local" : "log", `${this.machine.id}.jsonl`), JSON.stringify({ ...body, id }) + "\n", { mode: 0o600 });
    // The line is written, so the entry is saved: an index that cannot be updated now (a busy database) catches up on the
    // next read, and the caller is never told it failed.
    try { this.refresh(); } catch (e) { this.stale = true; this.log(`hub memory index not updated yet: ${(e as Error).message}`); }
    return id;
  }

  /** A note: short-term ones stay on this machine, long-term ones go to the synced log. The caller has screened it. */
  // A short-term note on a task that was settled already gets its own deadline: the task's has passed or is close.
  // `ownClock`: a note asked for short-term on purpose expires on its own clock, open task or not, and is never promoted.
  note(n: NoteInput, ownClock = false): string { return this.append(n.tier === "short" && !n.expires && (ownClock || !n.task || this.settled(n.task)) ? { ...n, expires: this.until() } : n, n.tier === "short"); }

  /** A person's or the hub's op on an entry; it goes where the entry lives, so forgetting a long-term entry syncs. */
  private op(op: OpEntry["op"], target: View, actor: string, by?: string): string {
    return this.append({ op, target: target.id, actor, ...(by ? { by } : {}) }, target.local);
  }
  forget(id: string, actor: string, project?: string): View | undefined { const v = this.get(id, project); if (v) this.op("forget", v, actor); return v; }
  /** A short-term note kept short-term: it expires like any other and is never promoted (its demote entry stays local). */
  keepShort(id: string, actor: string): void { const v = this.get(id); if (v?.tier === "short" && v.local && v.expiresAt === null) this.op("demote", v, actor, this.until()); } // once: a deadline is never pushed out
  demote(id: string, actor: string, project?: string): View | undefined { const v = this.get(id, project); if (v?.tier === "long") this.op("demote", v, actor, this.until()); return v; }
  supersede(oldId: string, newId: string, actor: string, project?: string): boolean {
    const a = this.get(oldId, project), b = this.get(newId, project);
    if (!a || !b || a.id === b.id) return false;
    // A replacement must reach everyone the old entry reached: never a project entry for a shared one, nor a
    // local (unsynced) entry for a synced one, a demoted long-term entry included.
    if ((a.scope === "shared" && b.scope !== "shared") || (!a.local && b.local)) return false;
    // Never a cycle: if the new entry is already (through others) replaced by the old one, both would vanish from reads.
    const replaced = new Map(this.views().filter((v) => v.supersededBy).map((v) => [v.id, v.supersededBy!]));
    for (let at: string | undefined = b.id, hops = 0; at && hops <= replaced.size; at = replaced.get(at), hops++) if (at === a.id) return false;
    this.op("supersede", a, actor, b.id);
    return true;
  }
  /**
   * A short-term entry's long-term copy; the short one is then hidden. Returns the copy's id, or nothing for a replaced
   * entry: its replacement may live only on this machine, so the copy could reach other machines without it (promote the
   * replacement instead).
   */
  promote(id: string, actor: string, project?: string, auto = false): string | undefined {
    const v = this.get(id, project);
    if (!v || v.tier !== "short") return v?.id;
    if (v.supersededBy) return undefined;
    // Screened here, whatever asked: a note saved under an older policy must not reach the synced log under a newer one.
    const verdict = this.screen ? this.screen(v) : auto ? "skip" : "promote";
    if (verdict === "skip") return undefined;
    if (verdict === "keep") { this.keepShort(v.id, actor); return undefined; }
    // ponytail: the check and the append are not one step across processes: a person forgetting or replacing this entry
    // at the very moment another process promotes it can leave the copy current on other machines. A per-machine lock
    // around local mutations (like sync's) would close it.
    return this.append({ op: "note", project: v.project, scope: v.scope, tier: "long", kind: v.kind, peer: v.peer, ...(v.title ? { title: v.title } : {}), text: v.text,
      ...(v.task ? { task: v.task } : {}), about: v.about, promotedFrom: v.id, source: v.source as NoteEntry["source"] }, false,
      // Dated as its source, from its source's machine and with its fields, whoever promotes and wherever: two processes or
      // two machines promoting the same entry write one id, which the index keeps once.
      v.at, v.machine);
  }
  /**
   * The task was approved: its short-term entries start to expire, and its decision, contract and fail notes move to
   * long-term. Returns how many moved.
   */
  settle(task: string, actor: string): number {
    this.promoting = true; // promoted here, in the settling actor's name, not after each read
    try {
      this.append({ op: "settle", target: task, actor, by: this.until() }, true);
      return this.promoteSettled(task, actor);
    } finally { this.promoting = false; }
  }
  private promoteSettled(task: string, actor: string): number {
    // Only the notes held for promotion (no deadline): one saved short-term after the settlement stays short-term.
    const moving = this.views().filter((v) => v.task === task && v.tier === "short" && v.local && !v.supersededBy && v.expiresAt === null && PROMOTED_KINDS.includes(v.kind));
    return moving.filter((v) => this.promote(v.id, actor, undefined, true) !== undefined).length;
  }
  /** Whether a task was ever settled, for the hub's reconciliation of approvals a crash cut off before their settle entry. */
  settled(task: string): boolean { return !!this.db.query("SELECT 1 FROM ops WHERE op = 'settle' AND target = ?").get(task); }
  /** Whether any entry was saved against the task. */
  hasTask(task: string): boolean { return !!this.db.query("SELECT 1 FROM entries WHERE task = ?").get(task); }
  private promoting = false;
  private readonly screen?: PromotionScreen;
  /**
   * After every read: a settled task's held decision, contract or fail moves to long-term once nothing replaces it (a
   * settlement a crash cut short, or a replacement that was forgotten or expired).
   */
  private promoteHeld(): void {
    if (this.promoting) return;
    this.promoting = true;
    try {
      const settled = new Set((this.db.query("SELECT target FROM ops WHERE op = 'settle'").all() as { target: string }[]).map((r) => r.target));
      if (!settled.size) return;
      for (const v of this.views()) {
        if (v.task && settled.has(v.task) && v.tier === "short" && v.local && !v.supersededBy && v.expiresAt === null && PROMOTED_KINDS.includes(v.kind)) {
          try { this.promote(v.id, "hub", undefined, true); } catch { /* fail-open: tried again at the next read */ }
        }
      }
    } finally { this.promoting = false; }
  }

  /** Index what the segments gained since the last read. A line still being written (no newline yet) waits for the next read. */
  refresh(attempt = 0): void {
    const files = [...this.segments("log"), ...this.segments("local")];
    const seen = this.shape(files); // taken before reading: a line written meanwhile changes it again
    // One statement, one snapshot: an offset and a head from two different commits would look like a rewrite.
    const read = this.db.query("SELECT s.file, s.offset, h.hash FROM segments s LEFT JOIN heads h ON h.file = s.file").all() as { file: string; offset: number; hash: string | null }[];
    const offsets = new Map(read.map((r) => [r.file, r.offset]));
    const heads = new Map(read.filter((r) => r.hash !== null).map((r) => [r.file, r.hash!]));
    // ponytail: hashes the whole indexed prefix on every read (O(segment size) per write); keep a per-block hash chain if
    // segments grow large enough for that to show.
    const head = (b: Buffer, upTo: number) => createHash("sha256").update(b.subarray(0, upTo)).digest("hex");
    // A segment that shrank or went away (a sync reset) leaves rows no incremental read can remove: rebuild instead.
    let shrunk = [...offsets.keys()].some((rel) => !files.includes(rel)), raced = false;
    for (const rel of shrunk ? [] : files) {
      const abs = join(this.dir, rel);
      let start = offsets.get(rel) ?? 0, text = "", fingerprint: string | undefined;
      try {
        const fd = openSync(abs, "r");
        try {
          // One read of the whole segment: the prefix check, the new lines and the new head all come from the same bytes,
          // so a rewrite between two reads can never index old lines under a new head.
          const all = Buffer.alloc(fstatSync(fd).size);
          const size = readSync(fd, all, 0, all.length, 0);
          // Replaced by a shorter one, or rewritten in place (a sync reset, a history rewrite): rebuilt below, from every segment.
          if (size < start || (start > 0 && heads.has(rel) && head(all, start) !== heads.get(rel))) { shrunk = true; break; }
          text = all.subarray(start, size).toString("utf8");
          const done = start + Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1));
          if (done > 0) fingerprint = head(all, done);
        } finally { closeSync(fd); }
      } catch (e) { this.stale = true; this.log(`memory segment ${rel} unreadable: ${(e as Error).message}`); continue; } // tried again on the next read
      const end = text.lastIndexOf("\n");
      if (end < 0) continue;
      const lines = text.slice(0, end).split("\n");
      this.db.transaction(() => {
        // Another process moved this segment's offset or head since it was read (it indexed the same lines, or a rebuild
        // emptied the index or read a rewritten segment): committing ours would skip lines the index no longer has, or
        // index lines the segment no longer has. Read again from what that process committed.
        const now = this.db.query("SELECT s.offset, h.hash FROM segments s LEFT JOIN heads h ON h.file = s.file WHERE s.file = ?").get(rel) as { offset: number; hash: string | null } | null;
        if (now?.offset !== offsets.get(rel) || (now?.hash ?? undefined) !== heads.get(rel)) { raced = true; return; }
        for (const line of lines) this.apply(line, rel);
        const offset = start + Buffer.byteLength(text.slice(0, end + 1));
        this.db.query("INSERT INTO segments (file, offset) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset").run(rel, offset);
        if (fingerprint !== undefined) this.db.query("INSERT INTO heads (file, hash) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET hash = excluded.hash").run(rel, fingerprint);
      }).immediate(); // a writer from the start: a read lock upgraded under another writer fails at once, past busy_timeout
    }
    if (shrunk) return this.rebuild();
    // ponytail: a few retries; a store with more writers racing on one segment would need a lock around the read.
    if (raced && attempt < 5) return this.refresh(attempt + 1);
    this.seen = seen;
    this.prune();
    this.promoteHeld();
  }
  /**
   * Each segment's size, times and inode: what a read compares to know whether anything was written since (ctime and
   * inode change on any rewrite, even one that keeps size and mtime).
   */
  private shape(files = [...this.segments("log"), ...this.segments("local")]): string {
    return files.map((rel) => { try { const st = statSync(join(this.dir, rel)); return `${rel}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`; } catch { return rel; } }).join("\n");
  }
  private seen = "";

  /** Drop the index and read every segment again: the same rows as the incremental index. */
  rebuild(): void {
    // One transaction: no reader sees the index empty, and no other process commits an offset in between.
    this.db.transaction(() => { for (const t of ["segments", "heads", "entries", "ops", "edges"]) this.db.run(`DELETE FROM ${t}`); this.refresh(); }).immediate();
  }

  private segments(sub: "log" | "local"): string[] {
    try { return readdirSync(join(this.dir, sub)).filter((n) => n.endsWith(".jsonl")).sort().map((n) => `${sub}/${n}`); } catch { return []; }
  }

  /** One log line. A malformed line, or one whose id does not match its content, is skipped. */
  private apply(line: string, segment: string): void {
    if (!line.trim()) return;
    let e: Entry;
    try { e = JSON.parse(line); } catch { this.log(`memory segment ${segment}: an unreadable line was skipped`); return; }
    if (e?.schema !== MEMORY_SCHEMA || typeof e.id !== "string") return;
    // Every column the index requires, checked before the insert: a malformed synced line is skipped, never fatal.
    const str = (v: unknown, max = 4096) => typeof v === "string" && v.length > 0 && v.length <= max;
    const opt = (v: unknown) => v === undefined || v === null || typeof v === "string";
    // `at` is compared as text (order, ranges, ties): only the UTC form the store writes is accepted.
    const utc = (v: string) => { const t = Date.parse(v); return !Number.isNaN(t) && new Date(t).toISOString() === v; };
    if (!str(e.at, 64) || !utc(e.at) || !str(e.machine, 64)) { this.log(`memory segment ${segment}: a malformed entry was skipped`); return; }
    const { id, ...rest } = e;
    if (entryId(rest) !== id) { this.log(`memory segment ${segment}: an entry whose id does not match its content was skipped`); return; }
    if (e.op === "note") {
      if (!KINDS.includes(e.kind) || typeof e.text !== "string" || !Array.isArray(e.about) || !str(e.project, 400) || !str(e.peer, 64)
        || !opt(e.title) || !opt(e.task) || !opt(e.supersedes) || !opt(e.promotedFrom) || !opt(e.expires) || (typeof e.expires === "string" && Number.isNaN(Date.parse(e.expires))) || !opt(e.source) || !["project", "shared"].includes(e.scope as string) || !["short", "long"].includes(e.tier as string)) { this.log(`memory segment ${segment}: a malformed entry was skipped`); return; }
      this.db.query(`INSERT OR IGNORE INTO entries (id, at, machine, project, scope, tier, kind, peer, title, text, task, about, supersedes, promoted_from, source, expires)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, e.at, e.machine, e.project, e.scope === "shared" ? "shared" : "project", e.tier === "long" ? "long" : "short",
        e.kind, e.peer, e.title ?? null, e.text, e.task ?? null, JSON.stringify(e.about.map(String)), e.supersedes ?? null, e.promotedFrom ?? null, e.source ?? "hub", typeof e.expires === "string" ? e.expires : null);
      for (const node of e.about) this.db.query("INSERT OR IGNORE INTO edges (src, dst) VALUES (?, ?)").run(id, String(node));
    } else if (["forget", "supersede", "demote", "settle"].includes(e.op)) {
      // A deadline is a date: a reader's own TTL must never stand in for an unreadable one.
      const dated = e.op !== "demote" && e.op !== "settle" || (typeof e.by === "string" && !Number.isNaN(Date.parse(e.by)));
      if (!str(e.target, 400) || !opt(e.by) || !opt(e.actor) || !dated) { this.log(`memory segment ${segment}: a malformed entry was skipped`); return; }
      this.db.query("INSERT OR IGNORE INTO ops (id, op, at, machine, target, by, actor) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, e.op, e.at, e.machine, e.target, e.by ?? null, e.actor ?? "");
    }
  }

  /**
   * Every live note with its derived state; an expired one is left out as soon as its deadline passes, before any
   * prune. ponytail: computed in memory over all rows; push the filters into SQL when the store grows.
   */
  private views(expired = false): View[] {
    const now = this.now();
    const rows = this.db.query("SELECT * FROM entries").all() as Record<string, string | null>[];
    const ops = this.db.query("SELECT op, at, target, by FROM ops ORDER BY at, id").all() as { op: string; at: string; target: string; by: string | null }[];
    const forgotten = new Set(ops.filter((o) => o.op === "forget").map((o) => o.target));
    // Deadlines were fixed when the entries were written, so every process (whatever its own TTL) prunes the same rows.
    const deadline = (o: { at: string; by: string | null }) => o.by && !Number.isNaN(Date.parse(o.by)) ? o.by : new Date(Date.parse(o.at) + this.ttl).toISOString();
    const demoted = new Map(ops.filter((o) => o.op === "demote").map((o) => [o.target, deadline(o)]));
    const settled = new Map<string, string>();
    for (const o of ops) if (o.op === "settle" && !settled.has(o.target)) settled.set(o.target, deadline(o));
    const superseded = new Map<string, string>(), supersededAt = new Map<string, string>();
    // Relations from ops and from notes' own `supersedes` fold together by write time (then id): the latest intent wins.
    const relate = (old: string, newer: string, when: string) => { if (!(when < (supersededAt.get(old) ?? ""))) { superseded.set(old, newer); supersededAt.set(old, when); } };
    for (const o of ops) if (o.op === "supersede" && o.by) relate(o.target, o.by, `${o.at} ${o.by}`);
    const promoted = new Set<string>();
    for (const r of rows) { if (r.supersedes) relate(r.supersedes, r.id!, `${r.at} ${r.id}`); if (r.promoted_from) promoted.add(r.promoted_from); }
    const expiry = (r: Record<string, string | null>): string | null => {
      const id = r.id!;
      if ((demoted.has(id) ? "short" : r.tier) !== "short") return null;
      // A decision, contract or fail of a settled task not yet copied to long-term waits for its promotion, never expires
      // first; a note saved short-term after the settlement carries its own deadline and stays short-term.
      // A superseded one is held too: if its replacement goes, it shows again, and a rebuild must find it the same way.
      if (r.tier === "short" && !demoted.has(id) && !r.expires && r.task && settled.has(r.task) && PROMOTED_KINDS.includes(r.kind as Kind)) return null;
      // A deadline written into the note (no task, a late note, an explicit short horizon) is its own, whatever the task does.
      return demoted.get(id) ?? r.expires ?? (r.task ? settled.get(r.task) ?? new Date(Date.parse(r.at!) + UNSETTLED_MS).toISOString() : new Date(Date.parse(r.at!) + this.ttl).toISOString());
    };
    // A newer entry that was forgotten, expired or pruned no longer replaces anything: the older one shows again. A
    // promoted source lives on as its copy.
    const byId = new Map(rows.map((r) => [r.id!, r]));
    const copyOf = new Map(rows.filter((r) => r.promoted_from).map((r) => [r.promoted_from!, r.id!]));
    const gone = (id: string): boolean => {
      const r = byId.get(id);
      if (!r || forgotten.has(id) || (r.promoted_from && forgotten.has(r.promoted_from))) return true;
      const copy = copyOf.get(id);
      if (copy) return gone(copy);
      const e = expiry(r);
      return e !== null && Date.parse(e) <= now;
    };
    // A promoted entry lives on as its copy, on either side of a relation: a promoted replacement still replaces, and a
    // promoted entry that was replaced stays replaced.
    const last = (id: string) => { let to = id; for (let c = copyOf.get(to); c; c = copyOf.get(to)) to = c; return to; };
    for (const [old, newer] of [...superseded]) {
      superseded.set(old, last(newer));
      const copy = last(old);
      if (copy !== old && !superseded.has(copy)) { superseded.set(copy, last(newer)); supersededAt.set(copy, supersededAt.get(old)!); }
    }
    for (const [old, newer] of superseded) if (gone(newer)) superseded.delete(old);
    // Supersessions made apart (two processes, two machines) can close a cycle that would hide every entry in it: the
    // earliest relation in the cycle gives way, so the latest intent stands, the same in every process. Each entry has
    // one replacement, so a chain holds at most one cycle.
    const when = (id: string) => `${supersededAt.get(id) ?? ""} ${id}`; // write time, then ids: the same in every process
    for (const start of [...superseded.keys()]) {
      const seen: string[] = [];
      for (let at: string | undefined = start; at !== undefined && superseded.has(at); at = superseded.get(at)) {
        const i = seen.indexOf(at);
        if (i >= 0) { superseded.delete(seen.slice(i).reduce((x, y) => (when(y) < when(x) ? y : x))); break; }
        seen.push(at);
      }
    }
    const supersedes = new Map<string, string[]>(); // the reverse: what each newer entry replaced
    for (const [old, newer] of superseded) supersedes.set(newer, [...(supersedes.get(newer) ?? []), old]);
    const out: View[] = [];
    for (const r of rows) {
      const id = r.id!;
      // A forgotten entry is gone, and so is its promoted copy's source or copy: forgetting either forgets both.
      if (forgotten.has(id) || (r.promoted_from && forgotten.has(r.promoted_from)) || promoted.has(id)) continue;
      const tier: Tier = demoted.has(id) ? "short" : r.tier as Tier;
      const expiresAt = expiry(r);
      if (!expired && expiresAt !== null && Date.parse(expiresAt) <= now) continue;
      out.push({ id, at: r.at!, machine: r.machine!, project: r.project!, scope: r.scope as Scope, tier, kind: r.kind as Kind, peer: r.peer!, title: r.title ?? null, text: r.text!,
        task: r.task ?? null, about: JSON.parse(r.about!), source: r.source!, supersededBy: superseded.get(id) ?? null, supersedes: supersedes.get(id) ?? [], promotedFrom: r.promoted_from ?? null, expiresAt, local: r.tier === "short" });
    }
    return out;
  }

  /**
   * Short-term entries whose time is up leave the index (their log lines stay on this machine); a rebuild prunes again.
   * ponytail: pruning trusts the wall clock; a clock set back past a deadline lets a rebuild show the entry again until
   * the clock passes it once more. A durable prune entry in the log would close that gap.
   */
  prune(): number {
    const now = this.now();
    const expired = this.views(true).filter((v) => v.expiresAt !== null && Date.parse(v.expiresAt) <= now);
    // A copy that expires (it was demoted) takes its whole hidden promotion ancestry with it, or an ancestor would reappear.
    const parent = new Map((this.db.query("SELECT id, promoted_from FROM entries WHERE promoted_from IS NOT NULL").all() as { id: string; promoted_from: string }[]).map((r) => [r.id, r.promoted_from]));
    const gone = new Set<string>();
    for (const v of expired) for (let id: string | undefined = v.id; id && !gone.has(id); id = parent.get(id)) gone.add(id);
    if (!gone.size) return 0;
    this.db.transaction(() => { for (const id of gone) { this.db.query("DELETE FROM entries WHERE id = ?").run(id); this.db.query("DELETE FROM edges WHERE src = ?").run(id); } }).immediate();
    return gone.size;
  }

  /**
   * What a read sees: rows that expired and promotions that became due while the store sat idle are settled first, so a
   * read, and the index after it, never differ from a rebuild.
   */
  private live(): View[] {
    // Another process (a CLI, another project's hub, a sync) may have written since this one last read the segments.
    if (this.stale || this.shape() !== this.seen) try { this.stale = false; this.refresh(); } catch { this.stale = true; /* still busy: the next read tries again */ }
    this.prune(); this.promoteHeld(); return this.views();
  }
  /** A write whose index update failed: the next read refreshes first. */
  private stale = false;

  /** Entries visible from `project` (its own, and `shared` ones of any project), newest first, filtered. */
  list(f: Filter = {}): View[] {
    const q = f.q?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    return this.live().filter((v) => (!f.project || v.project === f.project || v.scope === "shared") && (!f.tier || v.tier === f.tier) && (!f.kind || v.kind === f.kind)
      && (!f.peer || v.peer === f.peer) && (!f.machine || v.machine === f.machine) && (!f.since || Date.parse(v.at) >= Date.parse(f.since)) && (f.includeSuperseded || !v.supersededBy)
      && q.every((w) => `${v.title ?? ""}\n${v.text}\n${v.about.join(" ")}`.toLowerCase().includes(w)))
      .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, f.limit ?? 200);
  }

  /** One entry by id or unique id prefix; with `project`, only one that project may read (its own or shared). */
  get(id: string, project?: string): View | undefined {
    id = id.replace(/^mem:/, ""); // briefs and recall print `mem:<id>`
    const all = this.live().filter((v) => !project || v.project === project || v.scope === "shared");
    const pick = <T extends { id: string }>(rows: T[]) => rows.find((v) => v.id === id) ?? (id.length >= 6 ? (() => { const m = rows.filter((v) => v.id.startsWith(id)); return m.length === 1 ? m[0] : undefined; })() : undefined);
    const found = pick(all);
    if (found) return found;
    // A short-term id an agent kept after its task was approved names the promoted copy now, here or on another machine
    // that has only the synced copy (which names its source).
    let at = pick(this.db.query("SELECT id FROM entries UNION SELECT promoted_from FROM entries WHERE promoted_from IS NOT NULL").all() as { id: string }[])?.id;
    for (let copy = at; copy; copy = (this.db.query("SELECT id FROM entries WHERE promoted_from = ?").get(copy) as { id: string } | null)?.id) at = copy;
    return at ? all.find((v) => v.id === at) : undefined;
  }

  /**
   * Entries one or two hops from the given nodes (hop one: about one of them; hop two: about a node a hop-one entry is
   * about), visible from `project`. Fails first, then nearer, then newer; superseded entries are dropped.
   */
  related(project: string, nodes: Node[], limit: number): (View & { hops: 1 | 2 })[] {
    if (!nodes.length) return [];
    const live = new Map(this.list({ project, limit: Number.MAX_SAFE_INTEGER }).map((v) => [v.id, v]));
    const near = new Map<string, 1 | 2>();
    const about = (ns: Iterable<Node>) => {
      const ids = new Set<string>();
      for (const n of ns) for (const r of this.db.query("SELECT src FROM edges WHERE dst = ?").all(n) as { src: string }[]) if (live.has(r.src)) ids.add(r.src);
      return ids;
    };
    const first = about(nodes);
    for (const id of first) near.set(id, 1);
    for (const id of about(new Set([...first].flatMap((id) => live.get(id)!.about)))) if (!near.has(id)) near.set(id, 2);
    return [...near].map(([id, hops]) => ({ ...live.get(id)!, hops }))
      .sort((a, b) => Number(b.kind === "fail") - Number(a.kind === "fail") || a.hops - b.hops || b.at.localeCompare(a.at)).slice(0, limit);
  }

  /** The neighbourhood of one node for the dashboard: up to `hops` (1 or 2) steps, at most `cap` nodes. */
  graph(project: string, start: Node, hops = 1, cap = 200): Graph {
    const live = new Map(this.list({ project, limit: Number.MAX_SAFE_INTEGER, includeSuperseded: true }).map((v) => [`mem:${v.id}`, v]));
    const nodes = new Map<Node, Graph["nodes"][number]>(), edges = new Map<string, Graph["edges"][number]>();
    const node = (id: Node) => {
      if (nodes.has(id) || nodes.size >= cap) return nodes.has(id);
      const v = live.get(id);
      nodes.set(id, v ? { id, type: "memory", label: (v.title ?? v.text).slice(0, 60), kind: v.kind, tier: v.tier } : { id, type: id.slice(0, id.indexOf(":")), label: id.slice(id.indexOf(":") + 1) });
      return true;
    };
    const link = (from: Node, to: Node, rel: string) => { if (node(from) && node(to)) edges.set(`${from}\0${to}\0${rel}`, { from, to, rel }); };
    /** A memory node's own edges: what it is about, who wrote it, where, and what it supersedes. */
    const expand = (id: Node): Node[] => {
      const v = live.get(id);
      if (v) {
        const out: Node[] = [];
        for (const n of v.about) { link(id, n, v.kind === "fail" ? "rules_out" : "about"); out.push(n); }
        link(id, `peer:${v.peer}`, "by"); link(id, `machine:${v.machine}`, "by"); link(id, `project:${v.project}`, "in");
        out.push(`peer:${v.peer}`, `machine:${v.machine}`, `project:${v.project}`); // a second hop reaches their other entries
        if (v.supersededBy && live.has(`mem:${v.supersededBy}`)) { link(`mem:${v.supersededBy}`, id, "supersedes"); out.push(`mem:${v.supersededBy}`); }
        for (const old of v.supersedes) if (live.has(`mem:${old}`)) { link(id, `mem:${old}`, "supersedes"); out.push(`mem:${old}`); }
        return out;
      }
      // Provenance nodes keep their own relation: who wrote it and on which machine (`by`), in which project (`in`).
      const field = id.startsWith("peer:") ? (x: View) => `peer:${x.peer}` : id.startsWith("machine:") ? (x: View) => `machine:${x.machine}` : id.startsWith("project:") ? (x: View) => `project:${x.project}` : undefined;
      if (field) {
        const ids = [...live.values()].filter((x) => field(x) === id).map((x) => `mem:${x.id}`);
        for (const m of ids) link(m, id, id.startsWith("project:") ? "in" : "by");
        return ids;
      }
      const ids = (this.db.query("SELECT src FROM edges WHERE dst = ?").all(id) as { src: string }[]).map((r) => `mem:${r.src}`).filter((m) => live.has(m));
      for (const m of ids) { const v2 = live.get(m)!; link(m, id, v2.kind === "fail" ? "rules_out" : "about"); }
      return ids;
    };
    node(start);
    let frontier: Node[] = [start];
    for (let h = 0; h < Math.min(2, Math.max(1, hops)); h++) frontier = [...new Set(frontier.flatMap(expand))].filter((n) => n !== start);
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  /** What the segments hold, for `ahub memory` and the dashboard header. */
  counts(project?: string): { short: number; long: number; segments: number; machine: Machine } {
    const all = this.list({ ...(project ? { project } : {}), limit: Number.MAX_SAFE_INTEGER, includeSuperseded: true });
    return { short: all.filter((v) => v.tier === "short").length, long: all.filter((v) => v.tier === "long").length, segments: this.segments("log").length + this.segments("local").length, machine: this.machine };
  }

  /** The index's rows in a fixed order: what a rebuild must reproduce. */
  dump(): string {
    return JSON.stringify(["entries", "ops", "edges"].map((t) => this.db.query(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
  }
}
