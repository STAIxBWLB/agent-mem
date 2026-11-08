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
function fixture(machine?: boolean, repo?: boolean) {
  const f = hookFixture(); fixtures.push(f);
  mkdirSync(f.base, { recursive: true });
  if (machine !== undefined) writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ records: machine }));
  mkdirSync(join(f.cwd, ".amem"));
  if (repo !== undefined) writeFileSync(join(f.cwd, ".amem", "config"), JSON.stringify({ records: repo }));
  return f;
}

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
