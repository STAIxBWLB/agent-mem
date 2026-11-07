import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookProcessObserver } from "./fakes/hooks-process-observer.ts";
import type { HookProcessEvidence } from "./fakes/hooks-process-observer.ts";
import { verifyHookProcessObservation, verifyPlainHookDeferrals } from "../scripts/hook-process-check.ts";

function fixture(late: boolean) {
  const f = hookFixture(), observer = hookProcessObserver(f.root), hooks = resolve(import.meta.dir, "../src/hooks.ts");
  const excerpt = late ? "positive late deadline capture" : "positive worker spawn control";
  const script = `import {runHook} from ${JSON.stringify(hooks)};const result=await runHook('PostToolUse',{cwd:${JSON.stringify(f.cwd)},tool_response:${JSON.stringify(excerpt)}},{cwd:${JSON.stringify(f.cwd)},base:${JSON.stringify(f.base)},startedAt:performance.now()${late ? '-120' : ''}}${late ? '' : ',{deadlineMs:2000}'});console.log(JSON.stringify(result));`;
  const result = Bun.spawnSync([process.execPath, "--smol", "--preload", observer.preload, "-e", script], { cwd: f.cwd, env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3000 });
  const evidence = observer.evidence().filter(row => row.pid === result.pid), workers = observer.read();
  const dir = join(f.base, "hook-spool");
  const records = [dir, join(dir, ".capacity")].flatMap(folder => existsSync(folder) ? readdirSync(folder).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name)).map(name => JSON.parse(readFileSync(join(folder, name), "utf8"))) : []);
  const pending = records.some(row => row.capture?.event === "PostToolUse" && row.capture?.excerpt === excerpt);
  return { f, result, evidence, workers, pending };
}

test("a positively observed pre-spawn deadline branch has zero children and durable intake, with a real one-worker control", () => {
  const late = fixture(true), control = fixture(false);
  try {
    expect(late.result.exitCode, late.result.stderr.toString()).toBe(0);
    expect(JSON.parse(late.result.stdout.toString())).toMatchObject({ captured: false, pending: true });
    expect(late.workers).toEqual([]); expect(late.pending).toBe(true);
    expect(late.evidence.filter(row => row.phase === "deadline_skip")).toHaveLength(1);
    expect(verifyHookProcessObservation("PostToolUse", late.workers, late.evidence, late.pending)).toEqual({ deferred: true });
    expect(control.result.exitCode, control.result.stderr.toString()).toBe(0); expect(control.workers.filter(row => row.kind === "worker")).toHaveLength(1);
    expect(control.evidence.filter(row => row.phase === "deadline_skip")).toEqual([]);
    expect(verifyHookProcessObservation("PostToolUse", control.workers, control.evidence, control.pending)).toEqual({ deferred: false });
  } finally { late.f.close(); control.f.close(); }
});

test("the zero-worker exception never accepts missing receipts, a second worker, false deadline evidence or absent pending intake", () => {
  const late = fixture(true), control = fixture(false);
  try {
    expect(control.result.exitCode, control.result.stderr.toString()).toBe(0); expect(control.workers.filter(row => row.kind === "worker")).toHaveLength(1);
    expect(() => verifyHookProcessObservation("PostToolUse", [], control.evidence, true)).toThrow("owned-process observation");
    expect(() => verifyHookProcessObservation("PostToolUse", [...control.workers, ...control.workers], control.evidence, true)).toThrow("owned-process observation");
    expect(() => verifyHookProcessObservation("PostToolUse", [], late.evidence.filter(row => row.phase !== "deadline_skip"), true)).toThrow("owned-process observation");
    expect(() => verifyHookProcessObservation("PostToolUse", [], late.evidence, false)).toThrow("owned-process observation");
    expect(() => verifyHookProcessObservation("PostToolUse", [], late.evidence.map(row => row.phase === "precheck" || row.phase === "deadline_skip" ? { ...row, remainingUs: 5000 } : row), true)).toThrow("owned-process observation");
    expect(() => verifyHookProcessObservation("PostToolUse", control.workers, control.evidence.map(row => row.phase === "attempt" ? { ...row, exact: 0 } : row), control.pending)).toThrow("owned-process observation");
    expect(() => verifyHookProcessObservation("PostToolUse", control.workers, control.evidence.map(row => ({ ...row, loads: 2 })), control.pending)).toThrow("owned-process observation");
  } finally { late.f.close(); control.f.close(); }
});


test("at most ten of forty ordinary samples may take the positively proven deadline deferral", () => {
  expect(() => verifyPlainHookDeferrals(0, 40)).not.toThrow();
  expect(() => verifyPlainHookDeferrals(10, 40)).not.toThrow();
  expect(() => verifyPlainHookDeferrals(11, 40)).toThrow("25 percent");
});


