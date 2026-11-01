import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { processSignature } from "../src/memory/platform.ts";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function group(pid: number): number | undefined {
  const result = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "pgid="], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? Number(result.stdout.toString().trim()) : undefined;
}
function groupMembers(pgid: number): number[] {
  const result = Bun.spawnSync(["/bin/ps", "-axo", "pid=,pgid="], { stdout: "pipe", stderr: "pipe", timeout: 1000 });
  if (result.exitCode !== 0) throw new Error("process table unavailable");
  return result.stdout.toString().split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    return match && Number(match[2]) === pgid ? [Number(match[1])] : [];
  });
}
function jsonLines(file: string): Record<string, number>[] {
  if (!existsSync(file)) return [];
  const result: Record<string, number>[] = [];
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    try { result.push(JSON.parse(line) as Record<string, number>); } catch { /* Wait for the writer to finish this line. */ }
  }
  return result;
}

test("the CLI parent owns native Git and its watchdog reaps the group after caller death", async () => {
  const f = hookFixture(), bin = join(f.root, "bin"), marker = join(f.root, "blocked-git.jsonl"), metadata = join(f.root, "owned-native.jsonl"), caller = join(f.root, "caller.ts");
  const hooks = resolve(import.meta.dir, "../src/hooks.ts");
  mkdirSync(bin);
  const fakeGit = "#!/bin/sh\n/bin/sleep 30 >/dev/null 2>&1 & descendant=$!\nprintf '%s %s %s\\n' \"$$\" \"$PPID\" \"$descendant\" >> '" + marker + "'\nwait\n";
  writeFileSync(join(bin, "git"), fakeGit, { mode: 0o700 });
  const callerSource = [
    "import{appendFileSync}from'node:fs';",
    "import{hookMain}from" + JSON.stringify(hooks) + ";",
    "const spawn=Bun.spawn.bind(Bun),receipt=" + JSON.stringify(metadata) + ";",
    "Bun.spawn=(argv,options)=>{const child=spawn(argv,options);if(Array.isArray(argv)&&argv[0]==='/bin/sh'&&argv[3]==='amem-hook-native')appendFileSync(receipt,JSON.stringify({caller:process.pid,leader:child.pid,marker:argv[4]})+'\\n',{mode:0o600});return child;};",
    "await hookMain(process.argv.slice(2),performance.now(),{deadlineMs:1500});",
  ].join("\n");
  writeFileSync(caller, callerSource, { mode: 0o600 });
  const callerProcess = Bun.spawn([process.execPath, "--smol", caller, "PostToolUse"], {
    cwd: f.cwd, env: { ...f.env, PATH: bin + ":" + f.env.PATH },
    stdin: Buffer.from(JSON.stringify({ hook_event_name: "PostToolUse", cwd: f.cwd, session_id: "watchdog-parent-owner", prompt: "preserve capture" })),
    stdout: "ignore", stderr: "pipe",
  });
  let native: { caller: number; leader: number; marker: string; signature?: string; pgid?: number }[] = [];
  let descendants: { pid: number; signature?: string; pgid?: number }[] = [];
  let callerKilled = false;
  try {
    const callerSignature = processSignature(callerProcess.pid);
    expect(callerSignature).toBeDefined();
    const readyUntil = performance.now() + 2000;
    while ((!jsonLines(marker).length || !jsonLines(metadata).length) && performance.now() < readyUntil) await Bun.sleep(5);
    const ownerRows = jsonLines(metadata), gitRows = jsonLines(marker);
    expect(ownerRows.length).toBeGreaterThan(0); expect(gitRows.length).toBeGreaterThan(0);
    native = ownerRows.map(row => {
      const pid = row.leader!;
      return { caller: row.caller!, leader: pid, marker: String(row.marker), signature: processSignature(pid), pgid: group(pid) };
    });
    descendants = gitRows.map(row => {
      const owner = native.find(item => item.leader === row.supervisor && item.caller === callerProcess.pid);
      expect(owner).toBeDefined();
      const pid = row.descendant!;
      return { pid, signature: processSignature(pid), pgid: group(pid) };
    });
    expect(native.every(owner => owner.caller === callerProcess.pid && owner.signature && owner.pgid === owner.leader)).toBe(true);
    expect(descendants.every(child => child.signature && child.pgid && native.some(owner => owner.pgid === child.pgid))).toBe(true);
    process.kill(callerProcess.pid, "SIGKILL"); callerKilled = true; await callerProcess.exited;
    const goneUntil = performance.now() + 2000;
    while ([...native.map(owner => owner.leader), ...descendants.map(child => child.pid)].some(alive) && performance.now() < goneUntil) await Bun.sleep(10);
    expect(native.every(owner => !alive(owner.leader) && groupMembers(owner.pgid!).length === 0)).toBe(true);
    expect(descendants.every(child => !alive(child.pid))).toBe(true);
  } finally {
    // Only the original private fixture groups, revalidated by PID signature and group ID.
    if (!callerKilled && alive(callerProcess.pid)) callerProcess.kill("SIGKILL");
    await callerProcess.exited;
    const ownedRows = native.length ? native : jsonLines(metadata).flatMap(row => Number.isSafeInteger(row.leader)
      ? [{ caller: Number(row.caller), leader: Number(row.leader), marker: String(row.marker) }] : []);
    const recordedDescendants = descendants.length ? descendants : jsonLines(marker).flatMap(row => [row.git, row.supervisor, row.descendant].every(Number.isSafeInteger)
      ? [{ git: Number(row.git), supervisor: Number(row.supervisor), descendant: Number(row.descendant) }] : []);
    const cleanupUntil = performance.now() + 1800;
    while ([...ownedRows.map(owner => owner.leader), ...recordedDescendants.map(row => row.descendant)].some(alive) && performance.now() < cleanupUntil) await Bun.sleep(10);
    for (const owner of ownedRows) if (alive(owner.leader)) {
      const current = Bun.spawnSync(["/bin/ps", "-ww", "-p", String(owner.leader), "-o", "pgid=,command="], { stdout: "pipe", stderr: "ignore", timeout: 1000 });
      const command = current.stdout.toString(), pgid = Number(command.trim().split(/\s+/, 1)[0]);
      if (current.exitCode === 0 && pgid === owner.leader && command.includes("amem-hook-native") && command.includes(owner.marker)) {
        try { process.kill(-owner.leader, "SIGKILL"); } catch { /* Already exited. */ }
      }
    }
    for (const row of recordedDescendants) if (alive(row.descendant)) {
      const current = Bun.spawnSync(["/bin/ps", "-p", String(row.descendant), "-o", "pgid=,comm="], { stdout: "pipe", stderr: "ignore", timeout: 1000 });
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(current.stdout.toString());
      if (current.exitCode === 0 && match && Number(match[1]) === row.supervisor && /(?:^|\/)sleep$/.test(match[2]!)) {
        try { process.kill(row.descendant, "SIGKILL"); } catch { /* Already exited. */ }
      }
    }
    await callerProcess.stderr.cancel().catch(() => {}); f.close();
  }
}, 7000);
