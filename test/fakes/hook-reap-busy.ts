import { join } from "node:path";
import { createHash } from "node:crypto";
import { scanHookTranscriptTail } from "../../src/hook-transcript.ts";
import { CaptureStore } from "../../src/memory/capture.ts";
import { hookCaptureScope } from "../../src/hook-spool.ts";
import { acceptHookProjectReceipt } from "../../src/hook-project.ts";
import { hookRssReading } from "../../src/hook-resources.ts";

// Load the production worker's modules, scan its 256 KiB allowance, and keep a real SQLite capture store open.
// No descendants. After readiness the CPU arm only spins; the write arm repeats the production append/commit path.
const phase = process.argv[2] ?? "--phase=cpu";
if (process.argv.length > 3 || !["--phase=cpu", "--phase=write"].includes(phase))
  throw Error("Reap fixture phase is invalid; use the fixed CPU or capture-write probe arm");
void acceptHookProjectReceipt;
const cwd = process.cwd(), base = join(cwd, "memory"), project = "reap-probe";
if (!hookCaptureScope(cwd, base)) throw Error("Representative probe scope is unavailable; inspect the isolated fixture");
const scanned = await scanHookTranscriptTail({ cwd, session_id: "reap-probe", transcript_path: join(cwd, "transcript.jsonl") },
  { cwd, base, deadline: performance.now() + 1_500 });
if (!scanned?.offset || scanned.stopReason === "unavailable") throw Error("Representative probe scan is incomplete; inspect the isolated fixture");
const store = new CaptureStore({ memoryDir: base, project, cwd, busyTimeoutMs: 0 });
store.append({ project, agent: "claude", event: "Recap", excerpt: "representative reap probe" });
Object.defineProperty(globalThis, "__reapProbeOpenStore", { value: store });
const rss = hookRssReading();
await Bun.write(Bun.stdout, JSON.stringify({ ready: true, phase: phase.slice(8), fixture: "capture-store-scanned", openStore: true,
  transcriptOffset: scanned.offset, rssKB: rss.kb, rawRssKB: rss.rawKB, rssSource: rss.source,
  rssKnown: rss.known, liveRssMB: process.memoryUsage().rss / 1048576, workerUptimeMs: performance.now() }) + "\n");
if (phase === "--phase=cpu") for (;;) { Math.sqrt(performance.now()); }
const at = new Date().toISOString(), payload = "x".repeat(800);
for (let sequence = 0; sequence < 20_000; sequence++) {
  // append() drains any capture spool, starts an IMMEDIATE transaction, inserts the row and commits, then evicts.
  // No extra stdout/file observer runs inside this loop. The phase label does not claim an exact SQL PC at kill.
  const receipt = createHash("sha256").update("reap-probe-" + sequence).digest("hex");
  const appended = store.append({ project, agent: "claude", event: "Recap", at, excerpt: `probe ${sequence} ${payload}` }, { receipt });
  if ("spooled" in appended && appended.spooled) throw Error("Reap write arm spooled instead of committing; inspect the isolated fixture and reject the schedule");
}
throw Error("Reap write arm reached its finite row bound before SIGKILL; retain this incomplete schedule");
