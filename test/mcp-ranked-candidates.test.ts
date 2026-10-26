import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp, type MemoryMcp } from "../src/mcp-memory.ts";
import { CaptureStore, type CaptureInput } from "../src/memory/capture.ts";
import { MemoryStore } from "../src/memory/store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Result = { engine: string; hits: { source: string; evidence: boolean; capture?: { id: number }; score: number }[] };
const ids = (result: Result) => result.hits.map(hit => hit.capture?.id);
const query = "rankneedle exactanchor preciseanchor";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-ranked-candidates-")); roots.push(root);
  const project = "ranked-candidates-project", base = join(root, "memory");
  const now = Date.now(), at = (offset: number) => new Date(now - 60_000 + offset).toISOString();
  const store = new MemoryStore({ home: root, deferPromotions: true }); store.close();
  const capture = new CaptureStore({ home: root, project });
  const append = (excerpt: string, offset: number, fields: Partial<CaptureInput> = {}) => {
    const row = capture.append({ project, agent: "test", event: "Quiet", paths: ["public.ts"], excerpt, at: at(offset), ...fields });
    if (!("id" in row)) throw new Error("isolated capture unexpectedly spooled");
    return row.id;
  };
  return { root, project, base, capture, append };
}

test("MCP ranks the oldest precise capture above more than 5000 newer permitted matches", async () => {
  const f = fixture(); let mcp: MemoryMcp | undefined;
  try {
    const best = f.append("rankneedle exactanchor preciseanchor", 0);
    const second = f.append("rankneedle exactanchor", 1);
    const third = f.append("rankneedle preciseanchor", 2);
    // Every newer row really matches the FTS query, unlike a selective-search fixture.
    for (let i = 0; i < 5001; i++) f.append(`rankneedle ordinary background material ${i}`, 100 + i);
    expect(f.capture.stats().rows).toBe(5004);
    const reader = new MemoryStore({ memoryDir: f.base, deferPromotions: true });
    let expected: number[];
    try {
      const direct = reader.search(query, { project: f.project, limit: 3 });
      expect(direct.engine).toBe("fts5");
      expected = direct.hits.map(hit => hit.capture!.id);
      expect(expected[0]).toBe(best);
      expect([...expected].sort((a, b) => a - b)).toEqual([best, second, third]);
    } finally { reader.close(); }
    // The direct reader and MCP see the same entirely permitted capture-only corpus.
    // Compare rank order, not scores: the two indexes include different metadata fields.
    mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
    const result = await mcp.tools.amem_search({ query, limit: 3 }) as Result;
    expect(result.engine).toBe("fts5");
    expect(ids(result)).toEqual(expected);
    expect(result.hits.every(hit => hit.source === "capture" && hit.evidence === false)).toBe(true);
  } finally { mcp?.close(); f.capture.close(); }
}, 20000);

test("denied full capture rows affect neither permitted rank order nor result slots", async () => {
  const f = fixture(); let mcp: MemoryMcp | undefined;
  try {
    const permitted = [
      f.append("rankneedle exactanchor preciseanchor", 0),
      f.append("rankneedle exactanchor", 1),
      f.append("rankneedle preciseanchor", 2),
    ];
    mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project,
      policy: { denyPaths: ["hidden.ts"], piiPatterns: ["restricted-marker"] } });
    const before = await mcp.tools.amem_search({ query, limit: 3 }) as Result;
    expect([...ids(before)].sort((a, b) => a! - b!)).toEqual(permitted);
    // Excerpts are public. Only the complete row reveals the denied path or tool metadata.
    // Skew one query term's frequency: ranking before screening would also change
    // the relative order of the two permitted partial matches, even if denied hits were removed later.
    for (let i = 0; i < 120; i++) {
      f.append("rankneedle preciseanchor preciseanchor", 100 + i,
        i % 2 === 0 ? { paths: ["hidden.ts"] } : { tool: "restricted-marker" });
    }
    const after = await mcp.tools.amem_search({ query, limit: 3 }) as Result;
    expect(ids(after)).toEqual(ids(before));
    expect(after.hits).toHaveLength(3);
    const all = await mcp.tools.amem_search({ query, limit: 100 }) as Result;
    expect(ids(all)).toEqual(ids(before));
    const first = await mcp.tools.amem_search({ query, limit: 1 }) as Result;
    expect(ids(first)).toEqual(ids(before).slice(0, 1));
  } finally { mcp?.close(); f.capture.close(); }
});
