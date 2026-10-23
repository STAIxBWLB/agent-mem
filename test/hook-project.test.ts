import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture, workMarker } from "./fakes/hooks-fixture.ts";
import { hookCaptureScope } from "../src/hook-spool.ts";
import { resolveHookProject } from "../src/hook-project.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [], originalHome = process.env.HOME;
afterEach(() => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; for (const f of fixtures.splice(0)) f.close(); });
function fixture() { const f = hookFixture(); fixtures.push(f); process.env.HOME = f.env.HOME; return f; }
function binding(f: ReturnType<typeof hookFixture>) { const scope = hookCaptureScope(f.cwd, f.base); expect(scope).toBeDefined(); return { cwd: f.cwd, base: f.base, scope: scope!, timeRemaining: () => 3000 }; }
function cache(f: ReturnType<typeof hookFixture>) { return join(f.base, "hook-project", readdirSync(join(f.base, "hook-project"))[0]!); }
function noGit(f: ReturnType<typeof hookFixture>) {
  const preload = join(f.root, "refuse-git.ts"), worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  writeFileSync(preload, `const worker=${JSON.stringify(worker)},preload=${JSON.stringify(preload)},spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>spawn(Array.isArray(argv)&&argv[2]===worker?[argv[0],argv[1],'--preload',preload,...argv.slice(2)]:argv,options);if(process.argv[1]===worker){const sync=Bun.spawnSync.bind(Bun);Bun.spawnSync=(argv,options)=>{if(Array.isArray(argv)&&(argv.includes('remote')||argv.includes('rev-parse')))throw new Error('unexpected native Git query');return sync(argv,options);};}`);
  return { BUN_OPTIONS: `--preload=${preload}` };
}

test("a native-validated cached identity removes Git from SessionStart while preserving known work", async () => {
  const f = fixture(); await f.seed();
  expect(resolveHookProject(binding(f))).toBe(f.project);
  expect(statSync(cache(f)).mode & 0o777).toBe(0o600); expect(statSync(join(f.base, "hook-project")).mode & 0o777).toBe(0o700);
  const result = f.run("SessionStart", {}, noGit(f));
  expect(result.exitCode).toBe(0); expect(result.stdout.length).toBeGreaterThan(0);
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext).toContain(workMarker);
  // The same fixture without a valid receipt must really reach the refused Git port.
  rmSync(cache(f));
  expect(f.run("SessionStart", {}, noGit(f)).stdout.length).toBe(0);
});

