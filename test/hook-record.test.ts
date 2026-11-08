import { expect, test } from "bun:test";
import { parseRecordLines, RECORD_INSTRUCTION } from "../src/hook-record.ts";

test("records are canonical, bounded main-answer lines with explicit anchors", () => {
  for (const kind of ["decision", "fix", "fail", "contract", "finding"]) {
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
  expect(RECORD_INSTRUCTION.split("\n")).toHaveLength(3);
  expect(Buffer.byteLength(RECORD_INSTRUCTION)).toBeLessThanOrEqual(400);
});
