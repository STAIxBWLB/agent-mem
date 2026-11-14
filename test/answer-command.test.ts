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
  for (const original of ['{ "cmd" : "echo --instructed hi", "other": [1, true] }', '{"command":["ahub","status","--other","value"]}', 'not JSON', '{ "cmd": "echo --other value']) {
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
