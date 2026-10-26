/** Retrieval only: no reader model, generated answer, judge, network call or runtime package dependency. */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { canonicalPath, memoryGitEnv, memoryGitSync, realPath } from "../src/memory/platform.ts";
import { peakRssKB } from "./budget-rss.ts";
import { aggregateMetrics, type Backend, type GoldEvidence, type QuestionRetrieval, type RankedTurn } from "./longmemeval-metrics.ts";
import { hashLongMemEvalFile, parseBenchmarkDate, readLongMemEvalQuestions, validateQuestion, type LongMemEvalQuestion, type LongMemEvalTurn } from "./longmemeval-input.ts";

const HERE = realPath(join(import.meta.dir, "..")), LIMIT = 50, DEFAULT_TIMEOUT = 30_000;
const HARNESS_FILES = ["longmemeval.ts", "longmemeval-input.ts", "longmemeval-metrics.ts", "budget-rss.ts"];
function harnessDigest(): string {
  const hash = createHash("sha256");
  for (const file of HARNESS_FILES) hash.update(file).update(readFileSync(join(HERE, "scripts", file)));
  return hash.digest("hex");
}
const HARNESS_AT_LOAD = harnessDigest();
const BACKENDS: readonly Backend[] = ["mcp", "library", "bm25"];
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const requireBench = (ok: unknown, reason: string): void => { if (!ok) throw Error("LongMemEval: " + reason); };
const code = (error: unknown): string => error instanceof Error ? error.message.slice(0, 300) : "unknown failure";
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export interface BenchmarkOptions {
  input: string; output: string; sourceRoot?: string; questionTimeoutMs?: number; maxQuestions?: number; variant?: string;
}
interface Runtime { root: string; commit: string; version: string }
interface QuestionRun extends QuestionRetrieval {
  upstreamNoUserTarget: boolean;
  status: "ok" | "partial" | "timeout" | "failed" | "abstention-excluded"; workerError?: string;
  wallMs: number; cleanupMs: number; workerPeakKB: number | null; workerPeakComplete: boolean; workerCheckpointPeakKB?: number; mcpPeakKB: number | null;
  times: Partial<Record<"seed" | "library" | "bm25" | "mcp" | "mcpQuery", number>>;
  completedAt: Partial<Record<Backend, number>>;
  rows: { input: number; stored: number; overExcerptCap: number; changedExcerpts: number; retentionDays: number; duplicateSessionIds: number };
}
const emptyRows = () => ({ input: 0, stored: 0, overExcerptCap: 0, changedExcerpts: 0, retentionDays: 0, duplicateSessionIds: 0 });
/** Repeated session IDs are valid upstream; ordinal indexes every occurrence without losing rows. */
function eachTurn(q: LongMemEvalQuestion, visit: (turn: LongMemEvalTurn, sessionIndex: number, ref: RankedTurn) => void): void {
  const next = new Map<string, number>();
  q.haystack_sessions.forEach((session, sessionIndex) => {
    const sessionId = q.haystack_session_ids[sessionIndex]!;
    for (const turn of session) {
      const turnIndex = next.get(sessionId) ?? 0; next.set(sessionId, turnIndex + 1);
      visit(turn, sessionIndex, { sessionId, turnIndex });
    }
  });
}
function goldOf(q: LongMemEvalQuestion): GoldEvidence {
  const turns: RankedTurn[] = [], counts = new Map<string, number>();
  eachTurn(q, (turn, _sessionIndex, ref) => {
    if (turn.has_answer === true) turns.push(ref);
    counts.set(ref.sessionId, (counts.get(ref.sessionId) ?? 0) + 1);
  });
  return { sessionIds: q.answer_session_ids, turns, corpusSessions: [...counts].map(([sessionId, turns]) => ({ sessionId, turns })) };
}
function baseResult(q: LongMemEvalQuestion): QuestionRun {
  // Detach tiny persistent metadata from a possible substring-backed multi-MB JSON source string.
  const truth = JSON.parse(Buffer.from(JSON.stringify({ id: q.question_id, type: q.question_type,
    abstention: q.question_id.includes("_abs"), upstreamNoUserTarget: !q.haystack_sessions.some(session => session.some(turn => turn.role === "user" && turn.has_answer === true)), gold: goldOf(q) })).toString("utf8"));
  return { ...truth,
    rankings: {}, errors: {}, status: "failed", wallMs: 0, cleanupMs: 0, workerPeakKB: null, workerPeakComplete: false, mcpPeakKB: null, times: {}, completedAt: {}, rows: emptyRows() };
}
export function preserveCompleted(q: LongMemEvalQuestion, checkpoint: Partial<QuestionRun> | undefined, reason: string, deadlineAt = Infinity): QuestionRun {
  const base = baseResult(q), valid = checkpoint?.id === base.id && checkpoint.type === base.type;
  const result: QuestionRun = valid ? { ...base, ...checkpoint, id: base.id, type: base.type, gold: base.gold,
    rankings: { ...checkpoint.rankings }, errors: { ...checkpoint.errors } } : base;
  result.status = reason === "question time limit" ? "timeout" : "failed";
  for (const backend of BACKENDS) {
    if (result.rankings[backend] !== undefined && Number.isFinite(deadlineAt)
      && !(typeof result.completedAt[backend] === "number" && result.completedAt[backend]! <= deadlineAt)) {
      delete result.rankings[backend]; result.errors![backend] = "backend did not complete before question deadline";
    }
    if (result.rankings[backend] === undefined && !result.errors?.[backend]) result.errors![backend] = reason;
  }
  if (result.workerPeakComplete !== true) {
    if (result.workerPeakKB !== null) result.workerCheckpointPeakKB = result.workerPeakKB;
    result.workerPeakKB = null; result.workerPeakComplete = false;
  }
  return result;
}
function writeCheckpoint(file: string, result: QuestionRun, complete: boolean): void {
  const value = { ...result, workerPeakKB: peakRssKB(), workerPeakComplete: complete };
  writeFileSync(file + ".next", JSON.stringify(value), { mode: 0o600 }); renameSync(file + ".next", file);
}

