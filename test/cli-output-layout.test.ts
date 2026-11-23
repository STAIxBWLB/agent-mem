import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rawMemoryCommand } from "../src/memory/commands.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { ingestText } from "../src/cli.ts";
import { capacityApplyText } from "../src/memory/capacity.ts";
import { memoryTableText, PLAIN } from "../src/memory/style.ts";
import { isAmemCommand } from "../src/commands-table.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("index runtime exports and host API match main 7cb641fc", async () => {
  const api = await import("../src/index.ts"), names = Object.keys(api).sort();
  expect(api.HOST_API_VERSION).toBe(1); expect(names).toHaveLength(369);
  expect(createHash("sha256").update(JSON.stringify(names)).digest("hex")).toBe("9a984261120a3c938c0ea2ee95dcce31e68111afd55fe375634d3ec5f9fc95f0");
});

test("80-column ASCII goldens preserve wide-text clipping and one retrieval hint", () => {
  const rows = [{ id: "a".repeat(32), kind: "preference", tier: "long", peer: "writer", scope: "shared", at: "2026-01-01T00:00:00Z", text: "한글 설명 " + "긴내용".repeat(15), flags: ["stale: missing", "+1 same task"] }];
  const output = memoryTableText(rows, "Memory", { columns: 80, style: PLAIN, now: Date.parse("2026-01-03T00:00:00Z") });
  expect(output).toBe([" amem Memory", "", "> Entries (1)", "  ID             KIND        TIER    PEER      WHEN        TEXT", "  aaaaaaaaaaaaa  preference  long*   writer    2 d ago     한글 설명 긴내용긴...", `${" ".repeat(59)}stale: missing`, `${" ".repeat(59)}+1 same task`, "  * marks shared scope.", "  Full text: amem show <id> or --json."].join("\n"));
  expect(output.split("\n").every(line => Bun.stringWidth(line, { ambiguousIsNarrow: true }) <= 80)).toBe(true);
  expect(output.match(/amem show <id>/g)).toHaveLength(1);
});

test("80-column ASCII goldens for ingest and capacity preview", () => {
  const ingest = ingestText("codex", { files: 2, read: 3, imported: 2, skipped: 1, spooled: 0, remaining: false, errors: 0 }, PLAIN, 80);
  expect(ingest).toBe([" amem Ingest codex", "", "> Receipt", "  ok Ingest completed.", "  State:      complete", "  Files:      2", "  Read:       3", "  Imported:   2", "  Skipped:    1", "  Spooled:    0", "  Errors:     0", "  Remaining:  no", "", "Summary: 2 imported, 1 skipped, 0 errors"].join("\n"));
  const next = "amem capacity apply --cap-mb 256 --retention-days 30 --confirm";
  const capacity = capacityApplyText({ preview: { file: "/tmp/config", current: { capMb: 512, retentionDays: 90 }, target: { capMb: 256, retentionDays: 30 }, reason: "fixture" } }, PLAIN, { columns: 80, next });
  expect(capacity).toBe([" amem Capacity apply", "", "> Preview", "  ~  Capacity settings are ready for review.", "  File:      /tmp/config", "  Current:   512 MiB, 90 days", "  Proposed:  256 MiB, 30 days", "  Reason:    fixture", `    -> ${next}`].join("\n"));
  expect(isAmemCommand(next)).toBe(true);
});

test("host recall without render retains the main 7cb641fc text bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-host-output-parity-")); roots.push(root);
  const memory = join(root, "memory"), project = "github.com/example/amem-parity";
  cpSync(join(import.meta.dir, "fixtures", "parity", "memory"), memory, { recursive: true });
  const options = { project, open: () => new MemoryStore({ memoryDir: memory, deferPromotions: true }), readable: <T>(rows: T[]) => rows, importPolicy: () => () => false };
  const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "cli-output-main-7cb641fc", "host.json"), "utf8")) as Record<string, string>;
  expect(await rawMemoryCommand(["list"], root, options)).toBe(golden.list!);
  expect(await rawMemoryCommand(["search", "contract"], root, options)).toBe(golden.search!);
  expect(await rawMemoryCommand(["show", "26a604d279d68185bbbf4159f60e7dc6"], root, options)).toBe(golden.show!);
});

