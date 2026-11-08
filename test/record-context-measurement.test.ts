import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";

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
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const text = readFileSync(reportFile, "utf8"), report = JSON.parse(text);
    expect(text).not.toContain("private-copy-canary"); expect(text).not.toContain(copy);
    expect(report.fixture.noLarger).toBe(true);
    for (const side of [report.realCopy.before, report.realCopy.after]) {
      expect(side).toMatchObject({ instructionBytes: 0, maximum: 500, intakeAttempted: false, formatterExportsOnly: true });
      expect(side.totalBytes).toBeLessThanOrEqual(500);
      expect(side.dropNoticeBytes).toBe(Buffer.byteLength("capture dropped: spool full (2)"));
    }
    expect(readFileSync(join(copy, "amem.config.json"), "utf8")).toBe(configBefore);
    expect(readFileSync(join(copy, "metrics.jsonl"), "utf8")).toBe(metricsBefore);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
