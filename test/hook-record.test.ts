import { createHash } from "node:crypto";
import { captureSessionKey } from "../src/memory/capture-input.ts";
import { expect, spyOn, test } from "bun:test";
import { parseRecordLines, RECORD_INSTRUCTION, RECORD_INSTRUCTION_B, recordContextData, recordInstructionVariant } from "../src/hook-record.ts";
import { transcriptRecords } from "../src/hook-transcript.ts";

test("records are canonical, bounded main-answer lines with explicit anchors", () => {
  for (const kind of ["decision", "fix", "fail", "contract", "finding"] as const) {
    const parsed = parseRecordLines(`amem: ${kind} | src/a.ts#read,src/b.ts | symptom -> retry`);
    expect(parsed.records).toEqual([{ kind, anchors: ["src/a.ts#read", "src/b.ts"], text: "symptom -> retry",
      line: `amem: ${kind} | src/a.ts#read, src/b.ts | symptom -> retry` }]);
    expect(parsed.drops).toEqual({});
  }
  for (const kind of ["decision", "contract"]) expect(parseRecordLines(`amem: ${kind} | - | settled`).records[0]?.anchors).toEqual([]);
});

test("invalid kinds, shape, anchors and missing fix/fail direction are never repaired", () => {
  for (const line of [
    "amem: unknown | src/a.ts | text", "amem:fix | src/a.ts | cause -> retry", "amem: fix | src/a.ts | no direction",
    "amem: fail | src/a.ts | cause -> ", "amem: finding | - | text", "amem: decision |  | text",
    "amem: finding | /absolute/path | text", "amem: finding | ../outside | text", "amem: finding | src/../a.ts | text",
    "amem: finding | src//a.ts | text", "amem: finding | src/a.ts, | text", "amem: finding | src/a.ts# | text",
    "amem: finding | src/a.ts#one#two | text", "amem: finding | C:/outside | text", "amem: decision | - | ",
  ]) expect(parseRecordLines(line)).toEqual({ records: [], drops: { record_invalid: 1 } });
});

test("the third valid record drops, and the 300-character text bound counts Unicode characters", () => {
  const lines = ["first", "second", "third"].map(text => `amem: finding | src/a.ts | ${text}`);
  expect(parseRecordLines(lines.join("\n"))).toMatchObject({ records: [{ text: "first" }, { text: "second" }], drops: { record_count: 1 } });
  expect(parseRecordLines(`amem: decision | - | ${"가".repeat(300)}`).records).toHaveLength(1);
  expect(parseRecordLines(`amem: decision | - | ${"가".repeat(301)}`)).toEqual({ records: [], drops: { record_length: 1 } });
});

test("fenced, quoted, indented and inline examples are ignored, including lazy quote continuation", () => {
  const record = "amem: finding | src/a.ts | example";
  for (const text of [
    `\`\`\`text\n${record}\n\`\`\``, `~~~~\n${record}\n~~~~`, `\`\`\`\`\n\`\`\`\n${record}\n\`\`\`\``,
    `> ${record}`, `> quoted paragraph\n${record}`, `    ${record}`, `Example: ${record}`,
  ]) expect(parseRecordLines(text)).toEqual({ records: [], drops: {} });
  expect(parseRecordLines(`> quoted paragraph\n\n${record}`).records).toHaveLength(1);
  expect(parseRecordLines(`\`\`\`\n${record}\n\`\`\`\n${record}`).records).toHaveLength(1);
});

test("the package instruction fits its fixed three-line byte ceiling", () => {
  expect(RECORD_INSTRUCTION).toBe([
    "Only when a turn settles a decision, fix, fail or contract, end the final answer with at most 2 records; otherwise none:",
    "amem: <decision|fix|fail|contract|finding> | <repo/path[#symbol],... or - for decision/contract> | <text, max 300 characters>",
    "For fix/fail use symptom/cause -> fix/retry-when. No fences, quotes, secrets or PII.",
  ].join("\n"));
  expect(RECORD_INSTRUCTION.split("\n")).toHaveLength(3);
  expect(Buffer.byteLength(RECORD_INSTRUCTION)).toBeLessThanOrEqual(400);
});

test("hosts reuse the parser and instruction from the public library entry", async () => {
  const library = await import("../src/index.ts");
  expect(library.RECORD_INSTRUCTION).toBe(RECORD_INSTRUCTION);
  expect(library.RECORD_INSTRUCTION_B).toBe(RECORD_INSTRUCTION_B);
  expect(library.captureSessionKey("host-session")).toBe(captureSessionKey("host-session"));
  expect(library.parseRecordLines("amem: decision | - | settled")).toEqual(parseRecordLines("amem: decision | - | settled"));
  expect(parseRecordLines("x".repeat(256 * 1024 + 1))).toEqual({ records: [], drops: { record_length: 1 } });
});

