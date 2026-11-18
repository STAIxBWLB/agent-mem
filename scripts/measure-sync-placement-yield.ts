/** Opt-in isolated #462 measurement. No real home, host policy, network or model is used. */
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";
import { entryId } from "../src/memory/store.ts";
import { shardDir } from "../src/memory/shard.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { SyncProgress } from "../src/memory/sync-progress.ts";
import { measureSyncPlacementWriters } from "../src/memory/sync-placement-writers.ts";
import { SegmentReader } from "../src/memory/bridge.ts";
import { createPlacementInspectionFixture, inspectionNote } from "../test/fakes/sync-placement-inspection.ts";

const runLarge = process.argv.includes("--run-large"), runV1 = process.argv.includes("--run-v1");
const attribute = process.argv.includes("--attribute");
const gapsOut = process.argv.find(value => value.startsWith("--gaps-out="))?.slice("--gaps-out=".length);
if (!runLarge && !runV1) throw Error("Pass --run-large or --run-v1 to run an isolated placement measurement.");
if (attribute && !gapsOut) throw Error("--attribute requires --gaps-out=<file> to hold the #470 gap windows.");
if (runV1) {
  const legacy = await createPlacementInspectionFixture({ seed(store, project) {
    const first = store.note(inspectionNote("isolated seed", project));
    const log = join(store.profile.home, "log", readdirSync(join(store.profile.home, "log")).find(name => name.endsWith(".jsonl"))!);
    const { id: _id, ...template } = JSON.parse(readFileSync(log, "utf8").trim());
    let rows = "";
    for (let i = 1; i < 150; i++) { const body = { ...template, text: `synthetic row ${i}` }; rows += JSON.stringify({ ...body, id: entryId(body) }) + "\n"; }
    appendFileSync(log, rows); return { first };
  } });
  try {
    let last = performance.now(), maximum = 0, callbacks = 0;
    const sample = () => { const now = performance.now(); maximum = Math.max(maximum, now - last); last = now; };
    const timer = setInterval(sample, 10), progress = new SyncProgress({ intervalMs: 0, sink: snapshot => {
      if (snapshot.phase === "journal" && snapshot.unit === "records") {
        callbacks++; const end = performance.now() + 3; while (performance.now() < end) { /* isolated synchronous per-record cost */ }
      }
    } });
    let result;
    try { result = await syncMemory(legacy.store, { ...legacy.opts(), progress }); await new Promise<void>(resolve => setImmediate(resolve)); sample(); }
    finally { clearInterval(timer); }
    console.log(JSON.stringify({ fixture: "isolated v1 journal; synthetic 3ms progress callback", rows: 150, callbacks, maximumGapMs: Math.round(maximum * 100) / 100, ok: result.ok }));
    if (!result.ok || callbacks < 100 || maximum >= 250) throw Error("The v1 journal loop did not meet the fixture's 250ms bound.");
  } finally { legacy.close(); }
}
if (runLarge) {
const ROWS = 8000, TOKENS = 100, MIN_REALM_BYTES = 200 * 1024 * 1024;
const ownRoot = fileURLToPath(new URL("..", import.meta.url));
const value = (i: number) => Array.from({ length: TOKENS }, (_, j) => createHash("sha256").update(`synthetic ${i} ${j}`).digest("hex")).join(" ");
const f = await createPlacementInspectionFixture({
  seed(store, project) {
    const first = store.note(inspectionNote("isolated seed", project));
    const log = join(store.profile.home, "log", readdirSync(join(store.profile.home, "log")).find(name => name.endsWith(".jsonl"))!);
    const { id: _id, ...template } = JSON.parse(readFileSync(log, "utf8").trim());
    let rows = "";
    for (let i = 1; i < ROWS; i++) { const body = { ...template, text: `synthetic row ${i} ${value(i)}` }; rows += JSON.stringify({ ...body, id: entryId(body) }) + "\n"; }
    appendFileSync(log, rows); return { first };
  },
  async beforeMigrate(home) {
    const previous = process.env.AMEM_HOME; process.env.AMEM_HOME = home;
    try { await runCli(["formats", "raise", "sync", "0.28.0", "--confirm"], { cwd: home, env: {}, processTable: () => "" }); }
    finally { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; }
  },
});
try {
  const visited = new Set<string>();
  const size = (dir: string): number => {
    const stat = lstatSync(dir, { bigint: true });
    if (stat.isSymbolicLink()) throw Error("fixture contains a link");
    if (stat.isFile()) { const key = `${stat.dev}:${stat.ino}`; if (visited.has(key)) return 0; visited.add(key); return Number(stat.size); }
    if (!stat.isDirectory()) throw Error("fixture contains an unsupported node");
    return readdirSync(dir).reduce((sum, name) => sum + size(join(dir, name)), 0);
  };
  const realmBytes = size(shardDir(f.home, f.project));
  if (realmBytes < MIN_REALM_BYTES) throw Error(`Generated realm is ${realmBytes} bytes, below the ${MIN_REALM_BYTES}-byte measurement requirement.`);
  let phase = "startup", last = performance.now(), maximum = 0;
  const started = last;
  const gaps: { phase: string; ms: number; startEpochMs: number; endEpochMs: number }[] = [], attestMs: number[] = [], segmentMs: number[] = [];
  const originalRead = SegmentReader.prototype.read;
  SegmentReader.prototype.read = function (this: SegmentReader, ...args: Parameters<SegmentReader["read"]>) {
    const start = performance.now();
    try { return originalRead.apply(this, args); } finally { segmentMs.push(performance.now() - start); }
  };
  // #470: each >250 ms gap is written as an absolute window so a CPU profile's samples can be intersected with it;
  // the phase name only marks the last report, never the work that filled the gap.
  const sample = () => { const now = performance.now(), gap = now - last; last = now; maximum = Math.max(maximum, gap);
    if (gap > 250) gaps.push({ phase, ms: Math.round(gap * 100) / 100,
      startEpochMs: Math.round((performance.timeOrigin + now - gap) * 1000) / 1000, endEpochMs: Math.round((performance.timeOrigin + now) * 1000) / 1000 }); };
  const timer = setInterval(sample, 10), progress = new SyncProgress({ intervalMs: 0, sink: value => { phase = value.phase; } });
  let result;
  try {
    result = await syncMemory(f.store, { ...f.opts(), progress, placementAttestation: () => {
      const start = performance.now(); measureSyncPlacementWriters([ownRoot]); attestMs.push(performance.now() - start);
      return f.port.attest(); // Synthetic fixture's expected writer; the real install measurement is timing only.
    } });
    await new Promise<void>(resolve => setImmediate(resolve)); sample();
  } finally { clearInterval(timer); SegmentReader.prototype.read = originalRead; }
  if (!result.ok && !result.failure?.cause) throw Error("Placement failure did not carry a cause class.");
  console.log(JSON.stringify({ fixture: "isolated synthetic high-entropy rows; host proof is a timed install measurement plus fixture attestation",
    rows: ROWS, realmBytes, elapsedMs: Math.round(performance.now() - started), elapsedPhase: phase, maximumGapMs: Math.round(maximum * 100) / 100, gapsOver250Ms: gaps,
    maximumInstallMeasureMs: attestMs.length ? Math.round(Math.max(...attestMs) * 100) / 100 : null,
    maximumSegmentReadMs: segmentMs.length ? Math.round(Math.max(...segmentMs) * 100) / 100 : null,
    result: { ok: result.ok, cause: result.failure?.cause ?? null, bound: result.placementPublication?.bound ?? null } }, null, 2));
  if (gapsOut) {
    writeFileSync(gapsOut, JSON.stringify({ rows: ROWS, realmBytes, gaps }, null, 2) + "\n", { mode: 0o600 });
    console.log(`attribution: ${gaps.length} gap window(s) written to ${gapsOut}`);
  }
} finally { f.close(); }
}
