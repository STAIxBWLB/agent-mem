import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp, type MemoryMcp } from "../src/mcp-memory.ts";
import { appendMetrics, createPeakTracker, observeMcpPhase, metricsPath, processPeakRssKB, readCaptureDrops, readMetrics, type MetricSample } from "../src/memory/metrics.ts";
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
function session(f: ReturnType<typeof seeded>, peaks?: ReturnType<typeof createPeakTracker>): MemoryMcp {
  const created = createMemoryMcp({ cwd: f.root, base: f.memory, project: f.project, ...(peaks ? { peaks } : {}) });
  sessions.push(created); return created;
}
const samples = (memory: string): MetricSample[] => readMetrics(memory);
/** The read path hands its sample off, so a fixture waits for the write instead of reading the moment the call returns. */
const settled = async (memory: string, count = 1): Promise<MetricSample[]> => {
  for (let attempt = 0; attempt < 200; attempt++) { const rows = readMetrics(memory).filter(row => row.kind === "search"); if (rows.length >= count) return rows; await Bun.sleep(5); }
  return readMetrics(memory).filter(row => row.kind === "search");
};
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

  const written = readFileSync(metricsPath(f.memory), "utf8").trim().split("\n").map(line => JSON.parse(line) as MetricSample).filter(row => row.kind === "search");
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
  // not peaked higher already, and the current resident size is not a reliable floor: macOS reports the peak from
  // rusage while `memoryUsage().rss` is the live footprint. Fill a buffer larger than the recorded peak itself, which
  // makes the filled pages alone exceed every earlier peak on any host.
  const peakKB = processPeakRssKB() ?? Math.ceil(process.memoryUsage().rss / 1024);
  const held = Buffer.alloc((peakKB + 16 * 1024) * 1024, 1);
  await mcp.tools.amem_show({ id: f.id });
  expect(held.byteLength).toBeGreaterThan(peakKB * 1024);

  const rows = await settled(f.memory, 3);
  expect(rows.map(row => row.tool)).toEqual(["amem_search", "amem_timeline", "amem_show"]);
  for (const row of rows) { expect(row.kind).toBe("search"); expect(row.wallMs).toBeGreaterThan(0); expect(row.rssMB).toBeGreaterThan(0); }
  // The fill happened between calls, so the subsequent read must not claim it.
  expect(rows.at(-1)!.peakRaised).toBe(false);
  const peaks = rows.map(row => row.rssMB!);
  // From the second sample on a flag means this peak is above every earlier sample's, so the call that set a peak can
  // be named. The first sample is compared with the session baseline the wrapper reads before any call, which the
  // samples do not carry, so its flag is only a boolean here.
  expect(peaks.at(-1)).toBeGreaterThanOrEqual(peaks[0]!);
  expect(samples(f.memory).some(row => row.kind === "mcp-phase" && row.tool === "idle-gap")).toBe(true);
}, 30_000);

test("mixed metrics retain independent bounded windows and hook drop visibility", () => {
  const f = seeded(), at = new Date().toISOString();
  const hooks: MetricSample[] = Array.from({ length: 200 }, (_, i) => ({ at, kind: "hook", wallMs: i, captureDrops: 1, captureDropReason: "spool_full", brief: { work: "complete".repeat(20), curated: "complete", capture: "complete" } }));
  const reads: MetricSample[] = Array.from({ length: 200 }, (_, i) => ({ at, kind: "search", tool: "amem_search", wallMs: i + 0.123456789, rssMB: 40.123456789, peakRaised: false }));
  const phases: MetricSample[] = Array.from({ length: 800 }, (_, i) => ({ at, kind: "mcp-phase", tool: "preload", wallMs: i, rssMB: 50, peakRaised: false }));
  appendMetrics(f.memory, [...hooks, ...reads]);
  appendMetrics(f.memory, phases); // force the first byte-bounded trim
  const before = samples(f.memory).filter(row => row.kind !== "mcp-phase");
  appendMetrics(f.memory, phases);
  const after = samples(f.memory);
  expect(after.filter(row => row.kind !== "mcp-phase")).toEqual(before);
  expect(after.filter(row => row.kind === "hook")).toHaveLength(200);
  expect(after.filter(row => row.kind === "search")).toHaveLength(200);
  expect(after.filter(row => row.kind === "mcp-phase").length).toBeLessThanOrEqual(32);
  expect(statSync(metricsPath(f.memory)).size).toBeLessThanOrEqual(128 * 1024);
  const drops = readCaptureDrops(f.memory); expect(drops.readable).toBe(true);
  if (drops.readable) expect(drops.counts.spool_full).toBe(after.filter(row => row.kind === "hook").length);
  const inode = statSync(metricsPath(f.memory)).ino;
  appendMetrics(f.memory, [{ at, kind: "hook", wallMs: 1 }]);
  expect(statSync(metricsPath(f.memory)).ino).toBe(inode);
});

