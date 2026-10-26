import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashLongMemEvalFile, parseBenchmarkDate, readLongMemEvalQuestions, validateQuestion } from "../scripts/longmemeval-input.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(content: string | Buffer) {
  const root = mkdtempSync(join(tmpdir(), "amem-lme-input-")); roots.push(root);
  const target = join(root, "input.json"); writeFileSync(target, content); return target;
}
const date = "2023/06/14 (Wed) 19:43";
function question(id = "question-1") {
  return { question_id: id, question_type: "single-session-user", question: "어떤 공개 자료인가요?", question_date: date,
    haystack_session_ids: ["session-1"], haystack_dates: [date], haystack_sessions: [[{ role: "user", content: '공개 자료 😀 { [ ] } "quote" \\ slash', has_answer: true }]],
    answer_session_ids: id.endsWith("_abs") ? [] : ["session-1"], answer: "ignored benchmark label" as string | number };
}
async function collect(target: string, options?: { chunkBytes?: number; maxQuestionBytes?: number }) {
  const out = []; for await (const item of readLongMemEvalQuestions(target, options)) out.push(item); return out;
}

test("benchmark dates are UTC and reject invalid fields instead of rolling over", () => {
  const expected = Date.UTC(2023, 5, 14, 19, 43);
  expect(parseBenchmarkDate(date)).toBe(expected);
  expect(parseBenchmarkDate("2023-06-14T19:43:00Z")).toBe(expected);
  expect(parseBenchmarkDate("2023-06-14T21:43:00+02:00")).toBe(expected);
  expect(parseBenchmarkDate("2023-06-14T15:13:00-04:30")).toBe(expected);
  expect(parseBenchmarkDate("2023-06-14T19:43Z")).toBe(expected);
  expect(parseBenchmarkDate("2023-06-14T19:43:00.1Z")).toBe(expected + 100);
  expect(parseBenchmarkDate("2023-06-14T19:43:00.123Z")).toBe(expected + 123);
  expect(parseBenchmarkDate("2023-06-14")).toBe(Date.UTC(2023, 5, 14));
  expect(parseBenchmarkDate("2000/02/29 (Tue) 00:00")).toBe(Date.UTC(2000, 1, 29));
  expect(new Date(parseBenchmarkDate("0099-01-01T00:00:00Z")).getUTCFullYear()).toBe(99);
  for (const input of ["2023/06/14 (Tue) 19:43", "2023/6/14 (Wed) 19:43", "1900/02/29 (Thu) 00:00", "2023-02-29", "2023-02-30",
    "2023-00-01", "2023-13-01", "2023-01-00", "2023-01-32", "2023-06-14T24:00:00Z", "2023-06-14T19:60:00Z",
    "2023-06-14T19:43:60Z", "2023-06-14T19:43:00+24:00", "2023-06-14T19:43:00+00:60", "2023-06-14T19:43:00",
    "2023-06-14T19:43:00.1234Z", " June 14 2023 ", date + " "]) expect(() => parseBenchmarkDate(input)).toThrow("invalid date");
});

test("question validation keeps only typed inputs, arbitrary bounded role labels and boolean answer markers", () => {
  const raw = question(); raw.answer = 123;
  raw.haystack_sessions[0]!.push({ role: "observer; not executable", content: "public observation", has_answer: false });
  const parsed = validateQuestion({ ...raw, ignored: { deeply: [{ text: 'nested escaped " ] } [ { \\ text' }] } });
  expect(parsed).not.toHaveProperty("answer"); expect(parsed).not.toHaveProperty("ignored");
  expect(parsed.haystack_sessions[0]![1]).toEqual({ role: "observer; not executable", content: "public observation", has_answer: false });
  expect(validateQuestion(question("question-abs_abs")).answer_session_ids).toEqual([]);
  const withoutMarker = question(); delete (withoutMarker.haystack_sessions[0]![0] as { has_answer?: boolean }).has_answer;
  expect(validateQuestion(withoutMarker).haystack_sessions[0]![0]).not.toHaveProperty("has_answer");
});

