import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { CONFIG_FILE } from "../src/memory/config.ts";
import { realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
for (const tool of ["amem_search", "amem_graph", "amem_timeline"] as const) test(`${tool} rechecks earlier rows after a later awaited screen tightens real configured PII policy`, async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-mcp-recall-policy-"))), base = join(root, "memory"), project = memoryProjectKey(root); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now() - 86400_000;
  const store = new MemoryStore({ memoryDir: base, now: () => now, deferPromotions: true });
  const make = (text: string) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text, about: ["path:public.ts"] });
  const later = make("recallpolicy trigger row"); now += 1000; const earlier = make("recallpolicy EARLY_ALLOWED sensitive after tightening"); store.close();
  const screens: string[] = []; let tightened = false;
  const session = createMemoryMcp({ cwd: root, base, project, policy: { host: { screen: async value => {
    const id = (value as { id?: string } | null)?.id;
    if (id === earlier || id === later) screens.push(id);
    if (id === later && !tightened) { await Promise.resolve(); writeFileSync(join(base, CONFIG_FILE), JSON.stringify({ piiPatterns: ["EARLY_ALLOWED"] })); tightened = true; }
    return true;
  } } } }); cleanup.push(() => session.close());
  let result: unknown;
  try { result = tool === "amem_search" ? await session.tools.amem_search({ query: "recallpolicy", includeCapture: false }) : tool === "amem_graph" ? await session.tools.amem_graph({ start: "path:public.ts", hops: 1 }) : await session.tools.amem_timeline({ limit: 10 }); }
  catch (error) { expect((error as Error).message).toBe("memory operation unavailable"); } // A generic fail-closed refusal is also safe.
  expect(tightened).toBe(true); expect(screens.indexOf(earlier)).toBeGreaterThanOrEqual(0); expect(screens.indexOf(earlier)).toBeLessThan(screens.indexOf(later));
  expect(JSON.stringify(result) ?? "").not.toContain("EARLY_ALLOWED"); expect(JSON.stringify(result) ?? "").not.toContain(earlier);
  await session.onEmitted(tool, 17, result);
  const counters = new CandidateStore({ memoryDir: base }); try { expect(counters.counters(project, earlier)).toEqual([]); expect(counters.counters(project).every(row => row.delivered === null && row.cited === null)).toBe(true); } finally { counters.close(); }
});
