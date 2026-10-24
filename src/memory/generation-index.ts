import { SHARDED_SCHEMA } from "./shard.ts";
import { readShardLegacySnapshot } from "./shard-bridge.ts";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON, fsyncDirectory, readProfileJSON, selectorRevision, writeProfileJSON, type BoundProfile, validateVaultLinkRow, type VaultLink } from "./generation.ts";
import { legacyEntries, legacyHead, readLegacySnapshot, SegmentReader, type LegacyCheckpoint, type LegacySegment } from "./bridge.ts";
import { reducePruneRows, validatePruneRow, type PrunePlan, type PruneRow, type PruneSnapshot, type PruneSourceRow, type PruneStorePort } from "./prune.ts";
import { PROMOTED_KINDS, type Entry } from "./store.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (): never => { throw new Error("generation input unavailable or changed; person inspection required"); };
export const GENERATION_TABLES = ["generation_vault_links", "generation_rows", "generation_prunes", "generation_targets", "generation_segments", "generation_state"] as const;
export interface GenerationIndexOptions {
  profile: BoundProfile; db: Database; now: () => number;
  apply: (line: string, source: string) => void;
  withMutation: <T>(work: () => T) => T;
  limits?: readonly LegacyCheckpoint[]; commit?: string;
}
/** Pure deadline summary shared by migration and prune: no live index or host TTL is a proof. */
export function explicitExpirySnapshot(rows: readonly PruneSourceRow[]): PruneSnapshot["expiries"] {
  const ops = rows.filter(source => source.row.op !== "note" && source.row.op !== "goal").sort((a, b) => a.row.at.localeCompare(b.row.at) || a.row.id.localeCompare(b.row.id));
  const demotes = new Map<string, Entry>(), settles = new Map<string, Entry>();
  const forgotten = new Set(ops.flatMap(({ row }) => row.op === "forget" ? [row.target] : []));
  for (const source of ops) {
    const op = source.row;
    if (op.op === "demote") demotes.set(op.target, op);
    if (op.op === "settle") {
      const realms = [...(source.own === true ? [true] : []), ...((source.legacy ?? source.own !== true) ? [false] : [])];
      for (const own of realms) { const task = `${own}:${op.target}`; if (!settles.has(task)) settles.set(task, op); }
    }
  }
  return rows.flatMap(({ row, own }) => {
    if (row.op !== "note" || forgotten.has(row.id)) return [];
    const demote = demotes.get(row.id);
    if (row.tier !== "short" && !demote) return [];
    const settled = row.task ? settles.get(`${own === true}:${row.task}`) : undefined;
    // A held decision/contract/fail waits for promotion, not expiry, unless explicitly demoted or dated.
    if (row.tier === "short" && !demote && !row.expires && settled && PROMOTED_KINDS.includes(row.kind)) return [];
    const basis = demote ?? (row.expires ? row : settled);
    const expiredAt = basis?.op === "note" ? basis.expires : basis && "by" in basis ? basis.by : undefined;
    if (!basis || !expiredAt || !Number.isFinite(Date.parse(expiredAt)) || new Date(expiredAt).toISOString() !== expiredAt) return [];
    return [{ targetId: row.id, basisId: basis.id, expiredAt }];
  });
}

/** Exact source-presence reducer shared by indexing and migration proof validation. */
export function coalesceGenerationSource(prior: PruneSourceRow | undefined, row: Entry, source: { source: string; local: boolean }): PruneSourceRow {
  if (prior && canonicalJSON(prior.row) !== canonicalJSON(row)) return fail();
  const local = source.local || row.op === "settle" || row.op === "note" && row.tier === "short";
  const publicWitness = !local && source.source !== "legacy-local";
  const own = source.source === "generation";
  return { row, placement: local && (!prior || prior.placement === "local") ? "local" : "synced",
    publicWitness: !!prior?.publicWitness || publicWitness,
    own: prior ? row.op === "note" ? prior.own === true && own : prior.own === true || own : own,
    legacy: !!prior?.legacy || !own };
}

