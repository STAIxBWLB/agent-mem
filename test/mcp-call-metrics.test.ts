import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp, type MemoryMcp } from "../src/mcp-memory.ts";
import { appendMetrics, metricsPath, processPeakRssKB, readMetrics, type MetricSample } from "../src/memory/metrics.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";

/** #485: one bounded sample per completed `amem mcp` read-tool call, so capacity reports a live R3 reading. */
const roots: string[] = [], sessions: MemoryMcp[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const CANARY = "MCP-CALL-METRICS-CANARY-QUERY";
const PATH_CANARY = "src/never-read-by-telemetry.ts";
function seeded(text = "ordinary note for read-tool telemetry", about = [`path:${PATH_CANARY}`]) {
  const root = mkdtempSync(join(tmpdir(), "amem-call-metrics-")); roots.push(root);
  const memory = join(root, "memory"), project = memoryProjectKey(root);
  const store = new MemoryStore({ memoryDir: memory, deferPromotions: true });
  const id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", text, about, source: "person" });
  store.close();
  return { root, memory, project, id };
}
function session(f: ReturnType<typeof seeded>): MemoryMcp {
  const created = createMemoryMcp({ cwd: f.root, base: f.memory, project: f.project });
  sessions.push(created); return created;
}
const samples = (memory: string): MetricSample[] => readMetrics(memory);
const markerFree = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]) delete copy[key];
  return copy;
};

test("#485 AC1: a search served over a fake stdio client fills amem capacity's search reading", async () => {
  const f = seeded(), bin = join(import.meta.dir, "../bin/amem.js"), env = markerFree({ ...process.env, HOME: f.root, AMEM_HOME: f.memory });
  const child = Bun.spawn([process.execPath, bin, "mcp"], { cwd: f.root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    child.stdin.write([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "call-metrics", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "amem_search", arguments: { query: "telemetry" } } },
    ].map(frame => JSON.stringify(frame)).join("\n") + "\n");
    child.stdin.end();
    const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exit).toBe(0); expect(stdout).toContain("ordinary note for read-tool telemetry");
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }

  const written = readFileSync(metricsPath(f.memory), "utf8").trim().split("\n").map(line => JSON.parse(line) as MetricSample);
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ kind: "search", tool: "amem_search" });
  expect(written[0]!.wallMs).toBeGreaterThan(0); expect(written[0]!.rssMB).toBeGreaterThan(0); expect(typeof written[0]!.peakRaised).toBe("boolean");

  const capacity = Bun.spawnSync([process.execPath, bin, "capacity", "--json"], { cwd: f.root, env, stdout: "pipe", stderr: "pipe" });
  expect(capacity.exitCode).toBe(0);
  const report = JSON.parse(capacity.stdout.toString()) as { metrics: { searchP95Ms: number | null; searchRssMB: number | null } };
  expect(report.metrics.searchP95Ms).toBeGreaterThan(0); expect(report.metrics.searchRssMB).toBeGreaterThan(0);
}, 30_000);

test("#485 AC2: each read-tool call appends one named sample, and the call that set a peak is identifiable", async () => {
  const f = seeded(), mcp = session(f);
  await mcp.tools.amem_search({ query: "telemetry" });
  await mcp.tools.amem_timeline({ limit: 5 });
  // The peak is a process-lifetime high-water mark, so a fixed allocation raises it only while this test process has
  // not peaked higher already. Size the fill from the peak recorded so far: filling it puts resident memory about
  // 8 MB above every earlier peak, so the call after it is the one that did raise the peak on any host.
  const peakKB = processPeakRssKB(), residentKB = Math.round(process.memoryUsage().rss / 1024);
  const held = Buffer.alloc((Math.max(0, peakKB - residentKB) + 8 * 1024) * 1024, 1);
  await mcp.tools.amem_show({ id: f.id });
  expect(held.byteLength).toBeGreaterThanOrEqual(8 * 1024 * 1024);

  const rows = samples(f.memory);
  expect(rows.map(row => row.tool)).toEqual(["amem_search", "amem_timeline", "amem_show"]);
  for (const row of rows) { expect(row.kind).toBe("search"); expect(row.wallMs).toBeGreaterThan(0); expect(row.rssMB).toBeGreaterThan(0); }
  // The call after the sized fill is the identified raiser: its peak is above every earlier sample's.
  expect(rows.at(-1)!.peakRaised).toBe(true);
  const peaks = rows.map(row => row.rssMB!);
  // From the second sample on a flag means this peak is above every earlier sample's, so the call that set a peak can
  // be named. The first sample is compared with the session baseline the wrapper reads before any call, which the
  // samples do not carry, so its flag is only a boolean here.
  const raised = rows.slice(1).filter((_, offset) => peaks[offset + 1]! > Math.max(...peaks.slice(0, offset + 1)));
  expect(rows.slice(1).filter(row => row.peakRaised).map(row => row.tool)).toEqual(raised.map(row => row.tool));
}, 30_000);

