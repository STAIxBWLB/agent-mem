import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { stageHookCapture, drainHookCaptures, hookCaptureScope } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { appendAlias, resolveAlias } from "../src/memory/aliases.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { runHook } from "../src/hooks.ts";
const clean: (() => void)[] = [], home = process.env.HOME;
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
function fixture() {
  const f = hookFixture(); clean.push(f.close); process.env.HOME = f.env.HOME;
  const options = { cwd: f.cwd, base: f.base };
  const pending = () => [join(f.base, "hook-spool"), join(f.base, "hook-spool", ".capacity")].flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name)).map(name => JSON.parse(readFileSync(join(dir, name), "utf8"))) : []);
  return { ...f, options, pending };
}
async function drain(f: ReturnType<typeof fixture>, project = f.project) {
  const store = new CaptureStore({ memoryDir: f.base, project });
  try { await drainHookCaptures({ ...f.options, project }, (input, receipt) => store.append(input, { receipt })); return store.rows({ project }); }
  finally { store.close(); }
}

test("alias publication and shard selectors do not invalidate pending capture", async () => {
  const f = fixture(); const scope = hookCaptureScope(f.cwd, f.base);
  await stageHookCapture("PostToolUse", { prompt: "before alias" }, f.options);
  appendAlias(f.base, { alias: f.project, key: "fixture/canonical", actor: "person", machine: "fixture" });
  writeFileSync(join(f.base, "profile.json"), "{}"); writeFileSync(join(f.base, "shards.json"), "{}");
  expect(hookCaptureScope(f.cwd, f.base)).toBe(scope);
  const rows = await drain(f, resolveAlias(f.base, f.project));
  expect(rows.map(row => row.excerpt)).toEqual(["before alias"]); expect(f.pending()).toHaveLength(0);
});

test("unknown scope stays pending across admissions and adopts a later resolved physical root exactly once", async () => {
  const f = fixture(), config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
  writeFileSync(config, original + '\n[include]\n path = unavailable-config\n');
  expect(hookCaptureScope(f.cwd, f.base)).toBeUndefined();
  for (const prompt of ["unknown one", "unknown two"]) await stageHookCapture("PostToolUse", { prompt }, f.options);
  expect(f.pending()).toHaveLength(2);
  expect(f.pending().every(row => row.scope === null && typeof row.root === "string")).toBe(true);
  expect((await drain(f))).toHaveLength(0); expect(f.pending()).toHaveLength(2);
  expect(existsSync(join(f.base, "hook-spool", ".quarantine"))).toBe(false);
  writeFileSync(config, original);
  expect((await drain(f)).map(row => row.excerpt).sort()).toEqual(["unknown one", "unknown two"]);
  expect((await drain(f))).toHaveLength(2); expect(f.pending()).toHaveLength(0);
});

test("a transient unreadable scope cannot quarantine either old or newly staged work", async () => {
  const f = fixture(), config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
  await stageHookCapture("PostToolUse", { prompt: "before transient" }, f.options);
  writeFileSync(config, original + '\n[user]\n name = "unfinished\n');
  expect(hookCaptureScope(f.cwd, f.base)).toBeUndefined();
  await stageHookCapture("PostToolUse", { prompt: "during transient" }, f.options);
  expect((await drain(f))).toHaveLength(0); expect(f.pending()).toHaveLength(2);
  writeFileSync(config, original);
  expect((await drain(f)).map(row => row.excerpt).sort()).toEqual(["before transient", "during transient"]);
  expect(f.pending()).toHaveLength(0);
});

test("both full tiers preserve old events and report each dropped current event in receipt, metric and brief", async () => {
  const a = fixture(), b = fixture(); process.env.HOME = a.env.HOME;
  await a.seed();
  for (let i = 0; i < 288; i++) await stageHookCapture("PostToolUse", { prompt: `foreign ${i}` }, { cwd: b.cwd, base: a.base, deferAtCapacity: true });
  expect(a.pending()).toHaveLength(288);
  const result = await runHook("SessionStart", { prompt: "over capacity" }, a.options, { deadlineMs: 2000 });
  expect(result).toMatchObject({ captured: false, dropped: true, dropReason: "spool_full", dropCount: 1 });
  expect(result.output?.hookSpecificOutput.additionalContext).toContain("capture dropped: spool full (1)");
  expect(result.output?.hookSpecificOutput.additionalContext).toContain("p3-work-marker");
  expect(a.pending()).toHaveLength(288); expect(a.pending().some(row => row.capture.excerpt === "over capacity")).toBe(false);
  expect(readMetrics(a.base).filter(row => row.captureDrops).map(row => row.captureDrops)).toEqual([1]);
  const cli = a.runFunctional("PreToolUse", { prompt: "CLI over capacity" });
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout.toString())).toMatchObject({ captured: false, dropped: true, dropReason: "spool_full", dropCount: 1 });
  expect(readMetrics(a.base).filter(row => row.captureDrops).map(row => row.captureDrops)).toEqual([1, 1]);
  expect(existsSync(join(a.base, "hook-spool", ".quarantine"))).toBe(false);
});

test("SessionStart can return known work while unsupported Git syntax leaves capture retryable", async () => {
  const f = fixture(); await f.seed();
  const config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
  writeFileSync(config, original + '\n[include]\n path = optional-nonexistent-config\n');
  const answer = f.runFunctional("SessionStart", { prompt: "unknown scope brief" });
  expect(answer.exitCode).toBe(0);
  expect(answer.stdout.length).toBeGreaterThan(0);
  expect(JSON.parse(answer.stdout.toString()).hookSpecificOutput.additionalContext).toContain("p3-work-marker");
  expect(f.pending().filter(row => row.capture.excerpt === "unknown scope brief")).toHaveLength(1);
  expect(existsSync(join(f.base, "hook-spool", ".quarantine"))).toBe(false);
  writeFileSync(config, original);
  expect((await drain(f)).filter(row => row.excerpt === "unknown scope brief")).toHaveLength(1);
});


test("a null-scope event never adopts a replacement physical cwd", async () => {
  const f = fixture(), config = join(f.cwd, ".git", "config");
  writeFileSync(config, readFileSync(config, "utf8") + '\n[include]\n path = unavailable-config\n');
  await stageHookCapture("PostToolUse", { prompt: "old physical root" }, f.options);
  renameSync(f.cwd, f.cwd + "-old"); mkdirSync(f.cwd);
  const init = Bun.spawnSync(["git", "init", "--quiet", f.cwd], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(init.exitCode).toBe(0);
  let appended = false;
  await drainHookCaptures({ ...f.options, project: "replacement/project" }, () => { appended = true; return { id: 1 }; });
  expect(appended).toBe(false); expect(f.pending()).toHaveLength(1);
  expect(existsSync(join(f.base, "hook-spool", ".quarantine"))).toBe(false);
});
