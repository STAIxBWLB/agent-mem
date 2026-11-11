import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { PHASE_SLOT_BYTES, PHASE_SLOTS, transcriptPhaseAnchors, transcriptPhasePreload, instrumentTranscriptSource, readTranscriptPhases, type TranscriptPhaseRow } from "./fakes/transcript-phase-preload.ts";
import { phaseProjection, phaseWorkload, TRANSCRIPT_PHASE_LIMITS } from "../scripts/measure-transcript-phases.ts";

test("all transcript preload anchors match exactly once, including dormant paths, and compile", () => {
  for (const [file, anchors] of Object.entries(transcriptPhaseAnchors)) {
    const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
    const rendered = instrumentTranscriptSource(file, source);
    expect(() => new Bun.Transpiler({ loader: file.endsWith(".js") ? "js" : "ts" }).transformSync(rendered)).not.toThrow();
    for (const anchor of anchors) {
      expect(source.split(anchor.anchor)).toHaveLength(2);
      expect(() => instrumentTranscriptSource(file, source.replace(anchor.anchor, ""))).toThrow(file);
      expect(() => instrumentTranscriptSource(file, source + anchor.anchor)).toThrow(file);
    }
  }
});

test("phase workload retains the strict budget's byte bound and summary population", () => {
  const f = hookFixture();
  try {
    for (const event of ["Stop", "SessionEnd", "StopBurst"] as const) {
      const workload = phaseWorkload(f, event, 1, "2026-11-11T00:00:00.000Z");
      const data = readFileSync(workload.file, "utf8");
      expect(data.length).toBeGreaterThanOrEqual(256 * 1024); expect(data.length).toBeLessThan(256 * 1024 + 1000);
      expect(workload.expected.size).toBe(event === "StopBurst" ? 103 : 3);
      expect(data).toContain('"isCompactSummary":true'); expect(data).toContain('"subtype":"away_summary"');
    }
    expect(TRANSCRIPT_PHASE_LIMITS.followUps).toBe(64);
    const gate = readFileSync(join(import.meta.dir, "../scripts/measure-transcript-budget.ts"), "utf8");
    expect(gate).not.toContain("transcriptPhase"); expect(gate).not.toContain("BUN_OPTIONS");
  } finally { f.close(); }
});

function slot(row: Partial<TranscriptPhaseRow>): Buffer {
  const data = Buffer.alloc(PHASE_SLOT_BYTES, 32); data.write(JSON.stringify(row)); data[data.length - 1] = 10; return data;
}
const numeric: TranscriptPhaseRow = { phase: 1, pid: 42, ppid: 1, role: 0, count: 1, firstAt: 10, lastAt: 11, firstUser: 1, lastUser: 2, firstSystem: 1, lastSystem: 2, value: 0, observerMs: 0.1, loaderMs: 0.2 };
test("fixed-slot receipts reject torn, oversized and nonnumeric/renamed fields instead of inventing timing", () => {
  const f = hookFixture(), dir = join(f.root, "slots"); mkdirSync(dir);
  const file = join(dir, "42.slots"), content = (row: Partial<TranscriptPhaseRow>) => Buffer.concat([Buffer.alloc(PHASE_SLOT_BYTES), slot(row)]);
  try {
    writeFileSync(file, content(numeric)); expect(readTranscriptPhases(dir)).toEqual([numeric]);
    const { firstAt: _, ...renamed } = numeric;
    for (const row of [{ ...renamed, unexpected: 10 }, { ...numeric, value: "private" }, { ...numeric, lastUser: -1 }, { ...numeric, ppid: -1 }]) {
      writeFileSync(file, content(row as Partial<TranscriptPhaseRow>)); expect(() => readTranscriptPhases(dir)).toThrow("numeric receipt");
    }
    writeFileSync(file, content(numeric).subarray(0, -1)); expect(() => readTranscriptPhases(dir)).toThrow("bound exceeded");
    writeFileSync(file, Buffer.alloc(PHASE_SLOT_BYTES * PHASE_SLOTS + 1)); expect(() => readTranscriptPhases(dir)).toThrow("bound exceeded");
  } finally { f.close(); }
});

