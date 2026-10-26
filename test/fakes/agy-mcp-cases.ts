/** Synthetic JSONC text only. No codec, native application, home or filesystem dependency. */
export interface AgyMcpTextCase {
  name: string;
  input: string;
  /** Unowned lexical fragments that edits must retain verbatim. */
  preserve: readonly string[];
  owned?: unknown;
  /** Only marked cases are strict JSON; the other JSONC cases must be refused by setup. */
  strictJson?: true;
}

export const agyMcpTextCases: readonly AgyMcpTextCase[] = [
  {
    name: "line comments and trailing footer",
    input: `// public header\n{\n  // preserve this root explanation\n  "mcpServers": {"other": {"command":"keep"}, "amem": {"command":"old"}},\n  "unknown" : 9007199254740993123456789\n}\n// public footer\n`,
    preserve: ["// public header", "// preserve this root explanation", '"other": {"command":"keep"}', '"unknown" : 9007199254740993123456789', "// public footer"],
    owned: { command: "old" },
  },
  {
    name: "block comments between key colon value and separator",
    input: '{ /* root */ "mcpServers" /* key comment */ : /* before map */ { "other" /* before colon */ : /* before value */ {"command":"keep"}, "amem": {"command":"old"} /* after owned value */ , /* after comma */ }, "ui": "한국어" }',
    preserve: ["/* root */", "/* key comment */", "/* before map */", '"other" /* before colon */ : /* before value */ {"command":"keep"}', "/* after owned value */", "/* after comma */", '"ui": "한국어"'],
    owned: { command: "old" },
  },
  {
    name: "comment markers and escaped quotes inside strings",
    strictJson: true,
    input: String.raw`{"mcpServers":{"other":{"command":"https://example.invalid/path//segment","args":["quote\" // still string", "slash\\ /* still string */", "[{},]"]},"amem":{"command":"old"}},"unknown":"literal // and /* comment */"}`,
    preserve: [String.raw`"command":"https://example.invalid/path//segment"`, String.raw`"quote\" // still string"`, String.raw`"slash\\ /* still string */"`, '"[{},]"', '"unknown":"literal // and /* comment */"'],
    owned: { command: "old" },
  },
  {
    name: "fake owned keys inside comments do not participate in duplicate detection",
    input: `/* "mcpServers":{"amem":{"command":"fake"}} */\n{"mcpServers":{ // "amem": {"command":"fake"},\n "other": {"command":"keep"}, "amem":{"command":"old"} }}\n`,
    preserve: ['/* "mcpServers":{"amem":{"command":"fake"}} */', '// "amem": {"command":"fake"},', '"other": {"command":"keep"}'],
    owned: { command: "old" },
  },
  {
    name: "trailing commas at root container owned object and nested arrays",
    input: '{"mcpServers":{"other":{"args":["x",],"env":{"A":"B",},},"amem":{"command":"old","args":["one","two",],},},"unknown":{"list":[1,2,],},}',
    preserve: ['"other":{"args":["x",],"env":{"A":"B",},}', '"unknown":{"list":[1,2,],}'],
    owned: { command: "old", args: ["one", "two"] },
  },
  {
    name: "empty commented container",
    input: '{ "mcpServers" : { /* retain empty-map annotation */ }, "unknown": true, }\n',
    preserve: ["/* retain empty-map annotation */", '"unknown": true'],
  },
  {
    name: "root with comments and no MCP container",
    input: '{\n /* root-only annotation */\n "unknown": {"nested": ["keep",],},\n}\n',
    preserve: ["/* root-only annotation */", '"unknown": {"nested": ["keep",],}'],
  },
  {
    name: "last sibling line comment must not swallow inserted owned entry",
    input: '{"mcpServers":{"other":9007199254740993123456789 // preserve last sibling note\n}}',
    preserve: ['"other":9007199254740993123456789', "// preserve last sibling note\n"],
  },
  {
    name: "existing trailing comma and comment remain lexically visible for insertion",
    input: '{"mcpServers":{"other":1, /* original trailing comma note */}, /* root trailing comma note */}',
    preserve: ['"other":1', "/* original trailing comma note */", "/* root trailing comma note */"],
  },
  {
    name: "CRLF and Unicode comments retain source offsets",
    input: ['{', ' // 공개 메모리 🧭 annotation', ' "mcpServers": {"other":{"command":"유지"}, "amem":{"command":"old"},},', ' "unknown":"한글",', '}'].join("\r\n") + "\r\n",
    preserve: ["// 공개 메모리 🧭 annotation", '"other":{"command":"유지"}', '"unknown":"한글"', "\r\n"],
    owned: { command: "old" },
  },
];