function envFor(home: string, base?: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: home, ...(base ? { AMEM_HOME: base } : {}),
    TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
}
function git(root: string, args: string[]) {
  return memoryGitSync(["-C", root, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
    env: memoryGitEnv({ PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, { repositoryIsolation: true }) });
}
function runtimeAt(root: string): Runtime {
  root = realPath(resolve(root));
  const head = git(root, ["rev-parse", "HEAD"]);
  requireBench(head.status === 0 && /^[a-f0-9]{40}\n$/.test(head.stdout), "runtime must be a Git checkout");
  const clean = git(root, ["diff", "--exit-code", "HEAD", "--", "src", "bin", "package.json"]);
  requireBench(clean.status === 0, "runtime source is dirty");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  requireBench(pkg.name === "@staix/agent-mem" && typeof pkg.version === "string", "unexpected runtime package");
  return { root, commit: head.stdout.trim(), version: pkg.version };
}
async function sourceImport(runtime: Runtime, file: string): Promise<any> {
  return import(pathToFileURL(join(runtime.root, file)).href);
}
function mapped(ids: readonly number[], refs: Map<number, RankedTurn>): RankedTurn[] {
  requireBench(ids.length <= LIMIT, "retrieval exceeded requested depth");
  return ids.map(id => {
    requireBench(Number.isSafeInteger(id) && refs.has(id), "retrieval returned an unknown capture identity");
    return refs.get(id)!;
  });
}
function captureIds(result: unknown, project: string): number[] {
  requireBench(object(result) && result.engine === "fts5" && Array.isArray(result.hits), "retrieval did not use capture FTS5");
  return (result as any).hits.map((hit: any) => {
    requireBench(hit?.source === "capture" && object(hit.capture) && hit.capture.project === project, "retrieval escaped its synthetic capture corpus");
    return hit.capture.id as number;
  });
}

async function queryMcp(runtime: Runtime, home: string, base: string, cwd: string, project: string, question: string, clock: number) {
  const preload = join(home, "mcp-clock-rss.ts"), usage = join(home, "mcp-rss.json");
  writeFileSync(preload, "import {writeFileSync} from 'node:fs';import {peakRssKB} from " +
    JSON.stringify(join(HERE, "scripts/budget-rss.ts")) + ";\nDate.now=()=>" + clock + ";\n" +
    "process.once('exit',code=>writeFileSync(" + JSON.stringify(usage) +
    ",JSON.stringify({exitCode:code,peakKB:peakRssKB(),clockMs:Date.now()}),{mode:0o600}));\n", { mode: 0o600 });
  const child = Bun.spawn([process.execPath, "--smol", "--preload", preload, join(runtime.root, "bin/amem.js"), "mcp"],
    { cwd, env: envFor(home, base), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let exited = false; const exit = child.exited.then(value => { exited = true; return value; });
  const errors = new Response(child.stderr).text(), reader = child.stdout.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", total = 0, sequence = 0;
  const next = async (id: number): Promise<Record<string, any>> => {
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const response = JSON.parse(line);
        requireBench(object(response) && response.jsonrpc === "2.0" && response.id === id && !response.error && object(response.result), "MCP response unavailable");
        return response.result;
      }
      const chunk = await reader.read(); requireBench(!chunk.done, "MCP ended before its response");
      total += chunk.value!.byteLength; requireBench(total <= 2 * 1024 * 1024, "MCP output bound exceeded");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  const send = (value: unknown) => { child.stdin.write(JSON.stringify(value) + "\n"); child.stdin.flush(); };
  const request = async (method: string, params: unknown) => { const id = ++sequence; send({ jsonrpc: "2.0", id, method, params }); return next(id); };
  const started = performance.now();
  try {
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "longmemeval-retrieval", version: "1" } });
    requireBench(initialized.serverInfo?.name === "amem" && initialized.serverInfo.version === runtime.version, "MCP runtime identity mismatch");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const queryStarted = performance.now();
    const result = await request("tools/call", { name: "amem_search", arguments: { query: question, limit: LIMIT } });
    const queryMs = performance.now() - queryStarted;
    const text = result.content?.find((entry: any) => entry.type === "text" && typeof entry.text === "string")?.text;
    requireBench(result.isError !== true && typeof text === "string", "MCP query unavailable or refused");
    const ids = captureIds(JSON.parse(text), project);
    child.stdin.end();
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      total += chunk.value.byteLength; requireBench(total <= 2 * 1024 * 1024, "MCP output bound exceeded");
      requireBench(!decoder.decode(chunk.value, { stream: true }).trim(), "unexpected trailing MCP output");
    }
    requireBench(!buffer.trim() && !decoder.decode().trim() && await exit === 0, "MCP failed EOF/reap");
    const measured = JSON.parse(readFileSync(usage, "utf8"));
    const wait4 = process.platform === "darwin" ? (child.resourceUsage()?.maxRSS ?? 0) / 1024 : 0;
    requireBench(measured.exitCode === 0 && measured.peakKB > 0 && measured.clockMs === clock, "MCP clock or peak RSS unavailable");
    return { ids, queryMs, wallMs: performance.now() - started, peakKB: Math.max(measured.peakKB, wait4) };
  } finally {
    if (!exited) try { child.kill("SIGKILL"); } catch { /* Parent owns the enclosing worker group until reap. */ }
    await exit;
    await reader.cancel().catch(() => {}); reader.releaseLock();
    await errors;
  }
}

