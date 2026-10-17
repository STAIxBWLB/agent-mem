// R2 hook-like invocation (issue #13): one capture append, then exit. The parent measures wall time; this child's
// resourceUsage().maxRSS is the true peak RSS of the short-lived process (bytes on macOS, KB on Linux).
import { CaptureStore } from "../src/memory/capture.ts";

const home = process.env.AMEM_BUDGET_HOME;
if (!home) throw new Error("AMEM_BUDGET_HOME is required");
const store = new CaptureStore({ home });
const result = store.append({ project: "budget", agent: "measure", event: "PostToolUse", tool: "Edit", paths: ["src/memory/store.ts"], status: "ok", excerpt: `hook excerpt ${"x".repeat(200)}` });
store.close();
console.log(JSON.stringify({ ...result, maxRSS: process.resourceUsage().maxRSS }));
