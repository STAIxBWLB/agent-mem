import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateQuestion } from "../scripts/longmemeval-input.ts";
import { deriveRecordQuestion } from "../scripts/record-variant-fixture.ts";
import { runLongMemEval } from "../scripts/longmemeval.ts";
import { compareRecordRecall } from "../scripts/record-recall-compare.ts";

test("A/B seed forms retain strict input/gold/BM25 guards on a records-present fixture", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "amem-variant-recall-"));
  try {
    const source = JSON.parse(readFileSync(join(import.meta.dir, "fakes/longmemeval-three.json"), "utf8")) as unknown[];
    const derived = source.map(row => deriveRecordQuestion(validateQuestion(row)));
    expect(derived.reduce((sum, row) => sum + row.records, 0)).toBeGreaterThan(0);
    const input = join(scratch, "shared-derived.json");
    writeFileSync(input, JSON.stringify(derived.map(row => row.question)));
    const options = { input, sourceRoot: resolve(import.meta.dir, ".."), variant: "S", questionTimeoutMs: 5000 };
    const a = await runLongMemEval({ ...options, output: join(scratch, "a.json"), recordVariant: "a" });
    const b = await runLongMemEval({ ...options, output: join(scratch, "b.json"), recordVariant: "b" });
    expect(a.failed).toEqual([]); expect(b.failed).toEqual([]);
    expect(a.dataset.sha256).toBe(b.dataset.sha256);
    expect(a.recordFixture.records).toBeGreaterThan(0);
    expect(a.recordFixture.records).toBe(b.recordFixture.records);
    expect(a.recordFixture.seedSha256).not.toBe(b.recordFixture.seedSha256);
    expect(a.recordFixture.bm25Control).toBe("canonical-a-projection");
    const verdict = compareRecordRecall(a, b, { allowFixture: true });
    expect(verdict).toMatchObject({ complete: true, pass: true, scope: "fixture", rule: "strict-no-loss" });
    for (let index = 0; index < a.results.length; index++) {
      expect(a.results[index].gold).toEqual(b.results[index].gold);
      expect(a.results[index].rankings.bm25).toEqual(b.results[index].rankings.bm25);
      expect(a.results[index].rows).toEqual(b.results[index].rows);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 20_000);
