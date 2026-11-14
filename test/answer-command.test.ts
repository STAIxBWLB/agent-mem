import { expect, test } from "bun:test";
import { toolInputLine, withholdToolArguments } from "../src/memory/capture-input.ts";

const prefix = "ahub answer qs-1 q=a";
for (const [command, expected] of [
  [`${prefix} --instructed "record a"`, `${prefix} --instructed [withheld]`],
  [`${prefix} --instructed='x y'`, `${prefix} --instructed=[withheld]`],
  [`${prefix} --other q="free text"`, `${prefix} --other [withheld]`],
  [`cd /x && ${prefix} --instructed 'record a'`, `cd /x && ${prefix} --instructed [withheld]`],
  [`${prefix} --instructed "a \\"quote\\"" --other='free text'`, `${prefix} --instructed [withheld] --other=[withheld]`],
  [`${prefix} --instructed 'first' && ${prefix} --other second`, `${prefix} --instructed [withheld] && ${prefix} --other [withheld]`],
  [`${prefix} --instructed "unterminated private text && echo private`, "ahub answer [withheld]"],
  [`${prefix} --other 'unterminated private text`, "ahub answer [withheld]"],
  [`${prefix} --instructed --other private`, "ahub answer [withheld]"],
  [`${prefix} --instructed "${"private".repeat(1000)}"`, `${prefix} --instructed [withheld]`],
] as const) {
  test(`withhold answer values before clipping: ${command.slice(0, 75)}`, () => {
    expect(toolInputLine({ command })).toBe(expected);
    expect(toolInputLine({ cmd: command })).toBe(expected);
  });
}
for (const command of ["echo --instructed hi", "ahub status", "echo 'ahub answer qs-1 --instructed private'", "other answer q=a --other text", "ahub answers --other value", "ahub answer qs-1 q=a", "printf '%s' --other", "echo x && ahub status --other value"]) {
  test(`unrelated commands retain their bytes: ${command}`, () => { expect(toolInputLine({ command })).toBe(command); });
}


test("serialized tool argument shaping covers shell strings and argv arrays without touching other JSON bytes", () => {
  for (const input of [
    { command: ["bash", "-lc", "ahub answer qs-1 q=a --instructed 'person-quote-canary'"] },
    { command: ["ahub", "answer", "qs-1", "q=a", "--instructed", "person-quote-canary", "--other=free-text-canary"] },
    { nested: { cmd: "ahub answer qs-1 q=a --instructed 'person-quote-canary'" } },
  ]) {
    const shaped = withholdToolArguments(JSON.stringify(input));
    expect(shaped).toContain("[withheld]");
    expect(shaped).not.toContain("person-quote-canary");
    expect(shaped).not.toContain("free-text-canary");
    expect(() => JSON.parse(shaped)).not.toThrow();
  }
  for (const original of ['{ "cmd" : "echo --instructed hi", "other": [1, true] }', '{"command":["ahub","status","--other","value"]}', 'not JSON', '{ "cmd": "echo --other value', JSON.stringify({ cmd: "echo 'ahub answer --instructed ordinary'" }), JSON.stringify({ cmd: "git commit -m 'ahub answer --instructed ordinary'" })]) {
    expect(withholdToolArguments(original)).toBe(original);
  }
  expect(withholdToolArguments('{ "cmd": "ahub answer qs-1 q=a --instructed \"private')).toBe("[withheld]");
});


test("malformed tool JSON cannot evade shaping through whitespace, shell lists or argv wrappers", () => {
  for (const command of [" ahub answer qs-1 q=a --instructed 'person-quote-canary'", "cd /x && ahub answer qs-1 q=a --other 'free-text-canary'"]) {
    const raw = JSON.stringify({ cmd: command }).slice(0, -2);
    expect(withholdToolArguments(raw)).toBe("[withheld]");
    const wrapped = JSON.stringify({ command: ["bash", "-lc", command] }).slice(0, -3);
    expect(withholdToolArguments(wrapped)).toBe("[withheld]");
  }
  const direct = JSON.stringify({ command: ["ahub", "answer", "qs-1", "--instructed", "person-quote-canary"] }).slice(0, -3);
  expect(withholdToolArguments(direct)).toBe("[withheld]");
  const other = JSON.stringify({ cmd: "echo --instructed ordinary" }).slice(0, -2);
  expect(withholdToolArguments(other)).toBe(other);
});


test("duplicate JSON keys never retain shadowed answer commands or argv values", () => {
  for (const raw of [
    '{"cmd":"ahub answer qs-1 q=a --instructed person-quote-canary","cmd":"echo ok"}',
    '{"nested":{"command":"ahub answer qs-1 q=a --other free-text-canary","command":"echo ok"}}',
    '{"command":["ahub","answer","qs-1","--instructed","person-quote-canary"],"command":["echo","ok"]}',
    '{"command":["FOO=1","ahub","answer","qs-1","--instructed","person-quote-canary"],"command":["echo","ok"]}',
  ]) {
    const captured = withholdToolArguments(raw);
    expect(captured).toBe("[withheld]");
    expect(captured).not.toContain("person-quote-canary");
    expect(captured).not.toContain("free-text-canary");
  }
  const ordinary = '{"cmd":"echo first","cmd":"echo second"}';
  expect(withholdToolArguments(ordinary)).toBe(ordinary);
});

test("leading environment assignments do not become the program name", () => {
  for (const start of ["FOO=1 ", "FOO='x y' BAR=2 ", "cd /x && FOO=1 ", 'FOO="$VALUE" ']) {
    const command = `${start}ahub answer qs-1 q=a --instructed "person-quote-canary"`;
    expect(toolInputLine({ command })).toBe(`${start}ahub answer qs-1 q=a --instructed [withheld]`);
  }
  const argv = { command: ["FOO=1", "BAR=2", "ahub", "answer", "qs-1", "q=a", "--instructed", "person-quote-canary"] };
  expect(withholdToolArguments(JSON.stringify(argv))).toBe(JSON.stringify({ command: ["FOO=1", "BAR=2", "ahub", "answer", "qs-1", "q=a", "--instructed", "[withheld]"] }));
  for (const command of ['"FOO=1" ahub answer qs-1 --other text', 'echo FOO=1 ahub answer qs-1 --instructed text', "FOO=1 ahub status --other text"]) {
    expect(toolInputLine({ command })).toBe(command);
  }
});

test("unparseable tool arguments containing ahub answer are withheld as a whole", () => {
  expect(withholdToolArguments('{"command": ahub answer qs-1 q=a --instructed person-quote-canary}')).toBe("[withheld]");
});
