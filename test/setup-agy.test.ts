import { expect, test } from "bun:test";
import { readAgyMcp, putAgyMcp, restoreAgyMcp } from "../src/setup-agy.ts";
import type { ConfigImage } from "../src/setup-owned.ts";
import { agyMcpAmbiguousCases, agyMcpDeletionCases, agyMcpInvalidCases, agyMcpTextCases, agyMcpUndoCases } from "./fakes/agy-mcp-cases.ts";

const image = (text: string | null, mode = 0o640): ConfigImage => ({ bytes: text === null ? null : Buffer.from(text).toString("base64"), mode });
const text = (value: ConfigImage) => value.bytes === null ? null : Buffer.from(value.bytes, "base64").toString("utf8");
const server = { command: "/runtime/bun", args: ["--smol", "/package/amem.js", "mcp"] };

for (const sample of [...agyMcpTextCases.filter(sample => !sample.strictJson), ...agyMcpDeletionCases, ...agyMcpAmbiguousCases, ...agyMcpInvalidCases]) {
  test(`Antigravity strict JSON refuses ${sample.name}`, () => {
    const current = image(sample.input), before = image(null), after = putAgyMcp(before, server);
    expect(() => readAgyMcp(current)).toThrow("Antigravity strict JSON");
    expect(() => putAgyMcp(current, server)).toThrow("Antigravity strict JSON");
    expect(() => restoreAgyMcp(before, after, current)).toThrow("Antigravity strict JSON");
    expect(text(current)).toBe(sample.input);
  });
}

test("comment-like strings remain valid strict JSON with byte-preserving unknown data", () => {
  const samples = agyMcpTextCases.filter(sample => sample.strictJson);
  expect(samples).toHaveLength(1);
  for (const sample of samples) {
    const before = image(sample.input), after = putAgyMcp(before, server);
    expect(readAgyMcp(before)).toEqual(sample.owned); expect(readAgyMcp(after)).toEqual(server);
    for (const fragment of sample.preserve) expect(text(after)).toContain(fragment);
    expect(after.mode).toBe(before.mode); expect(putAgyMcp(after, server)).toEqual(after);
    expect(restoreAgyMcp(before, after, after)).toEqual(before);
  }
});

test("Antigravity edits only its owned mcpServers entry and retains raw numbers, escapes and Unicode", () => {
  const source = String.raw`{
  "unknown" : 9007199254740993123456789,
  "nested":{"mcpServers":{"amem":"unrelated"},"한글":"공개 설정","quoted":"a\"b\\c"},
  "mcpServers" : { "other" : {"command":"keep","args":["literal // text","literal /* text */"]}, "amem" : { "command" : "old" } }
}
`;
  const before = image(source), after = putAgyMcp(before, server);
  expect(text(after)).toBe(source.replace('{ "command" : "old" }', JSON.stringify(server)));
  expect(readAgyMcp(after)).toEqual(server); expect(after.mode).toBe(0o640);
  expect(restoreAgyMcp(before, after, after)).toEqual(before);
});

test("servers is unrelated data, never an Antigravity active alias", () => {
  const source = '{"servers" : {"amem":{"command":"keep"},"raw":9007199254740993123456789},"ui":"한국어"}';
  const before = image(source); expect(readAgyMcp(before)).toBeUndefined();
  const after = putAgyMcp(before, server);
  expect(readAgyMcp(after)).toEqual(server);
  expect(text(after)).toContain('"servers" : {"amem":{"command":"keep"},"raw":9007199254740993123456789}');
  expect(JSON.parse(text(after)!).mcpServers.amem).toEqual(server);
  expect(restoreAgyMcp(before, after, after)).toEqual(before);
});

test("Antigravity semantic undo preserves unrelated user edits and refuses changed or deleted owned values", () => {
  const before = image('{"mcpServers":{"amem":{ "command" : "old" },"other":1},"ui":"before"}');
  const after = putAgyMcp(before, server);
  const current = image(text(after)!.replace('"other":1', '"other" : 9007199254740993123456789').replace('"ui":"before"', '"ui" : "한국어"'), 0o600);
  const restored = restoreAgyMcp(before, after, current), rendered = text(restored)!;
  expect(rendered).toContain('"amem":{ "command" : "old" }'); expect(rendered).toContain('"other" : 9007199254740993123456789');
  expect(rendered).toContain('"ui" : "한국어"'); expect(restored.mode).toBe(0o600);
  expect(restoreAgyMcp(before, after, restored)).toEqual(restored);
  expect(() => restoreAgyMcp(before, after, putAgyMcp(after, { command: "user-edited" }))).toThrow("changed");
  expect(() => restoreAgyMcp(before, after, putAgyMcp(after, undefined))).toThrow("changed");
});

test("Antigravity rejects strict JSON owned duplicates at every owned nesting level", () => {
  for (const input of ['{"mcpServers":{},"mcpServers":{}}', '{"mcpServers":{"amem":1,"amem":2}}',
    '{"mcpServers":{"amem":{"command":"old","command":"new"}}}', '{"mcpServers":{"amem":{"env":{"A":1,"A":2}}}}',
    '{"mcpServers":{"amem":{"args":[{"nested":{"x":1,"x":2}}]}}}']) {
    expect(() => readAgyMcp(image(input))).toThrow("Antigravity strict JSON");
    expect(() => putAgyMcp(image(input), server)).toThrow("Antigravity strict JSON");
  }
});

test("Antigravity missing and empty configurations keep exact undo and reject BOM and JSONC undo images", () => {
  for (const source of [null, " { }\n", '{"mcpServers": {  }}\n']) {
    const before = image(source), after = putAgyMcp(before, server);
    expect(readAgyMcp(before)).toBeUndefined(); expect(readAgyMcp(after)).toEqual(server);
    expect(restoreAgyMcp(before, after, after)).toEqual(before);
  }
  expect(() => readAgyMcp(image("﻿{}"))).toThrow("Antigravity strict JSON");
  expect(() => restoreAgyMcp(image(agyMcpUndoCases.before), image(agyMcpUndoCases.after), image(agyMcpUndoCases.unrelatedEdit))).toThrow("Antigravity strict JSON");
});
