/** Same-runner main comparison only; the transcript harness remains the candidate R2 gate. */
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "../test/fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { measuredHookRss } from "./hook-rss-check.ts";

const root = process.argv[process.argv.indexOf("--root") + 1];
if (!process.argv.includes("--root") || !root) throw Error("baseline --root is required");
const bin = resolve(root, "bin/amem.js");
const revision = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
if (revision.exitCode !== 0) throw Error("baseline is not a Git checkout");
const groups = [];
for (const event of ["Stop", "SessionEnd"]) {
  const f = hookFixture(), samples = [];
  try {
    await f.seed();
    for (let run = 1; run <= 20; run++) {
      const transcript = join(f.root, "transcript.jsonl"), at = new Date().toISOString(), marker = "summary " + event + "-" + run;
      const prefix = [{ type: "assistant", timestamp: at }, { type: "ai-title", aiTitle: marker },
        { type: "system", subtype: "away_summary", timestamp: at, content: marker },
        { type: "user", isCompactSummary: true, timestamp: at, message: { content: marker } }].map(row => JSON.stringify(row)).join("\n") + "\n";
      const ordinary = JSON.stringify({ type: "assistant", timestamp: at, text: "x".repeat(800) }) + "\n";
      writeFileSync(transcript, prefix + ordinary.repeat(Math.ceil((262144 - prefix.length) / ordinary.length)));
      Bun.gc(true);
      const started = performance.now(), result = Bun.spawnSync([bin, "hook", event], { cwd: f.cwd, env: f.env,
        stdin: Buffer.from(JSON.stringify({ cwd: f.cwd, hook_event_name: event, session_id: "baseline-" + run, transcript_path: transcript })),
        stdout: "pipe", stderr: "pipe", timeout: 3000 });
      const wallMs = performance.now() - started, metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
      if (result.exitCode !== 0 || result.stdout.length || !metric) throw Error("main comparison hook unavailable");
      const sample = { event, run, wallMs, ...measuredHookRss(metric, result.resourceUsage.maxRSS / 1048576) };
      samples.push(sample); console.log(JSON.stringify({ diagnostic: "main-hook-image-sample", ...sample }));
    }
    const rss = samples.map(row => row.rssMB).sort((a, b) => a - b);
    groups.push({ event, runs: samples.length, coldFirstMB: samples[0]!.rssMB,
      medianRssMB: (rss[9]! + rss[10]!) / 2, peakRssMB: rss.at(-1)! });
  } finally { f.close(); }
}
console.log(JSON.stringify({ diagnostic: "main-hook-images", revision: revision.stdout.toString().trim(), comparisonOnly: true, groups }));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  "\nMain hook image comparison (" + revision.stdout.toString().trim() + ")\n\n| Event | Cold first MB | Median MB | Max MB |\n|---|---:|---:|---:|\n"
  + groups.map(row => "| " + row.event + " | " + row.coldFirstMB.toFixed(2) + " | " + row.medianRssMB.toFixed(2) + " | " + row.peakRssMB.toFixed(2) + " |").join("\n") + "\n");