function admittedShape(early: boolean, lateUs = 6000) {
  const row = (phase: HookProcessEvidence["phase"], values: Partial<HookProcessEvidence> = {}): HookProcessEvidence => ({ phase, pid: 10, loads: 1, ...values });
  const worker = { pid: 30, kind: "worker" as const, detached: true, argv: [] }, native = { pid: 20, kind: "native" as const, detached: true, argv: [] };
  const pair = (kind: number, pid: number) => [row("attempt", { native: kind, exact: 1 }), row("returned", { native: kind, exact: 1, childPid: pid })];
  const before = [row("preload"), row("precheck", { host: 0, remainingUs: 60000 })], late = row("late_check", { host: 1, remainingUs: lateUs });
  return { workers: early ? [worker, native] : [native, worker], evidence: early
    ? [...before, ...pair(0,30), ...pair(1,20), late]
    : [...before, ...pair(1,20), late, ...pair(0,30)] };
}
test("early final-hook and late PostToolUse admission shapes cannot substitute for one another", () => {
  for (const event of ["Stop", "SessionEnd"] as const) for (const lateUs of [-4319, 0, 6000]) {
    const early = admittedShape(true, lateUs), ordinary = admittedShape(false);
    expect(verifyHookProcessObservation(event, early.workers, early.evidence, false)).toEqual({ deferred: false });
    expect(() => verifyHookProcessObservation("PostToolUse", early.workers, early.evidence, false)).toThrow("owned-process observation");
    expect(() => verifyHookProcessObservation(event, ordinary.workers, ordinary.evidence, false)).toThrow("owned-process observation");
  }
  const ordinary = admittedShape(false);
  expect(verifyHookProcessObservation("PostToolUse", ordinary.workers, ordinary.evidence, false)).toEqual({ deferred: false });
  const below = admittedShape(false, 4999);
  expect(() => verifyHookProcessObservation("PostToolUse", below.workers, below.evidence, false)).toThrow("owned-process observation");
});
test("final-hook admission requires the first worker and exact paired native returns", () => {
  for (const mutate of [
    (rows: HookProcessEvidence[]) => { rows.find(row=>row.phase==="returned" && row.native===1)!.exact=0; },
    (rows: HookProcessEvidence[]) => { rows.find(row=>row.phase==="attempt" && row.native===1)!.exact=0; },
    (rows: HookProcessEvidence[]) => { rows.splice(rows.findIndex(row=>row.phase==="returned" && row.native===1),1); },
    (rows: HookProcessEvidence[]) => { const pair=rows.splice(4,2);rows.splice(2,0,...pair); },
    (rows: HookProcessEvidence[]) => { rows.find(row=>row.phase==="precheck")!.remainingUs=4999; },
    (rows: HookProcessEvidence[]) => { const late=rows.pop()!;rows.splice(2,0,late); },
  ]) {
    const early=admittedShape(true);mutate(early.evidence);
    expect(() => verifyHookProcessObservation("Stop",early.workers,early.evidence,false)).toThrow("owned-process observation");
  }
});

test("zero-native SessionStart needs one bounded deadline receipt and durable pending intake", () => {
  const row = (phase: HookProcessEvidence["phase"], remainingUs?: number): HookProcessEvidence => ({ phase,pid:10,loads:1,...(remainingUs===undefined?{}:{remainingUs}) });
  const valid = (remainingUs: number) => [row("preload"),row("session-native-deadline-skip",remainingUs)];
  for (const remainingUs of [-10000,0,1000]) expect(verifyHookProcessObservation("SessionStart",[],valid(remainingUs),true)).toEqual({deferred:true});
  for (const evidence of [[row("preload")], [...valid(0),row("session-native-deadline-skip",0)], valid(1001),valid(0.5),valid(Number.NaN),valid(Infinity),
    [row("preload"),row("session-native-deadline-skip")], [...valid(0),row("precheck",0)], [...valid(0),row("late_check",0)]])
    expect(()=>verifyHookProcessObservation("SessionStart",[],evidence,true)).toThrow("owned-process observation");
  expect(()=>verifyHookProcessObservation("SessionStart",[],valid(0),false)).toThrow("owned-process observation");
  expect(()=>verifyHookProcessObservation("PostToolUse",[],valid(0),true)).toThrow("owned-process observation");
  const one=admittedShape(true);
  expect(()=>verifyHookProcessObservation("SessionStart",one.workers,one.evidence,true)).toThrow("owned-process observation");
  expect(()=>verifyHookProcessObservation("SessionStart",[],[...valid(0),{phase:"attempt",pid:10,loads:1,exact:1,native:1}],true)).toThrow("owned-process observation");
  const native={pid:20,kind:"native" as const,detached:true,argv:[]};
  const positive:HookProcessEvidence[]=[row("preload"),{phase:"attempt",pid:10,loads:1,exact:1,native:1},{phase:"returned",pid:10,loads:1,exact:1,native:1,childPid:20}];
  expect(verifyHookProcessObservation("SessionStart",[native],positive,false)).toEqual({deferred:false});
  expect(()=>verifyHookProcessObservation("SessionStart",[native],positive.slice(0,-1),true)).toThrow("owned-process observation");
});
