import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, fsyncDirectory, readProfileJSON, selectorRevision, writeProfileJSON, type BoundProfile } from "./generation.ts";
import { legacyEntries, legacyHead, readLegacySnapshot, type LegacyCheckpoint, type LegacySegment } from "./bridge.ts";
import { reducePruneRows, validatePruneRow, type PrunePlan, type PruneRow, type PruneSnapshot, type PruneSourceRow, type PruneStorePort } from "./prune.ts";
import type { Entry } from "./store.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (): never => { throw new Error("generation input unavailable or changed; person inspection required"); };
export const GENERATION_TABLES = ["generation_rows", "generation_prunes", "generation_targets", "generation_segments", "generation_state"] as const;
export interface GenerationIndexOptions {
  profile: BoundProfile; db: Database; now: () => number;
  apply: (line: string, source: string) => void;
  withMutation: <T>(work: () => T) => T;
  limits?: readonly LegacyCheckpoint[]; commit?: string;
}
/** Pure deadline summary shared by migration and prune: no live index or host TTL is a proof. */
export function explicitExpirySnapshot(rows: readonly PruneSourceRow[]): PruneSnapshot["expiries"] {
  const ops = rows.map(x => x.row).filter(e => e.op !== "note" && e.op !== "goal").sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const demotes = new Map<string, Entry>(), settles = new Map<string, Entry>();
  const forgotten = new Set(ops.filter(e => e.op === "forget").map(e => e.target));
  for (const op of ops) {
    if (op.op === "demote") demotes.set(op.target, op);
    if (op.op === "settle" && !settles.has(op.target)) settles.set(op.target, op);
  }
  return rows.flatMap(({ row }) => {
    if (row.op !== "note" || forgotten.has(row.id)) return [];
    const demote = demotes.get(row.id);
    if (row.tier !== "short" && !demote) return [];
    const settled = row.task ? settles.get(row.task) : undefined;
    // A held decision/contract/fail waits for promotion, not expiry, unless explicitly demoted or dated.
    if (row.tier === "short" && !demote && !row.expires && settled && ["decision", "contract", "fail"].includes(row.kind)) return [];
    const basis = demote ?? (row.expires ? row : settled);
    const expiredAt = basis?.op === "note" ? basis.expires : basis && "by" in basis ? basis.by : undefined;
    if (!basis || !expiredAt || !Number.isFinite(Date.parse(expiredAt)) || new Date(expiredAt).toISOString() !== expiredAt) return [];
    return [{ targetId: row.id, basisId: basis.id, expiredAt }];
  });
}

