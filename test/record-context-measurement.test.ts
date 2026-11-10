import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { qualifyRecordContext, qualifyRecordContextFixture, type RecordContextProjection } from "../scripts/measure-record-context.ts";

test("read-only context measurement reuses native cap, opt-out and notice formatting without private output", () => {
  const scratch = mkdtempSync(join(tmpdir(), "amem-record-measure-test-")), parent = join(scratch, "copy"), copy = join(parent, "memory"), project = "record-measure-control";
  const capture = new CaptureStore({ memoryDir: copy, project });
  try { capture.append({ project, agent: "claude", event: "Record", paths: [], excerpt: "amem: decision | - | private-copy-canary" }); } finally { capture.close(); }
  writeFileSync(join(copy, "amem.config.json"), JSON.stringify({ records: false, briefBytes: 500 }));
  writeFileSync(join(copy, "metrics.jsonl"), [
    { at: new Date().toISOString(), kind: "hook", captureDropReason: "record_invalid", captureDrops: 20 },
    { at: new Date().toISOString(), kind: "hook", captureDropReason: "spool_full", captureDrops: 2 },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const reportFile = join(scratch, "report.json"), runtime = resolve(import.meta.dir, "..");
  const configBefore = readFileSync(join(copy, "amem.config.json"), "utf8"), metricsBefore = readFileSync(join(copy, "metrics.jsonl"), "utf8");
  try {
    const child = Bun.spawnSync([process.execPath, join(runtime, "scripts/measure-record-context.ts"), "--baseline", runtime, "--candidate", runtime,
      "--output", reportFile, "--copy", parent, "--project", project, "--cwd", scratch], { cwd: runtime, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
    const text = readFileSync(reportFile, "utf8"), report = JSON.parse(text);
    expect(text).not.toContain("private-copy-canary"); expect(text).not.toContain(copy);
    expect(report.fixture.noLarger).toBe(true);
    expect(report.fixture.variants).toMatchObject({ sameData: true, bytesDelta: -1, reservationBytes: 332,
      a: { instructionBytes: 332 }, b: { instructionBytes: 331 } });
    for (const side of [report.realCopy.before, report.realCopy.after]) {
      expect(side).toMatchObject({ instructionBytes: 0, maximum: 500, intakeAttempted: false, formatterExportsOnly: true });
      expect(side.totalBytes).toBeLessThanOrEqual(500);
      expect(side.dropNoticeBytes).toBe(Buffer.byteLength("capture dropped: spool full (2)"));
    }
    expect(readFileSync(join(copy, "amem.config.json"), "utf8")).toBe(configBefore);
    expect(readFileSync(join(copy, "metrics.jsonl"), "utf8")).toBe(metricsBefore);
    const bad = Bun.spawnSync([process.execPath, join(runtime, "scripts/measure-record-context.ts"), "--baseline", runtime, "--candidate", runtime,
      "--output", reportFile, "--copy", join(scratch, "private-path-canary"), "--project", project, "--cwd", scratch], { cwd: runtime, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stdout.toString())).toMatchObject({ complete: false, stage: "copy", cause: "copied-home input or projection was refused" });
    expect(bad.stdout.toString() + bad.stderr.toString()).not.toContain("private-path-canary");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});


const rawProjection = (): RecordContextProjection => ({ totalBytes: 1100, maximum: 1200, coverage: { work: "complete", capture: "partial" }, sections: { work: 1, capture: 2 }, events: { PostToolUse: 2 } });
const recordProjection = (): RecordContextProjection => ({ totalBytes: 900, maximum: 1200, coverage: { work: "complete", capture: "complete" }, sections: { work: 1, capture: 2 }, events: { Record: 2 } });

test("smaller header-only or unavailable candidate cannot qualify as Record context savings", () => {
  const before = rawProjection(), after = recordProjection();
  expect(qualifyRecordContextFixture(before, after, rawProjection())).toMatchObject({ complete: true, pass: true, noLarger: true, bytesDelta: -200 });
  const headerOnly = { ...after, totalBytes: 150, coverage: { work: "unavailable", capture: "unavailable" }, sections: { work: 0, capture: 0 }, events: {} };
  expect(qualifyRecordContextFixture(before, headerOnly, rawProjection())).toMatchObject({ complete: false, pass: false, noLarger: false });
  expect(qualifyRecordContextFixture(before, { ...after, coverage: { ...after.coverage, capture: "unavailable" } }, rawProjection())).toMatchObject({ complete: false, pass: false });
  expect(qualifyRecordContextFixture(before, { ...after, events: { PostToolUse: 2 } }, rawProjection())).toMatchObject({ complete: false, pass: false });
});

test("both raw controls must select seeded work and raw capture, and byte regressions remain failures", () => {
  const before = rawProjection(), after = recordProjection();
  for (const bad of [{ ...before, sections: { work: 0, capture: 2 } }, { ...before, sections: { work: 1, capture: 0 }, events: {} }, { ...before, events: { Record: 2 } }]) {
    expect(qualifyRecordContextFixture(bad, after, before)).toMatchObject({ complete: false, pass: false });
    expect(qualifyRecordContextFixture(before, after, bad)).toMatchObject({ complete: false, pass: false });
  }
  expect(qualifyRecordContextFixture(before, { ...after, totalBytes: 1150 }, before)).toMatchObject({ complete: true, pass: false, noLarger: false });
});

test("an observed empty copy can be measurable, but unavailable or inconsistent evidence cannot", () => {
  const empty = { ...rawProjection(), sections: { work: 0, capture: 0 }, events: {} };
  expect(qualifyRecordContext(empty)).toEqual({ complete: true });
  expect(qualifyRecordContext({ ...empty, coverage: { work: "complete", capture: "unavailable" } })).toMatchObject({ complete: false });
  expect(qualifyRecordContext({ ...empty, totalBytes: 0 })).toMatchObject({ complete: false });
  expect(qualifyRecordContext({ ...empty, events: { Record: 1 } })).toMatchObject({ complete: false });
});
