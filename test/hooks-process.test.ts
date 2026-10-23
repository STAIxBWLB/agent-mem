import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookCapturePending } from "../src/hook-spool.ts";
import { hookBin, hookFixture } from "./fakes/hooks-fixture.ts";
import { hookProcessObserver } from "./fakes/hooks-process-observer.ts";
import { hookTimeoutProbe } from "./fakes/hooks-timeout-probe.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture() { const f = hookFixture(); fixtures.push(f); return f; }
interface AcceptedCapture { event: string; excerpt: string }
function pendingCaptures(f: ReturnType<typeof hookFixture>, item: AcceptedCapture) {
  const dir = join(f.base, "hook-spool");
  if (!existsSync(dir)) return [];
  const matches = readdirSync(dir).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))
    .map(name => JSON.parse(readFileSync(join(dir, name), "utf8")))
    .filter(value => value.schema === "agent-mem.hook-capture/v1" && value.cwd === f.cwd && value.capture?.event === item.event && value.capture?.excerpt === item.excerpt);
  for (const value of matches) {
    expect(value.capture.agent).toBe("claude"); expect(Number.isFinite(Date.parse(value.capture.at))).toBe(true);
    expect(Array.isArray(value.capture.paths)).toBe(true); expect(value.capture.paths.length).toBeLessThanOrEqual(32);
    expect(Number.isFinite(value.capture.bytes)).toBe(true); expect(Buffer.byteLength(value.capture.excerpt)).toBeLessThanOrEqual(8000);
  }
  return matches;
}
function replayThroughHooks(f: ReturnType<typeof hookFixture>, accepted: AcceptedCapture[]) {
  const barriers: AcceptedCapture[] = []; let rows = f.rows();
  const matching = (item: AcceptedCapture) => rows.filter(row => row.event === item.event && row.excerpt === item.excerpt && row.project === f.project);
  // Real accepted work drives replay. The final barrier itself may still be durably pending.
  for (let i = 0; i < 4; i++) {
    const excerpt = `process replay barrier ${i}`, result = f.runFunctional("PostToolUse", { prompt: excerpt });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).not.toMatch(/"(?:decision|permissionDecision|updatedInput|block)"\s*:|"continue"\s*:\s*false/);
    barriers.push({ event: "PostToolUse", excerpt }); rows = f.rows();
    if (accepted.every(item => matching(item).length === 1 && pendingCaptures(f, item).length === 0)) break;
  }
  for (const item of accepted) {
    expect(matching(item)).toHaveLength(1); expect(pendingCaptures(f, item)).toHaveLength(0);
  }
  // The original exactly-once row above is the positive control; a new barrier may remain pending.
  for (const item of barriers) {
    const saved = matching(item), pending = pendingCaptures(f, item);
    expect(saved.length).toBeLessThanOrEqual(1); expect(pending.length).toBeLessThanOrEqual(1);
    expect(saved.length === 1 || pending.length === 1).toBe(true);
    // A committed row can retain its same-time acknowledgement claim until the next replay.
    if (saved.length && pending.length) expect(saved[0]!.at).toBe(pending[0]!.capture.at);
  }
  expect(rows).toHaveLength(accepted.length + barriers.filter(item => matching(item).length === 1).length);
  return rows;
}


test("SessionStart never exposes raw private or secret native input in observed owned metadata argv", () => {
  const f = fixture(), observer = hookProcessObserver(f.root);
  const markers = ["PRIVATE_NATIVE_ARGV_SENTINEL", "SYNTHETIC_PASSWORD_ARGV_SENTINEL"];
  for (const payload of [{ private: true, prompt: markers[0] }, { prompt: `password: ${markers[1]}` }]) {
    const result = Bun.spawnSync([process.execPath, "--preload", observer.preload, hookBin, "hook", "SessionStart"], {
      cwd: f.cwd, env: f.env, stdin: Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", cwd: f.cwd, ...payload })), stdout: "pipe", stderr: "pipe", timeout: 3000,
    });
    expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe("");
  }
  expect(observer.read()).toHaveLength(0); expect(f.rows()).toHaveLength(0);
  const control = f.runFunctional("SessionStart", { prompt: "public argv observer control" }, { BUN_OPTIONS: `--preload=${observer.preload}` });
  expect(control.exitCode).toBe(0);
  const receipts = observer.read(); expect(receipts.length).toBeGreaterThan(0);
  expect(receipts.every(receipt => receipt.kind === "native")).toBe(true);
  for (const receipt of receipts) {
    for (const marker of markers) expect(JSON.stringify(receipt.argv)).not.toContain(marker);
    expect(receipt.argv[0]).toBe("/bin/sh"); expect(receipt.argv[3]).toBe("amem-hook-native");
  }
  const rows = replayThroughHooks(f, [{ event: "SessionStart", excerpt: "public argv observer control" }]);
  for (const marker of markers) expect(JSON.stringify(rows)).not.toContain(marker);
});

for (const event of ["SessionStart", "PreToolUse"] as const) test(`${event} host-budget timeout reaps its observed owned descendant and preserves capture`, async () => {
  const f = fixture(), receipt = await hookTimeoutProbe(f, event, true);
  expect(receipt.remainingProcesses).toBe(0);
  const accepted = [{ event, excerpt: "public timeout fixture" }];
  for (const marker of ["healthy follow-up", "second healthy follow-up"]) {
    const healthy = f.runFunctional(event, { prompt: marker }); expect(healthy.exitCode).toBe(0);
    accepted.push({ event, excerpt: marker });
  }
  replayThroughHooks(f, accepted);
  expect(hookCapturePending(f.base, receipt.pending)).toBe(false);
}, 10000);

test("a worker execution deadline reserves teardown time inside its explicit host budget", () => {
  const f = fixture(), preload = join(f.root, "worker-reserve.ts"), receipt = join(f.root, "worker-deadline.json");
  const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  writeFileSync(preload, `import {writeFileSync} from 'node:fs';
const spawn=Bun.spawn.bind(Bun);
Bun.plugin({name:'observe-host-start',setup(b){b.onLoad({filter:/[/]hooks\\.ts$/},({path})=>{const source=require('node:fs').readFileSync(path,'utf8'),anchor='export async function hookMain(args: readonly string[], startedAt = performance.now(), host?: HookHostPorts): Promise<string> {';if(source.split(anchor).length!==2)throw Error('host start anchor changed');return{loader:'ts',contents:source.replace(anchor,anchor+'globalThis.__hookStarted=performance.timeOrigin+startedAt;')};});}});
Bun.spawn=(argv,options)=>{if(Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}){const input=JSON.parse(Buffer.from(options.stdin).toString());writeFileSync(${JSON.stringify(receipt)},JSON.stringify({deadlineFromHostStart:input.deadlineAt-globalThis.__hookStarted}));}return spawn(argv,options);};`);
  const result = f.runFunctional("PreToolUse", { prompt: "worker cleanup reserve" }, { BUN_OPTIONS: `--preload=${preload}` });
  expect(result.exitCode).toBe(0); expect(existsSync(receipt)).toBe(true);
  const budget = JSON.parse(readFileSync(receipt, "utf8"));
  expect(budget.deadlineFromHostStart).toBeGreaterThan(0);
  expect(budget.deadlineFromHostStart).toBeLessThanOrEqual(1975);
});
