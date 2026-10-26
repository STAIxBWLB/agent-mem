import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { memoryGitEnv, memoryGitSync } from "../src/memory/platform.ts";
import { ftsTerms } from "../src/memory/search-fts.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { MCP_VOLUME_EXCERPT_BYTES, MCP_VOLUME_ROWS, featureMasks, mcpVolumeRow } from "../test/fakes/mcp-volume-fixture.ts";
import { BudgetStall } from "./budget-attempt.ts";

const WATCHDOG_MS = 30_000, PEAK_KB = 200 * 1024, QUERY = "rankneedle exactanchor preciseanchor", OUTPUT_BYTES = 2 * 1024 * 1024;
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const requireVolume = (condition: unknown, message: string): void => { if (!condition) throw Error(`MCP volume budget: ${message}`); };
const mib = (kb: number) => Math.round(kb / 1024 * 100) / 100;

/** Protocol guards are pure so malformed/fallback responses cannot produce a green RSS receipt. */
export function assertMcpVolumeReply(value: unknown, id: number): Record<string, any> {
  requireVolume(object(value) && value.jsonrpc === "2.0" && value.id === id && value.error === undefined && object(value.result), "unexpected JSON-RPC response");
  return (value as Record<string, any>).result;
}
export function assertMcpVolumeSearch(value: unknown, project: string): { engine: "fts5"; first: number; hits: number } {
  requireVolume(object(value) && value.engine === "fts5" && Array.isArray(value.hits) && value.hits.length === 10, "broad search must use FTS5 and return ten hits");
  const result = value as Record<string, any>, ids = new Set<number>();
  for (const hit of result.hits) {
    const row = hit?.capture;
    requireVolume(hit?.source === "capture" && hit.evidence === false && hit.view === undefined && object(row)
      && Number.isSafeInteger(row.id) && row.id > 0 && row.id <= MCP_VOLUME_ROWS && !ids.has(row.id)
      && row.project === project && typeof row.at === "string" && Number.isFinite(Date.parse(row.at))
      && typeof row.excerpt === "string" && row.excerpt.includes("rankneedle") && Buffer.byteLength(row.excerpt) === MCP_VOLUME_EXCERPT_BYTES,
    "search lost its seeded project, capture evidence, identity or excerpt contract");
    ids.add(row.id);
  }
  const first = result.hits[0].capture;
  requireVolume(first.id === MCP_VOLUME_ROWS && first.excerpt.includes("exactanchor") && first.excerpt.includes("preciseanchor"), "oldest best match missing");
  return { engine: "fts5", first: first.id, hits: result.hits.length };
}

export interface McpVolumeReport {
  platform: string; bun: string; runtimeMode: "--smol"; transport: "stdio"; entry: "bin/amem.js";
  sessionMs: number; queryMs: number; wallTimingPass: boolean;
  corpus: { capture: number; excerptBytes: number; matchingRows: number; logicalBytes: number; seedDatabaseBytes: number; databaseBytes: number; vocabulary: number; tokens: number; averageChars: number; averageBytes: number; tempFreeBytes?: number };
  engine: "fts5"; first: number; hits: number;
  R1: { pass: boolean; eofExitCode: number; childReaped: boolean };
  R3: { pass: boolean; idleMeasured: false; peakRssMB: number; selfPeakKB: number; darwinWait4KB: number | null; peakKB: number; budgetPeakMB: 200 };
  pass: boolean;
}

