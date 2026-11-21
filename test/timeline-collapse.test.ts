import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { CaptureStore } from "../src/memory/capture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const t0 = Date.parse("2026-11-21T00:00:00.000Z"), at = (minute: number) => new Date(t0 + minute * 60_000).toISOString();
const S1 = "a".repeat(16), S2 = "b".repeat(16);
type Row = { minute: number; event: string; session?: string; agent?: string; tool?: string; excerpt?: string; paths?: string[] };

function fixture(rows: Row[], notes: { minute: number; text: string }[] = []) {
  const root = mkdtempSync(join(tmpdir(), "timeline-collapse-")); roots.push(root);
  const base = join(root, "memory"), project = "project-a";
  let clock = t0;
  const store = new MemoryStore({ home: root, deferPromotions: true, now: () => clock });
  const ids = notes.map(note => { clock = Date.parse(at(note.minute)); return store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: note.text, about: [] }); });
  store.close();
  const capture = new CaptureStore({ home: root, project });
  for (const row of rows) capture.append({ project, at: at(row.minute), agent: row.agent ?? "claude", event: row.event, excerpt: row.excerpt ?? `${row.event} ${row.tool ?? ""} m${row.minute}`,
    paths: row.paths ?? [], ...(row.tool ? { tool: row.tool } : {}), ...(row.session ? { session: row.session } : {}) });
  capture.close();
  return { root, base, project, ids };
}
const open = (f: ReturnType<typeof fixture>, policy?: { denyPaths: string[] }) => createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, ...(policy ? { policy } : {}) });
type Item = { source: string; id?: string; capture?: { id: number; event: string; excerpt: string }; run?: { agent: string; session: string; count: number; events: Record<string, number>; tools: { tool: string; count: number }[]; from: string; to: string; first: string; last: string } };
const tools = (session: string, from: number, count: number, tool = "Bash"): Row[] => Array.from({ length: count }, (_, i) => ({ minute: from + i, event: i % 2 ? "PostToolUse" : "PreToolUse", session, tool }));

test("the default timeline keeps every curated note and collapses each session's tool run into one marked entry", async () => {
  const f = fixture([...tools(S1, 1, 30), ...tools(S2, 40, 30, "mcp__agent-hub__hub_send")], [{ minute: 20, text: "decision one" }, { minute: 75, text: "decision two" }, { minute: 76, text: "decision three" }]);
  const mcp = open(f);
  try {
    const items = await mcp.tools.amem_timeline({ limit: 10 }) as Item[];
    expect(items.filter(item => item.source === "person").length).toBe(3);
    const runs = items.filter(item => item.source === "capture-run");
    expect(items.filter(item => item.source === "capture")).toEqual([]);
    expect(runs.map(item => item.run!.session)).toEqual([S2]); // capture reads only its newest `limit` rows, all in S2's run; no extra read
    for (const item of runs) { expect(item).toMatchObject({ evidence: false }); expect(JSON.stringify(item)).not.toContain("excerpt"); expect(item).not.toHaveProperty("stale"); }
    const s2 = runs[0]!.run!;
    expect(s2.count).toBe(10);
    expect(s2.tools).toEqual([{ tool: "mcp__agent-hub__hub_send", count: 10 }]);
    expect(items).toHaveLength(4); // 3 curated + 1 run: fewer than limit, never refilled
    const expanded = await mcp.tools.amem_timeline({ limit: 10, expand: true }) as Item[];
    expect(expanded.filter(item => item.source === "person").length).toBe(2); // before: the minute-20 note was crowded out
  } finally { mcp.close(); }
});

