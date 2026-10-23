import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stageHookCapture, drainHookCaptures, hookCapturePending } from "../src/hook-spool.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const fixture = () => { const f = hookFixture(); fixtures.push(f); return f; };
const options = (f: ReturnType<typeof hookFixture>) => ({ cwd: f.cwd, base: f.base });
const active = (f: ReturnType<typeof hookFixture>) => join(f.base, "hook-spool");
const capacity = (f: ReturnType<typeof hookFixture>) => join(active(f), ".capacity");
const names = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith("hook-")) : [];
async function full(f: ReturnType<typeof hookFixture>) {
  for (let i = 0; i < 256; i++) expect(await stageHookCapture("PostToolUse", { prompt: `capacity original ${i}` }, options(f))).toBeDefined();
  expect(names(active(f))).toHaveLength(256);
}

test("default active admission remains capped while explicit reserve retains the current normalized event", async () => {
  const f = fixture(); await full(f);
  await expect(stageHookCapture("PostToolUse", { prompt: "ordinary full refusal" }, options(f))).rejects.toThrow("hook storage full");
  const admission = stageHookCapture("SessionStart", { prompt: "reserved current" }, { ...options(f), deferAtCapacity: true });
  await expect(admission).resolves.toMatchObject({ deferred: true, backlog: true });
  const first = await admission;
  expect(first).toMatchObject({ deferred: true, backlog: true }); expect(hookCapturePending(f.base, first!.name)).toBe(true);
  expect(names(active(f))).toHaveLength(256); expect(names(capacity(f))).toHaveLength(1);
  expect(statSync(capacity(f)).mode & 0o777).toBe(0o700);
  expect(statSync(join(capacity(f), first!.name)).mode & 0o777).toBe(0o600);
  const value = JSON.parse(readFileSync(join(capacity(f), first!.name), "utf8"));
  expect(value.capture.excerpt).toBe("reserved current"); expect(value.cwd).toBe(f.cwd);
  expect(await stageHookCapture("SessionStart", { private: true, prompt: "never publish private" }, { ...options(f), deferAtCapacity: true })).toBeUndefined();
  expect(names(capacity(f))).toHaveLength(1);
});

test("matching reserve drains exactly once with older active work inside the shared bound and an 8 ms clock", async () => {
  const f = fixture(); await full(f);
  const staged = await stageHookCapture("PostToolUse", { prompt: "reserved exactly once" }, { ...options(f), deferAtCapacity: true });
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    const first = await drainHookCaptures({ ...options(f), project: f.project, timeRemaining: () => 8 }, (input, receipt) => store.append(input, { receipt }));
    expect(first.captured[0]).not.toBe(staged!.name); expect(first.captured.length).toBeGreaterThan(0); expect(first.captured.length).toBeLessThanOrEqual(32);
    expect(hookCapturePending(f.base, staged!.name)).toBe(true);
    for (let pass = 0; pass < 9 && (names(active(f)).length || names(capacity(f)).length); pass++) await drainHookCaptures({ ...options(f), project: f.project, timeRemaining: () => 8 }, (input, receipt) => store.append(input, { receipt }));
    expect(store.rows({ limit: 1000 })).toHaveLength(257);
    expect(store.rows({ limit: 1000 }).filter(row => row.excerpt === "reserved exactly once")).toHaveLength(1);
    expect((await drainHookCaptures({ ...options(f), project: f.project }, (input, receipt) => store.append(input, { receipt }))).captured).toEqual([]);
  } finally { store.close(); }
});

test("reserve admits at most 32 files and keeps exhaustion explicit", async () => {
  const f = fixture(); await full(f);
  for (let i = 0; i < 32; i++) await expect(stageHookCapture("PostToolUse", { prompt: `reserve file ${i}` }, { ...options(f), deferAtCapacity: true })).resolves.toMatchObject({ deferred: true });
  await expect(stageHookCapture("PostToolUse", { prompt: "reserve exhausted" }, { ...options(f), deferAtCapacity: true })).rejects.toThrow("hook storage full");
  expect(names(active(f))).toHaveLength(256); expect(names(capacity(f))).toHaveLength(32);
});

test("reserve byte admission refuses beyond 256 KiB even below its file count", async () => {
  const f = fixture(); await full(f); mkdirSync(capacity(f), { mode: 0o700 });
  const sourceName = names(active(f))[0]!, original = JSON.parse(readFileSync(join(active(f), sourceName), "utf8"));
  for (let i = 0; i < 4; i++) {
    const value = { ...original, nonce: i.toString(16).padStart(32, "0") }, name = sourceName.replace(/[a-f0-9]{32}\.json$/, value.nonce + ".json");
    // Valid normalized JSON, padded only with legal trailing whitespace to exercise byte admission.
    writeFileSync(join(capacity(f), name), JSON.stringify(value).padEnd(64 * 1024, " "), { mode: 0o600 });
  }
  await expect(stageHookCapture("PostToolUse", { prompt: "byte exhausted" }, { ...options(f), deferAtCapacity: true })).rejects.toThrow("hook storage full");
  expect(names(capacity(f))).toHaveLength(4);
  expect(names(capacity(f)).reduce((sum, name) => sum + statSync(join(capacity(f), name)).size, 0)).toBe(256 * 1024);
});

