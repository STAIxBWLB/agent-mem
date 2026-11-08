import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { drainHookCaptures, hookCaptureScope, stageTranscriptCapture } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { readCaptureDrops, readMetrics } from "../src/memory/metrics.ts";

// Actual published N-1, not a copy of the current decoder. The alias is dev-only.
const previousRoot = resolve(import.meta.dir, "../node_modules/@staix/agent-mem-v0221");
const previous = (file: string) => pathToFileURL(join(previousRoot, file)).href;
const clean: (() => void)[] = [];
const oldHome = process.env.HOME;
afterEach(() => { process.env.HOME = oldHome; for (const close of clean.splice(0)) close(); });
function fixture() {
  const f = hookFixture(); clean.push(f.close); process.env.HOME = f.env.HOME;
  return { ...f, options: { cwd: f.cwd, base: f.base } };
}
type Fixture = ReturnType<typeof fixture>;
const spool = (f: Fixture) => join(f.base, "hook-spool");
const pending = (f: Fixture) => existsSync(spool(f)) ? readdirSync(spool(f)).filter(name => name.startsWith("hook-")).sort() : [];
const recordText = "amem: fix | src/example.ts#read | stale value -> refresh before reading";
function stageRecord(f: Fixture) {
  return stageTranscriptCapture({ agent: "claude", event: "Record", at: new Date().toISOString(), paths: ["src/example.ts#read"], excerpt: recordText }, f.options);
}
function runPrevious<T>(f: Fixture, body: string): T {
  const script = `const root = ${JSON.stringify(previousRoot)};
const pkg = await Bun.file(root + "/package.json").json();
if (pkg.name !== "@staix/agent-mem" || pkg.version !== "0.22.1") throw new Error("expected published @staix/agent-mem 0.22.1");
const options = ${JSON.stringify(f.options)};
const project = ${JSON.stringify(f.project)};
${body}`;
  const child = Bun.spawnSync([process.execPath, "--smol", "-e", script], { cwd: f.cwd, env: { ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString()) as T;
}
async function drainCurrent(f: Fixture) {
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    const result = await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }));
    return { ...result, rows: store.rows({ project: f.project }) };
  } finally { store.close(); }
}

test("Record uses unchanged format 3 and current replay retains its exact body and receipt deduplication", async () => {
  const f = fixture(), at = new Date().toISOString();
  const input = { agent: "claude", event: "Record", at, paths: ["src/example.ts#read"], excerpt: recordText };
  const staged = await stageTranscriptCapture(input, f.options);
  expect(staged).toBeDefined();
  expect(staged!.name).toMatch(/^hook-v3-[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{32}\.json$/);
  const body = JSON.parse(readFileSync(join(spool(f), staged!.name), "utf8"));
  expect(body).toMatchObject({ schema: "agent-mem.hook-capture", format: 3, capture: { agent: "claude", event: "Record", excerpt: recordText, paths: input.paths, at } });
  expect(Object.keys(body).sort()).toEqual(["capture", "cwd", "format", "nonce", "root", "schema", "scope"]);
  const first = await drainCurrent(f);
  expect(first.captured).toEqual([staged!.name]);
  expect(first.rows).toHaveLength(1);
  expect(first.rows[0]).toMatchObject({ event: "Record", excerpt: recordText, paths: input.paths, at });
  expect(pending(f)).toEqual([]);
  expect((await stageTranscriptCapture(input, f.options))?.name).toBe(staged!.name);
  expect((await drainCurrent(f)).rows).toHaveLength(1);
});

test("N-1 0.22.1 drain deletes a fresh format-3 Record without a drop count while replaying a known summary", async () => {
  const f = fixture(), staged = (await stageRecord(f))!;
  expect(staged).toBeDefined();
  const summary = (await stageTranscriptCapture({ agent: "claude", event: "Recap", at: new Date().toISOString(), excerpt: "known previous-reader control" }, f.options))!;
  expect(pending(f)).toHaveLength(2);
  const result = runPrevious<{ captured: string[]; blocked: number; events: string[] }>(f, `
const { drainHookCaptures } = await import(${JSON.stringify(previous("src/hook-spool.ts"))});
const { CaptureStore } = await import(${JSON.stringify(previous("src/memory/capture.ts"))});
const store = new CaptureStore({ memoryDir: options.base, project });
try {
  const result = await drainHookCaptures({ ...options, project }, (input, receipt) => store.append(input, { receipt }));
  console.log(JSON.stringify({ ...result, events: store.rows({ project }).map(row => row.event) }));
} finally { store.close(); }`);
  expect(result).toEqual({ captured: [summary.name], blocked: 1, events: ["Recap"] });
  expect(pending(f)).toEqual([]);
  expect(readCaptureDrops(f.base)).toMatchObject({ readable: true, counts: {} });
  expect(readMetrics(f.base).some(row => (row.captureDrops ?? 0) > 0)).toBe(false);
});

test("N-1 0.22.1 home-wide maintenance deletes a fresh foreign-cwd Record without a drop count", async () => {
  const f = fixture(), staged = (await stageRecord(f))!;
  expect(staged).toBeDefined();
  const summary = (await stageTranscriptCapture({ agent: "claude", event: "Recap", at: new Date().toISOString(), excerpt: "maintenance keeps known summary" }, f.options))!;
  const result = runPrevious<{ staged: boolean }>(f, `
const { stageHookCapture } = await import(${JSON.stringify(previous("src/hook-spool.ts"))});
const staged = await stageHookCapture("PostToolUse", { tool_name: "Read", tool_response: "previous maintenance barrier" }, { ...options, cwd: ${JSON.stringify(f.root)} });
console.log(JSON.stringify({ staged: staged !== undefined }));`);
  expect(result.staged).toBe(true);
  expect(pending(f).some(name => name.startsWith(staged.name))).toBe(false);
  expect(pending(f)).toContain(summary.name);
  expect(pending(f)).toHaveLength(2); // Known summary plus the old reader's own native row.
  expect(readCaptureDrops(f.base)).toMatchObject({ readable: true, counts: {} });
  expect(readMetrics(f.base).some(row => (row.captureDrops ?? 0) > 0)).toBe(false);
});

for (const where of ["home", "repo"] as const) test(`N-1 0.22.1 refuses ${where} records=false as an unknown config key`, () => {
  const f = fixture();
  const directory = where === "home" ? f.base : join(f.cwd, ".amem");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, where === "home" ? "amem.config.json" : "config");
  writeFileSync(file, JSON.stringify({ records: false }));
  const result = runPrevious<{ error?: string }>(f, `
const { loadAmemConfig } = await import(${JSON.stringify(previous("src/memory/config.ts"))});
let error;
try { loadAmemConfig(options.base, options.cwd); } catch (caught) { error = caught.message; }
console.log(JSON.stringify({ error }));`);
  expect(result.error).toContain(file);
  expect(result.error).toContain('unknown key "records"');
  expect(readFileSync(file, "utf8")).toBe('{"records":false}');
});

