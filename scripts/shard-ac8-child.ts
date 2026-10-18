import { openShardStore } from "../src/memory/store.ts";
import { fts5Available } from "../src/memory/search-fts.ts";
import { peakRssKB } from "./budget-rss.ts";

const home = process.env.AMEM_AC8_HOME, project = process.env.AMEM_AC8_PROJECT, needle = process.env.AMEM_AC8_NEEDLE;
if (!home || !project || !needle) throw new Error("AMEM_AC8_HOME, AMEM_AC8_PROJECT and AMEM_AC8_NEEDLE are required");
const openStart = performance.now();
const store = openShardStore({ home, project });
const openMs = performance.now() - openStart, idle = process.memoryUsage().rss, walls: number[] = [];
let hits = 0, siblings = 0, engine = "fts5";
for (let i = 0; i < 10; i++) {
  const start = performance.now();
  const result = store.search(needle, { project });
  walls.push(performance.now() - start);
  hits = result.hits.length;
  siblings += result.hits.filter((hit) => hit.view && hit.view.project !== project && hit.view.scope !== "shared").length;
  engine = result.engine;
}
const p95Ms = walls.sort((a, b) => a - b)[Math.max(0, Math.ceil(walls.length * 0.95) - 1)]!;
store.close();
console.log(JSON.stringify({ openMs, idle, maxRSS: peakRssKB(), p95Ms, hits, siblings, engine, fts5: fts5Available() }));
