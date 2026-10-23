import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drainHookCaptures, hookCapturePending, hookCaptureScope, stageHookCapture } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [], originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) f.close();
});
function fixture(remote?: string) {
  const f = hookFixture(remote); fixtures.push(f); process.env.HOME = f.env.HOME;
  const options = { cwd: f.cwd, base: f.base };
  return { ...f, options,
    pending() {
      const dir = join(f.base, "hook-spool");
      return existsSync(dir) ? readdirSync(dir).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))
        .map(name => ({ name, value: JSON.parse(readFileSync(join(dir, name), "utf8")) })) : [];
    },
  };
}

test("pending hook stages contain bounded normalized capture fields, never the raw native envelope", async () => {
  const f = fixture();
  const staged = await stageHookCapture("PreToolUse", { cwd: f.cwd, hook_event_name: "PreToolUse", prompt: "public retained excerpt", metadata: { rawEnvelopeMarker: "RAW_ENVELOPE_NOT_CAPTURED" }, tool_name: "Read", tool_input: { file_path: "src/public.ts", command: "RAW_COMMAND_NOT_CAPTURED" } }, f.options);
  expect(staged).toBeDefined(); expect(hookCapturePending(f.base, staged!.name)).toBe(true);
  const rows = f.pending(); expect(rows).toHaveLength(1);
  expect(rows[0]!.value.capture).toMatchObject({ agent: "claude", event: "PreToolUse", tool: "Read", paths: ["src/public.ts"], status: "ok", excerpt: "public retained excerpt" });
  expect(Number.isFinite(Date.parse(rows[0]!.value.capture.at))).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("RAW_ENVELOPE_NOT_CAPTURED"); expect(JSON.stringify(rows)).not.toContain("RAW_COMMAND_NOT_CAPTURED");
  expect(rows[0]!.value).not.toHaveProperty("input"); expect(rows[0]!.value).not.toHaveProperty("tool_input");
});

test("complete-input private flags and secret metadata are refused before any pending stage", async () => {
  const f = fixture();
  for (const input of [{ private: true }, { metadata: { pii: true } }, { tool_input: { private: true } }, { metadata: { api_key: "sk-" + "synthetic".repeat(9) } }]) {
    expect(await stageHookCapture("PostToolUse", { ...input, cwd: f.cwd, prompt: "must not persist" }, f.options)).toBeUndefined();
  }
  expect(f.pending()).toEqual([]); expect(existsSync(join(f.base, "hook-spool"))).toBe(false);
});

test("PostToolUseFailure stages and drains the actual error excerpt with failed status", async () => {
  const f = fixture(), error = { message: "synthetic public tool failure", exit_code: 7 };
  const staged = await stageHookCapture("PostToolUseFailure", { cwd: f.cwd, hook_event_name: "PostToolUseFailure", error, tool_response: "must not replace error", prompt: "must not replace error either" }, f.options);
  expect(staged).toBeDefined(); expect(f.pending()[0]!.value.capture).toMatchObject({ status: "failed", excerpt: JSON.stringify(error) });
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    const result = await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }));
    expect(result.captured).toEqual([staged!.name]);
    expect(store.rows()).toHaveLength(1); expect(store.rows()[0]).toMatchObject({ project: f.project, event: "PostToolUseFailure", status: "failed", excerpt: JSON.stringify(error) });
  } finally { store.close(); }
});

test("a committed capture with lost acknowledgement retries its stable receipt exactly once", async () => {
  const f = fixture(), staged = await stageHookCapture("PostToolUse", { cwd: f.cwd, prompt: "durable exactly-once marker" }, f.options);
  expect(staged).toBeDefined(); const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    let committed = false;
    const first = await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => {
      store.append(input, { receipt }); committed = true; throw new Error("lost acknowledgement fixture");
    });
    expect(committed).toBe(true); expect(first.captured).toEqual([]); expect(first.blocked).toBe(1);
    expect(store.rows()).toHaveLength(1); expect(hookCapturePending(f.base, staged!.name)).toBe(true);
    const next = await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }));
    expect(next.captured).toEqual([staged!.name]); expect(store.rows()).toHaveLength(1);
    expect(hookCapturePending(f.base, staged!.name)).toBe(false);
    expect((await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }))).captured).toEqual([]);
    expect(store.rows()).toHaveLength(1);
  } finally { store.close(); }
});

