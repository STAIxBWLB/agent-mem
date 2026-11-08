import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { compareRecordFixture, type RecordFixtureMeasurement } from "../scripts/measure-record-recall-fixture.ts";

function observed(rank = 1): RecordFixtureMeasurement {
  const metrics = { hitAt1: Number(rank === 1), hitAt10: 1, MRR: 1 / rank, recordRank: rank };
  return { scope: "synthetic-record-present-not-public-longmemeval", rows: 3, goldRows: 1,
    library: { ...metrics }, mcp: { ...metrics }, canonicalMcpProjection: true, canonicalLibraryProjection: true };
}

test("complete canonical Record rank evidence must show non-loss on both backends", () => {
  expect(compareRecordFixture(observed(2), observed(1))).toMatchObject({ complete: true, pass: true,
    delta: { library: { hitAt1: 1, hitAt10: 0, MRR: 0.5 }, mcp: { hitAt1: 1, hitAt10: 0, MRR: 0.5 } } });
  const loss = observed(); loss.mcp = observed(2).mcp;
  expect(compareRecordFixture(observed(), loss)).toMatchObject({ complete: true, pass: false });
  // Even unchanged rank 2 cannot establish the fixed candidate's intended first-Record ordering.
  expect(compareRecordFixture(observed(2), observed(2))).toMatchObject({ complete: true, pass: false });
});

test("missing Record, malformed metrics and failed canonical projections never become a passing zero", () => {
  for (const mutate of [
    (r: RecordFixtureMeasurement) => { r.mcp = { hitAt1: 0, hitAt10: 0, MRR: 0, recordRank: null }; },
    (r: RecordFixtureMeasurement) => { r.library.MRR = NaN; },
    (r: RecordFixtureMeasurement) => { r.library.hitAt1 = 0; },
    (r: RecordFixtureMeasurement) => { r.canonicalMcpProjection = false; },
    (r: RecordFixtureMeasurement) => { r.canonicalLibraryProjection = false; },
    (r: RecordFixtureMeasurement) => { r.rows = 2; },
  ]) {
    const candidate = observed(); mutate(candidate);
    expect(compareRecordFixture(observed(), candidate)).toMatchObject({ complete: false, pass: false });
    expect(compareRecordFixture(candidate, observed())).toMatchObject({ complete: false, pass: false });
  }
});

test("fixture CLI reports unavailable runtime as safe incomplete JSON and nonzero exit", () => {
  const script = resolve(import.meta.dir, "../scripts/measure-record-recall-fixture.ts");
  const child = Bun.spawnSync([process.execPath, script, "/nonexistent-fixture-path-canary/baseline", "/nonexistent-fixture-path-canary/candidate"], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(child.exitCode).toBe(1);
  expect(JSON.parse(child.stdout.toString())).toMatchObject({ schema: "agent-mem.record-recall-fixture/v1", complete: false, pass: false });
  expect(child.stdout.toString() + child.stderr.toString()).not.toContain("nonexistent-fixture-path-canary");
});