/** Generation-owned derived state. Legacy files are inputs, never opened as a MemoryStore. */
export class GenerationIndex {
  readonly profile: BoundProfile;
  pruned = new Set<string>();
  private readonly reader = new SegmentReader();
  private fullCapture = false;
  private replayProvenance = false;
  constructor(private readonly options: GenerationIndexOptions) {
    this.profile = options.profile;
    const db = options.db;
    db.run("CREATE TABLE IF NOT EXISTS generation_rows (id TEXT PRIMARY KEY, line TEXT NOT NULL, local INTEGER NOT NULL, public INTEGER NOT NULL, own INTEGER NOT NULL, legacy INTEGER NOT NULL)");
    if (!(db.query("PRAGMA table_info(generation_rows)").all() as { name: string }[]).some(row => row.name === "legacy")) { db.run("ALTER TABLE generation_rows ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0"); this.replayProvenance = true; }
    db.run("CREATE TABLE IF NOT EXISTS generation_vault_links (id TEXT PRIMARY KEY, target TEXT NOT NULL, row_hash TEXT NOT NULL, project TEXT NOT NULL, path TEXT NOT NULL, at TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS generation_prunes (id TEXT PRIMARY KEY, line TEXT NOT NULL, local INTEGER NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS generation_targets (id TEXT PRIMARY KEY)");
    db.run("CREATE TABLE IF NOT EXISTS generation_segments (source TEXT NOT NULL, path TEXT NOT NULL, offset INTEGER NOT NULL, hash TEXT NOT NULL, commit_id TEXT, stamp TEXT, PRIMARY KEY(source,path))");
    if (!(db.query("PRAGMA table_info(generation_segments)").all() as { name: string }[]).some(row => row.name === "stamp")) db.run("ALTER TABLE generation_segments ADD COLUMN stamp TEXT");
    db.run("CREATE TABLE IF NOT EXISTS generation_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  private ownSegments(reader: SegmentReader = this.reader): LegacySegment[] {
    const prior = this.options.db.query("SELECT source,path,offset,hash,commit_id,stamp FROM generation_segments WHERE source='generation'").all() as (LegacyCheckpoint & { stamp: string | null })[];
    return ["log", "local"].flatMap(folder => {
      const dir = join(this.profile.dir, folder);
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return fail();
      return readdirSync(dir).sort().filter(name => name.endsWith(".jsonl")).map(name => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(name)) return fail();
        const path = `${folder}/${name}`, checkpoint = prior.find(row => row.path === path);
        const data = reader.read(join(dir, name), checkpoint ? { ...checkpoint, stamp: checkpoint.stamp ?? undefined } : undefined, this.fullCapture);
        return { ...data, source: "generation", path, local: folder === "local" };
      });
    });
  }
  /** Authoring handles cannot read or append a partially resumed split; migration index bootstraps use captured limits. */
  private shardFrontier(): string | undefined {
    if (!this.profile.sharded || this.options.limits !== undefined) return undefined;
    const value = readProfileJSON(join(this.profile.home, "shards.json")) as { schema?: unknown; phase?: unknown; generation?: unknown; selectorRevision?: unknown } | undefined;
    if (!value || value.schema !== SHARDED_SCHEMA || value.phase !== "active" || value.generation !== this.profile.generation || value.selectorRevision !== this.profile.selectorRevision) return fail();
    return hashJSON(value);
  }
  private capture(reader: SegmentReader = this.reader): { segments: LegacySegment[]; commit?: string } {
    const shardBefore = this.shardFrontier();
    const db = this.options.db;
    const previous = db.query("SELECT source,path,offset,hash,commit_id,stamp FROM generation_segments WHERE source != 'generation'").all() as (LegacyCheckpoint & { commit_id: string | null; stamp: string | null })[];
    const initial = readProfileJSON(join(this.profile.dir, "migration-sources.json")) as { sources?: LegacyCheckpoint[]; legacyCommit?: string } | undefined;
    const bySource = new Map((initial?.sources ?? []).map(row => [`${row.source}:${row.path}`, row]));
    for (const { commit_id, stamp, ...row } of previous) bySource.set(`${row.source}:${row.path}`, { ...row, ...(stamp ? { stamp } : {}), ...(commit_id ? { commit: commit_id } : {}) });
    const checkpoints = [...bySource.values()];
    const persisted = new Set(previous.map(row => `${row.source}:${row.path}`));
    const completeFrontier = checkpoints.every(row => persisted.has(`${row.source}:${row.path}`));
    const prior = (db.query("SELECT value FROM generation_state WHERE key='legacyCommit'").get() as { value: string } | null)?.value ?? initial?.legacyCommit;
    const legacyHome = this.profile.legacyHome ?? this.profile.home;
    const generation = this.profile.sharded ? undefined : this.profile.generation;
    const commit = this.options.commit ?? (generation ? legacyHead(legacyHome, generation) : undefined);
    const legacy = this.profile.sharded
      ? readShardLegacySnapshot(this.profile, { checkpoints, ...(this.options.limits ? { limits: this.options.limits } : {}), reader, incremental: !this.fullCapture && !this.options.limits && completeFrontier })
      : readLegacySnapshot(legacyHome, { ...(generation ? { generation } : {}), ...(commit ? { commit } : {}), checkpoints, ...(generation && prior ? { previousCommit: prior } : {}), ...(this.options.limits ? { limits: this.options.limits } : {}), reader, incremental: !this.fullCapture && !this.options.limits && completeFrontier });
    const own = this.ownSegments(reader);
    for (const old of db.query("SELECT path,offset,hash FROM generation_segments WHERE source='generation'").all() as { path: string; offset: number; hash: string }[]) {
      const segment = own.find(s => s.path === old.path);
      if (!segment || segment.offset < old.offset) fail();
    }
    if (this.shardFrontier() !== shardBefore) return fail();
    return { segments: [...legacy, ...own], ...(commit ? { commit } : {}) };
  }
  private index(captured: { segments: LegacySegment[]; commit?: string }): void {
    const db = this.options.db;
    for (const segment of captured.segments) {
      const consumed = (db.query("SELECT offset FROM generation_segments WHERE source=? AND path=?").get(segment.source, segment.path) as { offset: number } | null)?.offset ?? 0;
      if ((segment.start ?? 0) > consumed) return fail();
      for (const line of segment.bytes.subarray(Math.max(0, consumed - (segment.start ?? 0))).toString("utf8").split("\n").filter(Boolean)) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { if (segment.source === "generation") return fail(); this.recordSkipped(segment); continue; }
        if (segment.source === "generation" && parsed && typeof parsed === "object" && (parsed as { op?: string }).op === "prune") {
          const row = validatePruneRow(parsed, this.profile.generation, segment.local ? "local" : "synced");
          if (segment.path !== `${segment.local ? "local" : "log"}/${row.machine}.jsonl`) fail();
          db.query("INSERT OR IGNORE INTO generation_prunes VALUES (?,?,?)").run(row.id, canonicalJSON(row), Number(segment.local));
          continue;
        }
        if (segment.source === "generation" && parsed && typeof parsed === "object" && (parsed as { op?: string }).op === "vault_link") {
          const row = validateVaultLinkRow(parsed, this.profile.generation, segment.local ? "local" : "synced");
          if (segment.path !== `local/${row.machine}.jsonl`) fail();
          db.query("INSERT OR IGNORE INTO generation_vault_links VALUES (?,?,?,?,?,?)").run(row.id, row.target, row.rowHash, row.project, row.path, row.at);
          continue;
        }
        const bytes = Buffer.from(line + "\n");
        const row = legacyEntries([{ ...segment, bytes, offset: bytes.length, hash: digest(bytes) }], { strict: segment.source === "generation", onMalformed: () => this.recordSkipped(segment) })[0];
        if (!row) continue;
        const canonical = canonicalJSON(row), old = db.query("SELECT line,local,public,own,legacy FROM generation_rows WHERE id=?").get(row.id) as { line: string; local: number; public: number; own: number; legacy: number } | null;
        if (old && old.line !== canonical) fail();
        this.options.apply(line, segment.path);
        const presence = coalesceGenerationSource(old ? { row, placement: old.local ? "local" : "synced", publicWitness: !!old.public, own: !!old.own, legacy: !!old.legacy } : undefined, row, segment);
        db.query("INSERT INTO generation_rows VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET local=MIN(local,excluded.local), public=MAX(public,excluded.public), own=excluded.own, legacy=excluded.legacy")
          .run(row.id, canonical, Number(presence.placement === "local"), Number(presence.publicWitness), Number(presence.own), Number(presence.legacy));
      }
      db.query("INSERT INTO generation_segments VALUES (?,?,?,?,?,?) ON CONFLICT(source,path) DO UPDATE SET offset=excluded.offset,hash=excluded.hash,commit_id=excluded.commit_id,stamp=excluded.stamp")
        .run(segment.source, segment.path, segment.offset, segment.hash, segment.commit ?? null, segment.stamp ?? null);
    }
    if (captured.commit) db.query("INSERT INTO generation_state VALUES ('legacyCommit',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(captured.commit);
    const snapshot = this.snapshot(false);
    const prunes = (db.query("SELECT line,local FROM generation_prunes ORDER BY id").all() as { line: string; local: number }[]).map(row => ({ row: JSON.parse(row.line), placement: row.local ? "local" as const : "synced" as const }));
    const reduced = reducePruneRows(prunes, snapshot, this.profile.generation!);
    db.run("DELETE FROM generation_targets");
    for (const id of [...reduced.targets].sort()) db.query("INSERT INTO generation_targets VALUES (?)").run(id);
    this.pruned = reduced.targets;
  }
  private recordSkipped(segment: LegacySegment): void {
    this.options.db.query("INSERT INTO generation_state VALUES (?,'1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run(`skipped:${segment.source}:${segment.path}`);
  }
  skippedRows(): number {
    return (this.options.db.query("SELECT COALESCE(SUM(CAST(value AS INTEGER)),0) AS n FROM generation_state WHERE key LIKE 'skipped:%'").get() as { n: number }).n;
  }
  private frontier(): string {
    const db = this.options.db;
    return db.transaction(() => canonicalJSON({
      segments: db.query("SELECT * FROM generation_segments ORDER BY source,path").all(),
      state: db.query("SELECT * FROM generation_state ORDER BY key").all(),
    })).deferred();
  }
  refresh(attempt = 0, reader: SegmentReader = this.reader): void {
    if (this.replayProvenance) { this.rebuild(0, reader); return; }
    const before = this.frontier(), db = this.options.db;
    let input: ReturnType<GenerationIndex["capture"]>;
    try { input = this.capture(reader); }
    catch (error) { if (attempt < 5 && this.frontier() !== before) return this.refresh(attempt + 1, reader); throw error; }
    if (this.frontier() !== before) { if (attempt < 5) return this.refresh(attempt + 1, reader); return fail(); }
    const known = db.query("SELECT source,path,offset,hash,commit_id,stamp FROM generation_segments").all() as { source: string; path: string; offset: number; hash: string; commit_id: string | null; stamp: string | null }[];
    const currentCommit = (db.query("SELECT value FROM generation_state WHERE key='legacyCommit'").get() as { value: string } | null)?.value;
    const unchanged = known.length === input.segments.length && currentCommit === input.commit && input.segments.every(segment => known.some(row => row.source === segment.source && row.path === segment.path && row.offset === segment.offset && row.hash === segment.hash && row.commit_id === (segment.commit ?? null) && row.stamp === (segment.stamp ?? null)));
    if (unchanged) { this.pruned = new Set((db.query("SELECT id FROM generation_targets").all() as { id: string }[]).map(row => row.id)); return; }
    const committed = db.transaction(() => { if (this.frontier() !== before) return false; this.index(input); return true; }).immediate();
    if (!committed) { if (attempt < 5) return this.refresh(attempt + 1, reader); return fail(); }
  }
  rebuild(attempt = 0, reader: SegmentReader = this.reader): void {
    const before = this.frontier();
    let input: ReturnType<GenerationIndex["capture"]>;
    try { this.fullCapture = true; input = this.capture(reader); }
    catch (error) { this.fullCapture = false; if (attempt < 5 && this.frontier() !== before) return this.rebuild(attempt + 1, reader); throw error; }
    finally { this.fullCapture = false; }
    const committed = this.options.db.transaction(() => {
      if (this.frontier() !== before) return false;
      for (const table of ["entries", "ops", "edges", "goals", "segments", "heads", ...GENERATION_TABLES]) this.options.db.run(`DELETE FROM ${table}`);
      this.index(input); return true;
    }).immediate();
    if (!committed) { if (attempt < 5) return this.rebuild(attempt + 1, reader); return fail(); }
    this.replayProvenance = false;
  }
  vaultWitnesses(ids: readonly string[]): Map<string, string> {
    if (ids.length > 5000) throw new Error("vault scan budget exceeded");
    return new Map((this.options.db.query("SELECT id,line FROM generation_rows WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { id: string; line: string }[])
      .map(row => [row.id, hashJSON(JSON.parse(row.line))]));
  }
  vaultLinks(project: string): VaultLink[] {
    const rows = this.options.db.query("SELECT l.id,l.target,l.row_hash AS rowHash,l.project,l.path,l.at,r.line FROM generation_vault_links l JOIN generation_rows r ON r.id=l.target WHERE l.project=? ORDER BY l.at,l.id LIMIT 5001").all(project) as (VaultLink & { line: string })[];
    if (rows.length > 5000) throw new Error("vault scan budget exceeded");
    return rows
      .filter(row => { const note = JSON.parse(row.line) as Entry; return note.op === "note" && note.project === row.project && hashJSON(note) === row.rowHash; })
      .map(({ line: _line, ...row }) => row);
  }
  own(id: string): boolean { return !!(this.options.db.query("SELECT own FROM generation_rows WHERE id=?").get(id) as { own: number } | null)?.own; }
  snapshot(refresh = true): PruneSnapshot {
    if (refresh) this.refresh();
    return this.options.db.transaction(() => {
      const rows = (this.options.db.query("SELECT line,local,public,own,legacy FROM generation_rows ORDER BY id").all() as { line: string; local: number; public: number; own: number; legacy: number }[]).map(r => ({ row: JSON.parse(r.line) as Entry, placement: r.local ? "local" as const : "synced" as const, publicWitness: !!r.public, own: !!r.own, legacy: !!r.legacy }));
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
    this.shardFrontier();
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