test("completed slots survive a killed observer without fabricating exit or complete intervals", () => {
  const f = hookFixture(), observer = transcriptPhasePreload(f.root);
  try {
    const code = "globalThis.__amemTranscriptPhase(55,1);process.kill(process.pid,'SIGKILL');";
    const result = Bun.spawnSync([process.execPath, "--preload", observer.preload, "-e", code], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(result.signalCode).toBe("SIGKILL");
    const rows = readTranscriptPhases(observer.directory);
    expect(rows.some(row => row.phase === 55)).toBe(true); expect(rows.some(row => row.phase === 49)).toBe(false);
    expect(phaseProjection(rows, 0, result.pid).firstDrainToMetricMs).toBeNull();
    expect(phaseProjection(rows, 0, result.pid).processes[0]!.exitObserved).toBe(false);
  } finally { f.close(); }
});

test("a known worker close stall is bracketed by real wall and CPU receipts through the original cleanup and metric path", async () => {
  const f = hookFixture();
  try {
    await f.seed(); const workload = phaseWorkload(f, "Stop", 1, new Date().toISOString()), observer = transcriptPhasePreload(f.root);
    const map = JSON.parse(readFileSync(observer.map, "utf8")) as Record<string, { contents: string }>;
    const capture = Object.values(map).find(row => row.contents.includes("export class CaptureStore"))!;
    expect(capture.contents.split("this.db.close();")).toHaveLength(2);
    capture.contents = capture.contents.replace("this.db.close();", "Bun.sleepSync(270);this.db.close();");
    writeFileSync(observer.map, JSON.stringify(map));
    const origin = performance.timeOrigin + performance.now();
    const result = f.runFunctional("Stop", { session_id: workload.session, transcript_path: workload.file }, { BUN_OPTIONS: `--preload=${observer.preload}` }, 2000);
    expect(result.exitCode, result.stderr.toString()).toBe(0); expect(result.stdout.length).toBe(0);
    expect(readFileSync(observer.failure, "utf8")).toBe("");
    const rows = readTranscriptPhases(observer.directory), report = phaseProjection(rows, origin, result.pid);
    for (const id of [9,10,11,12,13,14,15,18,19,22,23,24,25,26,27,35,36,44,45,46,47,48,55])
      expect(rows.some(row => row.phase === id), `missing phase ${id}`).toBe(true);
    expect(report.intervals.find(row => row.start === "capture-close-start")!.firstMs).toBeGreaterThanOrEqual(250);
    expect(report.firstDrainToMetricMs).toBeGreaterThanOrEqual(250);
    expect(report.truncated).toBe(false); expect(readdirSync(observer.directory).length).toBe(2);
    expect(rows.every(row => Number.isFinite(row.lastUser) && row.lastUser >= row.firstUser)).toBe(true);
  } finally { f.close(); }
});


test("native bootstrap import, final metric write and exit are visible without a deadline override", () => {
  const f = hookFixture(), observer = transcriptPhasePreload(f.root);
  try {
    const result = f.run("Stop", { prompt: "public native phase control" }, { BUN_OPTIONS: `--preload=${observer.preload}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(observer.failure, "utf8")).toBe("");
    const rows = readTranscriptPhases(observer.directory, result.pid);
    for (const phase of [1,2,3,4,5,6,44,45,46,47,48,49,50]) expect(rows.some(row => row.phase === phase), `missing phase ${phase}`).toBe(true);
  } finally { f.close(); }
});
test("a source drift receipt names its file even when the native bin catches the import error", () => {
  const f = hookFixture(), observer = transcriptPhasePreload(f.root);
  try {
    const map = JSON.parse(readFileSync(observer.map, "utf8")) as Record<string, { file: string; hash: string }>;
    Object.values(map).find(row => row.file === "src/hooks.ts")!.hash = "changed";
    writeFileSync(observer.map, JSON.stringify(map));
    const result = f.run("Stop", {}, { BUN_OPTIONS: `--preload=${observer.preload}` });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(observer.failure, "utf8")).toContain("src/hooks.ts");
  } finally { f.close(); }
});
