// R3 search-path invocation (issue #13): open the store, report idle RSS, search, report peak RSS and the engine.
import { MemoryStore } from "../src/memory/store.ts";
import { fts5Available } from "../src/memory/search-fts.ts";

const home = process.env.AMEM_BUDGET_HOME;
if (!home) throw new Error("AMEM_BUDGET_HOME is required");
const store = new MemoryStore({ home });
const idle = process.memoryUsage().rss;
let hits = 0;
for (let i = 0; i < 10; i++) hits = store.search(`bounded eviction storage engine variant ${i}`, { project: "budget" }).hits.length;
const engine = store.search("bounded eviction storage engine", { project: "budget" }).engine;
store.close();
console.log(JSON.stringify({ idle, maxRSS: process.resourceUsage().maxRSS, engine, fts5: fts5Available(), hits }));
