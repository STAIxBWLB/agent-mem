// Test-only R3 instrumentation around the production MCP transport and handlers. stdout stays MCP-only.
import { writeFileSync } from "node:fs";
import { serveMcp } from "../src/mcp.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { peakRssKB } from "./budget-rss.ts";

const [cwd, base, report] = process.argv.slice(2);
if (!cwd || !base || !report) throw new Error("expected isolated cwd, memory base and report path");
const memory = await createMemoryMcp({ cwd, base });
let idleBytes = 0, maxRSS = 0, searches = 0;
const search = memory.tools.amem_search;
await serveMcp({
  tools: { ...memory.tools, amem_search: async args => {
    if (!searches) idleBytes = process.memoryUsage().rss;
    const result = await search(args);
    searches++;
    maxRSS = Math.max(maxRSS, peakRssKB());
    return result;
  } },
  close: async () => {
    await memory.close();
    writeFileSync(report, JSON.stringify({ idleBytes, maxRSS, searches }), { mode: 0o600 });
  },
});
