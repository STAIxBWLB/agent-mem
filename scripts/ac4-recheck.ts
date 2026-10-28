/**
 * Issue #13 AC4 re-measure after P1: the frozen 25-query set of docs/p0-baseline.md §3.4 against the new FTS5
 * search (`store.search`), same hit definition (an on-topic entry in the first 10, judged from result titles) and
 * the same project-scoped corpus convention (a copy of the live home, never the live one).
 *
 * Usage: bun scripts/ac4-recheck.ts --home <parent-of-memory> [--project <key>] [--limit N] [--mcp [--cwd <repo>]]
 * Prints JSON: per query the engine and the top hits (source and title/text start), for the operator's judgment
 * table in docs/p1-ac4-recheck.md.
 *
 * #137: a home split into shards is read through its project shard, and `--mcp` measures the path that counted
 * for P5, `amem mcp` `tools/call amem_search { query, limit }`, with `AMEM_HOME` pointing at the copy.
 * The script refuses the live home: it runs only against a copy. It is not part of the package (`files` in package.json).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath, realPath } from "../src/memory/platform.ts";
import { memoryHome } from "../src/memory/home.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";
import { aliasedKeys, resolveAlias } from "../src/memory/aliases.ts";

export const QUERIES = [
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

type Env = Readonly<Record<string, string | undefined>>;
export interface RecheckHit { source: string; score: number; title: string }
export interface RecheckReport { project: string; corpus: number; engine: string | undefined; path?: "mcp"; queries: { n: number; query: string; engine: string; hits: RecheckHit[] }[] }

/** A path as the store would open it: platform `realPath` (with the Bun backslash workaround) when it exists, `canonicalPath` only when it does not. */
const resolved = (path: string): string => existsSync(path) ? realPath(path) : canonicalPath(path);

/**
 * The copy's memory directory, refused when it is a live home: the one this environment resolves, the one it resolves without `AMEM_HOME`,
 * and the default directory itself before any `amem.config.json` pointer is followed (a store given an explicit home opens it directly).
 */
export function assertCopyHome(home: string, env: Env = process.env): string {
  const dir = resolved(join(home, "memory"));
  const bare = { ...env, AMEM_HOME: undefined } as NodeJS.ProcessEnv;
  // memoryHome's own pre-pointer default (AGENTHUB_HOME, else os.homedir()), plus the HOME-based one in case HOME differs from os.homedir().
  const defaults = [join(env.AGENTHUB_HOME?.trim() || join(homedir(), ".agenthub"), "memory"), ...(env.HOME?.trim() ? [join(env.HOME.trim(), ".agenthub", "memory")] : [])];
  const live = new Set([memoryHome(env as NodeJS.ProcessEnv), memoryHome(bare), ...defaults].map(resolved));
  if (live.has(dir)) throw new Error(`refusing the live memory home ${dir}: copy it first (see docs/p5-cutover.md, P6 retrieval re-check) and pass the copy's parent`);
  if (!existsSync(dir)) throw new Error(`no memory directory at ${dir}: --home takes the parent of the copied memory directory`);
  return dir;
}

const split = (dir: string): boolean => existsSync(join(dir, "shards.json"));
const title = (text: string | undefined): string => (text ?? "").slice(0, 110);

/** The library path: `store.search` on the copy, through the project shard when the home is split. */
export function recheckStore(opts: { home: string; project: string; limit: number; env?: Env }): RecheckReport {
  const dir = assertCopyHome(opts.home, opts.env);
  // The same key reconciliation `amem mcp` uses (createMemoryMcp): the canonical key of --project and every key aliased to it.
  const project = resolveAlias(dir, opts.project), aliases = aliasedKeys(dir, project), reconcile = aliases.length ? { reconcile: { canonical: project, aliases } } : {};
  const store = split(dir) ? openShardStore({ memoryDir: dir, project, screen: () => "skip", ...reconcile }) : new MemoryStore({ memoryDir: dir, screen: () => "skip", ...reconcile });
  try {
    const corpus = store.list({ project, limit: Number.MAX_SAFE_INTEGER }).length;
    const queries = QUERIES.map((query, i) => {
      const result = store.search(query, { project, limit: opts.limit });
      return { n: i + 1, query, engine: result.engine,
        hits: result.hits.map(h => ({ source: h.source, score: Number(h.score.toFixed(6)), title: h.view?.title ?? title(h.view?.text ?? h.capture?.excerpt) })) };
    });
    return { project: opts.project, corpus, engine: queries[0]?.engine, queries };
  } finally { store.close(); }
}