/** Generation-owned derived state. Legacy files are inputs, never opened as a MemoryStore. */
export class GenerationIndex {
  readonly profile: BoundProfile;
  pruned = new Set<string>();
  constructor(private readonly options: GenerationIndexOptions) {
    this.profile = options.profile;
    const db = options.db;
    db.run("CREATE TABLE IF NOT EXISTS generation_rows (id TEXT PRIMARY KEY, line TEXT NOT NULL, local INTEGER NOT NULL, public INTEGER NOT NULL, own INTEGER NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS generation_prunes (id TEXT PRIMARY KEY, line TEXT NOT NULL, local INTEGER NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS generation_targets (id TEXT PRIMARY KEY)");
    db.run("CREATE TABLE IF NOT EXISTS generation_segments (source TEXT NOT NULL, path TEXT NOT NULL, offset INTEGER NOT NULL, hash TEXT NOT NULL, commit_id TEXT, PRIMARY KEY(source,path))");
    db.run("CREATE TABLE IF NOT EXISTS generation_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  private ownSegments(): LegacySegment[] {
    return ["log", "local"].flatMap(folder => {
      const dir = join(this.profile.dir, folder);
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return fail();
      return readdirSync(dir).sort().filter(name => name.endsWith(".jsonl")).map(name => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(name)) return fail();
        const file = join(dir, name), stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return fail();
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        let all: Buffer;
        try { all = readFileSync(fd); } finally { closeSync(fd); }
        const end = all.lastIndexOf(10) + 1, bytes = all.subarray(0, end);
        return { source: "generation", path: `${folder}/${name}`, bytes, offset: end, hash: digest(bytes), local: folder === "local", tailBytes: all.length - end };
      });
    });
  }
  private capture(): { segments: LegacySegment[]; commit?: string } {
    const db = this.options.db;
    const previous = db.query("SELECT source,path,offset,hash,commit_id FROM generation_segments WHERE source != 'generation'").all() as (LegacyCheckpoint & { commit_id: string | null })[];
    const initial = readProfileJSON(join(this.profile.dir, "migration-sources.json")) as { sources?: LegacyCheckpoint[]; legacyCommit?: string } | undefined;
    const bySource = new Map((initial?.sources ?? []).map(row => [`${row.source}:${row.path}`, row]));
    for (const { commit_id, ...row } of previous) bySource.set(`${row.source}:${row.path}`, { ...row, ...(commit_id ? { commit: commit_id } : {}) });
    const checkpoints = [...bySource.values()];
    const prior = (db.query("SELECT value FROM generation_state WHERE key='legacyCommit'").get() as { value: string } | null)?.value ?? initial?.legacyCommit;
    const commit = this.options.commit ?? legacyHead(this.profile.home, this.profile.generation!);
    const legacy = readLegacySnapshot(this.profile.home, { generation: this.profile.generation, ...(commit ? { commit } : {}), checkpoints, ...(prior ? { previousCommit: prior } : {}), ...(this.options.limits ? { limits: this.options.limits } : {}) });
    const own = this.ownSegments();
    for (const old of db.query("SELECT path,offset,hash FROM generation_segments WHERE source='generation'").all() as { path: string; offset: number; hash: string }[]) {
      const segment = own.find(s => s.path === old.path);
      if (!segment || segment.offset < old.offset || digest(segment.bytes.subarray(0, old.offset)) !== old.hash) fail();
    }
    return { segments: [...legacy, ...own], ...(commit ? { commit } : {}) };
  }
  private index(captured: { segments: LegacySegment[]; commit?: string }): void {
    const db = this.options.db;
    for (const segment of captured.segments) {
      const consumed = (db.query("SELECT offset FROM generation_segments WHERE source=? AND path=?").get(segment.source, segment.path) as { offset: number } | null)?.offset ?? 0;
      for (const line of segment.bytes.subarray(consumed).toString("utf8").split("\n").filter(Boolean)) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { fail(); }
        if ((parsed as { op?: string }).op === "prune") {
          if (segment.source !== "generation") fail();
          const row = validatePruneRow(parsed, this.profile.generation, segment.local ? "local" : "synced");
          if (segment.path !== `${segment.local ? "local" : "log"}/${row.machine}.jsonl`) fail();
          db.query("INSERT OR IGNORE INTO generation_prunes VALUES (?,?,?)").run(row.id, canonicalJSON(row), Number(segment.local));
          continue;
        }
        const bytes = Buffer.from(line + "\n");
        const row = legacyEntries([{ ...segment, bytes, offset: bytes.length, hash: digest(bytes) }])[0];
        if (!row) continue;
        const canonical = canonicalJSON(row), old = db.query("SELECT line FROM generation_rows WHERE id=?").get(row.id) as { line: string } | null;
        if (old && old.line !== canonical) fail();
        this.options.apply(line, segment.path);
        const local = segment.local || row.op === "settle" || row.op === "note" && row.tier === "short";
        const publicWitness = !local && segment.source !== "legacy-local";
        db.query("INSERT INTO generation_rows VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET local=MIN(local,excluded.local), public=MAX(public,excluded.public), own=MAX(own,excluded.own)")
          .run(row.id, canonical, Number(local), Number(publicWitness), Number(segment.source === "generation"));
      }
      db.query("INSERT INTO generation_segments VALUES (?,?,?,?,?) ON CONFLICT(source,path) DO UPDATE SET offset=excluded.offset,hash=excluded.hash,commit_id=excluded.commit_id")
        .run(segment.source, segment.path, segment.offset, segment.hash, segment.commit ?? null);
    }
    if (captured.commit) db.query("INSERT INTO generation_state VALUES ('legacyCommit',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(captured.commit);
    const snapshot = this.snapshot(false);
    const prunes = (db.query("SELECT line,local FROM generation_prunes ORDER BY id").all() as { line: string; local: number }[]).map(row => ({ row: JSON.parse(row.line), placement: row.local ? "local" as const : "synced" as const }));
    const reduced = reducePruneRows(prunes, snapshot, this.profile.generation!);
    db.run("DELETE FROM generation_targets");
    for (const id of [...reduced.targets].sort()) db.query("INSERT INTO generation_targets VALUES (?)").run(id);
    this.pruned = reduced.targets;
  }
  private frontier(): string {
    const db = this.options.db;
    return db.transaction(() => canonicalJSON({
      segments: db.query("SELECT * FROM generation_segments ORDER BY source,path").all(),
      state: db.query("SELECT * FROM generation_state ORDER BY key").all(),
    })).deferred();
  }
  refresh(attempt = 0): void {
    const before = this.frontier(), db = this.options.db;
    let input: ReturnType<GenerationIndex["capture"]>;
    try { input = this.capture(); }
    catch (error) { if (attempt < 5 && this.frontier() !== before) return this.refresh(attempt + 1); throw error; }
    if (this.frontier() !== before) { if (attempt < 5) return this.refresh(attempt + 1); return fail(); }
    const known = db.query("SELECT source,path,offset,hash,commit_id FROM generation_segments").all() as { source: string; path: string; offset: number; hash: string; commit_id: string | null }[];
    const currentCommit = (db.query("SELECT value FROM generation_state WHERE key='legacyCommit'").get() as { value: string } | null)?.value;
    const unchanged = known.length === input.segments.length && currentCommit === input.commit && input.segments.every(segment => known.some(row => row.source === segment.source && row.path === segment.path && row.offset === segment.offset && row.hash === segment.hash && row.commit_id === (segment.commit ?? null)));
    if (unchanged) { this.pruned = new Set((db.query("SELECT id FROM generation_targets").all() as { id: string }[]).map(row => row.id)); return; }
    const committed = db.transaction(() => { if (this.frontier() !== before) return false; this.index(input); return true; }).immediate();
    if (!committed) { if (attempt < 5) return this.refresh(attempt + 1); return fail(); }
  }
  rebuild(attempt = 0): void {
    const before = this.frontier();
    let input: ReturnType<GenerationIndex["capture"]>;
    try { input = this.capture(); }
    catch (error) { if (attempt < 5 && this.frontier() !== before) return this.rebuild(attempt + 1); throw error; }
    const committed = this.options.db.transaction(() => {
      if (this.frontier() !== before) return false;
      for (const table of ["entries", "ops", "edges", "goals", "segments", "heads", ...GENERATION_TABLES]) this.options.db.run(`DELETE FROM ${table}`);
      this.index(input); return true;
    }).immediate();
    if (!committed) { if (attempt < 5) return this.rebuild(attempt + 1); return fail(); }
  }
  own(id: string): boolean { return !!(this.options.db.query("SELECT own FROM generation_rows WHERE id=?").get(id) as { own: number } | null)?.own; }
  snapshot(refresh = true): PruneSnapshot {
    if (refresh) this.refresh();
    return this.options.db.transaction(() => {
      const rows = (this.options.db.query("SELECT line,local,public FROM generation_rows ORDER BY id").all() as { line: string; local: number; public: number }[]).map(r => ({ row: JSON.parse(r.line) as Entry, placement: r.local ? "local" as const : "synced" as const, publicWitness: !!r.public }));
      const pruned = (this.options.db.query("SELECT id FROM generation_targets ORDER BY id").all() as { id: string }[]).map(row => row.id);
      return { rows, expiries: explicitExpirySnapshot(rows), pruned, durablePruneIds: (this.options.db.query("SELECT id FROM generation_prunes ORDER BY id").all() as { id: string }[]).map(r => r.id) };
    }).deferred();
  }
  port(machine: string): PruneStorePort {
    return { generation: this.profile.generation!, machine, now: this.options.now,
      selectorRevision: () => selectorRevision(this.profile.home), snapshot: () => this.snapshot(),
      withMutation: work => this.options.withMutation(work), refresh: () => this.refresh(),
      persistPrunePlan: plan => this.persistPlan(plan), appendPrune: (row, line, seal) => this.append(row, line, seal) };
  }
  private pendingPath(local: boolean, machine: string): string { return join(this.profile.dir, "prune-plans", `pending-${local ? "local" : "log"}-${machine}.json`); }
  /** Every ordinary writer must refuse to append unrelated JSON after a prune crash tail. */
  assertAppendable(local: boolean, machine: string): void {
    if (readProfileJSON(this.pendingPath(local, machine)) !== undefined) fail();
    const file = join(this.profile.dir, local ? "local" : "log", `${machine}.jsonl`);
    if (!existsSync(file)) return;
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) fail();
    const bytes = readFileSync(file);
    if (bytes.length && bytes.at(-1) !== 10) fail();
  }
  private persistPlan(plan: PrunePlan): void {
    const dir = join(this.profile.dir, "prune-plans");
    if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) fail();
    mkdirSync(dir, { mode: 0o700, recursive: true });
    fsyncDirectory(this.profile.dir);
    const file = join(dir, `${plan.seal}.json`), existing = readProfileJSON(file);
    if (existing && canonicalJSON(existing) !== canonicalJSON(plan)) fail();
    if (!existing) writeProfileJSON(file, plan);
  }
  private append(row: PruneRow, line: string, seal: string): "written" | "already-durable" {
    const plan = readProfileJSON(join(this.profile.dir, "prune-plans", `${seal}.json`)) as PrunePlan | undefined;
    if (!plan?.rows.some(item => canonicalJSON(item.payload) === canonicalJSON(row)) || line !== canonicalJSON(row) + "\n") return fail();
    this.refresh();
    const already = this.snapshot(false).durablePruneIds?.includes(row.id);
    const path = join(this.profile.dir, row.placement === "local" ? "local" : "log", `${row.machine}.jsonl`);
    const fd = openSync(path, constants.O_RDWR | (already ? 0 : constants.O_CREAT) | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const data = readFileSync(fd), tail = data.subarray(data.lastIndexOf(10) + 1), bytes = Buffer.from(line);
      const pending = this.pendingPath(row.placement === "local", row.machine);
      const prior = readProfileJSON(pending) as { schema?: string; seal?: string; rowId?: string; lineHash?: string; offset?: number; prefixHash?: string } | undefined;
      if (prior) {
        if (prior.schema !== "agent-mem.prune-append/v1" || prior.seal !== seal || prior.rowId !== row.id || prior.lineHash !== digest(bytes)
          || !Number.isSafeInteger(prior.offset) || prior.offset! < 0 || prior.offset! > data.length || digest(data.subarray(0, prior.offset)) !== prior.prefixHash) return fail();
        if (already ? !data.subarray(prior.offset, prior.offset! + bytes.length).equals(bytes) : prior.offset !== data.length - tail.length) return fail();
      } else if (!already) {
        if (tail.length) return fail();
        writeProfileJSON(pending, { schema: "agent-mem.prune-append/v1", seal, rowId: row.id, lineHash: digest(bytes), offset: data.length, prefixHash: digest(data) });
      }
      if (already) {
        const complete = data.subarray(0, data.lastIndexOf(10) + 1).toString("utf8").split("\n").filter(Boolean);
        if (!complete.some(value => canonicalJSON(JSON.parse(value)) === canonicalJSON(row))) return fail();
      } else {
        if (!bytes.subarray(0, tail.length).equals(tail)) return fail();
        let offset = tail.length;
        while (offset < bytes.length) { const wrote = writeSync(fd, bytes, offset, bytes.length - offset); if (wrote <= 0) fail(); offset += wrote; }
      }
      // A parsed complete line is not proof of fsync. Resume must cross this fence too.
      fsyncSync(fd);
      fsyncDirectory(join(this.profile.dir, row.placement === "local" ? "local" : "log"));
      if (readProfileJSON(pending) !== undefined) { unlinkSync(pending); fsyncDirectory(join(this.profile.dir, "prune-plans")); }
    } finally { closeSync(fd); }
    this.refresh();
    return already ? "already-durable" : "written";
  }
}
