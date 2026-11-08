import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stageHookCapture, stageTranscriptCapture, drainHookCaptures, hookCaptureScope } from "../src/hook-spool.ts";
import { applyHookSpoolReplay, planHookSpoolReplay } from "../src/hook-spool-replay.ts";
import { parseRecordLines, type RecordDropReason } from "../src/hook-record.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { normalizeCaptureFields } from "../src/memory/capture-input.ts";
import { readCaptureDrops } from "../src/memory/metrics.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0)) close(); });
function fixture(config?: object) {
  const f = hookFixture(); clean.push(f.close);
  if (config) { mkdirSync(f.base, { recursive: true }); writeFileSync(join(f.base, "amem.config.json"), JSON.stringify(config)); }
  const drops: RecordDropReason[] = [];
  const stage = (line: string, subagent?: boolean) => {
    const record = parseRecordLines(line).records[0]!;
    return stageTranscriptCapture({ agent: "claude", event: "Record", at: "2026-11-08T00:00:00.000Z", session: "a".repeat(16),
      excerpt: record.line, paths: record.anchors, ...(subagent ? { subagent } : {}) }, { cwd: f.cwd, base: f.base }, undefined, reason => drops.push(reason));
  };
  return { ...f, drops, stage };
}

test("a canonical Record uses format 3 and replays its line and anchors exactly once", async () => {
  const f = fixture(), line = "amem: fix | src/a.ts#read | schema race -> retry";
  const first = (await f.stage(line))!, again = (await f.stage(line))!;
  expect(first.name).toMatch(/^hook-v3-/); expect(again.name).toBe(first.name);
  expect(JSON.parse(readFileSync(join(f.base, "hook-spool", first.name), "utf8"))).toMatchObject({ format: 3, capture: { event: "Record", excerpt: line, paths: ["src/a.ts#read"] } });
  const capture = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    await drainHookCaptures({ cwd: f.cwd, base: f.base, project: f.project, expectedScope: hookCaptureScope(f.cwd, f.base), timeRemaining: () => 2000 }, (row, receipt) => capture.append(row, { receipt }));
    expect(capture.rows({ project: f.project })).toMatchObject([{ event: "Record", excerpt: line, paths: ["src/a.ts#read"], session: "a".repeat(16) }]);
  } finally { capture.close(); }
  expect(f.drops).toEqual([]);
});

test("replay declines whole Records under changed caps without storing a partial row or retaining their body", async () => {
  for (const config of [{ excerptBytes: 35 }, { capturePaths: 1 }, { piiPatterns: ["replay whole"] }]) {
    const f = fixture(), line = "amem: fix | src/a.ts, src/b.ts | replay whole -> retain canonical text";
    const pending = (await f.stage(line))!, spool = join(f.base, "hook-spool");
    writeFileSync(join(f.base, "amem.config.json"), JSON.stringify(config), { mode: 0o600 });
    const capture = new CaptureStore({ memoryDir: f.base, project: f.project, cwd: f.cwd });
    try {
      await drainHookCaptures({ cwd: f.cwd, base: f.base, project: f.project, expectedScope: hookCaptureScope(f.cwd, f.base), timeRemaining: () => 2000 }, (row, receipt) => capture.append(row, { receipt }));
      expect(capture.rows({ project: f.project })).toEqual([]);
    } finally { capture.close(); }
    expect(readdirSync(spool).some(name => name.startsWith(pending.name))).toBe(false);
    const quarantine = join(spool, ".quarantine");
    expect(readdirSync(quarantine)).toHaveLength(1);
    const metadata = readFileSync(join(quarantine, readdirSync(quarantine)[0]!), "utf8");
    expect(JSON.parse(metadata)).toMatchObject({ schema: "agent-mem.hook-quarantine/v1", reason: "policy" });
    expect(metadata).not.toContain(line);
    if (!("piiPatterns" in config)) expect(readCaptureDrops(f.base)).toMatchObject({ readable: true, counts: { record_policy: 1 } });
    writeFileSync(join(f.base, "amem.config.json"), "{}", { mode: 0o600 });
    const restored = new CaptureStore({ memoryDir: f.base, project: f.project, cwd: f.cwd });
    try {
      await drainHookCaptures({ cwd: f.cwd, base: f.base, project: f.project, expectedScope: hookCaptureScope(f.cwd, f.base), timeRemaining: () => 2000 }, (row, receipt) => restored.append(row, { receipt }));
      expect(restored.rows({ project: f.project })).toEqual([]);
    } finally { restored.close(); }
  }
});

test("CaptureStore refuses Record normalization changes before creating a receipt or capture spool", () => {
  const f = fixture(), line = "amem: fix | src/a.ts, src/b.ts | replay whole -> retain canonical text";
  const capture = new CaptureStore({ memoryDir: f.base, project: f.project, capturePaths: 1 });
  try {
    expect(() => capture.append({ project: f.project, agent: "claude", event: "Record", at: "2026-11-08T00:00:00.000Z", excerpt: line, paths: ["src/a.ts", "src/b.ts"] }, { receipt: "a".repeat(64) })).toThrow("current caps or screening");
    expect(capture.rows({ project: f.project })).toEqual([]);
  } finally { capture.close(); }
});

