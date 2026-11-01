import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { drainHookCaptures, stageHookCapture } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { readCaptureDrops } from "../src/memory/metrics.ts";

// #199: versions coexist on one memory home. The published 0.17.0 is the N-1 reader.
const clean: (() => void)[] = [];
const oldHome = process.env.HOME;
afterEach(() => { process.env.HOME = oldHome; for (const close of clean.splice(0)) close(); });
function fixture() {
  const f = hookFixture(); clean.push(f.close); process.env.HOME = f.env.HOME;
  return { ...f, options: { cwd: f.cwd, base: f.base } };
}
const spool = (base: string) => join(base, "hook-spool");
const pending = (base: string) => existsSync(spool(base)) ? readdirSync(spool(base)).filter(name => name.startsWith("hook-")) : [];
async function drain(f: ReturnType<typeof fixture>) {
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try { const r = await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt })); return { ...r, rows: store.rows({ project: f.project }) }; }
  finally { store.close(); }
}
const v017 = pathToFileURL(resolve(import.meta.dir, "../node_modules/@staix/agent-mem-v017/src/hook-spool.ts")).href;
/** 0.17.0 runs one ordinary hook: home-wide maintenance via stageHookCapture, then its drain for the same cwd. */
function runV017(f: ReturnType<typeof fixture>, excerpt: string) {
  const script = `const { drainHookCaptures, stageHookCapture } = await import(${JSON.stringify(v017)});
const options = { cwd: ${JSON.stringify(f.cwd)}, base: ${JSON.stringify(f.base)} };
await stageHookCapture("PostToolUse", { tool_name: "Read", tool_response: ${JSON.stringify(excerpt)} }, options);
const appended = [];
const r = await drainHookCaptures({ ...options, project: ${JSON.stringify(f.project)} }, (input) => { appended.push(input.excerpt); return { id: 1 }; });
console.log(JSON.stringify({ captured: r.captured.length, appended }));`;
  const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: f.cwd, env: { ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString()) as { captured: number; appended: string[] };
}

test("AC1: a record staged by this version survives a 0.17.0 maintenance pass and drain, and this version drains it", async () => {
  const f = fixture();
  const staged = (await stageHookCapture("PostToolUse", { session_id: "s", tool_name: "Read", tool_response: "new-version record" }, f.options))!;
  expect(staged.name).toMatch(/^hook-v2-[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{32}\.json$/);
  expect(JSON.parse(readFileSync(join(spool(f.base), staged.name), "utf8"))).toMatchObject({ schema: "agent-mem.hook-capture", format: 2 });
  // 0.17.0 drains its own v1 record and leaves the format-2 file untouched.
  expect(runV017(f, "old-version record")).toEqual({ captured: 1, appended: ["old-version record"] });
  expect(pending(f.base)).toEqual([staged.name]);
  // A v1 record 0.17.0 left pending is still drained here.
  const script = `const { stageHookCapture } = await import(${JSON.stringify(v017)});
await stageHookCapture("PostToolUse", { tool_response: "old pending" }, { cwd: ${JSON.stringify(f.cwd)}, base: ${JSON.stringify(f.base)} });`;
  expect(Bun.spawnSync([process.execPath, "-e", script], { cwd: f.cwd, env: { ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 10000 }).exitCode).toBe(0);
  const result = await drain(f);
  expect(result.captured).toContain(staged.name);
  expect(result.rows.map(row => row.excerpt).sort()).toEqual(["new-version record", "old pending"]);
  expect(pending(f.base)).toEqual([]);
});

function rewrite(f: ReturnType<typeof fixture>, name: string, change: (value: { [key: string]: unknown }) => unknown) {
  const file = join(spool(f.base), name), value = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, typeof change(value) === "string" ? change(value) as string : JSON.stringify(value));
}
const age = (f: ReturnType<typeof fixture>, days: number) => {
  const at = new Date(Date.now() - days * 86400_000);
  for (const name of pending(f.base)) utimesSync(join(spool(f.base), name), at, at);
};

test("AC2: a newer schema stays pending through drain and maintenance until the TTL, then retires with a counted reason", async () => {
  const f = fixture();
  const staged = (await stageHookCapture("PostToolUse", { tool_response: "from the future" }, f.options))!;
  rewrite(f, staged.name, value => { value.format = 3; value.extra = { added: true }; });
  expect((await drain(f)).rows).toEqual([]);
  await stageHookCapture("PostToolUse", { tool_response: "maintenance pass" }, { cwd: f.root, base: f.base });
  expect(pending(f.base).some(name => name.startsWith(staged.name))).toBe(true);
  // Six days old: still pending under maintenance from another cwd.
  age(f, 6);
  await stageHookCapture("PostToolUse", { tool_response: "maintenance pass 2" }, { cwd: f.root, base: f.base });
  expect(pending(f.base).some(name => name.startsWith(staged.name))).toBe(true);
  // Past the seven-day TTL: maintenance retires it and counts the reason.
  age(f, 8);
  await stageHookCapture("PostToolUse", { tool_response: "maintenance pass 3" }, { cwd: f.root, base: f.base });
  expect(pending(f.base).some(name => name.startsWith(staged.name))).toBe(false);
  const drops = readCaptureDrops(f.base);
  expect(drops.readable && drops.counts.unknown_schema_expired).toBe(1);
});

test("AC2: the drain retires an expired unknown schema with the counted reason; a corrupt record is still retired at once", async () => {
  const f = fixture();
  const unknown = (await stageHookCapture("PostToolUse", { tool_response: "unknown schema" }, f.options))!;
  const corrupt = (await stageHookCapture("PostToolUse", { tool_response: "corrupt" }, f.options))!;
  const known = (await stageHookCapture("PostToolUse", { tool_response: "known" }, f.options))!;
  rewrite(f, unknown.name, value => { value.schema = "agent-mem.hook-capture/v9"; });
  rewrite(f, corrupt.name, () => "{not json");
  const old = new Date(Date.now() - 8 * 86400_000); utimesSync(join(spool(f.base), unknown.name), old, old);
  const result = await drain(f);
  expect(result.rows.map(row => row.excerpt)).toEqual(["known"]);
  expect(result.captured).toEqual([known.name]);
  expect(pending(f.base)).toEqual([]);
  const drops = readCaptureDrops(f.base);
  expect(drops.readable && drops.counts).toEqual({ unknown_schema_expired: 1 });
});

test("AC3: a candidate row of an unknown kind is skipped and counted, not thrown", () => {
  const f = fixture();
  const store = new CandidateStore({ memoryDir: f.base });
  try {
    const id = store.put({ kind: "memory", project: f.project, text: "a known candidate" }, "public");
    const db = new Database(join(f.base, "candidates.db"));
    try { db.query("INSERT INTO candidates (id, project, kind, payload, at, status) VALUES (?, ?, 'future-kind', ?, ?, 'pending')").run("f".repeat(64), f.project, JSON.stringify({ kind: "future-kind", project: f.project, x: 1 }), Date.now()); }
    finally { db.close(); }
    expect(store.list({ project: f.project }).map(candidate => candidate.id)).toEqual([id]);
    expect(store.get("f".repeat(64), f.project)).toBeUndefined();
    expect(store.skippedUnknownKinds).toBe(2);
  } finally { store.close(); }
});
