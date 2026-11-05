import { expect, test } from "bun:test";
import { classifyInboxBenchmark } from "../scripts/measure-ui-inbox.ts";

test("inbox benchmark timing is strict by default and report-only cannot hide correctness or invalid observations", () => {
  expect(classifyInboxBenchmark(true, { snapshotP95Ms: 999 })).toMatchObject({ correctnessPass: true, timingPass: true, pass: true });
  expect(classifyInboxBenchmark(true, { snapshotP95Ms: 1000 })).toMatchObject({ correctnessPass: true, timingPass: false, pass: false, timingFailures: ["snapshotP95Ms"] });
  expect(classifyInboxBenchmark(true, { snapshotP95Ms: 1000, controlP95Ms: 2000 }, true)).toMatchObject({ correctnessPass: true, timingPass: false, pass: true, timingFailures: ["snapshotP95Ms", "controlP95Ms"] });
  expect(classifyInboxBenchmark(false, { snapshotP95Ms: 1 }, true)).toMatchObject({ correctnessPass: false, pass: false });
  const invalid: Readonly<Record<string, number>>[] = [{}, { snapshotP95Ms: Number.NaN }, { snapshotP95Ms: Number.POSITIVE_INFINITY }, { snapshotP95Ms: -1 }];
  for (const timings of invalid)
    expect(classifyInboxBenchmark(true, timings, true)).toMatchObject({ correctnessPass: false, telemetryValid: false, pass: false });
});