for (const surface of ["hook-spool", "home"] as const) test(`a person-authored ${surface} floor at 0.23.0 protects Record from old staging, drain and maintenance`, async () => {
  const f = fixture(), staged = (await stageRecord(f))!;
  expect(staged).toBeDefined();
  const file = join(spool(f), staged.name), before = readFileSync(file);
  const scope = hookCaptureScope(f.cwd, f.base)!;
  expect(scope).toMatch(/^[a-f0-9]{64}$/);
  // Fixture acts as the person. Never run the current 0.22.1 development package under this higher floor.
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface, minReader: "0.23.0", since: "2026-11-08" }]));
  const result = runPrevious<{ staged: boolean; captured: string[]; blocked: number; retired: number }>(f, `
const { stageHookCapture, drainHookCaptures, quarantineHookScope } = await import(${JSON.stringify(previous("src/hook-spool.ts"))});
const staged = await stageHookCapture("PostToolUse", { tool_response: "must not publish" }, options);
const result = await drainHookCaptures({ ...options, project }, () => { throw new Error("floor allowed append"); });
const cleanup = quarantineHookScope({ ...options, scope: ${JSON.stringify(scope)} });
console.log(JSON.stringify({ staged: staged !== undefined, ...result, ...cleanup }));`);
  expect(result).toEqual({ staged: false, captured: [], blocked: 1, retired: 0 });
  const hook = Bun.spawnSync([process.execPath, "--smol", join(previousRoot, "bin/amem.js"), "hook", "PostToolUse"], {
    cwd: f.cwd, env: { ...f.env }, stdin: Buffer.from(JSON.stringify({ hook_event_name: "PostToolUse", cwd: f.cwd, session_id: "floor-fixture", tool_response: "floor refuses capture" })), stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  expect(hook.exitCode, hook.stderr.toString()).toBe(0);
  expect(hook.stdout.toString()).toBe(""); // Fail-open hook, no native permission decision.
  expect(readFileSync(file)).toEqual(before);
  expect(pending(f)).toEqual([staged.name]);
  // Floor protection is spool-specific, not a promise that hook telemetry writes stop.
  expect(readMetrics(f.base).some(row => row.kind === "hook")).toBe(true);
  expect(readCaptureDrops(f.base)).toMatchObject({ readable: true, counts: {} });
});
