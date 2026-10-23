import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookGit } from "../src/hook-git.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { memoryGitEnv, memoryGitSync, realPath } from "../src/memory/platform.ts";

test("native hook Git port preserves project keys for ordinary, configured, linked and bare repositories", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-native-git-"))), saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  const git = (cwd: string, args: string[]) => { const r = memoryGitSync(["-C", cwd, ...args], { encoding: "utf8", env: memoryGitEnv(process.env, { repositoryIsolation: true }) }); expect(r.status, r.stderr).toBe(0); };
  const same = (cwd: string) => expect(memoryProjectKey(cwd, { repositoryIsolation: true, strictGitErrors: true, gitRead: hookGit(() => 1000) })).toBe(memoryProjectKey(cwd, { repositoryIsolation: true, strictGitErrors: true }));
  try {
    const repo = join(root, "repo"), bare = join(root, "bare.git"), separate = join(root, "separate"), metadata = join(root, "metadata");
    mkdirSync(repo); mkdirSync(bare); mkdirSync(separate); git(repo, ["init", "-q"]); git(bare, ["init", "-q", "--bare"]);
    same(repo); same(bare); mkdirSync(join(repo, "nested")); same(join(repo, "nested"));
    git(repo, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
    git(repo, ["worktree", "add", "-qb", "linked", join(root, "linked")]); same(join(root, "linked"));
    git(separate, ["init", "-q", `--separate-git-dir=${metadata}`]); same(separate);
    const hiddenMetadata = join(root, "metadata-parent", ".git"), hiddenCheckout = join(root, "hidden-checkout");
    mkdirSync(join(root, "metadata-parent")); mkdirSync(hiddenCheckout);
    git(hiddenCheckout, ["init", "-q", `--separate-git-dir=${hiddenMetadata}`]); same(hiddenCheckout);
    git(repo, ["remote", "add", "origin", "https://github.com/fixture/port"]); same(repo);
    appendFileSync(join(repo, ".git", "config"), "\n[core]\nrepositoryformatversion = 999\n");
    expect(() => memoryProjectKey(repo, { repositoryIsolation: true, strictGitErrors: true, gitRead: hookGit(() => 1000) })).toThrow("Git project identity unavailable");
  } finally { if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved; rmSync(root, { recursive: true, force: true }); }
});

test("native Git intake refuses exhausted budgets and oversized or invalid output", () => {
  expect(() => hookGit(() => 0)(["--version"], {})).toThrow("Git project identity unavailable");
  const root = mkdtempSync(join(tmpdir(), "amem-native-git-cap-")), executable = join(root, "git");
  try {
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' -e 'process.stdout.write("x".repeat(70000))'\n`, { mode: 0o700 });
    expect(() => hookGit(() => 1000)(["--version"], { PATH: root })).toThrow();
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' -e 'process.stdout.write(Buffer.from([255]))'\n`, { mode: 0o700 });
    expect(() => hookGit(() => 1000)(["--version"], { PATH: root })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Git output overflow cannot leave the hook worker's owned native descendant alive", async () => {
  const { hookFixture } = await import("./fakes/hooks-fixture.ts");
  const { readFileSync, existsSync } = await import("node:fs");
  const f = hookFixture(), bin = join(f.root, "bin"), pidFile = join(f.root, "native.pid"); mkdirSync(bin);
  let pid: number | undefined;
  const alive = () => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    writeFileSync(join(bin, "git"), `#!/bin/sh\n/bin/sleep 30 >/dev/null 2>&1 &\necho $! > '${pidFile}'\n'${process.execPath}' -e 'process.stdout.write("x".repeat(70000))'\n`, { mode: 0o700 });
    const { stageHookCapture } = await import("../src/hook-spool.ts");
    const priorHome = process.env.HOME;
    let pending: Awaited<ReturnType<typeof stageHookCapture>>;
    try {
      process.env.HOME = f.env.HOME;
      pending = await stageHookCapture("PostToolUse", { prompt: "overflow retention fixture" }, { cwd: f.cwd, base: f.base });
    } finally { if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome; }
    expect(pending).toBeDefined();
    // Test the worker's overflow/reaper after a real staged intake, independently of
    // two cold Bun boots reaching Git within the production hook's 140 ms budget.
    // Actual executable R1/R2 and native deadline tests retain their original bounds.
    const child = Bun.spawn([process.execPath, "--smol", join(import.meta.dir, "../src/session-brief-worker.ts")], {
      cwd: f.cwd, env: { PATH: `${bin}:${f.env.PATH}`, HOME: f.env.HOME, AMEM_HOME: f.base }, detached: true,
      stdin: Buffer.from(JSON.stringify({ cwd: f.cwd, base: f.base, current: pending!.name, event: "PostToolUse", maxTokens: 1200, ownedGroup: true, deadlineAt: performance.timeOrigin + performance.now() + 1000 })), stdout: "pipe", stderr: "pipe",
    });
    let exited = false;
    const exit = child.exited.then(code => { exited = true; return code; });
    const kill = () => { if (!exited) try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const timeout = setTimeout(kill, 1500);
    try { await Promise.all([exit, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
    finally { clearTimeout(timeout); kill(); await exit; }
    expect(existsSync(pidFile)).toBe(true);
    pid = Number(readFileSync(pidFile, "utf8")); expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    const until = performance.now() + 500;
    while (alive() && performance.now() < until) await Bun.sleep(10);
    expect(alive()).toBe(false); expect(f.rows()).toHaveLength(0);
  } finally { if (alive()) try { process.kill(pid!, "SIGKILL"); } catch { /* Only this fixture's recorded descendant. */ } f.close(); }
}, 5000);