test("schema validation checks alignment, gold membership, dates and bounded metadata", () => {
  const mutations: [string, (raw: any) => void][] = [
    ["alignment", raw => { raw.haystack_dates = []; }],
    ["missing gold", raw => { raw.answer_session_ids = []; }],
    ["missing from haystack", raw => { raw.answer_session_ids = ["missing-private-marker"]; }],
    ["question_date", raw => { raw.question_date = "2023-02-30"; }],
    ["haystack_dates", raw => { raw.haystack_dates[0] = "unknown-private-date"; }],
    ["question", raw => { raw.question = "x".repeat(64 * 1024 + 1); }],
    ["question_id", raw => { raw.question_id = "x".repeat(4097); }],
    ["turn role", raw => { raw.haystack_sessions[0][0].role = "x".repeat(65); }],
    ["has_answer", raw => { raw.haystack_sessions[0][0].has_answer = "true"; }],
    ["has_answer", raw => { raw.haystack_sessions[0][0].has_answer = undefined; }],
    ["haystack turn", raw => { raw.haystack_sessions[0][0].content = {}; }],
    ["haystack session", raw => { raw.haystack_sessions[0] = {}; }],
    ["answer_session_ids", raw => { raw.answer_session_ids = Array(1); }],
    ["haystack session", raw => { raw.haystack_sessions = Array(1); }],
    ["haystack turn", raw => { raw.haystack_sessions[0] = Array(1); }],
  ];
  for (const [reason, mutate] of mutations) {
    const raw = question(); mutate(raw); expect(() => validateQuestion(raw)).toThrow(reason);
  }
  const boundary = question(); boundary.question = "x".repeat(64 * 1024);
  expect(validateQuestion(boundary).question).toHaveLength(64 * 1024);
  boundary.question = "한".repeat(21845); expect(Buffer.byteLength(validateQuestion(boundary).question)).toBe(65535);
  boundary.question += "한"; expect(() => validateQuestion(boundary)).toThrow("invalid question");
  const withheld = { ...question("question_abs"), answer_session_ids: ["withheld-label-session"] };
  expect(validateQuestion(withheld).answer_session_ids).toEqual(["withheld-label-session"]);
  expect(() => validateQuestion({ ...withheld, question_id: "ordinary-question" })).toThrow("missing from haystack");
});

test("duplicate background session entries and gold labels retain their original occurrences", () => {
  const raw = question("duplicate-background");
  raw.haystack_session_ids.push("session-1");
  raw.haystack_dates.push("2023/06/15 (Thu) 19:43");
  raw.haystack_sessions.push(raw.haystack_sessions[0]!.map(turn => ({ ...turn })));
  raw.answer_session_ids.push("session-1");
  const parsed = validateQuestion(raw);
  expect(parsed.haystack_session_ids).toEqual(["session-1", "session-1"]);
  expect(parsed.haystack_dates).toEqual([date, "2023/06/15 (Thu) 19:43"]);
  expect(parsed.haystack_sessions).toEqual(raw.haystack_sessions);
  expect(parsed.haystack_sessions).toHaveLength(2);
  expect(parsed.answer_session_ids).toEqual(["session-1", "session-1"]);
});

test("object blocks coalesce large text and reset before the following question", async () => {
  const first = question("large"), second = question("next");
  first.haystack_sessions[0]![0]!.content = "공개 { } [ ] ".repeat(8000);
  const target = file(JSON.stringify([first, second]));
  expect(await collect(target, { chunkBytes: 1024 })).toEqual([validateQuestion(first), validateQuestion(second)]);
});

