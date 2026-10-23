import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookCaptureScope } from "../src/hook-spool.ts";
import { resolveHookProject, resolveHookProjectAsync } from "../src/hook-project.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [];
const originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function unsupportedConfig(fixture: ReturnType<typeof hookFixture>) {
  const home = fixture.env.HOME!;
  for (let n = 1; n <= 5; n++) writeFileSync(join(home, `deep-${n}.gitconfig`), n === 5 ? "[user]\n name = Deep\n" : `[include]\n path = deep-${n + 1}.gitconfig\n`);
  writeFileSync(join(home, ".gitconfig"), "[include]\n path = deep-1.gitconfig\n");
}
function includedConfig() {
  const fixture = hookFixture("https://example.invalid/unknown-scope/native-project.git"); fixtures.push(fixture);
  process.env.HOME = fixture.env.HOME;
  unsupportedConfig(fixture);
  return fixture;
}
const cacheFiles = (base: string) => existsSync(join(base, "hook-project")) ? readdirSync(join(base, "hook-project")) : [];

test("unknown over-depth included Git configuration resolves natively without publishing or trusting a cache", async () => {
  const fixture = includedConfig();
  expect(hookCaptureScope(fixture.cwd, fixture.base)).toBeUndefined();
  const options = { cwd: fixture.cwd, base: fixture.base, scope: undefined, timeRemaining: () => 3000 };
  expect(resolveHookProject(options)).toBe("example.invalid/unknown-scope/native-project");
  expect(cacheFiles(fixture.base)).toEqual([]);
  const usage = { rssKB: 0, rawRssKB: 0 };
  expect(await resolveHookProjectAsync({ ...options, maintainCache: true }, usage)).toBe("example.invalid/unknown-scope/native-project");
  expect(cacheFiles(fixture.base)).toEqual([]);
  const changed = Bun.spawnSync(["git", "-C", fixture.cwd, "remote", "set-url", "origin", "https://example.invalid/unknown-scope/changed-project.git"], { env: fixture.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(changed.exitCode).toBe(0);
  expect(await resolveHookProjectAsync(options, usage)).toBe("example.invalid/unknown-scope/changed-project");
  expect(cacheFiles(fixture.base)).toEqual([]);
});

test("an unknown scope never reuses a formerly valid cache after an included remote changes", async () => {
  const fixture = hookFixture("https://example.invalid/cache/old-project.git"); fixtures.push(fixture); process.env.HOME = fixture.env.HOME;
  const scope = hookCaptureScope(fixture.cwd, fixture.base); expect(scope).toBeDefined();
  const options = { cwd: fixture.cwd, base: fixture.base, timeRemaining: () => 3000 };
  expect(resolveHookProject({ ...options, scope })).toBe("example.invalid/cache/old-project");
  expect(cacheFiles(fixture.base)).toHaveLength(1);
  // Git itself, rather than the conservative stamp parser, resolves this included origin.
  const remove = Bun.spawnSync(["git", "-C", fixture.cwd, "remote", "remove", "origin"], { env: fixture.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(remove.exitCode).toBe(0);
  const included = join(fixture.env.HOME!, "remote.gitconfig");
  writeFileSync(included, '[remote "origin"]\n  url = https://example.invalid/cache/new-project.git\n');
  appendFileSync(join(fixture.cwd, ".git", "config"), `\n[include]\n  path = ${included}\n`);
  unsupportedConfig(fixture);
  expect(hookCaptureScope(fixture.cwd, fixture.base)).toBeUndefined();
  expect(await resolveHookProjectAsync(options, { rssKB: 0, rawRssKB: 0 })).toBe("example.invalid/cache/new-project");
  expect(cacheFiles(fixture.base)).toHaveLength(1);
});
