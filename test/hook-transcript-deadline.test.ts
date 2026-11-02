import { afterEach, expect, test } from "bun:test";
import { symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { CONFIG_FILE } from "../src/memory/config.ts";
import { deferralPendingEligible, verifyHookProcessObservation } from "../scripts/hook-process-check.ts";
import { hookProcessObserver, type HookProcessEvidence } from "./fakes/hooks-process-observer.ts";

// #221: a transcript-bearing hook never ends silently. It reports `deadline` only when measured time proves it,
// reports nothing for a policy refusal, and reports the non-accepted `unavailable` when the scan throws.
const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0)) close(); });
function fixture() {
  const f = hookFixture(); clean.push(f.close);
  const transcript = join(f.root, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "deadline title" }) + "\n");
  return { ...f, transcript };
}
/** The real hookMain through its host deadline port; the CLI's own 140 ms is unchanged. */
function run(f: ReturnType<typeof fixture>, deadlineMs: number, payload: Record<string, unknown>) {
  const entry = join(f.root, `hook-${deadlineMs}.ts`), hooks = resolve(import.meta.dir, "../src/hooks.ts");
  writeFileSync(entry, `import { hookMain } from ${JSON.stringify(hooks)};await hookMain(process.argv.slice(2),performance.now(),{deadlineMs:${deadlineMs}});`);
  const result = Bun.spawnSync([process.execPath, "--smol", entry, "Stop"], { cwd: f.cwd, env: f.env, stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", cwd: f.cwd, session_id: "s221", ...payload })), stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
}

for (const deadlineMs of [5, 20, 30]) test(`a hook out of time before its worker reports a deadline stop, not silence (${deadlineMs} ms)`, async () => {
  const f = fixture(); await f.seed();
  const metric = run(f, deadlineMs, { transcript_path: f.transcript, last_assistant_message: "answer" });
  expect(metric.transcriptStopReason).toBe("deadline");
  expect(metric.transcriptOffset).toBeUndefined();
});

test("a policy-refused Stop is not reported as a deadline stop", async () => {
  const f = fixture(); await f.seed();
  writeFileSync(join(f.base, CONFIG_FILE), JSON.stringify({ piiPatterns: ["refused-marker-221"] }));
  const metric = run(f, 2000, { transcript_path: f.transcript, last_assistant_message: "contains refused-marker-221" });
  expect(metric.transcriptStopReason).toBeUndefined();
  expect(metric.transcriptOffset).toBeUndefined();
});

test("a transcript scan that throws reports `unavailable`, which no progress clause accepts", async () => {
  const f = fixture(); await f.seed();
  const link = f.transcript + ".link"; symlinkSync(f.transcript, link);
  const metric = run(f, 2000, { transcript_path: link, last_assistant_message: "answer" });
  expect(metric.transcriptStopReason).toBe("unavailable");
  expect(["cap", "deadline", "spool_full"]).not.toContain(metric.transcriptStopReason!);
});

test("with time left, the same hook scans and reports offset progress (control)", async () => {
  const f = fixture(); await f.seed();
  const metric = run(f, 2000, { transcript_path: f.transcript, last_assistant_message: "answer" });
  expect(metric.transcriptStopReason).toBeUndefined();
  expect(metric.transcriptOffset).toBeGreaterThan(0);
});

const row = (phase: HookProcessEvidence["phase"], values: Partial<HookProcessEvidence> = {}): HookProcessEvidence => ({ phase, pid: 10, loads: 1, ...values });
const nativeWorker = { pid: 20, detached: true, argv: [], kind: "native" as const };
const lateExit = (lateUs: number) => [row("preload"), row("precheck", { remainingUs: 60_000, host: 0 }), row("attempt", { exact: 1, native: 1 }), row("returned", { exact: 1, native: 1, childPid: 20 }), row("late_check", { remainingUs: lateUs, host: 1 })];

test("the owned-process contract accepts the post-metadata deadline exit only with measured evidence and durable intake", () => {
  expect(verifyHookProcessObservation("PostToolUse", [nativeWorker], lateExit(3_000), true)).toEqual({ deferred: true });
  expect(() => verifyHookProcessObservation("PostToolUse", [nativeWorker], lateExit(6_000), true)).toThrow("owned-process observation");    // time remained: not a deadline
  expect(() => verifyHookProcessObservation("PostToolUse", [nativeWorker], lateExit(3_000), false)).toThrow("owned-process observation");   // intake not durable
  expect(() => verifyHookProcessObservation("PostToolUse", [nativeWorker], lateExit(3_000).filter(item => item.phase !== "late_check"), true)).toThrow("owned-process observation");
  expect(() => verifyHookProcessObservation("PostToolUse", [nativeWorker], [...lateExit(3_000), row("deadline_skip", { remainingUs: 60_000, host: 0 })], true)).toThrow("owned-process observation");
  expect(() => verifyHookProcessObservation("PostToolUse", [nativeWorker], [...lateExit(3_000), row("late_check", { remainingUs: 1_000, host: 1 })], true)).toThrow("owned-process observation");
});

test("a native-only late deferral is eligible for the durable-intake check; a Bun worker never is (codex P2)", () => {
  // The caller's real gate: native supervisors are observed as workers, so `workers.length === 0` rejected this deferral.
  expect(deferralPendingEligible([nativeWorker])).toBe(true);
  expect(deferralPendingEligible([])).toBe(true);
  expect(deferralPendingEligible([nativeWorker, { pid: 21, detached: true, argv: [], kind: "worker" }])).toBe(false);
  const pending = deferralPendingEligible([nativeWorker]) && true;
  expect(verifyHookProcessObservation("PostToolUse", [nativeWorker], lateExit(3_000), pending)).toEqual({ deferred: true });
});

test("the late-check evidence and the branch it records read one clock sample, at the 5 ms threshold (codex P2)", () => {
  const f = hookFixture(); clean.push(f.close);
  const observer = hookProcessObserver(f.root);
  const source = readFileSync(observer.preload, "utf8");
  const hooks = readFileSync(resolve(import.meta.dir, "../src/hooks.ts"), "utf8");
  // Rebuild the instrumented guard exactly as the preload does, then run it with a clock that advances on every read.
  const late = "  if (!metadata.receipt || workDeadline - performance.now() < 5) return";
  expect(hooks.split(late)).toHaveLength(2);
  const lateObserved = /const lateObserved='([^']+)'/.exec(source)![1]!;
  expect(lateObserved.match(/performance\.now\(\)/g)).toHaveLength(1);                     // a single sample
  for (const [first, expected] of [[4.9995, "skip"], [5.0005, "continue"]] as const) {
    let reads = 0; const notes: { remainingUs: number }[] = [];
    const clock = { now: () => 100 - first + reads++ * 0.002 };   // each further read would move 2 µs across the threshold
    const run = new Function("performance", "globalThis", "metadata", "transcript", "workDeadline", `${lateObserved} "skip"; return "continue";`);
    const outcome = run(clock, { __hookProcessNote: (_: string, value: { remainingUs: number }) => notes.push(value) }, { receipt: {} }, {}, 100);
    expect(outcome).toBe(expected);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.remainingUs < 5000).toBe(expected === "skip");                      // recorded value agrees with the branch
    expect(reads).toBe(1);
  }
});
