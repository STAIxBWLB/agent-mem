/** Synthetic Record-present control, separate from the unmodified public S/M datasets. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Hits = { hits: { capture?: { id: number; event: string; excerpt: string; paths: string[] } }[] };
const BACKENDS = ["library", "mcp"] as const, METRICS = ["hitAt1", "hitAt10", "MRR"] as const;
export interface RecordFixtureMetrics { hitAt1: number; hitAt10: number; MRR: number; recordRank: number | null }
export interface RecordFixtureMeasurement {
  scope: "synthetic-record-present-not-public-longmemeval"; rows: number; goldRows: number;
  library: RecordFixtureMetrics; mcp: RecordFixtureMetrics;
  canonicalMcpProjection: boolean; canonicalLibraryProjection: boolean;
}
const incomplete = () => ({ complete: false as const, pass: false as const,
  cause: "Synthetic Record retrieval or its canonical backend projection did not complete.",
  nextStep: "Inspect the isolated fixture and both backend results, then rerun with the same canonical rows; retain missing results as failures." });
function metrics(result: Hits, gold: number): RecordFixtureMetrics {
  const rank = result.hits.findIndex(hit => hit.capture?.id === gold);
  return { hitAt1: rank === 0 ? 1 : 0, hitAt10: rank >= 0 && rank < 10 ? 1 : 0, MRR: rank < 0 ? 0 : 1 / (rank + 1), recordRank: rank < 0 ? null : rank + 1 };
}
/** Missing Record evidence is incomplete; a measured regression or wrong candidate rank is a failed comparison. */
export function compareRecordFixture(baseline: RecordFixtureMeasurement, candidate: RecordFixtureMeasurement) {
  for (const result of [baseline, candidate]) {
    if (result.scope !== "synthetic-record-present-not-public-longmemeval" || result.rows !== 3 || result.goldRows !== 1
      || result.canonicalMcpProjection !== true || result.canonicalLibraryProjection !== true) return incomplete();
    for (const backend of BACKENDS) {
      const row = result[backend];
      if (!row || !Number.isSafeInteger(row.recordRank) || row.recordRank! < 1 || row.recordRank! > 10
        || !METRICS.every(metric => Number.isFinite(row[metric]))
        || row.hitAt1 !== Number(row.recordRank === 1) || row.hitAt10 !== 1 || row.MRR !== 1 / row.recordRank!) return incomplete();
    }
  }
  const delta = Object.fromEntries(BACKENDS.map(backend => [backend, Object.fromEntries(METRICS.map(metric => [metric, candidate[backend][metric] - baseline[backend][metric]]))]));
  const pass = BACKENDS.every(backend => candidate[backend].recordRank === 1 && METRICS.every(metric => candidate[backend][metric] >= baseline[backend][metric]));
  return { complete: true as const, pass, delta,
    ...(!pass ? { cause: "The candidate loses a synthetic backend metric or fails to rank the canonical Record first.",
      nextStep: "Retain this failed comparison and review Record weighting, selection and projections before rerunning." } : {}) };
}
export async function measureRecordFixture(root: string): Promise<RecordFixtureMeasurement> {
  const load = (file: string) => import(pathToFileURL(join(root, "src", file)).href);
  const { CaptureStore } = await load("memory/capture.ts") as typeof import("../src/memory/capture.ts");
  const { MemoryStore } = await load("memory/store.ts") as typeof import("../src/memory/store.ts");
  const { createMemoryMcp } = await load("mcp-memory.ts") as typeof import("../src/mcp-memory.ts");
  const scratch = mkdtempSync(join(tmpdir(), "amem-record-recall-fixture-")), base = join(scratch, "memory"), project = "records-present-control";
  let store: InstanceType<typeof MemoryStore> | undefined, mcp: ReturnType<typeof createMemoryMcp> | undefined;
  try {
    const at = new Date().toISOString(), line = "amem: finding | src/cache.ts | recordfixtureneedle", paths = ["src/cache.ts"];
    const capture = new CaptureStore({ memoryDir: base, project }); let gold = 0;
    try {
      for (const event of ["Record", "Recap", "PostToolUse"]) {
        const row = capture.append({ project, agent: "claude", event, at, excerpt: line, paths });
        if (!("id" in row)) throw Error("synthetic capture unexpectedly spooled; rerun this isolated fixture after contention clears");
        if (event === "Record") gold = row.id;
      }
      if (capture.stats().rows !== 3 || !gold) throw Error("synthetic seed is incomplete; rebuild the isolated three-row fixture before rerunning");
    } finally { capture.close(); }
    store = new MemoryStore({ memoryDir: base }); mcp = createMemoryMcp({ cwd: scratch, base, project });
    const library = store.search("recordfixtureneedle", { project, limit: 10 }) as Hits;
    const protocol = await mcp.tools.amem_search!({ query: "recordfixtureneedle", limit: 10 }) as Hits;
    const canonical = (result: Hits) => { const shown = result.hits.find(hit => hit.capture?.id === gold)?.capture;
      return shown?.event === "Record" && shown.excerpt === line && JSON.stringify(shown.paths) === JSON.stringify(paths); };
    return { scope: "synthetic-record-present-not-public-longmemeval", rows: 3, goldRows: 1,
      library: metrics(library, gold), mcp: metrics(protocol, gold), canonicalMcpProjection: canonical(protocol), canonicalLibraryProjection: canonical(library) };
  } finally { try { mcp?.close(); } finally { try { store?.close(); } finally { rmSync(scratch, { recursive: true, force: true }); } } }
}
if (import.meta.main) {
  try {
    const [before, after] = process.argv.slice(2);
    if (!before || !after || process.argv.length !== 4) throw Error("fixture arguments unavailable");
    const baseline = await measureRecordFixture(resolve(before)), candidate = await measureRecordFixture(resolve(after));
    const verdict = compareRecordFixture(baseline, candidate);
    console.log(JSON.stringify({ schema: "agent-mem.record-recall-fixture/v1", baseline, candidate, ...verdict }));
    if (!verdict.pass) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ schema: "agent-mem.record-recall-fixture/v1", ...incomplete() }));
    process.exitCode = 1;
  }
}
