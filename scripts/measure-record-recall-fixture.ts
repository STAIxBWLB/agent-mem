/** Synthetic Record-present control, separate from the unmodified public S/M datasets. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Hits = { hits: { capture?: { id: number; event: string; excerpt: string; paths: string[] } }[] };
function metrics(result: Hits, gold: number) {
  const ids = result.hits.flatMap(hit => hit.capture ? [hit.capture.id] : []), rank = ids.indexOf(gold);
  return { hitAt1: rank === 0 ? 1 : 0, hitAt10: rank >= 0 && rank < 10 ? 1 : 0, MRR: rank < 0 ? 0 : 1 / (rank + 1) };
}
export async function measureRecordFixture(root: string) {
  const load = (file: string) => import(pathToFileURL(join(root, "src", file)).href);
  const { CaptureStore } = await load("memory/capture.ts") as typeof import("../src/memory/capture.ts");
  const { MemoryStore } = await load("memory/store.ts") as typeof import("../src/memory/store.ts");
  const { createMemoryMcp } = await load("mcp-memory.ts") as typeof import("../src/mcp-memory.ts");
  const scratch = mkdtempSync(join(tmpdir(), "amem-record-recall-fixture-")), base = join(scratch, "memory"), project = "records-present-control";
  const at = new Date().toISOString(), line = "amem: finding | src/cache.ts | recordfixtureneedle", paths = ["src/cache.ts"];
  const capture = new CaptureStore({ memoryDir: base, project });
  let gold = 0;
  try {
    for (const event of ["Record", "Recap", "PostToolUse"]) {
      const row = capture.append({ project, agent: "claude", event, at, excerpt: line, paths });
      if (!("id" in row)) throw Error("synthetic capture unexpectedly spooled; rerun this isolated fixture after contention clears");
      if (event === "Record") gold = row.id;
    }
  } finally { capture.close(); }
  const store = new MemoryStore({ memoryDir: base }), mcp = createMemoryMcp({ cwd: scratch, base, project });
  try {
    const library = store.search("recordfixtureneedle", { project, limit: 10 }) as Hits;
    const protocol = await mcp.tools.amem_search!({ query: "recordfixtureneedle", limit: 10 }) as Hits;
    const shown = protocol.hits.find(hit => hit.capture?.event === "Record")?.capture;
    return { scope: "synthetic-record-present-not-public-longmemeval", rows: 3, goldRows: 1,
      library: metrics(library, gold), mcp: metrics(protocol, gold),
      canonicalMcpProjection: shown?.excerpt === line && JSON.stringify(shown.paths) === JSON.stringify(paths) };
  } finally { mcp.close(); store.close(); rmSync(scratch, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const [before, after] = process.argv.slice(2);
  if (!before || !after || process.argv.length !== 4) throw Error("fixture needs two runtime roots; run measure-record-recall-fixture.ts BASELINE CANDIDATE");
  const baseline = await measureRecordFixture(resolve(before)), candidate = await measureRecordFixture(resolve(after));
  console.log(JSON.stringify({ schema: "agent-mem.record-recall-fixture/v1", baseline, candidate,
    delta: Object.fromEntries((["library", "mcp"] as const).map(backend => [backend, {
      hitAt1: candidate[backend].hitAt1 - baseline[backend].hitAt1, hitAt10: candidate[backend].hitAt10 - baseline[backend].hitAt10,
      MRR: candidate[backend].MRR - baseline[backend].MRR,
    }])) }));
}
