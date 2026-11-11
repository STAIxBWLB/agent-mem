import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as spool from "../src/hook-spool.ts";
import { ingestTranscript, type IngestKind } from "../src/ingest.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { hookFixture, hookBin } from "./fakes/hooks-fixture.ts";

const clean: (() => void)[] = [], original = { ...process.env };
afterEach(() => { for (const close of clean.splice(0)) close(); for (const key of ["HOME", "AMEM_HOME", "AGENTHUB_HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });
const at = new Date(Date.now() - 3600000).toISOString();
const valid = "amem: fix | src/read.ts#load | stale cache -> recheck source; basis:test";
const malformed = "amem: fix | - | invalid anchorless fix";
const line = (value: unknown) => JSON.stringify(value) + "\n";
function fixture(kind: IngestKind) {
  const f = hookFixture(); clean.push(f.close);
  for (const key of ["HOME", "AMEM_HOME", "AGENTHUB_HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) process.env[key] = f.env[key];
  const file = join(f.root, "native.jsonl"), session = randomUUID();
  const header = kind === "codex" ? { type: "session_meta", timestamp: at, payload: { id: session, cwd: f.cwd, source: "cli" } }
    : kind === "pi" ? { type: "session", version: 3, id: session, timestamp: at, cwd: f.cwd }
      : kind === "kimi" ? { type: "metadata", protocol_version: "1.5" } : undefined;
  if (kind === "kimi") writeFileSync(join(f.root, "state.json"), JSON.stringify({ cwd: f.cwd }));
  const message = (text: string, extras: Record<string, any> = {}) => kind === "codex"
    ? [{ type: "response_item", timestamp: at, payload: { type: "message", id: randomUUID(), role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }], ...extras } }]
    : kind === "pi" ? [{ type: "message", id: randomUUID(), parentId: null, timestamp: at, message: { role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "fixture", timestamp: Date.parse(at), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extras } }]
      : kind === "kimi" ? (() => { const uuid = randomUUID(), agentId = extras.agentId ?? "main"; return [
        { type: "context.append_loop_event", time: Date.parse(at), agentId, event: { type: "step.begin", uuid } },
        { type: "context.append_loop_event", time: Date.parse(at), agentId, event: { type: "content.part", stepUuid: uuid, part: { type: "text", text } } },
        { type: "context.append_loop_event", time: Date.parse(at), agentId, event: { type: "step.end", uuid, messageId: randomUUID(), finishReason: extras.finishReason ?? "completed" } },
      ]; })()
        : [{ uuid: randomUUID(), parentUuid: null, sessionId: session, version: "0.26.1", timestamp: at, type: "assistant", cwd: f.cwd, message: { role: "model", parts: [{ text }] }, ...extras }];
  const write = (...rows: unknown[]) => writeFileSync(file, (header ? line(header) : "") + rows.map(line).join(""));
  const run = () => ingestTranscript(kind, { cwd: f.cwd, base: f.base, files: [file] });
  const rows = () => { const store = new CaptureStore({ memoryDir: f.base, project: f.project }); try { return store.rows({ limit: 200 }); } finally { store.close(); } };
  return { ...f, file, header, message, write, run, rows };
}

for (const kind of ["codex", "pi", "kimi"] as const) {
  test(`${kind}: valid main final Records use capture staging, malformed lines refuse, and tool/nonfinal rows never yield Records`, async () => {
    const f = fixture(kind);
    const nonfinal = kind === "codex" ? { phase: "commentary" } : kind === "pi" ? { stopReason: "toolUse", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { text: valid } }] } : { finishReason: "tool_calls" };
    f.write(...f.message(valid + "\n" + malformed), ...f.message(valid.replace("stale cache", "not final"), nonfinal));
    const result = await f.run(), records = f.rows().filter(row => row.event === "Record");
    expect(result.errors).toBe(0); expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ agent: kind, excerpt: valid, paths: ["src/read.ts#load"], at });
    expect(records[0]!.session).toMatch(/^[a-f0-9]{16}$/);
    expect(result.records).toMatchObject({ supported: true, staged: 1, refused: { record_invalid: 1 }, duplicatesSkipped: 0 });
    const again = await f.run(); expect(again.records).toMatchObject({ found: 0, staged: 0, duplicatesSkipped: 0 }); expect(f.rows().filter(row => row.event === "Record")).toHaveLength(1);
  });
  for (const where of ["home", "repo"] as const) test(`${kind}: ${where} records=false disables extraction without changing ordinary intake`, async () => {
    const f = fixture(kind); f.write(...f.message(valid));
    const dir = where === "home" ? f.base : join(f.cwd, ".amem"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, where === "home" ? "amem.config.json" : "config"), JSON.stringify({ records: false }));
    const result = await f.run(); expect(result.errors).toBe(0); expect(result.records).toMatchObject({ found: 0, staged: 0 }); expect(f.rows().some(row => row.event === "Record")).toBe(false);
    if (kind !== "kimi") expect(result.imported).toBe(1);
  });
  test(`${kind}: explicit child attribution cannot supply main-session Records`, async () => {
    const f = fixture(kind);
    if (kind === "codex") (f.header as any).payload.source = { subagent: "review" };
    if (kind === "pi") (f.header as any).parentSession = join(f.root, "parent.jsonl");
    f.write(...f.message(valid, kind === "kimi" ? { agentId: "child-agent" } : {}));
    const result = await f.run(); expect(result.records!.staged).toBe(0); expect(f.rows().filter(row => row.event === "Record")).toEqual([]);
  });
  test(`${kind}: ingested Records use the existing brief slot and byte cap`, async () => {
    const f = fixture(kind); f.write(...f.message(valid)); await f.run();
    const brief = await sessionStartBrief({ cwd: f.cwd, base: f.base, project: f.project });
    expect(brief.context).toContain('"event":"Record"'); expect(brief.context).toContain("stale cache"); expect(Buffer.byteLength(brief.context)).toBeLessThanOrEqual(1200);
  });
}

