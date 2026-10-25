/** #13 frozen P2 R1/R3: a real stdio MCP session over a bounded synthetic project on macOS and Linux.
 * Instrumentation is confined to the child fixture; production handlers and transport are unchanged.
 */
import { spawn } from "node:child_process";
import { budgetGroup, BudgetStall } from "./budget-attempt.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MEMORY_SCHEMA, entryId, MemoryStore, type NoteEntry } from "../src/memory/store.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";

async function measureSession() {
const home = mkdtempSync(join(tmpdir(), "amem-mcp-budget-"));
const cwd = join(home, "project"), base = join(home, "memory"), reportPath = join(home, "rss.json");
const CURATED = 5001, CAPTURE = 5001, SEARCHES = 10, TIMELINES = 4, WORK_ROWS = 10001, WORK_ITEMS = 100;
const mb = (bytes: number) => Math.round(bytes / 1048576 * 100) / 100;
let child: ReturnType<typeof spawn> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let reaped: Promise<number | null> | undefined;
let timedOut = false, sessionStarted = 0;
let stalled: { pending: string | null; steps: string } | undefined;
try {
  mkdirSync(cwd);
  const project = memoryProjectKey(cwd);
  const start = Date.now() - (CURATED + 1) * 2000;
  const at = (index: number, capture = false) => new Date(start + index * 2000 + (capture ? 1000 : 0)).toISOString();
  const since = at(CURATED - 10), anchorIndex = Math.floor(CURATED / 2);
  let curatedAnchor = "", captureAnchor = "";
  const briefPath = "src/budget-writer.ts", briefExpected = new Map<string, "fail" | "decision">();
  const curated = new MemoryStore({ home });
  try {
    // Authentic hashed log replay avoids quadratic setup; migration and the measured child read the real index.
    const machine = curated.machine.id;
    let segment = "";
    for (let i = 0; i < CURATED; i++) {
      const briefKind = i >= CURATED - 3 ? "fail" : "decision", inBrief = i >= CURATED - 6;
      const body: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note", at: at(i), machine, project, scope: "project", tier: "long", kind: inBrief ? briefKind : "finding", peer: "budget", source: "person",
        text: `bounded retrieval storage engine mcpbudgetneedle variant ${i}`, about: inBrief ? [`path:${briefPath}`] : [] };
      const id = entryId(body); if (inBrief) briefExpected.set(`mem:${id}`, briefKind);
      if (i === anchorIndex) curatedAnchor = id;
      segment += JSON.stringify({ ...body, id }) + "\n";
    }
    writeFileSync(join(curated.dir, "log", `${machine}.jsonl`), segment, { mode: 0o600 });
    curated.rebuild();
    if (curated.list({ project, limit: CURATED + 1 }).length !== CURATED) throw new Error("curated seed incomplete");
  } finally { curated.close(); }
  await migrateShards({ memoryDir: base, mode: "apply", generation: "b".repeat(32), authorizedPerson: true, tty: true });
  const capture = new CaptureStore({ home, project });
  try {
    for (let i = 0; i < CAPTURE; i++) {
      const row = capture.append({ project, at: at(i, true), agent: "budget", event: "PostToolUse", tool: "Edit", paths: ["src/storage.ts"], status: "ok",
        excerpt: `mcpbudgetneedle mcpbudgetcaptureonly capture variant ${i} ${"bounded storage retrieval ".repeat(10)}` });
      if (!("id" in row)) throw new Error("capture seed unexpectedly spooled");
      if (i === anchorIndex) captureAnchor = `capture:${row.id}`;
    }
    if (capture.stats().rows !== CAPTURE) throw new Error("capture seed incomplete");
  } finally { capture.close(); }
  // Meaningful append history without quadratic setup through thousands of write()/refresh() calls.
  // Replay the synthetic hashed segment once; the measured child still opens and reads the real work-list store.
  const work = new WorkListStore({ base, project, policy: () => true });
  try {
    const machine = "c".repeat(16);
    let segment = "";
    for (let i = 0; i < WORK_ROWS; i++) {
      const body = { schema: "agent-mem.work-list/v1", project, machine, at: i, nonce: i.toString(16).padStart(32, "0"), list: "budget-work",
        fields: { task: `item-${i % WORK_ITEMS}`, status: "doing", progress: i, detail: `bounded synthetic work-list observation ${i} ${"storage retrieval budget ".repeat(8)}` } };
      segment += canonicalJSON({ ...body, id: hashJSON(body) }) + "\n";
    }
    writeFileSync(join(work.dir, "log", `${machine}.jsonl`), segment, { mode: 0o600 });
    work.rebuild();
  } finally { work.close(); }
  // Allowlist environment: no real-home state, inherited agent settings, credentials or network provider configuration.
  child = spawn(process.execPath, [join(import.meta.dir, "budget-mcp-child.ts"), cwd, base, reportPath], {
    cwd, env: { PATH: process.env.PATH ?? "", HOME: home, AMEM_HOME: base, TMPDIR: home }, stdio: ["pipe", "pipe", "pipe"],
  });
  const proc = child;
  let stderr = "", sequence = 0;
  let awaiting: { id: number; label: string; started: number; resolve: (value: any) => void; reject: (error: Error) => void } | undefined;
  // Per-request wall time, so a stall names the step it was waiting on.
  const steps: string[] = [];
  const stepValues = () => ({ pending: awaiting?.label ?? null, steps: steps.join(",") });
  proc.stderr!.on("data", data => { stderr = (stderr + String(data)).slice(-4096); });
  const lines = createInterface({ input: proc.stdout! });
  lines.on("line", line => {
    try {
      const value = JSON.parse(line);
      if (!awaiting || value.id !== awaiting.id || value.jsonrpc !== "2.0" || value.error) throw new Error(`unexpected MCP response: ${line.slice(0, 300)}`);
      const current = awaiting; awaiting = undefined; steps.push(`${current.label}:${Math.round(performance.now() - current.started)}`); current.resolve(value.result);
    } catch (error) { awaiting?.reject(error as Error); awaiting = undefined; proc.kill(); }
  });
  reaped = new Promise((resolve, reject) => {
    proc.once("error", error => { awaiting?.reject(error); reject(error); });
    proc.once("exit", code => { awaiting?.reject(new Error(`MCP exited before response (${code}): ${stderr}`)); resolve(code); });
  });
  sessionStarted = performance.now();
  deadline = setTimeout(() => { timedOut = true; stalled = stepValues(); awaiting?.reject(new BudgetStall("MCP budget session timed out", { elapsedMs: performance.now() - sessionStarted, limitMs: 30_000, ...stalled })); proc.kill("SIGKILL"); }, 30_000);
  const send = (message: unknown) => proc.stdin!.write(JSON.stringify(message) + "\n");
  const request = (method: string, params: unknown = {}, label = method) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; awaiting = { id, label, started: performance.now(), resolve, reject }; send({ jsonrpc: "2.0", id, method, params });
  });
  const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "amem-budget", version: "1" } });
  if (initialized.serverInfo?.name !== "amem") throw new Error("expected the amem MCP server");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const listing = await request("tools/list");
  const expectedTools = ["amem_brief", "amem_capacity", "amem_correct", "amem_evidence", "amem_graph", "amem_remember", "amem_search", "amem_show", "amem_timeline", "amem_vault_candidates", "amem_work_state_read", "amem_work_state_write"];
  if (listing.tools?.length !== 12 || JSON.stringify(listing.tools.map((tool: { name: string }) => tool.name).sort()) !== JSON.stringify(expectedTools)) throw new Error("frozen MCP tool surface missing");
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await request("tools/call", { name, arguments: args }, name);
    const text = result.content?.find((item: { type: string; text?: string }) => item.type === "text")?.text;
    if (result.isError || typeof text !== "string") throw new Error(`${name} failed: ${JSON.stringify(args)}`);
    return JSON.parse(text);
  };
  type Entry = { id: string; at: string; text: string; tier: string; project: string; source: "person" };
  type Capture = { id: number; at: string; excerpt: string; project: string };
  type Hit = { source: string; evidence: boolean; view?: Entry; capture?: Capture };
  const sourceRow = (hit: Hit) => {
    if (hit.source === "curated" && hit.evidence === true && hit.view?.tier === "long" && !hit.capture) return hit.view;
    if (hit.source === "capture" && hit.evidence === false && hit.capture && !hit.view) return hit.capture;
    throw new Error("retrieval tier/evidence contract changed");
  };
  for (let i = 0; i < SEARCHES; i++) {
    const variant = i % 5;
    const captureOnly = variant === 2 || variant === 4;
    const args = { query: captureOnly ? "mcpbudgetcaptureonly" : "mcpbudgetneedle", limit: 10, includeCapture: variant !== 0,
      ...(variant >= 3 ? { since } : {}) };
    const result = await call("amem_search", args) as { hits: Hit[] };
    if (result.hits.length !== 10) throw new Error("search did not fill its bounded result from the large corpus");
    for (const hit of result.hits) {
      const row = sourceRow(hit);
      if (row.project !== project || !("text" in row ? row.text : row.excerpt).includes(args.query) ||
          (variant === 0 && hit.source !== "curated") || (captureOnly && hit.source !== "capture") ||
          (args.since && Date.parse(row.at) < Date.parse(since))) throw new Error("search returned incorrect seeded evidence");
    }
  }
  const timelineCases = [{ limit: 10 }, { limit: 10, since }, { limit: 3, id: curatedAnchor }, { limit: 3, id: captureAnchor }];
  if (timelineCases.length !== TIMELINES) throw new Error("timeline case count mismatch");
  for (const args of timelineCases) {
    const result = await call("amem_timeline", args) as (Entry | Hit)[];
    const rows = result.map(item => {
      if (item.source === "capture") return sourceRow(item as Hit);
      if (item.source !== "person" || !("tier" in item) || item.tier !== "long" || !("text" in item)) throw new Error("timeline curated row did not preserve its raw person-authored view");
      return item as Entry;
    });
    if (rows.length !== args.limit || rows.some(row => row.project !== project || ("since" in args && Date.parse(row.at) < Date.parse(args.since!)))) throw new Error("timeline did not return bounded project rows");
    if ("id" in args) {
      const first = rows[0]!;
      const ref = typeof first.id === "number" ? `capture:${first.id}` : first.id;
      if (ref !== args.id) throw new Error("timeline failed to locate a middle-of-corpus anchor");
      const distance = (row: Entry | Capture) => Math.abs(Date.parse(row.at) - Date.parse(at(anchorIndex, args.id === captureAnchor)));
      if (rows.some((row, i) => i > 0 && distance(rows[i - 1]!) > distance(row))) throw new Error("anchor timeline is not ordered by distance");
    } else {
      if (!result.some(item => item.source === "capture") || !result.some(item => item.source === "person")) throw new Error("timeline lost a seeded tier");
      if (rows[0]?.at !== at(CAPTURE - 1, true) || rows.some((row, i) => i > 0 && rows[i - 1]!.at < row.at)) throw new Error("timeline is not newest first");
    }
  }
  const brief = await call("amem_brief", { intent: "bounded retrieval storage", paths: [briefPath], maxBytes: 2048 });
  // Six newest rows in the same-sized corpus exercise real fail-first rendering, not just the scan.
  if (brief.state !== "known" || typeof brief.brief !== "string" || !brief.brief.startsWith("Untrusted memory data") || brief.bytes !== Buffer.byteLength(brief.brief) || brief.bytes > 2048 || typeof brief.truncated !== "boolean") throw new Error("intent brief lost its bounded render contract");
  const briefRows = brief.brief.split("\n").slice(1).map((line: string) => JSON.parse(line)) as { id: string; kind: string; text: string }[];
  if (briefRows.length !== briefExpected.size || new Set(briefRows.map(row => row.id)).size !== briefExpected.size
    || briefRows.some((row, index) => briefExpected.get(row.id) !== row.kind || row.kind !== (index < 3 ? "fail" : "decision") || typeof row.text !== "string" || !row.text.includes("mcpbudgetneedle"))) throw new Error("intent brief did not render all seeded fails before decisions");
  const evidence = await call("amem_evidence", { question: "bounded retrieval storage", limit: 6, maxBytes: 4096 });
  if (evidence.schema !== "amem.evidence/v1" || evidence.state !== "known" || !Array.isArray(evidence.entries) || !evidence.entries.length || Buffer.byteLength(JSON.stringify(evidence)) > 4096
    || evidence.entries.some((row: { citation: string; text: string }) => !/^mem:[a-f0-9]{32}$/.test(row.citation) || !row.text.includes("mcpbudgetneedle"))) throw Error("evidence lost its cited bounded render contract");
  for (const args of [{ includeClosed: true }, { list: "budget-work", includeClosed: true }]) {
    const result = await request("tools/call", { name: "amem_work_state_read", arguments: args }, "amem_work_state_read");
    const text = result.content?.find((item: { type: string; text?: string }) => item.type === "text")?.text;
    if (result.isError || typeof text !== "string") throw new Error("work-list MCP read failed");
    const lists = JSON.parse(text) as { list: string; items: { task: string; fields: { progress: number } }[] }[];
    if (lists.length !== 1 || lists[0]?.list !== "budget-work" || lists[0].items.length !== WORK_ITEMS || !lists[0].items.some(item => item.fields.progress === WORK_ROWS - 1)) throw new Error("work-list MCP read did not reduce the complete seeded history");
    const seen = new Set<string>();
    for (const item of lists[0].items) {
      const index = Number(item.task.slice("item-".length));
      const latest = index + Math.floor((WORK_ROWS - 1 - index) / WORK_ITEMS) * WORK_ITEMS;
      if (!Number.isInteger(index) || index < 0 || index >= WORK_ITEMS || item.task !== `item-${index}` || seen.has(item.task) || item.fields.progress !== latest) throw new Error("work-list MCP read lost a per-item latest update");
      seen.add(item.task);
    }
  }
  proc.stdin!.end(); // The stdio session's EOF, not a shutdown RPC or a kill, must close and reap the child.
  const exitCode = await reaped;
  clearTimeout(deadline);
  if (exitCode !== 0) throw new Error(`MCP EOF exit ${exitCode}: ${stderr}`);
  let remains = true;
  try { process.kill(proc.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") remains = false; else throw error; }
  const measured = JSON.parse(readFileSync(reportPath, "utf8")) as { idleBytes: number; maxRSS: number; searches: number; timelines: number; workReads: number; briefReads: number; evidenceReads: number };
  const idleRssMB = mb(measured.idleBytes), peakRssMB = mb(measured.maxRSS * 1024);
  const pass = measured.idleBytes > 0 && measured.maxRSS > 0 && measured.idleBytes < 100 * 1048576 && measured.maxRSS < 200 * 1024 && measured.searches === SEARCHES && measured.timelines === TIMELINES && measured.workReads === 2 && measured.briefReads === 1 && measured.evidenceReads === 1 && !remains;
  const sessionMs = performance.now() - sessionStarted;
  const report = { platform: process.platform, bun: Bun.version, transport: "stdio", sessionMs: Math.round(sessionMs), wallTimingPass: sessionMs < 30_000, steps, corpus: { curated: CURATED, capture: CAPTURE, workRows: WORK_ROWS, workItems: WORK_ITEMS },
    R1: { pass: !remains, eofExitCode: exitCode, childReaped: !remains },
    R3: { pass: measured.idleBytes > 0 && measured.maxRSS > 0 && measured.idleBytes < 100 * 1048576 && measured.maxRSS < 200 * 1024, idleRssMB, peakRssMB, searches: measured.searches, timelines: measured.timelines, workReads: measured.workReads, briefReads: measured.briefReads, evidenceReads: measured.evidenceReads, evidenceRendered: evidence.entries.length, briefRendered: briefRows.length, briefBytes: brief.bytes, budgetIdleMB: 100, budgetPeakMB: 200 }, pass };
  if (!pass) throw new Error("MCP memory or EOF budget failed");
  return report;
} catch (error) {
  if (timedOut) throw new BudgetStall("MCP budget session timed out", { elapsedMs: performance.now() - sessionStarted, limitMs: 30_000, ...stalled });
  throw error;
} finally {
  if (deadline) clearTimeout(deadline);
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await reaped?.catch(() => {});
  // A timed-out attempt owns its child through the reap barrier before another session can start.
  if (child?.pid) {
    let alive = true; try { process.kill(child.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
    if (alive) throw new Error("MCP owned child survived cleanup; refusing retry");
  }
  rmSync(home, { recursive: true, force: true });
}

}
// #48: a single watchdog stall retries even at normal speed; this is the only MCP retry layer.
const measured = await budgetGroup("mcp-session", measureSession, report => ({ wallPass: report.wallTimingPass, rssPass: report.R3.pass }), { retryPolicy: "stall" });

console.log(JSON.stringify({ ...measured.result, groupAttempts: measured.attempts }, null, 2));
