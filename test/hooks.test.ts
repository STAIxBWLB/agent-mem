import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMetrics } from "../src/memory/capacity.ts";
import { hookMain, runHook } from "../src/hooks.ts";
import { drainHookCaptures, stageHookCapture } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { CONFIG_FILE } from "../src/memory/config.ts";
import { hookBin, hookEvents, hookFixture, workMarker } from "./fakes/hooks-fixture.ts";
const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const fixture = () => { const f = hookFixture(); fixtures.push(f); return f; };
function contextOnly(stdout: string) {
  if (!stdout.trim()) return;
  const output: unknown = JSON.parse(stdout);
  const inspect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      expect(["decision", "permissionDecision", "updatedInput", "block"].includes(key)).toBe(false);
      if (key === "continue") expect(child).not.toBe(false);
      inspect(child);
    }
  };
  inspect(output); expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(8192);
}

interface AcceptedCapture { event: string; excerpt: string }
function pendingCaptures(f: ReturnType<typeof hookFixture>, item: AcceptedCapture) {
  const dir = join(f.base, "hook-spool");
  if (!existsSync(dir)) return [];
  const matches = [dir, join(dir, ".capacity")].flatMap(folder => existsSync(folder) ? readdirSync(folder)
    .filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))
    .map(name => JSON.parse(readFileSync(join(folder, name), "utf8"))) : [])
    .filter(value => value.schema === "agent-mem.hook-capture/v1" && value.cwd === f.cwd && value.capture?.event === item.event && value.capture?.excerpt === item.excerpt);
  for (const value of matches) {
    expect(value.capture.agent).toBe("claude"); expect(Number.isFinite(Date.parse(value.capture.at))).toBe(true);
    expect(Array.isArray(value.capture.paths)).toBe(true); expect(value.capture.paths.length).toBeLessThanOrEqual(32);
    expect(Number.isFinite(value.capture.bytes)).toBe(true); expect(Buffer.byteLength(value.capture.excerpt)).toBeLessThanOrEqual(8000);
  }
  return matches;
}
function replayThroughHooks(f: ReturnType<typeof hookFixture>, accepted: AcceptedCapture[]) {
  const barriers: AcceptedCapture[] = []; let rows = f.rows();
  const matching = (item: AcceptedCapture) => rows.filter(row => row.event === item.event && row.excerpt === item.excerpt && row.project === f.project);
  // Functional accepted work drives replay. The final barrier itself may still be durably pending.
  for (let i = 0; i < 4; i++) {
    const excerpt = `p3 replay barrier ${i}`, result = f.runFunctional("PostToolUse", { prompt: excerpt });
    expect(result.exitCode).toBe(0);
    contextOnly(result.stdout.toString());
    barriers.push({ event: "PostToolUse", excerpt }); rows = f.rows();
    if (accepted.every(item => matching(item).length === 1 && pendingCaptures(f, item).length === 0)) break;
  }
  for (const item of accepted) {
    expect(matching(item)).toHaveLength(1); expect(pendingCaptures(f, item)).toHaveLength(0);
  }
  // The original exactly-once row above is the positive control; a new barrier may remain pending.
  for (const item of barriers) {
    const saved = matching(item), pending = pendingCaptures(f, item);
    expect(saved.length).toBeLessThanOrEqual(1); expect(pending.length).toBeLessThanOrEqual(1);
    expect(saved.length === 1 || pending.length === 1).toBe(true);
    // A committed row can retain its same-time acknowledgement claim until the next replay.
    if (saved.length && pending.length) expect(saved[0]!.at).toBe(pending[0]!.capture.at);
  }

  return rows;
}


for (const event of hookEvents) test(`actual CLI hook ${event} accepts agent markers and appends bounded project capture`, () => {
  const f = fixture(), excerpt = `p3 original ${event} capture`;
  const result = f.run(event, { prompt: excerpt, tool_name: "Read", tool_input: { file_path: "src/public.ts" }, tool_response: excerpt, last_assistant_message: excerpt });
  expect(result.exitCode).toBe(0); contextOnly(result.stdout.toString());
  const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
  expect(metric).toBeDefined(); expect(Number.isFinite(metric?.wallMs)).toBe(true); expect(metric!.wallMs!).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(metric?.rssMB)).toBe(true); expect(metric!.rssMB!).toBeGreaterThan(0);
  expect(readMetrics(f.base).filter(row => row.kind === "hook")).toHaveLength(1);
  const expectedExcerpt = ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event) ? `src/public.ts\n${excerpt}` : excerpt;
  const rows = replayThroughHooks(f, [{ event, excerpt: expectedExcerpt }]);
  expect(rows.every(row => Buffer.byteLength(row.excerpt) <= 8000 && row.paths.length <= 32)).toBe(true);
});