test("wrong scope never replays reserve and policy retirement never becomes ordinary replay", async () => {
  const f = fixture(); await full(f);
  const staged = await stageHookCapture("PostToolUse", { prompt: "capacity policy marker" }, { ...options(f), deferAtCapacity: true });
  utimesSync(join(capacity(f), staged!.name), new Date(0), new Date(0));
  let appends = 0;
  const wrong = await drainHookCaptures({ ...options(f), project: f.project, expectedScope: "0".repeat(64) }, () => { appends++; return { id: 1 }; });
  expect(wrong.captured).toEqual([]); expect(appends).toBe(0); expect(hookCapturePending(f.base, staged!.name)).toBe(true);
  await drainHookCaptures({ ...options(f), project: f.project, policy: { piiPatterns: ["capacity policy marker"] } }, () => { appends++; return { id: 1 }; });
  expect(names(capacity(f))).toHaveLength(0); expect(hookCapturePending(f.base, staged!.name)).toBe(true);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    for (let pass = 0; pass < 9; pass++) await drainHookCaptures({ ...options(f), project: f.project }, (input, receipt) => store.append(input, { receipt }));
    expect(store.rows({ limit: 1000 }).some(row => row.excerpt === "capacity policy marker")).toBe(false);
  } finally { store.close(); }
});

test("removed cwd reserve records retire only the needed slot with a counted body deletion", async () => {
  const f = fixture(), foreign = fixture();
  const stale = await stageHookCapture("PostToolUse", { prompt: "removed cwd reserve" }, { cwd: foreign.cwd, base: f.base });
  mkdirSync(capacity(f), { mode: 0o700 }); renameSync(join(active(f), stale!.name), join(capacity(f), stale!.name));
  const source = JSON.parse(readFileSync(join(capacity(f), stale!.name), "utf8"));
  for (let i = 1; i < 32; i++) {
    const nonce = i.toString(16).padStart(32, "0"), name = stale!.name.replace(/[a-f0-9]{32}\.json$/, nonce + ".json");
    writeFileSync(join(capacity(f), name), JSON.stringify({ ...source, nonce }), { mode: 0o600 });
  }
  for (const name of names(capacity(f))) { const file = join(capacity(f), name), row = JSON.parse(readFileSync(file, "utf8")); row.capture.at = new Date(Date.now() - 8 * 24 * 3600_000).toISOString(); writeFileSync(file, JSON.stringify(row)); }
  rmSync(foreign.cwd, { recursive: true, force: true });
  await full(f);
  await expect(stageHookCapture("SessionStart", { prompt: "after stale capacity" }, { ...options(f), deferAtCapacity: true })).resolves.toMatchObject({ deferred: true });
  expect(readMetrics(f.base).filter(row => row.captureDropReason === "cwd_removed").reduce((n,row) => n + (row.captureDrops ?? 0), 0)).toBe(1);
  expect(names(capacity(f))).toHaveLength(32);
  expect(names(join(active(f), ".quarantine"))).toHaveLength(0);
});


test("a failed reserved append retains its claim inside reserve without overflowing active admission", async () => {
  const f = fixture(); await full(f);
  const staged = await stageHookCapture("PostToolUse", { prompt: "retry reserved append" }, { ...options(f), deferAtCapacity: true });
  // Select this reserved claim first while retaining the global-oldest production order.
  utimesSync(join(capacity(f), staged!.name), new Date(0), new Date(0));
  const failed = await drainHookCaptures({ ...options(f), project: f.project, timeRemaining: () => 8 }, () => { throw new Error("fixture append refused"); });
  expect(failed.captured).toEqual([]); expect(failed.blocked).toBeGreaterThan(0);
  expect(names(active(f))).toHaveLength(256); expect(names(capacity(f))).toHaveLength(1);
  expect(names(capacity(f))[0]).toStartWith(staged!.name + ".draining-");
  expect(hookCapturePending(f.base, staged!.name)).toBe(true);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    const recovered = await drainHookCaptures({ ...options(f), project: f.project, timeRemaining: () => 8 }, (input, receipt) => store.append(input, { receipt }));
    expect(recovered.captured[0]).toBe(staged!.name);
    expect(store.rows({ limit: 1000 }).filter(row => row.excerpt === "retry reserved append")).toHaveLength(1);
  } finally { store.close(); }
});


test("single-append budgets and new admissions cannot starve older active records", async () => {
  const f = fixture(); await full(f);
  const originals = new Set(names(active(f)));
  await stageHookCapture("SessionStart", { prompt: "new reserved event" }, { ...options(f), deferAtCapacity: true });
  const consumed = new Set<string>();
  for (let turn = 0; turn < 3; turn++) {
    let remaining = 8, appends = 0;
    const result = await drainHookCaptures({ ...options(f), project: f.project, timeRemaining: () => remaining }, () => { appends++; remaining = 0; return { id: turn + 1 }; });
    expect(appends).toBe(1); expect(result.captured).toHaveLength(1);
    expect(originals.has(result.captured[0]!)).toBe(true); expect(consumed.has(result.captured[0]!)).toBe(false);
    consumed.add(result.captured[0]!);
    const next = await stageHookCapture("SessionStart", { prompt: `later busy-session event ${turn}` }, { ...options(f), deferAtCapacity: true });
    expect(next).toMatchObject({ backlog: true });
  }
});