test("hook and search floods retain the other kind's bounded window", () => {
  const at = new Date().toISOString(), f = seeded(), g = seeded();
  const hook = (i: number): MetricSample => ({ at, kind: "hook", wallMs: i, rssMB: 10, brief: { work: "complete", curated: "complete", capture: "complete" } });
  const search = (i: number): MetricSample => ({ at, kind: "search", tool: "amem_search", wallMs: i, rssMB: 20, peakRaised: false });
  appendMetrics(f.memory, Array.from({ length: 200 }, (_, i) => hook(i)));
  appendMetrics(f.memory, Array.from({ length: 800 }, (_, i) => search(i)));
  const savedHooks = samples(f.memory).filter(row => row.kind === "hook");
  appendMetrics(f.memory, Array.from({ length: 800 }, (_, i) => search(i + 800)));
  expect(samples(f.memory).filter(row => row.kind === "hook")).toEqual(savedHooks);
  appendMetrics(g.memory, Array.from({ length: 200 }, (_, i) => search(i)));
  appendMetrics(g.memory, Array.from({ length: 800 }, (_, i) => hook(i)));
  const savedSearches = samples(g.memory).filter(row => row.kind === "search");
  appendMetrics(g.memory, Array.from({ length: 800 }, (_, i) => hook(i + 800)));
  expect(samples(g.memory).filter(row => row.kind === "search")).toEqual(savedSearches);
  expect(savedHooks.length).toBeGreaterThan(0); expect(savedSearches.length).toBeGreaterThan(0);
});

test("#485 AC4: a sample holds no query text, arguments, ids or paths", async () => {
  const f = seeded(`the canary body ${CANARY}`), mcp = session(f);
  await mcp.tools.amem_search({ query: CANARY });
  const rows = await settled(f.memory, 1);
  expect(rows).toHaveLength(1);
  expect(Object.keys(rows[0]!).filter(key => key !== "shared").sort()).toEqual(["at", "kind", "peakRaised", "rssMB", "tool", "wallMs"]);
  const text = JSON.stringify(rows[0]);
  for (const secret of [CANARY, f.id, f.project, PATH_CANARY, f.root]) expect(text).not.toContain(secret);
}, 30_000);

test("#485 review: the sample's wall time covers the recall preparation the caller waits for", async () => {
  const f = seeded(), mcp = session(f), delay = 250;
  const original = MemoryStore.prototype.beginRecallRead;
  let prepared = 0;
  // The seam the finding names: `beginRecallRead()` refreshes the index and prunes rows before the tool body runs, so its
  // cost is work the caller waits for. Making that preparation deliberately expensive proves the clock starts before it
  // instead of after the guarded result it reaches.
  MemoryStore.prototype.beginRecallRead = function (this: MemoryStore) {
    prepared += 1; Bun.sleepSync(delay);
    return original.call(this);
  };
  try {
    const result = await mcp.tools.amem_search({ query: "telemetry" });
    // The timed work produced the answer the call returned, so the span measured is the span that served it.
    expect(JSON.stringify(result)).toContain("ordinary note for read-tool telemetry");
  } finally { MemoryStore.prototype.beginRecallRead = original; }
  expect(prepared).toBe(1);
  const rows = await settled(f.memory, 1);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.wallMs).toBeGreaterThanOrEqual(delay);
}, 30_000);

