import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stageHookCapture } from "../src/hook-spool.ts";
import { toolInputLine } from "../src/memory/capture-input.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function fixture() { const value = hookFixture(); fixtures.push(value); return value; }
function pending(f: ReturnType<typeof hookFixture>) {
  const root = join(f.base, "hook-spool");
  return [root, join(root, ".capacity")].flatMap(dir => existsSync(dir) ? readdirSync(dir)
    .filter(name => /^hook-.*\.json$/.test(name)).map(name => ({ name, value: JSON.parse(readFileSync(join(dir, name), "utf8")) as { capture: { excerpt: string } } })) : []);
}

test("tool input line has fixed known-key order, sorted remaining values and excludes bulk fields", () => {
  expect(toolInputLine({ subject: "subject", unknown_z: "z", query: "query", pattern: "pattern", url: "url", description: "description",
    prompt: "prompt", skill: "skill", command: "command", unknown_a: "a", content: "bulk content", old_string: "old", new_string: "new", edits: "bulk edits" }))
    .toBe("command | pattern | query | url | description | prompt | skill | subject | a | z");
});

test("tool input values and full line clip on UTF-8 boundaries", () => {
  const line = toolInputLine({ command: "é".repeat(400), query: "tail" });
  expect(line).toBe("é".repeat(256)); expect(Buffer.byteLength(line)).toBe(512);
  expect(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(line))).not.toThrow();
});

test("tool events prepend input before old content while other events keep their old excerpt", async () => {
  const f = fixture(), options = { cwd: f.cwd, base: f.base };
  const bash = await stageHookCapture("PostToolUse", { cwd: f.cwd, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo hello" }, tool_response: "hello" }, options);
  expect(bash).toBeDefined(); expect(pending(f).find(row => row.name === bash!.name)!.value.capture.excerpt).toBe("echo hello\nhello");
  const pre = await stageHookCapture("PreToolUse", { cwd: f.cwd, hook_event_name: "PreToolUse", tool_input: { command: "git status" } }, options);
  expect(pre).toBeDefined(); expect(pending(f).find(row => row.name === pre!.name)!.value.capture.excerpt).toBe("git status");
  const failure = await stageHookCapture("PostToolUseFailure", { cwd: f.cwd, hook_event_name: "PostToolUseFailure", tool_input: { command: "make check" }, error: { message: "failed" }, tool_response: "ignored" }, options);
  expect(failure).toBeDefined(); expect(pending(f).find(row => row.name === failure!.name)!.value.capture.excerpt).toBe("make check\n{\"message\":\"failed\"}");
  const prompt = await stageHookCapture("UserPromptSubmit", { cwd: f.cwd, hook_event_name: "UserPromptSubmit", prompt: "ordinary prompt", tool_input: { command: "not included" } }, options);
  expect(prompt).toBeDefined(); expect(pending(f).find(row => row.name === prompt!.name)!.value.capture.excerpt).toBe("ordinary prompt");
});

test("tool excerpt obeys the 2,000-byte and configured lower UTF-8 bounds", async () => {
  const f = fixture(), options = { cwd: f.cwd, base: f.base };
  const full = await stageHookCapture("PostToolUse", { cwd: f.cwd, tool_input: { command: "run" }, tool_response: "x".repeat(3000) }, options);
  expect(full).toBeDefined();
  const defaultExcerpt = pending(f).find(row => row.name === full!.name)!.value.capture.excerpt;
  expect(Buffer.byteLength(defaultExcerpt)).toBe(2000);
  expect(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(defaultExcerpt))).not.toThrow();

  mkdirSync(f.base, { recursive: true });
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ excerptBytes: 31 }));
  const capped = await stageHookCapture("PostToolUse", { cwd: f.cwd, tool_input: { command: "run" }, tool_response: "界".repeat(1000) }, options);
  expect(capped).toBeDefined();
  const excerpt = pending(f).find(row => row.name === capped!.name)!.value.capture.excerpt;
  expect(Buffer.byteLength(excerpt)).toBe(31);
  expect(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(excerpt))).not.toThrow();
});

test("raw and combined tool text screens drop the whole row instead of storing a redaction sentinel", async () => {
  const f = fixture(); mkdirSync(f.base, { recursive: true });
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["private-codename"] }));
  const options = { cwd: f.cwd, base: f.base };
  expect(await stageHookCapture("PostToolUse", { cwd: f.cwd, tool_input: { command: `curl ${"sk-" + "synthetic".repeat(8)}` } }, options)).toBeUndefined();
  expect(await stageHookCapture("PostToolUse", { cwd: f.cwd, tool_input: { query: "private-codename lookup" } }, options)).toBeUndefined();
  // The configured literal is only present after the deterministic value join.
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["alpha | omega"] }));
  expect(await stageHookCapture("PostToolUse", { cwd: f.cwd, tool_input: { command: "alpha", query: "omega" } }, options)).toBeUndefined();
  // Neither raw field is secret by itself; the joined final excerpt is.
  expect(await stageHookCapture("PostToolUse", { cwd: f.cwd, tool_input: { command: "password:" }, tool_response: "abcdefghijk" }, options)).toBeUndefined();
  expect(pending(f)).toEqual([]);
});

test("private spans are stripped from each value before clipping and from old content", async () => {
  const f = fixture(), hidden = "private-plan-".repeat(100);
  const staged = await stageHookCapture("PostToolUse", { cwd: f.cwd, tool_input: { command: `prefix <private>${hidden}</private> suffix` },
    tool_response: `response <private/>${hidden}</private> tail` }, { cwd: f.cwd, base: f.base });
  expect(staged).toBeDefined();
  const excerpt = pending(f).find(row => row.name === staged!.name)!.value.capture.excerpt;
  expect(excerpt).toContain("prefix  suffix\nresponse "); expect(excerpt).toContain(" tail");
  expect(excerpt).not.toContain("private-plan-"); expect(excerpt).not.toContain("<private");
});

test("the normalizer retains its configured screen if policy tightens after the envelope screen", async () => {
  const f = fixture(); mkdirSync(f.base, { recursive: true });
  const clone = globalThis.structuredClone;
  const change = spyOn(globalThis, "structuredClone").mockImplementation(((...args: Parameters<typeof clone>) => {
    writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["late-codename"] }));
    return clone(...args);
  }) as typeof clone);
  try {
    expect(await stageHookCapture("PostToolUse", { cwd: f.cwd, tool_input: { command: "late-codename lookup" } }, { cwd: f.cwd, base: f.base })).toBeUndefined();
    expect(pending(f)).toEqual([]);
  } finally { change.mockRestore(); }
});
