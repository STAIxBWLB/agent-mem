import { expect, test } from "bun:test";
import { putJcodeMcp, readJcodeMcp, restoreJcodeMcp } from "../src/setup-jcode.ts";
import type { ConfigImage } from "../src/setup-owned.ts";
import { SETUP_CONFIG_BYTES } from "../src/setup-toml.ts";

const image = (text: string | null, mode = 0o640): ConfigImage => ({ bytes: text === null ? null : Buffer.from(text).toString("base64"), mode });
const text = (value: ConfigImage) => value.bytes === null ? null : Buffer.from(value.bytes, "base64").toString("utf8");
const server = { command: "/runtime/bun", args: ["--smol", "/package/amem.js", "mcp"] };

test("owned MCP replacement preserves every unrelated lexical byte, escapes and Unicode", () => {
  const source = String.raw`{
  "unknown": 9007199254740993123456789,
  "nested": { "servers": {"amem":"unrelated"}, "escaped": "quote\" slash\\ line\n", "한글": "공개 설정" },
  "servers" : { "other" : { "command": "keep", "nested": [1, {"brackets":"[{}]"}] }, "amem" : { "command" : "old" } },
  "tail": true
}
`;
  const before = image(source), after = putJcodeMcp(before, server);
  expect(text(after)).toBe(source.replace('{ "command" : "old" }', JSON.stringify(server)));
  expect(after.mode).toBe(0o640); expect(readJcodeMcp(after)).toEqual(server);
  expect(putJcodeMcp(after, server)).toEqual(after);
  expect(restoreJcodeMcp(before, after, after)).toEqual(before);
});

test("legacy container canonicalization changes only its key when the owned entry already matches", () => {
  const source = ` { "mcpServers" : { "other": {"raw":9007199254740993123456789}, "amem": ${JSON.stringify(server)} }, "ui":"한국어" }\n`;
  const before = image(source), after = putJcodeMcp(before, server);
  expect(text(after)).toBe(source.replace('"mcpServers"', '"servers"'));
  expect(readJcodeMcp(before)).toEqual(server); expect(readJcodeMcp(after)).toEqual(server);
  expect(restoreJcodeMcp(before, after, after)).toEqual(before);
});

test("semantic undo reverses an alias-only migration while retaining unrelated raw edits", () => {
  const source = `{"mcpServers" : { "amem":${JSON.stringify(server)}, "other":9007199254740993123456789 }, "ui":"before"}\n`;
  const before = image(source), after = putJcodeMcp(before, server);
  const currentText = text(after)!.replace('"ui":"before"', '"ui" : "한국어", "later":{"escaped":"a\\tb"}');
  const current = image(currentText, 0o600), restored = restoreJcodeMcp(before, after, current);
  expect(text(restored)).toBe(currentText.replace('"servers"', '"mcpServers"'));
  expect(readJcodeMcp(restored)).toEqual(server); expect(restored.mode).toBe(0o600);
  expect(restoreJcodeMcp(before, after, restored)).toEqual(restored);
});

test("member insertion and deletion preserve raw first, middle and last sibling entries", () => {
  for (const source of ['{"servers":{"amem":{}, "other":1},"tail":2}', '{"servers":{"first":1, "amem":{}, "last":2}}', '{"servers":{"other":1, "amem":{}}}']) {
    const removed = putJcodeMcp(image(source), undefined), rendered = text(removed)!;
    expect(readJcodeMcp(removed)).toBeUndefined(); expect(JSON.parse(rendered).servers).toBeDefined();
    for (const entry of ['"first":1', '"other":1', '"last":2', '"tail":2']) if (source.includes(entry)) expect(rendered).toContain(entry);
    expect(readJcodeMcp(putJcodeMcp(removed, server))).toEqual(server);
  }
  const source = ' { "other":9007199254740993123456789\n}\n', inserted = putJcodeMcp(image(source), server);
  expect(text(inserted)).toBe(source.replace("\n}", `,"servers":{"amem":${JSON.stringify(server)}}\n}`));
});

test("missing, empty root and empty container restore with their original presence and modes", () => {
  for (const source of [null, " { }\n", ' {"servers": {  }}\n', '{"mcpServers":{}}']) {
    const before = image(source), after = putJcodeMcp(before, server);
    expect(readJcodeMcp(before)).toBeUndefined(); expect(readJcodeMcp(after)).toEqual(server);
    expect(restoreJcodeMcp(before, after, after)).toEqual(before);
  }
  const before = image(null), after = putJcodeMcp(before, server), chmodOnly = { ...after, mode: 0o600 };
  expect(restoreJcodeMcp(before, after, chmodOnly)).toEqual({ bytes: null, mode: 0o600 });
  const empty = image('{"servers": {  }}'), installed = putJcodeMcp(empty, server);
  const edited = image(text(installed)!.replace('"servers"', '"later":9007199254740993123456789,"servers"'));
  const restored = text(restoreJcodeMcp(empty, installed, edited))!;
  expect(restored).toContain('"later":9007199254740993123456789'); expect(JSON.parse(restored).servers).toEqual({});
  expect(text(putJcodeMcp(image('{ "servers" : {"amem":1} }'), undefined))).toBe('{  }');
});

