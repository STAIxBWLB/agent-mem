import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp, type MemoryMcp } from "../src/mcp-memory.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { setFts5AvailableForTest } from "../src/memory/search-fts.ts";
import { entryId, MEMORY_SCHEMA, MemoryStore, type NoteEntry, type View } from "../src/memory/store.ts";

const project = "bounds-project";
const now = Date.now();
const day = 86400_000;
const at = (offset: number) => new Date(now + offset).toISOString();
let root: string;
let mcp: MemoryMcp;
let oldNote: string;
let recentNote: string;
let oldCapture: string;
let recentCapture: string;

type TimelineRow = View | { source: "capture"; evidence: false; capture: { id: number; excerpt: string } };
type SearchResult = { engine: string; hits: { source: string; evidence: boolean; view?: View; capture?: { id: number; excerpt: string } }[] };
const ref = (row: TimelineRow) => "capture" in row ? `capture:${row.capture.id}` : row.id;
const searchRefs = (result: SearchResult) => result.hits.map(hit => hit.view?.id ?? `capture:${hit.capture!.id}`);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "amem-mcp-bounds-"));
  const store = new MemoryStore({ home: root, deferPromotions: true });
  const rows: NoteEntry[] = [];
  const note = (text: string, time: string, overrides: Partial<NoteEntry> = {}) => {
    const body: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note", at: time, machine: store.machine.id,
      project, scope: "project", tier: "long", kind: "decision", peer: "person", text,
      about: ["path:public.ts"], source: "person", ...overrides };
    const row = { ...body, id: entryId(body) }; rows.push(row); return row.id;
  };
  oldNote = note("selectiveneedle old curated", at(-30 * day));
  for (let i = 0; i < 5001; i++) note(`ordinary background ${i}`, at(-10 * day + i * 1000));
  recentNote = note("selectiveneedle recent curated", at(-3600_000));
  // More than a public page of newer matches must never take the public result's slot.
  for (let i = 0; i < 120; i++) {
    note(`selectiveneedle private ${i}`, at(-1000 + i), { about: ["path:hidden.ts"] });
    note(`selectiveneedle sibling ${i}`, at(-1000 + i), { project: "sibling-project" });
    note(`selectiveneedle shared sibling ${i}`, at(-1000 + i), { project: "sibling-project", scope: "shared" });
  }
  // Authentic signed append-only rows, then one normal rebuild, avoid thousands of per-note fsyncs.
  writeFileSync(join(store.dir, "log", `${store.machine.id}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  store.rebuild();
  expect(store.list({ project, limit: 10000 }).filter(row => row.project === project).length).toBeGreaterThan(5000);
  store.close();
  const capture = new CaptureStore({ home: root, project });
  const append = (excerpt: string, time: string, paths = ["public.ts"]) => {
    const result = capture.append({ project, agent: "test", event: "tool", excerpt, at: time, paths });
    if (!("id" in result)) throw new Error("isolated capture unexpectedly spooled");
    return `capture:${result.id}`;
  };
  try {
    oldCapture = append("selectiveneedle old capture", at(-30 * day + 1000));
    for (let i = 0; i < 5001; i++) append(`ordinary capture ${i}`, at(-10 * day + i * 1000));
    recentCapture = append("selectiveneedle recent capture", at(-3600_000 + 1000));
    for (let i = 0; i < 120; i++) append(`selectiveneedle private capture ${i}`, at(-1000 + i), ["hidden.ts"]);
    expect(capture.rows({ project, limit: 10000 }).length).toBeGreaterThan(5000);
  } finally { capture.close(); }
  const sibling = new CaptureStore({ home: root, project: "sibling-project" });
  try { sibling.append({ project: "sibling-project", agent: "test", event: "tool", excerpt: "selectiveneedle sibling capture", at: at(-1) }); }
  finally { sibling.close(); }
  mcp = createMemoryMcp({ cwd: root, base: join(root, "memory"), project, policy: { denyPaths: ["hidden.ts"] } });
}, 20000);

afterAll(() => {
  setFts5AvailableForTest(undefined);
  mcp?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("selective search finds old and recent rows beyond both 5000-row tiers", async () => {
  const result = await mcp.tools.amem_search({ query: "selectiveneedle", limit: 10 }) as SearchResult;
  expect(searchRefs(result).sort()).toEqual([oldNote, recentNote, oldCapture, recentCapture].sort());
  expect(result.hits.filter(hit => hit.source === "capture").every(hit => hit.evidence === false)).toBe(true);
  const curated = await mcp.tools.amem_search({ query: "selectiveneedle", includeCapture: false, limit: 10 }) as SearchResult;
  expect(searchRefs(curated).sort()).toEqual([oldNote, recentNote].sort());
});

test("search applies since and screens private and foreign matches before the public limit", async () => {
  const result = await mcp.tools.amem_search({ query: "selectiveneedle", since: at(-2 * 3600_000), limit: 10 }) as SearchResult;
  expect(searchRefs(result).sort()).toEqual([recentNote, recentCapture].sort());
  const first = await mcp.tools.amem_search({ query: "selectiveneedle", since: at(-2 * 3600_000), limit: 1 }) as SearchResult;
  expect(first.hits).toHaveLength(1);
  expect([recentNote, recentCapture]).toContain(searchRefs(first)[0]!);
});

test("latest and since timelines select public rows without refusing a large corpus", async () => {
  const latest = await mcp.tools.amem_timeline({ limit: 2 }) as TimelineRow[];
  expect(latest.map(ref)).toEqual([recentCapture, recentNote]);
  const since = await mcp.tools.amem_timeline({ since: at(-2 * 3600_000), limit: 100 }) as TimelineRow[];
  expect(since.map(ref)).toEqual([recentCapture, recentNote]);
});

test("timeline anchors reach old curated and capture rows outside the latest candidate window", async () => {
  const curated = await mcp.tools.amem_timeline({ id: oldNote, limit: 2 }) as TimelineRow[];
  expect(curated.map(ref)).toEqual([oldNote, oldCapture]);
  const capture = await mcp.tools.amem_timeline({ id: oldCapture, limit: 2 }) as TimelineRow[];
  expect(capture.map(ref)).toEqual([oldCapture, oldNote]);
});

test("FTS-disabled substring search remains available above both tier ceilings", async () => {
  setFts5AvailableForTest(false);
  try {
    const result = await mcp.tools.amem_search({ query: "selectiveneedle", limit: 10 }) as SearchResult;
    expect(result.engine).toBe("substring");
    expect(searchRefs(result).sort()).toEqual([oldNote, recentNote, oldCapture, recentCapture].sort());
    const recent = await mcp.tools.amem_search({ query: "selectiveneedle", since: at(-2 * 3600_000), limit: 10 }) as SearchResult;
    expect(searchRefs(recent).sort()).toEqual([recentNote, recentCapture].sort());
  } finally { setFts5AvailableForTest(undefined); }
});


test("selected old references remain readable above the tier ceilings", async () => {
  expect(await mcp.tools.amem_show({ id: oldNote })).toMatchObject({ id: oldNote });
  expect(await mcp.tools.amem_show({ id: `mem:${oldNote}` })).toMatchObject({ id: oldNote });
  expect(await mcp.tools.amem_show({ id: oldCapture })).toMatchObject({ source: "capture", evidence: false });
});
