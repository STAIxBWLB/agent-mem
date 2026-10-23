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

test("unknown scope stays pending and never adopts a later resolved project", async () => {
  const f = fixture(), config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
  writeFileSync(config, original + '\n[user]\n name = "unfinished\n');
  expect(hookCaptureScope(f.cwd, f.base)).toBeUndefined();
  for (const prompt of ["unknown one", "unknown two"]) await stageHookCapture("PostToolUse", { prompt }, f.options);
  expect(f.pending()).toHaveLength(2);
  expect(f.pending().every(row => row.scope === null && typeof row.root === "string")).toBe(true);
  expect((await drain(f))).toHaveLength(0); expect(f.pending()).toHaveLength(2);
  expect(existsSync(join(f.base, "hook-spool", ".quarantine"))).toBe(false);
  writeFileSync(config, original);
  expect((await drain(f))).toHaveLength(0); expect(f.pending()).toHaveLength(2);
});

test("a transient unreadable scope cannot quarantine either old or newly staged work", async () => {
  const f = fixture(), config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
  await stageHookCapture("PostToolUse", { prompt: "before transient" }, f.options);
  writeFileSync(config, original + '\n[user]\n name = "unfinished\n');
  expect(hookCaptureScope(f.cwd, f.base)).toBeUndefined();
  await stageHookCapture("PostToolUse", { prompt: "during transient" }, f.options);
  expect((await drain(f))).toHaveLength(0); expect(f.pending()).toHaveLength(2);
  writeFileSync(config, original);
  expect((await drain(f)).map(row => row.excerpt)).toEqual(["before transient"]);
  expect(f.pending().map(row => row.capture.excerpt)).toEqual(["during transient"]);
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
  expect(result.output?.hookSpecificOutput.additionalContext.split("\n")[0]).toStartWith("Untrusted project memory data");
  expect(a.pending()).toHaveLength(288); expect(a.pending().some(row => row.capture.excerpt === "over capacity")).toBe(false);
  expect(readMetrics(a.base).filter(row => row.captureDrops).map(row => row.captureDrops)).toEqual([1]);
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]) {
    const cli = a.runFunctional(event, { prompt: "CLI over capacity" });
    expect(cli.exitCode).toBe(0); expect(cli.stdout.toString()).toBe("");
  }
  const cli = a.runFunctional("SessionStart", { prompt: "CLI full brief" });
  expect(cli.exitCode).toBe(0);
  const output = JSON.parse(cli.stdout.toString());
  expect(Object.keys(output)).toEqual(["hookSpecificOutput"]);
  expect(Object.keys(output.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
  expect(output.hookSpecificOutput.additionalContext.split("\n")[0]).toStartWith("Untrusted project memory data");
  expect(output.hookSpecificOutput.additionalContext).toContain("capture dropped: spool full");
  expect(readMetrics(a.base).filter(row => row.captureDropReason === "spool_full").map(row => row.captureDrops)).toEqual(Array(8).fill(1));
  expect(existsSync(join(a.base, "hook-spool", ".quarantine"))).toBe(false);
});

test("SessionStart common includes still return known work and replay capture", async () => {
  const f = fixture(); await f.seed();
  const config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
  writeFileSync(config, original + '\n[include]\n path = optional-nonexistent-config\n');
  const answer = f.runFunctional("SessionStart", { prompt: "unknown scope brief" });
  expect(answer.exitCode).toBe(0);
  expect(answer.stdout.length).toBeGreaterThan(0);
  expect(JSON.parse(answer.stdout.toString()).hookSpecificOutput.additionalContext).toContain("p3-work-marker");
  expect(f.pending().filter(row => row.capture.excerpt === "unknown scope brief")).toHaveLength(1);
  expect(existsSync(join(f.base, "hook-spool", ".quarantine"))).toBe(false);
  expect((await drain(f)).filter(row => row.excerpt === "unknown scope brief")).toHaveLength(1);
  writeFileSync(config, original);
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

function agePending(f: ReturnType<typeof fixture>, days: number) {
  for (const dir of [join(f.base, "hook-spool"), join(f.base, "hook-spool", ".capacity")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))) {
      const file = join(dir, name), value = JSON.parse(readFileSync(file, "utf8"));
      value.capture.at = new Date(Date.now() - days * 24 * 3600_000).toISOString();
      writeFileSync(file, JSON.stringify(value));
    }
  }
}
const losses = (f: ReturnType<typeof fixture>, reason: string) => readMetrics(f.base).filter(row => row.captureDropReason === reason).reduce((n,row) => n + (row.captureDrops ?? 0), 0);

