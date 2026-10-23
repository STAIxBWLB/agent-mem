import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookProcessObserver } from "./fakes/hooks-process-observer.ts";
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
    expect(control.result.exitCode, control.result.stderr.toString()).toBe(0); expect(control.workers).toHaveLength(1);
    expect(control.evidence.filter(row => row.phase === "deadline_skip")).toEqual([]);
    expect(verifyHookProcessObservation("PostToolUse", control.workers, control.evidence, control.pending)).toEqual({ deferred: false });
  } finally { late.f.close(); control.f.close(); }
});

test("the zero-worker exception never accepts missing receipts, a second worker, false deadline evidence or absent pending intake", () => {
  const late = fixture(true), control = fixture(false);
  try {
    expect(control.result.exitCode, control.result.stderr.toString()).toBe(0); expect(control.workers).toHaveLength(1);
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
