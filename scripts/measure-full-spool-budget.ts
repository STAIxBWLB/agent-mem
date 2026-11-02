import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookCaptureScope } from "../src/hook-spool.ts";
import { normalizeCaptureFields } from "../src/memory/capture-input.ts";
import { readCaptureDrops, readMetrics, type MetricSample } from "../src/memory/metrics.ts";
import { hookFixture } from "../test/fakes/hooks-fixture.ts";
import { measuredHookRss } from "./hook-rss-check.ts";
import { workloadBudget } from "./hook-timing-check.ts";

// Every sample starts with the pre-upgrade backlog, not the easier already-drained state.
// There are no retries: even malformed, failed and over-budget samples enter the report.
const RUNS = 40, WALL_MS = 150, RSS_MB = 100;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
const round = (value: number) => Math.round(value * 100) / 100;
type Rss = ReturnType<typeof measuredHookRss>;
interface Sample {
  invocation: number; event: string; wallMs: number; metricWallMs: number | null; exitCode: number | null; signal: string | null;
  before: { active: number; reserve: number }; after?: { active: number; reserve: number };
  admitted?: boolean; drops?: Record<string, number>; metric?: MetricSample; rss?: Rss; error?: string;
}
const f = hookFixture(), originalHome = process.env.HOME, groups: Record<string, { samples: Sample[]; wallP95Ms: number; peakRssMB: number; pass: boolean }> = {};
process.env.HOME = f.env.HOME;
let fatal: string | undefined;
try {
  await f.seed();
  const foreign = join(f.root, "foreign"); mkdirSync(foreign);
  const init = Bun.spawnSync(["git", "init", "--quiet", foreign], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  if (init.exitCode !== 0) throw new Error("full-spool fixture git init failed");
  const scope = hookCaptureScope(foreign, f.base);
  if (!scope) throw new Error("full-spool fixture scope unavailable");
  const stat = lstatSync(foreign), root = digest(`${stat.ino}:${stat.birthtimeMs}`), cwdHash = digest(foreign);
  const dir = join(f.base, "hook-spool"), reserve = join(dir, ".capacity");
  const inventory = () => ({ active: readdirSync(dir).filter(name => name.startsWith("hook-")).length,
    reserve: existsSync(reserve) ? readdirSync(reserve).filter(name => name.startsWith("hook-")).length : 0 });
  for (const [name, reserveCount, hookEvent] of [["active-full", 0, "PostToolUse"], ["active-and-reserve-full", 32, "PostToolUse"], ["session-start-full", 32, "SessionStart"]] as const) {
    const samples: Sample[] = [];
    groups[name] = { samples, wallP95Ms: 0, peakRssMB: 0, pass: false };
    for (let invocation = 0; invocation < RUNS; invocation++) {
      // These are only this script's private fixture files. Direct seeding represents an old writer
      // or a pre-upgrade home that already exceeds the new per-cwd fair share.
      rmSync(dir, { recursive: true, force: true }); mkdirSync(reserve, { recursive: true, mode: 0o700 });
      for (const [folder, count, event] of [[dir, 256, "PostToolUse"], [reserve, reserveCount, "SessionStart"]] as const) {
        for (let index = 0; index < count; index++) {
          const nonce = digest(`${name}:${invocation}:${event}:${index}`).slice(0, 32);
          const capture = normalizeCaptureFields({ agent: "claude", event, at: new Date(Date.now() - 120_000).toISOString(), excerpt: "foreign full-spool public fixture" });
          const record = { schema: "agent-mem.hook-capture", format: 2, cwd: foreign, scope, root, nonce, capture };
          writeFileSync(join(folder, `hook-v2-${cwdHash}-${scope}-${nonce}.json`), JSON.stringify(record), { mode: 0o600, flag: "wx" });
        }
      }
      writeFileSync(join(f.base, "metrics.jsonl"), "", { mode: 0o600 });
      const before = inventory(), marker = `full-spool-current-${name}-${invocation}`;
      const sample: Sample = { invocation, event: hookEvent, before, wallMs: 0, metricWallMs: null, exitCode: null, signal: null };
      samples.push(sample);
      const start = performance.now();
      try {
        const result = f.run(hookEvent, { prompt: marker });
        sample.wallMs = round(performance.now() - start);
        sample.exitCode = result.exitCode;
        sample.signal = result.signalCode === null || result.signalCode === undefined ? null : String(result.signalCode);
        if (before.active !== 256 || before.reserve !== reserveCount) throw new Error("full-spool sample did not start full");
        sample.after = inventory();
        const metric = readMetrics(f.base).filter(row => row.kind === "hook" && row.wallMs !== undefined).at(-1);
        sample.metric = metric;
        if (!metric || !Number.isFinite(metric.wallMs)) throw new Error("full-spool hook metric unavailable");
        sample.metricWallMs = round(metric.wallMs!);
        sample.rss = measuredHookRss(metric, result.resourceUsage.maxRSS / 1048576);
        const drops = readCaptureDrops(f.base);
        if (!drops.readable) throw new Error("full-spool drop receipt unreadable");
        sample.drops = drops.counts;
        const pending = [dir, reserve].some(folder => readdirSync(folder).filter(entry => entry.startsWith("hook-")).some(entry => {
          try { const record = JSON.parse(readFileSync(join(folder, entry), "utf8")); return record.cwd === f.cwd && record.capture?.excerpt === marker; }
          catch { return false; }
        }));
        sample.admitted = pending || f.rows().some(row => row.excerpt === marker);
        if (result.exitCode !== 0 || result.signalCode) throw new Error("full-spool hook executable failed");
        if (!sample.admitted) throw new Error("full-spool hook lost the new project's capture");
        if (!(drops.counts.scope_capacity! > 0)) throw new Error("full-spool eviction lacks a counted scope_capacity receipt");
        if (sample.after.active > 256 || sample.after.reserve > 32) throw new Error("full-spool admission exceeded unchanged tier caps");
      } catch (error) { if (!sample.wallMs) sample.wallMs = round(performance.now() - start); sample.error = (error as Error).message; }
    }
    const wallP95Ms = p95(samples.map(sample => sample.wallMs)), peakRssMB = Math.max(0, ...samples.map(sample => sample.rss?.rssMB ?? 0));
    const verdict = workloadBudget(`full-spool-${name}`, { wallP95Ms, peakRssMB, wallLimitMs: WALL_MS, rssLimitMB: RSS_MB });
    groups[name] = { samples, wallP95Ms: round(wallP95Ms), peakRssMB: round(peakRssMB), pass: verdict.pass && samples.every(sample => sample.error === undefined) };
  }
} catch (error) { fatal = (error as Error).message; }
finally {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  f.close();
}
const pass = fatal === undefined && Object.keys(groups).length === 3 && Object.values(groups).every(group => group.pass);
await Bun.stdout.write(JSON.stringify({ schema: "amem.full-spool-budget/v1", runsPerGroup: RUNS, retries: 0, wallP95BudgetMs: WALL_MS, peakRssBudgetMB: RSS_MB, groups, ...(fatal ? { fatal } : {}), pass }, null, 2) + "\n");
if (!pass) process.exitCode = 1;
