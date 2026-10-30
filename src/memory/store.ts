import { readShardLegacySnapshot } from "./shard-bridge.ts";
import { cliAttribution } from "./cli-attribution.ts";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { isDenied, realPath } from "./platform.ts";
import { stripPrivateDeep, stripPrivateSpans } from "./private-spans.ts";
import { looksSecret } from "./screen.ts";
import { mutationDatabase } from "./mutation.ts";
import { memoryHome } from "./home.ts";
import { machineId, type Machine } from "./machine.ts";
import { assertProjectActive } from "./lifecycle.ts";
export { machineId, type Machine } from "./machine.ts";
import { rankedScore, rankedScoreDetails, unrankedScoreDetails, type SearchScoreDetails } from "./search-score.ts";
export type { SearchScoreDetails } from "./search-score.ts";
import { readWindowSql, readRef, type ReadWindow, type ReadRef, SearchIndex, captureSearch } from "./search-fts.ts";
import { assertCuratedShardPaths, ensureShardDescriptor, readShardDescriptor, readShardedSelection, aliasedKeys, resolveAlias, resolveShardProfile, shardDir, shardKeyHash, shardMachineDir, userShardDir } from "./shard.ts";
import { readCaptureConfig, type CaptureRow } from "./capture.ts";
import { assertSharedV1Op } from "./ops-contract.ts";
import { generationDescriptor, generationDir, fsyncDirectory, canonicalJSON, hashJSON, readProfileJSON, resolveProfile, writeProfileJSON, readSelector, type BoundProfile, type ProfileInput, validateVaultLinkRow, vaultLinkId, type VaultLink, type VaultLinkRow } from "./generation.ts";
import { GenerationIndex, coalesceGenerationSource, explicitExpirySnapshot, GENERATION_TABLES } from "./generation-index.ts";
import { legacyEntries, readLegacySnapshot, SegmentReader, type LegacyCheckpoint } from "./bridge.ts";
import { readMigrationSources } from "./migrate.ts";
import type { PruneSourceRow, PruneStorePort } from "./prune.ts";
import { isDeepStrictEqual } from "node:util";
import { registerReaderLease, type ReaderLease } from "./reader-lease.ts";

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
  schema: typeof MEMORY_SCHEMA; op: "forget" | "supersede" | "demote" | "settle" | "goal_state" | "goal_link" | "lease" | "lease_force" | "suggest" | "confirm" | "reject"; id: string; at: string; machine: string;
  /** An entry id, a goal id, or for `settle` a task key. */
  target: string;
  /** `supersede`: the newer entry; `goal_state`: the state; `goal_link`: the task key; `lease`, `lease_force`: until (ISO); `settle`, `demote`: when the short-term entries leave the index (ISO), fixed when written; `suggest`: `<rel>:<entry id>`. */
  by?: string;
  actor: string;
}
/** #258 phase 2: a long-term task, a goal that spans sessions, board tasks, projects and machines. */
export interface GoalEntry {
  schema: typeof MEMORY_SCHEMA; op: "goal"; id: string; at: string; machine: string;
  project: string; scope: Scope; title: string; milestones: string[]; dependsOn: string[]; actor: string;
}
export type Entry = NoteEntry | OpEntry | GoalEntry;
export const GOAL_STATES = ["open", "active", "blocked", "done", "dropped"] as const;
export type GoalState = (typeof GOAL_STATES)[number];
export const DEFAULT_LEASE_MS = 4 * 3600_000;
/** Bumped when the index's tables change: an index with another version is dropped and rebuilt from the logs. */
const INDEX_VERSION = 3; // 3: suggest, confirm and reject ops (an older index skipped them)
export const SUGGESTED = ["contradicts", "same_topic"] as const;
export type Suggested = (typeof SUGGESTED)[number];
export interface Suggestion { id: string; at: string; from: string; to: string; rel: Suggested; status: "suggested" | "confirmed" | "rejected" }
export type NoteInput = Omit<NoteEntry, "schema" | "id" | "at" | "machine">;
export type OpInput = Omit<OpEntry, "schema" | "id" | "at" | "machine">;
export type GoalInput = Omit<GoalEntry, "schema" | "id" | "at" | "machine">;

