import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMetrics, readMetrics } from "../src/memory/metrics.ts";
import { transcriptTiming } from "../scripts/transcript-timing.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

test("old metric rows remain readable and the 0.29 reader accepts new timing", async () => {
  const home = mkdtempSync(join(tmpdir(), "amem-metric-timing-"));
  try {
    const old = { at: "2026-01-01T00:00:00Z", kind: "hook" as const, wallMs: 2 };
    appendMetrics(home, [old, { ...old, transcriptTiming: { metricSampleAtMs: 12, killAtMs: 10, reapAtMs: 11 } }]);
    const rows = readMetrics(home);
    expect(rows[0]).toEqual(old);
    const oldReader = await import("../node_modules/@staix/agent-mem-v0290/src/memory/metrics.ts");
    expect(oldReader.readMetrics(home)).toEqual(rows);
    expect(transcriptTiming(rows[0], undefined, 15)).toEqual({ paired: false, reason: "missing-or-outside-invocation" });
    expect(transcriptTiming(rows[1], rows[0], 15)).toEqual({ paired: true, killToReapMs: 1, reapToMetricSampleMs: 1,
      metricSampleToParentReturnUpperBoundMs: 3, missing: [] });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("missing, stale, invalid or out-of-order marks do not invent an interval", () => {
  const base = { at: "2026-01-01T00:00:00Z", kind: "hook" as const };
  expect(transcriptTiming({ ...base, transcriptTiming: { metricSampleAtMs: 16 } }, undefined, 15).paired).toBe(false);
  const stale = { ...base, transcriptTiming: { metricSampleAtMs: 12 } };
  expect(transcriptTiming(stale, stale, 15)).toEqual({ paired: false, reason: "unchanged-metric" });
  expect(transcriptTiming({ ...base, transcriptTiming: { metricSampleAtMs: 12, killAtMs: 14, reapAtMs: 11 } }, undefined, 15))
    .toEqual({ paired: true, killToReapMs: null, reapToMetricSampleMs: 1, metricSampleToParentReturnUpperBoundMs: 3, missing: ["kill"] });
  expect(transcriptTiming({ ...base, transcriptTiming: { metricSampleAtMs: 12 } }, undefined, 15))
    .toEqual({ paired: true, killToReapMs: null, reapToMetricSampleMs: null, metricSampleToParentReturnUpperBoundMs: 3, missing: ["kill", "reap"] });
});

test("a real hook metric pairs with its own spawn and return", async () => {
  const f = hookFixture();
  try {
    await f.seed();
    const previous = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
    const started = performance.now();
    const result = f.run("Stop");
    const wall = performance.now() - started;
    expect(result.exitCode).toBe(0);
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
    expect(transcriptTiming(metric, previous, wall).paired).toBe(true);
  } finally { f.close(); }
});
