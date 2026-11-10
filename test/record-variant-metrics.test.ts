import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHook } from "../src/hooks.ts";
import { isHookTranscriptProgress } from "../src/hook-contract.ts";
import { captureSessionKey } from "../src/memory/capture-input.ts";
const readVariantMetrics = (base: string) => readFileSync(join(base, "record-variants.jsonl"), "utf8").trim().split("\n").map(line => { const row = JSON.parse(line); return { ...row, recordVariant: row.variant }; });
import { recordInstructionVariant } from "../src/hook-record.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture(mode: "a" | "b" | "alternate") {
  const f = hookFixture(); fixtures.push(f); mkdirSync(f.base, { recursive: true });
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ records: true }));
  writeFileSync(join(f.base, "record-instruction.json"), JSON.stringify({ instruction: mode }), { mode: 0o600 });
  return f;
}
for (const mode of ["a", "b", "alternate"] as const) test(`numeric ${mode} metrics use payload parity and count Stop separately from SessionEnd`, async () => {
  const f = fixture(mode), session_id = "variant-metric-session", expected = recordInstructionVariant(mode, captureSessionKey(session_id));
  const start = await runHook("SessionStart", { source: "resume", session_id }, { cwd: f.cwd, base: f.base }, { deadlineMs: 2000 });
  expect(readVariantMetrics(f.base).at(-1)).toMatchObject({ recordVariant: expected, recordSessions: 1, recordEnabled: 1, recordInstructionEmitted: 1,
    recordBriefBytes: Buffer.byteLength(start.output!.hookSpecificOutput.additionalContext) });
  const transcript_path = join(f.root, "transcript.jsonl"), canary = "record-body-canary";
  writeFileSync(transcript_path, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { id: "metric-message", role: "assistant", content: [
    { type: "text", text: `amem: finding | src/cache.ts | ? ${canary}; basis:test\namem: decision | - | retain anchors` },
  ] } }) + "\n");
  const input = { session_id, transcript_path, cwd: f.cwd };
  await runHook("Stop", input, { cwd: f.cwd, base: f.base }, { deadlineMs: 2000 });
  expect(readVariantMetrics(f.base).at(-1)).toMatchObject({ recordVariant: expected, recordTurns: 1, recordScanIncomplete: 0, recordTurnsWithRecords: 1,
    recordValidRecords: 2, recordBasisRecords: 1, recordUnverifiedRecords: 1 });
  await runHook("SessionEnd", input, { cwd: f.cwd, base: f.base }, { deadlineMs: 2000 });
  expect(readVariantMetrics(f.base).at(-1)).toMatchObject({ recordVariant: expected, recordTurns: 0, recordValidRecords: 0 });
  expect(readVariantMetrics(f.base).at(-1)!.recordTurnsWithRecords).toBeUndefined();
  expect(readFileSync(join(f.base, "metrics.jsonl"), "utf8")).not.toContain(canary);
  expect(readFileSync(join(f.base, "metrics.jsonl"), "utf8")).not.toContain(session_id);
  const journal = readFileSync(join(f.base, "record-variants.jsonl"), "utf8");
  const observations = journal.trim().split("\n").map(line => JSON.parse(line));
  expect(observations.map(row => row.event)).toEqual(["SessionStart", "Stop", "SessionEnd"]);
  expect(observations.every(row => row.variant === expected)).toBe(true);
  expect(observations[1]).toMatchObject({ recordValidRecords: 2, recordBasisRecords: 1, recordUnverifiedRecords: 1 });
  expect(journal).not.toContain(canary);
  expect(journal).not.toContain(session_id);
  const resource = JSON.parse(readFileSync(join(f.base, "metrics.jsonl"), "utf8").trim().split("\n").at(-1)!);
  expect(resource.recordVariant).toBeUndefined();
  expect(resource.recordSessions).toBeUndefined();
  expect(resource.recordValidRecords).toBeUndefined();
});