/** One attempt only: the caller owns the existing budgetGroup single-stall retry layer. */
export async function measureMcpVolume(): Promise<McpVolumeReport> {
  const home = mkdtempSync(join(tmpdir(), "amem-mcp-volume-")), cwd = join(home, "project"), base = join(home, "memory"), reportPath = join(home, "rss.json");
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let cancelOutput: (() => Promise<void>) | undefined, cancelErrors: (() => Promise<void>) | undefined, stderr: Promise<string> | undefined;
  let timedOut = false, sessionStarted = 0, pending = "fixture";
  try {
    mkdirSync(cwd, { mode: 0o700 }); mkdirSync(join(home, "tmp"), { mode: 0o700 });
    const env = { PATH: process.env.PATH ?? "", HOME: home, AMEM_HOME: base, TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
    const git = memoryGitSync(["-C", cwd, "init", "-q"], { env: memoryGitEnv(env, { repositoryIsolation: true }), encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
    requireVolume(git.status === 0 && !git.error, "private Git fixture unavailable");
    const project = memoryProjectKey(cwd, { repositoryIsolation: true,
      gitRead: args => memoryGitSync(args, { env: memoryGitEnv(env, { repositoryIsolation: true }), encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 }) });
    const store = new MemoryStore({ home, deferPromotions: true }); store.close();
    let tempFreeBytes: number | undefined;
    try { const disk = statfsSync(home); tempFreeBytes = disk.bavail * disk.bsize; } catch { /* Optional disk diagnostic, never proof of resource health. */ }
    const capture = new CaptureStore({ home, project, cwd });
    const databaseFile = join(capture.dir, "capture.db"); let logicalBytes = 0, matchingRows = 0;
    try {
      const db = (capture as unknown as { db: Database }).db, masks = featureMasks(MCP_VOLUME_ROWS);
      const put = db.query("INSERT INTO rows(at,project,agent,event,tool,paths,status,excerpt,bytes) VALUES (?,?,'fixture','Quiet',NULL,?,NULL,?,?)");
      const now = Date.now(), old = new Date(now - 86400_000).toISOString(), recent = new Date(now - 1000).toISOString();
      // The native schema and FTS triggers are real; only fixture setup avoids per-row fsync/eviction.
      db.transaction(() => {
        for (let i = 0; i < MCP_VOLUME_ROWS; i++) {
          const row = mcpVolumeRow(i, masks[i]!, MCP_VOLUME_ROWS - 1), paths = JSON.stringify(row.paths);
          requireVolume(Buffer.byteLength(row.excerpt) === MCP_VOLUME_EXCERPT_BYTES, "fixture byte calibration drifted");
          const bytes = Buffer.byteLength(row.excerpt) + Buffer.byteLength(paths) + 96; logicalBytes += bytes;
          put.run(i === MCP_VOLUME_ROWS - 1 ? old : recent, project, paths, row.excerpt, bytes);
        }
        db.query("INSERT INTO meta(key,value) VALUES ('bytes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(logicalBytes));
      })();
      const stats = capture.stats(); requireVolume(stats.rows === MCP_VOLUME_ROWS && stats.bytes === logicalBytes, "capture fixture or byte metadata incomplete");
      const stored = db.query("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM rows").get() as { n: number; bytes: number };
      requireVolume(stored.n === MCP_VOLUME_ROWS && stored.bytes === logicalBytes, "capture row byte totals disagree with metadata");
      matchingRows = (db.query("SELECT COUNT(*) AS n FROM fts WHERE fts MATCH ?").get(ftsTerms(QUERY)) as { n: number }).n;
      requireVolume(matchingRows === MCP_VOLUME_ROWS, "query does not match the entire calibrated corpus");
      // Do not call readPage here: the child's first query must exercise cold MCP FTS setup.
    } finally { capture.close(); }
    const databaseSize = () => ["", "-wal", "-shm"].reduce((total, suffix) => { try { return total + statSync(databaseFile + suffix).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return total; throw error; } }, 0);
    const seedDatabaseBytes = databaseSize();
    const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    requireVolume(typeof version === "string", "package version unavailable");
    const preload = join(home, "rss-exit.ts"), rssHelper = fileURLToPath(new URL("./budget-rss.ts", import.meta.url));
    writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';import {peakRssKB} from ${JSON.stringify(rssHelper)};
if(!process.execArgv.includes('--smol'))throw Error('volume child runtime mismatch');
process.once('exit',code=>{if(process.platform==='linux'&&!/VmHWM:\\s*(\\d+)\\s*kB/.test(readFileSync('/proc/self/status','utf8')))throw Error('volume self VmHWM unavailable');writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({runtimeMode:'--smol',bun:Bun.version,selfPeakKB:peakRssKB(),exitCode:code}),{mode:0o600});});\n`, { mode: 0o600 });
    sessionStarted = performance.now(); pending = "initialize";
    child = Bun.spawn([process.execPath, "--smol", "--preload", preload, fileURLToPath(new URL("../bin/amem.js", import.meta.url)), "mcp"], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const proc = child;
    const errorStream = proc.stderr.getReader(); cancelErrors = () => errorStream.cancel();
    stderr = (async () => { const stream = errorStream, decoder = new TextDecoder(); let tail = ""; try { for (;;) { const chunk = await stream.read(); if (chunk.done) return tail; tail = (tail + decoder.decode(chunk.value, { stream: true })).slice(-4096); } } catch { return tail; } finally { stream.releaseLock(); } })();
    const output = proc.stdout.getReader(); cancelOutput = async () => { try { await output.cancel(); } finally { output.releaseLock(); } };
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); let buffer = "", outputBytes = 0;
    let expire!: (error: BudgetStall) => void;
    const expired = new Promise<never>((_resolve, reject) => { expire = reject; });
    timer = setTimeout(() => { timedOut = true; try { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); } catch { /* The reap barrier below still owns cleanup. */ } expire(new BudgetStall("MCP volume session timed out", { elapsedMs: performance.now() - sessionStarted, limitMs: WATCHDOG_MS, pending })); }, Math.max(0, WATCHDOG_MS - (performance.now() - sessionStarted)));
    const next = async (id: number) => {
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); requireVolume(!!line.trim(), "empty protocol frame"); return assertMcpVolumeReply(JSON.parse(line), id); }
        const chunk = await output.read(); requireVolume(!chunk.done, "EOF before expected response");
        outputBytes += chunk.value!.byteLength; requireVolume(outputBytes <= OUTPUT_BYTES, "protocol output bound exceeded");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    let sequence = 0;
    const request = async (method: string, params: unknown, label: string) => {
      pending = label; const id = ++sequence;
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); proc.stdin.flush();
      return await Promise.race([next(id), expired]);
    };
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "amem-volume-budget", version: "1" } }, "initialize");
    requireVolume(initialized.protocolVersion === "2025-06-18" && object(initialized.capabilities?.tools)
      && initialized.serverInfo?.name === "amem" && initialized.serverInfo.version === version, "wrong MCP protocol or server identity/version");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); proc.stdin.flush();
    const listing = await request("tools/list", {}, "tools/list");
    requireVolume(Array.isArray(listing.tools) && listing.tools.some((tool: any) => tool.name === "amem_search")
      && listing.tools.every((tool: any) => typeof tool.name === "string" && typeof tool.description === "string" && object(tool.inputSchema)), "invalid rendered tool inventory");
    // ponytail: one cold broad query fits the unchanged watchdog; the frozen small session
    // covers repeated tool calls. Extend this volume sequence only with measured headroom.
    const queryStarted = performance.now();
    const called = await request("tools/call", { name: "amem_search", arguments: { query: QUERY, limit: 10 } }, "amem_search");
    const queryMs = performance.now() - queryStarted;
    const content = called.content?.find((item: any) => item.type === "text" && typeof item.text === "string");
    requireVolume(called.isError !== true && !!content, "search tool failed");
    const found = assertMcpVolumeSearch(JSON.parse(content.text), project);
    pending = "EOF"; proc.stdin.end();
    const drained = (async () => {
      requireVolume(!buffer.trim(), "unexpected extra protocol frame");
      for (;;) {
        const chunk = await output.read();
        if (chunk.done) { requireVolume(!decoder.decode().trim(), "incomplete trailing protocol bytes"); return; }
        outputBytes += chunk.value.byteLength; requireVolume(outputBytes <= OUTPUT_BYTES, "protocol output bound exceeded");
        requireVolume(!decoder.decode(chunk.value, { stream: true }).trim(), "unexpected extra protocol output");
      }
    })();
    const [exitCode] = await Promise.race([Promise.all([proc.exited, drained]), expired]);
    clearTimeout(timer); timer = undefined;
    requireVolume(exitCode === 0, "MCP did not exit normally on EOF");
    const sessionMs = performance.now() - sessionStarted;
    if (sessionMs >= WATCHDOG_MS) throw new BudgetStall("MCP volume session timed out", { elapsedMs: sessionMs, limitMs: WATCHDOG_MS, pending });
    let remains = true; try { process.kill(proc.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") remains = false; else throw error; }
    requireVolume(!remains, "owned MCP child remains after EOF");
    const measured = JSON.parse(readFileSync(reportPath, "utf8"));
    requireVolume(measured.runtimeMode === "--smol" && measured.bun === Bun.version && measured.exitCode === 0 && Number.isFinite(measured.selfPeakKB) && measured.selfPeakKB > 0, "missing or invalid exit RSS receipt");
    // Bun child wait4 maxRSS is bytes. On newer macOS Bun, self maxRSS instead reports physical footprint.
    const darwinWait4KB = process.platform === "darwin" ? (proc.resourceUsage()?.maxRSS ?? 0) / 1024 : null;
    requireVolume(darwinWait4KB === null || Number.isFinite(darwinWait4KB) && darwinWait4KB > 0, "Darwin wait4 RSS unavailable");
    const peakKB = darwinWait4KB === null ? measured.selfPeakKB : Math.max(measured.selfPeakKB, darwinWait4KB);
    // Aggregate validation is in the parent after the measured child is reaped; no text is printed.
    const metadata = new Database(databaseFile, { readonly: true });
    let vocabulary: number, tokens: number, averageChars: number, averageBytes: number;
    try {
      metadata.run("CREATE VIRTUAL TABLE temp.volume_terms USING fts5vocab(main,mcp_fts,'row')");
      const stats = metadata.query("SELECT COUNT(*) AS terms,SUM(cnt) AS tokens FROM volume_terms").get() as { terms: number; tokens: number };
      const density = metadata.query("SELECT AVG(length(excerpt)) AS chars,AVG(length(CAST(excerpt AS BLOB))) AS bytes FROM rows").get() as { chars: number; bytes: number };
      vocabulary = stats.terms; tokens = stats.tokens; averageChars = density.chars; averageBytes = density.bytes;
      requireVolume(vocabulary >= 90_000 && vocabulary <= 100_000 && tokens / MCP_VOLUME_ROWS >= 180 && tokens / MCP_VOLUME_ROWS <= 190, "fixture vocabulary/token calibration drifted");
      requireVolume(averageBytes === MCP_VOLUME_EXCERPT_BYTES && averageChars >= 1130 && averageChars <= 1140, "fixture character density drifted");
    } finally { metadata.close(); }
    const databaseBytes = databaseSize();
    const report: McpVolumeReport = { platform: process.platform, bun: Bun.version, runtimeMode: "--smol", transport: "stdio", entry: "bin/amem.js", sessionMs: Math.round(sessionMs), queryMs: Math.round(queryMs), wallTimingPass: true,
      corpus: { capture: MCP_VOLUME_ROWS, excerptBytes: MCP_VOLUME_EXCERPT_BYTES, matchingRows, logicalBytes, seedDatabaseBytes, databaseBytes, vocabulary, tokens, averageChars, averageBytes, ...(tempFreeBytes === undefined ? {} : { tempFreeBytes }) }, ...found,
      R1: { pass: !remains, eofExitCode: exitCode, childReaped: true },
      R3: { pass: peakKB < PEAK_KB, idleMeasured: false, peakRssMB: mib(peakKB), selfPeakKB: measured.selfPeakKB, darwinWait4KB, peakKB, budgetPeakMB: 200 }, pass: peakKB < PEAK_KB };
    if (!report.pass) { console.error(JSON.stringify({ diagnostic: "mcp-volume-budget-failure", ...report })); throw Error("MCP volume peak RSS budget failed"); }
    return report;
  } catch (error) {
    if (timedOut) throw new BudgetStall("MCP volume session timed out", { elapsedMs: performance.now() - sessionStarted, limitMs: WATCHDOG_MS, pending });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      if (child && child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* Reap and identity checks below decide cleanup success. */ } }
      if (child) await child.exited;
      try { await cancelOutput?.(); } catch { /* Already closed after normal EOF. */ }
      try { await cancelErrors?.(); } catch { /* Already closed after normal EOF. */ }
      await stderr?.catch(() => "");
      if (child?.pid) {
        let alive = true; try { process.kill(child.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
        if (alive) throw Error("MCP volume owned child survived cleanup; refusing retry");
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
}

if (import.meta.main) console.log(JSON.stringify(await measureMcpVolume(), null, 2));
