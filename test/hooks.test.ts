import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMetrics } from "../src/memory/capacity.ts";
import { runHook } from "../src/hooks.ts";
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

for (const event of hookEvents) test(`actual CLI hook ${event} accepts agent markers and appends bounded project capture`, () => {
  const f = fixture(), result = f.run(event, { prompt: "p3 public prompt", tool_name: "Read", tool_input: { file_path: "src/public.ts" }, tool_response: "p3 tool result", last_assistant_message: "p3 assistant answer" });
  expect(result.exitCode).toBe(0); contextOnly(result.stdout.toString());
  const rows = f.rows(); expect(rows.some(row => row.event === event && row.project === f.project)).toBe(true);
  expect(rows.every(row => Buffer.byteLength(row.excerpt) <= 8000 && row.paths.length <= 32)).toBe(true);
  const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
  expect(metric).toBeDefined(); expect(Number.isFinite(metric?.wallMs)).toBe(true); expect(metric!.wallMs!).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(metric?.rssMB)).toBe(true); expect(metric!.rssMB!).toBeGreaterThan(0);
});

test("SessionStart returns only bounded untrusted context with known open work and coverage", async () => {
  const f = fixture(); await f.seed();
  const result = f.run("SessionStart"), stdout = result.stdout.toString(); expect(result.exitCode).toBe(0); contextOnly(stdout);
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

test("hook exception never admits ordinary agent-marked CLI reads or writes", () => {
  const f = fixture();
  for (const args of [["--help"], ["list", "--json"], ["note", "forbidden"]]) {
    const result = Bun.spawnSync([process.execPath, hookBin, ...args], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(result.exitCode).toBe(1); expect(result.stderr.toString()).toContain("person");
  }
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
    const captured = await runHook("PostToolUse", { tool_name: "Read", tool_response: "public library capture" }, { cwd: f.cwd, base: f.base });
    expect(captured).toEqual({ captured: true, skipped: false });
    const before = f.rows().length;
    const skipped = await runHook("SessionStart", { prompt: "public host fixture" }, { cwd: f.cwd, base: f.base, policy: { host: { screen: async () => true } } });
    expect(skipped).toEqual({ captured: false, skipped: true });
    let getterCalls = 0;
    const input = Object.defineProperty({}, "prompt", { enumerable: true, get() { getterCalls++; return "private getter"; } });
    expect((await runHook("PostToolUse", input, { cwd: f.cwd, base: f.base })).skipped).toBe(true);
    expect(getterCalls).toBe(0); expect(f.rows()).toHaveLength(before);
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
});