/** All stores are throwaway. Gold IDs/turn flags stay in this controller, never in indexed text. */
export async function runQuestion(q: LongMemEvalQuestion, runtime: Runtime, home: string, checkpoint: (value: QuestionRun) => void = () => {}): Promise<QuestionRun> {
  const result = baseResult(q), started = performance.now(), cwd = join(home, "project"), base = join(home, "memory");
  const clock = parseBenchmarkDate(q.question_date), dates = q.haystack_dates.map(parseBenchmarkDate);
  const retentionDays = Math.max(90, Math.ceil((clock - dates.reduce((minimum, at) => Math.min(minimum, at), clock)) / 86400_000) + 2);
  result.rows.retentionDays = retentionDays;
  result.rows.duplicateSessionIds = q.haystack_session_ids.length - new Set(q.haystack_session_ids).size;
  mkdirSync(cwd, { recursive: true, mode: 0o700 }); mkdirSync(base, { mode: 0o700 }); mkdirSync(join(home, "tmp"), { recursive: true, mode: 0o700 });
  writeFileSync(join(base, "capture-config.json"), JSON.stringify({ cap_mb: 512, retention_days: retentionDays }), { mode: 0o600 });
  const env = envFor(home, base), initialized = memoryGitSync(["-C", cwd, "init", "-q"],
    { env: memoryGitEnv(env, { repositoryIsolation: true }), encoding: "utf8", timeout: 5000 });
  requireBench(initialized.status === 0, "cannot initialize synthetic project");
  const { memoryProjectKey } = await sourceImport(runtime, "src/memory/project.ts");
  const { MemoryStore } = await sourceImport(runtime, "src/memory/store.ts");
  const { CaptureStore } = await sourceImport(runtime, "src/memory/capture.ts");
  const { ftsTerms, fts5Available } = await sourceImport(runtime, "src/memory/search-fts.ts");
  requireBench(fts5Available(), "FTS5 unavailable");
  const project = memoryProjectKey(cwd, { repositoryIsolation: true }), refs = new Map<number, RankedTurn>(), originals = new Map<number, string>();
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true, now: () => clock });
  requireBench(store.readNow() === clock, "library clock mismatch");
  const capture = new CaptureStore({ memoryDir: base, project, cwd, now: () => clock, retentionDays, capMb: 512 });
  const db = (capture as { db: Database }).db, databaseFile = join(capture.dir, "capture.db");
  try {
    const seedStarted = performance.now();
    db.transaction(() => {
      eachTurn(q, (turn, sessionIndex, ref) => {
        const appended = capture.append({ project, agent: "longmemeval", event: turn.role, at: new Date(dates[sessionIndex]!).toISOString(),
          excerpt: turn.content, paths: [] }, { receipt: digest([q.question_id, ref.sessionId, ref.turnIndex]) });
        requireBench("id" in appended && !appended.already, "capture unexpectedly spooled or duplicated");
        refs.set(appended.id, ref); originals.set(appended.id, turn.content);
        result.rows.input++; result.rows.overExcerptCap += Number(turn.content.length > 2000);
      });
    })();
    result.rows.stored = capture.stats().rows;
    requireBench(result.rows.stored === result.rows.input, "capture retention or capacity removed benchmark turns");
    for (const row of db.query("SELECT id,excerpt FROM rows").iterate() as Iterable<{ id: number; excerpt: string }>) {
      result.rows.changedExcerpts += Number(originals.get(row.id) !== row.excerpt);
    }
    result.times.seed = performance.now() - seedStarted;
    const queryStarted = performance.now();
    try {
      result.rankings.library = mapped(captureIds(store.search(q.question, { project, includeCapture: true, limit: LIMIT }), project), refs);
    } catch (error) { result.errors!.library = code(error); }
    result.times.library = performance.now() - queryStarted; result.completedAt.library = performance.timeOrigin + performance.now(); checkpoint(result);
  } finally { capture.close(); store.close(); }
  const plainStarted = performance.now(), plain = new Database(databaseFile, { readonly: true });
  try {
    const terms = ftsTerms(q.question);
    const rows = terms ? plain.query("SELECT rowid AS id,bm25(fts) AS rank FROM fts WHERE fts MATCH ? ORDER BY rank,rowid LIMIT ?").all(terms, LIMIT) as { id: number }[] : [];
    result.rankings.bm25 = mapped(rows.map(row => row.id), refs);
  } catch (error) { result.errors!.bm25 = code(error); }
  finally { plain.close(); }
  result.times.bm25 = performance.now() - plainStarted; result.completedAt.bm25 = performance.timeOrigin + performance.now(); checkpoint(result);
  const mcpStarted = performance.now();
  try {
    const mcp = await queryMcp(runtime, home, base, cwd, project, q.question, clock);
    result.rankings.mcp = mapped(mcp.ids, refs); result.mcpPeakKB = mcp.peakKB;
    result.times.mcp = mcp.wallMs; result.times.mcpQuery = mcp.queryMs;
  } catch (error) { result.errors!.mcp = code(error); }
  result.times.mcp ??= performance.now() - mcpStarted; result.completedAt.mcp = performance.timeOrigin + performance.now();
  result.status = BACKENDS.every(backend => result.rankings[backend] !== undefined && !result.errors?.[backend]) ? "ok" : "partial";
  result.wallMs = performance.now() - started;
  checkpoint(result); return result;
}

