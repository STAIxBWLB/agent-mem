import { expect, test } from "bun:test";
import { deriveRecordQuestion, fixtureRecord, variantRecordLine } from "../scripts/record-variant-fixture.ts";
import { parseRecordLines } from "../src/hook-record.ts";
import type { LongMemEvalQuestion, LongMemEvalTurn } from "../scripts/longmemeval-input.ts";

function question(overrides: Partial<LongMemEvalQuestion> = {}): LongMemEvalQuestion {
  return {
    question_id: "q1", question_type: "single-session", question: "gold question", question_date: "2026-11-01",
    haystack_session_ids: ["other", "gold"], haystack_dates: ["2026-10-30", "2026-10-31"],
    haystack_sessions: [
      [{ role: "user", content: "decoy", has_answer: true }],
      [{ role: "user", content: "source fact 1\n\twith controls", has_answer: true }, { role: "assistant", content: "answer text", has_answer: false }, { role: "user", content: "source fact 3", has_answer: true }],
    ], answer_session_ids: ["gold"], ...overrides,
  };
}

test("inserts only source facts after eligible originals and preserves gold labels and order", () => {
  const input = question(), original = structuredClone(input);
  const out = deriveRecordQuestion(input);
  expect(out.records).toBe(2);
  const session = out.question.haystack_sessions[1]!;
  expect(session).toEqual([
    original.haystack_sessions[1]![0]!,
    { role: "assistant", content: "amem: finding | fixtures/longmemeval.txt#s1t0 | source fact 1 with controls", has_answer: false },
    original.haystack_sessions[1]![1]!,
    original.haystack_sessions[1]![2]!,
    { role: "assistant", content: "amem: finding | fixtures/longmemeval.txt#s1t2 | source fact 3", has_answer: false },
  ]);
  expect(out.question.haystack_sessions[0]).toEqual(original.haystack_sessions[0]);
  expect(out.question.question).toBe(original.question);
  expect(out.question.answer_session_ids).toEqual(original.answer_session_ids);
  expect(out.question.haystack_sessions.flat().filter((turn, index) => turn.role !== "assistant" || turn.has_answer !== false || !turn.content.startsWith("amem: ")).length).toBe(4);
  expect(Object.keys(out.question)).toEqual(Object.keys(original));
});

test("limits two fixtures, requires gold-session answer turns, and skips abstention", () => {
  const many = question({ haystack_sessions: [[{ role: "user", content: "wrong session", has_answer: true }], Array.from({ length: 5 }, (_, i) => ({ role: "user", content: `fact ${i}`, has_answer: true }))] });
  expect(deriveRecordQuestion(many).records).toBe(2);
  expect(deriveRecordQuestion(question({ question_id: "q_abs" }))).toMatchObject({ records: 0, skipped: 0 });
  const notEligible = question({ haystack_sessions: [[{ role: "user", content: "decoy", has_answer: true }], [{ role: "user", content: "no label" }]] });
  expect(deriveRecordQuestion(notEligible).records).toBe(0);
});

test("counts parser and secret-screen refusals without modifying the source", () => {
  const content = "api_key=sensitivevalue123";
  const input = question({ haystack_sessions: [[], [{ role: "user", content, has_answer: true }, { role: "user", content: "   \n\t", has_answer: true }]] });
  const out = deriveRecordQuestion(input);
  expect(out).toMatchObject({ records: 0, skipped: 2 });
  expect(out.question.haystack_sessions[1]).toEqual(input.haystack_sessions[1]);
});

test("fixture recognition requires one canonical assistant line and exact sentinel anchor", () => {
  const canonical: LongMemEvalTurn = { role: "assistant", content: "amem: finding | fixtures/longmemeval.txt#s2t4 | a source fact", has_answer: false };
  const record = fixtureRecord(canonical)!;
  expect(record).toMatchObject({ kind: "finding", anchors: ["fixtures/longmemeval.txt#s2t4"], text: "a source fact" });
  expect(fixtureRecord({ ...canonical, role: "user" })).toBeUndefined();
  expect(fixtureRecord({ ...canonical, content: `${canonical.content}\nother` })).toBeUndefined();
  expect(fixtureRecord({ ...canonical, content: "amem: finding | src/longmemeval.txt#s2t4 | a source fact" })).toBeUndefined();
  expect(fixtureRecord({ ...canonical, content: "original source assistant text" })).toBeUndefined();
});

test("A and B lines are deterministic, preserve record identity, and fit the B parser ceiling", () => {
  const record = fixtureRecord({ role: "assistant", content: `amem: finding | fixtures/longmemeval.txt#s0t0 | ${"f".repeat(225)}` })!;
  const a = variantRecordLine(record, "a", 0), bEven = variantRecordLine(record, "b", 0), bOdd = variantRecordLine(record, "b", 1);
  expect(variantRecordLine(record, "a", 99)).toBe(a);
  expect(variantRecordLine(record, "b", 0)).toBe(bEven);
  expect(bEven).toBe(`${a}; basis:test`);
  const textStart = a.lastIndexOf(" | ") + 3;
  expect(bOdd).toBe(`${a.slice(0, textStart)}? ${a.slice(textStart)}; basis:test`);
  expect(Array.from(bOdd).length).toBeLessThanOrEqual(300);
  expect(parseRecordLines(bOdd).records).toHaveLength(1);
});