/** Key order fixed, so the same content always hashes to the same id. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const entryId = (e: Omit<Entry, "id">): string => createHash("sha256").update(canonical(e)).digest("hex").slice(0, 32);

// Single-sourced in screen.ts so the capture tier (#13) screens excerpts without importing this store; the export stays.
export { looksSecret };

/** `task`: the board task's id and proposal time; its node carries both, so a task id reused after `ahub reset --all` is another node. */
export interface Extract { cwd: string; project: string; repo: string; deny?: string[]; paths?: string[]; symbols?: string[]; task?: { id: number; created: number }; checkExists?: boolean }
/**
 * Deterministic edges, fixed at write time so a rebuild never depends on the file system: the task's refs and plan
 * paths, plan symbols (with the path when the plan names exactly one), paths in the text that exist in the project then (or text-only paths when checkExists is false),
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
    try { if (!isAbsolute(p) && !p.startsWith("..") && (x.checkExists === false || existsSync(join(x.cwd, p)))) path(p); } catch { /* unreadable: not an edge */ }
  }
  for (const m of text.matchAll(/\btask #(\d{1,9})\b/gi)) out.add(`task:${x.project}#${m[1]}`);
  for (const m of text.matchAll(/(?<![\w/]|task )#(\d{1,9})\b/gi)) out.add(`issue:${x.repo}#${m[1]}`);
  if (x.task !== undefined) out.add(`task:${x.project}#${x.task.id}@${x.task.created}`);
  return [...out].sort().slice(0, MAX_TARGETS);
}

/** Text that is rendered as one line: whitespace runs (newlines included) collapse, and it is capped. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);

/** A board task's key in hub memory: unique across `ahub reset --all`, which restarts the ids. */
export const taskKey = (project: string, task: { id: number; created: number }): string => `${project}#${task.id}@${task.created}`;

/** A person's name for this machine, shown beside its id. */
export function setMachineLabel(dir: string, label: string): Machine {
  const m = machineId(dir);
  const clean = label.trim().replace(/[^\w .@-]/g, "").slice(0, 40) || m.id;
  writeFileSync(join(dir, "machine.json.tmp"), JSON.stringify({ id: m.id, label: clean }) + "\n", { mode: 0o600 });
  renameSync(join(dir, "machine.json.tmp"), join(dir, "machine.json"));
  return { id: m.id, label: clean };
}

export interface View {
  id: string; at: string; machine: string; project: string; scope: Scope; tier: Tier; kind: Kind; peer: string; title: string | null; text: string;
  task: string | null; about: Node[]; source: string; supersededBy: string | null; supersedes: string[]; promotedFrom: string | null; expiresAt: string | null;
  /** Written as short-term, so it lives in this machine's local segment and never syncs. */
  local: boolean;
}
export interface VaultEntry { view: View; /** Full authored hash in generation profiles; empty for read-only shared-v1. */ rowHash: string }
export interface RecallStateOptions { person?: boolean; asOf?: string; history?: boolean; maxRows?: number; maxBytes?: number }
export interface RecallRelation { from: string; to: string; at: string; kind: "supersede" | "promote" }
export interface RetainedRecallState {
  at: string; views: View[]; forgotten: { id: string; at: string }[]; relations: RecallRelation[];
  malformed: number; incomplete: boolean; notices: string[];
  /** Present only when retained source diagnostics independently make the result incomplete. */
  sourceIncomplete?: true;
}
interface RecallViewProjection {
  now: number; rows: Record<string, string | null>[];
  ops: { id: string; op: string; at: string; target: string; by: string | null }[];
  realms?: Map<string, { id: string; own: number; legacy: number }>;
  pruned: Set<string>; forgotten: Set<string>; includePromoted: boolean;
}
export interface GoalView {
  id: string; at: string; machine: string; project: string; scope: Scope; title: string; milestones: string[]; dependsOn: string[];
  state: GoalState; links: { task: string; at: string; machine: string }[];
  /** The machine holding it now; other active claims are a conflict. Without an active claim: the last one, expired. */
  lease: { holder: string | null; until: string | null; conflict: string[]; expired: boolean; lastHolder?: string | null };
}
export interface Filter { project?: string; tier?: Tier; kind?: Kind; peer?: string; machine?: string; since?: string; q?: string; limit?: number; includeSuperseded?: boolean }
/** #13 search: `Filter` plus the capture-tier switch (on by default; capture is recall, never curated evidence). */
export interface SearchFilter extends Filter {
  includeCapture?: boolean;
  /** Attach score factors only when explicitly requested. */
  explain?: boolean;
  /** A host that writes capture with a `retentionDays` override passes the same value here; files decide otherwise. */
  captureRetentionDays?: number;
}
export interface SearchHit { source: "curated" | "capture"; score: number; scoreDetails?: SearchScoreDetails; view?: View; capture?: CaptureRow }
export interface SearchResult { engine: "fts5" | "substring"; hits: SearchHit[] }
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
export interface StoreOptions { home?: string; memoryDir?: string; ttlMs?: number; now?: () => number; log?: (line: string) => void; screen?: PromotionScreen; deferPromotions?: boolean; profile?: ProfileInput;
  /** #15 T5: `openShardStore` refuses a project the person archived or forgot unless the caller says `ignore` (the catalog, `--include-archived` reads and export do, on purpose). */
  lifecycle?: "enforce" | "ignore";
  /** #27: read the `aliases` keys' curated rows as part of the `canonical` project (CLI and MCP only); the library default reads the raw key. Rows are presented under `canonical`. */
  reconcile?: { canonical: string; aliases: readonly string[] };
  /** Explicit project import may initialize configured alias shards; read-only reconciliation still never creates them. */
  createAliases?: boolean;
}

const MIGRATION_BOOTSTRAP = Symbol("migration index bootstrap");
interface BootstrapBinding { token: typeof MIGRATION_BOOTSTRAP; profile: BoundProfile; limits?: readonly LegacyCheckpoint[]; commit?: string; authoring?: boolean; userOverlay?: MemoryStore; aliasStores?: MemoryStore[] }
export class MemoryStore {
  readonly dir: string;
  readonly profile: BoundProfile;
  private readonly generationIndex?: GenerationIndex;
  private readonly bootstrapOnly: boolean;
  readonly machine: Machine;
  private readonly db: Database;
  private readonly mutationDb: Database;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly deferPromotions: boolean;
  /** #13: the derived FTS5 copy of the curated rows, and the memory home base for capture shard resolution (#15 T1). */
  private readonly searchIndex: SearchIndex;
  private readonly memoryBaseDir: string;
  private releaseReaderLease?: ReaderLease;
  private readonly userOverlay?: MemoryStore;
  /** #27: the other keys' shards of a reconciled read (curated shards); shared-v1 reads them from its own index. */
  private readonly aliasStores: MemoryStore[];
  private readonly reconcile?: { canonical: string; aliases: readonly string[] };
  /** A full rebuild refills FTS in one resync instead of one derived transaction per entry. */
  private rebuildingSearch = false;

  constructor(opts: StoreOptions = {}, bootstrap?: BootstrapBinding) {
    if (bootstrap && bootstrap.token !== MIGRATION_BOOTSTRAP) throw new Error("invalid migration bootstrap");
    this.bootstrapOnly = bootstrap ? bootstrap.authoring !== true : false;
    this.userOverlay = bootstrap?.userOverlay;
    this.aliasStores = bootstrap?.aliasStores ?? [];
    this.reconcile = opts.reconcile && opts.reconcile.aliases.length ? { canonical: opts.reconcile.canonical, aliases: [...opts.reconcile.aliases] } : undefined;
    if (opts.memoryDir !== undefined && (opts.home !== undefined || typeof opts.memoryDir !== "string" || !opts.memoryDir.trim())) throw new Error("choose a memory home or one explicit memory directory");
    const home = bootstrap?.profile.home ?? opts.memoryDir ?? (opts.home === undefined ? memoryHome() : join(opts.home, "memory"));
    if (!bootstrap && lstatSync(join(home, "shards.json"), { throwIfNoEntry: false })) throw new Error("memory home has a curated split; hosts must use openShardStore({ project }) or openShardStore({ user: true }); finish an incomplete split with amem migrate --shards --resume");
    this.profile = bootstrap?.profile ?? resolveProfile(home, opts.profile);
    if (bootstrap && (this.profile.kind !== "generation" || !this.profile.generation
      || (!this.profile.sharded && this.profile.dir !== generationDir(this.profile.home, this.profile.generation))
      || canonicalJSON(readProfileJSON(join(this.profile.dir, "generation.json"))) !== canonicalJSON(generationDescriptor(this.profile.generation)))) throw new Error("invalid migration profile binding");
    // Shared-v1 preserves its historical lexical dir API; profile.home is still canonical for selector identity.
    this.dir = this.profile.kind === "shared-v1" ? home : this.profile.dir;
    mkdirSync(join(this.dir, "log"), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.dir, "local"), { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700); // mkdir's mode applies only when it creates the directory
    this.machine = machineId(this.profile.sharded ? this.profile.home : this.dir);
    this.ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.screen = opts.screen;
    this.deferPromotions = opts.deferPromotions ?? false;
    // Announce before opening derived handles or reading rows; failed admission leaks no database handles.
    if (!bootstrap || bootstrap.authoring === true) this.releaseReaderLease = registerReaderLease(this.profile.home);
    let openedDb: Database | undefined, openedMutation: Database | undefined, openedSearch: SearchIndex | undefined;
    try {
      const indexFile = join(this.dir, this.profile.foreignPruneFormat ? "index-v2.db" : "index.db");
      if (this.profile.foreignPruneFormat) for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const stat = lstatSync(indexFile + suffix, {throwIfNoEntry:false});
        if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())) throw new Error("v2 index path unavailable");
      }
      const db = openedDb = new Database(indexFile, { create: true });
      if (this.profile.foreignPruneFormat) chmodSync(indexFile, 0o600);
      db.run(`PRAGMA busy_timeout = ${MEMORY_DB_BUSY_TIMEOUT_MS}`);
      db.run("PRAGMA journal_mode = WAL");
      if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version !== INDEX_VERSION) {
        for (const t of ["segments", "heads", "entries", "ops", "edges", "goals"]) db.run(`DROP TABLE IF EXISTS ${t}`);
        db.run(`PRAGMA user_version = ${INDEX_VERSION}`);
      }
      db.run("CREATE TABLE IF NOT EXISTS segments (file TEXT PRIMARY KEY, offset INTEGER NOT NULL)");
      // The hash of each segment's whole indexed prefix: a segment rewritten in place (same size or larger) is caught.
      db.run("CREATE TABLE IF NOT EXISTS heads (file TEXT PRIMARY KEY, hash TEXT NOT NULL)");
      db.run("CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, at TEXT NOT NULL, machine TEXT NOT NULL, project TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, milestones TEXT NOT NULL, depends TEXT NOT NULL, actor TEXT NOT NULL)");
      db.run(`CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, at TEXT NOT NULL, machine TEXT NOT NULL, project TEXT NOT NULL, scope TEXT NOT NULL, tier TEXT NOT NULL,
        kind TEXT NOT NULL, peer TEXT NOT NULL, title TEXT, text TEXT NOT NULL, task TEXT, about TEXT NOT NULL, supersedes TEXT, promoted_from TEXT, source TEXT NOT NULL, expires TEXT)`);
      db.run("CREATE TABLE IF NOT EXISTS ops (id TEXT PRIMARY KEY, op TEXT NOT NULL, at TEXT NOT NULL, machine TEXT NOT NULL, target TEXT NOT NULL, by TEXT, actor TEXT NOT NULL)");
      db.run("CREATE TABLE IF NOT EXISTS edges (src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst))");
      db.run("CREATE INDEX IF NOT EXISTS edges_dst ON edges (dst)");
      this.db = db;
      this.mutationDb = openedMutation = mutationDatabase(this.dir);
      // One derived FTS copy per profile: a generation handle and a shared-v1 handle on one home never resync-fight.
      this.searchIndex = openedSearch = new SearchIndex(this.profile.sharded ? join(this.dir, "search.db") : join(home, this.profile.kind === "generation" ? `search-${this.profile.generation}.db` : "search.db"));
      this.memoryBaseDir = home;
      try { chmodSync(join(this.dir, this.profile.foreignPruneFormat ? "index-v2.db" : "index.db"), 0o600); } catch { /* best effort */ }
      if (this.profile.kind === "generation") this.generationIndex = new GenerationIndex({ profile: this.profile, db, now: this.now,
        apply: (line, source) => this.apply(line, source), withMutation: work => this.withMutation(work),
        ...(bootstrap ? { limits: bootstrap.limits } : {}), ...(bootstrap?.commit ? { commit: bootstrap.commit } : {}) });
      this.refresh();
    } catch (error) {
      for (const handle of [openedSearch, openedMutation, openedDb]) { try { handle?.close(); } catch { /* preserve the opening failure */ } }
      const release = this.releaseReaderLease;
      this.releaseReaderLease = undefined;
      release?.();
      throw error;
    }
  }

  /** The host must authenticate person intent before authorizing plan/apply through this port. */
  prunePort(): PruneStorePort {
    if (this.bootstrapOnly || !this.generationIndex) throw new Error("durable prune requires an active generation handle");
    return this.generationIndex.port(this.machine.id);
  }

  /** Borrowed sync targets: the opened canonical shard plus its user overlay, never person-local aliases. Do not close these handles. */
  openedSyncTargets(): readonly MemoryStore[] {
    return [this, ...(this.userOverlay ? [this.userOverlay] : [])];
  }

  /** Read-only project views, bounded before bodies or hashes; never promotes or authors a prune. */
  vaultEntries(project: string): VaultEntry[] {
    if (!project.trim() || this.profile.sharded && !this.profile.shardUser && this.profile.shardKey !== project) throw new Error("vault project does not match the bound store");
    this.withDeferredPromotions(() => this.ensureFresh());
    const scanLimit = 5000;
    const own = this.db.query("SELECT id FROM entries WHERE project IN (SELECT value FROM json_each(?)) LIMIT ?").all(JSON.stringify(this.scopeKeys(project)), scanLimit + 1) as { id: string }[];
    if (own.length > scanLimit) throw new Error("vault scan budget exceeded; refine the store before retrying");
    const overlay = new Map([...(this.userOverlay?.vaultEntries(project) ?? []), ...this.aliasStores.flatMap(store => store.vaultEntries(store.profile.shardKey!))].map(entry => [entry.view.id, entry.rowHash]));
    if (new Set([...own.map(row => row.id), ...overlay.keys()]).size > scanLimit) throw new Error("vault scan budget exceeded; refine the store before retrying");
    const authored = this.generationIndex?.vaultWitnesses(own.map(row => row.id));
    return this.views(false, { project }).filter(view => view.project === project).map(view => {
      // A shared-v1 read cannot record links and needs no authored witness or new index field.
      const rowHash = this.generationIndex ? authored?.get(view.id) ?? overlay.get(view.id) : "";
      if (rowHash === undefined) throw new Error("authored vault entry witness unavailable");
      return { view, rowHash };
    });
  }
  vaultLinks(project: string): VaultLink[] {
    this.ensureFresh();
    if (!project.trim() || this.profile.sharded && !this.profile.shardUser && this.profile.shardKey !== project) throw new Error("vault project does not match the bound store");
    return [...this.scopeKeys(project).flatMap(key => this.generationIndex?.vaultLinks(key) ?? []), ...(this.userOverlay?.vaultLinks(project) ?? []), ...this.aliasStores.flatMap(store => store.vaultLinks(store.profile.shardKey!))];
  }
  /** Exact id/hash recheck under the existing mutation fence; never follows promoted/superseded aliases. */
  recordVaultLink(id: string, path: string, project: string, rowHash: string): string {
    if (this.bootstrapOnly || !this.generationIndex) throw new Error("vault links require an active generation handle");
    if (this.userOverlay?.vaultEntries(project).some(entry => entry.view.id === id)) return this.userOverlay.recordVaultLink(id, path, project, rowHash);
    const aliased = this.aliasStores.find(store => store.vaultEntries(store.profile.shardKey!).some(entry => entry.view.id === id));
    if (aliased) return aliased.recordVaultLink(id, path, aliased.profile.shardKey!, rowHash);
    return this.withMutation(() => {
      this.refresh();
      const entry = this.vaultEntries(project).find(row => row.view.id === id && row.rowHash === rowHash);
      if (!entry || entry.view.tier !== "long" || entry.view.local || entry.view.supersededBy) throw new Error("exact vault entry changed or unavailable");
      // A link names the key the row was written under (never the canonical label a reconciled read shows), so a raw-key reader still finds it.
      const written = this.rawProject(entry.view);
      const prior = this.vaultLinks(project).find(row => row.target === id && row.rowHash === rowHash && row.path === path);
      if (prior) return prior.id;
      const body = { schema: "agent-mem.vault-link/v1", op: "vault_link", generation: this.profile.generation!,
        at: new Date(this.now()).toISOString(), machine: this.machine.id, actor: "person", placement: "local", target: id, rowHash, project: written, path } as const;
      const row: VaultLinkRow = { ...body, id: vaultLinkId(body) };
      validateVaultLinkRow(row, this.profile.generation, "local");
      this.generationIndex!.assertAppendable(true, this.machine.id);
      const file = join(this.dir, "local", `${this.machine.id}.jsonl`), existed = existsSync(file);
      const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("vault link segment is not an owned regular file");
        appendFileSync(fd, canonicalJSON(row) + "\n"); fsyncSync(fd);
      } finally { closeSync(fd); }
      if (!existed) fsyncDirectory(join(this.dir, "local"));
      try { this.refresh(); } catch (error) { this.stale = true; throw error; }
      return row.id;
    });
  }

  /** Full derived receipt for golden replay; raw debug data, never model evidence. */
  derivedTables(): Record<string, unknown[]> {
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(tables.map(({ name }) => [name, (this.db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as unknown[]).sort((a, b) => canonicalJSON(a).localeCompare(canonicalJSON(b)))]));
  }

  close(): void {
    const release = this.releaseReaderLease;
    this.releaseReaderLease = undefined;
    try { this.db.close(); this.mutationDb.close(); this.searchIndex.close(); }
    finally { try { this.userOverlay?.close(); } finally { try { for (const store of this.aliasStores) store.close(); } finally { release?.(); } } }
  }

  /** A synchronous host-authorized mutation whose reads must not implicitly promote unrelated notes. */
  withDeferredPromotions<T>(work: () => T): T {
    const previous = this.readStores().map(store => [store, store.promoting] as const);
    for (const [store] of previous) store.promoting = true;
    try { return work(); } finally { for (const [store, promoting] of previous) store.promoting = promoting; }
  }

  private withMutation<T>(work: () => T): T {
    return this.mutationDb.transaction(work).immediate();
  }

  /** Synchronous exact-target work under every opened shard's existing writer fence. No read-time promotions. */
  withCurrentEntries<T>(ids: readonly string[], project: string, work: (entries: readonly View[]) => T): T {
    if (!ids.length || ids.length > MAX_TARGETS || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{32}$/.test(id)) || !project.trim()) throw new Error("invalid exact-entry batch");
    return this.withStoreFences(stores => {
      assertProjectActive(this.profile.home, project);
      for (const store of stores) store.ensureFresh();
      const entries = ids.map(id => {
        const view = this.get(id, project);
        if (!view || view.id !== id || view.supersededBy) throw new Error("exact entry changed or unavailable");
        return view;
      });
      return work(entries);
    });
  }
  /**
   * Exact original transport placement; View.local describes tier, not a verified publication choice.
   * ponytail: a legacy (shared-v1) home reads its whole snapshot under a 32 MiB byte budget on every call and refuses past it, so consolidation and its acceptance are unavailable for a legacy home that large. Upgrade: migrate the home to a generation (its placements come from the indexed `generation_rows`), or keep a placement index for legacy homes.
   */
  entryPlacements(ids: readonly string[], project: string): ReadonlyMap<string, "local" | "synced"> {
    if (!ids.length || ids.length > 256 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{32}$/.test(id)) || !project.trim()) throw Error("invalid placement batch");
    return this.withStoreFences(stores => {
      const wanted = new Set(ids), found = new Map<string, "local" | "synced">(), reader = new SegmentReader(32 * 1024 * 1024);
      const add = (id: string, placement: "local" | "synced") => { if (wanted.has(id) && (placement === "synced" || !found.has(id))) found.set(id, placement); };
      assertProjectActive(this.profile.home, project);
      for (const store of stores) {
        if (store.generationIndex) {
          store.generationIndex.refresh(0, reader);
          const rows = store.db.query("SELECT id,local FROM generation_rows WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { id: string; local: number }[];
          for (const row of rows) add(row.id, row.local ? "local" : "synced");
        } else {
          // Strict bounded verification includes locations, never guesses transport from tier or View.local.
          const presence = new Map<string, PruneSourceRow>();
          for (const segment of readLegacySnapshot(store.dir, { reader })) for (const row of legacyEntries([segment], { strict: true })) {
            if (row.op === "note" && wanted.has(row.id)) {
              const located = coalesceGenerationSource(presence.get(row.id), row, segment);
              presence.set(row.id, located); add(row.id, located.placement);
            }
          }
          store.ensureFresh(); // Refresh only after the strict bounded source read succeeds.
        }
      }
      for (const id of ids) { const view = this.get(id, project); if (!view || view.id !== id || view.project !== project || !found.has(id)) throw Error("entry placement unavailable"); }
      return found;
    });
  }
  private withStoreFences<T>(work: (stores: readonly MemoryStore[]) => T): T {
    const unique = new Map<string, MemoryStore>();
    for (const store of this.readStores()) { const dir = realPath(store.dir); if (!unique.has(dir)) unique.set(dir, store); }
    const stores = [...unique.keys()].sort().map(dir => unique.get(dir)!);
    const lock = (index: number): T => index === stores.length ? work(stores) : stores[index]!.withMutation(() => lock(index + 1));
    // Older/raw writers that bypass mutation-lock.db retain the existing mutation.ts ceiling.
    return this.withDeferredPromotions(() => lock(0));
  }

  /** Serialize current-store writers, screen one normalized body, and expose a one-shot append of that body. */
  withAcceptedNote<T>(note: NoteInput, work: (append: () => string) => T): T {
    if (this.userOverlay && note.scope === "shared") return this.userOverlay.withAcceptedNote(note, work);
    try { return this.withMutation(() => {
      // Ordinary writes may defer indexing, but accepting an exact target revision must have a current index.
      this.db.transaction(() => this.refresh()).immediate();
      const at = new Date(this.now()).toISOString();
      const normalized = structuredClone({ ...note, text: stripPrivateSpans(note.text).slice(0, MAX_TEXT),
        ...(note.title ? { title: stripPrivateSpans(note.title).slice(0, MAX_TITLE) } : {}),
        ...(note.tier === "short" && !note.expires ? { expires: new Date(Date.parse(at) + this.ttl).toISOString() } : {}) });
      const body = { schema: MEMORY_SCHEMA, at, machine: this.machine.id, ...normalized } as const;
      const view: View = { ...normalized, id: entryId(body), at, machine: body.machine, title: normalized.title ?? null,
        task: normalized.task ?? null, about: [...normalized.about], supersededBy: null,
        supersedes: normalized.supersedes ? [normalized.supersedes] : [], promotedFrom: normalized.promotedFrom ?? null,
        expiresAt: normalized.expires ?? null, local: normalized.tier === "short" };
      if (this.screen?.(view) !== "promote") throw new Error("candidate refused by current promotion screen");
      let appended = false;
      return work(() => {
        if (appended) throw new Error("accepted note already appended");
        appended = true;
        return this.appendBody(body, normalized.tier === "short");
      });
    }); } catch (error) {
      // A callback can fail after a durable JSONL append; ensure the derived index catches up.
      this.stale = true;
      throw error;
    }
  }

  /** When a short-term entry written now leaves the index. */
  private until(): string { return new Date(this.now() + this.ttl).toISOString(); }

  /** Append one entry to this machine's long-term (synced) or local segment and index it. Returns its id. */
  private append(entry: NoteInput | OpInput | GoalInput, local: boolean, at = new Date(this.now()).toISOString(), machine = this.machine.id): string {
    // `<private>` spans are never stored, whoever writes (note, goal, promotion): dropped before the cap, the hash and the log line.
    const capped = entry.op === "note" ? { ...entry, text: stripPrivateSpans(entry.text).slice(0, MAX_TEXT), ...(entry.title ? { title: stripPrivateSpans(entry.title).slice(0, MAX_TITLE) } : {}) }
      : entry.op === "goal" ? stripPrivateDeep(entry) : entry;
    const body = { schema: MEMORY_SCHEMA, at, machine, ...capped } as Omit<Entry, "id">;
    return this.appendBody(body, local);
  }

  private appendBody(body: Omit<Entry, "id">, local: boolean): string {
    if (this.bootstrapOnly) throw new Error("migration bootstrap cannot author memory");
    if (this.userOverlay && (body.op === "note" || body.op === "goal") && "scope" in body && body.scope === "shared") return this.userOverlay.appendBody(body, local);
    if ("target" in body && body.op !== "settle") { const owner = this.ownerOf(body.target as string); if (owner) return owner.appendBody(body, local); }
    if (this.profile.sharded && (body.op === "note" || body.op === "goal") && "scope" in body && "project" in body) {
      if (this.profile.shardUser ? body.scope !== "shared" : body.scope !== "project" || body.project !== this.profile.shardKey) throw new Error("entry does not belong to this curated shard");
    }
    if (this.profile.sharded && body.op === "settle" && "target" in body && (typeof body.target !== "string" || (!this.profile.shardUser && !body.target.startsWith(`${this.profile.shardKey}#`)))) throw new Error("settlement does not belong to this curated shard");
    assertSharedV1Op(body.op);
    // Lock the authoritative log independently: a busy derived index must never prevent an ordinary append.
    return this.withMutation(() => {
      this.generationIndex?.assertAppendable(local, this.machine.id);
      const id = entryId(body);
      appendFileSync(join(this.dir, local ? "local" : "log", `${this.machine.id}.jsonl`), JSON.stringify({ ...body, id }) + "\n", { mode: 0o600 });
      // The line is durable even if indexing fails; the next refresh catches up from the authoritative log.
      try { this.refresh(); } catch (e) { this.stale = true; this.log(`hub memory index not updated yet: ${(e as Error).message}`); }
      return id;
    });
  }

  /** A note: short-term ones stay on this machine, long-term ones go to the synced log. The caller has screened it. */
  // A short-term note on a task that was settled already gets its own deadline: the task's has passed or is close.
  // `ownClock`: a note asked for short-term on purpose expires on its own clock, open task or not, and is never promoted.
  note(n: NoteInput, ownClock = false): string { return this.append(n.tier === "short" && !n.expires && (ownClock || !n.task || this.settled(n.task)) ? { ...n, expires: this.until() } : n, n.tier === "short"); }

  /** The already-opened owner of an imported row, shared by preflight and append. */
  private importOwner(n: NoteInput): MemoryStore {
    if (this.bootstrapOnly) throw new Error("migration bootstrap cannot import memory");
    if (this.userOverlay && n.scope === "shared") return this.userOverlay.importOwner(n);
    if (this.profile.sharded && !this.profile.shardUser && n.scope === "project" && n.project !== this.profile.shardKey) {
      const owner = this.aliasStores.find(store => store.profile.shardKey === n.project);
      if (owner) return owner.importOwner(n);
    }
    if (this.profile.sharded && (this.profile.shardUser ? n.scope !== "shared" : n.scope !== "project" || n.project !== this.profile.shardKey)) throw new Error("entry does not belong to this curated shard");
    return this;
  }

  /** Check every import route before a multi-row caller appends; never creates a missing alias shard. */
  assertImportable(notes: Iterable<NoteInput>): void {
    for (const note of notes) this.importOwner(note);
  }

  /**
   * An entry from another store with its own time (`ahub memory import claude-mem`): the same source row always gives
   * the same id, so a second import writes nothing. Returns the id and whether it was new.
   */
  importNote(n: NoteInput, at: string, identity: { machine?: string; expectedId?: string } = {}): { id: string; added: boolean } {
    const owner = this.importOwner(n);
    if (owner !== this) return owner.importNote(n, at, identity);
    assertSharedV1Op(n.op);
    // A fixed machine: the same observation imported on two machines is one entry once they sync. A project import preserves the exported identity instead.
    const body = { schema: MEMORY_SCHEMA, at, machine: identity.machine ?? "claude-mem", ...n, text: stripPrivateSpans(n.text).slice(0, MAX_TEXT), ...(n.title ? { title: stripPrivateSpans(n.title).slice(0, MAX_TITLE) } : {}) } as Omit<Entry, "id">;
    const id = entryId(body);
    if (identity.expectedId !== undefined && identity.expectedId !== id) throw new Error("project import entry identity changed");
    return this.withMutation(() => {
      this.generationIndex?.assertAppendable(n.tier === "short", this.machine.id);
      // The source tuple also recognizes legacy ids whose nodes depended on the checkout or extractor version.
      const known = this.db.query("SELECT id FROM entries WHERE id = ? OR (source = 'claude-mem' AND project = ? AND at = ? AND text = ?)").get(id, n.project, at, stripPrivateSpans(n.text).slice(0, MAX_TEXT)) as { id: string } | null;
      if (known) return { id: known.id, added: false };
      appendFileSync(join(this.dir, n.tier === "short" ? "local" : "log", `${this.machine.id}.jsonl`), JSON.stringify({ ...body, id }) + "\n", { mode: 0o600 });
      return { id, added: true };
    });
  }

  /** A person's or the hub's op on an entry; it goes where the entry lives, so forgetting a long-term entry syncs. */
  private op(op: OpEntry["op"], target: View, actor: string, by?: string): string {
    return this.append({ op, target: target.id, actor, ...(by ? { by } : {}) }, target.local);
  }
  /** Complete existing forget expansion, including superseded legacy-import copies. Reads author no ops. */
  forgetTargets(id: string, project?: string): View[] {
    const v = this.get(id, project); return v ? this.forgetGroup(v) : [];
  }
  private forgetGroup(v: View): View[] {
    return v.source === "claude-mem" ? this.live().filter(x => x.source === v.source && x.project === v.project && x.at === v.at && x.text === v.text) : [v];
  }
  forget(id: string, actor: string, project?: string, exactOnly = false): View | undefined {
    const v = this.get(id, project);
    if (!v) return undefined;
    const group = this.forgetGroup(v);
    if (exactOnly && (group.length !== 1 || group[0]?.id !== id)) throw Error("forget expands beyond the reviewed exact entry");
    // Ordinary person forget retains its legacy-import copy expansion; reviewed decay is exact-only.
    for (const member of group) this.op("forget", member, actor);
    return v;
  }

  /** Plan or append reconciliation of legacy imports, preserving every existing replacement relation. */
  dedupe(project: string, apply = false): { groups: { members: View[]; heads: string[]; target: string }[]; applied: number } {
    const rows = this.live(), byId = new Map(rows.map(v => [v.id, v]));
    const tuples = new Map<string, View[]>();
    for (const v of rows) {
      if (v.project !== project || v.source !== "claude-mem") continue;
      const key = JSON.stringify([v.at, v.text]);
      const group = tuples.get(key) ?? []; group.push(v); tuples.set(key, group);
    }
    const groups: { members: View[]; heads: string[]; target: string }[] = [];
    for (const members of tuples.values()) {
      if (members.length < 2) continue;
      members.sort((a, b) => a.id.localeCompare(b.id));
      const heads = members.filter(v => !v.supersededBy);
      if (!heads.length) continue;
      const ids = new Set(members.map(v => v.id));
      const terminals = new Map<string, View>();
      for (const v of members) {
        let terminal = v;
        const seen = new Set<string>();
        while (terminal.supersededBy && !seen.has(terminal.id)) {
          seen.add(terminal.id);
          const next = byId.get(terminal.supersededBy);
          if (!next) break;
          terminal = next;
        }
        if (!terminal.supersededBy && !ids.has(terminal.id) && !terminal.local && (terminal.project === project || terminal.scope === "shared") && heads.every(h => h.scope !== "shared" || terminal.scope === "shared")) terminals.set(terminal.id, terminal);
      }
      const outside = [...terminals.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))[0];
      if (!outside && heads.length === 1) continue;
      groups.push({ members, heads: heads.map(v => v.id), target: outside?.id ?? heads[0]!.id });
    }
    let applied = 0;
    if (apply) for (const group of groups) for (const head of group.heads) {
      if (head === group.target) continue;
      if (!this.supersede(head, group.target, cliAttribution()?.actor ?? "user", project)) throw new Error("memory dedupe replacement refused; rerun to inspect current relations");
      applied++;
    }
    return { groups, applied };
  }
  /** A short-term note kept short-term: it expires like any other and is never promoted (its demote entry stays local). */
  keepShort(id: string, actor: string): void { const v = this.get(id); if (v?.tier === "short" && v.local && v.expiresAt === null) this.op("demote", v, actor, this.until()); } // once: a deadline is never pushed out
  /** The short-tier deadline to display before a person confirms a demotion. */
  shortExpiry(): string { return this.until(); }
  /** A confirmed deadline may be older than a fresh one, but cannot extend the configured TTL beyond one hour. */
  assertDemotionExpiry(expiresAt: string): void {
    const at = Date.parse(expiresAt), now = this.now();
    if (!Number.isFinite(at) || new Date(at).toISOString() !== expiresAt || at <= now || at > now + this.ttl + 3600_000) throw Error("demotion expiry must be future UTC within the short-tier deadline plus one hour");
  }
  demote(id: string, actor: string, project?: string, expiresAt?: string): View | undefined {
    if (expiresAt !== undefined) this.assertDemotionExpiry(expiresAt);
    const v = this.get(id, project); if (v?.tier === "long") this.op("demote", v, actor, expiresAt ?? this.until()); return v;
  }
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
    const owner = v ? this.ownerOf(v.id) : undefined;
    if (v && owner) return owner.promote(v.id, actor, owner.profile.shardKey ?? project, auto);
    if (v && this.generationIndex && !this.generationIndex.own(v.id)) return undefined;
    if (!v || v.tier !== "short") return v?.id;
    if (v.supersededBy) return undefined;
    // Screened here, whatever asked: a note saved under an older policy must not reach the synced log under a newer one.
    const verdict = this.screen ? this.screen(v) : auto ? "skip" : "promote";
    if (verdict === "skip") return undefined;
    if (verdict === "keep") { this.keepShort(v.id, actor); return undefined; }
    // ponytail: the check and the append are not one step across processes: a person forgetting or replacing this entry
    // at the very moment another process promotes it can leave the copy current on other machines. A per-machine lock
    // around local mutations (like sync's) would close it.
    return this.append({ op: "note", project: this.rawProject(v), scope: v.scope, tier: "long", kind: v.kind, peer: v.peer, ...(v.title ? { title: v.title } : {}), text: v.text,
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
      const entry = { op: "settle", target: task, actor, by: this.until() } as const;
      const at = new Date(this.now()).toISOString();
      // #27: a task key `<key>#...` belongs to the shard of `<key>`. In a reconciled sharded store that can be an aliased key's shard, which refuses a settlement of any other key.
      const owner = this.aliasStores.find(store => store.profile.shardKey !== undefined && task.startsWith(`${store.profile.shardKey}#`));
      (owner ?? this).append(entry, true, at, owner ? this.machine.id : undefined);
      if (this.userOverlay) this.userOverlay.append(entry, true, at, this.machine.id);
      return this.promoteSettled(task, actor) + (this.userOverlay?.promoteSettled(task, actor) ?? 0) + this.aliasStores.reduce((n, store) => n + store.promoteSettled(task, actor), 0);
    } finally { this.promoting = false; }
  }
  private promoteSettled(task: string, actor: string): number {
    // Only the notes held for promotion (no deadline): one saved short-term after the settlement stays short-term.
    const moving = this.views().filter((v) => (!this.generationIndex || this.generationIndex.own(v.id)) && v.task === task && v.tier === "short" && v.local && !v.supersededBy && v.expiresAt === null && PROMOTED_KINDS.includes(v.kind));
    return moving.filter((v) => this.promote(v.id, actor, undefined, true) !== undefined).length;
  }
  /** Whether a task was settled in this profile. Reconciliation may opt into bridged legacy settlements. */
  settled(task: string, options: { includeLegacy?: boolean } = {}): boolean {
    return this.readRows(this.generationIndex && !options.includeLegacy
      ? "SELECT 1 FROM ops JOIN generation_rows ON generation_rows.id=ops.id WHERE op='settle' AND target=? AND own=1"
      : "SELECT 1 FROM ops WHERE op = 'settle' AND target = ?", task).length > 0;
  }
  /** Whether any entry was saved against the task. */
  hasTask(task: string): boolean { this.ensureFresh(); return this.readRows("SELECT 1 FROM entries WHERE task = ?", task).length > 0; }
  private promoting = false;
  private readonly screen?: PromotionScreen;
  /**
   * After every read: a settled task's held decision, contract or fail moves to long-term once nothing replaces it (a
   * settlement a crash cut short, or a replacement that was forgotten or expired).
   */
  private promoteHeld(): void {
    if (this.promoting || this.deferPromotions) return;
    this.promoting = true;
    try {
      const settled = new Set((this.db.query(this.generationIndex
        ? "SELECT target FROM ops JOIN generation_rows ON generation_rows.id=ops.id WHERE op='settle' AND own=1"
        : "SELECT target FROM ops WHERE op = 'settle'").all() as { target: string }[]).map((r) => r.target));
      if (!settled.size) return;
      for (const v of this.views()) {
        if (this.generationIndex && !this.generationIndex.own(v.id)) continue; // The bridge never auto-promotes legacy inputs.
        if (v.task && settled.has(v.task) && v.tier === "short" && v.local && !v.supersededBy && v.expiresAt === null && PROMOTED_KINDS.includes(v.kind)) {
          try { this.promote(v.id, "hub", undefined, true); } catch { /* fail-open: tried again at the next read */ }
        }
      }
    } finally { this.promoting = false; }
  }

  /** Index what the segments gained since the last read. A line still being written (no newline yet) waits for the next read. */
  refresh(attempt = 0): void {
    if (this.generationIndex) { this.generationIndex.refresh(); return; }
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
    this.searchIndex.reset();
    if (this.generationIndex) { this.generationIndex.rebuild(); return; }
    // One transaction: no reader sees the index empty, and no other process commits an offset in between.
    this.rebuildingSearch = true;
    try {
      this.db.transaction(() => { for (const t of ["segments", "heads", "entries", "ops", "edges", "goals"]) this.db.run(`DELETE FROM ${t}`); this.refresh(); }).immediate();
    } finally { this.rebuildingSearch = false; }
    this.syncSearchIndex(); // one batched derived write, not one search.db transaction per rebuilt entry
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
      const inserted = this.db.query(`INSERT OR IGNORE INTO entries (id, at, machine, project, scope, tier, kind, peer, title, text, task, about, supersedes, promoted_from, source, expires)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, e.at, e.machine, e.project, e.scope === "shared" ? "shared" : "project", e.tier === "long" ? "long" : "short",
        e.kind, e.peer, e.title ?? null, e.text, e.task ?? null, JSON.stringify(e.about.map(String)), e.supersedes ?? null, e.promotedFrom ?? null, e.source ?? "hub", typeof e.expires === "string" ? e.expires : null).changes;
      // The FTS copy follows the committed row. `changes` is only a hint here (bun:sqlite misreports it for ignored
      // inserts inside a transaction): addCurated is idempotent by entry id, and a missed hint becomes a count drift
      // the next search resyncs.
      if (inserted && !this.rebuildingSearch) this.searchIndex.addCurated({ id, at: e.at, project: e.project, tier: e.tier === "long" ? "long" : "short", scope: e.scope === "shared" ? "shared" : "project", body: `${e.title ?? ""}\n${e.text}\n${e.about.map(String).join(" ")}` });
      for (const node of e.about) this.db.query("INSERT OR IGNORE INTO edges (src, dst) VALUES (?, ?)").run(id, String(node));
    } else if (e.op === "goal") {
      if (!str(e.title, 400) || !Array.isArray(e.milestones) || !Array.isArray(e.dependsOn) || !str(e.project, 400) || !opt(e.actor) || !opt(e.scope)) { this.log(`memory segment ${segment}: a malformed entry was skipped`); return; }
      this.db.query("INSERT OR IGNORE INTO goals (id, at, machine, project, scope, title, milestones, depends, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, e.at, e.machine, e.project, e.scope === "shared" ? "shared" : "project", e.title, JSON.stringify(e.milestones.map(String)), JSON.stringify(e.dependsOn.map(String)), e.actor ?? "");
    } else if (["forget", "supersede", "demote", "settle", "goal_state", "goal_link", "lease", "lease_force", "suggest", "confirm", "reject"].includes(e.op)) {
      // A deadline is a date: a reader's own TTL must never stand in for an unreadable one.
      const dated = !["demote", "settle", "lease", "lease_force"].includes(e.op) || (typeof e.by === "string" && !Number.isNaN(Date.parse(e.by)));
      if (!str(e.target, 400) || !opt(e.by) || !opt(e.actor) || !dated) { this.log(`memory segment ${segment}: a malformed entry was skipped`); return; }
      this.db.query("INSERT OR IGNORE INTO ops (id, op, at, machine, target, by, actor) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, e.op, e.at, e.machine, e.target, e.by ?? null, e.actor ?? "");
    }
  }

  /** Only the bound project and user overlay participate; never scan another project's private shard. */
  private readStores(): MemoryStore[] { return [this, ...(this.userOverlay ? [this.userOverlay] : []), ...this.aliasStores]; }
  /** #27: the keys a project filter covers: the project, and with a reconciled read every key aliased to it. */
  private scopeKeys(project: string): string[] { return this.reconcile && project === this.reconcile.canonical ? [project, ...this.reconcile.aliases] : [project]; }
  private inScope(rowProject: string, project: string): boolean { return this.scopeKeys(project).includes(rowProject); }
  /** The key a row was written under. A reconciled read labels aliased rows with the canonical key, but every write that copies a row keeps its own key (#27). */
  private rawProject(view: View): string {
    if (!this.reconcile || !this.reconcile.aliases.length) return view.project;
    for (const store of this.readStores()) {
      const row = store.db.query("SELECT project FROM entries WHERE id = ?").get(view.id) as { project: string } | null;
      if (row) return row.project;
    }
    return view.project;
  }
  /** A row of an aliased key reads under the canonical key. */
  private label(project: string): string { return this.reconcile?.aliases.includes(project) ? this.reconcile.canonical : project; }
  /** The store that holds the log line of `id`, when it is not this one: the user overlay or an aliased key's shard. */
  private ownerOf(id: string): MemoryStore | undefined { return [...(this.userOverlay ? [this.userOverlay] : []), ...this.aliasStores].find(store => store.ownsTarget(id)); }

  private readRows(sql: string, ...bind: string[]): Record<string, unknown>[] {
    const rows = this.readStores().flatMap(store => store.db.query(sql).all(...bind) as Record<string, unknown>[]);
    const unique = new Map<string, Record<string, unknown>>();
    for (const row of rows) unique.set(typeof row.id === "string" ? row.id : canonicalJSON(row), row);
    return [...unique.values()].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")) || String(a.id ?? "").localeCompare(String(b.id ?? "")));
  }

  private ownsTarget(id: string): boolean {
    this.ensureFresh();
    return !!this.db.query("SELECT id FROM entries WHERE id=? UNION SELECT id FROM goals WHERE id=? UNION SELECT id FROM ops WHERE id=?").get(id, id, id);
  }

  /**
   * Every live note with its derived state; an expired one is left out as soon as its deadline passes, before any
   * prune. Lifecycle relations still fold globally; SQL selects full rows before View/JSON materialization.
   * ponytail: lifecycle metadata is still scanned on every read; measure before adding a revision cache.
   */
  private views(expired = false, selection?: Filter & { ids?: string[] }, expiredOnly = false): View[] {
    // Metadata, ops and candidate bodies must describe one WAL snapshot, even if another process indexes a copy.
    const read = () => this.viewRows(expired, selection, expiredOnly);
    const nest = (stores: MemoryStore[]): View[] => stores.length ? stores[0]!.db.transaction(() => nest(stores.slice(1))).deferred() : read();
    return nest(this.readStores());
  }

  private viewRows(expired: boolean, selection: (Filter & { ids?: string[] }) | undefined, expiredOnly: boolean, projection?: RecallViewProjection): View[] {
    const now = projection?.now ?? this.now(), selecting = selection !== undefined || expiredOnly;
    const pruned = projection?.pruned ?? (this.generationIndex ? new Set((this.readRows("SELECT id FROM generation_targets") as { id: string }[]).map(row => row.id)) : undefined);
    if (!projection && this.generationIndex) this.generationIndex.pruned = new Set((this.db.query("SELECT id FROM generation_targets").all() as { id: string }[]).map(row => row.id));
    // Relations may cross projects and promoted copies: fold their small metadata globally, never filtered bodies.
    const rows = projection?.rows ?? this.readRows(selecting
      ? "SELECT id, at, tier, kind, task, expires, supersedes, promoted_from FROM entries"
      : "SELECT * FROM entries") as Record<string, string | null>[];
    const ops = projection?.ops ?? this.readRows("SELECT id, op, at, target, by FROM ops ORDER BY at, id") as { id: string; op: string; at: string; target: string; by: string | null }[];
    const realms = projection ? projection.realms : this.generationIndex ? new Map((this.readRows("SELECT id,own,legacy FROM generation_rows") as { id: string; own: number; legacy: number }[]).map(row => [row.id, row])) : undefined;
    const born = realms ? new Set([...realms.values()].filter(row => row.own).map(row => row.id)) : undefined;
    const forgotten = new Set([...ops.filter((o) => o.op === "forget").map((o) => o.target), ...(projection?.forgotten ?? [])]);
    // Deadlines were fixed when the entries were written, so every process (whatever its own TTL) prunes the same rows.
    const deadline = (o: { at: string; by: string | null }) => o.by && !Number.isNaN(Date.parse(o.by)) ? o.by : new Date(Date.parse(o.at) + this.ttl).toISOString();
    const demoted = new Map(ops.filter((o) => o.op === "demote").map((o) => [o.target, deadline(o)]));
    const settled = new Map<string, string>();
    const settlementKey = (id: string, task: string) => born ? `${born.has(id)}:${task}` : task;
    for (const o of ops) if (o.op === "settle") {
      const source = realms?.get(o.id);
      const keys = !realms ? [o.target] : [
        ...(source?.own ? [`true:${o.target}`] : []),
        ...(source?.legacy || !source?.own ? [`false:${o.target}`] : []),
      ];
      for (const key of keys) if (!settled.has(key)) settled.set(key, deadline(o));
    }
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
      const taskDeadline = r.task ? settled.get(settlementKey(id, r.task)) : undefined;
      if (r.tier === "short" && !demoted.has(id) && !r.expires && taskDeadline && PROMOTED_KINDS.includes(r.kind as Kind)) return null;
      // A deadline written into the note (no task, a late note, an explicit short horizon) is its own, whatever the task does.
      return demoted.get(id) ?? r.expires ?? (r.task ? taskDeadline ?? new Date(Date.parse(r.at!) + UNSETTLED_MS).toISOString() : new Date(Date.parse(r.at!) + this.ttl).toISOString());
    };
    // A newer entry that was forgotten, expired or pruned no longer replaces anything: the older one shows again. A
    // promoted source lives on as its copy.
    const byId = new Map(rows.map((r) => [r.id!, r]));
    const copyOf = new Map(rows.filter((r) => r.promoted_from).map((r) => [r.promoted_from!, r.id!]));
    const gone = (id: string): boolean => {
      if (pruned?.has(id)) return true;
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
    let candidates = rows;
    if (selecting) {
      const hidden: string[] = [], expiredIds: string[] = [];
      for (const r of rows) {
        const id = r.id!;
        if (pruned?.has(id) || forgotten.has(id) || (r.promoted_from && forgotten.has(r.promoted_from)) || promoted.has(id)) { hidden.push(id); continue; }
        const at = expiry(r);
        if (at !== null && Date.parse(at) <= now) expiredIds.push(id);
      }
      const where: string[] = [], bind: string[] = [];
      const ids = (values: Iterable<string>, exclude: boolean) => {
        const entries = [...values];
        if (entries.length || !exclude) { where.push(`id ${exclude ? "NOT IN" : "IN"} (SELECT value FROM json_each(?))`); bind.push(JSON.stringify(entries)); }
      };
      ids(hidden, true);
      if (expiredOnly) ids(expiredIds, false); else if (!expired) ids(expiredIds, true);
      if (selection) {
        if (selection.project) {
          // The exact-key form is unchanged unless a reconciled read widens it (#27).
          const keys = this.scopeKeys(selection.project);
          if (keys.length === 1) { where.push("(project = ? OR scope = 'shared')"); bind.push(selection.project); }
          else { where.push("(project IN (SELECT value FROM json_each(?)) OR scope = 'shared')"); bind.push(JSON.stringify(keys)); }
        }
        if (selection.ids) ids(selection.ids, false);
        if (selection.tier) {
          if (demoted.size) { where.push("CASE WHEN id IN (SELECT value FROM json_each(?)) THEN 'short' ELSE tier END = ?"); bind.push(JSON.stringify([...demoted.keys()]), selection.tier); }
          else { where.push("tier = ?"); bind.push(selection.tier); }
        }
        for (const key of ["kind", "peer", "machine"] as const) if (selection[key]) { where.push(`${key} = ?`); bind.push(selection[key]!); }
        if (!selection.includeSuperseded) ids(superseded.keys(), true);
      }
      // No SQL LIMIT: a host may screen the complete matching set before its own caps or visible counts.
      // Date parsing, Unicode query matching, locale order and slice semantics stay in JavaScript.
      candidates = this.readRows(`SELECT * FROM entries${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`, ...bind) as Record<string, string | null>[];
    }
    const out: View[] = [];
    for (const r of candidates) {
      const id = r.id!;
      // A forgotten entry is gone, and so is its promoted copy's source or copy: forgetting either forgets both.
      if (pruned?.has(id) || forgotten.has(id) || (r.promoted_from && forgotten.has(r.promoted_from)) || promoted.has(id) && !projection?.includePromoted) continue;
      const tier: Tier = demoted.has(id) ? "short" : r.tier as Tier;
      const expiresAt = expiry(r);
      if (!expired && expiresAt !== null && Date.parse(expiresAt) <= now) continue;
      out.push({ id, at: r.at!, machine: r.machine!, project: this.label(r.project!), scope: r.scope as Scope, tier, kind: r.kind as Kind, peer: r.peer!, title: r.title ?? null, text: r.text!,
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
    if (this.generationIndex) return 0; // Generation raw rows remain authoritative; only explicit durable prune masks them.
    const now = this.now();
    const expired = this.views(true, undefined, true).filter((v) => v.expiresAt !== null && Date.parse(v.expiresAt) <= now);
    // A copy that expires (it was demoted) takes its whole hidden promotion ancestry with it, or an ancestor would reappear.
    const parent = new Map((this.db.query("SELECT id, promoted_from FROM entries WHERE promoted_from IS NOT NULL").all() as { id: string; promoted_from: string }[]).map((r) => [r.id, r.promoted_from]));
    const gone = new Set<string>();
    for (const v of expired) for (let id: string | undefined = v.id; id && !gone.has(id); id = parent.get(id)) gone.add(id);
    if (!gone.size) return 0;
    this.db.transaction(() => { for (const id of gone) { this.db.query("DELETE FROM entries WHERE id = ?").run(id); this.db.query("DELETE FROM edges WHERE src = ?").run(id); } }).immediate();
    this.searchIndex.markDirty(); // FTS cannot subtract rows incrementally: the next search resyncs it
    return gone.size;
  }

  /** Index deferred writes before any note, goal or suggestion read. */
  private ensureFresh(): void {
    this.releaseReaderLease?.verify();
    this.userOverlay?.ensureFresh();
    for (const store of this.aliasStores) store.ensureFresh();
    if (this.generationIndex) { this.generationIndex.refresh(); return; }
    // Another process (a CLI, another project's hub, a sync) may have written since this one last read the segments.
    if (this.stale || this.shape() !== this.seen) try { this.stale = false; this.refresh(); } catch { this.stale = true; /* still busy: the next read tries again */ }
  }

  /**
   * What a read sees: rows that expired and promotions that became due while the store sat idle are settled first, so a
   * read, and the index after it, never differ from a rebuild.
   */
  private live(selection?: Filter): View[] {
    this.ensureFresh();
    this.prune(); this.userOverlay?.promoteHeld(); for (const store of this.aliasStores) store.promoteHeld(); this.promoteHeld(); return this.views(false, selection);
  }
  /** A write whose index update failed: the next read refreshes first. */
  private stale = false;

  /** Entries visible from `project` (its own, and `shared` ones of any project), newest first, filtered. */
  list(f: Filter = {}): View[] {
    const q = f.q?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    return this.live(f).filter((v) => (!f.project || this.inScope(v.project, f.project) || v.scope === "shared") && (!f.tier || v.tier === f.tier) && (!f.kind || v.kind === f.kind)
      && (!f.peer || v.peer === f.peer) && (!f.machine || v.machine === f.machine) && (!f.since || Date.parse(v.at) >= Date.parse(f.since)) && (f.includeSuperseded || !v.supersededBy)
      && q.every((w) => `${v.title ?? ""}\n${v.text}\n${v.about.join(" ")}`.toLowerCase().includes(w)))
      .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, f.limit ?? 200);
  }

  /** The verified authored log rows behind the current export selection, including legacy absent/null optional fields. */
  portableNotes(project: string): NoteEntry[] {
    const selected = this.list({ project, limit: Number.MAX_SAFE_INTEGER, includeSuperseded: true });
    const wanted = new Set(selected.map(view => view.id)), authored = new Map<string, NoteEntry>();
    for (const store of this.readStores()) {
      const rows = store.generationIndex ? store.generationIndex.snapshot(false).rows.map(item => item.row) : legacyEntries(readLegacySnapshot(store.dir));
      for (const row of rows) if (row.op === "note" && wanted.has(row.id) && !authored.has(row.id)) authored.set(row.id, row);
    }
    return selected.map(view => {
      const row = authored.get(view.id);
      if (!row) throw new Error("exported note's authored row is unavailable");
      return row;
    });
  }

  /** Exact-project body pages for policy-aware callers. Relations still fold over complete metadata. */
  readPage(window: ReadWindow & { query?: string; includeSuperseded?: boolean }): { rows: View[]; next?: ReadRef } {
    this.ensureFresh(); this.prune();
    const refs: ReadRef[] = [];
    for (const store of this.readStores()) {
      if (window.query !== undefined && store.searchIndex.available) {
        store.syncSearchIndex(); refs.push(...store.searchIndex.candidates(window.query, this.reconcile ? { ...window, projects: this.scopeKeys(window.project) } : window));
      } else {
        const { columns, where, bind } = readWindowSql(this.reconcile ? { ...window, projects: this.scopeKeys(window.project) } : window, "id");
        refs.push(...(store.db.query(`SELECT ${columns} FROM entries WHERE ${where.join(" AND ")} ORDER BY candidate_position, candidate_id LIMIT ?`)
          .all(...bind, window.limit) as { candidate_id: string; at: string; candidate_position: number }[]).map(readRef));
      }
    }
    const page = [...new Map(refs.map(ref => [ref.id, ref])).values()].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, window.limit);
    if (!page.length) return { rows: [] };
    const views = new Map(this.views(false, { project: window.project, ids: page.map(ref => ref.id), includeSuperseded: window.includeSuperseded })
      .filter(view => view.project === window.project && (window.includeSuperseded || !view.supersededBy)).map(view => [view.id, view]));
    return { rows: page.flatMap(ref => views.get(ref.id) ?? []), next: page[page.length - 1] };
  }

  /**
   * #13 R5: natural-language search over the curated tier and this machine's capture tier, ranked by BM25 with
   * tier and recency weights (curated outranks capture; a newer row beats an older one at equal text). Visibility
   * (forgotten, superseded, expired, pruned) is decided by the same live views `list` uses. Without FTS5 the engine
   * falls back to the substring filter and says so; capture recall needs FTS5 and is skipped in the fallback (the
   * R3 cost of the fallback is the pre-#13 behavior: same scan, same memory).
   */
  search(q: string, f: SearchFilter = {}): SearchResult {
    const limit = f.limit ?? 200;
    if (!this.searchIndex.available) return { engine: "substring", hits: this.list({ ...f, q }).map(view => {
      const hit: SearchHit = { source: "curated", score: 0, view };
      if (f.explain) hit.scoreDetails = unrankedScoreDetails("curated", hit.score);
      return hit;
    }) };
    const visible = new Map(this.live(f).filter((v) => (!f.project || this.inScope(v.project, f.project) || v.scope === "shared")
      && (!f.since || Date.parse(v.at) >= Date.parse(f.since)) && (f.includeSuperseded || !v.supersededBy)).map((v) => [v.id, v]));
    for (const store of this.readStores()) store.syncSearchIndex();
    const now = this.now();
    const hits: SearchHit[] = [];
    // The project filter runs inside the FTS query (its rows plus shared ones), so a busy sibling project can never
    // starve this project's LIMIT.
    // Superseded, forgotten, expired and `since` rows are filtered after FTS, so a fixed candidate cap could be filled
    // by invisible rows and hide a visible match: widen the cap until `limit` visible hits or the index is exhausted.
    // Pages of fixed size, so memory stays one page plus the hits (#13 R3) however many invisible rows rank first.
    // ponytail: with almost nothing visible (a selective `since`, many superseded or forgotten rows) the pages walk the
    // store's whole match set; push `since` into SearchIndex.query (docs carries `at`) if that time shows up.
    const page = Math.max(limit * 4, 32);
    for (const store of visible.size ? this.readStores() : []) {
      let found = 0;
      const seen = new Set<string>(); // another process's sync between pages can shift offsets and repeat a ref
      for (let offset = 0; found < limit; offset += page) {
        const ranked = store.searchIndex.query(q, page, f.project === undefined ? undefined : this.scopeKeys(f.project), offset);
        for (const hit of ranked) {
          const view = visible.get(hit.ref);
          if (!view || seen.has(hit.ref)) continue;
          seen.add(hit.ref);
          found++;
          const selected: SearchHit = { source: "curated", score: rankedScore(hit.rank, view.tier, hit.at, now), view };
          if (f.explain) selected.scoreDetails = rankedScoreDetails("curated", hit.rank, view.tier, hit.at, now, selected.score);
          hits.push(selected);
        }
        if (ranked.length < page) break;
      }
    }
    // #15 D4/T1: the capture tier is project-scoped; without a project key there is no shard to recall from.
    if (f.includeCapture !== false && f.project) {
      const shard = shardMachineDir(this.memoryBaseDir, resolveAlias(this.memoryBaseDir, f.project), this.machine.id);
      // The retention cutoff and `since` run in the capture query, so neither expired nor old rows take a candidate slot.
      // An out-of-range retention_days gives no cutoff rather than failing the whole search (eviction keeps its own check).
      const override = f.captureRetentionDays, days = typeof override === "number" && Number.isFinite(override) && override > 0 ? override : readCaptureConfig(shard, this.memoryBaseDir).retentionDays;
      const cutoff = new Date(now - days * 24 * 3600_000);
      const retained = Number.isFinite(cutoff.getTime()) ? cutoff.toISOString() : undefined;
      const since = f.since && Number.isFinite(Date.parse(f.since)) ? new Date(Date.parse(f.since)).toISOString() : undefined;
      for (const { row, rank } of captureSearch(shard, q, Math.max(limit * 4, 32), since && (!retained || since > retained) ? since : retained)) {
        const selected: SearchHit = { source: "capture", score: rankedScore(rank, "capture", row.at, now), capture: row };
        if (f.explain) selected.scoreDetails = rankedScoreDetails("capture", rank, "capture", row.at, now, selected.score);
        hits.push(selected);
      }
    }
    // Where FTS misses entirely (a stopword-only query, a tokenization edge), the substring filter is the safety net.
    if (!hits.length && q.trim()) {
      for (const view of this.list({ ...f, q })) {
        const hit: SearchHit = { source: "curated", score: 0, view };
        if (f.explain) hit.scoreDetails = unrankedScoreDetails("curated", hit.score);
        hits.push(hit);
      }
    }
    const ref = (h: SearchHit): string => h.view?.id ?? String(h.capture?.id ?? 0).padStart(12, "0");
    hits.sort((a, b) => b.score - a.score || ref(a).localeCompare(ref(b)));
    return { engine: "fts5", hits: hits.slice(0, limit) };
  }

  /** Bring the derived FTS copy level with the curated rows when a prune, a crash, a lock or a rebuild drifted them apart. */
  private syncSearchIndex(): void {
    if (!this.searchIndex.available) return;
    const curated = (this.db.query("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
    if (!this.searchIndex.needsResync(curated)) return;
    const db = this.db;
    this.searchIndex.resync(function* () {
      for (const r of db.query("SELECT id, at, project, tier, scope, title, text, about FROM entries").iterate() as Iterable<{ id: string; at: string; project: string; tier: string; scope: string; title: string | null; text: string; about: string }>) {
        yield { id: r.id, at: r.at, project: r.project, tier: r.tier, scope: r.scope, body: `${r.title ?? ""}\n${r.text}\n${(JSON.parse(r.about) as string[]).join(" ")}` };
      }
    });
  }

  /** Metadata-only revision of the opened read set, never a note body or an unopened project shard. */
  recallRevision(): string { return this.recallFingerprint(true); }
  private recallFingerprint(databases: boolean): string {
    const entries: unknown[] = [];
    const stamp = (file: string, directory = false) => {
      try {
        const stat = lstatSync(file, { bigint: true });
        if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw Error("recall input path unavailable");
        entries.push([file, String(stat.dev), String(stat.ino), ...(directory ? [] : [String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)])]);
        return true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { entries.push([file, "absent"]); return false; } throw error; }
    };
    const roots = new Set<string>(), fixed = new Set<string>();
    for (const store of this.readStores()) {
      roots.add(store.dir);
      for (const name of ["profile.json", "shards.json", "aliases.jsonl", "lifecycle.jsonl", "machine.json"]) fixed.add(join(store.profile.home, name));
      for (const name of ["generation.json", "generation-seal.json", "migration-sources.json", "machine.json"]) fixed.add(join(store.dir, name));
      if (store.generationIndex) {
        const legacy = store.profile.legacyHome ?? store.profile.home; roots.add(legacy);
        if (store.profile.legacyMainHome) roots.add(store.profile.legacyMainHome);
        if (!store.profile.sharded && store.profile.generation) {
          const dir = generationDir(legacy, store.profile.generation), pointer = join(dir, "bridge-snapshot.json"); fixed.add(pointer);
          // Only the small sealed pointer is parsed to locate its active archive; JSONL bodies are never read here.
          const head = readProfileJSON(pointer, 4096) as { commit?: unknown } | undefined;
          if (head !== undefined) {
            if (typeof head.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(head.commit)) throw Error("recall bridge pointer unavailable");
            const archive = join(dir, "bridge-snapshots", head.commit); roots.add(archive); fixed.add(join(archive, "snapshot.json"));
          }
        }
      }
      if (databases) entries.push([store.dir, store.db.query("PRAGMA data_version").get(), store.db.query("SELECT total_changes() AS n").get()]);
    }
    for (const root of [...roots].sort()) {
      if (!stamp(root, true)) continue;
      fixed.add(join(root, "machine.json"));
      for (const folder of ["log", "local"]) {
        const dir = join(root, folder); if (!stamp(dir, true)) continue;
        for (const name of readdirSync(dir).filter(name => name.endsWith(".jsonl")).sort()) stamp(join(dir, name));
      }
    }
    for (const file of [...fixed].sort()) stamp(file);
    return hashJSON(entries);
  }
  private prepareRecallRead(stores: readonly MemoryStore[]): void {
    for (const store of stores) {
      const active = readSelector(store.profile.home);
      if (active.revision !== store.profile.selectorRevision) throw Error("recall profile changed");
      if (store.profile.sharded) {
        const selected = readShardedSelection(store.profile.home);
        if (selected.generation !== store.profile.generation || selected.selectorRevision !== store.profile.selectorRevision) throw Error("recall shard binding changed");
      } else if ((readProfileJSON(join(store.profile.home, "shards.json")) as { phase?: unknown } | undefined)?.phase === "active"
        || (active.selector?.kind ?? "shared-v1") !== store.profile.kind || store.profile.kind === "generation" && active.selector?.generation !== store.profile.generation) throw Error("recall profile changed");
      if (store.reconcile && (resolveAlias(store.profile.home, store.reconcile.canonical) !== store.reconcile.canonical || canonicalJSON(aliasedKeys(store.profile.home, store.reconcile.canonical).sort()) !== canonicalJSON([...store.reconcile.aliases].sort()))) throw Error("recall alias binding changed");
      if (store.generationIndex) store.generationIndex.refresh();
      else if (store.stale || store.shape() !== store.seen) {
        store.stale = false; store.refresh();
        if (store.stale || store.shape() !== store.seen) throw Error("recall refresh unavailable");
      }
    }
  }
  /** Strict preparation once; callers release the fences before awaiting policy or optional overlays. */
  beginRecallRead(): () => void {
    return this.withStoreFences(stores => {
      const before = this.recallFingerprint(false);
      this.prepareRecallRead(stores);
      for (const store of stores) store.prune(); // readPage performs this too; settle its derived writes before the revision.
      const captured = this.recallRevision();
      if (this.recallFingerprint(false) !== before) throw Error("recall inputs changed during preparation");
      return () => { if (this.recallRevision() !== captured) throw Error("recall inputs changed"); };
    });
  }
  /** One lifecycle fold for a bounded exact-project set of useful intent-brief genres. */
  intentSnapshot(project: string, limit = 5000): { rows: View[]; truncated: boolean; assertCurrent(): void } {
    if (!project.trim() || project.length > 400 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000 || this.profile.sharded && !this.profile.shardUser && this.profile.shardKey !== project) throw Error("invalid intent snapshot scope or limit");
    return this.withStoreFences(stores => {
      const before = this.recallFingerprint(false);
      assertProjectActive(this.profile.home, project); this.prepareRecallRead(stores);
      const revision = this.recallRevision(), ids = new Map<string, { id: string; at: string }>();
      if (this.recallFingerprint(false) !== before) throw Error("recall inputs changed during preparation");
      for (const store of stores) {
        const rows = store.db.query("SELECT id,at FROM entries WHERE project IN (SELECT value FROM json_each(?)) AND kind IN ('fail','decision','contract') ORDER BY at DESC,id LIMIT ?").all(JSON.stringify(this.scopeKeys(project)), limit + 1) as { id: string; at: string }[];
        for (const row of rows) ids.set(row.id, row);
      }
      const refs = [...ids.values()].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)), selected = refs.slice(0, limit);
      const rows = selected.length ? this.views(false, { project, ids: selected.map(row => row.id) }).filter(view => view.project === project && !view.supersededBy && Number.isFinite(Date.parse(view.at))) : [];
      const order = new Map(selected.map((row, index) => [row.id, index])); rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      const assertCurrent = () => { if (this.recallRevision() !== revision) throw Error("recall inputs changed"); };
      assertCurrent(); return { rows, truncated: refs.length > limit, assertCurrent };
    });
  }

  /** The same injected clock used by validity, expiry and projection; callers must not substitute wall time. */
  readNow(): number { return this.now(); }

  /** Person historical recall over verified retained rows. Current removals always override past state. */
  recallState(project: string, options: RecallStateOptions = {}): RetainedRecallState {
    if ((options.history || options.asOf !== undefined) && options.person !== true) throw Error("historical recall requires authenticated person intent from the host");
    if (!project.trim() || project.length > 400 || this.profile.sharded && !this.profile.shardUser && this.profile.shardKey !== project) throw Error("recall project does not match the bound store");
    const maximumRows = options.maxRows ?? 50_000, maximumBytes = options.maxBytes ?? 32 * 1024 * 1024, present = this.now();
    if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 50_000 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 32 * 1024 * 1024) throw Error("invalid retained recall budget");
    let time = present;
    if (options.asOf !== undefined) {
      const value = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(options.asOf) ? `${options.asOf}T00:00:00.000Z` : options.asOf;
      time = Date.parse(value);
      if (!Number.isFinite(time) || new Date(time).toISOString() !== value || time > present) throw Error("as-of must be a past canonical UTC date or timestamp");
    }
    const frontier = () => {
      const active = readSelector(this.profile.home);
      if (active.revision !== this.profile.selectorRevision) throw Error("recall profile changed or is not active");
      if (this.profile.sharded) {
        const shards = readShardedSelection(this.profile.home);
        if (shards.generation !== this.profile.generation || shards.selectorRevision !== this.profile.selectorRevision) throw Error("recall shard binding changed");
      } else if ((readProfileJSON(join(this.profile.home, "shards.json")) as { phase?: unknown } | undefined)?.phase === "active"
        || (active.selector?.kind ?? "shared-v1") !== this.profile.kind || this.profile.kind === "generation" && active.selector?.generation !== this.profile.generation) throw Error("recall profile changed or is not active");
      assertProjectActive(this.profile.home, project);
    };
    return this.withStoreFences(() => {
      frontier();
      const source = new Map<string, Entry>(), realm = new Map<string, { id: string; own: number; legacy: number }>(), pruned = new Set<string>();
      const reader = new SegmentReader(maximumBytes); let records = 0, bytes = 0, malformed = 0, incomplete = false;
      const add = (row: Entry, own: boolean, legacy: boolean) => {
        const { id, ...body } = row;
        if (row.schema !== MEMORY_SCHEMA || !/^[a-f0-9]{32}$/.test(id) || entryId(body as Omit<Entry, "id">) !== id) throw Error("retained recall row verification failed");
        const canonical = canonicalJSON(row); records++; bytes += Buffer.byteLength(canonical);
        if (records > maximumRows || bytes > maximumBytes) throw Error("retained recall budget exceeded");
        const previous = source.get(id); if (previous && canonicalJSON(previous) !== canonical) throw Error("retained recall identity conflict");
        source.set(id, row); realm.set(id, { id, own: Number(own), legacy: Number(legacy) });
      };
      // Same bound read handles as ordinary views. Never opens an unopened project's private shard.
      for (const store of this.readStores()) {
        if (store.generationIndex) {
          store.generationIndex.refresh(0, reader);
          store.db.transaction(() => {
            const size = store.db.query("SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(line AS BLOB))),0) AS bytes FROM generation_rows").get() as { n: number; bytes: number };
            if (size.n > maximumRows - records || size.bytes > maximumBytes - bytes) throw Error("retained recall budget exceeded");
            const diagnostics = store.generationIndex!.recallDiagnostics(); malformed += diagnostics.malformed; incomplete ||= diagnostics.incomplete;
            const state = store.generationIndex!.snapshot(false);
            for (const item of state.rows) add(item.row, item.own === true, item.legacy ?? item.own !== true);
            for (const id of state.pruned ?? []) pruned.add(id);
          }).deferred();
        } else {
          const segments = readLegacySnapshot(store.dir, { reader });
          incomplete ||= segments.some(segment => segment.tailBytes > 0);
          for (const row of legacyEntries(segments, { onMalformed: () => { malformed++; } })) add(row, false, true);
        }
      }
      frontier();
      const all = [...source.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      const notes = all.filter((row): row is NoteEntry => row.op === "note");
      const removed = new Set(pruned), forgottenAt = new Map<string, string>();
      for (const row of all) if (row.op === "forget") { removed.add(row.target); if (!forgottenAt.has(row.target)) forgottenAt.set(row.target, row.at); }
      // Forgetting either end removes known promotion ancestry, in linear bounded graph work.
      const ancestry = new Map<string, string[]>();
      for (const note of notes) if (note.promotedFrom) {
        ancestry.set(note.id, [...ancestry.get(note.id) ?? [], note.promotedFrom]);
        ancestry.set(note.promotedFrom, [...ancestry.get(note.promotedFrom) ?? [], note.id]);
      }
      const queue = [...removed];
      for (let index = 0; index < queue.length; index++) {
        const id = queue[index]!, at = forgottenAt.get(id);
        for (const next of ancestry.get(id) ?? []) {
          const fresh = !removed.has(next);
          if (fresh) { removed.add(next); queue.push(next); }
          if (at && !forgottenAt.has(next)) { forgottenAt.set(next, at); if (!fresh) queue.push(next); }
        }
      }
      const visible = (note: NoteEntry) => this.inScope(note.project, project) || note.scope === "shared";
      const dated = notes.filter(note => options.asOf === undefined || Date.parse(note.at) <= time), retained = new Map(dated.filter(visible).map(note => [note.id, note]));
      const rows = dated.map(note => ({ id: note.id, at: note.at, machine: note.machine, project: note.project, scope: note.scope, tier: note.tier, kind: note.kind, peer: note.peer, title: note.title ?? null, text: note.text,
        task: note.task ?? null, about: JSON.stringify(note.about), source: note.source ?? "hub", supersedes: note.supersedes ?? null, promoted_from: note.promotedFrom ?? null, expires: note.expires ?? null }));
      const ops = all.filter((row): row is OpEntry => row.op !== "note" && row.op !== "goal" && (options.asOf === undefined || Date.parse(row.at) <= time)).map(row => ({ id: row.id, op: row.op, at: row.at, target: row.target, by: row.by ?? null }));
      const views = this.viewRows(options.history === true, undefined, false, { now: time, rows, ops, ...(this.generationIndex ? { realms: realm } : {}), pruned, forgotten: removed, includePromoted: options.history === true })
        .filter(view => (this.inScope(view.project, project) || view.scope === "shared") && (options.history === true || !view.supersededBy));
      const forgotten = [...forgottenAt].flatMap(([id, at]) => retained.has(id) ? [{ id, at }] : []).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      const relations: RecallRelation[] = [];
      const link = (from: string, to: string, at: string, kind: RecallRelation["kind"]) => { if (retained.has(from) && retained.has(to) && !pruned.has(from) && !pruned.has(to)) relations.push({ from, to, at, kind }); };
      for (const note of dated) { if (note.supersedes) link(note.supersedes, note.id, note.at, "supersede"); if (note.promotedFrom) link(note.promotedFrom, note.id, note.at, "promote"); }
      for (const op of ops) if (op.op === "supersede" && op.by) link(op.target, op.by, op.at, "supersede");
      const notices = (options.asOf !== undefined || options.history === true) && views.some(view => view.promotedFrom)
        ? ["promotion time unknown: tier before promotion cannot be recovered"] : [];
      frontier();
      return { at: new Date(time).toISOString(), views, forgotten, relations, malformed, notices, incomplete: incomplete || malformed > 0 || notices.length > 0, ...(incomplete || malformed > 0 ? { sourceIncomplete: true as const } : {}) };
    });
  }

  /** One entry by id or unique id prefix; with `project`, only one that project may read (its own or shared). */
  get(id: string, project?: string): View | undefined {
    id = id.replace(/^mem:/, ""); // briefs and recall print `mem:<id>`
    const all = this.live().filter((v) => !project || this.inScope(v.project, project) || v.scope === "shared");
    const pick = <T extends { id: string }>(rows: T[]) => rows.find((v) => v.id === id) ?? (id.length >= 6 ? (() => { const m = rows.filter((v) => v.id.startsWith(id)); return m.length === 1 ? m[0] : undefined; })() : undefined);
    if (this.generationIndex?.pruned.has(id)) return undefined;
    const found = pick(all);
    if (found) return found;
    // A short-term id an agent kept after its task was approved names the promoted copy now, here or on another machine
    // that has only the synced copy (which names its source).
    let at = pick(this.readRows("SELECT id FROM entries UNION SELECT promoted_from AS id FROM entries WHERE promoted_from IS NOT NULL") as { id: string }[])?.id;
    for (let copy = at; copy; copy = (this.readRows("SELECT id FROM entries WHERE promoted_from = ?", copy)[0] as { id: string } | undefined)?.id) { if (this.generationIndex?.pruned.has(copy)) return undefined; at = copy; }
    return at ? all.find((v) => v.id === at) : undefined;
  }

  /**
   * Entries one or two hops from the given nodes (hop one: about one of them; hop two: about a node a hop-one entry is
   * about), visible from `project`. Fails first, then nearer, then newer; superseded entries are dropped.
   */
  related(project: string, nodes: Node[], limit: number): (View & { hops: 1 | 2 })[] {
    if (!nodes.length) return [];
    // A task that is part of a long-term task brings the goal's other tasks along, so its decisions and fails are near.
    const taskNode = (key: string) => `task:${key}`; // a link's task key is the task node's own (id and proposal time)
    const goals = this.goals(project).filter((g) => g.links.some((l) => nodes.includes(taskNode(l.task))));
    nodes = [...new Set([...nodes, ...goals.flatMap((g) => g.links.map((l) => taskNode(l.task)))])];
    const live = new Map(this.list({ project, limit: Number.MAX_SAFE_INTEGER }).map((v) => [v.id, v]));
    const near = new Map<string, 1 | 2>();
    const about = (ns: Iterable<Node>) => {
      const ids = new Set<string>();
      for (const n of ns) for (const r of this.readRows("SELECT src FROM edges WHERE dst = ?", n) as { src: string }[]) if (live.has(r.src)) ids.add(r.src);
      return ids;
    };
    const first = about(nodes);
    for (const id of first) near.set(id, 1);
    for (const id of about(new Set([...first].flatMap((id) => live.get(id)!.about)))) if (!near.has(id)) near.set(id, 2);
    // Only a person-confirmed suggestion links two entries for retrieval; an unconfirmed one is never evidence.
    for (const s of this.suggestions().filter((x) => x.status === "confirmed")) {
      if (first.has(s.from) && live.has(s.to) && !near.has(s.to)) near.set(s.to, 2);
      if (first.has(s.to) && live.has(s.from) && !near.has(s.from)) near.set(s.from, 2);
    }
    return [...near].map(([id, hops]) => ({ ...live.get(id)!, hops }))
      .sort((a, b) => Number(b.kind === "fail") - Number(a.kind === "fail") || a.hops - b.hops || b.at.localeCompare(a.at)).slice(0, limit);
  }

  /** The neighbourhood of one node for the dashboard: up to `hops` (1 or 2) steps, at most `cap` nodes. */
  graph(project: string, start: Node, hops = 1, cap = 200, projection?: readonly View[]): Graph {
    this.ensureFresh();
    if (start.startsWith("mem:") && this.generationIndex?.pruned.has(start.slice(4))) return { nodes: [], edges: [] };
    const live = new Map((projection ?? this.list({ project, limit: Number.MAX_SAFE_INTEGER, includeSuperseded: true })).map((v) => [`mem:${v.id}`, v]));
    const nodes = new Map<Node, Graph["nodes"][number]>(), edges = new Map<string, Graph["edges"][number]>();
    const goals = new Map(this.goals(project).map((g) => [`goal:${g.id}`, g]));
    const suggestions = this.suggestions().filter((x) => x.status !== "rejected");
    const taskNode = (key: string) => `task:${key}`; // a link's task key is the task node's own (id and proposal time)
    const node = (id: Node) => {
      if (id.startsWith("mem:") && this.generationIndex?.pruned.has(id.slice(4))) return false;
      if (nodes.has(id) || nodes.size >= cap) return nodes.has(id);
      const v = live.get(id), g = goals.get(id);
      nodes.set(id, v ? { id, type: "memory", label: (v.title ?? v.text).slice(0, 60), kind: v.kind, tier: v.tier } : g ? { id, type: "goal", label: g.title.slice(0, 60), kind: g.state } : { id, type: id.slice(0, id.indexOf(":")), label: id.slice(id.indexOf(":") + 1) });
      return true;
    };
    const link = (from: Node, to: Node, rel: string) => { if (node(from) && node(to)) edges.set(`${from}\0${to}\0${rel}`, { from, to, rel }); };
    /** A memory node's own edges: what it is about, who wrote it, where, and what it supersedes. */
    const expand = (id: Node): Node[] => {
      const v = live.get(id);
      if (v) {
        const out: Node[] = [];
        for (const n of v.about) { link(id, n, v.kind === "fail" ? "rules_out" : "about"); out.push(n); }
        for (const s of suggestions) {
          const other = s.from === v.id ? s.to : s.to === v.id ? s.from : undefined;
          if (!other || !live.has(`mem:${other}`)) continue;
          link(`mem:${s.from}`, `mem:${s.to}`, s.status === "confirmed" ? s.rel : `suggested ${s.rel}`); out.push(`mem:${other}`);
        }
        link(id, `peer:${v.peer}`, "by"); link(id, `machine:${v.machine}`, "by"); link(id, `project:${v.project}`, "in");
        out.push(`peer:${v.peer}`, `machine:${v.machine}`, `project:${v.project}`); // a second hop reaches their other entries
        if (v.supersededBy && live.has(`mem:${v.supersededBy}`)) { link(`mem:${v.supersededBy}`, id, "supersedes"); out.push(`mem:${v.supersededBy}`); }
        for (const old of v.supersedes) if (live.has(`mem:${old}`)) { link(id, `mem:${old}`, "supersedes"); out.push(`mem:${old}`); }
        return out;
      }
      const g = goals.get(id);
      if (g) {
        const out = g.links.map((l) => taskNode(l.task));
        for (const t of out) link(t, id, "part_of");
        for (const d of g.dependsOn) if (goals.has(`goal:${d}`)) { link(id, `goal:${d}`, "depends_on"); out.push(`goal:${d}`); }
        return out;
      }
      const parts = id.startsWith("task:") ? [...goals.values()].filter((x) => x.links.some((l) => taskNode(l.task) === id)).map((x) => `goal:${x.id}`) : [];
      for (const p of parts) link(id, p, "part_of");
      // Provenance nodes keep their own relation: who wrote it and on which machine (`by`), in which project (`in`).
      const field = id.startsWith("peer:") ? (x: View) => `peer:${x.peer}` : id.startsWith("machine:") ? (x: View) => `machine:${x.machine}` : id.startsWith("project:") ? (x: View) => `project:${x.project}` : undefined;
      if (field) {
        const ids = [...live.values()].filter((x) => field(x) === id).map((x) => `mem:${x.id}`);
        for (const m of ids) link(m, id, id.startsWith("project:") ? "in" : "by");
        return ids;
      }
      const ids = (this.db.query("SELECT src FROM edges WHERE dst = ?").all(id) as { src: string }[]).map((r) => `mem:${r.src}`).filter((m) => live.has(m));
      // Retained expired rows may no longer have derived edges; only their verified authored about nodes supply them.
      if (projection) for (const view of projection) if (view.about.includes(id) && !ids.includes(`mem:${view.id}`)) ids.push(`mem:${view.id}`);
      for (const m of ids) { const v2 = live.get(m)!; link(m, id, v2.kind === "fail" ? "rules_out" : "about"); }
      return [...ids, ...parts];
    };
    node(start);
    let frontier: Node[] = [start];
    for (let h = 0; h < Math.min(2, Math.max(1, hops)); h++) frontier = [...new Set(frontier.flatMap(expand))].filter((n) => n !== start);
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  /** A new long-term task; it lives in the synced log. Returns its id. */
  goal(g: Omit<GoalInput, "op">): string { return this.append({ op: "goal", ...g, title: oneLine(g.title), milestones: g.milestones.map(oneLine).slice(0, 32) }, false); }
  goalState(id: string, state: GoalState, actor: string): void { this.append({ op: "goal_state", target: id, by: state, actor }, false); }
  /** A board task (`<project>#<id>@<created>`) becomes part of the goal. */
  goalLink(id: string, task: string, actor: string): void { if (!this.goals().find((g) => g.id === id)?.links.some((l) => l.task === task)) this.append({ op: "goal_link", target: id, by: task, actor }, false); }

  /**
   * Claim the goal's lease for this machine until now + `ms`. Refused while another machine's lease is active, unless
   * `force` (a person's takeover), which voids every earlier claim. ponytail: advisory, eventually consistent through
   * sync, no consensus: two claims inside one sync window both stand and show as a conflict, the earlier one holding
   * until a person settles it; a broker would make it a real lock if concurrent cross-machine work needs one.
   */
  take(id: string, actor: string, opts: { force?: boolean; ms?: number } = {}): { ok: true; until: string } | { ok: false; holder: string; until: string } {
    const g = this.goals().find((x) => x.id === id);
    if (!g) throw new Error(`no long-term task ${id}`);
    if (!opts.force && g.lease.holder && g.lease.holder !== this.machine.id) return { ok: false, holder: g.lease.holder, until: g.lease.until! };
    const until = new Date(this.now() + (opts.ms ?? DEFAULT_LEASE_MS)).toISOString();
    this.append({ op: opts.force ? "lease_force" : "lease", target: g.id, by: until, actor }, false);
    return { ok: true, until };
  }

  /** Every long-term task with its derived state, links and lease, newest first; `project` keeps its own and shared ones. */
  goals(project?: string): GoalView[] {
    this.ensureFresh();
    const now = this.now();
    const rows = this.readRows("SELECT * FROM goals") as { id: string; at: string; machine: string; project: string; scope: string; title: string; milestones: string; depends: string }[];
    const ops = this.readRows("SELECT id, op, at, machine, target, by FROM ops WHERE op IN ('goal_state', 'goal_link', 'lease', 'lease_force') ORDER BY at, id") as { op: string; at: string; machine: string; target: string; by: string | null }[];
    return rows.filter((r) => !project || this.inScope(r.project, project) || r.scope === "shared").map((r): GoalView => {
      const mine = ops.filter((o) => o.target === r.id);
      const states = mine.filter((o) => o.op === "goal_state" && (GOAL_STATES as readonly string[]).includes(o.by ?? ""));
      const links = mine.filter((o) => o.op === "goal_link" && o.by).map((o) => ({ task: o.by!, at: o.at, machine: o.machine }));
      // Claims after the last forced one, latest per machine; active ones hold.
      const claims = mine.filter((o) => o.op === "lease" || o.op === "lease_force");
      const fresh = claims.slice(Math.max(0, claims.map((o) => o.op).lastIndexOf("lease_force")));
      // Precedence goes by when each machine's current lease began: a claim made after its own previous one expired
      // starts a new lease, so an old, lapsed claim never puts a machine ahead of one that took the task over since.
      const first = new Map<string, string>(), latest = new Map<string, string>();
      for (const o of fresh) {
        const until = latest.get(o.machine);
        if (until === undefined || Date.parse(until) <= Date.parse(o.at)) first.set(o.machine, o.at);
        latest.set(o.machine, o.by ?? o.at);
      }
      const active = [...latest].filter(([, until]) => Date.parse(until) > now).sort((a, b) => first.get(a[0])!.localeCompare(first.get(b[0])!) || a[0].localeCompare(b[0]));
      const last = fresh.at(-1);
      // One line whatever another machine wrote: titles are rendered into agents' context.
      return { id: r.id, at: r.at, machine: r.machine, project: this.label(r.project), scope: r.scope as Scope, title: oneLine(r.title), milestones: (JSON.parse(r.milestones) as string[]).map(oneLine), dependsOn: JSON.parse(r.depends),
        state: (states.at(-1)?.by as GoalState | undefined) ?? "open", links,
        lease: active.length ? { holder: active[0]![0], until: active[0]![1], conflict: active.slice(1).map(([m]) => m), expired: false }
          : { holder: null, until: last?.by ?? null, conflict: [], expired: !!last, lastHolder: last?.machine ?? null } };
    }).sort((a, b) => b.at.localeCompare(a.at));
  }
  goalOf(id: string, project?: string): GoalView | undefined {
    const all = this.goals(project);
    return all.find((g) => g.id === id) ?? (id.length >= 6 ? (() => { const m = all.filter((g) => g.id.startsWith(id)); return m.length === 1 ? m[0] : undefined; })() : undefined);
  }
  /** The goals a board task is part of. */
  goalsOfTask(task: string): GoalView[] { return this.goals().filter((g) => g.links.some((l) => l.task === task)); }

  /**
   * A model-suggested edge between two entries (#258 phase 3): stored as the hub model's suggestion, drawn dashed, and
   * never evidence (briefs, recall, `ahub ask`) until a person confirms it.
   */
  suggest(from: string, to: string, rel: Suggested): string | undefined {
    if (from === to || !SUGGESTED.includes(rel) || this.suggestions().some((x) => x.from === from && x.to === to && x.rel === rel)) return undefined;
    return this.append({ op: "suggest", target: from, by: `${rel}:${to}`, actor: "hub-model" }, false);
  }
  /** A person's verdict on a suggestion; with `project`, only one whose two entries that project may read. */
  judge(id: string, verdict: "confirm" | "reject", actor: string, project?: string): Suggestion | undefined {
    const s = this.suggestions(project).find((x) => x.id === id || (id.length >= 6 && x.id.startsWith(id)));
    if (s) this.append({ op: verdict, target: s.id, actor }, false);
    return s;
  }
  suggestions(project?: string): Suggestion[] {
    this.ensureFresh();
    const visible = project ? new Set(this.list({ project, limit: Number.MAX_SAFE_INTEGER, includeSuperseded: true }).map((v) => v.id)) : undefined;
    const ops = this.readRows("SELECT id, op, at, target, by FROM ops WHERE op IN ('suggest', 'confirm', 'reject') ORDER BY at, id") as { id: string; op: string; at: string; target: string; by: string | null }[];
    const verdict = new Map<string, "confirmed" | "rejected">();
    for (const o of ops) if (o.op !== "suggest") verdict.set(o.target, o.op === "confirm" ? "confirmed" : "rejected");
    return ops.filter((o) => o.op === "suggest" && o.by).flatMap((o) => {
      const [rel, to] = [o.by!.slice(0, o.by!.indexOf(":")), o.by!.slice(o.by!.indexOf(":") + 1)];
      if (visible && (!visible.has(o.target) || !visible.has(to))) return [];
      return SUGGESTED.includes(rel as Suggested) ? [{ id: o.id, at: o.at, from: o.target, to, rel: rel as Suggested, status: verdict.get(o.id) ?? "suggested" as const }] : [];
    });
  }

  /** Person-local diagnostic receipt; malformed legacy bodies are never included. */
  bridgeStatus(): { skippedRows: number } | undefined {
    return this.generationIndex ? { skippedRows: this.generationIndex.skippedRows() } : undefined;
  }

  /** What the segments hold, for `ahub memory` and the dashboard header. */
  counts(project?: string): { short: number; long: number; segments: number; machine: Machine } {
    const all = this.list({ ...(project ? { project } : {}), limit: Number.MAX_SAFE_INTEGER, includeSuperseded: true });
    const segments = this.generationIndex
      ? (this.db.query("SELECT COUNT(*) AS n FROM generation_segments").get() as { n: number }).n
      : this.segments("log").length + this.segments("local").length;
    return { short: all.filter((v) => v.tier === "short").length, long: all.filter((v) => v.tier === "long").length, segments, machine: this.machine };
  }

  /** The index's rows in a fixed order: what a rebuild must reproduce. */
  dump(): string {
    return JSON.stringify(["entries", "ops", "edges", "goals"].map((t) => this.db.query(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
  }
}

/** Migration builds only its generation-owned index over exact captured source prefixes. */
export function buildGenerationIndex(profile: BoundProfile, sources: readonly LegacyCheckpoint[], legacyCommit?: string): void {
  const store = new MemoryStore({ deferPromotions: true }, { token: MIGRATION_BOOTSTRAP, profile, limits: sources, ...(legacyCommit ? { commit: legacyCommit } : {}) });
  try { const before = store.derivedTables(); store.rebuild(); if (!isDeepStrictEqual(before, store.derivedTables())) throw new Error("generation rebuild differs from incremental index"); }
  finally { store.close(); }
}

/** Trusted activation bootstrap; caller holds profile + realm mutation fences. */
export function buildPublicPruneIndex(profile: BoundProfile): {targets:string[];sourceHash:string} {
  const sources = readShardLegacySnapshot(profile, {}).map(({bytes:_bytes,local:_local,...prefix}) => prefix);
  const store = new MemoryStore({deferPromotions:true}, {token:MIGRATION_BOOTSTRAP, profile, limits:sources});
  try {
    const before = store.derivedTables(); store.rebuild(); const tables = store.derivedTables();
    if (!isDeepStrictEqual(before, tables)) throw new Error("public prune view rebuild differs from incremental index");
    return { targets: (tables.generation_targets as {id:string}[]).map(row=>row.id).sort(),
      sourceHash: hashJSON([tables.generation_rows, tables.generation_prunes, tables.generation_segments, tables.generation_state]) };
  } finally {store.close();}
}

function initializeShard(home: string, opts: { project?: string; user?: boolean }): void {
  const selection = readShardedSelection(home), generation = selection.generation;
  const dir = opts.user === true ? userShardDir(home) : shardDir(home, opts.project!), machine = machineId(home);
  if (opts.project !== undefined) ensureShardDescriptor(home, opts.project);
  for (const folder of ["log", "local", "legacy/log", "legacy/local", "legacy-main/log", "legacy-main/local"]) mkdirSync(join(dir, folder), { recursive: true, mode: 0o700 });
  for (const [path, value] of [["generation.json", generationDescriptor(generation)], ["machine.json", machine], ["legacy/machine.json", machine], ["legacy-main/machine.json", machine]] as const) {
    const file = join(dir, path), prior = readProfileJSON(file);
    if (prior === undefined) writeProfileJSON(file, value);
    else if (canonicalJSON(prior) !== canonicalJSON(value)) throw new Error("curated shard metadata changed during initialization");
  }
  const legacyHome = join(dir, "legacy"), sources = readMigrationSources(legacyHome);
  writeProfileJSON(join(dir, "migration-sources.json"), { schema: "agent-mem.migration-sources/v1", sources });
  const selected = readSelector(home).selector;
  const profile: BoundProfile = { kind: "generation", home, dir, generation, selectorRevision: selection.selectorRevision,
    ...(selected?.schema === "agent-mem.profile/v2" ? {foreignPruneFormat: selected.foreignPruneFormat, pruneInputSetHash: selected.pruneInputSetHash} : {}),
    legacyHome, legacyMainHome: join(dir, "legacy-main"), sharded: true, ...(opts.user === true ? { shardUser: true } : { shardKey: opts.project! }) };
  buildGenerationIndex(profile, sources);
  writeProfileJSON(join(dir, "generation-seal.json"), { schema: "agent-mem.generation-seal/v1", generation,
    descriptorHash: hashJSON(generationDescriptor(generation)), sourceDigest: hashJSON({ sources, legacyCommit: undefined }) });
}

/** Open one sealed project or user shard directly; no legacy-home scan, catalog walk or old-layout reader lease. */
export function openShardStore(opts: StoreOptions & { project?: string; user?: boolean; memoryDir?: string }): MemoryStore {
  if (opts.user === true && opts.project !== undefined || opts.user !== true && !opts.project) throw new Error("choose exactly one project or the user shard");
  if (opts.memoryDir !== undefined && (opts.home !== undefined || typeof opts.memoryDir !== "string" || !opts.memoryDir.trim())) throw new Error("choose a memory home or one explicit memory directory");
  const home = opts.memoryDir ?? (opts.home === undefined ? memoryHome() : join(opts.home, "memory"));
  readShardedSelection(home); // validate the floor before any lazy shard initialization
  const admission = registerReaderLease(home);
  try {
  assertCuratedShardPaths(home, opts);
  // #15 T5: the one gate every recall path shares, checked before a shard can be created. The user shard has no lifecycle.
  if (opts.user !== true && opts.lifecycle !== "ignore") assertProjectActive(home, opts.project!);
  const dir = opts.user === true ? userShardDir(home) : shardDir(home, opts.project!);
  const missing = !existsSync(join(dir, "generation.json"));
  if (missing) initializeShard(home, opts);
  const profile = resolveShardProfile(home, opts);
  const { reconcile, ...plain } = opts;
  const userOverlay = opts.user === true ? undefined : openShardStore({ ...plain, project: undefined, user: true });
  const aliasStores: MemoryStore[] = [];
  try {
    // #27: read-only reconciliation never creates an alias shard. An explicit project import can.
    if (opts.user !== true && reconcile && reconcile.canonical === opts.project) {
      for (const alias of reconcile.aliases) {
        if (alias === opts.project || !opts.createAliases && !existsSync(join(shardDir(home, alias), "generation.json"))) continue;
        assertCuratedShardPaths(home, { project: alias });
        aliasStores.push(opts.createAliases ? openShardStore({ ...plain, project: alias })
          : new MemoryStore(plain, { token: MIGRATION_BOOTSTRAP, profile: resolveShardProfile(home, { project: alias }), authoring: true }));
      }
    }
    return new MemoryStore(opts, { token: MIGRATION_BOOTSTRAP, profile, authoring: true, userOverlay, aliasStores });
  } catch (error) { for (const store of aliasStores) store.close(); userOverlay?.close(); throw error; }
  } finally { admission(); }
}

/** Administrative migration receipt; this inspector reads raw rows without opening a store or writing any index. */
export function summarizeRawExpiry(rawLines: string[], now: number, tailBytes: number): import("./migrate.ts").MigrationCounts {
  const bytes = Buffer.from(rawLines.filter(Boolean).join("\n") + (rawLines.length ? "\n" : ""));
  let malformed = 0;
  const rows = legacyEntries([{ source: "legacy-local", path: "log/inspection.jsonl", bytes, offset: bytes.length, hash: createHash("sha256").update(bytes).digest("hex"), local: false, tailBytes: 0 }], { onMalformed: () => malformed++ });
  const byOp: Record<string, number> = {}, byTier: Record<string, number> = {};
  for (const row of rows) { byOp[row.op] = (byOp[row.op] ?? 0) + 1; if (row.op === "note") byTier[row.tier] = (byTier[row.tier] ?? 0) + 1; }
  // Explicit proof eligibility is shared with prune planning; implicit TTL is reported but never used as a prune proof.
  const located = rows.map(row => ({ row, placement: "local" as const, publicWitness: false }));
  const explicit = explicitExpirySnapshot(located).filter(e => Date.parse(e.expiredAt) <= now);
  const proved = new Map(explicitExpirySnapshot(located).map(e => [e.targetId, e.expiredAt]));
  const settled = new Set(rows.flatMap(e => e.op === "settle" ? [e.target] : []));
  const expiredRows = rows.filter(row => {
    if (row.op !== "note") return false;
    const fixed = proved.get(row.id);
    if (fixed) return Date.parse(fixed) <= now;
    if (row.tier !== "short" || row.task && settled.has(row.task) && PROMOTED_KINDS.includes(row.kind)) return false;
    // Diagnostic only, at the CLI's default TTL. Such derived expiry is never a durable-prune witness.
    return Date.parse(row.at) + (row.task ? UNSETTLED_MS : DEFAULT_TTL_MS) <= now;
  }).length;
  return { validRows: rows.length, expiredRows, eligibleRows: explicit.length, skippedRows: malformed, tailBytes, byOp, byTier };
}
