import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { MemoryStore } from "../src/memory/store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-read-window-")); roots.push(root);
  const project = "window-project", base = join(root, "memory");
  const store = new MemoryStore({ home: root, deferPromotions: true });
  return { root, project, base, store };
}

test("capture matching uses the same FTS tokenizer for excerpts, paths and event", async () => {
  const f = fixture(); f.store.close();
  const capture = new CaptureStore({ home: f.root, project: f.project });
  try {
    for (const paths of [["메모리"], ["café"], ["Äpfel"]]) capture.append({ project: f.project, agent: "test", event: "Quiet", paths, excerpt: "ordinary" });
    capture.append({ project: f.project, agent: "test", event: "EventNeedle", excerpt: "ordinary" });
  } finally { capture.close(); }
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
  try {
    for (const query of ["메모리는", "cafe", "äpfel", "eventneedle"]) {
      const result = await mcp.tools.amem_search({ query }) as { hits: { source: string; evidence: boolean }[] };
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]).toMatchObject({ source: "capture", evidence: false });
    }
  } finally { mcp.close(); }
});

test("metadata substring false positives and more than 5000 denied matches cannot consume the public window", async () => {
  const f = fixture(); f.store.close();
  const capture = new CaptureStore({ home: f.root, project: f.project });
  const at = Date.now() - 10_000;
  try {
    capture.append({ project: f.project, agent: "test", event: "Quiet", paths: ["foo"], excerpt: "ordinary", at: new Date(at).toISOString() });
    for (let i = 0; i < 5001; i++) capture.append({ project: f.project, agent: "test", event: "Quiet", paths: ["myfoo"], excerpt: "ordinary", at: new Date(at + i + 1).toISOString() });
    for (let i = 0; i < 5001; i++) capture.append({ project: f.project, agent: "test", event: "Quiet", paths: ["hidden.ts"], excerpt: "foo denied", at: new Date(at + i + 5002).toISOString() });
  } finally { capture.close(); }
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, policy: { denyPaths: ["hidden.ts"] } });
  try {
    const result = await mcp.tools.amem_search({ query: "foo", limit: 1 }) as { hits: { capture: { id: number } }[] };
    expect(result.hits.map(hit => hit.capture.id)).toEqual([1]);
    const timeline = await mcp.tools.amem_timeline({ limit: 1 }) as { capture: { id: number } }[];
    expect(timeline.map(hit => hit.capture.id)).toEqual([5002]);
  } finally { mcp.close(); }
}, 20000);

test("current curated recall hides invalid lifecycle bodies while person history retains superseded originals", async () => {
  const f = fixture();
  const note = (text: string) => f.store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "test", source: "person", text, about: [] });
  const old = note("lifecycleneedle old"), forgotten = note("lifecycleneedle forgotten"), current = note("lifecycleneedle current");
  f.store.forget(forgotten, "person");
  f.store.supersede(old, current, "person");
  f.store.close();
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
  try {
    const result = await mcp.tools.amem_search({ query: "lifecycleneedle" }) as { hits: { view: { id: string } }[] };
    expect(result.hits.map(hit => hit.view.id)).toEqual([current]);
    const timeline = await mcp.tools.amem_timeline({}) as { id: string }[];
    expect(timeline.map(row => row.id)).toEqual([current]);
    expect(await mcp.tools.amem_show({ id: old })).toBeNull();
    const reader = new MemoryStore({ memoryDir: f.base, deferPromotions: true });
    try { expect(reader.recallState(f.project, { history: true }).views.map(row => row.id).sort()).toEqual([old, current].sort()); }
    finally { reader.close(); }
    expect(await mcp.tools.amem_timeline({ id: forgotten })).toEqual([]);
  } finally { mcp.close(); }
});

test("since compares instants with timezone offsets inside candidate selection", async () => {
  const f = fixture();
  const id = f.store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "test", source: "person", text: "offsetneedle", about: [] });
  f.store.close();
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
  try {
    const since = new Date(Date.now() - 3600_000).toISOString().replace("Z", "+00:00");
    expect(await mcp.tools.amem_timeline({ since })).toMatchObject([{ id }]);
    expect(await mcp.tools.amem_search({ query: "offsetneedle", since })).toMatchObject({ hits: [{ view: { id } }] });
  } finally { mcp.close(); }
});


test("old capture MCP-index backfill rolls back a failure before advertising readiness", () => {
  const f = fixture(); f.store.close();
  const capture = new CaptureStore({ home: f.root, project: f.project });
  capture.append({ project: f.project, agent: "test", event: "BackfillNeedle", paths: ["public.ts"], excerpt: "ordinary" });
  const file = join(capture.dir, "capture.db"); capture.close();
  const old = new Database(file);
  try {
    for (const trigger of ["rows_mcp_ai", "rows_mcp_ad", "rows_mcp_au"]) old.run(`DROP TRIGGER IF EXISTS ${trigger}`);
    old.run("DROP TABLE IF EXISTS mcp_fts");
    // A real SQL error during backfill must roll the schema marker back too, so the next open retries.
    old.run("UPDATE rows SET paths = 'not-json'");
    const reader = new CaptureStore({ home: f.root, project: f.project });
    try { expect(() => reader.readPage({ project: f.project, query: "backfillneedle", limit: 10 })).toThrow(); }
    finally { reader.close(); }
    expect(old.query("SELECT name FROM sqlite_master WHERE name = 'mcp_fts'").get()).toBeNull();
    old.query("UPDATE rows SET paths = ?").run(JSON.stringify(["public.ts"]));
  } finally { old.close(); }
  const reopened = new CaptureStore({ home: f.root, project: f.project });
  try {
    expect(reopened.readPage({ project: f.project, query: "backfillneedle", limit: 10 }).rows).toMatchObject([{ id: 1 }]);
  } finally { reopened.close(); }
});
