import { join } from "node:path";
import { scanHookTranscriptTail } from "../../src/hook-transcript.ts";
import { CaptureStore } from "../../src/memory/capture.ts";
import { hookCaptureScope } from "../../src/hook-spool.ts";
import { acceptHookProjectReceipt } from "../../src/hook-project.ts";
import { hookRssReading } from "../../src/hook-resources.ts";

// Load the production worker's modules, scan its 256 KiB allowance, and keep a real SQLite capture store open.
// There are no descendants or I/O after readiness; the blocked phase itself is CPU-only, like the slow-store test.
void acceptHookProjectReceipt;
const cwd = process.cwd(), base = join(cwd, "memory"), project = "reap-probe";
if (!hookCaptureScope(cwd, base)) throw Error("Representative probe scope is unavailable; inspect the isolated fixture");
const scanned = await scanHookTranscriptTail({ cwd, session_id: "reap-probe", transcript_path: join(cwd, "transcript.jsonl") },
  { cwd, base, deadline: performance.now() + 1_500 });
if (!scanned?.offset || scanned.stopReason === "unavailable") throw Error("Representative probe scan is incomplete; inspect the isolated fixture");
const store = new CaptureStore({ memoryDir: base, project, cwd, busyTimeoutMs: 0 });
store.append({ project, agent: "claude", event: "Recap", excerpt: "representative reap probe" });
const rss = hookRssReading();
await Bun.write(Bun.stdout, JSON.stringify({ ready: true, fixture: "capture-store-scanned", openStore: true,
  transcriptOffset: scanned.offset, rssKB: rss.kb, rawRssKB: rss.rawKB, rssSource: rss.source,
  rssKnown: rss.known, liveRssMB: process.memoryUsage().rss / 1048576, workerUptimeMs: performance.now() }) + "\n");
for (;;) { Math.sqrt(performance.now()); }
