import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp, type MemoryMcp } from "../src/mcp-memory.ts";
import { CONFIG_FILE } from "../src/memory/config.ts";
import { appendLifecycle } from "../src/memory/lifecycle.ts";
import type { StandalonePolicyOptions } from "../src/memory/policy.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "amem-work-guard-")); roots.push(root); return { root, base: join(root, "memory") }; };
type Work = { list: string; items: { task: string; fields: Record<string, unknown> }[] }[];
const MARKER = "verbotenword";
/** A pattern in the home config: the person's own policy, written after the server started. */
const tighten = (base: string) => writeFileSync(join(base, CONFIG_FILE), JSON.stringify({ piiPatterns: [MARKER] }));

async function seed(mcp: MemoryMcp, rows: { list: string; task: string }[]): Promise<void> {
  for (const row of rows) await mcp.tools.amem_work_state_write({ list: row.list, fields: { task: row.task, status: "doing" } });
}
const spread = (count: number, lists: number, task = (list: number, index: number) => `work ${list}/${index}`) =>
  Array.from({ length: count }, (_, index) => ({ list: `queue-${index % lists}`, task: task(index % lists, index) }));

test("a work read runs the full placement guard a constant number of times per call, not once per row", async () => {
  const counts: number[] = [], items: number[] = [];
  for (const [count, lists] of [[10, 2], [2000, 50]] as const) {
    const { root, base } = fixture();
    let guards = 0;
    const mcp = createMemoryMcp({ cwd: root, base, project: "work-guard", assertCurrent: () => { guards++; } });
    try {
      await seed(mcp, spread(count, lists));
      guards = 0;
      const read = await mcp.tools.amem_work_state_read({}) as Work;
      counts.push(guards);
      items.push(read.reduce((sum, view) => sum + view.items.length, 0));
    } finally { mcp.close(); }
  }
  expect(items).toEqual([10, 2000]);
  // One guard at entry and one after the read, whatever the row count: the per-row callback takes the cheap path.
  expect(counts).toEqual([2, 2]);
});

test("a binding change made during the read is refused at the post-read guard", async () => {
  const { root, base } = fixture();
  let guards = 0, armed = false;
  const mcp = createMemoryMcp({ cwd: root, base, project: "work-guard", assertCurrent: () => {
    if (!armed) return;
    guards++;
    if (guards === 2) appendLifecycle(base, { op: "archive", key: "work-guard", actor: "test", machine: "test-machine" });
  } });
  try {
    await seed(mcp, spread(3, 1));
    armed = true;
    await expect(mcp.tools.amem_work_state_read({})).rejects.toThrow(/memory operation unavailable/);
    // The read ran to completion and the second guard is the one that refused, so the refusal is the post-read check.
    expect(guards).toBe(2);
  } finally { mcp.close(); }
});

test("a session that stops being permitted refuses that row inside the call", async () => {
  const { root, base } = fixture();
  let allowed = true, armed = false;
  const policy: StandalonePolicyOptions = { host: { screen: async value => {
    const task = (value as { fields?: { task?: unknown } } | null)?.fields?.task;
    // The middle row is declined while it is being read; the per-row guard turns that into a dropped row, and the
    // call itself stands, which is what proves the cheap per-row arm runs once per row.
    if (armed && task === "work 0/1") allowed = false;
    if (armed && task === "work 0/2") allowed = true;
    return true;
  } } };
  const mcp = createMemoryMcp({ cwd: root, base, project: "work-guard", policy, allowed: () => allowed });
  try {
    await seed(mcp, spread(3, 1));
    armed = true;
    const read = await mcp.tools.amem_work_state_read({}) as Work;
    expect(read.flatMap(view => view.items.map(item => item.task))).toEqual(["work 0/0", "work 0/2"]);
  } finally { mcp.close(); }
});

test("a closed session refuses its work read", async () => {
  const { root, base } = fixture();
  const mcp = createMemoryMcp({ cwd: root, base, project: "work-guard" });
  await seed(mcp, spread(2, 1));
  mcp.close();
  await expect(mcp.tools.amem_work_state_read({})).rejects.toThrow(/memory operation unavailable/);
});

test("a policy tightened after the server started hides the row it now declines", async () => {
  const { root, base } = fixture();
  const mcp = createMemoryMcp({ cwd: root, base, project: "work-guard" });
  try {
    await seed(mcp, [{ list: "queue-0", task: "plain work item" }, { list: "queue-0", task: `${MARKER} item` }]);
    tighten(base);
    const read = await mcp.tools.amem_work_state_read({}) as Work;
    const tasks = read.flatMap(view => view.items.map(item => item.task));
    expect(tasks).toEqual(["plain work item"]);
  } finally { mcp.close(); }
});

test("a policy changed during the read refuses the call, and each call screens with its own snapshot", async () => {
  const { root, base } = fixture();
  let armed = false, held = false, screened = 0;
  let enter!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const policy: StandalonePolicyOptions = { host: { screen: async () => {
    if (armed) { screened++; if (!held) { held = true; enter(); await gate; } }
    return true;
  } } };
  const mcp = createMemoryMcp({ cwd: root, base, project: "work-guard", policy });
  try {
    await seed(mcp, [{ list: "queue-0", task: "plain work item" }, { list: "queue-0", task: `${MARKER} item` }]);
    armed = true;
    const first = mcp.tools.amem_work_state_read({});
    await inside;
    tighten(base);
    // A second call started after the tighten screens with its own snapshot, while the first is still inside its read.
    const second = await mcp.tools.amem_work_state_read({}) as Work;
    expect(second.flatMap(view => view.items.map(item => item.task))).toEqual(["plain work item"]);
    release();
    await expect(first).rejects.toThrow(/memory operation unavailable/);
    // The first call kept screening under its own snapshot instead of re-reading the tightened policy per row.
    expect(screened).toBeGreaterThanOrEqual(2);
  } finally { mcp.close(); }
});