/**
 * A working directory `amem mcp` binds to `project`: the given repository, or a throwaway git directory whose origin is
 * `https://<project>` when that yields the same key. `amem mcp` takes its project from its working directory only.
 */
function projectCwd(project: string, cwd: string | undefined): { cwd: string; cleanup: () => void } {
  if (cwd) {
    if (memoryProjectKey(cwd) !== project) throw new Error(`--cwd ${cwd} is project ${memoryProjectKey(cwd)}, not ${project}`);
    return { cwd, cleanup: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "amem-ac4-cwd-")), cleanup = () => rmSync(dir, { recursive: true, force: true });
  spawnSync("git", ["init", "-q", dir]); spawnSync("git", ["-C", dir, "remote", "add", "origin", `https://${project}`]);
  if (memoryProjectKey(dir) !== project) { cleanup(); throw new Error(`cannot bind amem mcp to ${project} from a scratch directory: pass --cwd <a checkout of that repository>`); }
  return { cwd: dir, cleanup };
}

/** The MCP path that counted for P5: one `amem mcp` session over stdio, `tools/call amem_search { query, limit }` per query, with `AMEM_HOME` set to the copy. */
export async function recheckMcp(opts: { home: string; project: string; limit: number; cwd?: string; env?: Env; entry?: string }): Promise<RecheckReport> {
  const dir = assertCopyHome(opts.home, opts.env);
  const corpus = recheckStore({ ...opts, limit: 1 }).corpus;   // the same corpus count as the library path
  const bound = projectCwd(opts.project, opts.cwd), entry = opts.entry ?? join(import.meta.dir, "..", "bin", "amem.js");
  // `amem mcp` is served before any person/agent check, so no marker is needed; the real stdio entry is measured, not createMemoryMcp.
  const env = { ...process.env, ...opts.env, AMEM_HOME: dir };
  try {
    const frames = [
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ac4-recheck", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ...QUERIES.map((query, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "amem_search", arguments: { query, limit: opts.limit } } })),
    ];
    const child = spawn(process.execPath, [entry, "mcp"], { cwd: bound.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", chunk => out.push(chunk)); child.stderr.on("data", chunk => err.push(chunk));
    child.stdin.end(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n");
    const code = await new Promise<number | null>(resolve => child.on("close", resolve));
    if (code !== 0) throw new Error(`amem mcp exited ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 400)}`);
    const replies = new Map<number, { result?: { isError?: boolean; content?: { text: string }[] } }>();
    for (const line of Buffer.concat(out).toString("utf8").split("\n").filter(Boolean)) { const reply = JSON.parse(line); if (typeof reply.id === "number") replies.set(reply.id, reply); }
    const queries = QUERIES.map((query, i) => {
      const reply = replies.get(i + 1);
      if (!reply?.result || reply.result.isError) throw new Error(`amem_search failed for query ${i + 1}`);
      const body = JSON.parse(reply.result.content?.[0]?.text ?? "{}") as { engine: string; hits: { source: string; score: number; view?: { title?: string; text?: string }; capture?: { excerpt?: string } }[] };
      return { n: i + 1, query, engine: body.engine,
        hits: body.hits.map(h => ({ source: h.source, score: Number(h.score.toFixed(6)), title: h.view?.title ?? title(h.view?.text ?? h.capture?.excerpt) })) };
    });
    return { project: opts.project, corpus, engine: queries[0]?.engine, path: "mcp", queries };
  } finally { bound.cleanup(); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const read = (name: string): string | undefined => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const home = read("--home");
  if (!home) throw new Error("usage: bun scripts/ac4-recheck.ts --home <parent-of-memory> [--project <key>] [--limit N] [--mcp [--cwd <repo>]]");
  const project = read("--project") ?? "github.com/staixbwlb/agent-hub";
  const limit = Number(read("--limit") ?? "10"), cwd = read("--cwd");
  const report = args.includes("--mcp") ? await recheckMcp({ home, project, limit, ...(cwd ? { cwd } : {}) }) : recheckStore({ home, project, limit });
  console.log(JSON.stringify(report, null, 2));
}