test("semantic undo restores the prior raw owned value and alias while preserving user edits", () => {
  const old = '{ "command" : "prior", "args" : ["한글", "quote\\\""] }';
  const before = image(`{"mcpServers":{"amem":${old},"other":7},"ui":"before"}`), after = putJcodeMcp(before, server);
  const current = image(text(after)!.replace('"other":7', '"other" : 9007199254740993123456789').replace('"ui":"before"', '"ui" : "later", "extra":{"escaped":"a\\tb"}'), 0o600);
  const restored = restoreJcodeMcp(before, after, current), rendered = text(restored)!;
  expect(rendered).toContain(`"amem":${old}`); expect(rendered).toContain('"mcpServers"'); expect(rendered).not.toContain('"servers"');
  expect(rendered).toContain('"other" : 9007199254740993123456789'); expect(rendered).toContain('"ui" : "later", "extra":{"escaped":"a\\tb"}');
  expect(restored.mode).toBe(0o600);
  expect(restoreJcodeMcp(before, after, restored)).toEqual(restored);
});

test("semantic undo drops an installer-created container but never restores unrelated user deletions", () => {
  const before = image('{"servers":{"other":1},"keep":9007199254740993123456789}'), after = putJcodeMcp(before, server);
  const deletedContainer = image('{"keep":9007199254740993123456789,"later":true}');
  expect(restoreJcodeMcp(before, after, deletedContainer)).toEqual(deletedContainer);
  const missing = image(null), installed = putJcodeMcp(missing, server), edited = image(text(installed)!.replace('"servers"', '"later":9007199254740993123456789,"servers"'));
  const restored = text(restoreJcodeMcp(missing, installed, edited))!;
  expect(restored).toContain('"later":9007199254740993123456789'); expect(JSON.parse(restored).servers).toBeUndefined();
});

test("owned entry conflicts fail before returning a replacement image", () => {
  const before = image('{"servers":{"amem":{"command":"old"}}}'), after = putJcodeMcp(before, server);
  const edited = putJcodeMcp(after, { command: "user-edited", args: [] });
  expect(() => restoreJcodeMcp(before, after, edited)).toThrow("changed");
  expect(readJcodeMcp(edited)).toEqual({ command: "user-edited", args: [] });
  const deleted = putJcodeMcp(after, undefined);
  expect(() => restoreJcodeMcp(before, after, deleted)).toThrow("changed");
  expect(readJcodeMcp(deleted)).toBeUndefined();
  const absentBefore = image(null), installed = putJcodeMcp(absentBefore, server), alreadyRemoved = image('{"servers":{},"later":true}');
  expect(restoreJcodeMcp(absentBefore, installed, alreadyRemoved)).toEqual(alreadyRemoved);
});

test("ambiguous owned containers and entries fail closed, including duplicate keys", () => {
  for (const source of ['{"servers":{},"mcpServers":{}}', '{"servers":{},"servers":{}}', '{"mcpServers":{},"mcpServers":{}}',
    '{"servers":{"amem":1},"servers":{"amem":2}}', '{"servers":{"amem":1,"amem":2}}',
    '{"mcpServers":{"amem":{"command":"first"},"amem":{"command":"second"}}}', '{"servers":{"amem":{"command":"old","command":"new"}}}',
    '{"servers":{"amem":{"env":{"A":1,"A":2}}}}', '{"servers":{"amem":{"args":[{"nested":{"x":1,"x":2}}]}}}',
    '{"servers":[]}', '{"mcpServers":null}']) {
    const current = image(source);
    expect(() => readJcodeMcp(current)).toThrow(); expect(() => putJcodeMcp(current, server)).toThrow();
    expect(() => restoreJcodeMcp(image(null), putJcodeMcp(image(null), server), current)).toThrow();
  }
  const unknownDuplicates = image('{"other":1,"other":2,"servers":{"unrelated":1,"unrelated":2}}');
  expect(text(putJcodeMcp(unknownDuplicates, server))).toContain('"other":1,"other":2');
  expect(text(putJcodeMcp(unknownDuplicates, server))).toContain('"unrelated":1,"unrelated":2');
});

test("invalid JSON, invalid UTF-8, noncanonical bytes and input/output size excesses are refused", () => {
  for (const source of ["", "[]", "null", '{"servers":{', '{"servers":{},}', '// comment\n{}']) expect(() => readJcodeMcp(image(source))).toThrow();
  // Deliberate literal BOM input: the decoder must preserve it so JSON validation rejects it.
  expect(() => readJcodeMcp(image("﻿{}"))).toThrow();
  expect(() => readJcodeMcp({ bytes: Buffer.from([255]).toString("base64"), mode: 0o600 })).toThrow();
  expect(() => readJcodeMcp({ bytes: image("{}").bytes! + "\n", mode: 0o600 })).toThrow();
  const oversized = image(JSON.stringify({ unknown: "x".repeat(SETUP_CONFIG_BYTES) }));
  expect(() => readJcodeMcp(oversized)).toThrow();
  const near = image(JSON.stringify({ unknown: "x".repeat(SETUP_CONFIG_BYTES - 40) }));
  expect(() => putJcodeMcp(near, server)).toThrow();
});
