import type { CatalogProject } from "../src/memory/catalog.ts";
import type { DecayPlan } from "../src/memory/decay-review.ts";
import type { MigrationResult } from "../src/memory/migrate.ts";
import type { PrunePlan } from "../src/memory/prune.ts";
import type { ShardMigrationResult } from "../src/memory/shard-migration.ts";
import type { View } from "../src/memory/store.ts";
import type { SyncResult } from "../src/memory/sync.ts";
import type { SyncStatusReport } from "../src/memory/sync-progress.ts";
import type { UsageReport } from "../src/memory/usage.ts";

// Synthetic, content-free inputs for the #590 task 429 goldens; ids and keys are made up.
export const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const id = (c: string) => c.repeat(32);
export const migration: MigrationResult = { mode: "dry-run", profile: { kind: "shared-v1", home: "/h/memory", dir: "/h/memory" } as MigrationResult["profile"],
  counts: { validRows: 1088, skippedRows: 2, tailBytes: 0, expiredRows: 14, eligibleRows: 1074, byOp: { add: 1000, supersede: 74 }, byTier: { long: 900, short: 174 } } as NonNullable<MigrationResult["counts"]>,
  consequence: "applies a new generation; the shared v1 log stays as it is" };
export const shardMigration: ShardMigrationResult = { mode: "dry-run", generation: "abcdef0123456789abcdef0123456789", active: false,
  counts: { rows: 1200, skippedRows: 0, userRows: 40, tailBytes: 0, legacyRows: 1160, generationRows: 0, generationLocalRows: 0, legacyLocalRows: 12, legacyMainRows: 1148,
    pruneRows: 3, translatedPruneRows: 3, refusedRows: 1, sharedSupersededByPrivate: 0, crossPrivateReplacement: 0, danglingRows: 0, byShard: { a: 1, b: 2 }, byProject: { p: 1 } },
  consequence: "splits the curated home into project and user shards", refusals: ["one row names a project outside the inventory"] } as unknown as ShardMigrationResult;
export const prune: PrunePlan = { schema: "agent-mem.prune-plan/v1", generation: "g", selectorRevision: "r", project: "repo@1234abcd", policyRevision: "p",
  rows: [{ placement: "local", payload: { cutoff: "2026-01-01T00:00:00.000Z", targets: [{ id: id("a"), expiredAt: "2025-12-01T00:00:00.000Z" }] } }] as unknown as PrunePlan["rows"],
  counts: { eligible: 3, selected: 1, local: 1, synced: 0 }, hasMore: true, seal: "s" };
const view = (c: string, title: string, kind = "decision"): View => ({ id: id(c), kind, title, text: "body", at: "2026-01-02T00:00:00.000Z", project: "repo@1234abcd" } as unknown as View);
export const decay: DecayPlan = { project: "repo@1234abcd", profile: "generation", days: 90, at: "", cutoff: "", demoteExpiresAt: "",
  entries: [{ target: { id: id("b"), revision: 2 } as never, view: view("b", "Old lock rule") }, { target: { id: id("c"), revision: 1 } as never, view: view("c", "한글 제목이 아주 길게 이어지는 오래된 결정 노트입니다 넓은 글자") }],
  withheld: 1, citedExemptions: null, truncated: false, citationHistory: "unknown" };
export const replay = { records: [{ name: "x", cwd: "/w/repo", project: "repo@1234abcd", class: "native", event: "Stop" }, { name: "y", cwd: "/w/other", project: null, class: "summary", event: null }],
  counts: { native: 1, summary: 1, unreadable: 0 }, digest: "0123456789abcdef", needsConfirmation: [{ cwd: "/w/other", project: "other@5678abcd", count: 1 }] };
export const sync: SyncResult = { ok: true, pushed: true, entries: 1088, placementPublication: { outcome: "committed", exported: 12, withheld: 1, policyCeiling: "last-positive-check-before-in-flight-push" },
  placementRealms: [{ realm: "user", outcome: "committed", publication: 4 }, { realm: "f".repeat(64), outcome: "not-needed" }], checkpoint: { window: 3, objectsBefore: 900, objectsAfter: 120 } } as SyncResult;
export const syncStatus: SyncStatusReport = { malformed: 1, operations: [{ operationId: "op-1", state: "interrupted", phase: "publish", attempt: 1, elapsedMs: 42_000, phaseElapsedMs: 5_000, startedUnixMs: NOW - 102_000, ownerLiveness: "gone",
  lastAliveAgoMs: 60_000, lastWorkProgressAgoMs: 60_000, lastAliveUnixMs: NOW - 60_000, lastWorkProgressUnixMs: NOW - 60_000 } as never] };
const project = (key: string, rows: number, disk: number, extra: Partial<CatalogProject> = {}): CatalogProject => ({ hash: "h", key, local: false, aliases: [], captureRows: rows, captureBytes: rows * 100,
  captureLastAt: "2026-11-22T10:00:00.000Z", curatedEntries: 40, curatedLastAt: null, curatedAvailable: true, capMb: 64, retentionDays: 30, state: "active", diskBytes: disk, ...extra });
export const projects = [project("agent-mem@1234abcd", 4200, 9_400_000, { aliases: ["old@00000000"] }), project("notes@5678abcd", 12, 40_000, { state: "archived", local: true })];
export const usage: UsageReport = { projects, totals: { shards: 2, captureRows: 4212, captureBytes: 421_200, curatedEntries: 80, diskBytes: 9_440_000 }, largest: projects, curatedSplit: true };
export const repoStatus = { root: "/w/repo", file: "/w/repo/.amem/log.jsonl", state: "ok", entries: 7, skipped: { malformed: 1, mismatched: 0, duplicate: 0, withheld: 2 } };
export const vault = [{ project: "agent-mem@1234abcd", candidates: [view("d", "Release gate reuses the identical tree"), view("e", "Sync lock is one per home", "contract")] }];