test("origin changes and malformed, oversized or linked cache entries cannot reuse a project", async () => {
  const f = fixture(); await f.seed(); const initial = binding(f);
  expect(resolveHookProject(initial)).toBe(f.project);
  const file = cache(f), original = readFileSync(file, "utf8"), target = join(f.root, "foreign-cache");
  for (const text of ["{", "x".repeat(5000)]) {
    writeFileSync(file, text, { mode: 0o600 });
    expect(f.run("SessionStart", {}, noGit(f)).stdout.length).toBe(0);
  }
  rmSync(file); writeFileSync(target, original, { mode: 0o600 }); symlinkSync(target, file);
  expect(f.run("SessionStart", {}, noGit(f)).stdout.length).toBe(0);
  rmSync(file); writeFileSync(file, original, { mode: 0o600 });
  const changed = Bun.spawnSync(["git", "-C", f.cwd, "remote", "add", "origin", "https://example.invalid/another/repository.git"], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(changed.exitCode).toBe(0); expect(hookCaptureScope(f.cwd, f.base)).not.toBe(initial.scope);
  expect(f.run("SessionStart", {}, noGit(f)).stdout.length).toBe(0);
  expect(() => resolveHookProject(initial)).toThrow("scope changed");
  expect(resolveHookProject(binding(f))).not.toBe(f.project);
});

test("a cache receipt with the wrong executable revision is a miss, not trusted metadata", async () => {
  const f = fixture(); await f.seed(); resolveHookProject(binding(f));
  const file = cache(f), value = JSON.parse(readFileSync(file, "utf8"));
  value.binary = "0".repeat(64); writeFileSync(file, JSON.stringify(value)); chmodSync(file, 0o600);
  expect(f.run("SessionStart", {}, noGit(f)).stdout.length).toBe(0);
  expect(existsSync(file)).toBe(true);
  // A different actual PATH binary must invalidate even a structurally valid prior receipt.
  resolveHookProject(binding(f));
  const bin = join(f.root, "bin"); mkdirSync(bin); writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 77\n", { mode: 0o700 });
  expect(f.run("SessionStart", {}, { PATH: `${bin}:${f.env.PATH}` }).stdout.length).toBe(0);
});

test("derived project cache stays bounded and old HOME bindings cannot be reused", async () => {
  const f = fixture(); await f.seed();
  const dir = join(f.base, "hook-project"); mkdirSync(dir, { mode: 0o700 });
  for (let i = 0; i < 128; i++) writeFileSync(join(dir, `occupied-${i}`), "{}", { mode: 0o600 });
  expect(resolveHookProject(binding(f))).toBe(f.project); expect(readdirSync(dir)).toHaveLength(128);
  rmSync(dir, { recursive: true }); resolveHookProject(binding(f));
  const home = join(f.root, "another-home"); mkdirSync(home);
  expect(f.run("SessionStart", {}, { ...noGit(f), HOME: home }).stdout.length).toBe(0);
});

test("a changed Git-format or HEAD validity cannot hide behind the pending-capture semantic stamp", async () => {
  const f = fixture(); await f.seed(); const initial = binding(f); resolveHookProject(initial);
  const config = join(f.cwd, ".git", "config"), head = join(f.cwd, ".git", "HEAD");
  const configText = readFileSync(config, "utf8"), headText = readFileSync(head, "utf8");
  writeFileSync(config, configText.replace(/repositoryformatversion\s*=\s*0/, "repositoryformatversion = 999"));
  expect(hookCaptureScope(f.cwd, f.base)).toBe(initial.scope);
  expect(f.run("SessionStart", {}, noGit(f)).stdout.length).toBe(0);
  writeFileSync(config, configText); writeFileSync(head, "invalid HEAD\n");
  expect(hookCaptureScope(f.cwd, f.base)).toBe(initial.scope);
  expect(f.run("SessionStart", {}, noGit(f)).stdout.length).toBe(0);
  writeFileSync(head, headText);
  expect(JSON.parse(f.run("SessionStart", {}, noGit(f)).stdout.toString()).hookSpecificOutput.additionalContext).toContain(workMarker);
});

test("the shared alias reader leaf resolves an alias without loading SQLite mutation machinery", () => {
  const f = fixture(), preload = join(f.root, "no-sqlite.ts"), marker = join(f.root, "early-sqlite");
  const aliases = resolve(import.meta.dir, "../src/memory/aliases.ts");
  writeFileSync(preload, `import {writeFileSync} from 'node:fs';Bun.plugin({name:'alias-sqlite-tripwire',setup(b){b.onLoad({filter:/memory\\/mutation\\.ts$/},()=>{writeFileSync(${JSON.stringify(marker)},'early');throw new Error('SQLite on alias-only read');});}});`);
  const script = `import {appendAlias,resolveAlias} from ${JSON.stringify(aliases)};appendAlias(${JSON.stringify(f.base)},{alias:'legacy',key:'canonical',actor:'fixture',machine:'0000000000000000'});console.log(resolveAlias(${JSON.stringify(f.base)},'legacy'));`;
  const result = Bun.spawnSync([process.execPath, "--smol", "--preload", preload, "-e", script], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(result.stdout.toString(), `early SQLite attempted=${existsSync(marker)}`).toBe("canonical\n");
  expect(result.exitCode).toBe(0); expect(existsSync(marker)).toBe(false);
});
