import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applySetup, planSetup, undoSetup, type SetupContext } from "../src/setup.ts";
import { realPath } from "../src/memory/platform.ts";

// #176: amem setup opencode (OpenCode 1.18.35). Direct, MCP-only edit of the global strict-JSON opencode.json.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
interface Image { bytes: string | null; mode: number }
function put(file: string, text: string, mode = 0o600) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, mode); }
const text = (file: string) => readFileSync(file, "utf8");
const image = (file: string): Image => existsSync(file) ? { bytes: readFileSync(file).toString("base64"), mode: lstatSync(file).mode & 0o777 } : { bytes: null, mode: 0o600 };
function fixture(extra: Record<string, string | undefined> = {}) {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-setup-opencode-"))); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const calls: string[][] = [];
  const env = { HOME: home, AMEM_HOME: join(home, "memory"), XDG_CONFIG_HOME: join(home, ".config"), ...extra };
  const options: SetupContext = { env, bun: process.execPath, entry: join(home, "pkg", "bin", "amem.js"), native: argv => { calls.push([...argv]); } };
  const file = join(home, ".config", "opencode", "opencode.json");
  return { home, env, options, file, calls, plan: (mode: "preview" | "apply" | "undo" = "preview") => planSetup("opencode", mode, options) };
}
const server = (f: ReturnType<typeof fixture>) => ({ type: "local", command: [f.options.bun, "--smol", f.options.entry, "mcp"], enabled: true });

test("preview inventories one global file, MCP only, no native command, hook or plugin", () => {
  const f = fixture(), action = f.plan().actions[0]!;
  expect(action.files).toEqual([f.file]);
  expect(action.registration).toBeNull(); expect(action.commands).toEqual([]); expect(action.hooks).toEqual([]);
  expect(action.lifecycle).toContain("MCP only"); expect(action.mcpChange).toBe("add");
  expect(f.plan().notes.join("\n")).toContain("No plugin or ingest hook is installed");
  expect(existsSync(f.file)).toBe(false); expect(existsSync(join(f.home, "memory"))).toBe(false);
});

test("apply owns only mcp.amem, keeps unrelated bytes, is idempotent and undo restores the exact original", () => {
  const f = fixture();
  const original = '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "keep/model",\n  "mcp": {"playwright":{"type":"local","command":["npx","x"],"enabled":false}},\n  "big": 9007199254740993\n}\n';
  put(f.file, original, 0o640);
  expect(applySetup(f.plan("apply"), f.options)).toEqual({ applied: ["opencode"], unchanged: [] });
  expect(f.calls).toEqual([]);
  const installed = text(f.file), parsed = JSON.parse(installed);
  expect(parsed.mcp.amem).toEqual(server(f));
  expect(parsed.mcp.playwright).toEqual({ type: "local", command: ["npx", "x"], enabled: false });
  expect(installed).toContain('"big": 9007199254740993'); expect(installed).toContain('"model": "keep/model"');
  expect(lstatSync(f.file).mode & 0o777).toBe(0o640);
  const receipt = join(f.home, "memory", "setup", "opencode.json");
  expect(lstatSync(receipt).mode & 0o077).toBe(0);
  expect(applySetup(f.plan("apply"), f.options)).toEqual({ applied: [], unchanged: ["opencode"] });
  expect(text(f.file)).toBe(installed);
  expect(undoSetup(f.plan("undo"), f.options)).toEqual({ restored: ["opencode"] });
  expect(text(f.file)).toBe(original); expect(lstatSync(f.file).mode & 0o777).toBe(0o640);
});

test("an absent config is created and undo removes it again", () => {
  const f = fixture();
  applySetup(f.plan("apply"), f.options);
  expect(JSON.parse(text(f.file))).toEqual({ mcp: { amem: server(f) } });
  undoSetup(f.plan("undo"), f.options);
  expect(existsSync(f.file)).toBe(false);
});

