// R2 hook-like invocation (issue #13): one capture append, then exit. The parent measures wall time; the child's
// peak RSS is its own high-water mark (/proc VmHWM on Linux, resourceUsage maxRSS elsewhere). AMEM_BUDGET_CAP_MB
// shrinks the shard cap first, so the append measures the time-bounded eviction path after a cap shrink (R2).
import { CaptureStore } from "../src/memory/capture.ts";
import { peakRssKB } from "./budget-rss.ts";

const home = process.env.AMEM_BUDGET_HOME;
if (!home) throw new Error("AMEM_BUDGET_HOME is required");
const project = process.env.AMEM_BUDGET_PROJECT ?? "budget";
const capMb = Number(process.env.AMEM_BUDGET_CAP_MB ?? "");
const store = new CaptureStore({ home, project, ...(Number.isFinite(capMb) && capMb > 0 ? { capMb } : {}) });
const result = store.append({ project, agent: "measure", event: "PostToolUse", tool: "Edit", paths: ["src/memory/store.ts"], status: "ok", excerpt: `hook excerpt ${"x".repeat(200)}` });
store.close();
console.log(JSON.stringify({ ...result, maxRSS: peakRssKB() }));