test("native metrics count the emitted instruction and omitted tiny-budget exposure separately", () => {
  const f = fixture("b");
  const result = f.runFunctional("SessionStart", { source: "resume", session_id: "native-b" });
  const text = JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext;
  expect(readVariantMetrics(f.base).at(-1)).toMatchObject({ recordVariant: "b", recordSessions: 1, recordBriefBytes: Buffer.byteLength(text), recordInstructionEmitted: 1 });
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ records: true, briefBytes: 150 }));
  f.runFunctional("SessionStart", { source: "resume", session_id: "native-b" });
  expect(readVariantMetrics(f.base).at(-1)).toMatchObject({ recordVariant: "b", recordSessions: 1, recordInstructionEmitted: 0, recordInstructionBytes: 0 });
});

test("worker progress accepts only complete bounded numeric Record counter groups", () => {
  const good = { offset: 12, recordValidRecords: 2, recordBasisRecords: 1, recordUnverifiedRecords: 1 };
  expect(isHookTranscriptProgress(good)).toBe(true);
  for (const bad of [{ ...good, recordBasisRecords: 3 }, { ...good, recordValidRecords: -1 }, { ...good, recordText: "private" },
    { offset: 12, recordValidRecords: 0 }, { ...good, recordUnverifiedRecords: Infinity }]) expect(isHookTranscriptProgress(bad)).toBe(false);
});


test("missing scan counts remain unknown while every accepted Stop is still a turn", async () => {
  const f = fixture("a");
  await runHook("Stop", { session_id: "without-transcript" }, { cwd: f.cwd, base: f.base }, { deadlineMs: 2000 });
  const sample = readVariantMetrics(f.base).at(-1)!;
  expect(sample).toMatchObject({ recordVariant: "a", recordTurns: 1, recordScanIncomplete: 1 });
  expect(sample.recordValidRecords).toBeUndefined();
  expect(sample.recordTurnsWithRecords).toBeUndefined();
});


test("policy-declined hook invocations retain units without fabricating parsed counts", async () => {
  const f = fixture("b"), options = { cwd: f.cwd, base: f.base, policy: { host: { screen: async () => false } } };
  await runHook("Stop", { session_id: "declined" }, options, { deadlineMs: 2000 });
  const stop = readVariantMetrics(f.base).at(-1)!;
  expect(stop).toMatchObject({ recordVariant: "b", recordTurns: 1, recordScanIncomplete: 1 });
  expect(stop.recordValidRecords).toBeUndefined();
  await runHook("SessionStart", { source: "resume", session_id: "declined" }, options, { deadlineMs: 2000 });
  expect(readVariantMetrics(f.base).at(-1)).toMatchObject({ recordVariant: "b", recordSessions: 1, recordInstructionEmitted: 0, recordBriefBytes: 0 });
});


test("metric metadata cannot invoke getters on a refused payload", async () => {
  const f = fixture("a"); let reads = 0;
  const input = Object.defineProperties({}, {
    source: { enumerable: true, get() { reads++; throw Error("source getter must not run"); } },
    session_id: { enumerable: true, get() { reads++; throw Error("identity getter must not run"); } },
  });
  await runHook("SessionStart", input, { cwd: f.cwd, base: f.base, policy: { host: { screen: async () => false } } }, { deadlineMs: 2000 });
  expect(reads).toBe(0);
});

test("a bounded scan with an unread Record journals incomplete coverage", async () => {
  const f = fixture("a"), transcript_path = join(f.root, "bounded-transcript.jsonl");
  const ordinary = JSON.stringify({ type: "user", message: { role: "user", content: "bounded ordinary transcript line" } }) + "\n";
  const tail = JSON.stringify({ type: "assistant", message: { id: "unread-record", role: "assistant", content: [{ type: "text", text: "amem: finding | - | unread tail Record" }] } }) + "\n";
  writeFileSync(transcript_path, ordinary.repeat(5000) + tail);
  await runHook("Stop", { session_id: "partial-turn", transcript_path, cwd: f.cwd }, { cwd: f.cwd, base: f.base }, { deadlineMs: 2000 });
  const sample = readVariantMetrics(f.base).at(-1)!;
  expect(sample).toMatchObject({ recordTurns: 1, recordScanIncomplete: 1, recordValidRecords: 0, recordTurnsWithRecords: 0 });
  const report = (await import("../scripts/report-record-variants.ts")).aggregateRecordVariants([sample]);
  expect(report.variants.a).toMatchObject({ turnShare: null, denominatorCounts: { exactStopTurns: 0 } });
  expect(report.scanCoverage.complete).toBe(false);
});
