/** #201: real CLI Stop/SessionEnd with a fresh 256 KiB transcript tail per run.
 * Run beside the unchanged R1/R2 harness; every physical sample is printed, never discarded.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "../test/fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { HOOK_TRANSCRIPT_BYTES } from "../src/hook-transcript.ts";
import { budgetGroup } from "./budget-attempt.ts";

const RUNS = 40, p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
async function measure() {
  const f = hookFixture(), samples: { event: string; run: number; wallMs: number; rssMB: number; offset: number }[] = [];
  try {
    await f.seed();
    const transcript = join(f.root, "transcript.jsonl");
    for (const event of ["Stop", "SessionEnd"]) for (let run = 1; run <= RUNS; run++) {
      const session = `${event}-${run}`, at = new Date().toISOString(), marker = `summary ${session}`;
      const lines = [JSON.stringify({ type: "assistant", timestamp: at }), JSON.stringify({ type: "ai-title", aiTitle: marker }),
        JSON.stringify({ type: "system", subtype: "away_summary", timestamp: at, content: marker }),
        JSON.stringify({ type: "user", isCompactSummary: true, timestamp: at, message: { content: marker } })];
      // All three kinds plus an ordinary tail at the maximum read size. No fixture setup enters timing.
      const prefix = lines.join("\n") + "\n", ordinary = JSON.stringify({ type: "assistant", text: "x".repeat(800) }) + "\n";
      writeFileSync(transcript, prefix + ordinary.repeat(Math.ceil((HOOK_TRANSCRIPT_BYTES - Buffer.byteLength(prefix)) / ordinary.length)));
      Bun.gc(true);
      const started = performance.now(), result = f.run(event, { session_id: session, transcript_path: transcript });
      const wallMs = performance.now() - started, metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
      const digest = createHash("sha256").update(`amem-session\0${session}`).digest("hex").slice(0, 16);
      const file = join(f.base, "hook-transcripts", `${digest}.db`);
      if (result.exitCode !== 0 || result.stdout.length || !metric || !existsSync(file)) throw Error("transcript budget hook did not scan");
      const db = new Database(file, { readonly: true });
      let offset: number;
      try { offset = (db.query("SELECT offset FROM cursor").get() as { offset: number }).offset; } finally { db.close(); }
      if (!(offset > Buffer.byteLength(prefix) && offset <= HOOK_TRANSCRIPT_BYTES)) throw Error("transcript budget scan progress unavailable");
      const captured = f.rows().filter(row => row.session === digest);
      const pending = [join(f.base, "hook-spool"), join(f.base, "hook-spool", ".capacity")].flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")).flatMap(name => {
        const value = JSON.parse(readFileSync(join(dir, name), "utf8"));
        return value.capture?.session === digest ? [value.capture] : [];
      }) : []);
      for (const kind of ["Title", "Recap", "Compact"]) if (![...captured, ...pending].some(row => row.event === kind && row.excerpt === marker)) throw Error(`missing scanned ${kind}`);
      const rssMB = Math.max(result.resourceUsage.maxRSS / 1048576, metric.rssMB ?? Infinity);
      const sample = { event, run, wallMs, rssMB, offset }; samples.push(sample); console.log(JSON.stringify({ diagnostic: "transcript-budget-sample", ...sample }));
    }
    const groups = ["Stop", "SessionEnd"].map(event => {
      const rows = samples.filter(row => row.event === event), wallP95Ms = p95(rows.map(row => row.wallMs)), peakRssMB = Math.max(...rows.map(row => row.rssMB));
      return { event, runs: rows.length, wallP95Ms, peakRssMB, wallPass: wallP95Ms < 150, rssPass: peakRssMB < 100 };
    });
    return { groups, samples };
  } finally { f.close(); }
}
const result = await budgetGroup("transcript-hooks", measure, report => ({ wallPass: report.groups.every(row => row.wallPass), rssPass: report.groups.every(row => row.rssPass) }));
console.log(JSON.stringify(result, null, 2));