test("SessionStart returns only bounded untrusted context with known open work and coverage", async () => {
  const f = fixture(); await f.seed();
  const result = f.runFunctional("SessionStart"), stdout = result.stdout.toString(); expect(result.exitCode).toBe(0); contextOnly(stdout);
  const output = JSON.parse(stdout), context = output.hookSpecificOutput?.additionalContext;
  expect(output.hookSpecificOutput?.hookEventName).toBe("SessionStart"); expect(typeof context).toBe("string");
  expect(context).toContain(workMarker); expect(context).toContain("Untrusted project memory"); expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1200);
  expect(context).toMatch(/coverage|complete|partial/i);
});

test("hook failure and invalid input fail open without capture or control fields", () => {
  const f = fixture();
  for (const [event, input] of [["UnknownEvent", {}], ["sessionstart", {}], ["PostToolUse", "{"], ["PostToolUse", "[]"], ["PostToolUse", "null"], ["PostToolUse", "x".repeat(2 * 1024 * 1024)], ["PostToolUse", { cwd: join(f.root, "foreign") }]] as const) {
    const result = f.run(event, input); expect(result.exitCode).toBe(0); contextOnly(result.stdout.toString());
  }
  expect(f.rows()).toHaveLength(0);
  expect(readMetrics(f.base).filter(row => row.kind === "hook")).toHaveLength(7);
  const blocker = join(f.root, "not-directory"); writeFileSync(blocker, "fixture");
  const result = f.run("PostToolUse", {}, { AMEM_HOME: blocker }); expect(result.exitCode).toBe(0); contextOnly(result.stdout.toString());
});

test("private flags and secret-bearing metadata or tool input cannot enter hook capture", () => {
  const f = fixture(), secret = "sk-" + "synthetic".repeat(9);
  for (const payload of [{ private: true }, { pii: true }, { metadata: { private: true } }, { tool_input: { pii: true } }, { metadata: { api_key: secret } }, { tool_input: { command: `curl -H 'Authorization: Bearer ${secret}' https://example.invalid` } }]) {
    const result = f.run("PostToolUse", { ...payload, prompt: "p3 private marker" }); expect(result.exitCode).toBe(0); contextOnly(result.stdout.toString());
  }
  expect(JSON.stringify(f.rows())).not.toContain("p3 private marker"); expect(JSON.stringify(f.rows())).not.toContain(secret);
});

test("native hook capture stays separate while marked CLI reads are screened and note writers keep peer attribution", async () => {
  const f = fixture(); await f.seed();
  const privateMarker = "P3-CLI-PRIVATE-CONTROL";
  const seed = new MemoryStore({ home: f.root, screen: () => "keep" });
  seed.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "contract", peer: "fixture", text: privateMarker, about: [], source: "person" });
  seed.close();
  writeFileSync(join(f.base, CONFIG_FILE), JSON.stringify({ piiPatterns: [privateMarker] }));
  const run = (args: string[], env: NodeJS.ProcessEnv = f.env) => Bun.spawnSync([process.execPath, hookBin, ...args], { cwd: f.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3000 });

  const read = run(["list", "--json"]);
  expect(read.exitCode).toBe(0); expect(read.stderr.toString()).toBe("");
  expect(read.stdout.toString()).toContain("p3 curated public fixture"); expect(read.stdout.toString()).not.toContain(privateMarker);
  const history = run(["list", "--history"]);
  expect(history.exitCode).toBe(1); expect(history.stderr.toString()).toContain("agent-marked list accepts only --limit and --since.");

  const unmarkedEnv = { ...f.env }; delete unmarkedEnv.CLAUDECODE;
  const unmarked = run(["list", "--json"], unmarkedEnv);
  expect(unmarked.exitCode).toBe(0); expect(unmarked.stdout.toString()).toContain(privateMarker);

  const added = run(["note", "add", "p3 agent attributed note", "--json"]);
  expect(added.exitCode).toBe(0); expect(added.stderr.toString()).toBe("");
  const id = (JSON.parse(added.stdout.toString()) as { id: string }).id;
  const check = new MemoryStore({ home: f.root });
  try { expect(check.get(id, f.project)).toMatchObject({ peer: "claude", text: "p3 agent attributed note", source: "person" }); }
  finally { check.close(); }
});

