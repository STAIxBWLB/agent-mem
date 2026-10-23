import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookCaptureScope } from "../src/hook-spool.ts";
import { resolveHookProject, resolveHookProjectAsync } from "../src/hook-project.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { memoryGitEnv, memoryGitSync } from "../src/memory/platform.ts";

function binding(cwd: string, base: string) {
  const scope = hookCaptureScope(cwd, base); expect(scope).toBeDefined();
  const until = performance.now() + 2000;
  return { cwd, base, scope: scope!, timeRemaining: () => until - performance.now() };
}

test("async native identity keeps shared resolver parity for remote, nested and linked worktrees", async () => {
  const f = hookFixture(), home = process.env.HOME;
  try {
    process.env.HOME = f.env.HOME;
    const git = (...args: string[]) => expect(memoryGitSync(["-C", f.cwd, ...args], { encoding: "utf8", env: memoryGitEnv(process.env, { repositoryIsolation: true }) }).status).toBe(0);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    const nested = join(f.cwd, "nested"), linked = join(f.root, "linked"); mkdirSync(nested);
    git("remote", "add", "origin", "https://example.invalid/async/fixture.git");
    git("worktree", "add", "-qb", "async-linked", linked);
    for (const cwd of [f.cwd, nested, linked]) {
      const actual = await resolveHookProjectAsync(binding(cwd, f.base), { rssKB: 0, rawRssKB: 0 });
      expect(actual).toBe(memoryProjectKey(cwd, { repositoryIsolation: true, strictGitErrors: true }));
    }
  } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; f.close(); }
});

test("a scope change after an async native read refuses identity and publishes no cache", async () => {
  const f = hookFixture(), home = process.env.HOME, spawn = Bun.spawn;
  let intercepted = false;
  try {
    process.env.HOME = f.env.HOME;
    const options = binding(f.cwd, f.base), config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
    Object.assign(Bun, { spawn(argv: string[], options: unknown) {
      const child = Reflect.apply(spawn, Bun, [argv, options]);
      if (!intercepted && argv[0] === "/bin/sh" && argv[3] === "amem-hook-native" && argv.includes("remote")) {
        intercepted = true;
        child.exited.then(() => writeFileSync(config, original + '\n[remote "origin"]\nurl = https://example.invalid/changed/identity.git\n'));
      }
      return child;
    } });
    await expect(resolveHookProjectAsync(options, { rssKB: 0, rawRssKB: 0 })).rejects.toThrow("scope changed");
    expect(intercepted).toBe(true);
    const dir = join(f.base, "hook-project");
    expect(existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")) : []).toEqual([]);
  } finally { Bun.spawn = spawn; if (home === undefined) delete process.env.HOME; else process.env.HOME = home; f.close(); }
});


test("a suspended identity completion fence cannot publish even an otherwise valid native key", () => {
  const f = hookFixture(), home = process.env.HOME;
  try {
    process.env.HOME = f.env.HOME;
    const options = binding(f.cwd, f.base);
    expect(() => resolveHookProject({ ...options,
      gitRead: (args, env) => { const value = memoryGitSync(args, { env, encoding: "utf8" }); return { status: value.status, stdout: value.stdout }; },
      assertComplete: () => { throw new Error("native identity suspended"); },
    })).toThrow("native identity suspended");
    const dir = join(f.base, "hook-project");
    expect(existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")) : []).toEqual([]);
  } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; f.close(); }
});
