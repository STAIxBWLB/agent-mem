import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp, type MemoryMcp } from "../src/mcp-memory.ts";
import { MemoryStore, type View } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { realPath } from "../src/memory/platform.ts";
import { setFts5AvailableForTest } from "../src/memory/search-fts.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { try { for (const close of cleanup.splice(0).reverse()) close(); } finally { setFts5AvailableForTest(undefined); } });
for (const fallback of [false, true]) test(`expired curated snapshots never fill the final ${fallback ? "substring" : "FTS"} result limit`, async () => {
  setFts5AvailableForTest(fallback ? false : undefined);
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-mcp-ranked-expiry-"))), base = join(root, "memory"), project = "expiry-project";
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const legacy = new MemoryStore({ memoryDir: base, profile: "shared-v1", deferPromotions: true }); legacy.close();
  await migrate({ memoryDir: base, mode: "apply", generation: "e".repeat(32), authorizedPerson: true, tty: true });
  const shorts = new Set<string>(), screened: string[] = []; let deadline = 0, waited = false;
  const mcp: MemoryMcp = createMemoryMcp({ cwd: root, base, project, policy: { host: { screen: async value => {
    const id = (value as { id?: string } | null)?.id;
    if (id && shorts.has(id)) {
      screened.push(id);
      if (screened.length === 2) {
        while (Date.now() <= deadline) await Bun.sleep(Math.max(1, deadline - Date.now() + 1));
        waited = true;
      }
    }
    return true;
  } } } }); cleanup.push(() => mcp.close());
  const writer = new MemoryStore({ memoryDir: base, deferPromotions: true });
  let live: string;
  try {
    expect(writer.profile.kind).toBe("generation");
    live = writer.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "expiryneedle " + "ordinary background ".repeat(80), about: [] });
    deadline = Date.now() + 1000;
    for (let n = 0; n < 2; n++) shorts.add(writer.note({ op: "note", project, scope: "project", tier: "short", kind: "finding", peer: "person", source: "person", text: `expiryneedle ${"expiryneedle ".repeat(20)}${n}`, about: [], expires: new Date(deadline).toISOString() }));
  } finally { writer.close(); }
  const result = await mcp.tools.amem_search({ query: "expiryneedle", includeCapture: false, limit: fallback ? 10 : 1 }) as { hits: { view: View }[] };
  expect(waited).toBe(true); expect(screened).toHaveLength(2); expect(Date.now()).toBeGreaterThan(deadline);
  expect(result.hits.map(hit => hit.view.id)).toEqual([live]);
  expect(result.hits.every(hit => hit.view.expiresAt === null)).toBe(true);
});
