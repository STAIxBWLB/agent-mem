import { afterEach, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { CONFIG_FILE } from "../src/memory/config.ts";
import { verifyHookProcessObservation } from "../scripts/hook-process-check.ts";
import type { HookProcessEvidence } from "./fakes/hooks-process-observer.ts";

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
