import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applySetup, planSetup, undoSetup, type SetupContext, type SetupPlan, type SetupTarget } from "../src/setup.ts";
import { realPath } from "../src/memory/platform.ts";

// #203: jcode [hooks] in <JCODE_HOME>/config.toml. Jcode has no native MCP command, so no stub CLI is needed.
type Image = { bytes: string | null; mode: number };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const run of cleanup.splice(0)) run(); });
function put(file: string, text: string, mode = 0o600) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, mode); }
const text = (file: string) => readFileSync(file, "utf8");
function image(file: string): Image { return existsSync(file) ? { bytes: readFileSync(file).toString("base64"), mode: lstatSync(file).mode & 0o777 } : { bytes: null, mode: 0o600 }; }
function restore(file: string, value: Image) { if (value.bytes === null) rmSync(file, { force: true }); else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(value.bytes, "base64")); chmodSync(file, value.mode); } }
function fixture() {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-setup-jcode-"))); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const env: Record<string, string | undefined> = { HOME: home, AMEM_HOME: join(home, "memory"), JCODE_HOME: join(home, ".jcode"), XDG_CONFIG_HOME: join(home, ".config") };
  const calls: unknown[] = [], entry = join(home, "package with space", "bin", "amem.js"), bun = process.execPath;
  const options: SetupContext = { env, bun, entry, native: argv => { calls.push(argv); } };
  const plan = (target = "jcode", mode: SetupPlan["mode"] = "preview") => planSetup(target, mode, options);
  const file = (target: SetupTarget, index = 0) => plan(target).actions[0]!.files[index]!;
  const receiptFile = (target: SetupTarget) => plan(target).actions[0]!.receipt;
  const receipt = (target: SetupTarget) => JSON.parse(text(receiptFile(target))) as { changes: unknown[] };
  return { home, env, calls, entry, bun, options, plan, file, receiptFile, receipt };
}
function seedOther(f: ReturnType<typeof fixture>) { put(f.file("jcode"), JSON.stringify({ servers: { other: { command: "other-server", args: ["keep"] } } }, null, 2) + "\n"); }

test("Jcode setup registers MCP and capture hooks, keeps a user turn_end command and restores config.toml byte for byte", () => {
  const f = fixture(); seedOther(f);
  const config = join(f.env.JCODE_HOME!, "config.toml");
  const original = 'model = "keep"  # comment\n\n[hooks]\nturn_end = "/user/bin/notify --flag"\nsession_end = "user-existing-hook"\n\n[other]\nk = 1\n';
  put(config, original, 0o640);
  const action = f.plan("jcode", "apply").actions[0]!, file = action.files[0]!, before = image(file), hookBefore = image(config);
  expect(action.files).toEqual([join(f.env.JCODE_HOME!, "mcp.json"), config]);
  expect(action.registration).toBeNull(); expect(action.commands).toEqual([]);
  const command = `'${f.bun}' --smol '${f.entry}' hook jcode`;
  expect(action.hooks).toEqual([{ event: "post_tool", command, timeout: 1 }, { event: "turn_end", command, timeout: 1 }]);
  expect(action.lifecycle).toContain("post_tool and turn_end");
  expect(f.plan("jcode").notes.join("\n")).toContain("JCODE_HOOK_CWD");
  expect(image(config)).toEqual(hookBefore);   // preview writes nothing
  expect(applySetup(f.plan("jcode", "apply"), f.options)).toEqual({ applied: ["jcode"], unchanged: [] });
  expect(f.calls).toEqual([]);
  const hooks = (Bun.TOML.parse(text(config)) as { hooks: Record<string, unknown> }).hooks;
  expect(hooks.turn_end).toEqual(["/user/bin/notify --flag", command]);   // the user's command keeps running
  expect(hooks.post_tool).toBe(command); expect(hooks.session_end).toBe("user-existing-hook");
  expect(text(config)).toStartWith('model = "keep"  # comment\n'); expect(text(config)).toContain("[other]\nk = 1\n");
  expect(image(config).mode).toBe(0o640);
  const installed = JSON.parse(text(file));
  expect(installed.servers.amem).toEqual({ command: f.bun, args: ["--smol", f.entry, "mcp"], shared: false });
  expect(installed.servers.other).toEqual({ command: "other-server", args: ["keep"] });
  expect(f.receipt("jcode").changes).toHaveLength(2);
  expect(lstatSync(f.receiptFile("jcode")).mode & 0o077).toBe(0);
  const applied = image(file), appliedConfig = image(config);
  expect(applySetup(f.plan("jcode", "apply"), f.options)).toEqual({ applied: [], unchanged: ["jcode"] });
  expect(image(file)).toEqual(applied); expect(image(config)).toEqual(appliedConfig);
  undoSetup(f.plan("jcode", "undo"), f.options);
  expect(image(file)).toEqual(before); expect(image(config)).toEqual(hookBefore);
});

test("Jcode hook undo after unrelated edits removes only amem's command and keeps the user's edits", () => {
  const f = fixture(); const config = join(f.env.JCODE_HOME!, "config.toml");
  put(config, '[hooks]\nturn_end = "/user/notify"\n', 0o600);
  applySetup(f.plan("jcode", "apply"), f.options);
  put(config, text(config).replace("[hooks]\n", "[hooks]\nsession_start = \"/user/later\"\n"), 0o600);
  undoSetup(f.plan("jcode", "undo"), f.options);
  const hooks = (Bun.TOML.parse(text(config)) as { hooks: Record<string, unknown> }).hooks;
  expect(hooks).toEqual({ session_start: "/user/later", turn_end: "/user/notify" });
  // A config.toml that did not exist is removed again on an untouched undo.
  const g = fixture(), absent = join(g.env.JCODE_HOME!, "config.toml");
  applySetup(g.plan("jcode", "apply"), g.options); expect(existsSync(absent)).toBe(true);
  undoSetup(g.plan("jcode", "undo"), g.options); expect(existsSync(absent)).toBe(false);
});

test("a pre-#203 MCP-only jcode receipt upgrades to hooks and still undoes both files", () => {
  const f = fixture(); seedOther(f); const file = f.file("jcode"), config = join(f.env.JCODE_HOME!, "config.toml"), mcpBefore = image(file);
  applySetup(f.plan("jcode", "apply"), f.options); undoSetup(f.plan("jcode", "undo"), f.options);
  // Emulate the 0.17 receipt: one change, the old intent.
  const legacyAfter = { bytes: Buffer.from(JSON.stringify({ servers: { other: { command: "other-server", args: ["keep"] }, amem: { command: f.bun, args: ["--smol", f.entry, "mcp"], shared: false } } }, null, 2) + "\n").toString("base64"), mode: 0o600 };
  restore(file, legacyAfter);
  writeFileSync(f.receiptFile("jcode"), JSON.stringify({ version: 1, target: "jcode", intent: "0".repeat(64), phase: "applied", changes: [{ key: "jcode:0", path: file, before: mcpBefore, after: legacyAfter }] }) + "\n", { mode: 0o600 });
  expect(f.plan("jcode").actions[0]!.state).toContain("runtime changed");
  expect(applySetup(f.plan("jcode", "apply"), f.options).applied).toEqual(["jcode"]);
  expect(f.receipt("jcode").changes).toHaveLength(2);
  expect(text(config)).toContain("hook jcode");
  undoSetup(f.plan("jcode", "undo"), f.options);
  expect(image(file)).toEqual(mcpBefore); expect(existsSync(config)).toBe(false);
});

