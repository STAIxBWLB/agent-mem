import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applySetup, planSetup, undoSetup, type SetupContext } from "../src/setup.ts";
import { realPath } from "../src/memory/platform.ts";

// #176: amem setup gemini (Gemini CLI 0.61.0). Native `gemini mcp add --scope user` in a private staging HOME,
// MCP only, never Antigravity's ~/.gemini/config/mcp_config.json.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function put(file: string, text: string, mode = 0o600) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, mode); }
const text = (file: string) => readFileSync(file, "utf8");
const bytes = (file: string) => existsSync(file) ? readFileSync(file).toString("base64") : null;
interface Call { argv: string[]; env: Record<string, string | undefined>; cwd: string }
function fixture(extra: Record<string, string | undefined> = {}) {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-setup-gemini-"))); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const calls: Call[] = [];
  const env = { HOME: home, AMEM_HOME: join(home, "memory"), ...extra };
  // Emulates gemini 0.61.0 add/remove: it rewrites <GEMINI_CLI_HOME>/.gemini/settings.json mcpServers.
  const native: NonNullable<SetupContext["native"]> = (argv, staged, cwd) => {
    calls.push({ argv: [...argv], env: { ...staged }, cwd });
    const file = join(staged.GEMINI_CLI_HOME!, ".gemini", "settings.json"), doc = existsSync(file) ? JSON.parse(text(file)) : {};
    doc.mcpServers ??= {};
    if (argv[2] === "remove") delete doc.mcpServers.amem;
    else { const marker = argv.indexOf("--"); doc.mcpServers.amem = { command: argv[marker - 1], args: argv.slice(marker + 1) }; }
    put(file, JSON.stringify(doc, null, 2) + "\n");
  };
  const options: SetupContext = { env, bun: process.execPath, entry: join(home, "pkg dir", "bin", "amem.js"), native };
  const settings = join(home, ".gemini", "settings.json"), antigravity = join(home, ".gemini", "config", "mcp_config.json");
  return { home, env, options, calls, settings, antigravity, plan: (mode: "preview" | "apply" | "undo" = "preview") => planSetup("gemini", mode, options) };
}

test("preview: one user settings file, native registration planned, MCP only, Antigravity untouched", () => {
  const f = fixture(), action = f.plan().actions[0]!;
  expect(action.files).toEqual([f.settings]);
  expect(action.registration).toEqual(["gemini", "mcp", "add", "--scope", "user", "--transport", "stdio", "amem", f.options.bun!, "--", "--smol", f.options.entry!, "mcp"]);
  expect(action.hooks).toEqual([]); expect(action.lifecycle).toContain("MCP only");
  expect(f.plan().notes.join("\n")).toContain("mcp_config.json is never touched");
  expect(f.calls).toEqual([]); expect(existsSync(f.settings)).toBe(false);
});

test("apply registers through the native CLI in a private HOME, preserves unrelated settings, and undo restores bytes", () => {
  const f = fixture();
  const original = '{\n  "ui": {"theme": "keep"},\n  "mcpServers": {"playwright": {"command": "npx", "args": ["x"]}},\n  "hooks": {"AfterTool": [{"hooks": [{"type": "command", "command": "user-hook"}]}]}\n}\n';
  put(f.settings, original, 0o640);
  const agy = '{"mcpServers":{"antigravity":{"command":"keep"}}}\n'; put(f.antigravity, agy, 0o640);
  expect(applySetup(f.plan("apply"), f.options)).toEqual({ applied: ["gemini"], unchanged: [] });
  expect(f.calls.map(call => call.argv.slice(0, 3))).toEqual([["gemini", "mcp", "add"]]);
  const staged = f.calls[0]!;
  expect(staged.cwd).not.toBe(f.home); expect(staged.env.HOME).toBe(staged.cwd); expect(staged.env.GEMINI_CLI_HOME).toBe(staged.cwd);
  expect(staged.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(join(staged.cwd, "gemini-system-settings.json"));
  expect(existsSync(staged.cwd)).toBe(false);
  const installed = JSON.parse(text(f.settings));
  expect(installed.mcpServers.amem).toEqual({ command: f.options.bun, args: ["--smol", f.options.entry, "mcp"] });
  expect(installed.mcpServers.playwright).toEqual({ command: "npx", args: ["x"] });
  expect(installed.ui).toEqual({ theme: "keep" }); expect(installed.hooks.AfterTool[0].hooks[0].command).toBe("user-hook");
  expect(text(f.antigravity)).toBe(agy);
  expect(lstatSync(f.settings).mode & 0o777).toBe(0o640);
  const applied = text(f.settings);
  expect(applySetup(f.plan("apply"), f.options)).toEqual({ applied: [], unchanged: ["gemini"] });
  expect(text(f.settings)).toBe(applied); expect(f.calls).toHaveLength(1);
  expect(undoSetup(f.plan("undo"), f.options)).toEqual({ restored: ["gemini"] });
  expect(text(f.settings)).toBe(original); expect(text(f.antigravity)).toBe(agy);
});

test("an existing amem entry is removed natively before add; JSONC settings are refused before any native call", () => {
  const f = fixture(); put(f.settings, JSON.stringify({ mcpServers: { amem: { command: "old", args: ["old"] } } }) + "\n");
  applySetup(f.plan("apply"), f.options);
  expect(f.calls.map(call => call.argv)).toEqual([["gemini", "mcp", "remove", "--scope", "user", "amem"], expect.arrayContaining(["add"])]);
  const g = fixture(); put(g.settings, '{\n  // comment\n  "ui": {}\n}\n'); const before = bytes(g.settings);
  expect(() => applySetup(g.plan("apply"), g.options)).toThrow("does not parse as a JSON object");
  expect(g.calls).toEqual([]); expect(bytes(g.settings)).toBe(before);
});

test("GEMINI_CLI_HOME moves the settings file and must be absolute; $ placeholders in runtime paths are refused", () => {
  const custom = fixture(); const elsewhere = join(custom.home, "gemini home");
  const moved = { ...custom.options, env: { ...custom.env, GEMINI_CLI_HOME: elsewhere } };
  expect(planSetup("gemini", "preview", moved).actions[0]!.files).toEqual([join(elsewhere, ".gemini", "settings.json")]);
  applySetup(planSetup("gemini", "apply", moved), moved);
  expect(JSON.parse(text(join(elsewhere, ".gemini", "settings.json"))).mcpServers.amem.command).toBe(custom.options.bun);
  expect(existsSync(custom.settings)).toBe(false);
  for (const value of ["relative", "~/g"]) expect(() => planSetup("gemini", "preview", { ...custom.options, env: { ...custom.env, GEMINI_CLI_HOME: value } })).toThrow("absolute GEMINI_CLI_HOME");
  // Only a selected gemini target refuses it: the shared context must not break other targets (claude preview/undo).
  const other = { ...custom.options, env: { ...custom.env, GEMINI_CLI_HOME: "relative" } };
  for (const mode of ["preview", "undo"] as const) expect(planSetup("claude", mode, other).actions.map(action => action.target)).toEqual(["claude"]);
  expect(() => undoSetup(planSetup("claude", "undo", other), other)).not.toThrow();
  expect(() => planSetup("gemini", "undo", other)).toThrow("absolute GEMINI_CLI_HOME");
  const placeholder = fixture(); placeholder.options.entry = join(placeholder.home, "$HOME", "amem.js");
  expect(() => placeholder.plan("apply")).toThrow("$VAR");
  expect(placeholder.calls).toEqual([]);
});
