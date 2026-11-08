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
// #302 (owner ruling D): per-phase eviction timing for the next red run. Measurement only: the store's eviction logic is untouched.
// `evict` is wrapped on the instance, and every transaction opened while it runs is one batch (timed on its own).
const phases = { evictMs: 0, batches: 0, longestTxMs: 0 };
{
  const internal = store as unknown as { evict: () => unknown; db: { transaction: (fn: (...args: never[]) => unknown) => ((...args: never[]) => unknown) & { immediate: (...args: never[]) => unknown } } };
  let inEvict = false;
  const transaction = internal.db.transaction.bind(internal.db), evict = internal.evict.bind(store);
  internal.db.transaction = fn => {
    const run = transaction(fn);
    const timed = (call: (...args: never[]) => unknown) => (...args: never[]) => {
      if (!inEvict) return call(...args);
      const start = performance.now();
      try { return call(...args); } finally { phases.batches++; phases.longestTxMs = Math.max(phases.longestTxMs, performance.now() - start); }
    };
    return Object.assign(timed(run), { immediate: timed(run.immediate.bind(run)) });
  };
  internal.evict = () => {
    inEvict = true; const start = performance.now();
    try { return evict(); } finally { phases.evictMs += performance.now() - start; inEvict = false; }
  };
}
const result = store.append({ project, agent: "measure", event: "PostToolUse", tool: "Edit", paths: ["src/memory/store.ts"], status: "ok", excerpt: `hook excerpt ${"x".repeat(200)}` });
store.close();
console.log(JSON.stringify({ ...result, maxRSS: peakRssKB(), evict: { ms: phases.evictMs, batches: phases.batches, longestTxMs: phases.longestTxMs } }));