test("#485 review: a trim races another process's appends without tearing a line", async () => {
  const f = seeded(), file = metricsPath(f.memory), script = join(f.root, "append-loop.ts");
  const ready = join(f.root, "writer-ready"), stop = join(f.root, "writer-stop");
  const batch = (offset: number): MetricSample[] => Array.from({ length: 800 }, (_, index) => ({ at: new Date(1_700_000_000_000 + offset + index).toISOString(),
    kind: "hook", wallMs: offset + index, rssMB: 10, brief: { work: "complete", curated: "complete", capture: "complete" } }));

  // The trim publishes a fully written sibling under the file's name, so a writer holding the old file keeps a
  // complete one and no append can land inside the replacement. Rewriting the live file in place is what tore a line.
  appendMetrics(f.memory, batch(0));
  const before = statSync(file).ino;
  appendMetrics(f.memory, batch(800));
  expect(statSync(file).ino).not.toBe(before);
  expect(readMetrics(f.memory).length).toBeGreaterThan(0);

  // A second process appends whole samples to the same file while this process appends past the bound, so trims land
  // among that writer's appends.
  writeFileSync(script, `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const [file, ready, stop] = process.argv.slice(2);
writeFileSync(ready, "");
let index = 0;
while (!existsSync(stop)) { appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind: "search", tool: "amem_search", wallMs: index++, rssMB: 1, peakRaised: false }) + "\\n"); await Bun.sleep(1); }
`, { mode: 0o600 });
  const writer = Bun.spawn([process.execPath, script, file, ready, stop], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(1);
    expect(existsSync(ready)).toBe(true);
    for (let round = 2; round < 302; round++) appendMetrics(f.memory, batch(round * 800));
  } finally { writeFileSync(stop, "", { mode: 0o600 }); }
  const stderr = await new Response(writer.stderr).text();
  await writer.exited;
  expect(stderr).toBe("");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  expect(lines.length).toBeGreaterThan(200);
  for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  // The other process's samples are in the window, so its appends really did overlap this file's trims.
  const searches = lines.map(line => JSON.parse(line) as MetricSample).filter(row => row.kind === "search");
  expect(searches.length).toBeGreaterThan(0);
  expect(searches.every(row => row.tool === "amem_search")).toBe(true);
  expect(samples(f.memory).length).toBeGreaterThan(200);
}, 30_000);

test("#485 review: a peak this host cannot report never fails or blocks a completed read", async () => {
  // The sampler a host answers with may throw; a window still opens and closes, crediting nothing.
  const peaks = createPeakTracker(() => { throw new Error("no peak on this host"); });
  const window = peaks.begin();
  expect(peaks.end(window)).toEqual({ raised: false });
  expect(peaks.end(peaks.begin())).toEqual({ raised: false });
}, 30_000);

