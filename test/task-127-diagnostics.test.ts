import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { analyze, install } from "../scripts/task-127-instrument.ts";
import { transformSource } from "../scripts/task-127-transform.ts";

const repo = resolve(import.meta.dir, ".."), main = "0d15f5354773dbaa966cf4f75cd3a7890e87d0ff", head = "cdd196666e7efab2f7ec04c654a1bcfa8fd49517";
const targets = ["src/hooks.ts", "src/hook-spool.ts", "src/hook-transcript.ts", "src/session-brief-worker.ts", "test/fakes/hooks-fixture.ts", "scripts/measure-transcript-budget.ts"];
test("task127 every fixed variant anchor compiles and ordinary worker source is identical at both frozen heads", () => {
  for (const commit of [main, head]) for (const file of targets) {
    const source = execFileSync("git", ["show", `${commit}:${file}`], { cwd: repo }).toString();
    const transformed = transformSource(file, source);
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(transformed), `${commit}:${file}`).not.toThrow();
  }
  const file = "src/session-brief-worker.ts";
  expect(execFileSync("git", ["show", `${main}:${file}`], { cwd: repo }).equals(execFileSync("git", ["show", `${head}:${file}`], { cwd: repo }))).toBe(true);
  expect(() => transformSource("src/hooks.ts", "changed anchor")).toThrow("anchor mismatch");
});

test("task127 real isolated transport correlates native hook, process identities and scan bytes without changing source", async () => {
  const root = mkdtempSync(join(tmpdir(), "task127-transport-")), output = join(root, "diagnostic"), trace = join(root, "trace"), log = join(root, "stdout.log");
  const before = targets.map(file => readFileSync(join(repo, file), "utf8"));
  try {
    install(repo, output);
    const entry = join(root, "probe.ts");
    writeFileSync(entry, `import {hookFixture} from ${JSON.stringify(join(repo, "test/fakes/hooks-fixture.ts"))};import {writeFileSync} from 'node:fs';import {join} from 'node:path';const f=hookFixture();try{await f.seed();const t=join(f.root,'transcript.jsonl');writeFileSync(t,JSON.stringify({type:'ai-title',aiTitle:'task127 public transport',timestamp:new Date().toISOString()})+'\\n');const r=f.run('Stop',{session_id:'Stop-1',transcript_path:t});if(r.exitCode!==0)throw Error(r.stderr.toString());console.log(JSON.stringify({diagnostic:'transcript-budget-invocation',event:'Stop',logicalRun:1,followUp:0}));}finally{f.close();}`);
    const child = Bun.spawn([process.execPath, "--preload", join(output, "preload.ts"), entry], { env: { ...process.env, AMEM_TASK127_TRACE_DIR: trace }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0); writeFileSync(log, stdout);
    const result = analyze(trace, log) as { observerComplete: boolean; faults: string[]; callMetadataCount: number; calls: { callId: string; processes: { role: string; identity: { available: boolean } }[]; readBytes: number | null }[] };
    expect(result.observerComplete, JSON.stringify(result.faults)).toBe(true); expect(result.callMetadataCount).toBe(1);
    expect(result.calls[0]!.processes.find(item => item.role === "cli")?.identity.available).toBe(true);
    // Native startup can spend the real deadline before reading: unknown bytes must remain null rather than zero.
    expect(result.calls[0]!.readBytes === null || result.calls[0]!.readBytes! <= 256 * 1024).toBe(true);
    expect(targets.map(file => readFileSync(join(repo, file), "utf8"))).toEqual(before);
    writeFileSync(log, ""); expect((analyze(trace, log) as { observerComplete: boolean }).observerComplete).toBe(false);
    writeFileSync(log, stdout + stdout); expect((analyze(trace, log) as { observerComplete: boolean }).observerComplete).toBe(false);
    writeFileSync(log, stdout);
    const binary = join(trace, readdirSync(trace).find(name => name.endsWith(".bin"))!), saved = readFileSync(binary);
    unlinkSync(binary); expect((analyze(trace, log) as { observerComplete: boolean }).observerComplete).toBe(false); writeFileSync(binary, saved);
    writeFileSync(join(trace, "injected.fault.json"), '{"reason":"overflow control"}');
    expect((analyze(trace, log) as { observerComplete: boolean }).observerComplete).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("task127 ownership uses stable PID identity and does not equate command disappearance with final exit", () => {
  const root = mkdtempSync(join(tmpdir(), "task127-ownership-control-")), callId = "00000000-0000-0000-0000-000000000001";
  try {
    writeFileSync(join(root, callId + ".call.json"), JSON.stringify({ callId, event: "Stop", logicalRun: 1, followUp: 0 }));
    const identity = (pid: number) => ({ pid, available: true, startIdentity: `${pid}:original-start` });
    for (const [pid, role] of [[1001, "cli"], [1002, "worker"]] as const) {
      const stem = `${callId}-${pid}`, record = Buffer.alloc(32); record.writeUInt32LE(1, 0); record.writeDoubleLE(1, 8);
      writeFileSync(join(root, stem + ".bin"), record);
      writeFileSync(join(root, stem + ".json"), JSON.stringify({ schema: 1, callId, pid, role, identity: identity(pid), entryAt: 1, recordBytes: 32, limit: 512 }));
    }
    writeFileSync(join(root, callId + ".spawn.json"), JSON.stringify({ pid: 1002, parentPid: 1001, childIdentity: identity(1002) }));
    const log = join(root, "stdout.log"), observation = join(root, "control.observer.jsonl");
    writeFileSync(log, JSON.stringify({ diagnostic: "transcript-budget-invocation", event: "Stop", logicalRun: 1, followUp: 0 }));
    const writeObservation = (startIdentity: string) => writeFileSync(observation, JSON.stringify({ diagnostic: "task127-r1-identities", stage: "after", callId, at: 2,
      alive: [], processes: [{ ...identity(1002), startIdentity, state: "Z" }] }) + "\n");
    writeObservation("1002:original-start");
    expect((analyze(root, log) as { ownershipUnresolved: boolean }).ownershipUnresolved).toBe(true);
    writeObservation("1002:reused-start");
    expect((analyze(root, log) as { ownershipUnresolved: boolean }).ownershipUnresolved).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
