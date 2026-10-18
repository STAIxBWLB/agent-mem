/** #13 frozen P2 R1/R3: a real stdio MCP session over a bounded synthetic project on macOS and Linux.
 * Instrumentation is confined to the child fixture; production handlers and transport are unchanged.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";

const home = mkdtempSync(join(tmpdir(), "amem-mcp-budget-"));
const cwd = join(home, "project"), base = join(home, "memory"), reportPath = join(home, "rss.json");
const CURATED = 200, CAPTURE = 2000, SEARCHES = 10;
const mb = (bytes: number) => Math.round(bytes / 1048576 * 100) / 100;
let child: ReturnType<typeof spawn> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let reaped: Promise<number | null> | undefined;
try {
  mkdirSync(cwd);
  const project = memoryProjectKey(cwd);
  const curated = new MemoryStore({ home });
  try {
    for (let i = 0; i < CURATED; i++) curated.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "budget", source: "person",
      text: `bounded retrieval storage engine mcpbudgetneedle variant ${i}`, about: [] });
  } finally { curated.close(); }
  await migrateShards({ memoryDir: base, mode: "apply", generation: "b".repeat(32), authorizedPerson: true, tty: true });
  const capture = new CaptureStore({ home, project });
  try {
    for (let i = 0; i < CAPTURE; i++) capture.append({ project, agent: "budget", event: "PostToolUse", tool: "Edit", paths: ["src/storage.ts"], status: "ok",
      excerpt: `mcpbudgetneedle capture variant ${i} ${"bounded storage retrieval ".repeat(10)}` });
  } finally { capture.close(); }
  // Allowlist environment: no real-home state, inherited agent settings, credentials or network provider configuration.
  child = spawn(process.execPath, [join(import.meta.dir, "budget-mcp-child.ts"), cwd, base, reportPath], {
    cwd, env: { PATH: process.env.PATH ?? "", HOME: home, AMEM_HOME: base, TMPDIR: home }, stdio: ["pipe", "pipe", "pipe"],
  });
  const proc = child;
  let stderr = "", sequence = 0;
  let awaiting: { id: number; resolve: (value: any) => void; reject: (error: Error) => void } | undefined;
  proc.stderr!.on("data", data => { stderr = (stderr + String(data)).slice(-4096); });
  const lines = createInterface({ input: proc.stdout! });
  lines.on("line", line => {
    try {
      const value = JSON.parse(line);
      if (!awaiting || value.id !== awaiting.id || value.jsonrpc !== "2.0" || value.error) throw new Error(`unexpected MCP response: ${line.slice(0, 300)}`);
      const current = awaiting; awaiting = undefined; current.resolve(value.result);
    } catch (error) { awaiting?.reject(error as Error); awaiting = undefined; proc.kill(); }
  });
  reaped = new Promise((resolve, reject) => {
    proc.once("error", error => { awaiting?.reject(error); reject(error); });
    proc.once("exit", code => { awaiting?.reject(new Error(`MCP exited before response (${code}): ${stderr}`)); resolve(code); });
  });
  deadline = setTimeout(() => { awaiting?.reject(new Error("MCP budget session timed out")); proc.kill("SIGKILL"); }, 30_000);
  const send = (message: unknown) => proc.stdin!.write(JSON.stringify(message) + "\n");
  const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; awaiting = { id, resolve, reject }; send({ jsonrpc: "2.0", id, method, params });
  });
  const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "amem-budget", version: "1" } });
  if (initialized.serverInfo?.name !== "amem") throw new Error("expected the amem MCP server");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const listing = await request("tools/list");
  if (listing.tools?.length !== 9 || !listing.tools.some((tool: { name: string }) => tool.name === "amem_search")) throw new Error("frozen MCP tool surface missing");
  for (let i = 0; i < SEARCHES; i++) {
    const result = await request("tools/call", { name: "amem_search", arguments: { query: "mcpbudgetneedle", limit: 10, includeCapture: true } });
    if (result.isError || !result.content?.some((item: { type: string; text?: string }) => item.type === "text" && item.text?.includes("mcpbudgetneedle"))) throw new Error("search did not return seeded MCP evidence");
  }
  proc.stdin!.end(); // The stdio session's EOF, not a shutdown RPC or a kill, must close and reap the child.
  const exitCode = await reaped;
  clearTimeout(deadline);
  if (exitCode !== 0) throw new Error(`MCP EOF exit ${exitCode}: ${stderr}`);
  let remains = true;
  try { process.kill(proc.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") remains = false; else throw error; }
  const measured = JSON.parse(readFileSync(reportPath, "utf8")) as { idleBytes: number; maxRSS: number; searches: number };
  const idleRssMB = mb(measured.idleBytes), peakRssMB = mb(measured.maxRSS * 1024);
  const pass = measured.idleBytes > 0 && measured.maxRSS > 0 && measured.idleBytes < 100 * 1048576 && measured.maxRSS < 200 * 1024 && measured.searches === SEARCHES && !remains;
  console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, transport: "stdio", corpus: { curated: CURATED, capture: CAPTURE },
    R1: { pass: !remains, eofExitCode: exitCode, childReaped: !remains },
    R3: { pass: measured.idleBytes > 0 && measured.maxRSS > 0 && measured.idleBytes < 100 * 1048576 && measured.maxRSS < 200 * 1024, idleRssMB, peakRssMB, searches: measured.searches, budgetIdleMB: 100, budgetPeakMB: 200 }, pass }, null, 2));
  if (!pass) process.exitCode = 1;
} finally {
  if (deadline) clearTimeout(deadline);
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await reaped?.catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