test("#485 review: telemetry I/O that cannot land never holds a completed read", async () => {
  // A sample goes to disk only after the response is queued, and the write is asynchronous with a non-blocking open, so
  // a metrics path the writer cannot use is dropped instead of waited on. A FIFO with no reader is the shape that
  // holds a writer forever, which is what a completed read must never do.
  for (const shape of ["directory", "fifo"] as const) {
    const f = seeded(), mcp = session(f), file = metricsPath(f.memory);
    if (shape === "directory") mkdirSync(file);
    else expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
    const started = Date.now();
    const result = await mcp.tools.amem_search({ query: "telemetry" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(JSON.stringify(result)).toContain("ordinary note for read-tool telemetry");
    const writeStarted = Date.now();
    await mcp.tools.amem_remember({ text: "fixture candidate", kind: "finding" });
    expect(Date.now() - writeStarted).toBeLessThan(2000);
    await Bun.sleep(100);
    // The path is untouched: no sample was appended and nothing replaced the FIFO. Reading it back is answered as
    // absent rather than waited on, so `amem capacity` cannot be held either.
    expect(lstatSync(file).isFIFO()).toBe(shape === "fifo");
    expect(readMetrics(f.memory)).toEqual([]);
  }
}, 30_000);

test("#485 review: a peak set while two read calls overlap is credited to neither of them", () => {
  let peak = 100;
  const peaks = createPeakTracker(() => peak);
  const first = peaks.begin();
  peak = 300;
  const second = peaks.begin();
  // Either call could have raised this peak, so neither is named; both still record the peak they saw.
  expect(peaks.end(second)).toEqual({ peakKB: 300, raised: false });
  expect(peaks.end(first)).toEqual({ peakKB: 300, raised: false, shared: true });
  // The peak advanced anyway, so the next call is compared with reality and does not re-claim it.
  expect(peaks.end(peaks.begin())).toEqual({ peakKB: 300, raised: false });
  peak = 400;
  const afterGap = peaks.begin(); expect(afterGap.gapKB).toBe(400);
  peak = 450;
  expect(peaks.end(afterGap)).toEqual({ peakKB: 450, raised: true });
  // A call that refuses or throws records nothing, but it still advances the baseline it may have raised.
  peak = 500;
  peaks.abort(peaks.begin());
  expect(peaks.end(peaks.begin())).toEqual({ peakKB: 500, raised: false });
});

test("MCP phase samples cover failed reads and write tools without content", async () => {
  const f = seeded(CANARY); let peak = 100;
  const mcp = session(f, createPeakTracker(() => peak += 10));
  await expect(mcp.tools.amem_search({ query: "" })).rejects.toThrow();
  await mcp.tools.amem_remember({ text: CANARY, kind: "finding" });
  await mcp.tools.amem_work_state_write({ list: "fixture", fields: { status: "active" } });
  await expect(mcp.tools.amem_correct({ id: "invalid", proposedText: CANARY, reason: CANARY })).rejects.toThrow();
  let rows: MetricSample[] = [];
  for (let i = 0; i < 200; i++) { rows = readMetrics(f.memory).filter(row => row.kind === "mcp-phase"); if (rows.some(row => row.tool === "amem_correct")) break; await Bun.sleep(5); }
  expect(rows.map(row => row.tool)).toEqual(expect.arrayContaining(["failed:amem_search", "amem_remember", "amem_work_state_write", "amem_correct"]));
  for (const row of rows) expect(Object.keys(row).filter(key => key !== "shared").sort()).toEqual(["at", "kind", "peakRaised", "rssMB", "tool", "wallMs"]);
  for (const secret of [CANARY, f.id, f.project, f.root, PATH_CANARY]) expect(JSON.stringify(rows)).not.toContain(secret);
});

test("nested phase attribution is conservative across overlap", () => {
  let peak = 100; const tracker = createPeakTracker(() => peak);
  const read = tracker.begin(), phase = tracker.begin(read); peak = 200;
  expect(tracker.end(phase)).toEqual({ peakKB: 200, raised: true });
  expect(tracker.end(read)).toEqual({ peakKB: 200, raised: false, shared: true });
  const a = tracker.begin(), b = tracker.begin(); peak = 300;
  expect(tracker.end(a)).toMatchObject({ raised: false, shared: true }); expect(tracker.end(b)).toMatchObject({ raised: false, shared: true });
});


test("a raising phase survives 100 later non-raising phases", async () => {
  const f = seeded(); let peak = 100; const tracker = createPeakTracker(() => peak);
  const first = observeMcpPhase(f.memory, tracker, "amem_remember"); peak = 200; first();
  for (let i = 0; i < 100; i++) observeMcpPhase(f.memory, tracker, "amem_correct")();
  let phases: MetricSample[] = [];
  for (let i = 0; i < 200; i++) { phases = readMetrics(f.memory).filter(row => row.kind === "mcp-phase"); if (phases.length) break; await Bun.sleep(5); }
  expect(phases).toHaveLength(1); expect(phases[0]).toMatchObject({ tool: "amem_remember", rssMB: 200 / 1024, peakRaised: true });
});

test("an overlapping phase rise is recorded as shared", async () => {
  const f = seeded(); let peak = 100; const tracker = createPeakTracker(() => peak);
  const first = observeMcpPhase(f.memory, tracker, "amem_remember"), second = observeMcpPhase(f.memory, tracker, "amem_correct");
  peak = 300; first(); second();
  let phases: MetricSample[] = [];
  for (let i = 0; i < 200; i++) { phases = readMetrics(f.memory).filter(row => row.kind === "mcp-phase"); if (phases.length === 2) break; await Bun.sleep(5); }
  expect(phases).toHaveLength(2); expect(phases.every(row => row.shared === true && row.peakRaised === false)).toBe(true);
});