test("a raw capture queued behind a cap-declined Record drains in the same pass", async () => {
  const f = fixture(), pending = (await f.stage("amem: fix | src/a.ts, src/b.ts | cap drift -> decline the whole record"))!;
  const raw = (await stageHookCapture("PostToolUse", { tool_name: "Read", tool_response: "raw behind" }, { cwd: f.cwd, base: f.base }))!;
  const spool = join(f.base, "hook-spool"), now = Date.now() / 1000;
  utimesSync(join(spool, pending.name), now - 2, now - 2); utimesSync(join(spool, raw.name), now - 1, now - 1);
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ capturePaths: 1 }), { mode: 0o600 });
  const capture = new CaptureStore({ memoryDir: f.base, project: f.project, cwd: f.cwd });
  try {
    const result = await drainHookCaptures({ cwd: f.cwd, base: f.base, project: f.project, expectedScope: hookCaptureScope(f.cwd, f.base), timeRemaining: () => 2000 }, (row, receipt) => capture.append(row, { receipt }));
    expect(result.captured).toEqual([raw.name]);
    const rows = capture.rows({ project: f.project });
    expect(rows.map(row => row.event)).toEqual(["PostToolUse"]); expect(rows[0]!.excerpt).toContain("raw behind");
    expect(readCaptureDrops(f.base)).toMatchObject({ readable: true, counts: { record_policy: 1 } });
  } finally { capture.close(); }
});

test("off-hook replay uses the same whole-Record retirement on current cap refusal", async () => {
  const f = fixture(); await f.stage("amem: fix | src/a.ts, src/b.ts | cap drift -> decline the whole record");
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ capturePaths: 1 }), { mode: 0o600 });
  const plan = await planHookSpoolReplay({ base: f.base });
  expect(plan.counts.replayable).toBe(1);
  const receipt = await applyHookSpoolReplay({ base: f.base, plan });
  expect(receipt).toMatchObject({ applied: 0, spooled: 0, retired: 1, retained: 0, outcomes: [{ outcome: "skipped" }] });
  expect(readCaptureDrops(f.base)).toMatchObject({ readable: true, counts: { record_policy: 1 } });
});

test("denied anchors, secrets, PII and private spans refuse the whole canonical Record", async () => {
  for (const [config, line] of [
    [undefined, "amem: fix | .env#load | leak -> remove"],
    [undefined, "amem: fix | id_rsa#load | leak -> remove"],
    [undefined, `amem: decision | - | ghp_${"a".repeat(40)}`],
    [undefined, "amem: decision | - | alice@example.com"],
    [{ denyPaths: ["internal/"] }, "amem: fix | src/a.ts, internal/b.ts#load | leak -> remove"],
    [{ piiPatterns: ["PERSONAL_CANARY"] }, "amem: decision | - | PERSONAL_CANARY"],
  ] as const) {
    const f = fixture(config);
    expect(await f.stage(line)).toBeUndefined(); expect(f.drops).toEqual(["record_policy"]);
  }
  const f = fixture();
  expect(await stageTranscriptCapture({ agent: "claude", event: "Record", at: "2026-11-08T00:00:00.000Z", paths: [],
    excerpt: "amem: decision | - | before <private>hidden</private> after" }, { cwd: f.cwd, base: f.base }, undefined, reason => f.drops.push(reason))).toBeUndefined();
  expect(f.drops).toEqual(["record_policy"]);
});

test("lower configured caps never truncate a Record into a different line or anchor set", async () => {
  const text = fixture({ excerptBytes: 10 });
  expect(await text.stage("amem: decision | - | settled")).toBeUndefined(); expect(text.drops).toEqual(["record_length"]);
  const paths = fixture({ capturePaths: 1 });
  expect(await paths.stage("amem: fix | src/a.ts, src/b.ts | race -> wait")).toBeUndefined(); expect(paths.drops).toEqual(["record_policy"]);
});

test("opt-out and subagent attribution suppress Record without suppressing existing summaries", async () => {
  const f = fixture({ records: false });
  expect(await f.stage("amem: decision | - | settled")).toBeUndefined(); expect(f.drops).toEqual([]);
  expect(await stageTranscriptCapture({ agent: "claude", event: "Title", excerpt: "existing title" }, { cwd: f.cwd, base: f.base })).toBeDefined();
  const subagent = fixture();
  expect(await subagent.stage("amem: decision | - | settled", true)).toBeUndefined(); expect(subagent.drops).toEqual([]);
});

test("replay refuses a forged Record with otherwise valid normalized capture bytes", async () => {
  for (const changed of [{ excerpt: "not a canonical record" }, { agent: "jcode" }]) {
    const f = fixture(), staged = (await f.stage("amem: decision | - | settled"))!, file = join(f.base, "hook-spool", staged.name);
    const body = JSON.parse(readFileSync(file, "utf8"));
    body.capture = normalizeCaptureFields({ ...body.capture, ...changed });
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    const capture = new CaptureStore({ memoryDir: f.base, project: f.project });
    try {
      await drainHookCaptures({ cwd: f.cwd, base: f.base, project: f.project, expectedScope: hookCaptureScope(f.cwd, f.base), timeRemaining: () => 2000 }, (row, receipt) => capture.append(row, { receipt }));
      expect(capture.rows({ project: f.project })).toEqual([]);
    } finally { capture.close(); }
  }
});
