import { expect, test } from "bun:test";
import { jcodeJournalSampleFields } from "../scripts/jcode-journal-timing.ts";
import { appendMetrics, readMetrics } from "../src/memory/metrics.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("journal samples preserve nested marks and existing transcript fields", () => {
  const metric = { at: "2026-01-01T00:00:00Z", kind: "hook" as const, drainStartMs: 12, drained: 2, transcriptOffset: 100, transcriptStopReason: "deadline" as const,
    jcodeJournalTiming: { scanStartMs: 10, publishStartMs: 12, publishEndMs: 15, publishTotalMs: 3, scanEndMs: 20, metricSampleAtMs: 25 } };
  const fields = jcodeJournalSampleFields("jcodeJournal", metric, 30);
  expect(fields).toMatchObject({ drainStartMs: 12, drained: 2, transcriptOffset: 100, transcriptStopReason: "deadline", jcodeJournalTiming: metric.jcodeJournalTiming, metricSampleToParentReturnUpperBoundMs: 5 });
  expect(jcodeJournalSampleFields("jcode", metric, 30)).toEqual({});
  expect(jcodeJournalSampleFields("plain", metric, 30)).toEqual({});
});

test("absent, invalid and partial marks remain absent, not zero", () => {
  const base = { at: "2026-01-01T00:00:00Z", kind: "hook" as const };
  expect(jcodeJournalSampleFields("jcodeJournal", base, 30)).toEqual({ metricSampleToParentReturnUpperBoundMs: null });
  const result = jcodeJournalSampleFields("jcodeJournal", { ...base, jcodeJournalTiming: { scanStartMs: 10, scanEndMs: 5, publishStartMs: 12, publishTotalMs: 4, metricSampleAtMs: 40 } }, 30);
  expect(result).toEqual({ jcodeJournalTiming: { scanStartMs: 10, publishStartMs: 12, metricSampleAtMs: 40 }, metricSampleToParentReturnUpperBoundMs: null });
  const home = mkdtempSync(join(tmpdir(), "amem-jcode-metric-"));
  try { appendMetrics(home, [base]); expect(readMetrics(home)[0]).toEqual(base); }
  finally { rmSync(home, { recursive: true, force: true }); }
});
