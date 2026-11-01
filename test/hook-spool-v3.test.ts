import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { drainHookCaptures, stageHookCapture } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";

// #203 under the #199 contract: the published 0.18.0 is the N-1 reader. It drains format 2 and retires any record it cannot decode,
// so a jcode row (agent `jcode`, unknown to 0.18.0) must publish where 0.18.0 does not look: format 3 under `hook-v3-`.
const clean: (() => void)[] = [];
const oldHome = process.env.HOME;
afterEach(() => { process.env.HOME = oldHome; for (const close of clean.splice(0)) close(); });
function fixture() {
  const f = hookFixture(); clean.push(f.close); process.env.HOME = f.env.HOME;
  return { ...f, options: { cwd: f.cwd, base: f.base } };
}
const spool = (base: string) => join(base, "hook-spool");
const pending = (base: string) => existsSync(spool(base)) ? readdirSync(spool(base)).filter(name => name.startsWith("hook-")).sort() : [];
async function drain(f: ReturnType<typeof fixture>) {
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try { const r = await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt })); return { ...r, rows: store.rows({ project: f.project }) }; }
  finally { store.close(); }
}
const v018 = pathToFileURL(resolve(import.meta.dir, "../node_modules/@staix/agent-mem-v018/src/hook-spool.ts")).href;
/** 0.18.0 runs one ordinary hook: home-wide maintenance via stageHookCapture, then its drain for the same cwd. */
function runV018(f: ReturnType<typeof fixture>, excerpt: string) {
  const script = `const { drainHookCaptures, stageHookCapture } = await import(${JSON.stringify(v018)});
const options = { cwd: ${JSON.stringify(f.cwd)}, base: ${JSON.stringify(f.base)} };
await stageHookCapture("PostToolUse", { tool_name: "Read", tool_response: ${JSON.stringify(excerpt)} }, options);
const appended = [];
const r = await drainHookCaptures({ ...options, project: ${JSON.stringify(f.project)} }, (input) => { appended.push(input.agent + ":" + input.excerpt); return { id: 1 }; });
console.log(JSON.stringify({ captured: r.captured.length, appended }));`;
  const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: f.cwd, env: { ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString()) as { captured: number; appended: string[] };
}

test("a jcode record is format 3 under hook-v3-; Claude records stay format 2 under hook-v2-", async () => {
  const f = fixture();
  const jcode = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "jcode row" }, { ...f.options, agent: "jcode" }))!;
  const claude = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "claude row" }, f.options))!;
  expect(jcode.name).toMatch(/^hook-v3-[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{32}\.json$/);
  expect(claude.name).toMatch(/^hook-v2-[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{32}\.json$/);
  expect(JSON.parse(readFileSync(join(spool(f.base), jcode.name), "utf8"))).toMatchObject({ schema: "agent-mem.hook-capture", format: 3, capture: { agent: "jcode" } });
  expect(JSON.parse(readFileSync(join(spool(f.base), claude.name), "utf8"))).toMatchObject({ schema: "agent-mem.hook-capture", format: 2, capture: { agent: "claude" } });
});

test("N-1: 0.18.0 maintenance and drain leave a pending jcode record alone; this version then drains it as agent jcode", async () => {
  const f = fixture();
  const staged = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "jcode pending row" }, { ...f.options, agent: "jcode" }))!;
  // 0.18.0 drains its own (format-2 Claude) record and does not touch the format-3 file.
  expect(runV018(f, "old-version record")).toEqual({ captured: 1, appended: ["claude:old-version record"] });
  expect(pending(f.base)).toEqual([staged.name]);
  const result = await drain(f);
  expect(result.rows.filter(row => row.excerpt === "jcode pending row").map(row => row.agent)).toEqual(["jcode"]);
  expect(pending(f.base)).toEqual([]);
});

test("N-1: 0.18.0 still drains a Claude record this version stages (format 2 is unchanged)", async () => {
  const f = fixture();
  await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "claude from new version" }, f.options);
  const result = runV018(f, "barrier");
  expect(result.appended).toContain("claude:claude from new version");
  expect(pending(f.base)).toEqual([]);
});

test("a hook-spool format floor above this version skips the spool and leaves a pending format-3 record untouched (#207)", async () => {
  const f = fixture();
  const staged = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "jcode before floor" }, { ...f.options, agent: "jcode" }))!;
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "hook-spool", minReader: "99.0.0", since: "2026-11-01" }]));
  expect(await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "jcode under floor" }, { ...f.options, agent: "jcode" })).toBeUndefined();
  const result = await drain(f);
  expect(result.rows).toEqual([]);
  expect(pending(f.base)).toEqual([staged.name]);
  // Floors gate the surface by reader version, not the record format: removing the floor drains the same v3 record.
  writeFileSync(join(f.base, "formats.json"), "[]");
  expect((await drain(f)).rows.filter(row => row.excerpt === "jcode before floor").map(row => row.agent)).toEqual(["jcode"]);
});

test("the format and agent must agree: a jcode capture in a format-2 body, or a claude capture in format 3, is not drained", async () => {
  const f = fixture();
  const jcode = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "mislabelled jcode" }, { ...f.options, agent: "jcode" }))!;
  const claude = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "mislabelled claude" }, f.options))!;
  const flip = (name: string, format: number, prefix: string) => {
    const file = join(spool(f.base), name), body = JSON.parse(readFileSync(file, "utf8"));
    body.format = format; writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    renameSync(file, join(spool(f.base), name.replace(/^hook-v[23]-/, prefix)));
  };
  flip(jcode.name, 2, "hook-v2-"); flip(claude.name, 3, "hook-v3-");
  const result = await drain(f);
  expect(result.rows.some(row => row.excerpt.startsWith("mislabelled"))).toBe(false);
});