test("null scope never rebinds, stays pending before seven days and expires with a counted reason", async () => {
  const f = fixture(), config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
  writeFileSync(config, original + '\n[user]\n name = "unfinished\n');
  await stageHookCapture("PostToolUse", { prompt: "unknown old identity" }, f.options);
  agePending(f, 6); writeFileSync(config, original);
  await stageHookCapture("PostToolUse", { prompt: "fresh known identity" }, f.options);
  const rows = await drain(f);
  expect(rows.map(row => row.excerpt)).toEqual(["fresh known identity"]);
  expect(f.pending().map(row => row.capture.excerpt)).toEqual(["unknown old identity"]);
  expect(losses(f, "scope_unknown")).toBe(0);
  agePending(f, 8);
  await stageHookCapture("PostToolUse", { prompt: "expiry maintenance" }, f.options);
  expect(f.pending().some(row => row.capture.excerpt === "unknown old identity")).toBe(false);
  expect(losses(f, "scope_unknown")).toBe(1);
  expect((await drain(f)).some(row => row.excerpt === "unknown old identity")).toBe(false);
});

test("a stale non-null scope expires with a numeric receipt and the brief keeps its untrusted header first", async () => {
  const f = fixture(); await f.seed();
  await stageHookCapture("PostToolUse", { prompt: "old scoped body" }, f.options); agePending(f, 8);
  const config = join(f.cwd, ".git", "config");
  writeFileSync(config, readFileSync(config, "utf8") + '\n[remote "origin"]\n url = https://example.invalid/retarget/project.git\n');
  const result = await runHook("SessionStart", { prompt: "current brief" }, f.options, { deadlineMs: 2000 });
  // Admission can defer maintenance when it fits; the next ordinary intake owns bounded retirement.
  await stageHookCapture("PostToolUse", { prompt: "ordinary maintenance" }, f.options);
  expect(losses(f, "undrainable_expired")).toBe(1);
  const shown = await runHook("SessionStart", { prompt: "notice brief" }, f.options, { deadlineMs: 2000 });
  const context = shown.output!.hookSpecificOutput.additionalContext;
  expect(context.split("\n")[0]).toStartWith("Untrusted project memory data");
  expect(context).toContain("capture dropped: undrainable expired (1)");
  expect(context).not.toContain("old scoped body");
});

test("removed cwds retire with counts even behind a healthy first maintenance slice", async () => {
  const a = fixture(), b = fixture(), removed = fixture(); process.env.HOME = a.env.HOME;
  for (let i = 0; i < 40; i++) await stageHookCapture("PostToolUse", { prompt: `healthy foreign ${i}` }, { cwd: b.cwd, base: a.base });
  await stageHookCapture("PostToolUse", { prompt: "removed body canary" }, { cwd: removed.cwd, base: a.base });
  renameSync(removed.cwd, removed.cwd + "-gone");
  for (let i = 0; i < 3 && !losses(a, "cwd_removed"); i++) await stageHookCapture("PostToolUse", { prompt: `maintenance ${i}` }, a.options);
  expect(losses(a, "cwd_removed")).toBe(1);
  expect(a.pending().some(row => row.capture.excerpt === "removed body canary")).toBe(false);
  expect(a.pending().filter(row => row.cwd === b.cwd)).toHaveLength(40);
});

test("an unavailable drop metric never authorizes deletion of an expired body", async () => {
  const f = fixture(); await stageHookCapture("PostToolUse", { prompt: "must remain without receipt" }, f.options); agePending(f, 8);
  const config = join(f.cwd, ".git", "config");
  writeFileSync(config, readFileSync(config, "utf8") + '\n[remote "origin"]\n url = https://example.invalid/retarget/project.git\n');
  mkdirSync(join(f.base, "metrics.jsonl"));
  await stageHookCapture("PostToolUse", { prompt: "new input" }, f.options);
  expect(f.pending().some(row => row.capture.excerpt === "must remain without receipt")).toBe(true);
});