test("every MCP tool returns the main 7cb641fc result text", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-mcp-output-parity-")); roots.push(root);
  const program = join(root, "compare.ts"), fixture = join(import.meta.dir, "fixtures", "parity", "memory");
  const current = join(import.meta.dir, "../src/mcp-memory.ts"), transport = join(import.meta.dir, "../src/mcp.ts");
  const capacity = join(import.meta.dir, "../src/memory/capacity.ts");
  // The child process confines clock, entropy and system-reading substitutions to this test.
  writeFileSync(program, `
import { mock, setSystemTime } from "bun:test";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
setSystemTime(new Date("2026-11-23T00:00:00.000Z"));
const crypto = await import("node:crypto");
mock.module("node:crypto", () => ({ ...crypto, randomBytes: (size: number) => Buffer.alloc(size, 7) }));
const os = await import("node:os");
mock.module("node:os", () => ({ ...os, totalmem: () => 68719476736 }));
const originalCapacity = await import(${JSON.stringify(capacity)});
const capacityReport = originalCapacity.capacityReport;
mock.module(${JSON.stringify(capacity)}, () => ({ ...originalCapacity, capacityReport: (options: Record<string, unknown>) => capacityReport({ ...options, inject: { disk: { freeBytes: 900000000, totalBytes: 1000000000 }, memoryPressure: "fixture", metrics: [] } }) }));
const { createMemoryMcp: current } = await import(${JSON.stringify(current)});
const { serveMcp } = await import(${JSON.stringify(transport)});
const root = ${JSON.stringify(root)}, fixture = ${JSON.stringify(fixture)}, project = "github.com/example/amem-parity";
const id = "26a604d279d68185bbbf4159f60e7dc6";
const cases = [
  ["amem_search", { query: "contract", includeCapture: false }],
  ["amem_evidence", { question: "contract" }],
  ["amem_show", { id }],
  ["amem_timeline", { limit: 10 }],
  ["amem_brief", { intent: "contract" }],
  ["amem_graph", { start: id }],
  ["amem_work_state_read", { list: "queue" }],
  ["amem_work_state_write", { list: "queue", fields: { task: "fixture", status: "doing" } }],
  ["amem_remember", { text: "fixture candidate", kind: "finding" }],
  ["amem_correct", { id, proposedText: "corrected fixture", reason: "fixture reason" }],
  ["amem_vault_candidates", { limit: 10 }],
  ["amem_capacity", {}],
] as const;
async function call(factory: typeof current, base: string, name: string, args: Record<string, unknown>) {
  cpSync(fixture, base, { recursive: true });
  const mcp = factory({ cwd: root, base, project });
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "parity", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ];
  let output = "";
  await serveMcp({ input: Readable.from(frames.map(frame => JSON.stringify(frame) + "\\n")), output: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }), tools: mcp.tools, close: () => mcp.close() });
  const response = JSON.parse(output.trim().split("\\n").at(-1)!);
  if (response.result?.isError || typeof response.result?.content?.[0]?.text !== "string") throw Error(name + " did not return a successful text result");
  return response.result.content[0].text as string;
}
mkdirSync(join(root, "runs"));
const results = [];
for (const [name, args] of cases) results.push({ name, current: await call(current, join(root, "runs", name + "-current"), name, args) });
console.log(JSON.stringify(results));
`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, AMEM_HOME: join(root, "unused-memory"), AGENTHUB_HOME: join(root, "unused-hub") };
  for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]) delete env[key];
  const child = Bun.spawnSync([process.execPath, program], { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const results = JSON.parse(child.stdout.toString()) as { name: string; current: string }[];
  expect(results.map(row => row.name)).toEqual(["amem_search", "amem_evidence", "amem_show", "amem_timeline", "amem_brief", "amem_graph", "amem_work_state_read", "amem_work_state_write", "amem_remember", "amem_correct", "amem_vault_candidates", "amem_capacity"]);
  const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "cli-output-main-7cb641fc", "mcp.json"), "utf8")) as Record<string, string>;
  for (const result of results) expect(result.current, result.name).toBe(golden[result.name]!);
}, 70_000);