function members(pgid: number): number[] {
  const result = Bun.spawnSync(["/bin/ps", "-axo", "pid=,pgid="], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
  requireBench(result.exitCode === 0, "process-group table unavailable");
  return result.stdout.toString().split("\n").flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line); return m && Number(m[2]) === pgid ? [Number(m[1])] : [];
  });
}
async function executeQuestion(q: LongMemEvalQuestion, runtime: Runtime, runRoot: string, timeoutMs: number): Promise<QuestionRun> {
  const root = mkdtempSync(join(runRoot, "question-")), input = join(root, "question.json"), output = join(root, "result.json");
  const home = join(root, "home"); mkdirSync(home, { mode: 0o700 }); mkdirSync(join(home, "tmp"), { mode: 0o700 });
  const started = performance.now(), deadlineAt = performance.timeOrigin + started + timeoutMs; writeFileSync(input, JSON.stringify(q), { mode: 0o600 });
  const child = Bun.spawn([process.execPath, "--smol", import.meta.filename, "--worker", input, output, runtime.root, runtime.commit, home, HARNESS_AT_LOAD],
    { cwd: root, env: envFor(home), stdin: "ignore", stdout: "ignore", stderr: "pipe", detached: true });
  let exited = false, timedOut = false;
  const exit = child.exited.then(value => { exited = true; return value; });
  const stderr = new Response(child.stderr).text();
  const stop = () => { if (exited) return; try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* Reap barrier decides ownership. */ } } };
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, timeoutMs - (performance.now() - started)));
  const interrupted = () => stop();
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  try {
    const exitCode = await exit, elapsedMs = performance.now() - started; clearTimeout(timer);
    timedOut ||= elapsedMs >= timeoutMs;
    const cleanupStarted = performance.now();
    // Wait only for the owning init to reap killed group members, never extend retrieval time.
    const until = performance.now() + 500;
    while (members(child.pid).length && performance.now() < until) await Bun.sleep(10);
    requireBench(members(child.pid).length === 0, "owned question group survived; refusing next question");
    let saved: QuestionRun | undefined;
    try { saved = JSON.parse(readFileSync(output, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("LongMemEval: invalid worker checkpoint"); }
    let result: QuestionRun;
    if (!timedOut && exitCode === 0) {
      requireBench(saved?.id === q.question_id && saved.type === q.question_type && saved.workerPeakComplete === true
        && typeof saved.workerPeakKB === "number" && saved.workerPeakKB > 0, "invalid question worker receipt");
      const truth = baseResult(q); result = { ...saved!, id: truth.id, type: truth.type, gold: truth.gold };
    } else { result = preserveCompleted(q, saved, timedOut ? "question time limit" : "question worker failed", deadlineAt);
      if (!timedOut) result.workerError = (await stderr).slice(-3000);
    }
    if (process.platform === "darwin") {
      const wait4KB = (child.resourceUsage()?.maxRSS ?? 0) / 1024;
      requireBench(wait4KB > 0, "worker wait4 RSS unavailable");
      result.workerPeakKB = Math.max(result.workerPeakKB ?? 0, wait4KB); result.workerPeakComplete = true;
    }
    result.wallMs = elapsedMs; result.cleanupMs = performance.now() - cleanupStarted;
    return result;
  } finally {
    clearTimeout(timer); process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted);
    stop(); await exit; await stderr;
    rmSync(root, { recursive: true, force: true });
  }
}
const cell = (value: unknown) => String(value).replace(/[|<>\r\n]/g, " ");
const number = (value: number | null) => value === null ? "-" : value.toFixed(4);
export function markdownReport(report: any): string {
  const lines = ["# LongMemEval retrieval-only report", "", "Dataset SHA-256: " + report.dataset.sha256,
    "", "Runtime commit: " + report.runtime.commit, "", "Complete: " + report.complete + "; examined " + report.questions +
    "; abstentions excluded " + report.abstentions + "; question time limit " + report.questionTimeoutMs + " ms.", "",
    "| Type | Backend | N | Failed | Any@5 | All@5 | Any@10 | All@10 | ndcg_any@10 | MRR | Turn@10 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  const groups = { overall: report.metrics.overall, ...report.metrics.byType };
  for (const [type, scores] of Object.entries(groups)) for (const backend of BACKENDS) {
    const s = (scores as any)[backend];
    lines.push("| " + [cell(type), backend, s.eligible, s.failure, number(s.sessionRecallAnyAt5), number(s.sessionRecallAllAt5),
      number(s.sessionRecallAnyAt10), number(s.sessionRecallAllAt10), number(s.ndcgAnyAt10), number(s.MRR), number(s.turnRecallAt10)].join(" | ") + " |");
  }
  lines.push("", "# Per-question resources", "", "Worker peak includes input, seed, library, BM25 and controller; MCP peak is a separate process. Missing values are not zero.", "",
    "| Question | Type | Status | Wall ms | Worker peak MiB | MCP peak MiB |", "|---|---|---|---:|---:|---:|");
  for (const q of report.results) lines.push("| " + [cell(q.id), cell(q.type), q.status, Math.round(q.wallMs),
    number(q.workerPeakKB === null ? null : q.workerPeakKB / 1024), number(q.mcpPeakKB === null ? null : q.mcpPeakKB / 1024)].join(" | ") + " |");
  return lines.join("\n") + "\n";
}

export async function runLongMemEval(options: BenchmarkOptions): Promise<any> {
  const input = realPath(resolve(options.input)), output = canonicalPath(resolve(options.output)), source = runtimeAt(options.sourceRoot ?? HERE);
  requireBench(input !== output && input !== canonicalPath(output + ".jsonl") && input !== canonicalPath(output + ".md"), "output cannot overwrite dataset");
  const timeoutMs = options.questionTimeoutMs ?? DEFAULT_TIMEOUT;
  requireBench(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300_000, "invalid per-question time limit");
  requireBench(options.maxQuestions === undefined || Number.isSafeInteger(options.maxQuestions) && options.maxQuestions > 0, "invalid question limit");
  requireBench(harnessDigest() === HARNESS_AT_LOAD, "harness changed since load");
  const initial = statSync(input); requireBench(initial.isFile(), "dataset must be a regular file");
  const started = performance.now(), dataset = await hashLongMemEvalFile(input);
  for (const file of [output, output + ".jsonl", output + ".md"]) try {
    const stat = statSync(file); requireBench(stat.dev !== initial.dev || stat.ino !== initial.ino, "output aliases dataset");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const root = mkdtempSync(join(tmpdir(), "amem-longmemeval-run-")), results: QuestionRun[] = [], seen = new Set<string>();
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); writeFileSync(output + ".jsonl", "", { mode: 0o600 });
  let complete = false, fatal: string | undefined, cancelled = false;
  const stopRun = () => { cancelled = true; };
  process.once("SIGINT", stopRun); process.once("SIGTERM", stopRun);
  try {
    for await (const q of readLongMemEvalQuestions(input)) {
      if (cancelled) { fatal = "benchmark interrupted"; break; }
      if (options.maxQuestions !== undefined && results.length >= options.maxQuestions) break;
      let result = baseResult(q);
      requireBench(!seen.has(result.id), "duplicate question ID"); seen.add(result.id);
      requireBench(runtimeAt(source.root).commit === source.commit, "runtime changed during benchmark");
      requireBench(harnessDigest() === HARNESS_AT_LOAD, "harness changed during benchmark");
      if (result.abstention) result.status = "abstention-excluded";
      else result = await executeQuestion(q, source, root, timeoutMs);
      requireBench(runtimeAt(source.root).commit === source.commit && harnessDigest() === HARNESS_AT_LOAD, "source or harness changed during question");
      results.push(result); appendFileSync(output + ".jsonl", JSON.stringify(result) + "\n", { mode: 0o600 });
      console.error(JSON.stringify({ event: "longmemeval-question", index: results.length, id: result.id, type: result.type, status: result.status,
        wallMs: Math.round(result.wallMs), workerPeakKB: result.workerPeakKB, mcpPeakKB: result.mcpPeakKB }));
      if (cancelled) { fatal = "benchmark interrupted"; break; }
      if (options.maxQuestions !== undefined && results.length >= options.maxQuestions) break;
    }
    complete = options.maxQuestions === undefined;
    const after = statSync(input);
    requireBench(initial.dev === after.dev && initial.ino === after.ino && initial.size === after.size && initial.mtimeMs === after.mtimeMs && initial.ctimeMs === after.ctimeMs, "dataset changed during benchmark");
  } catch (error) { fatal = code(error); }
  finally { process.removeListener("SIGINT", stopRun); process.removeListener("SIGTERM", stopRun); rmSync(root, { recursive: true, force: true }); }
  const report = { schema: "agent-mem.longmemeval/v2", variant: options.variant ?? "custom", dataset: { ...dataset, file: input }, runtime: source,
    harnessCommit: git(HERE, ["rev-parse", "HEAD"]).stdout.trim(), harnessSha256: HARNESS_AT_LOAD, definitions: { upstream: "xiaowu0162/LongMemEval@9e0b455f4ef0e2ab8f2e582289761153549043fc/src/retrieval/eval_utils.py", sessionRanking: "upstream turn2session effective_k widening; duplicate turns remain in DCG", ndcgAnyAt10: "upstream dcg: ranks 1 and 2 weight 1, full-corpus ideal at effective_k", MRR: "extra: first gold SID reciprocal raw turn rank among 50 returned turns", turnRecallAt10: "extra: fraction of has_answer turns in the first ten raw hits; turnIndex is cumulative per SID across repeated entries", failures: "failed paths contribute zero; no-turn-label averages are null", clock: "raw session timestamps, question-date UTC clock, retention covers haystack", workerPeakKB: "whole question worker (seed, library, BM25 and MCP controller); MCP child separate; null when incomplete/unavailable", wallMs: "input/seed/query/worker execution; cleanupMs is a separate reap barrier" }, platform: process.platform, bun: Bun.version, limit: LIMIT, questionTimeoutMs: timeoutMs,
    complete: complete && !fatal, ...(fatal ? { fatal } : {}), questions: results.length, upstreamNoUserTarget: results.filter(q => !q.abstention && q.upstreamNoUserTarget).length, duplicateSessionIds: results.reduce((sum, q) => sum + q.rows.duplicateSessionIds, 0), abstentions: results.filter(q => q.abstention).length,
    failed: results.filter(q => q.status === "failed" || q.status === "timeout" || q.status === "partial").map(q => ({ id: q.id, type: q.type, status: q.status, errors: q.errors })),
    wallMs: performance.now() - started, metrics: aggregateMetrics(results), results };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(output + ".md", markdownReport(report), { mode: 0o600 });
  console.log("LONGMEMEVAL_REPORT " + JSON.stringify(report));
  if (fatal === "benchmark interrupted") process.exitCode = 130;
  else if (fatal) throw Error(fatal);
  return report;
}
function args(values: readonly string[]): BenchmarkOptions {
  const parsed: Record<string, string> = {};
  const names = ["--input", "--output", "--source-root", "--question-timeout-ms", "--max-questions", "--variant"];
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i]!, value = values[i + 1];
    requireBench(names.includes(key) && value !== undefined && !Object.hasOwn(parsed, key), "invalid arguments");
    parsed[key] = value!;
  }
  requireBench(!!parsed["--input"] && !!parsed["--output"], "--input and --output are required");
  return { input: parsed["--input"]!, output: parsed["--output"]!, ...(parsed["--source-root"] ? { sourceRoot: parsed["--source-root"] } : {}),
    ...(parsed["--question-timeout-ms"] ? { questionTimeoutMs: Number(parsed["--question-timeout-ms"]) } : {}),
    ...(parsed["--max-questions"] ? { maxQuestions: Number(parsed["--max-questions"]) } : {}), ...(parsed["--variant"] ? { variant: parsed["--variant"] } : {}) };
}
if (import.meta.main) {
  const values = process.argv.slice(2);
  if (values[0] === "--worker") {
    const [, input, output, sourceRoot, expected, home, expectedHarness] = values;
    requireBench(!!input && !!output && !!sourceRoot && !!expected && !!home && expectedHarness === HARNESS_AT_LOAD, "invalid question worker arguments");
    const runtime = runtimeAt(sourceRoot!); requireBench(runtime.commit === expected, "question worker runtime changed");
    let result: QuestionRun | undefined;
    process.once("exit", () => { if (result) writeCheckpoint(output!, result, true); });
    result = await runQuestion(validateQuestion(JSON.parse(readFileSync(input!, "utf8"))), runtime, home!, value => writeCheckpoint(output!, value, false));
  } else if (values.length === 1 && values[0] === "--help") {
    console.log("bun scripts/longmemeval.ts --input FILE --output REPORT.json [--source-root MAIN_CHECKOUT] [--question-timeout-ms 30000] [--max-questions N] [--variant S|M]");
  } else await runLongMemEval(args(values));
}
