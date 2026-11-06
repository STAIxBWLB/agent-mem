/** Finite hosted diagnostic batch, not an acceptance gate or a production retry. */
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HookWorkerPhase } from "../test/fakes/hooks-worker-phases.ts";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Count only real-workload reaped:false receipts, never unknown-RSS advisories or synthetic timeout children. */
export function attributedWorkerMisses(records: readonly unknown[]) {
  const misses = new Map<string, { parentPid: number; childPid: number; event: string; phase: string; timerLagMs: number; beforePreload: boolean }>();
  for (const input of records) {
    const row = object(input);
    if (!row || row.diagnostic !== "hook-child-reap/v1" || row.phaseInstrumentation !== true || !pid(row.parentPid)
      || !["baseline", "phase-hooks", "phase-transcript"].includes(String(row.variant)) || !Array.isArray(row.children)
      || !["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"].includes(String(row.event))) continue;
    for (const inputChild of row.children) {
      const child = object(inputChild), timer = object(child?.parentTimerAtReapEnd), phase = object(child?.lastWorkerPhaseBeforeKill);
      if (!child || child.kind !== "worker" || child.reaped !== false || !pid(child.pid) || child.phaseInstrumentation !== true
        || child.phaseTracePartial !== false || child.phaseTraceTruncated !== false || !finite(child.killRequestMs) || !timer || !finite(timer.lagMs)
        || timer.windowChildPid !== child.pid) continue;
      const beforePreload = child.phaseTraceMissing === true;
      if(beforePreload&&(child.bootReceiptPresent!==false||!Array.isArray(child.workerPhases)||child.workerPhases.length!==0))continue;
      const label = phase && finite(phase.id) && Number.isSafeInteger(phase.id) ? HookWorkerPhase[phase.id] : undefined;
      if (!beforePreload && (typeof label !== "string" || phase?.id === HookWorkerPhase.Truncated || phase?.id === HookWorkerPhase.AnchorRefused)) continue;
      misses.set(`${row.parentPid}:${child.pid}`, { parentPid: row.parentPid, childPid: child.pid, event: String(row.event),
        phase: beforePreload ? "preload-entry-not-observed" : String(label), timerLagMs: timer.lagMs, beforePreload });
    }
  }
  return [...misses.values()];
}

async function runBatch(directory: string) {
  const root = resolve(import.meta.dir, ".."), out = resolve(directory);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (git.exitCode !== 0) throw Error("Attribution checkout identity is unavailable; run from the committed diagnostic worktree");
  const manifest = { diagnostic: "hook-worker-attribution-batch/v1", head: git.stdout.toString().trim(), platform: process.platform, bun: Bun.version,
    maxAttempts: 3, targetMisses: 3, admissionMs: 26 * 60_000, outerWorkflowTimeoutMinutes: 30, instrumented: true };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(manifest));
  const commands = [
    { name: "hooks", args: ["scripts/measure-hooks-budget.ts", "--phase-diagnostics"] },
    { name: "baseline", args: ["scripts/measure-hook-baseline.ts", "--root", root, "--phase-diagnostics"] },
    { name: "transcript", args: ["scripts/measure-transcript-budget.ts", "--phase-diagnostics"] },
    { name: "worker-test", args: ["test", "--timeout", "20000", "test/hook-transcript-worker.test.ts"] },
  ];
  const results: { attempt: number; script: string; exit: number; wallMs: number; parserIncomplete: number; misses: ReturnType<typeof attributedWorkerMisses> }[] = [];
  const started = performance.now(), misses: (ReturnType<typeof attributedWorkerMisses>[number] & { attempt: number; script: string })[] = [];
  const save = () => {
    const report = { ...manifest, results, misses, attributionTargetMet: misses.length >= manifest.targetMisses,
      originalScriptsPassed: results.length > 0 && results.every(row => row.exit === 0),
      wallMs: performance.now() - started, batchComplete: results.length % commands.length === 0 };
    writeFileSync(join(out, "summary.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  };
  for (let attempt = 1; attempt <= manifest.maxAttempts; attempt++) {
    if (performance.now() - started >= manifest.admissionMs) break;
    for (const command of commands) {
      if (performance.now() - started >= manifest.admissionMs) break;
      const folder = join(out, `attempt-${attempt}-${command.name}`); mkdirSync(folder, { mode: 0o700 });
      const foundMisses = new Map<string, ReturnType<typeof attributedWorkerMisses>[number]>(); let parserIncomplete = 0;
      const child = Bun.spawn([process.execPath, ...command.args], { cwd: root, env: { ...process.env, NO_COLOR: "1",
        AMEM_TEST_WORKER_PHASES: "1", AMEM_TEST_PHASE_ARTIFACTS: join(folder, "receipts") }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const scriptStart = performance.now();
      const drain = async (stream: ReadableStream<Uint8Array>, name: string) => {
        const fd = openSync(join(folder, name), "wx", 0o600), reader = stream.getReader(), decoder = new TextDecoder();
        let pending = "", overflow = false;
        const line = (text: string) => {
          if (!text.startsWith('{"diagnostic":"hook-child-reap/v1"')) return;
          try { for(const miss of attributedWorkerMisses([JSON.parse(text)])) foundMisses.set(`${miss.parentPid}:${miss.childPid}`,miss); }
          catch { parserIncomplete++; }
        };
        try {
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            writeFileSync(fd, part.value); // Preserve every raw byte even when diagnostic parsing is incomplete.
            const text = decoder.decode(part.value, { stream: true });
            const pieces=text.split("\n");
            for (let index=0;index<pieces.length;index++) {
              if(!overflow){pending+=pieces[index]!;if(pending.length>512*1024){parserIncomplete++;pending="";overflow=true;}}
              if(index<pieces.length-1){if(!overflow)line(pending);pending="";overflow=false;}
            }
          }
          const tail=decoder.decode();if(!overflow&&(pending||tail))line(pending+tail);
        } finally { reader.releaseLock(); closeSync(fd); }
      };
      await Promise.all([drain(child.stdout, "stdout.log"), drain(child.stderr, "stderr.log")]);
      const exit = await child.exited, found = [...foundMisses.values()];
      for (const miss of found) misses.push({ ...miss, attempt, script: command.name });
      const result = { attempt, script: command.name, exit, wallMs: performance.now() - scriptStart, parserIncomplete, misses: found };
      results.push(result); save(); console.log(JSON.stringify({ diagnostic: "hook-worker-attribution-script/v1", ...result }));
    }
    // Finish every script in the declared attempt, retaining failures, before stopping at the evidence target.
    if (misses.length >= manifest.targetMisses) break;
  }
  const report = save();
  console.log(JSON.stringify({ diagnostic: "hook-worker-attribution-result/v1", ...report }));
  if (!report.attributionTargetMet || !report.originalScriptsPassed || results.some(row => row.parserIncomplete)) {
    console.error("Attribution batch has insufficient evidence or a strict script/parser failure; retain every artifact and inspect the per-attempt outcomes before another batch");
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  if (process.argv.length !== 3 || !process.argv[2]) throw Error("Attribution output directory is missing; pass one fresh CI artifact directory");
  await runBatch(process.argv[2]);
}