test("Qwen native text has no finality marker: report refusal, preserve ordinary capture, ignore thought/tool/subagent text", async () => {
  const f = fixture("qwen");
  f.write(...f.message(valid + "\n" + malformed), ...f.message(valid, { isSidechain: true, agentId: "child" }),
    ...f.message("", { message: { role: "model", parts: [{ text: valid, thought: true }] } }),
    ...f.message("", { message: { role: "model", parts: [{ functionCall: { name: "read", args: { text: valid } } }] } }));
  const result = await f.run();
  expect(result.records).toEqual({ supported: false, found: 2, staged: 0, duplicatesSkipped: 0, refused: { record_invalid: 1, "finality-unavailable": 1 } });
  expect(result.imported).toBe(3); expect(f.rows().filter(row => row.event === "Record")).toEqual([]);
  expect((await f.run()).records!.found).toBe(0);
});

test("existing EOF cursors are never reset or backfilled when extraction becomes enabled", async () => {
  const f = fixture("codex"); mkdirSync(f.base, { recursive: true }); const config = join(f.base, "amem.config.json");
  writeFileSync(config, JSON.stringify({ records: false })); f.write(...f.message(valid)); await f.run();
  writeFileSync(config, JSON.stringify({ records: true }));
  const idle = await f.run(); expect(idle.read).toBe(0); expect(idle.records!.found).toBe(0); expect(f.rows().filter(row => row.event === "Record")).toHaveLength(0);
  appendFileSync(f.file, f.message(valid.replace("stale cache", "new current result")).map(line).join(""));
  expect((await f.run()).records!.staged).toBe(1); expect(f.rows().filter(row => row.event === "Record")).toHaveLength(1);
});

