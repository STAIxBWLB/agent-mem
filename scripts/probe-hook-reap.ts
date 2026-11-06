/** Nonshipping #287 evidence. No production limits or accounting are changed by this probe. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function reapDistribution(values: readonly number[]) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0))
    throw Error("Reap probe samples are missing or invalid; inspect the retained raw evidence before sizing a bound");
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return { samples: sorted.length, quantile: "nearest-rank", p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: sorted.at(-1)! };
}

/** Readiness is numeric self-observation, never inferred from an imported module name. */
export function probeReadiness(value: unknown, phase: "cpu" | "write" = "cpu") {
  const row = value as Record<string, unknown> | null;
  const positive = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item) && item > 0;
  if (!row || row.ready !== true || row.phase !== phase || row.fixture !== "capture-store-scanned" || row.openStore !== true
    || !positive(row.transcriptOffset) || !positive(row.rssKB) || !positive(row.rawRssKB)
    || !positive(row.liveRssMB) || !positive(row.workerUptimeMs) || row.rssKnown !== true
    || !["VmHWM", "vmpeak-bound", "platform-rusage"].includes(String(row.rssSource)))
    throw Error("Representative reap probe footprint is missing or invalid; retain the attempt and inspect its readiness frame");
  return { phase, fixture: "capture-store-scanned", openStore: true, transcriptOffset: row.transcriptOffset,
    rssKB: row.rssKB, rawRssKB: row.rawRssKB, liveRssMB: row.liveRssMB, workerUptimeMs: row.workerUptimeMs, rssSource: row.rssSource };
}

/** Same 10 ms exited-promise race as production, followed separately by the probe's eventual-exit barrier. */
export async function observeProbeReapWindow(exit: Promise<number>) {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined, late = false;
  try {
    const code = await Promise.race([exit, new Promise<undefined>(resolve => {
      timer = setTimeout(() => { late = true; resolve(undefined); }, 10);
    })]);
    return { boundMs: 10, startedAt, finishedAt: performance.now(), late, code };
  } finally { if (timer) clearTimeout(timer); }
}