for (const chunkBytes of [1, 2, 3, 4, 5, 6, 7]) test(`array reader preserves three questions across ${chunkBytes}-byte UTF-8 and escape boundaries`, async () => {
  const first = question("first"), second = question("second"), third = question("third_abs"); second.answer = 456;
  const raw = [first, { ...second, ignored: { array: [1, { braces: 'quoted " ] } [ { \\ marker', nested: [true, false] }] } }, third];
  const parsed = await collect(file(" \n" + JSON.stringify(raw) + "\r\n "), { chunkBytes });
  expect(parsed).toEqual(raw.map(validateQuestion));
});

test("empty arrays are valid and early iterator return closes its source", async () => {
  expect(await collect(file(" \n [ \r\n ] \t"), { chunkBytes: 1 })).toEqual([]);
  const iterator = readLongMemEvalQuestions(file(JSON.stringify([question("one"), question("two")])), { chunkBytes: 3 });
  expect((await iterator.next()).value?.question_id).toBe("one");
  expect((await iterator.return(undefined)).done).toBe(true);
});

test("strict array framing refuses truncation, trailing commas, extra values, garbage and invalid UTF-8", async () => {
  const encoded = JSON.stringify(question());
  for (const input of ["", encoded, "{}", "null", "[", `[${encoded}`, `[${encoded},]`, `[${encoded} ${encoded}]`, `[${encoded}] trailing-private-marker`,
    `[${encoded}][${encoded}]`, "[null]", "[[]]", "[1]", "[/* comment */]", `[${encoded.slice(0, -2)}`, '[{"question":"unterminated-private-marker']) {
    await expect(collect(file(input), { chunkBytes: 2 })).rejects.toThrow("LongMemEval input");
  }
  const bytes = Buffer.from(`[${encoded}]`), marker = bytes.indexOf(Buffer.from("공개"));
  expect(marker).toBeGreaterThan(0); bytes[marker] = 255;
  await expect(collect(file(bytes), { chunkBytes: 1 })).rejects.toThrow("UTF-8");
});

test("per-question UTF-8 byte limits exclude array framing and reject oversize without content", async () => {
  const raw = question(), encoded = JSON.stringify(raw), size = Buffer.byteLength(encoded);
  expect(await collect(file(`[${encoded}]`), { chunkBytes: 7, maxQuestionBytes: size })).toEqual([validateQuestion(raw)]);
  await expect(collect(file(`[${encoded}]`), { chunkBytes: 7, maxQuestionBytes: size - 1 })).rejects.toThrow("maxQuestionBytes");
  for (const options of [{ chunkBytes: 0 }, { chunkBytes: -1 }, { chunkBytes: 1.5 }, { maxQuestionBytes: 0 }, { maxQuestionBytes: Infinity }]) {
    await expect(collect(file("[]"), options)).rejects.toThrow("reader bounds");
  }
  const invalid = question(); invalid.answer_session_ids = ["missing-private-marker"];
  let message = ""; try { await collect(file(JSON.stringify([invalid]))); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("question 1"); expect(message).toContain("missing from haystack");
  expect(message).not.toContain("missing-private-marker"); expect(message).not.toContain(raw.question);
});

test("schema-invalid questions are fatal after any already yielded prefix, never silently dropped", async () => {
  const iterator = readLongMemEvalQuestions(file(JSON.stringify([question("first"), { ...question("second"), question_date: "invalid-private-marker" }, question("third")])), { chunkBytes: 7 });
  expect((await iterator.next()).value?.question_id).toBe("first");
  await expect(iterator.next()).rejects.toThrow("question 2: invalid question_date");
});

test("stream hashing reports raw bytes and sanitized read errors", async () => {
  expect(await hashLongMemEvalFile(file("abc"))).toEqual({ bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
  expect((await hashLongMemEvalFile(file("공개😀"))).bytes).toBe(Buffer.byteLength("공개😀"));
  await expect(hashLongMemEvalFile("/missing/private-file-marker")).rejects.toThrow("benchmark file hash failed");
});