test("#485 AC3: a flood of one kind never evicts the other kind's samples", () => {
  const hook = (index: number): MetricSample => ({ at: new Date(1_700_000_000_000 + index).toISOString(), kind: "hook", wallMs: index, rssMB: 10,
    brief: { work: "complete", curated: "complete", capture: "complete" }, recordInstructionBytes: 900, recordInstructionEstimatedTokens: 225 });
  const search = (index: number): MetricSample => ({ at: new Date(1_700_000_000_000 + index).toISOString(), kind: "search", tool: "amem_search", wallMs: index, rssMB: 20, peakRaised: false });
  const flood = (kind: "hook" | "search", count: number, offset: number) => Array.from({ length: count }, (_, index) => kind === "hook" ? hook(offset + index) : search(offset + index));

  // Search samples past the bound must not push the hook window out, and hook samples must not push the search window out.
  const searchesLast = seeded();
  appendMetrics(searchesLast.memory, flood("hook", 200, 0));
  appendMetrics(searchesLast.memory, flood("search", 400, 1000));
  const keptAfterSearches = samples(searchesLast.memory);
  expect(keptAfterSearches.filter(row => row.kind === "hook")).toHaveLength(200);
  expect(keptAfterSearches.filter(row => row.kind === "search")).toHaveLength(200);
  expect(keptAfterSearches.filter(row => row.kind === "search").map(row => row.wallMs)).toEqual(Array.from({ length: 200 }, (_, index) => 1200 + index));

  const hooksLast = seeded();
  appendMetrics(hooksLast.memory, flood("search", 200, 0));
  appendMetrics(hooksLast.memory, flood("hook", 400, 1000));
  const keptAfterHooks = samples(hooksLast.memory);
  expect(keptAfterHooks.filter(row => row.kind === "search")).toHaveLength(200);
  expect(keptAfterHooks.filter(row => row.kind === "hook")).toHaveLength(200);

  // The read window is per kind too: 200 hook samples in the tail cannot hide the newest search samples.
  const readsPerKind = seeded();
  appendMetrics(readsPerKind.memory, flood("hook", 400, 0));
  appendMetrics(readsPerKind.memory, flood("search", 5, 5000));
  const read = samples(readsPerKind.memory);
  expect(read.filter(row => row.kind === "search")).toHaveLength(5);
  expect(read.filter(row => row.kind === "hook")).toHaveLength(200);
});

test("#485 AC4: a sample holds no query text, arguments, ids or paths", async () => {
  const f = seeded(`the canary body ${CANARY}`), mcp = session(f);
  await mcp.tools.amem_search({ query: CANARY });
  const rows = samples(f.memory);
  expect(rows).toHaveLength(1);
  expect(Object.keys(rows[0]!).sort()).toEqual(["at", "kind", "peakRaised", "rssMB", "tool", "wallMs"]);
  const text = JSON.stringify(rows[0]);
  for (const secret of [CANARY, f.id, f.project, PATH_CANARY, f.root]) expect(text).not.toContain(secret);
}, 30_000);
