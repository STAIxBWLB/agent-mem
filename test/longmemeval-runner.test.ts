import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLongMemEval } from "../scripts/longmemeval.ts";

const sourceRoot = join(import.meta.dir, "..");
test("three-question retrieval fixture runs actual MCP, library and plain FTS without a judge", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-longmemeval-test-"));
  try {
    const report = await runLongMemEval({ input: join(import.meta.dir, "fakes/longmemeval-three.json"), output: join(root, "report.json"), sourceRoot, questionTimeoutMs: 5000 });
    expect(report.complete).toBe(true); expect(report.questions).toBe(3); expect(report.abstentions).toBe(1); expect(report.failed).toEqual([]);
    for (const backend of ["mcp", "library", "bm25"]) expect(report.metrics.overall[backend]).toMatchObject({ eligible: 2, success: 2, failure: 0 });
    for (const q of report.results.filter((q: any) => !q.abstention)) {
      expect(q.rows.stored).toBe(q.rows.input); expect(q.workerPeakKB).toBeGreaterThan(0); expect(q.mcpPeakKB).toBeGreaterThan(0);
    }
    expect(readFileSync(join(root, "report.json.md"), "utf8")).toContain("Per-question resources");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("gold IDs and question text never become searchable capture content", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-longmemeval-contamination-"));
  try {
    const token = "goldzzxyqcontaminationalpha", input = join(root, "input.json");
    writeFileSync(input, JSON.stringify([{ question_id: token, question_type: "single-session-user", question: token, answer: token,
      question_date: "2024-01-01T00:00:00Z", haystack_session_ids: [token], haystack_dates: ["2023-01-01T00:00:00Z"],
      haystack_sessions: [[{ role: "user", content: "ordinary public content", has_answer: true }]], answer_session_ids: [token] }]));
    const report = await runLongMemEval({ input, output: join(root, "report.json"), sourceRoot, questionTimeoutMs: 5000 });
    expect(report.failed).toEqual([]);
    for (const backend of ["mcp", "library", "bm25"]) expect(report.results[0].rankings[backend]).toEqual([]);
    expect(report.results[0].rows.retentionDays).toBeGreaterThan(365);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repeated session IDs keep every turn and have unambiguous receipt/gold ordinals", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-longmemeval-repeat-"));
  try {
    const input = join(root, "input.json"), turn = { role: "assistant", content: "precisionneedle public evidence", has_answer: true };
    writeFileSync(input, JSON.stringify([{ question_id: "repeat", question_type: "single-session-user", question: "precisionneedle",
      question_date: "2024-01-01T00:00:00Z", haystack_session_ids: ["same", "same"],
      haystack_dates: ["2023-12-01T00:00:00Z", "2023-12-01T00:00:00Z"], haystack_sessions: [[turn], [turn]], answer_session_ids: ["same"] }]));
    const report = await runLongMemEval({ input, output: join(root, "report.json"), sourceRoot, questionTimeoutMs: 5000 });
    expect(report.failed).toEqual([]); expect(report.results[0].rows).toMatchObject({ input: 2, stored: 2, duplicateSessionIds: 1 });
    expect(report.duplicateSessionIds).toBe(1); expect(report.upstreamNoUserTarget).toBe(1);
    expect(report.results[0].gold.corpusSessions).toEqual([{ sessionId: "same", turns: 2 }]);
    expect(report.results[0].gold.turns).toEqual([{ sessionId: "same", turnIndex: 0 }, { sessionId: "same", turnIndex: 1 }]);
    for (const backend of ["mcp", "library", "bm25"]) expect(report.metrics.overall[backend].turnRecallAt10).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an explicit pilot limit does not inspect a later unselected malformed question", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-longmemeval-limit-"));
  try {
    const questions = JSON.parse(readFileSync(join(import.meta.dir, "fakes/longmemeval-three.json"), "utf8"));
    const input = join(root, "input.json"); writeFileSync(input, JSON.stringify([questions[2], { malformed: true }]));
    const report = await runLongMemEval({ input, output: join(root, "report.json"), sourceRoot, maxQuestions: 1 });
    expect(report.complete).toBe(false); expect(report.fatal).toBeUndefined(); expect(report.questions).toBe(1); expect(report.abstentions).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a question timeout preserves already completed backends and reports unknown final Linux RSS", async () => {
  const { preserveCompleted } = await import("../scripts/longmemeval.ts");
  const q = JSON.parse(readFileSync(join(import.meta.dir, "fakes/longmemeval-three.json"), "utf8"))[0];
  const ranking = [{ sessionId: q.answer_session_ids[0], turnIndex: 0 }];
  const result = preserveCompleted(q, { id: q.question_id, type: q.question_type, rankings: { library: ranking, bm25: ranking }, workerPeakKB: 1234 }, "question time limit");
  expect(result.rankings.library).toEqual(ranking); expect(result.rankings.bm25).toEqual(ranking);
  expect(result.errors!.library).toBeUndefined(); expect(result.errors!.bm25).toBeUndefined(); expect(result.errors!.mcp).toBe("question time limit");
  expect(result.workerPeakKB).toBeNull(); expect(result.workerCheckpointPeakKB).toBe(1234); expect(result.workerPeakComplete).toBe(false);
});

test("deadline receipts retain only backends completed before the recorded limit", async () => {
  const { preserveCompleted } = await import("../scripts/longmemeval.ts");
  const q = JSON.parse(readFileSync(join(import.meta.dir, "fakes/longmemeval-three.json"), "utf8"))[0];
  const ranking = [{ sessionId: q.answer_session_ids[0], turnIndex: 0 }];
  const result = preserveCompleted(q, { id: q.question_id, type: q.question_type, rankings: { library: ranking, bm25: ranking, mcp: ranking },
    completedAt: { library: 90, bm25: 100, mcp: 101 }, workerPeakKB: 1234, workerPeakComplete: true }, "question time limit", 100);
  expect(result.rankings.library).toEqual(ranking); expect(result.rankings.bm25).toEqual(ranking); expect(result.rankings.mcp).toBeUndefined();
  expect(result.errors!.mcp).toContain("deadline"); expect(result.workerPeakKB).toBe(1234); expect(result.workerPeakComplete).toBe(true);
});


test("explicit question types scan the full dataset and report subset coverage", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-longmemeval-selection-"));
  try {
    const report = await runLongMemEval({ input: join(import.meta.dir, "fakes/longmemeval-three.json"), output: join(root, "report.json"), sourceRoot, questionTypes: ["multi-session"] });
    expect(report.complete).toBe(true); expect(report.questions).toBe(1);
    expect(report.selection).toEqual({ questionTypes: ["multi-session"], examined: 3, skippedByType: 2 });
    expect(report.results[0].type).toBe("multi-session"); expect(report.failed).toEqual([]);
    const missing = await runLongMemEval({ input: join(import.meta.dir, "fakes/longmemeval-three.json"), output: join(root, "missing.json"), sourceRoot, questionTypes: ["knowledge-update"] }).catch(() => null);
    expect(missing).toBeNull();
    expect(JSON.parse(readFileSync(join(root, "missing.json"), "utf8"))).toMatchObject({ complete: false, questions: 0, fatal: "LongMemEval: requested question type absent from dataset" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