test("foreign cwd and changed physical cwd cannot attach a retained event to a new project", async () => {
  const f = fixture(), foreign = join(f.root, "foreign"); mkdirSync(foreign);
  expect(await stageHookCapture("PostToolUse", { cwd: foreign, prompt: "foreign" }, f.options)).toBeUndefined();
  const staged = await stageHookCapture("PostToolUse", { cwd: f.cwd, prompt: "original cwd marker" }, f.options); expect(staged).toBeDefined();
  renameSync(f.cwd, join(f.root, "old-project")); mkdirSync(f.cwd);
  let appended = false;
  const result = await drainHookCaptures({ ...f.options, project: "foreign/project" }, () => { appended = true; return { id: 1 }; });
  expect(result.captured).toEqual([]); expect(appended).toBe(false); expect(hookCapturePending(f.base, staged!.name)).toBe(true);
});

test("changed Git control scope stays pending instead of attaching to the newly resolved project", async () => {
  const f = fixture(), config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
  const staged = await stageHookCapture("PostToolUse", { cwd: f.cwd, prompt: "original scope marker" }, f.options); expect(staged).toBeDefined();
  appendFileSync(config, '\n[remote "origin"]\n url = https://example.invalid/foreign/project.git\n');
  let appended = false;
  const result = await drainHookCaptures({ ...f.options, project: "example.invalid/foreign/project" }, () => { appended = true; return { id: 1 }; });
  expect(result.captured).toEqual([]); expect(appended).toBe(false); expect(hookCapturePending(f.base, staged!.name)).toBe(true);
  writeFileSync(config, original);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    expect((await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }))).captured).toEqual([staged!.name]);
    expect(store.rows()).toHaveLength(1); expect(store.rows()[0]!.project).toBe(f.project);
  } finally { store.close(); }
});

test("the exact pending-file cap remains drainable without eviction", async () => {
  const f = fixture();
  for (let i = 0; i < 256; i++) expect(await stageHookCapture("PostToolUse", { prompt: `bounded pending ${i}` }, f.options)).toBeDefined();
  await expect(stageHookCapture("PostToolUse", { prompt: "over cap" }, f.options)).rejects.toThrow("hook storage full");
  const result = await drainHookCaptures({ ...f.options, project: f.project }, () => ({ id: 1 }));
  expect(result.captured).toHaveLength(32); expect(f.pending()).toHaveLength(224);
});

test("an already expired hook deadline still publishes durable capture before optional work", async () => {
  const f = fixture();
  const { runHook } = await import("../src/hooks.ts");
  const receipt = await runHook("PostToolUse", { prompt: "expired deadline retained" }, { ...f.options, startedAt: performance.now() - 1000 });
  expect(receipt).toMatchObject({ captured: false, pending: true });
  const pending = f.pending();
  expect(pending).toHaveLength(1); expect(pending[0]!.value.capture.excerpt).toBe("expired deadline retained");
  expect(f.rows()).toHaveLength(0);
});


test("native hooks recover a full pending tier before publishing the next event", async () => {
  const f = fixture();
  for (let i = 0; i < 256; i++) await stageHookCapture("PostToolUse", { prompt: `backlog ${i}` }, f.options);
  const result = f.run("PostToolUse", { prompt: "full queue follow-up" });
  expect(result.exitCode).toBe(0);
  const rows = f.rows(), pending = f.pending();
  expect(rows.length).toBeGreaterThan(0); expect(pending.length).toBeLessThanOrEqual(256);
  expect(rows.filter(row => row.excerpt === "full queue follow-up").length + pending.filter(row => row.value.capture.excerpt === "full queue follow-up").length).toBe(1);
});

test("a project resolution stamp cannot admit newer stages after an origin changes", async () => {
  const f = fixture(), expectedScope = hookCaptureScope(f.cwd, f.base);
  expect(expectedScope).toBeDefined();
  appendFileSync(join(f.cwd, ".git", "config"), '\n[remote "origin"]\n url = https://example.invalid/new/project.git\n');
  const pending = await stageHookCapture("PostToolUse", { prompt: "new scope only" }, f.options);
  expect(pending).toBeDefined(); expect(hookCaptureScope(f.cwd, f.base)).not.toBe(expectedScope);
  let appended = false;
  const result = await drainHookCaptures({ ...f.options, project: f.project, expectedScope }, () => { appended = true; return { id: 1 }; });
  expect(result.captured).toEqual([]); expect(appended).toBe(false); expect(hookCapturePending(f.base, pending!.name)).toBe(true);
});

