import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordsEnabled, RECORD_INSTRUCTION } from "../src/index.ts";
import * as config from "../src/memory/config.ts";
import { runHook } from "../src/hooks.ts";
import { scanHookTranscriptTail } from "../src/hook-transcript.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture(machine?: unknown, repo?: boolean) {
  const f = hookFixture(); fixtures.push(f);
  mkdirSync(f.base, { recursive: true });
  if (machine !== undefined) writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ records: machine }));
  mkdirSync(join(f.cwd, ".amem"));
  if (repo !== undefined) writeFileSync(join(f.cwd, ".amem", "config"), JSON.stringify({ records: repo }));
  return f;
}

for (const instruction of [undefined, "a", "b", "alternate"] as const) {
  test(`machine records instruction object selects ${instruction ?? "default a"}`, () => {
    const f = hookFixture(); fixtures.push(f);
    mkdirSync(f.base, { recursive: true });
    writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ records: instruction === undefined ? {} : { instruction } }));
    const loaded = config.loadAmemConfig(f.base).config;
    expect(loaded.records).toBe(true);
    expect(loaded.recordInstruction).toBe(instruction ?? "a");
    expect(recordsEnabled(f.base)).toBe(true);
  });
}

test("repo records stays boolean and false overrides machine instruction variants", () => {
  for (const instruction of ["a", "b", "alternate"] as const) {
    const f = fixture({ instruction }, false);
    const loaded = config.loadAmemConfig(f.base, f.cwd).config;
    expect(loaded.records).toBe(false);
    expect(loaded.recordInstruction).toBe(instruction);
    expect(recordsEnabled(f.base, f.cwd)).toBe(false);
  }
  const f = fixture(true, false);
  expect(() => config.loadAmemConfig(f.base, f.cwd)).not.toThrow();
  writeFileSync(join(f.cwd, ".amem", "config"), JSON.stringify({ records: { instruction: "b" } }));
  expect(() => config.loadAmemConfig(f.base, f.cwd)).toThrow("records is not a boolean");
});

for (const records of [{ extra: true }, { instruction: "c" }, { instruction: null }, []]) {
  test(`machine records instruction object refuses ${JSON.stringify(records)}`, () => {
    const f = fixture(records);
    expect(() => config.loadAmemConfig(f.base)).toThrow();
  });
}

test("recordInstruction is not a top-level machine or repository input", () => {
  const f = hookFixture(); fixtures.push(f);
  mkdirSync(f.base, { recursive: true });
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ recordInstruction: "b" }));
  expect(() => config.loadAmemConfig(f.base)).toThrow('unknown key "recordInstruction"');
  writeFileSync(join(f.base, "amem.config.json"), "{}");
  mkdirSync(join(f.cwd, ".amem"), { recursive: true });
  writeFileSync(join(f.cwd, ".amem", "config"), JSON.stringify({ recordInstruction: "b" }));
  expect(() => config.loadAmemConfig(f.base, f.cwd)).toThrow('unknown key "recordInstruction"');
});

for (const machine of [undefined, true, false]) for (const repo of [undefined, true, false]) {
  test(`public records policy: machine=${machine}, repo=${repo}`, () => {
    const f = fixture(machine, repo), nested = join(f.cwd, "nested"); mkdirSync(nested);
    expect(recordsEnabled(f.base)).toBe(machine !== false);
    expect(recordsEnabled(f.base, nested)).toBe(machine !== false && repo !== false);
    expect(recordsEnabled(f.base, nested)).toBe(config.loadAmemConfig(f.base, config.repoConfigRoot(nested)).config.records !== false);
    expect(recordsEnabled(f.base, f.root)).toBe(machine !== false);
  });
}

for (const where of ["machine", "repo"]) for (const raw of ['{"records":', '{"records":"false"}', '{"unknown":true}']) {
  test(`public records policy preserves ${where} config refusal: ${raw}`, () => {
    const f = fixture();
    writeFileSync(where === "machine" ? join(f.base, "amem.config.json") : join(f.cwd, ".amem", "config"), raw);
    let failure: unknown;
    try { config.loadAmemConfig(f.base, config.repoConfigRoot(f.cwd)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(() => recordsEnabled(f.base, f.cwd)).toThrow((failure as Error).message);
  });
}

test("SessionStart instruction and Stop transcript capture call the exported policy implementation", async () => {
  const f = fixture(true, true); await f.seed();
  const policy = spyOn(config, "recordsEnabled").mockReturnValue(false);
  try {
    const result = await runHook("SessionStart", { source: "resume" }, { base: f.base, cwd: f.cwd }, { deadlineMs: 2000 });
    expect(result.output?.hookSpecificOutput.additionalContext).toStartWith("Untrusted project memory data");
    expect(result.output?.hookSpecificOutput.additionalContext).not.toContain(RECORD_INSTRUCTION);
    expect(policy).toHaveBeenCalledWith(f.base, f.cwd);
    policy.mockClear();
    const transcript = join(f.root, "transcript.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: {
      id: "record-policy-test", role: "assistant", content: [{ type: "text", text: "amem: decision | - | shared policy" }],
    } }) + "\n");
    await scanHookTranscriptTail({ transcript_path: transcript, session_id: "policy-session" }, { base: f.base, cwd: f.cwd, deadline: performance.now() + 2000 });
    expect(policy).toHaveBeenCalledWith(f.base, f.cwd);
  } finally { policy.mockRestore(); }
});