test("undo preserves later unrelated edits and refuses a changed managed entry", () => {
  const f = fixture(); put(f.file, '{"mcp":{"other":{"type":"remote","url":"https://example.invalid"}},"theme":"a"}\n');
  applySetup(f.plan("apply"), f.options);
  put(f.file, text(f.file).replace('"theme":"a"', '"theme":"b"'));
  undoSetup(f.plan("undo"), f.options);
  expect(JSON.parse(text(f.file))).toEqual({ mcp: { other: { type: "remote", url: "https://example.invalid" } }, theme: "b" });

  const g = fixture(); applySetup(g.plan("apply"), g.options);
  const edited = text(g.file).replace('"enabled":true', '"enabled":false'); put(g.file, edited);
  expect(() => undoSetup(g.plan("undo"), g.options)).toThrow("changed");
  expect(text(g.file)).toBe(edited);
});

test("unsupported layouts are refused before any write: JSONC, merged siblings, env routes, symlinks", () => {
  const jsonc = fixture(); put(jsonc.file, '{ // comment\n "mcp": {} }\n'); const jsoncBefore = image(jsonc.file);
  expect(() => applySetup(jsonc.plan("apply"), jsonc.options)).toThrow("does not parse as a JSON object");
  expect(image(jsonc.file)).toEqual(jsoncBefore);
  for (const sibling of ["opencode.jsonc", "config.json"]) {
    const f = fixture(); put(join(dirname(f.file), sibling), "{}\n");
    expect(() => f.plan()).toThrow(sibling);
    expect(existsSync(f.file)).toBe(false);
  }
  for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"]) {
    const f = fixture({ [key]: key === "OPENCODE_CONFIG_CONTENT" ? "{}" : "/somewhere" });
    expect(() => f.plan("apply")).toThrow(key);
    expect(existsSync(f.file)).toBe(false);
  }
  const placeholder = fixture(); placeholder.options.entry = join(placeholder.home, "{env:HOME}", "amem.js");
  expect(() => placeholder.plan("apply")).toThrow("{env:}");
  const linked = fixture(), real = join(linked.home, "real-opencode"); mkdirSync(real, { recursive: true }); mkdirSync(join(linked.home, ".config"), { recursive: true });
  symlinkSync(real, join(linked.home, ".config", "opencode"));
  expect(() => linked.plan("apply")).toThrow("symbolic-link");
  expect(existsSync(join(real, "opencode.json"))).toBe(false);
});

test("the config path uses an absolute XDG_CONFIG_HOME literally, ~/.config when unset or empty, and refuses a relative value", () => {
  const xdg = fixture(); const custom = join(xdg.home, "xdg");
  expect(planSetup("opencode", "preview", { ...xdg.options, env: { ...xdg.env, XDG_CONFIG_HOME: custom } }).actions[0]!.files).toEqual([join(custom, "opencode", "opencode.json")]);
  // xdg-basedir does not trim: a trailing space names a different directory, and setup must follow it exactly.
  const spacedHome = fixture(), spaced = join(spacedHome.home, "config ");
  const spacedOptions = { ...spacedHome.options, env: { ...spacedHome.env, XDG_CONFIG_HOME: spaced } };
  expect(planSetup("opencode", "preview", spacedOptions).actions[0]!.files).toEqual([`${spaced}/opencode/opencode.json`]);
  applySetup(planSetup("opencode", "apply", spacedOptions), spacedOptions);
  expect(existsSync(`${spaced}/opencode/opencode.json`)).toBe(true); expect(existsSync(join(spacedHome.home, "config", "opencode", "opencode.json"))).toBe(false);
  for (const value of [undefined, ""]) {
    const env = { ...xdg.env, XDG_CONFIG_HOME: value };
    expect(planSetup("opencode", "preview", { ...xdg.options, env }).actions[0]!.files).toEqual([join(xdg.home, ".config", "opencode", "opencode.json")]);
  }
  for (const value of ["relative/xdg", " ", "~/cfg"]) {
    for (const mode of ["preview", "apply", "undo"] as const) expect(() => planSetup("opencode", mode, { ...xdg.options, env: { ...xdg.env, XDG_CONFIG_HOME: value } })).toThrow("absolute XDG_CONFIG_HOME");
  }
});