test("lost source cursor replays the same Record receipt and counts its duplicate instead of adding a row", async () => {
  const f = fixture("codex"); f.write(...f.message(valid)); await f.run();
  const store = new CaptureStore({ memoryDir: f.base, project: f.project }), dir = join(store.dir, "ingest"); store.close();
  for (const name of readdirSync(dir)) if (name.endsWith(".db")) rmSync(join(dir, name));
  const repeated = await f.run(); expect(repeated.records).toMatchObject({ staged: 0, duplicatesSkipped: 1 }); expect(f.rows().filter(row => row.event === "Record")).toHaveLength(1);
});

test("Record screens preserve full source privacy and anchor policy before writing a whole canonical line", async () => {
  const f = fixture("codex"); f.write(...f.message(valid));
  mkdirSync(join(f.cwd, ".amem")); writeFileSync(join(f.cwd, ".amem", "config"), JSON.stringify({ denyPaths: ["src/read.ts"] }));
  const result = await f.run(); expect(result.records).toMatchObject({ found: 1, staged: 0, refused: { record_policy: 1 } }); expect(f.rows().filter(row => row.event === "Record")).toHaveLength(0);
});

test("source replacement during an awaited Record screen cannot publish a pending body", async () => {
  const f = fixture("codex"); f.write(...f.message(valid));
  let changed = false;
  const result = await ingestTranscript("codex", { cwd: f.cwd, base: f.base, files: [f.file], policy: { host: { screen: async (value: unknown) => {
    if (!changed && JSON.stringify(value).includes('"event":"Record"')) { changed = true; appendFileSync(f.file, line({ type: "event_msg", timestamp: at, payload: { type: "task_complete" } })); }
    return true;
  } } } });
  expect(changed).toBe(true); expect(result.remaining).toBe(true); expect(f.rows().filter(row => row.event === "Record")).toHaveLength(0);
  const pending = join(f.base, "hook-spool"); expect(existsSync(pending) ? readdirSync(pending).filter(name => name.startsWith("hook-v4-")) : []).toEqual([]);
});

for (const kind of ["codex", "pi", "kimi", "qwen"] as const) test(`${kind} ingest --json exposes Record counters without a new ingest-kind CLI`, () => {
  const f = fixture(kind);
  const root = kind === "codex" ? f.env.CODEX_HOME! : kind === "kimi" ? join(f.env.HOME!, ".kimi-code") : kind === "pi" ? join(f.env.HOME!, ".pi", "agent") : join(f.env.HOME!, ".qwen");
  const sourceDir = kind === "qwen" ? join(root, "projects", "fixture", "chats") : join(root, "sessions", "fixture");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, kind === "kimi" ? "wire.jsonl" : "rollout-record.jsonl"), (f.header ? line(f.header) : "") + f.message(valid).map(line).join(""));
  if (kind === "kimi") writeFileSync(join(sourceDir, "state.json"), JSON.stringify({ cwd: f.cwd }));
  const child = Bun.spawnSync([process.execPath, hookBin, "ingest", kind, "--json"], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(JSON.parse(child.stdout.toString()).records).toMatchObject(kind === "qwen"
    ? { supported: false, found: 1, staged: 0, refused: { "finality-unavailable": 1 }, duplicatesSkipped: 0 }
    : { supported: true, found: 1, staged: 1, refused: {}, duplicatesSkipped: 0 });
});

for (const kind of ["codex", "pi"] as const) test(`${kind}: a complete physical message tail waits, then extracts only after the newline`, async () => {
  const f = fixture(kind), message = f.message(valid)[0]!;
  writeFileSync(f.file, line(f.header) + JSON.stringify(message));
  const incomplete = await f.run(); expect(incomplete.remaining).toBe(true); expect(incomplete.records!.staged).toBe(0);
  appendFileSync(f.file, "\n"); expect((await f.run()).records!.staged).toBe(1);
});

