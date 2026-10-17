/**
 * Issue #13 AC4 re-measure after P1: the frozen 25-query set of docs/p0-baseline.md §3.4 against the new FTS5
 * search (`store.search`), same hit definition (an on-topic entry in the first 10, judged from result titles) and
 * the same project-scoped corpus convention (a copy of the live home, never the live one).
 *
 * Usage: bun scripts/ac4-recheck.ts --home <parent-of-memory> [--project <key>] [--limit N]
 * Prints JSON: per query the engine and the top hits (source and title/text start), for the operator's judgment
 * table in docs/p1-ac4-recheck.md.
 */
import { MemoryStore } from "../src/memory/store.ts";

const QUERIES = [
  "seatbelt HFS+ ignorable code points .git",
  "review done never throw after approval write",
  "escalation publish failure assignment delivery",
  "peer_stop stop headless agent",
  "upgrade restore blocked launcher session attach",
  "turn-free test silent waits",
  "macOS CI flaky timing tests",
  "usage_update context occupancy kimi",
  "permission modes grantablePath",
  "codex resume restore owed native policy",
  "console task assignment revision queue",
  "kimi TUI pull-only headless ACP",
  "memory split agent-mem migration generation profile",
  "candidate sidecar memory_correct counter",
  "cli output table columns color json",
  "office view dashboard pet window",
  "database busy timeout locked restart",
  "usage limit refusal quota pause reroute",
  "submodule git directory sandbox",
  "hardened git helper fsmonitor hooksPath",
  "pi bounded spec access container check runner",
  "chroma RSS admission blocked heavy job",
  "work_state import lists",
  "watchdog cancel overlap ACP prompt",
  "realPath backslash ENOENT Bun",
] as const;

const args = process.argv.slice(2);
const read = (name: string): string | undefined => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const home = read("--home");
if (!home) throw new Error("usage: bun scripts/ac4-recheck.ts --home <parent-of-memory> [--project <key>] [--limit N]");
const project = read("--project") ?? "github.com/staixbwlb/agent-hub";
const limit = Number(read("--limit") ?? "10");

const store = new MemoryStore({ home, screen: () => "skip" });
try {
  const corpus = store.list({ project, limit: Number.MAX_SAFE_INTEGER }).length;
  const out = QUERIES.map((q, i) => {
    const result = store.search(q, { project, limit });
    return {
      n: i + 1, query: q, engine: result.engine,
      hits: result.hits.map((h) => ({ source: h.source, score: Number(h.score.toFixed(6)), title: h.view?.title ?? (h.view?.text ?? h.capture?.excerpt ?? "").slice(0, 110) })),
    };
  });
  console.log(JSON.stringify({ project, corpus, engine: out[0]?.engine, queries: out }, null, 2));
} finally { store.close(); }
