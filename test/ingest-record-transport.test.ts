import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_AGENTS, drainHookCaptures, stageHookCapture, stageTranscriptCapture } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { type CaptureFields } from "../src/memory/capture-input.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const agents = ["codex", "kimi", "pi", "qwen", "jcode"] as const;
const closes: (() => void)[] = [], oldHome = process.env.HOME;
afterEach(() => { process.env.HOME = oldHome; for (const close of closes.splice(0)) close(); });
function fixture() {
  const f = hookFixture(); closes.push(f.close); process.env.HOME = f.env.HOME; mkdirSync(f.base);
  return { ...f, options: { cwd: f.cwd, base: f.base } };
}
const record = (agent: string): CaptureFields => ({ agent, event: "Record", at: "2026-11-11T00:00:00.000Z", paths: ["src/a.ts"], excerpt: "amem: decision | src/a.ts | retain the source proof" });
const pending = (base: string) => existsSync(join(base, "hook-spool")) ? readdirSync(join(base, "hook-spool")).filter(name => name.startsWith("hook-")) : [];

test("all five non-Claude Record agents use v4 and retain deterministic pending/claimed receipts", async () => {
  const f = fixture();
  expect(HOOK_AGENTS).toEqual(["claude", "jcode"]);
  for (const agent of agents) {
    const input = record(agent), first = (await stageTranscriptCapture(input, f.options, "native-message"))!;
    expect(first.name).toStartWith("hook-v4-");
    const file = join(f.base, "hook-spool", first.name), bytes = readFileSync(file);
    expect(JSON.parse(bytes.toString())).toMatchObject({ schema: "agent-mem.hook-capture", format: 4, capture: { agent, event: "Record" } });
    expect(await stageTranscriptCapture(input, f.options, "native-message")).toEqual({ ...first, backlog: true });
    renameSync(file, file + ".draining-" + "a".repeat(24));
    expect(await stageTranscriptCapture(input, f.options, "native-message")).toEqual({ ...first, backlog: true });
  }
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    const append = (input: Parameters<CaptureStore["append"]>[0], receipt: string) => store.append(input, { receipt });
    expect((await drainHookCaptures({ ...f.options, project: f.project }, append)).captured).toHaveLength(5);
    for (const agent of agents) await stageTranscriptCapture(record(agent), f.options, "native-message");
    await drainHookCaptures({ ...f.options, project: f.project }, append);
    expect(store.rows({ project: f.project }).map(row => row.agent).sort()).toEqual([...agents].sort());
    expect(pending(f.base)).toEqual([]);
  } finally { store.close(); }
});

test("existing native and transcript publications keep their v2/v3 envelope and agent APIs", async () => {
  const f = fixture();
  const native = (await stageHookCapture("Stop", { last_assistant_message: "ordinary native" }, f.options))!;
  expect(native.name).toStartWith("hook-v2-");
  for (const [agent, event] of [["claude", "Title"], ["claude", "Recap"], ["claude", "Compact"], ["claude", "Record"], ["jcode", "Title"], ["jcode", "Compact"]]) {
    const input = event === "Record" ? record(agent!) : { agent: agent!, event: event!, excerpt: "public summary" };
    const staged = (await stageTranscriptCapture(input, f.options))!;
    expect(staged.name).toStartWith("hook-v3-");
    const body = JSON.parse(readFileSync(join(f.base, "hook-spool", staged.name), "utf8"));
    expect(body.format).toBe(3); expect(body.capture.agent).toBe(agent); expect(body.capture.event).toBe(event);
    expect(Object.keys(body)).toEqual(["schema", "format", "cwd", "scope", "root", "nonce", "capture"]);
  }
  for (const input of [record("unknown"), { ...record("codex"), event: "Title" }, { ...record("kimi"), event: "Stop" }])
    expect(await stageTranscriptCapture(input, f.options)).toBeUndefined();
});

test("v4 refuses agent/event mismatches and v3 cannot admit a non-Claude Record", async () => {
  for (const alteration of [{ format: 3 }, { agent: "unknown" }, { agent: "claude" }, { event: "Title" }]) {
    const f = fixture(), staged = (await stageTranscriptCapture(record("codex"), f.options))!;
    const file = join(f.base, "hook-spool", staged.name), value = JSON.parse(readFileSync(file, "utf8"));
    if ("format" in alteration) value.format = alteration.format;
    if ("agent" in alteration) value.capture.agent = alteration.agent;
    if ("event" in alteration) value.capture.event = alteration.event;
    writeFileSync(file, JSON.stringify(value));
    let appended = 0;
    await drainHookCaptures({ ...f.options, project: f.project }, () => { appended++; return { id: 1 }; });
    expect(appended).toBe(0);
  }
});

test("new Record paths await complete host screens before the synchronous publication guard", async () => {
  const f = fixture(), calls: unknown[] = [], order: string[] = [];
  const policy = { host: { async screen(value: unknown) { calls.push(value); await Promise.resolve(); order.push("screen"); return true; } } };
  const staged = await stageTranscriptCapture(record("pi"), { ...f.options, policy }, "source", undefined, () => {
    expect(pending(f.base)).toEqual([]); order.push("guard");
  });
  expect(staged).toBeDefined(); expect(order).toEqual(["screen", "screen", "guard"]);
  expect(calls[0]).toMatchObject({ input: record("pi"), paths: ["src/a.ts"] });
  expect(calls[1]).toMatchObject({ capture: { excerpt: record("pi").excerpt, paths: ["src/a.ts"], agent: "pi", event: "Record" } });
  const denied = fixture(), drops: string[] = [];
  expect(await stageTranscriptCapture(record("qwen"), { ...denied.options, policy: { host: { async screen() { return false; } } } }, undefined, reason => drops.push(reason), () => { throw Error("must not publish"); })).toBeUndefined();
  expect(drops).toEqual(["record_policy"]); expect(pending(denied.base)).toEqual([]);
});

test("source changes after the last awaited screen stop publication; legacy host refusal is unchanged", async () => {
  const f = fixture(); let screened = 0, guarded = 0;
  const policy = { host: { async screen() { await Promise.resolve(); screened++; return true; } } };
  await expect(stageTranscriptCapture(record("kimi"), { ...f.options, policy }, undefined, undefined, () => { guarded++; throw Error("native source changed"); })).rejects.toThrow("native source changed");
  expect(screened).toBe(2); expect(guarded).toBe(1); expect(pending(f.base)).toEqual([]);
  expect(await stageTranscriptCapture(record("claude"), { ...f.options, policy })).toBeUndefined();
  expect(await stageTranscriptCapture({ agent: "jcode", event: "Compact", excerpt: "public" }, { ...f.options, policy })).toBeUndefined();
  expect(screened).toBe(2);
});

test("opt-out, subagent, denied anchor and floor refusals do not reach the publish guard", async () => {
  for (const kind of ["records", "subagent", "anchor", "floor"] as const) {
    const f = fixture();
    if (kind === "records") writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ records: false }));
    if (kind === "floor") writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "hook-spool", minReader: "99.0.0", since: "2026-11-11" }]));
    const options = { ...f.options, ...(kind === "anchor" ? { policy: { denyPaths: ["src/a.ts"] } } : {}) };
    expect(await stageTranscriptCapture({ ...record("jcode"), ...(kind === "subagent" ? { subagent: true } : {}) }, options, undefined, undefined, () => { throw Error("refusal reached publication"); })).toBeUndefined();
    expect(pending(f.base)).toEqual([]);
  }
});
