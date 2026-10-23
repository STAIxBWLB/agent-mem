import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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


test("two async Git queries prepare filesystem and cache bindings only once", () => {
  const f = hookFixture(), preload = join(f.root, "count-project-preparation.ts"), source = resolve(import.meta.dir, "../src/hook-project.ts");
  try {
    writeFileSync(preload, `import {readFileSync} from 'node:fs';globalThis.__hookPrepareCount=0;
Bun.plugin({name:'count-project-preparation',setup(b){b.onLoad({filter:/hook-project\\.ts$/},({path})=>{const body=readFileSync(path,'utf8'),needle='const cwd = realPath';if(body.split(needle).length!==2)throw Error('preparation anchor changed');return{loader:'ts',contents:body.replace(needle,'globalThis.__hookPrepareCount++;'+needle)};});}});`);
    const script = `const {resolveHookProjectAsync}=await import(${JSON.stringify(source)});const {hookCaptureScope}=await import(${JSON.stringify(resolve(import.meta.dir, "../src/hook-spool.ts"))});let queries=0;const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>{if(Array.isArray(argv)&&argv[0]==='/bin/sh'&&argv[3]==='amem-hook-native'&&(argv.includes('remote')||argv.includes('rev-parse')))queries++;return spawn(argv,options);};const until=performance.now()+2000;const project=await resolveHookProjectAsync({cwd:${JSON.stringify(f.cwd)},base:${JSON.stringify(f.base)},scope:hookCaptureScope(${JSON.stringify(f.cwd)},${JSON.stringify(f.base)}),timeRemaining:()=>until-performance.now()},{rssKB:0,rawRssKB:0});console.log(JSON.stringify({project,preparations:globalThis.__hookPrepareCount,queries}));`;
    const result = Bun.spawnSync([process.execPath, "--smol", "--preload", preload, "--eval", script], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ project: f.project, preparations: 1, queries: 2 });
  } finally { f.close(); }
});

for (const change of ["binary", "configuration"] as const) test(`async completion refuses a ${change} change after native await`, async () => {
  const f = hookFixture(), home = process.env.HOME, path = process.env.PATH, spawn = Bun.spawn;
  let intercepted = false, nativeQueries = 0;
  try {
    process.env.HOME = f.env.HOME;
    const bin = join(f.root, "bin"), executable = join(bin, "git"), originalGit = Bun.which("git", { PATH: process.env.PATH })!;
    mkdirSync(bin); writeFileSync(executable, `#!/bin/sh\nexec '${originalGit}' "$@"\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${path ?? ""}`;
    const options = binding(f.cwd, f.base), config = join(f.cwd, ".git", "config");
    Object.assign(Bun, { spawn(argv: string[], options: unknown) {
      if (argv[0] === "/bin/sh" && argv[3] === "amem-hook-native" && (argv.includes("remote") || argv.includes("rev-parse"))) nativeQueries++;
      const child = Reflect.apply(spawn, Bun, [argv, options]);
      if (!intercepted && argv[0] === "/bin/sh" && argv[3] === "amem-hook-native" && argv.includes("remote")) {
        intercepted = true;
        child.exited.then(() => change === "binary" ? appendFileSync(executable, "# replaced binary revision\n") : appendFileSync(config, "\n[user]\nname = changed nonidentity configuration\n"));
      }
      return child;
    } });
    await expect(resolveHookProjectAsync(options, { rssKB: 0, rawRssKB: 0 })).rejects.toThrow(change === "binary" ? "binary changed" : "scope changed");
    expect(intercepted).toBe(true);
    if (change === "binary") expect(nativeQueries).toBe(1);
    if (change === "configuration") expect(hookCaptureScope(f.cwd, f.base)).toBe(options.scope);
    const dir = join(f.base, "hook-project");
    expect(existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")) : []).toEqual([]);
  } finally { Bun.spawn = spawn; if (home === undefined) delete process.env.HOME; else process.env.HOME = home; if (path === undefined) delete process.env.PATH; else process.env.PATH = path; f.close(); }
});