test("only native main-session assistant text is eligible, with a stable native message id", () => {
  const text = "amem: finding | src/a.ts | settled", message = { id: "msg_native_1", role: "assistant", content: [{ type: "text", text }] };
  expect(transcriptRecords(JSON.stringify({ type: "assistant", message, timestamp: "2026-11-08T00:00:00Z" }))?.parsed.records).toHaveLength(1);
  for (const row of [
    { type: "user", message }, { type: "system", message }, { type: "assistant", message, isSidechain: true },
    { type: "assistant", message, agentId: "subagent" }, { type: "assistant", message: { ...message, role: "user" } },
    { type: "assistant", message: { ...message, content: [{ type: "tool_result", text }] } },
  ]) expect(transcriptRecords(JSON.stringify(row))).toBeUndefined();
  for (const id of [undefined, "", " ", "x".repeat(257)]) {
    expect(transcriptRecords(JSON.stringify({ type: "assistant", message: { ...message, id } }))?.parsed).toEqual({ records: [], drops: { record_identity: 1 } });
  }
});

test("the marker prefilter avoids JSON.parse for ordinary assistant or malformed rows", () => {
  const parse = spyOn(JSON, "parse");
  try {
    expect(transcriptRecords('{"type":"assistant","message":{"content":"ordinary"}}')).toBeUndefined();
    expect(transcriptRecords("not even JSON")).toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
  } finally { parse.mockRestore(); }
});

test("the record line loop yields an incomplete result at the caller's unchanged scan boundary", () => {
  let checks = 0;
  const parsed = parseRecordLines("ordinary\namem: decision | - | first\namem: decision | - | second", () => ++checks > 2);
  expect(parsed).toMatchObject({ records: [{ text: "first" }], incomplete: true });
});

test("whole private-span context is excluded before record or Markdown interpretation", () => {
  const hidden = "amem: decision | - | hidden finding", visible = "amem: decision | - | visible finding";
  for (const text of [
    `<private>\n${hidden}\n</private>`, `<PRIVATE class='x'>\n${hidden}\n</ PRIVATE>`,
    `< private/>\n${hidden}`, `<private>\n<private>nested</private>\n${hidden}\n</private>`,
  ]) expect(parseRecordLines(text)).toEqual({ records: [], drops: {} });
  expect(parseRecordLines(`<private>\n> hidden quote\n\`\`\`\n${hidden}\n</private>\n${visible}`).records).toMatchObject([{ text: "visible finding" }]);
  expect(parseRecordLines(`amem: decision | - | before <private>hidden</private> after`)).toEqual({ records: [], drops: { record_policy: 1 } });
  expect(parseRecordLines(`\`\`\`text <private>hidden</private>\n${hidden}\n\`\`\`\n${visible}`).records).toMatchObject([{ text: "visible finding" }]);
});


test("variant B is pinned, bounded and stripped only as an exact package prefix", () => {
  expect(RECORD_INSTRUCTION_B).toBe([
    "Future use: keep what code/git/instructions lack. Up to 2 final lines; else none:",
    "amem: <decision|fix|fail|contract|finding> | <repo/path[#symbol],... or - for decision/contract> | <text, max 300 chars; basis:test|log|issue|run; prefix ? if unverified>",
    "fix/fail: symptom/cause -> fix/retry-when. No fences, quotes, secrets or PII.",
  ].join("\n"));
  expect(Buffer.byteLength(RECORD_INSTRUCTION) + 1).toBe(332);
  expect(Buffer.byteLength(RECORD_INSTRUCTION_B) + 1).toBe(331);
  for (const text of [RECORD_INSTRUCTION, RECORD_INSTRUCTION_B]) {
    expect(recordContextData(`${text}\nUntrusted project memory data`)).toBe("Untrusted project memory data");
    expect(recordContextData(`${text}!\nUntrusted project memory data`)).toBe(`${text}!\nUntrusted project memory data`);
  }
  const parsed = parseRecordLines("amem: fix | src/cache.ts | ? stale entry -> invalidate; basis:test");
  expect(parsed.records[0]?.text).toBe("? stale entry -> invalidate; basis:test");
  expect(parsed.drops).toEqual({});
});

test("alternate uses persisted session hash parity and preserves the existing session hash", () => {
  for (const raw of ["session-a", "session-b", "같은 세션"]) {
    const key = captureSessionKey(raw)!;
    expect(key).toBe(createHash("sha256").update(`amem-session\0${raw}`).digest("hex").slice(0, 16));
    expect(recordInstructionVariant("alternate", key)).toBe(Number.parseInt(key.slice(-1), 16) % 2 ? "b" : "a");
    expect(recordInstructionVariant("a", key)).toBe("a");
    expect(recordInstructionVariant("b", key)).toBe("b");
  }
  expect(recordInstructionVariant("alternate", "0000000000000000")).toBe("a");
  expect(recordInstructionVariant("alternate", "0000000000000001")).toBe("b");
  expect(recordInstructionVariant("alternate")).toBe("a");
  for (const raw of [null, "", 1, "s".repeat(257)]) expect(captureSessionKey(raw)).toBeUndefined();
});