export function probeArguments(args: readonly string[]) {
  let series: "idle" | "contended" = "idle", phase: "cpu" | "write" = "cpu";
  const seen = new Set<string>();
  for (const argument of args) {
    const key = argument.split("=")[0]!;
    if (seen.has(key) || !["--series=idle", "--series=contended", "--phase=cpu", "--phase=write"].includes(argument))
      throw Error("Reap probe arguments are invalid or repeated; use one --series=idle|contended and one --phase=cpu|write");
    seen.add(key);
    if (argument === "--series=contended") series = "contended";
    if (argument === "--phase=write") phase = "write";
  }
  return { series, phase };
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("Reap probe readiness or exit bound missed; retain this attempt and inspect its owned-worker receipt")), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function probeHookReap(series: "idle" | "contended" = "idle", phase: "cpu" | "write" = "cpu") {
  const home = mkdtempSync(join(tmpdir(), "amem-reap-probe-")), samples: number[] = [];
  const worker = fileURLToPath(new URL("../test/fakes/hook-reap-busy.ts", import.meta.url));
  const started = performance.now(), totalMs = 120_000, count = 200, waitMs = 2_000;
  let safeToRemove = true, attempted = 0, censoredAtReapBound = 0, eventualCensoredCount = 0, over10Ms = 0;
  console.log(JSON.stringify({ diagnostic: "hook-reap-probe-start/v1", platform: process.platform, arch: process.arch, bun: Bun.version,
    epochStartedMs: performance.timeOrigin + started, count, waitMs, totalMs, series, phase, fixture: "capture-store-scanned", minimumHandleAgeMs: 100,
    activePhaseMsBeforeKill: 20, reapBoundMs: 10, quantile: "nearest-rank", detached: true, argvMode: "bun --smol" }));
  try {
    for (let run = 1; run <= count; run++) {
      if (performance.now() - started >= totalMs) throw Error("Reap probe total bound exceeded; retain this incomplete schedule and obtain a runner ruling");
      const runHome = mkdtempSync(join(home, "worker-"));
      const prefix = JSON.stringify({ type: "system", subtype: "away_summary", timestamp: new Date().toISOString(), content: "representative probe summary" }) + "\n";
      const ordinary = JSON.stringify({ type: "assistant", text: "x".repeat(900) }) + "\n";
      const transcript = prefix + ordinary.repeat(Math.floor((262144 - prefix.length) / ordinary.length));
      writeFileSync(join(runHome, "transcript.jsonl"), transcript, { mode: 0o600 });
      const child = Bun.spawn([process.execPath, "--smol", worker, "--phase=" + phase], {
        detached: true, cwd: runHome, env: { PATH: process.env.PATH ?? "", HOME: runHome, AMEM_HOME: join(runHome, "memory") },
        stdin: "ignore", stdout: "pipe", stderr: "ignore",
      });
      const spawnedAt = performance.now();
      attempted++;
      let exitedAt: number | undefined, killAt: number | undefined, killReturnedAt: number | undefined, groupKill = false, fallbackKill = false;
      const exit = child.exited.then(code => { exitedAt = performance.now(); return code; });
      const reader = child.stdout.getReader();
      const stop = () => {
        if (exitedAt !== undefined || killAt !== undefined) return;
        // Same authority and group-SIGKILL/fallback as hookWorker.stop(): our still-live detached leader.
        killAt ??= performance.now();
        try { process.kill(-child.pid, "SIGKILL"); groupKill = true; }
        catch { child.kill("SIGKILL"); fallbackKill = true; }
        killReturnedAt = performance.now();
      };
      let failure: unknown, ready = false, code: number | undefined, footprint: ReturnType<typeof probeReadiness> | undefined;
      let reapWindow: Awaited<ReturnType<typeof observeProbeReapWindow>> | undefined;
      try {
        let frame = "";
        await within((async () => {
          while (!frame.includes("\n")) {
            const part = await reader.read();
            if (part.done || !part.value || frame.length + part.value.length > 4096)
              throw Error("Reap probe worker readiness is missing or oversized; inspect the fixture before accepting samples");
            frame += new TextDecoder().decode(part.value);
          }
        })(), waitMs);
        footprint = probeReadiness(JSON.parse(frame), phase);
        if (footprint.transcriptOffset !== Buffer.byteLength(transcript))
          throw Error("Representative reap probe did not complete the transcript scan; retain this incomplete attempt");
        ready = true;
        const killDue = Math.max(performance.now() + 20, spawnedAt + 100);
        while (performance.now() < killDue) await Bun.sleep(Math.max(1, Math.ceil(killDue - performance.now())));
        if (exitedAt !== undefined) throw Error("Reap probe busy worker exited before SIGKILL; inspect the fixture and discard this incomplete schedule");
        stop();
        reapWindow = await observeProbeReapWindow(exit);
        if (reapWindow.late) censoredAtReapBound++;
        code = reapWindow.late ? await within(exit, waitMs) : reapWindow.code;
        if (!groupKill || fallbackKill || killAt === undefined || exitedAt === undefined || child.signalCode !== "SIGKILL")
          throw Error("Reap probe did not observe the required group SIGKILL exit; inspect this owned-worker receipt before continuing");
        samples.push(exitedAt - killAt);
        if (exitedAt - killAt > 10) over10Ms++;
      } catch (error) { failure = error; }
      finally {
        if (exitedAt === undefined) {
          try { stop(); await within(exit, waitMs); }
          catch { safeToRemove = false; child.unref(); }
        }
        await within(reader.cancel().catch(() => {}), waitMs).catch(() => {});
        try { reader.releaseLock(); } catch { /* A cancelled pending readiness read grants no process authority. */ }
        if (exitedAt === undefined) eventualCensoredCount++;
        console.log(JSON.stringify({ diagnostic: "hook-reap-probe-sample/v1", series, phase, run, pid: child.pid, ready, groupKill, fallbackKill, footprint,
          reapBoundMs: 10, censoredAtReapBound: reapWindow?.late ?? null,
          reapedAtBound: reapWindow === undefined ? null : !reapWindow.late,
          reapStartMs: reapWindow === undefined ? null : reapWindow.startedAt - started,
          reapEndMs: reapWindow === undefined ? null : reapWindow.finishedAt - started,
          observedReapWindowMs: reapWindow === undefined ? null : reapWindow.finishedAt - reapWindow.startedAt,
          handleAgeAtKillMs: killAt === undefined ? null : killAt - spawnedAt,
          spawnMs: spawnedAt - started, killMs: killAt === undefined ? null : killAt - started,
          killReturnedMs: killReturnedAt === undefined ? null : killReturnedAt - started,
          exitMs: exitedAt === undefined ? null : exitedAt - started, exitCode: code ?? null,
          reaped: exitedAt !== undefined, accepted: failure === undefined,
          killToExitMs: killAt === undefined || exitedAt === undefined ? null : exitedAt - killAt,
          censored: exitedAt === undefined, elapsedAfterKillMs: killAt === undefined ? null : performance.now() - killAt }));
      }
      if (failure) throw failure;
      if (!safeToRemove) throw Error("Reap probe owned worker exit remains unconfirmed; stop the schedule and inspect this runner, do not launch a replacement");
      rmSync(runHome, { recursive: true, force: true });
    }
    const distribution = reapDistribution(samples);
    console.log(JSON.stringify({ diagnostic: "hook-reap-probe-summary/v1", platform: process.platform, bun: Bun.version,
      series, phase, idleIsLowerBound: series === "idle", complete: samples.length === count, ...distribution,
      reapBoundMs: 10, censoredAtReapBound, eventualCensoredCount, over10Ms, observationOnly: true }));
    return distribution;
  } finally {
    if (samples.length !== count) console.log(JSON.stringify({ diagnostic: "hook-reap-probe-summary/v1", platform: process.platform,
      series, phase, complete: false, attempted, accepted: samples.length, statistics: null, censoredAtReapBound, eventualCensoredCount, over10Ms, observationOnly: true }));
    if (safeToRemove) rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { series, phase } = probeArguments(process.argv.slice(2));
  await probeHookReap(series, phase);
}
