// R3 search-path invocation (issue #13): open the store, report idle RSS, search, report peak RSS, p95 and engine.
import { MemoryStore } from "../src/memory/store.ts";
import { fts5Available } from "../src/memory/search-fts.ts";

const home = process.env.AMEM_BUDGET_HOME;
if (!home) throw new Error("AMEM_BUDGET_HOME is required");
const store = new MemoryStore({ home });
const idle = process.memoryUsage().rss;
const walls: number[] = [];
let hits = 0, engine = "fts5";
for (let i = 0; i < 10; i++) {
  const start = performance.now();
  const result = store.search(`bounded eviction storage engine variant ${i}`, { project: "budget" });
  walls.push(performance.now() - start);
  hits = result.hits.length;
  engine = result.engine;
}
const p95 = walls.sort((a, b) => a - b)[Math.max(0, Math.ceil(walls.length * 0.95) - 1)]!;
store.close();
console.log(JSON.stringify({ idle, maxRSS: process.resourceUsage().maxRSS, p95Ms: p95, engine, fts5: fts5Available(), hits }));