function git(f: ReturnType<typeof fixture>, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", f.cwd, ...args], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

test("checkout and return preserve a pending event's semantic project scope", async () => {
  const f = fixture();
  git(f, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "initial");
  const branch = git(f, "symbolic-ref", "--short", "HEAD");
  const staged = await stageHookCapture("PostToolUse", { prompt: "checkout roundtrip marker" }, f.options);
  expect(staged).toBeDefined();
  const scope = hookCaptureScope(f.cwd, f.base);
  git(f, "checkout", "--quiet", "-b", "temporary-scope-branch");
  git(f, "checkout", "--quiet", branch);
  expect(hookCaptureScope(f.cwd, f.base)).toBe(scope);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    expect((await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }))).captured).toEqual([staged!.name]);
    expect(store.rows().map(row => row.excerpt)).toEqual(["checkout roundtrip marker"]);
  } finally { store.close(); }
});

test("rewriting config with the same origin and unrelated settings does not strand pending capture", async () => {
  const f = fixture("https://example.invalid/team/semantic.git"), config = join(f.cwd, ".git", "config");
  const staged = await stageHookCapture("PostToolUse", { prompt: "same origin rewrite marker" }, f.options);
  expect(staged).toBeDefined();
  const scope = hookCaptureScope(f.cwd, f.base), original = readFileSync(config, "utf8");
  writeFileSync(config + ".replacement", original + '\n# cosmetic rewrite\n[user]\n name = Different Fixture\n');
  renameSync(config + ".replacement", config);
  expect(hookCaptureScope(f.cwd, f.base)).toBe(scope);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    expect((await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }))).captured).toEqual([staged!.name]);
    expect(store.rows().map(row => row.excerpt)).toEqual(["same origin rewrite marker"]);
  } finally { store.close(); }
});

test("removed cwd records leave the active cap privately and cannot become a replacement project's capture", async () => {
  const f = fixture(), removed = join(f.cwd, "removed-worktree"); mkdirSync(removed);
  const staged = await stageHookCapture("PostToolUse", { cwd: removed, prompt: "removed cwd private canary" }, { ...f.options, cwd: removed });
  expect(staged).toBeDefined(); rmSync(removed, { recursive: true });
  const current = await stageHookCapture("PostToolUse", { prompt: "healthy current marker" }, f.options);
  expect(current).toBeDefined();
  expect(f.pending().some(row => row.value.cwd === removed)).toBe(false);
  const quarantine = join(f.base, "hook-spool", ".quarantine");
  expect(existsSync(quarantine)).toBe(true);
  expect(statSync(quarantine).mode & 0o777).toBe(0o700);
  const held = readdirSync(quarantine);
  expect(held.length).toBeGreaterThan(0); expect(held.length).toBeLessThanOrEqual(256);
  expect(held.reduce((bytes, name) => bytes + statSync(join(quarantine, name)).size, 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
  for (const name of held) expect(statSync(join(quarantine, name)).mode & 0o777).toBe(0o600);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }));
    expect(store.rows().map(row => row.excerpt)).toEqual(["healthy current marker"]);
  } finally { store.close(); }
});

test("256 orphaned cwd records cannot disable actual hooks in another healthy cwd", async () => {
  const f = fixture(), removed = join(f.cwd, "orphaned-worktree"); mkdirSync(removed);
  for (let index = 0; index < 256; index++) {
    expect(await stageHookCapture("PostToolUse", { cwd: removed, prompt: `orphan canary ${index}` }, { ...f.options, cwd: removed })).toBeDefined();
  }
  expect(f.pending()).toHaveLength(256);
  rmSync(removed, { recursive: true });
  const first = f.run("PostToolUse", { prompt: "healthy after orphan cap" });
  expect(first.exitCode).toBe(0);
  for (let pass = 0; pass < 4 && !f.rows().some(row => row.excerpt === "healthy after orphan cap"); pass++) {
    expect(f.run("PostToolUse", { prompt: `healthy recovery barrier ${pass}` }).exitCode).toBe(0);
  }
  expect(f.rows().filter(row => row.excerpt === "healthy after orphan cap")).toHaveLength(1);
  expect(f.rows().some(row => row.excerpt.startsWith("orphan canary"))).toBe(false);
  expect(f.pending().length).toBeLessThan(256);
  const held = readdirSync(join(f.base, "hook-spool", ".quarantine"));
  expect(held.length).toBeGreaterThan(0); expect(held.length).toBeLessThanOrEqual(256);
  expect(held.reduce((bytes, name) => bytes + statSync(join(f.base, "hook-spool", ".quarantine", name)).size, 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
}, 20000);
