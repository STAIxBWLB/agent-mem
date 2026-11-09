import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { aggregateRecordVariants } from "../scripts/report-record-variants.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "record-report-")); dirs.push(dir); return dir; }

test("aggregates exact hook fields and includes SessionEnd records outside turn denominator", () => {
  const report = aggregateRecordVariants([
    { kind: "hook", recordVariant: "a", recordEnabled: 1, recordSessions: 1, recordInstructionEmitted: 1, recordBriefBytes: 412 },
    { kind: "hook", recordVariant: "a", recordEnabled: 1, recordTurns: 1, recordTurnsWithRecords: 1, recordValidRecords: 2, recordBasisRecords: 1, recordUnverifiedRecords: 1 },
    { kind: "hook", recordVariant: "a", recordEnabled: 1, recordTurns: 0, recordValidRecords: 3, recordBasisRecords: 2, recordUnverifiedRecords: 1 },
    { kind: "hook", recordVariant: "b", recordEnabled: 1, recordSessions: 0, recordInstructionEmitted: 0, recordBriefBytes: 0 },
  ]);
  expect(report.variants.a).toMatchObject({ sessions: 1, recordsPerSession: 5, turns: 1, observedTurns: 1, turnsWithRecords: 1, turnShare: 1, observedShare: 1, validRecords: 5, basisShare: 3 / 5, unverifiedShare: 2 / 5, meanBriefBytes: 412, disabledSessions: 0, instructionEmittedSessions: 1 });
  expect(report.variants.b).toMatchObject({ sessions: 0, recordsPerSession: null, turns: null, turnShare: null, disabledSessions: 0, instructionEmittedSessions: 0, meanBriefBytes: 0 });
});

test("keeps zero denominators null and missing Stop counters incomplete", () => {
  const report = aggregateRecordVariants([
    { kind: "hook", recordVariant: "a", recordSessions: 0, recordTurns: 1, recordValidRecords: 1 },
    { kind: "hook", recordVariant: "b", recordTurns: 1, recordValidRecords: 0, recordTurnsWithRecords: 0, recordBasisRecords: 0, recordUnverifiedRecords: 0 },
  ]);
  expect(report.variants.a).toMatchObject({ recordsPerSession: null, turnShare: null, observedShare: null, basisShare: null, meanBriefBytes: null });
  expect(report.variants.b).toMatchObject({ turnShare: 0, observedShare: 0, basisShare: null });
});

test("counts legacy, unattributed and malformed rows without partial arithmetic", () => {
  const report = aggregateRecordVariants([
    { kind: "hook", at: "old" }, { kind: "hook", recordVariant: "old", recordSessions: 9 }, null,
    { kind: "hook", recordVariant: "a", recordTurns: 1, recordValidRecords: -1, recordBasisRecords: 2, recordUnverifiedRecords: 1, recordTurnsWithRecords: 1 },
    { kind: "hook", recordVariant: "b", recordTurns: 1, recordValidRecords: 0, recordTurnsWithRecords: 1 },
  ]);
  expect(report).toMatchObject({ ignoredRows: 0, unknownRows: 2, malformedRows: 3, scanCoverage: { totalRows: 5, hookRows: 4, complete: false, unknownRows: 2, malformedRows: 3 } });
  expect(report.variants.a).toMatchObject({ turns: null, validRecords: null });
  expect(report.variants.b).toMatchObject({ turns: null, validRecords: null });
});

test("validates binary counters and requires a complete Stop counter group", () => {
  const report = aggregateRecordVariants([
    { kind: "hook", recordVariant: "a", recordSessions: 2, recordEnabled: 1 },
    { kind: "hook", recordVariant: "a", recordTurns: 1, recordTurnsWithRecords: 1, recordValidRecords: 1 },
    { kind: "hook", recordVariant: "b", recordTurns: 1, recordTurnsWithRecords: 2, recordValidRecords: 1, recordBasisRecords: 1, recordUnverifiedRecords: 0 },
    { kind: "hook", recordVariant: "b", recordTurns: 1, recordTurnsWithRecords: 1, recordValidRecords: 1, recordBasisRecords: 1, recordUnverifiedRecords: 0 },
  ]);
  expect(report.malformedRows).toBe(2);
  expect(report.incompleteRows).toBe(1);
  expect(report.variants.a).toMatchObject({ sessions: null, turnShare: null, observedShare: null, denominatorCounts: { sessions: null, allStopTurns: 1, observedStopTurns: 0, validRecords: 1, briefSamples: 0 } });
  expect(report.variants.b).toMatchObject({ turnShare: 1, denominatorCounts: { allStopTurns: 1, observedStopTurns: 1 } });
  expect(report.scanCoverage).toMatchObject({ complete: false, malformedRows: 2, incompleteRows: 1 });
  expect(report.retention).toContain("64KiB trim trigger, newest 200 on trim");
});

test("report JSON excludes arbitrary text, identifiers and paths", () => {
  const secret = "TEXT_CANARY native-session /private/home/file";
  const output = JSON.stringify(aggregateRecordVariants([{ kind: "hook", recordVariant: "a", recordSessions: 1, excerpt: secret, id: secret, path: secret }]));
  expect(output).not.toContain(secret);
  expect(output).not.toContain("native-session");
});

test("CLI reads bounded regular files without writing input and reports fixed errors", () => {
  const dir = temp(), file = join(dir, "metrics.jsonl"), cli = join(process.cwd(), "scripts/report-record-variants.ts");
  const row = JSON.stringify({ kind: "hook", recordVariant: "a", recordSessions: 1, recordTurns: 1, recordTurnsWithRecords: 1, recordValidRecords: 1, recordBasisRecords: 1, recordUnverifiedRecords: 0 });
  writeFileSync(file, `${row}\n`, { mode: 0o600 });
  const before = { size: statSync(file).size, mtimeMs: statSync(file).mtimeMs, content: Bun.file(file).text() };
  const good = spawnSync("bun", [cli, "--metrics", file], { encoding: "utf8" });
  expect(good.status).toBe(0);
  expect(JSON.parse(good.stdout).variants.a.sessions).toBe(1);
  expect({ size: statSync(file).size, mtimeMs: statSync(file).mtimeMs, content: Bun.file(file).text() }).toEqual(before);
  const missing = spawnSync("bun", [cli, "--metrics", join(dir, "missing")], { encoding: "utf8" });
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("Cannot read metrics file");
  expect(missing.stderr).not.toContain(dir);
  const link = join(dir, "link.jsonl"); symlinkSync(file, link);
  const linked = spawnSync("bun", [cli, "--metrics", link], { encoding: "utf8" });
  expect(linked.status).not.toBe(0);
  expect(linked.stderr).toContain("symlink");
  expect(linked.stderr).not.toContain(dir);
  const empty = join(dir, "empty.jsonl"); writeFileSync(empty, "");
  const emptyResult = spawnSync("bun", [cli, "--metrics", empty], { encoding: "utf8" });
  expect(emptyResult.status).not.toBe(0);
  expect(emptyResult.stderr).toContain("nonempty");
});
