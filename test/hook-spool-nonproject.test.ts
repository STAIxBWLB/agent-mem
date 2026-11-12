import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stageTranscriptCapture } from "../src/hook-spool.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

// #385 AC1: summary captures staged from a directory that resolves to no project never drain
// from a later hook at the project root. This pins the current behavior before the fix.
const fixtures: ReturnType<typeof hookFixture>[] = [], originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) f.close();
});

function pending(base: string): { cwd: string; event: string }[] {
  const dir = join(base, "hook-spool");
  return [dir, join(dir, ".capacity")].flatMap(folder => (existsSync(folder) ? readdirSync(folder) : [])
    .filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))
    .map(name => { const record = JSON.parse(readFileSync(join(folder, name), "utf8")) as { cwd: string; capture: { event: string } }; return { cwd: record.cwd, event: record.capture.event }; }));
}

test("#385 AC1: a summary staged from a non-project directory stays pending after later hooks at the project root", async () => {
  const f = hookFixture(); fixtures.push(f); process.env.HOME = f.env.HOME;
  const scratch = join(f.root, "scratch"); mkdirSync(scratch); // Not a git repository: resolves to no project.
  const excerpt = "nonproject summary 385";
  const staged = await stageTranscriptCapture({ agent: "claude", event: "Title", at: new Date().toISOString(), excerpt }, { cwd: scratch, base: f.base });
  expect(staged).toBeDefined();
  expect(pending(f.base).filter(row => row.cwd === scratch).map(row => row.event)).toEqual(["Title"]);

  // Later hooks from the same session fire at the project root; each one drains its own cwd only.
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    const result = f.runFunctional(event, { prompt: "continue" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }

  // Current behavior (the bug): the summary is still pending and never reached the project's rows.
  expect(pending(f.base).filter(row => row.cwd === scratch).map(row => row.event)).toEqual(["Title"]);
  expect(f.rows().some(row => (row as { excerpt?: string }).excerpt?.includes(excerpt))).toBe(false);
}, 20000);