test("Kimi completion requires the matching step identity and no prior privacy/tool refusal", async () => {
  const f = fixture("kimi"), rows = f.message(valid);
  (rows[2] as any).event.uuid = randomUUID(); f.write(...rows);
  const missing = await f.run(); expect(missing.records).toMatchObject({ staged: 0, refused: { "finality-unavailable": 1 } }); expect(f.rows().filter(row => row.event === "Record")).toEqual([]);
});

test("Kimi split windows refuse unknown completion instead of inventing a persistent backfill", async () => {
  const f = fixture("kimi"), native = f.message(valid); f.write(...native);
  const prefix = line(f.header) + native.slice(0, 2).map(line).join("");
  const first = await ingestTranscript("kimi", { cwd: f.cwd, base: f.base, files: [f.file], maxBytes: Buffer.byteLength(prefix) });
  expect(first.remaining).toBe(true); expect(first.records).toMatchObject({ staged: 0, refused: { "finality-unavailable": 1 } });
  expect((await f.run()).records!.staged).toBe(0); expect(f.rows().filter(row => row.event === "Record")).toEqual([]);
});


test("tightening source-only privacy during an awaited full-envelope screen cannot publish a Record", async () => {
  const f = fixture("codex"), native = f.message(valid);
  (native[0] as any).sourceNote = "source-only-marker";
  f.write(...native); let changed = false;
  const result = await ingestTranscript("codex", { cwd: f.cwd, base: f.base, files: [f.file], policy: { host: { screen: async (value: unknown) => {
    if (!changed && Array.isArray(value) && JSON.stringify(value).includes("source-only-marker")) {
      changed = true; writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["source-only-marker"] }));
    }
    return true;
  } } } });
  expect(changed).toBe(true); expect(result.remaining).toBe(true); expect(result.records!.staged).toBe(0);
  expect(f.rows().filter(row => row.event === "Record")).toEqual([]);
  const pending = join(f.base, "hook-spool"); expect(existsSync(pending) ? readdirSync(pending).filter(name => name.startsWith("hook-v4-")) : []).toEqual([]);
});


for (const kind of ["codex", "pi", "kimi"] as const) test(`${kind}: duplicate native message identity in one window reports the receipt duplicate`, async () => {
  const f = fixture(kind), native = f.message(valid); f.write(...native, ...native);
  const result = await f.run();
  expect(result.records).toMatchObject({ found: 2, staged: 1, duplicatesSkipped: 1 });
  expect(f.rows().filter(row => row.event === "Record")).toHaveLength(1);
});

for (const kind of ["codex", "kimi"] as const) test(`${kind}: staging backpressure holds the source commit behind the whole Record frame`, async () => {
  const f = fixture(kind); f.write(...f.message(valid + "\n" + valid.replace("stale cache", "other cache")));
  const originalStage = spool.stageTranscriptCapture; let publications = 0;
  const failed = spyOn(spool, "stageTranscriptCapture").mockImplementation(async (...args) => {
    if (++publications === 2) throw new spool.HookSpoolFull();
    return originalStage(...args);
  });
  try { expect((await f.run()).remaining).toBe(true); } finally { failed.mockRestore(); }
  expect(f.rows().filter(row => row.event === "Record")).toHaveLength(0);
  const resumed = await f.run(); expect(resumed.records).toMatchObject({ found: 2, staged: 1, duplicatesSkipped: 1 });
  expect(f.rows().filter(row => row.event === "Record")).toHaveLength(2);
  expect((await f.run()).records!.found).toBe(0);
});


test("broadening the existing since filter keeps ordinary capture backfill but never backfills Records behind its cursor", async () => {
  const f = fixture("codex"); f.write(...f.message(valid));
  const excluded = await ingestTranscript("codex", { cwd: f.cwd, base: f.base, files: [f.file], since: new Date(Date.parse(at) + 1000).toISOString() });
  expect(excluded.records!.found).toBe(0);
  const broader = await f.run(); expect(broader.imported).toBe(1); expect(broader.records!.found).toBe(0);
  expect(f.rows().filter(row => row.event === "Record")).toHaveLength(0);
});