test("packaged plugin wires exactly the supported hooks through the actual CLI", () => {
  const root = join(import.meta.dir, ".."), manifest = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  expect(typeof manifest.name).toBe("string");
  const hooks = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8")).hooks;
  expect(Object.keys(hooks).sort()).toEqual([...hookEvents].sort());
  for (const event of hookEvents) {
    const commands = hooks[event].flatMap((entry: { hooks: { type: string; command: string }[] }) => entry.hooks);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) { expect(command.type).toBe("command"); expect(command.command).toContain("${CLAUDE_PLUGIN_ROOT}"); expect(command.command).toContain("bin/amem.js"); expect(command.command).toContain(`hook ${event}`); }
  }
  const files: string[] = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files;
  expect(files).toContain(".claude-plugin/"); expect(files).toContain("hooks/");
});


test("library hook intake preserves the policy boundary and skips unsupported host callbacks", async () => {
  const f = fixture(), oldHome = process.env.HOME;
  process.env.HOME = f.env.HOME;
  try {
    const captured = await runHook("PostToolUse", { tool_name: "Read", tool_response: "public library capture" }, { cwd: f.cwd, base: f.base }, { deadlineMs: 2000 });
    if (captured.captured) expect(captured).toEqual({ captured: true, skipped: false });
    else expect(captured).toMatchObject({ captured: false, pending: true });
    expect(readMetrics(f.base).filter(row => row.kind === "hook")).toHaveLength(1);
    replayThroughHooks(f, [{ event: "PostToolUse", excerpt: "public library capture" }]);
    const before = f.rows().length;
    const skipped = await runHook("SessionStart", { prompt: "public host fixture" }, { cwd: f.cwd, base: f.base, policy: { host: { screen: async () => true } } }, { deadlineMs: 2000 });
    expect(skipped).toEqual({ captured: false, skipped: true });
    let getterCalls = 0;
    const input = Object.defineProperty({}, "prompt", { enumerable: true, get() { getterCalls++; return "private getter"; } });
    expect((await runHook("PostToolUse", input, { cwd: f.cwd, base: f.base }, { deadlineMs: 2000 })).skipped).toBe(true);
    expect(getterCalls).toBe(0); expect(f.rows()).toHaveLength(before);
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
});


test("SessionStart preserves known open work while a durable capture backlog awaits replay", async () => {
  const f = fixture(); await f.seed();
  const accepted: AcceptedCapture[] = [], oldHome = process.env.HOME;
  process.env.HOME = f.env.HOME;
  try {
    for (let i = 0; i < 64; i++) {
      const excerpt = `p3 pending backlog ${i}`;
      expect(await stageHookCapture("PostToolUse", { cwd: f.cwd, prompt: excerpt }, { cwd: f.cwd, base: f.base })).toBeDefined();
      accepted.push({ event: "PostToolUse", excerpt });
    }
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
  const excerpt = "p3 SessionStart with pending backlog", result = f.runFunctional("SessionStart", { prompt: excerpt });
  expect(result.exitCode).toBe(0); contextOnly(result.stdout.toString());
  const output = JSON.parse(result.stdout.toString()), context = output.hookSpecificOutput?.additionalContext;
  expect(output.hookSpecificOutput?.hookEventName).toBe("SessionStart");
  expect(context).toContain(workMarker); expect(context).toContain("Untrusted project memory");
  expect(context).toMatch(/coverage/); expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1200);
  expect(readMetrics(f.base).filter(row => row.kind === "hook")).toHaveLength(1);
  accepted.push({ event: "SessionStart", excerpt });
  // Every original must be retained by the native call before the explicit replay barrier.
  const retained = f.rows();
  for (const item of accepted) expect(retained.filter(row => row.event === item.event && row.excerpt === item.excerpt).length + pendingCaptures(f, item).length).toBe(1);
  // This is a correctness test, not a promise that four scheduler-limited hooks drain 65 rows.
  // Await the same production drain; the actual executable's R2 workload remains separately strict.
  process.env.HOME = f.env.HOME;
  let store: CaptureStore | undefined;
  try {
    store = new CaptureStore({ memoryDir: f.base, project: f.project });
    for (let pass = 0; pass < 3; pass++) await drainHookCaptures({ cwd: f.cwd, base: f.base, project: f.project }, (input, receipt) => store!.append(input, { receipt }));
  } finally { store?.close(); if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
  replayThroughHooks(f, accepted);
});


test("host-only hook deadline validates explicit programmatic values before intake", async () => {
  const f = fixture();
  for (const deadlineMs of [0, -1, 1.5, NaN, Infinity, 10_001]) {
    await expect(hookMain([], performance.now(), { deadlineMs })).rejects.toThrow("invalid hook host deadline");
    await expect(runHook("PostToolUse", {}, { cwd: f.cwd, base: f.base }, { deadlineMs })).rejects.toThrow("invalid hook host deadline");
  }
});