/** Cover removal of each owned member position, with and without a trailing comma. */
export const agyMcpDeletionCases: readonly AgyMcpTextCase[] = [
  { name: "owned first", input: '{"mcpServers":{"amem":{} /* preserve A */, /* preserve B */ "other":1}}', preserve: ["/* preserve A */", "/* preserve B */", '"other":1'], owned: {} },
  { name: "owned middle", input: '{"mcpServers":{"first":1, /* preserve A */ "amem":{} /* preserve B */, "last":2}}', preserve: ['"first":1', "/* preserve A */", "/* preserve B */", '"last":2'], owned: {} },
  { name: "owned last", input: '{"mcpServers":{"other":1, /* preserve A */ "amem":{} /* preserve B */}}', preserve: ['"other":1', "/* preserve A */", "/* preserve B */"], owned: {} },
  { name: "owned last with trailing comma", input: '{"mcpServers":{"other":1, /* preserve A */ "amem":{} /* preserve B */, /* preserve C */}}', preserve: ['"other":1', "/* preserve A */", "/* preserve B */", "/* preserve C */"], owned: {} },
  { name: "owned only with root siblings", input: '{"mcpServers":{"amem":{},}, /* preserve root note */ "unknown":9007199254740993123456789,}', preserve: ["/* preserve root note */", '"unknown":9007199254740993123456789'], owned: {} },
  { name: "owned only with unowned container annotation", input: '{"mcpServers":{/* user annotation survives undo */"amem":{},}}', preserve: ["/* user annotation survives undo */"], owned: {} },
];

export const agyMcpAmbiguousCases: readonly { name: string; input: string }[] = [
  { name: "duplicate real containers separated by comments", input: '{"mcpServers":{}, /* real duplicate */ "mcpServers":{},}' },
  { name: "duplicate owned entries", input: '{"mcpServers":{"amem":{}, // real duplicate\n "amem":{"command":"second"},}}' },
  { name: "duplicate owned command fields", input: '{"mcpServers":{"amem":{"command":"one", /* real duplicate */ "command":"two",}}}' },
  { name: "duplicate owned nested object fields", input: '{"mcpServers":{"amem":{"env":{"A":"one", "A":"two",},}}}' },
  { name: "duplicate owned object fields inside arrays", input: '{"mcpServers":{"amem":{"args":[{"nested":{"A":1,"A":2,}},],}}}' },
];

export const agyMcpInvalidCases: readonly { name: string; input: string }[] = [
  { name: "unterminated block comment", input: '{"mcpServers":{} /* not closed' },
  { name: "unterminated string is not a comment", input: '{"mcpServers":{},"unknown":"not closed // text}' },
  { name: "missing value before trailing comma", input: '{"mcpServers":{,}}' },
  { name: "array elision is not a trailing comma", input: '{"mcpServers":{"amem":{"args":["one",,]}}}' },
  { name: "masked comment must not merge number tokens", input: '{"mcpServers":{},"unknown":1/* gap */2}' },
  { name: "masked comment must not merge keyword tokens", input: '{"mcpServers":{},"unknown":tr/* gap */ue}' },
  { name: "single quotes are not JSONC strings", input: "{'mcpServers':{}}" },
  { name: "unquoted names are not JSONC keys", input: '{mcpServers:{}}' },
  { name: "multiple documents remain invalid", input: '{} // separator\n {}' },
];

/** Images for semantic undo scenarios; these contain no private runtime or machine paths. */
export const agyMcpUndoCases = {
  before: '{/* original header */"mcpServers":{"other":{"command":"keep",},},"ui":"before",}\n',
  after: '{/* original header */"mcpServers":{"other":{"command":"keep",},"amem":{"command":"installed","args":["mcp"],}},"ui":"before",}\n',
  unrelatedEdit: '{/* original header */"mcpServers":{"other":{"command":"keep",},"amem":{"command":"installed","args":["mcp"],}},"ui" : "한국어",/* later comment */"unknown":9007199254740993123456789,}\n',
  ownedEdit: '{/* original header */"mcpServers":{"other":{"command":"keep",},"amem":{"command":"user-edited","args":["mcp"],}},"ui":"before",}\n',
  preserve: ['/* original header */', '"other":{"command":"keep",}', '"ui" : "한국어"', '/* later comment */', '"unknown":9007199254740993123456789'],
} as const;
