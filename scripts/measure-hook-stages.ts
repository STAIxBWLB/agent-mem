import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
/** Diagnostic only: numeric cold-path milestones for actual runner failures. No budget overrides. */
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeCaptureFields } from "../src/memory/capture-input.ts";
import { hookFixture, workMarker } from "../test/fakes/hooks-fixture.ts";
import { singleAttemptTiming } from "./hook-timing-check.ts";
import { assertHookStageAnchorsHealthy, hookStagePreload, validateHookStageSources } from "../test/fakes/hook-stage-preload.ts";

validateHookStageSources(resolve(import.meta.dir, ".."));

const f = hookFixture(), preload = join(f.root, "hook-stages.ts"), trace = join(f.root, "hook-stages.jsonl"), anchorFailure = join(f.root, "hook-stage-failure.txt");
const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
try {
  await f.seed();
  if (process.argv.includes("--public-prune-view")) {
    await migrateShards({ memoryDir: f.base, mode: "apply", authorizedPerson: true, tty: true });
    await activatePublicPruneView({ memoryDir: f.base, mode: "apply", authorizedPerson: true, tty: true });
  }
  // Preload/observation still count toward the unchanged deadline; buffer bounded numeric marks so
  // synchronous trace-file I/O does not intervene at every measured stage. Flush once at CLI exit.
  writeFileSync(preload, hookStagePreload(worker, trace, preload, anchorFailure), { mode: 0o600 });
  let cold: { knownWork: boolean; ms: number | null; wallMs: number } | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    writeFileSync(trace, "", { mode: 0o600 });
    writeFileSync(anchorFailure, "", { mode: 0o600 });
    const started = performance.timeOrigin + performance.now();
    const result = f.run("SessionStart", {}, { BUN_OPTIONS: `--preload=${preload}` });
    const wallMs = performance.timeOrigin + performance.now() - started;
    assertHookStageAnchorsHealthy(anchorFailure);
    if (result.exitCode !== 0 || result.signalCode) throw new Error("cold SessionStart executable failed");
    const rows = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { child: boolean; stage: string; at: number });
    let context: unknown;
    try { context = JSON.parse(result.stdout.toString()).hookSpecificOutput?.additionalContext; } catch { /* Report missing context explicitly. */ }
    const knownWork = typeof context === "string" && context.includes(workMarker);
    const stopped = [...rows].reverse().find(row => !row.child && row.stage === "output-ready");
    const completedMs = stopped ? stopped.at - started : null;
    if (attempt === 0) cold = { knownWork, ms: completedMs, wallMs };
    console.log(JSON.stringify({ diagnostic: "cold-session-stages", attempt, exit: result.exitCode, outputBytes: result.stdout.length, knownWork, completedMs, wallMs,
      stages: rows.map(row => ({ process: row.child ? "worker" : "cli", stage: row.stage, ms: Math.round((row.at - started) * 100) / 100 })) }));
  }
  // Reproduce the full foreign tier separately from the cold/plain budget; preparation
  // is outside the measured hook, and these numeric stages diagnose its real deadline.
  const full = hookFixture(), foreign = hookFixture(), oldHome = process.env.HOME;
  try {
    await full.seed();
    if (process.argv.includes("--public-prune-view")) {
      await migrateShards({ memoryDir: full.base, mode: "apply", authorizedPerson: true, tty: true });
      await activatePublicPruneView({ memoryDir: full.base, mode: "apply", authorizedPerson: true, tty: true });
    }
    process.env.HOME = full.env.HOME;
    const { stageHookCapture } = await import("../src/hook-spool.ts");
    const templateEntry = await stageHookCapture("PostToolUse", { prompt: "stage diagnostic template" }, { cwd: foreign.cwd, base: full.base });
    if (!templateEntry) throw new Error("full foreign diagnostic template unavailable");
    const spool = join(full.base, "hook-spool"), template = JSON.parse(readFileSync(join(spool, templateEntry.name), "utf8"));
    rmSync(join(spool, templateEntry.name));
    // Reproduce an N-1/pre-upgrade backlog directly. New admission intentionally
    // keeps one cwd below 256, which must not silently shrink this diagnostic.
    for (let i = 0; i < 256; i++) {
      const nonce = i.toString(16).padStart(32, "0"), capture = normalizeCaptureFields({ ...template.capture, excerpt: `stage diagnostic ${i}` });
      const name = templateEntry.name.replace(/[a-f0-9]{32}\.json$/, `${nonce}.json`);
      writeFileSync(join(spool, name), JSON.stringify({ ...template, nonce, capture }), { mode: 0o600, flag: "wx" });
    }
    if (readdirSync(spool).filter(name => name.startsWith("hook-")).length !== 256) throw new Error("full foreign diagnostic requires exactly 256 records");
    writeFileSync(trace, "", { mode: 0o600 });
    writeFileSync(anchorFailure, "", { mode: 0o600 });
    const started = performance.timeOrigin + performance.now();
    const result = full.run("SessionStart", {}, { BUN_OPTIONS: `--preload=${preload}` });
    const wallMs = performance.timeOrigin + performance.now() - started;
    assertHookStageAnchorsHealthy(anchorFailure);
    if (result.exitCode !== 0 || result.signalCode) throw new Error("full foreign SessionStart executable failed");
    const rows = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { child: boolean; stage: string; at: number });
    let context: unknown; try { context = JSON.parse(result.stdout.toString()).hookSpecificOutput?.additionalContext; } catch { /* Missing output is the diagnostic. */ }
    const stopped = [...rows].reverse().find(row => !row.child && row.stage === "output-ready");
    const knownWork = typeof context === "string" && context.includes(workMarker), completedMs = stopped ? stopped.at - started : null;
    console.log(JSON.stringify({ diagnostic: "full-foreign-session-stages", exit: result.exitCode, outputBytes: result.stdout.length,
      knownWork, completedMs, wallMs,
      stages: rows.map(row => ({ process: row.child ? "worker" : "cli", stage: row.stage, ms: Math.round((row.at - started) * 100) / 100 })) }));
    singleAttemptTiming("full foreign SessionStart known work before 140 ms", knownWork && completedMs !== null && completedMs < 140,
      { knownWork, completedMs, wallMs, limitMs: 140 });
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; full.close(); foreign.close(); }
  singleAttemptTiming("cold SessionStart known work before 140 ms", !!cold?.knownWork && cold.ms !== null && cold.ms < 140,
    { knownWork: cold?.knownWork ?? false, completedMs: cold?.ms ?? null, wallMs: cold?.wallMs ?? null, limitMs: 140 });
} finally { f.close(); }