test("runs break on conversational rows, other sessions and other agents; rows without a session stay raw", async () => {
  const f = fixture([
    ...tools(S1, 1, 3), { minute: 4, event: "Stop", session: S1, excerpt: "said something" }, ...tools(S1, 5, 2),
    ...tools(S2, 7, 2), { minute: 9, event: "PreToolUse", session: S2, agent: "codex", tool: "Read" }, { minute: 10, event: "PostToolUse", session: S2, agent: "codex", tool: "Read" },
    { minute: 11, event: "PreToolUse", tool: "Grep" }, { minute: 12, event: "PostToolUse", tool: "Grep" }, { minute: 13, event: "PreToolUse", session: S1, tool: "Edit" },
  ]);
  const mcp = open(f);
  try {
    const items = await mcp.tools.amem_timeline({ limit: 50 }) as Item[];
    const shape = items.map(item => item.source === "capture-run" ? `run:${item.run!.agent}:${item.run!.session.slice(0, 1)}:${item.run!.count}` : `${item.capture!.event}:${item.capture!.excerpt.split(" ")[1] ?? ""}`);
    expect(shape).toEqual(["PreToolUse:Edit", "PostToolUse:Grep", "PreToolUse:Grep", "run:codex:b:2", "run:claude:b:2", "run:claude:a:2", "Stop:something", "run:claude:a:3"]);
    const run = items.find(item => item.run?.count === 3)!.run!;
    expect(run).toMatchObject({ events: { PreToolUse: 2, PostToolUse: 1 }, from: at(1), to: at(3) });
    expect(run.first).toMatch(/^capture:\d+$/); expect(run.last).toMatch(/^capture:\d+$/);
  } finally { mcp.close(); }
});

test("screened-out rows neither count nor break or extend a run, and leave no text in the summary", async () => {
  const rows = tools(S1, 1, 4); rows.splice(2, 0, { minute: 2.5, event: "PostToolUse", session: S1, tool: "Write", excerpt: "SECRETPATHCANARY", paths: ["hidden/x.ts"] });
  const f = fixture(rows);
  const mcp = open(f, { denyPaths: ["hidden"] });
  try {
    const items = await mcp.tools.amem_timeline({ limit: 20 }) as Item[];
    expect(items).toHaveLength(1);
    expect(items[0]!.run!).toMatchObject({ count: 4, tools: [{ tool: "Bash", count: 4 }] });
    expect(JSON.stringify(items)).not.toContain("SECRETPATHCANARY"); expect(JSON.stringify(items)).not.toContain("Write");
  } finally { mcp.close(); }
});

test("expand:true returns the pre-change output for the same fixture; collapse returns fewer entries without another read", async () => {
  const f = fixture([...tools(S1, 1, 12), { minute: 13, event: "Stop", session: S1 }, ...tools(S2, 14, 6)], [{ minute: 5.5, text: "kept decision" }]);
  const mcp = open(f);
  try {
    for (const args of [{ limit: 8 }, { limit: 20 }, { limit: 5, since: at(10) }]) {
      const expanded = await mcp.tools.amem_timeline({ ...args, expand: true }) as Item[];
      // The pre-change algorithm: both readers at `limit`, merged newest first, cut at `limit`.
      const all = await mcp.tools.amem_timeline({ limit: 100, expand: true }) as Item[];
      const since = "since" in args ? Date.parse(args.since!) : -Infinity;
      const at_ = (item: Item) => Date.parse((item as unknown as { at?: string }).at ?? (item.capture as unknown as { at: string }).at);
      const curated = all.filter(item => item.source === "person" && at_(item) >= since).slice(0, args.limit), capture = all.filter(item => item.source === "capture" && at_(item) >= since).slice(0, args.limit);
      const old = [...curated, ...capture].sort((a, b) => at_(b) - at_(a)).slice(0, args.limit);
      expect(expanded).toEqual(old);
      expect(expanded.every(item => item.source !== "capture-run")).toBe(true);
    }
    const collapsed = await mcp.tools.amem_timeline({ limit: 8 }) as Item[];
    expect(collapsed.length).toBeLessThan(8);
    await expect(mcp.tools.amem_timeline({ expand: "yes" })).rejects.toThrow();
  } finally { mcp.close(); }
});

test("an id/since/limit caller receives only current shapes plus the documented capture-run shape; anchors still resolve", async () => {
  const f = fixture([...tools(S1, 1, 6), { minute: 7, event: "UserPromptSubmit", session: S1 }], [{ minute: 3.5, text: "anchor decision" }]);
  const mcp = open(f);
  try {
    for (const args of [{}, { limit: 5 }, { since: at(2) }, { id: f.ids[0]!, limit: 3 }]) {
      const items = await mcp.tools.amem_timeline(args) as Item[];
      for (const item of items) expect(["person", "capture", "capture-run"]).toContain(item.source);
    }
    const anchored = await mcp.tools.amem_timeline({ id: f.ids[0]!, limit: 3 }) as Item[];
    expect(anchored[0]!.id).toBe(f.ids[0]!);
  } finally { mcp.close(); }
});
