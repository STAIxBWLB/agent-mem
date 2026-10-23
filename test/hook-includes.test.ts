import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookCaptureScope, stageHookCapture, drainHookCaptures } from "../src/hook-spool.ts";
import { resolveHookProjectAsync } from "../src/hook-project.ts";
import { CaptureStore } from "../src/memory/capture.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [], originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function fixture() {
  const value = hookFixture("https://example.invalid/includes/project.git"); fixtures.push(value); process.env.HOME = value.env.HOME;
  return value;
}

test("HOME includeIf candidates support native project resolution and pending capture drains exactly once", async () => {
  const f = fixture(), home = f.env.HOME!, included = join(home, "common.gitconfig"), unrelated = join(home, "unmatched.gitconfig");
  writeFileSync(included, "[user]\n  name = Hook Include Fixture\n");
  writeFileSync(unrelated, '[remote "origin"]\n  url = https://example.invalid/foreign/never-active.git\n');
  writeFileSync(join(home, ".gitconfig"), `[includeIf "gitdir:${f.cwd}/.git/"]\n  path = ~/common.gitconfig\n[includeIf "gitdir:/never/matches/"]\n  path = ~/unmatched.gitconfig\n`);
  const scope = hookCaptureScope(f.cwd, f.base); expect(scope).toBeDefined();
  const project = await resolveHookProjectAsync({ cwd: f.cwd, base: f.base, scope, timeRemaining: () => 3000 }, { rssKB: 0, rawRssKB: 0 });
  expect(project).toBe("example.invalid/includes/project");
  const options = { cwd: f.cwd, base: f.base }, staged = await stageHookCapture("PostToolUse", { cwd: f.cwd, prompt: "HOME includeIf capture retained" }, options);
  expect(staged).toBeDefined();
  const store = new CaptureStore({ home: f.root, project });
  try {
    const append = (input: Parameters<typeof store.append>[0], receipt: string) => store.append(input, { receipt });
    expect((await drainHookCaptures({ ...options, project }, append)).captured).toEqual([staged!.name]);
    expect((await drainHookCaptures({ ...options, project }, append)).captured).toEqual([]);
    expect(store.rows({ project }).filter(row => row.excerpt === "HOME includeIf capture retained")).toHaveLength(1);
  } finally { store.close(); }
  // An unmatched candidate is a dependency, never an active duplicate-origin decision.
  writeFileSync(unrelated, '[remote "origin"]\n  url = https://example.invalid/foreign/changed.git\n');
  expect(hookCaptureScope(f.cwd, f.base)).not.toBe(scope);
});

test("relative includes bind nested candidate bytes and excessive depth or file count stays unknown", () => {
  const f = fixture(), home = f.env.HOME!, dir = join(home, "git-config"); mkdirSync(dir);
  writeFileSync(join(home, ".gitconfig"), '[include]\n  path = git-config/one\n');
  writeFileSync(join(dir, "one"), '[include]\n  path = two\n');
  writeFileSync(join(dir, "two"), "[user]\n  name = Nested Fixture\n");
  const initial = hookCaptureScope(f.cwd, f.base); expect(initial).toBeDefined();
  writeFileSync(join(dir, "two"), "[user]\n  name = Changed Nested Fixture\n"); expect(hookCaptureScope(f.cwd, f.base)).not.toBe(initial);
  for (let n = 1; n <= 5; n++) writeFileSync(join(dir, `depth-${n}`), n === 5 ? "[user]\n name = Deep\n" : `[include]\n path = depth-${n + 1}\n`);
  writeFileSync(join(home, ".gitconfig"), '[include]\n path = git-config/depth-1\n');
  expect(hookCaptureScope(f.cwd, f.base)).toBeUndefined();
  writeFileSync(join(home, ".gitconfig"), Array.from({ length: 17 }, (_, n) => `[include]\n path = git-config/missing-${n}\n`).join(""));
  expect(hookCaptureScope(f.cwd, f.base)).toBeUndefined();
});

test("onbranch conditions bind HEAD and include cycles remain unknown", () => {
  const f = fixture(), home = f.env.HOME!, candidate = join(home, "branch.gitconfig");
  writeFileSync(candidate, '[remote "origin"]\n url = https://example.invalid/branch/conditional.git\n');
  writeFileSync(join(home, ".gitconfig"), '[includeIf "onbranch:topic"]\n path = ~/branch.gitconfig\n');
  const before = hookCaptureScope(f.cwd, f.base); expect(before).toBeDefined();
  writeFileSync(join(f.cwd, ".git", "HEAD"), "ref: refs/heads/topic\n"); expect(hookCaptureScope(f.cwd, f.base)).not.toBe(before);
  writeFileSync(candidate, '[include]\n path = .gitconfig\n');
  expect(hookCaptureScope(f.cwd, f.base)).toBeUndefined();
});

test("hasconfig include conditions bind non-origin remote sources without selecting the candidate origin", () => {
  const f = fixture(), home = f.env.HOME!, candidate = join(home, "condition.gitconfig");
  writeFileSync(candidate, '[remote "origin"]\n url = https://example.invalid/conditional/other-project.git\n');
  writeFileSync(join(home, ".gitconfig"), '[includeIf "hasconfig:remote.*.url:https://example.invalid/trigger/**"]\n path = ~/condition.gitconfig\n');
  const initial = hookCaptureScope(f.cwd, f.base); expect(initial).toBeDefined();
  const changed = Bun.spawnSync(["git", "-C", f.cwd, "config", "remote.upstream.url", "https://example.invalid/trigger/repo.git"], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(changed.exitCode).toBe(0);
  expect(hookCaptureScope(f.cwd, f.base)).not.toBe(initial);
});
