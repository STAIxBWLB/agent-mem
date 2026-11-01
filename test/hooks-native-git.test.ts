import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("parent-owned native Git overflow reaps its descendant and retains the staged capture", async () => {
  const { hookFixture } = await import("./fakes/hooks-fixture.ts");
  const { hookCapturePending } = await import("../src/hook-spool.ts");
  const { hookProcessObserver } = await import("./fakes/hooks-process-observer.ts");
  const { existsSync, readFileSync } = await import("node:fs");
  const f = hookFixture(), observer = hookProcessObserver(f.root), bin = join(f.root, "bin"), pidFile = join(f.root, "native.pid"); mkdirSync(bin);
  const fakeGitPath = join(bin, "git");
  let native: { pid: number; argv: string[] }[] = [], descendants: { supervisor: number; pid: number }[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
  const group = (pid: number): number | undefined => {
    const result = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "pgid="], { stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? Number(result.stdout.toString().trim()) : undefined;
  };
  const members = (pgid: number): number[] => {
    const result = Bun.spawnSync(["/bin/ps", "-axo", "pid=,pgid="], { stdout: "pipe", stderr: "pipe", timeout: 1000 });
    if (result.exitCode !== 0) throw new Error("process table unavailable");
    return result.stdout.toString().split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      return match && Number(match[2]) === pgid ? [Number(match[1])] : [];
    });
  };
  try {
    writeFileSync(fakeGitPath, `#!/bin/sh\n/bin/sleep 30 >/dev/null 2>&1 & child=$!\nprintf '%s %s\\n' "$PPID" "$child" >> '${pidFile}'\n'${process.execPath}' -e 'process.stdout.write("x".repeat(70000))'\n`, { mode: 0o700 });
    const hooks = join(import.meta.dir, "../src/hooks.ts"), functional = join(f.root, "parent-native-overflow.ts");
    writeFileSync(functional, `import { hookMain } from ${JSON.stringify(hooks)};const output=await hookMain(["PostToolUse"],performance.now(),{deadlineMs:1000});if(output)console.log(output);`, { mode: 0o600 });
    const payload = { hook_event_name: "PostToolUse", cwd: f.cwd, session_id: "native-overflow-retained", tool_response: "overflow retention fixture" };
    const result = Bun.spawnSync([process.execPath, "--smol", functional], { cwd: f.cwd,
      env: { ...f.env, PATH: bin + ":" + f.env.PATH, BUN_OPTIONS: `--preload=${observer.preload}` },
      stdin: Buffer.from(JSON.stringify(payload)), stdout: "pipe", stderr: "pipe", timeout: 5000 });
    expect(result.exitCode).toBe(0); expect(result.stdout.length).toBe(0);
    const receipts = observer.read().filter(row => row.kind === "native" && row.argv.includes(fakeGitPath));
    expect(receipts.length).toBeGreaterThan(0); expect(receipts.every(row => row.detached)).toBe(true);
    native = receipts.map(row => ({ pid: row.pid, argv: row.argv }));
    expect(existsSync(pidFile)).toBe(true);
    descendants = readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).map(line => {
      const [supervisor, pid] = line.split(/\s+/).map(Number); return { supervisor: supervisor!, pid: pid! };
    });
    expect(descendants.length).toBeGreaterThan(0);
    expect(descendants.every(row => native.some(owner => owner.pid === row.supervisor))).toBe(true);
    const until = performance.now() + 500;
    while ([...native.map(row => row.pid), ...descendants.map(row => row.pid)].some(alive) && performance.now() < until) await Bun.sleep(10);
    expect(native.every(row => !alive(row.pid) && members(row.pid).length === 0)).toBe(true);
    expect(descendants.every(row => !alive(row.pid))).toBe(true);

    const spool = join(f.base, "hook-spool"), pending = [spool, join(spool, ".capacity")].flatMap(dir =>
      existsSync(dir) ? readdirSync(dir).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name)).map(name => ({ name, value: JSON.parse(readFileSync(join(dir, name), "utf8")) })) : []);
    const retained = pending.filter(row => row.value.capture?.event === "PostToolUse" && row.value.capture?.excerpt === payload.tool_response);
    expect(retained).toHaveLength(1); expect(hookCapturePending(f.base, retained[0]!.name)).toBe(true); expect(f.rows().some(row => row.excerpt === payload.tool_response)).toBe(false);

    const runHook = (value: unknown, env: NodeJS.ProcessEnv) => Bun.spawnSync([process.execPath, "--smol", functional], { cwd: f.cwd, env,
      stdin: Buffer.from(JSON.stringify(value)), stdout: "pipe", stderr: "pipe", timeout: 5000 });
    const healthy = runHook({ hook_event_name: "PostToolUse", cwd: f.cwd, session_id: "native-overflow-healthy", tool_name: "Read", tool_input: { file_path: "src/public.ts" }, tool_response: "healthy follow-up" }, f.env);
    expect(healthy.exitCode).toBe(0);
    expect(f.rows().filter(row => row.excerpt === payload.tool_response)).toHaveLength(1);
    expect(hookCapturePending(f.base, retained[0]!.name)).toBe(false);
  } finally {
    const cleanupNative = native.length ? native : observer.read().filter(row => row.kind === "native" && row.argv.includes(fakeGitPath)).map(row => ({ pid: row.pid, argv: row.argv }));
    const cleanupChildren = descendants.length ? descendants : existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).map(line => {
      const [supervisor, pid] = line.split(/\s+/).map(Number); return { supervisor: supervisor!, pid: pid! };
    }) : [];
    for (const child of cleanupChildren) if (alive(child.pid) && group(child.pid) === child.supervisor) {
      const current = Bun.spawnSync(["/bin/ps", "-p", String(child.pid), "-o", "comm="], { stdout: "pipe", stderr: "ignore", timeout: 1000 });
      if (current.exitCode === 0 && /(?:^|\/)sleep$/.test(current.stdout.toString().trim())) try { process.kill(child.pid, "SIGKILL"); } catch { /* Only the recorded fixture sleep. */ }
    }
    for (const owner of cleanupNative) if (members(owner.pid).length) {
      const marker = owner.argv[4];
      const current = Bun.spawnSync(["/bin/ps", "-ww", "-p", String(owner.pid), "-o", "pgid=,command="], { stdout: "pipe", stderr: "ignore", timeout: 1000 });
      const command = current.stdout.toString(), pgid = Number(command.trim().split(/\s+/, 1)[0]);
      if (marker && current.exitCode === 0 && pgid === owner.pid && command.includes("amem-hook-native") && command.includes(marker)) try { process.kill(-owner.pid, "SIGKILL"); } catch { /* Only a recorded native supervisor group. */ }
    }
    f.close();
  }
}, 5000);
