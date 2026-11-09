import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendRecordVariant, RECORD_VARIANTS_FILE, RECORD_VARIANTS_MAX_BYTES } from "../src/memory/record-variant-log.ts";
import { aggregateRecordVariants } from "../scripts/report-record-variants.ts";
const homes: string[] = [];
afterEach(() => { for (const base of homes.splice(0)) rmSync(base, { recursive: true, force: true }); });
const NOW = Date.parse("2026-11-10T00:00:00Z"), DAY = 86400_000;
function home() { const base = mkdtempSync(join(tmpdir(), "amem-variant-log-")); homes.push(base); return base; }
const sample = { at: new Date(NOW).toISOString(), kind: "hook" as const, recordVariant: "b" as const, recordSessions: 1, recordBriefBytes: 442 };
const rows = (base: string) => readFileSync(join(base, RECORD_VARIANTS_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line));
test("eight-day trim retains a busy week's observations and leaves general metrics unchanged", () => {
  const base = home(); writeFileSync(join(base, "metrics.jsonl"), "general-metrics-canary\n");
  appendRecordVariant(base, "SessionStart", sample, NOW - 9 * DAY);
  for (let day = 6; day >= 0; day--) for (let n = 0; n < 35; n++) appendRecordVariant(base, "SessionStart", sample, NOW - day * DAY + n);
  const got = rows(base);
  expect(got).toHaveLength(245);
  expect(got.every(row => Date.parse(row.at) >= NOW - 8 * DAY)).toBe(true);
  expect(aggregateRecordVariants(got).variants.b?.sessions).toBe(245);
  expect(readFileSync(join(base, "metrics.jsonl"), "utf8")).toBe("general-metrics-canary\n");
  expect(statSync(join(base, RECORD_VARIANTS_FILE)).mode & 0o077).toBe(0);
});
test("cap trim keeps the file bounded and reports lost coverage", () => {
  const base = home(), file = join(base, RECORD_VARIANTS_FILE);
  const line = JSON.stringify({ at: new Date(NOW).toISOString(), event: "Stop", variant: "a", recordTurns: 1, recordValidRecords: 0, recordBasisRecords: 0, recordUnverifiedRecords: 0, recordTurnsWithRecords: 0 }) + "\n";
  writeFileSync(file, line.repeat(Math.ceil(RECORD_VARIANTS_MAX_BYTES / line.length)), { mode: 0o600 });
  appendRecordVariant(base, "SessionStart", sample, NOW);
  expect(statSync(file).size).toBeLessThanOrEqual(RECORD_VARIANTS_MAX_BYTES);
  const got = rows(base), report = aggregateRecordVariants(got);
  expect(got.at(-1)).toMatchObject({ event: "SessionStart", variant: "b", capTrimmed: 1 });
  expect(report.window.capForcedTrim).toBe(true);
  expect(report.scanCoverage.complete).toBe(false);
});
test("only selected numeric fields enter one appended observation", () => {
  const base = home();
  appendRecordVariant(base, "Stop", { ...sample, recordTurns: 1, recordValidRecords: 2, excerpt: "private-canary", session: "private-session" } as typeof sample, NOW);
  const raw = readFileSync(join(base, RECORD_VARIANTS_FILE), "utf8");
  expect(raw).not.toContain("private-");
  expect(rows(base)).toEqual([{ at: new Date(NOW).toISOString(), event: "Stop", variant: "b", recordSessions: 1, recordTurns: 1, recordValidRecords: 2, recordBriefBytes: 442 }]);
});
