/**
 * #417 AC1/AC3, #418 AC6: synthetic first placement sync. Counts complete writer attestations and policy
 * evaluations and records wall/CPU time; no real memory records, no network (a local bare remote).
 *
 *   bun scripts/bench-placement-sync.ts --rows 1000 --roots 4 [--row-bytes 300] [--progress] [--batch-floor]
 *
 * Each attestation measures --roots synthetic copies of this package's runtime with the production
 * measureSyncPlacementWriters, so the per-attestation cost is real install I/O. Run it on dgx02, not the Mac.
 */
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { captureSyncPlacementContext } from "../src/memory/sync-placement-capture.ts";
import { planPlacementJournal, preparePlacementJournal, type PlacementJournalPort } from "../src/memory/sync-placement-journal.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { ensurePlacementFence } from "../src/memory/sync-placement-journal-storage.ts";
import { PLACEMENT_FORMAT, PLACEMENT_SHARDS_SCHEMA } from "../src/memory/sync-placement-format.ts";
import { measureSyncPlacementWriters } from "../src/memory/sync-placement-writers.ts";
import { syncPlacementMemory } from "../src/memory/sync-placement-transport.ts";
import type { SyncOptions } from "../src/memory/sync.ts";
import { runCli } from "../src/cli.ts";

const arg = (name: string, fallback: number) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : Number(process.argv[at + 1]); };
const rows = arg("--rows", 1000), roots = arg("--roots", 4), rowBytes = arg("--row-bytes", 300), withProgress = process.argv.includes("--progress");
const PROJECT = "example.test/placement/bench", json = (value: unknown) => canonicalJSON(value) + "\n";
const base = realPath(mkdtempSync(join(tmpdir(), "amem-placement-bench-")));
try {
  const home = join(base, "memory"), remote = join(base, "remote.git"), repo = fileURLToPath(new URL("..", import.meta.url));
  mkdirSync(remote); if (memoryGitSync(["-C", remote, "init", "--bare", "-q"], { encoding: "utf8" }).status !== 0) throw Error("bare remote unavailable");
  const writerRoots: string[] = [];
  for (let index = 0; index < roots; index++) {
    const root = join(base, `writer-${index}`); mkdirSync(root);
    for (const name of ["package.json", "src", "bin", "hooks", ".claude-plugin"]) if (existsSync(join(repo, name))) cpSync(join(repo, name), join(root, name), { recursive: true });
    writerRoots.push(root);
  }
  const original = new MemoryStore({ memoryDir: home, deferPromotions: true });
  const pad = "synthetic filler ".repeat(Math.ceil(rowBytes / 17));
  for (let index = 0; index < rows; index++) {
    // Mixed outcomes: every 10th row is policy-declined, every 7th is machine-local, one in 50 is a user-scope row.
    const text = `${index % 10 === 3 ? "NEVER_PUBLIC_" : "row"} ${index} ${pad}`.slice(0, Math.max(24, rowBytes));
    original.note({ op: "note", project: PROJECT, scope: index % 50 === 1 ? "shared" : "project", tier: index % 7 === 5 ? "short" : "long", kind: "finding", peer: "person", source: "person", text, about: [] });
  }
  original.close();
  // Fixture-only opt-in uses the same explicit floor command, against this disposable home and an empty process table.
  if (process.argv.includes("--batch-floor")) {
    const priorHome = process.env.AMEM_HOME; process.env.AMEM_HOME = home;
    try { await runCli(["formats", "raise", "sync", "0.28.0", "--confirm"], { processTable: () => "", cwd: base, env: {} }); }
    finally { if (priorHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = priorHome; }
  }
  if (!(await migrateShards({ memoryDir: home, generation: "b".repeat(32), mode: "apply", authorizedPerson: true, tty: true })).active) throw Error("shard migration unavailable");
  await activatePublicPruneView({ memoryDir: home, mode: "apply", authorizedPerson: true, tty: true });
  writeFileSync(join(home, "amem.config.json"), json({ piiPatterns: ["NEVER_PUBLIC_"] }), { mode: 0o600 });
  let attestations = 0, measureMs = 0, evaluations = 0, phase = "materialize";
  const byPhase: Record<string, number> = {};
  const port: PlacementJournalPort = { attest: () => {
    attestations++; byPhase[phase] = (byPhase[phase] ?? 0) + 1;
    if (writerRoots.length) { const started = performance.now(); measureSyncPlacementWriters(writerRoots); measureMs += performance.now() - started; }
    return { writers: [{ writerId: "1".repeat(64), version: "0.22.0", pin: "2".repeat(64), publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true };
  }, policyVersion: () => "bench", authorize: () => true };
  const preview = planPlacementJournal(home, port), { epochHash } = preparePlacementJournal(home, preview, port);
  const oldShards = JSON.parse(readFileSync(join(home, "shards.json"), "utf8")), profile = preview.plan.targetProfile;
  writeFileSync(join(home, "profile.json"), json(profile), { mode: 0o600 });
  writeFileSync(join(home, "shards.json"), json({ ...oldShards, schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(profile), publicationFormat: PLACEMENT_FORMAT, placementHead: epochHash }), { mode: 0o600 });
  const proof = captureSyncPlacementContext(home, port), mutation = acquireMutation(home); if (!mutation) throw Error("home mutation unavailable");
  try { ensurePlacementFence(home, epochHash, { mutation, assertCurrent: proof.assertCurrent }); } finally { mutation(); }
  const store = openShardStore({ memoryDir: home, project: PROJECT, deferPromotions: true });
  const sourceBytes = [...captureSyncPlacementContext(home, port).rows.values()].reduce((sum, row) => sum + Buffer.byteLength(canonicalJSON(row.row)), 0);
  let progressEvents = 0;
  const options = { remote, visibility: async () => "private", placementAttestation: port.attest, policyVersion: port.policyVersion,
    screen: () => { evaluations++; return true; }, ...(withProgress ? { progress: () => { progressEvents++; } } : {}) } as SyncOptions;
  attestations = 0; measureMs = 0; for (const key of Object.keys(byPhase)) delete byPhase[key];
  let failure: unknown;
  const cpu = process.cpuUsage(), started = performance.now();
  const phaseAt: Record<string, number> = {};
  const result = await syncPlacementMemory(store, options, at => { phase = at; phaseAt[at] = Math.round(performance.now() - started); }, error => { failure = error; });
  const wallMs = performance.now() - started, used = process.cpuUsage(cpu);
  store.close();
  const epochDir = join(home, "sync-placement", "epochs", epochHash);
  console.log(JSON.stringify({ rows, roots, rowBytes, sourceBytes, ok: result.ok, error: result.error, failure: failure instanceof Error ? failure.message : undefined,
    outcome: result.placementPublication?.outcome, exported: result.placementPublication?.exported, withheld: result.placementPublication?.withheld,
    attestations, attestationsByPhase: byPhase, measureMs: Math.round(measureMs), perAttestationMs: attestations ? Number((measureMs / attestations).toFixed(2)) : 0,
    evaluations, progressEvents, phaseAtMs: phaseAt, wallMs: Math.round(wallMs), cpuMs: Math.round((used.user + used.system) / 1000), journalObjects: readdirSync(epochDir).length }));
} finally { rmSync(base, { recursive: true, force: true }); }
