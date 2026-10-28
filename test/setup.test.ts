import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applySetup, planSetup, runSetup, SETUP_ALL_TARGETS, undoSetup, type SetupContext, type SetupPlan, type SetupTarget } from "../src/setup.ts";
import { SETUP_CONFIG_BYTES } from "../src/setup-toml.ts";
import { memoryGitEnv, memoryGitSync, realPath } from "../src/memory/platform.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
interface Call { argv: string[]; env: Record<string, string | undefined>; cwd: string }
interface Image { bytes: string | null; mode: number }
interface Receipt { version: number; target: string; intent: string; phase: "prepared" | "applied"; changes: Array<{ key: string; path: string; before: Image; after: Image }> }
function put(file: string, text: string, mode = 0o600) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, mode); }
const text = (file: string) => readFileSync(file, "utf8");
function image(file: string): Image { return existsSync(file) ? { bytes: readFileSync(file).toString("base64"), mode: lstatSync(file).mode & 0o777 } : { bytes: null, mode: 0o600 }; }
function restore(file: string, value: Image) { if (value.bytes === null) rmSync(file, { force: true }); else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(value.bytes, "base64")); chmodSync(file, value.mode); } }
function snapshot(root: string): Array<{ name: string; mode: number; bytes?: string; link?: string }> {
  const rows: Array<{ name: string; mode: number; bytes?: string; link?: string }> = [];
  const visit = (dir: string) => { for (const name of readdirSync(dir).sort()) { const file = join(dir, name), stat = lstatSync(file), value = { name: relative(root, file), mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) rows.push({ ...value, link: readlinkSync(file) });
    else if (stat.isDirectory()) { rows.push(value); visit(file); }
    else rows.push({ ...value, bytes: readFileSync(file).toString("base64") });
  } }; visit(root); return rows;
}
function fixture() {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-setup-test-"))); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const env: Record<string, string | undefined> = { HOME: home, AMEM_HOME: join(home, "memory"), CODEX_HOME: join(home, ".codex"), KIMI_CODE_HOME: join(home, ".kimi-code"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), QWEN_HOME: join(home, ".qwen"), JCODE_HOME: join(home, ".jcode") };
  const calls: Call[] = [], entry = join(home, "package with space", "bin", "amem.js"), bun = process.execPath;
  const native: NonNullable<SetupContext["native"]> = (argv, stagedEnv, cwd) => {
    calls.push({ argv: [...argv], env: { ...stagedEnv }, cwd });
    expect(stagedEnv.HOME).toBe(cwd); expect(cwd).not.toBe(home); expect(realPath(cwd)).toBe(cwd);
    const target = argv[0] as SetupTarget, remove = argv[2] === "remove", marker = argv.indexOf("--"), launch = target === "qwen" ? [argv[marker - 1], ...argv.slice(marker + 1)] : argv.slice(marker + 1);
    expect(["claude", "codex", "pi", "qwen"]).toContain(target);
    expect(argv.slice(1, 3)).toEqual(["mcp", remove ? "remove" : "add"]);
    const file = target === "claude" ? stagedEnv.CLAUDE_CONFIG_DIR ? join(stagedEnv.CLAUDE_CONFIG_DIR, ".claude.json") : join(cwd, ".claude.json")
      : target === "codex" ? join(stagedEnv.CODEX_HOME!, "config.toml") : target === "qwen" ? join(stagedEnv.QWEN_HOME!, "settings.json") : join(stagedEnv.PI_CODING_AGENT_DIR!, "mcp.json");
    if (target === "codex") {
      const source = existsSync(file) ? text(file) : "", kept: string[] = []; let skipping = false;
      for (const line of source.split("\n")) { if (/^\s*\[/.test(line)) skipping = /^\s*\[mcp_servers\.amem\]\s*$/.test(line); if (!skipping) kept.push(line); }
      const body = kept.join("\n");
      put(file, remove ? body : `${body}${body.endsWith("\n") || !body ? "" : "\n"}[mcp_servers.amem]\ncommand = ${JSON.stringify(launch[0])}\nargs = ${JSON.stringify(launch.slice(1))}\n`);
    } else {
      const document = existsSync(file) ? JSON.parse(text(file)) : {}, servers = document.mcpServers ?? {};
      if (remove) delete servers.amem; else servers.amem = { command: launch[0], args: launch.slice(1) };
      document.mcpServers = servers; put(file, JSON.stringify(document, null, 2) + "\n");
    }
  };
  const options: SetupContext = { env, bun, entry, native };
  const plan = (target = "all", mode: SetupPlan["mode"] = "preview") => planSetup(target, mode, options);
  const file = (target: SetupTarget, index = 0) => plan(target).actions[0]!.files[index]!;
  const receiptFile = (target: SetupTarget) => plan(target).actions[0]!.receipt;
  const receipt = (target: SetupTarget): Receipt => JSON.parse(text(receiptFile(target))) as Receipt;
  return { home, env, calls, entry, bun, options, plan, file, receiptFile, receipt };
}
function seedOtherFiles(f: ReturnType<typeof fixture>) {
  put(f.file("claude"), '{ "theme":"original", "mcpServers": {"other":{"command":"other-server","args":["keep"]}} }\n', 0o640);
  put(f.file("claude", 1), JSON.stringify({ enabledPlugins: { "other@catalog": true }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "existing-start" }] }] } }) + "\n", 0o640);
  put(f.file("codex"), '# original comment\nmodel = "fixture"\n[mcp_servers.other]\ncommand = "other-server"\nargs = ["keep"]\n', 0o640);
  put(f.file("codex", 1), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "existing-end" }] }], PostToolUse: [{ hooks: [{ type: "command", command: "existing-tool" }] }] } }) + "\n", 0o640);
  put(f.file("kimi"), JSON.stringify({ mcpServers: { other: { command: "other-server", args: ["keep"] } } }) + "\n", 0o640);
  put(f.file("kimi", 1), '# user config\nmodel = "fixture"\n[[hooks]]\nevent = "Stop"\ncommand = "existing-kimi"\n', 0o640);
  put(f.file("pi"), JSON.stringify({ mcpServers: { other: { command: "other-server", args: ["keep"] } } }) + "\n", 0o640);
  put(f.file("qwen"), JSON.stringify({ mcpServers: { other: { command: "other-server", args: ["keep"] } }, hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "existing-qwen" }] }] }, ui: { theme: "keep" } }) + "\n", 0o640);
  put(f.file("jcode"), '{ "servers": {"other":{"command":"other-server","args":["keep"]}}, "unrelated": {"keep":true} }\n', 0o640);
  const rules = ["AGENTS.md", "CLAUDE.md", ".claude/rules/keep.md", ".codex/rules/keep.rules", ".pi/agent/extensions/keep.ts"].map(name => join(f.home, name));
  for (const rule of rules) put(rule, "unrelated user content\n", 0o640);
  return rules;
}
const mcp = (file: string, target: SetupTarget) => target === "codex" ? (Bun.TOML.parse(text(file)) as Record<string, any>).mcp_servers : target === "jcode" ? JSON.parse(text(file)).servers : JSON.parse(text(file)).mcpServers;
test("setup preview inventories every target without commands, files or confirmation", async () => {
  const f = fixture(); seedOtherFiles(f); const before = snapshot(f.home), shown = f.plan();
  expect(shown.targets).toEqual([...SETUP_ALL_TARGETS]); expect(shown.mode).toBe("preview"); expect(shown.actions).toHaveLength(6);
  for (const action of shown.actions) { expect(action.files).toHaveLength(action.target === "qwen" || action.target === "jcode" ? 1 : 2); expect(action.receipt).toBe(join(f.home, "memory", "setup", `${action.target}.json`)); expect(action.state).toBe("not installed"); }
  expect(shown.actions.find(row => row.target === "kimi")?.registration).toBeNull();
  let confirmations = 0;
  const output = await runSetup("all", "preview", { ...f.options, stdinTTY: false, confirm: async () => { confirmations++; return true; } });
  expect(JSON.parse(output).targets).toEqual([...SETUP_ALL_TARGETS]); expect(confirmations).toBe(0); expect(f.calls).toEqual([]); expect(snapshot(f.home)).toEqual(before);
});
test("all-target apply stages native commands, records private receipts and is byte/mode-idempotent", () => {
  const f = fixture(), rules = seedOtherFiles(f), rulesBefore = rules.map(image), plan = f.plan("all", "apply");
  expect(applySetup(plan, f.options)).toEqual({ applied: [...SETUP_ALL_TARGETS], unchanged: [] });
  expect(f.calls.map(call => call.argv[0])).toEqual(["claude", "codex", "pi", "qwen"]);
  for (const call of f.calls) { expect(call.argv.slice(-5)).toEqual(call.argv[0] === "qwen" ? [f.bun, "--", "--smol", f.entry, "mcp"] : ["--", f.bun, "--smol", f.entry, "mcp"]); expect(existsSync(call.cwd)).toBe(false); expect(call.env.CODEX_HOME).toBe(join(call.cwd, ".codex")); expect(call.env.KIMI_CODE_HOME).toBe(join(call.cwd, ".kimi-code")); expect(call.env.PI_CODING_AGENT_DIR).toBe(join(call.cwd, ".pi", "agent")); }
  for (const target of SETUP_ALL_TARGETS) {
    const receipt = f.receipt(target), action = plan.actions.find(row => row.target === target)!;
    expect(receipt).toMatchObject({ version: 1, target, phase: "applied" }); expect(receipt.changes.map(change => change.path)).toEqual(action.files);
    expect(lstatSync(action.receipt).mode & 0o077).toBe(0); expect(lstatSync(dirname(action.receipt)).mode & 0o077).toBe(0);
    expect(mcp(f.file(target), target).amem).toEqual({ command: f.bun, args: ["--smol", f.entry, "mcp"], ...(target === "jcode" ? { shared: false } : {}) });
    expect(mcp(f.file(target), target).other).toEqual({ command: "other-server", args: ["keep"] });
  }
  const settings = JSON.parse(text(f.file("claude", 1))); expect(settings.enabledPlugins).toEqual({ "other@catalog": true }); expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("existing-start"); expect(Object.keys(settings.hooks)).toHaveLength(7);
  const codexHooks = JSON.parse(text(f.file("codex", 1))); expect(codexHooks.hooks.SessionEnd[0].hooks[0].command).toBe("existing-end"); expect(codexHooks.hooks.PostToolUse[0].hooks[0].command).toBe("existing-tool"); expect(codexHooks.hooks.SessionEnd).toHaveLength(2);
  expect(text(f.file("codex"))).toContain('# original comment\nmodel = "fixture"');
  const kimiHooks = (Bun.TOML.parse(text(f.file("kimi", 1))) as { hooks: Array<{ event: string; command: string }> }).hooks; expect(kimiHooks[0]?.command).toBe("existing-kimi"); expect(kimiHooks.filter(hook => hook.event === "SessionEnd")).toHaveLength(1);
  expect(text(f.file("pi", 1))).toContain("session_shutdown"); expect(text(f.file("pi", 1))).toContain(f.entry);
  expect(rules.map(image)).toEqual(rulesBefore);
  const beforeSecond = snapshot(f.home), calls = f.calls.length;
  expect(applySetup(f.plan("all", "apply"), f.options)).toEqual({ applied: [], unchanged: [...SETUP_ALL_TARGETS] }); expect(f.calls).toHaveLength(calls); expect(snapshot(f.home)).toEqual(beforeSecond);
});
test("undo restores original bytes, modes and missing files without touching unrelated rules", () => {
  const f = fixture(), rules = seedOtherFiles(f), plan = f.plan("all", "apply"), files = plan.actions.flatMap(action => action.files), originals = files.map(image), rulesBefore = rules.map(image);
  expect(originals.some(value => value.bytes === null)).toBe(true); applySetup(plan, f.options); const calls = f.calls.length;
  expect(undoSetup(f.plan("all", "undo"), f.options)).toEqual({ restored: [...SETUP_ALL_TARGETS] }); expect(files.map(image)).toEqual(originals); expect(rules.map(image)).toEqual(rulesBefore); expect(f.calls).toHaveLength(calls);
  for (const target of SETUP_ALL_TARGETS) expect(existsSync(f.receiptFile(target))).toBe(false);
});
test("existing amem registration is removed before add while other MCP entries survive", () => {
  const f = fixture(); seedOtherFiles(f);
  for (const target of ["claude", "pi", "qwen"] as const) { const file = f.file(target), document = JSON.parse(text(file)); document.mcpServers.amem = { command: "old-amem", args: ["old"] }; put(file, JSON.stringify(document)); }
  put(f.file("codex"), text(f.file("codex")) + '\n[mcp_servers.amem]\ncommand = "old-amem"\nargs = ["old"]\n');
  const before = [...SETUP_ALL_TARGETS].flatMap(target => f.plan(target).actions[0]!.files).map(image);
  applySetup(f.plan("all", "apply"), f.options);
  expect(f.calls.map(call => [call.argv[0], call.argv[2]])).toEqual([["claude", "remove"], ["claude", "add"], ["codex", "remove"], ["codex", "add"], ["pi", "remove"], ["pi", "add"], ["qwen", "remove"], ["qwen", "add"]]);
  expect(f.calls[0]?.argv).toEqual(["claude", "mcp", "remove", "--scope", "user", "amem"]);
  for (const target of SETUP_ALL_TARGETS) expect(mcp(f.file(target), target).other).toEqual({ command: "other-server", args: ["keep"] });
  undoSetup(f.plan("all", "undo"), f.options); expect([...SETUP_ALL_TARGETS].flatMap(target => f.plan(target).actions[0]!.files).map(image)).toEqual(before);
});
test("runSetup cancellation and missing terminal cause no registration or file changes", async () => {
  const f = fixture(); seedOtherFiles(f); const before = snapshot(f.home); let confirmations = 0;
  await expect(runSetup("all", "apply", { ...f.options, stdinTTY: false, confirm: async () => { confirmations++; return true; } })).rejects.toThrow("terminal on stdin");
  expect(confirmations).toBe(0); expect(JSON.parse(await runSetup("all", "apply", { ...f.options, stdinTTY: true, confirm: async plan => { confirmations++; expect(plan.mode).toBe("apply"); expect(plan.targets).toEqual([...SETUP_ALL_TARGETS]); return false; } }))).toEqual({ cancelled: true });
  expect(confirmations).toBe(1); expect(f.calls).toEqual([]); expect(snapshot(f.home)).toEqual(before);
  expect(JSON.parse(await runSetup("kimi", "apply", { ...f.options, stdinTTY: true, confirm: async plan => plan.targets.join() === "kimi" }))).toEqual({ applied: ["kimi"], unchanged: [] });
});
test("edits to the owned MCP entry refuse apply and undo without overwriting any target", () => {
  const f = fixture(); seedOtherFiles(f); applySetup(f.plan("all", "apply"), f.options);
  const changed = f.file("codex"), later = text(changed).replace(JSON.stringify(f.bun), JSON.stringify("changed-owned-runtime")); put(changed, later, 0o640);
  const before = snapshot(f.home), calls = f.calls.length;
  expect(() => applySetup(f.plan("all", "apply"), f.options)).toThrow("changed"); expect(() => undoSetup(f.plan("all", "undo"), f.options)).toThrow("changed");
  expect(snapshot(f.home)).toEqual(before); expect(f.calls).toHaveLength(calls);
});
for (const kind of ["symlink", "hardlink"] as const) test(`setup refuses ${kind} configuration and receipt paths before effects`, () => {
  const f = fixture(), victim = join(f.home, "victim.json"); put(victim, '{"untouched":true}\n');
  const target = f.file("claude"); if (kind === "symlink") symlinkSync(victim, target); else linkSync(victim, target);
  const before = image(victim); expect(() => f.plan("claude", "apply")).toThrow(kind === "symlink" ? "symbolic-link" : "unavailable"); expect(image(victim)).toEqual(before); expect(f.calls).toEqual([]);
  rmSync(target); applySetup(f.plan("claude", "apply"), f.options);
  const receiptFile = f.receiptFile("claude"), saved = text(receiptFile); rmSync(receiptFile); put(victim, saved);
  if (kind === "symlink") symlinkSync(victim, receiptFile); else linkSync(victim, receiptFile);
  const after = snapshot(f.home), calls = f.calls.length;
  expect(() => undoSetup({ ...f.plan("kimi", "undo"), targets: ["claude"] }, f.options)).toThrow(kind === "symlink" ? "symbolic-link" : "unavailable"); expect(snapshot(f.home)).toEqual(after); expect(f.calls).toHaveLength(calls);
});
test("a symbolic-link containing directory is refused without following it", () => {
  const f = fixture(), elsewhere = join(f.home, "elsewhere"); mkdirSync(elsewhere); put(join(elsewhere, "config.toml"), 'model = "keep"\n'); symlinkSync(elsewhere, join(f.home, ".codex"));
  expect(() => f.plan("codex", "apply")).toThrow("symbolic-link"); expect(text(join(elsewhere, "config.toml"))).toBe('model = "keep"\n'); expect(f.calls).toEqual([]);
});
for (const kind of ["path", "target"] as const) test(`receipt ${kind} tampering cannot redirect restoration`, () => {
  const f = fixture(); seedOtherFiles(f); applySetup(f.plan("claude", "apply"), f.options);
  const originalPlan = f.plan("claude", "undo"), receipt = f.receipt("claude"), victim = join(f.home, "unrelated.json"); put(victim, "never overwrite\n");
  if (kind === "path") receipt.changes[0]!.path = victim; else receipt.target = "codex";
  put(originalPlan.actions[0]!.receipt, JSON.stringify(receipt)); const before = snapshot(f.home), calls = f.calls.length;
  expect(() => undoSetup(originalPlan, f.options)).toThrow(kind === "path" ? "target mismatch" : "does not match"); expect(snapshot(f.home)).toEqual(before); expect(f.calls).toHaveLength(calls);
});
test("a prepared receipt with mixed before/after images resumes without native commands and remains undoable", () => {
  const f = fixture(); seedOtherFiles(f); const plan = f.plan("claude", "apply"), originals = plan.actions[0]!.files.map(image); applySetup(plan, f.options);
  const receipt = f.receipt("claude"), after = receipt.changes.map(change => change.after), calls = f.calls.length;
  receipt.phase = "prepared"; restore(receipt.changes[0]!.path, receipt.changes[0]!.before); put(plan.actions[0]!.receipt, JSON.stringify(receipt));
  expect(applySetup(f.plan("claude", "apply"), f.options)).toEqual({ applied: ["claude"], unchanged: [] }); expect(f.calls).toHaveLength(calls); expect(plan.actions[0]!.files.map(image)).toEqual(after); expect(f.receipt("claude").phase).toBe("applied");
  undoSetup(f.plan("claude", "undo"), f.options); expect(plan.actions[0]!.files.map(image)).toEqual(originals);
});
test("a later target preparation failure publishes no earlier prepared config", () => {
  const f = fixture(); seedOtherFiles(f); const plan = f.plan("all", "apply"), files = plan.actions.flatMap(action => action.files), before = files.map(image), native = f.options.native!;
  expect(() => applySetup(plan, { ...f.options, native: (argv, env, cwd) => { if (argv[0] === "codex") throw Error("fixture native refusal"); native(argv, env, cwd); } })).toThrow("fixture native refusal");
  expect(files.map(image)).toEqual(before); for (const action of plan.actions) expect(existsSync(action.receipt)).toBe(false); expect(f.calls.every(call => !existsSync(call.cwd))).toBe(true);
});
test("explicit agent config roots stay inside the isolated HOME and undo restores all originally absent files", () => {
  const f = fixture(), env = { ...f.env, CLAUDE_CONFIG_DIR: join(f.home, "custom claude"), CODEX_HOME: join(f.home, "custom codex"), KIMI_CODE_HOME: join(f.home, "custom kimi"), PI_CODING_AGENT_DIR: join(f.home, "custom pi"), QWEN_HOME: join(f.home, "custom qwen"), JCODE_HOME: join(f.home, "custom jcode") }, options = { ...f.options, env };
  const plan = planSetup("all", "apply", options), files = plan.actions.flatMap(action => action.files);
  expect(plan.actions[0]?.files).toEqual([join(env.CLAUDE_CONFIG_DIR, ".claude.json"), join(env.CLAUDE_CONFIG_DIR, "settings.json")]);
  expect(files.every(file => !existsSync(file))).toBe(true); applySetup(plan, options);
  expect(files.every(file => existsSync(file))).toBe(true);
  expect(f.calls.find(call => call.argv[0] === "claude")?.env.CLAUDE_CONFIG_DIR).toBe(join(f.calls[0]!.cwd, ".claude"));
  for (const action of plan.actions) expect(mcp(action.files[0]!, action.target).amem).toEqual({ command: f.bun, args: ["--smol", f.entry, "mcp"], ...(action.target === "jcode" ? { shared: false } : {}) });
  undoSetup(planSetup("all", "undo", options), options); expect(files.every(file => !existsSync(file))).toBe(true);
});

test("fresh Codex staging creates its explicit profile before the native registration command", () => {
  const f = fixture(), invoke = f.options.native!;
  const options = { ...f.options, native: ((argv, env, cwd) => {
    expect(argv[0]).toBe("codex"); expect(lstatSync(env.CODEX_HOME!).isDirectory()).toBe(true); invoke(argv, env, cwd);
  }) as NonNullable<SetupContext["native"]> };
  const plan = planSetup("codex", "apply", options);
  expect(applySetup(plan, options).applied).toEqual(["codex"]);
  expect(undoSetup(planSetup("codex", "undo", options), options).restored).toEqual(["codex"]);
});
test("setup receipts follow the standalone configuration's relocated memory home", () => {
  const f = fixture(); delete f.env.AMEM_HOME; f.env.AGENTHUB_HOME = join(f.home, "legacy");
  const moved = join(f.home, "moved-memory"); put(join(f.env.AGENTHUB_HOME, "memory", "amem.config.json"), JSON.stringify({ home: moved }));
  const plan = f.plan("claude", "apply"); expect(plan.actions[0]!.receipt).toBe(join(moved, "setup", "claude.json"));
  expect(applySetup(plan, f.options).applied).toEqual(["claude"]);
  expect(existsSync(join(moved, "setup", "claude.json"))).toBe(true);
  expect(undoSetup(f.plan("claude", "undo"), f.options).restored).toEqual(["claude"]);
});
test("valid native amem output that drops another MCP server refuses before any target publication", () => {
  for (const brokenTarget of ["claude", "codex"] as const) {
    const f = fixture(), rules = seedOtherFiles(f), plan = f.plan("all", "apply"), files = plan.actions.flatMap(action => action.files), before = files.map(image), rulesBefore = rules.map(image), invoke = f.options.native!;
    const options: SetupContext = { ...f.options, native: (argv, env, cwd) => {
      invoke(argv, env, cwd);
      if (argv[0] !== brokenTarget) return;
      const file = brokenTarget === "codex" ? join(env.CODEX_HOME!, "config.toml") : env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(cwd, ".claude.json");
      const server = mcp(file, brokenTarget).amem;
      expect(server).toEqual({ command: f.bun, args: ["--smol", f.entry, "mcp"] });
      put(file, brokenTarget === "codex" ? `[mcp_servers.amem]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n` : JSON.stringify({ mcpServers: { amem: server } }));
    } };
    expect(() => applySetup(plan, options)).toThrow("unrelated MCP servers");
    expect(files.map(image)).toEqual(before); expect(rules.map(image)).toEqual(rulesBefore);
    for (const action of plan.actions) expect(existsSync(action.receipt)).toBe(false);
    expect(f.calls.every(call => !existsSync(call.cwd))).toBe(true);
  }
});
test("runtime relocation updates managed entries and still restores original bytes, modes and absence", () => {
  const f = fixture(), rules = seedOtherFiles(f), plan = f.plan("all", "apply"), files = plan.actions.flatMap(action => action.files), originals = files.map(image), rulesBefore = rules.map(image);
  applySetup(plan, f.options); const calls = f.calls.length;
  const moved: SetupContext = { ...f.options, bun: join(f.home, "relocated-runtime", "bun"), entry: join(f.home, "relocated-package", "bin", "amem.js") };
  expect(applySetup(planSetup("all", "apply", moved), moved).applied).toEqual([...SETUP_ALL_TARGETS]);
  expect(f.calls.length).toBeGreaterThan(calls); const updatedCalls = f.calls.length;
  for (const target of SETUP_ALL_TARGETS) expect(mcp(f.file(target), target).amem).toMatchObject({ command: moved.bun, args: ["--smol", moved.entry, "mcp"] });
  expect(undoSetup(planSetup("all", "undo", moved), moved)).toEqual({ restored: [...SETUP_ALL_TARGETS] });
  expect(files.map(image)).toEqual(originals); expect(rules.map(image)).toEqual(rulesBefore); expect(f.calls).toHaveLength(updatedCalls);
});

test("idempotent dry-run exposes no native commands or new hooks and lists every first-install hook", () => {
  const f = fixture(), first = f.plan("all", "apply");
  expect(first.actions.find(action => action.target === "claude")!.hooks).toHaveLength(7);
  for (const action of first.actions) {
    expect(action.mcpChange).toBe("add");
    expect(action.hooks.every(hook => hook.command.includes(f.entry) && hook.timeout > 0)).toBe(true);
  }
  applySetup(first, f.options);
  for (const action of f.plan("all").actions) { expect(action.mcpChange).toBe("unchanged"); expect(action.commands).toEqual([]); expect(action.hooks).toEqual([]); }
});

test("a HOME-only setup context never falls through to the hosting process's memory home", () => {
  const f = fixture(), decoy = realPath(mkdtempSync(join(tmpdir(), "amem-setup-decoy-"))); cleanup.push(() => rmSync(decoy, { recursive: true, force: true }));
  delete f.env.AMEM_HOME; delete f.env.AGENTHUB_HOME; const originalHome = process.env.HOME;
  try {
    process.env.HOME = decoy;
    expect(f.plan("claude").actions[0]!.receipt).toBe(join(f.home, ".agenthub", "memory", "setup", "claude.json"));
    expect(existsSync(join(f.home, ".agenthub"))).toBe(false); expect(existsSync(join(decoy, ".agenthub"))).toBe(false);
  } finally { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; }
});

test("the installed Pi extension forwards shutdown to bounded capture ingest without a native decision", async () => {
  const f = fixture(), record = join(f.home, "pi-ingest-call.json"), project = join(f.home, "opened project"); mkdirSync(project);
  put(f.entry, `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(record)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));`);
  applySetup(f.plan("pi", "apply"), f.options);
  const extension = await import(pathToFileURL(f.file("pi", 1)).href);
  let event = "", handler: ((event: unknown, context: { cwd: string }) => unknown) | undefined;
  extension.default({ on(name: string, fn: typeof handler) { event = name; handler = fn; } });
  expect(event).toBe("session_shutdown"); expect(typeof handler).toBe("function");
  expect(handler!({}, { cwd: project })).toBeUndefined();
  expect(JSON.parse(text(record))).toEqual({ argv: ["ingest", "pi"], cwd: project });
  expect(handler!({}, { cwd: join(f.home, "missing") })).toBeUndefined();
});

test("native config writers cannot widen an existing configuration file's permissions", () => {
  const f = fixture(), file = f.file("codex"); put(file, '# private config\n', 0o640);
  applySetup(f.plan("codex", "apply"), f.options); expect(image(file).mode).toBe(0o640);
  undoSetup(f.plan("codex", "undo"), f.options); expect(image(file)).toEqual({ bytes: Buffer.from('# private config\n').toString("base64"), mode: 0o640 });
});

test("a bounded input cannot grow into an oversized configuration that undo could not reopen", () => {
  const f = fixture(), file = f.file("kimi", 1), size = SETUP_CONFIG_BYTES, original = "#" + "x".repeat(size - 2) + "\n"; put(file, original);
  expect(() => applySetup(f.plan("kimi", "apply"), f.options)).toThrow("setup TOML");
  expect(readFileSync(file).length).toBe(size); expect(readFileSync(file).equals(Buffer.from(original))).toBe(true);
  expect(existsSync(f.file("kimi"))).toBe(false); expect(existsSync(f.receiptFile("kimi"))).toBe(false);
});
test("advisory broken plugin registries never block preview, reapply or byte-exact undo", () => {
  for (const kind of ["invalid JSON", "array", "symlink", "oversized", "bad shape"] as const) {
    const f = fixture(); seedOtherFiles(f); const files = [f.file("claude"), f.file("claude", 1)], before = files.map(image);
    applySetup(f.plan("claude", "apply"), f.options);
    const registry = join(f.home, ".claude", "plugins", "installed_plugins.json"); mkdirSync(dirname(registry), { recursive: true });
    if (kind === "symlink") { const target = join(f.home, "registry-target"); put(target, '{"plugins":{"agent-mem@market":[]}}'); symlinkSync(target, registry); }
    else put(registry, kind === "invalid JSON" ? "not json" : kind === "array" ? "[]" : kind === "oversized" ? " ".repeat(SETUP_CONFIG_BYTES + 1) : '{"plugins":[]}');
    const installed = files.map(image), calls = f.calls.length, registryBefore = kind === "symlink" ? readlinkSync(registry) : readFileSync(registry);
    const preview = f.plan("claude"); expect(preview.notes.some(note => note.startsWith("Installed Claude plugin"))).toBe(false); expect(files.map(image)).toEqual(installed);
    expect(applySetup(f.plan("claude", "apply"), f.options).unchanged).toEqual(["claude"]); expect(f.calls).toHaveLength(calls);
    expect(undoSetup(f.plan("claude", "undo"), f.options).restored).toEqual(["claude"]); expect(files.map(image)).toEqual(before);
    expect(kind === "symlink" ? readlinkSync(registry) : readFileSync(registry)).toEqual(registryBefore);
    expect(applySetup(f.plan("claude", "apply"), f.options).applied).toEqual(["claude"]); undoSetup(f.plan("claude", "undo"), f.options); expect(files.map(image)).toEqual(before);
  }
});
test("preview warns about version-specific mise and asdf Bun paths but leaves stable shims alone", () => {
  const f = fixture();
  for (const bun of [join(f.home, ".local/share/mise/installs/bun/1.4.2/bin/bun"), join(f.home, ".asdf/installs/bun/1.4.2/bin/bun"), join(f.home, "custom-mise-root/installs/bun/1.4.2/bin/bun")]) {
    mkdirSync(dirname(bun), { recursive: true }); symlinkSync(process.execPath, bun);
    const options = { ...f.options, bun: undefined, env: { ...f.env, PATH: dirname(bun) } }, plan = planSetup("claude", "preview", options);
    expect(plan.notes.join("\n")).toContain("this bun path is version-specific; rerun setup --apply after changing Bun"); expect(plan.actions[0]!.registration).toContain(bun);
  }
  for (const bun of [join(f.home, ".local/share/mise/shims/bun"), join(f.home, ".asdf/shims/bun"), "/opt/homebrew/bin/bun"]) expect(planSetup("claude", "preview", { ...f.options, bun }).notes.join("\n")).not.toContain("this bun path is version-specific");
  expect(f.calls).toHaveLength(0);
});
test("advisory registry failure does not hide invalid authoritative settings", () => {
  const f = fixture(), settings = f.file("claude", 1), registry = join(f.home, ".claude", "plugins", "installed_plugins.json");
  put(settings, "not json"); put(registry, "not json"); expect(() => f.plan("claude")).toThrow("setup configuration does not parse"); expect(f.calls).toHaveLength(0);
});
test("a malformed plugin registry does not hide the plugin note derived from settings", () => {
  const f = fixture(), settings = f.file("claude", 1), registry = join(f.home, ".claude", "plugins", "installed_plugins.json");
  put(settings, '{"enabledPlugins":{"agent-mem@market":true}}'); put(registry, "not json");
  expect(f.plan("claude").notes.some(note => note.startsWith("Installed Claude plugin agent-mem@market detected"))).toBe(true);
});
test("Bun path version detection: any version segment warns, a moving symlink does not", () => {
  const f = fixture(), warn = "this bun path is version-specific; rerun setup --apply after changing Bun";
  const versioned = ["/home/u/.local/share/mise/installs/bun/1.4.2/bin/bun", "/home/u/.proto/tools/bun/1.4.2/bin/bun", "/nix/store/abc123-bun-1.4.2/bin/bun", "/opt/homebrew/Cellar/bun/1.4.2/bin/bun"];
  for (const bun of versioned) expect(planSetup("claude", "preview", { ...f.options, bun }).notes.join("\n")).toContain(warn);
  for (const bun of ["/home/u/.local/share/mise/installs/bun/latest/bin/bun", "/home/u/.local/share/mise/shims/bun"]) expect(planSetup("claude", "preview", { ...f.options, bun }).notes.join("\n")).not.toContain(warn);
});

test("Qwen has one atomic settings image for native MCP and bounded SessionEnd ingest", () => {
  const f = fixture(); seedOtherFiles(f);
  const plan = f.plan("qwen", "apply"), action = plan.actions[0]!;
  const expected = ["qwen", "mcp", "add", "--scope", "user", "--transport", "stdio", "amem", f.bun, "--", "--smol", f.entry, "mcp"];
  expect(f.plan("qwen", "preview").actions[0]!.registration).toEqual(expected);
  expect(f.plan("qwen", "preview").actions[0]!.commands).toEqual([expected]);
  expect(action.registration).toEqual(expected); expect(action.commands).toEqual([expected]);
  expect(action.files).toEqual([join(f.env.QWEN_HOME!, "settings.json")]);
  expect(action.hooks).toEqual([{ event: "SessionEnd", command: `'${f.bun}' --smol '${f.entry}' ingest qwen`, timeout: 3 }]);
  const before = image(action.files[0]!);
  expect(applySetup(plan, f.options).applied).toEqual(["qwen"]);
  expect(f.receipt("qwen").changes).toHaveLength(1);
  expect(f.calls[0]!.argv).toEqual(expected);
  expect(f.calls[0]!.env.QWEN_HOME).toBe(join(f.calls[0]!.cwd, ".qwen"));
  expect(f.calls[0]!.env.QWEN_RUNTIME_DIR).toBe(join(f.calls[0]!.cwd, "qwen-runtime"));
  expect(f.calls[0]!.env.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBe(join(f.calls[0]!.cwd, "qwen-system-settings.json"));
  expect(f.calls[0]!.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH).toBe(join(f.calls[0]!.cwd, "qwen-system-defaults.json"));
  const doc = JSON.parse(text(action.files[0]!));
  expect(doc.ui).toEqual({ theme: "keep" });
  expect(doc.hooks.SessionEnd).toHaveLength(2);
  expect(doc.hooks.SessionEnd[0].hooks[0].command).toBe("existing-qwen");
  expect(doc.hooks.SessionEnd[1].hooks[0]).toEqual({ type: "command", command: action.hooks[0]!.command, timeout: 3 });
  expect(applySetup(f.plan("qwen", "apply"), f.options).unchanged).toEqual(["qwen"]);
  undoSetup(f.plan("qwen", "undo"), f.options); expect(image(action.files[0]!)).toEqual(before);
});

test("Qwen alone puts the executable before the server-argument separator", () => {
  const f = fixture();
  const launch = ["--", f.bun, "--smol", f.entry, "mcp"];
  expect(f.plan("claude").actions[0]!.registration).toEqual(["claude", "mcp", "add", "--scope", "user", "--transport", "stdio", "amem", ...launch]);
  expect(f.plan("codex").actions[0]!.registration).toEqual(["codex", "mcp", "add", "amem", ...launch]);
  expect(f.plan("pi").actions[0]!.registration).toEqual(["pi", "mcp", "add", "amem", ...launch]);
  expect(f.plan("qwen").actions[0]!.registration).toEqual(["qwen", "mcp", "add", "--scope", "user", "--transport", "stdio", "amem", f.bun, "--", "--smol", f.entry, "mcp"]);
});

test.each(["arguments", "generic", "timeout"] as const)("native Qwen %s failure is labelled and publishes no settings or receipt", mode => {
  const f = fixture(); seedOtherFiles(f);
  const bin = join(f.home, "bin"), original = image(f.file("qwen"));
  put(join(bin, "qwen"), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] === '--help') { console.log('  mcp'); process.exit(0); }\nwriteFileSync(process.env.QWEN_HOME + '/settings.json', '{"mcpServers":{"amem":{"command":"must-not-publish"}}}');\nconsole.error(${JSON.stringify(mode === "arguments" ? "Not enough non-option arguments: got 1, need at least 2\nNATIVE_SECRET_SENTINEL" : "NATIVE_SECRET_SENTINEL")});\n${mode === "timeout" ? "await Bun.sleep(30000);" : "process.exit(1);"}\n`, 0o700);
  const options: SetupContext = { env: { ...f.env, PATH: bin }, cwd: f.home, bun: f.bun, entry: fileURLToPath(new URL("../bin/amem.js", import.meta.url)) };
  const plan = planSetup("qwen", "apply", options);
  let message = "";
  try { applySetup(plan, options); } catch (error) { message = (error as Error).message; }
  expect(message).toBe(`qwen MCP registration ${mode === "timeout" ? "timed out" : mode === "arguments" ? "rejected command arguments" : "failed"} in staging; no native output disclosed`);
  expect(message).not.toContain("NATIVE_SECRET_SENTINEL"); expect(message).not.toContain("got 1");
  expect(image(f.file("qwen"))).toEqual(original); expect(existsSync(plan.actions[0]!.receipt)).toBe(false);
}, 20_000);

test.skipIf(process.env.AMEM_QWEN_NATIVE_SMOKE !== "1")("real Qwen 0.26.1 isolated native registration reads back the planned server", () => {
  const f = fixture(); seedOtherFiles(f);
  const source = f.file("qwen"), original = image(source), qwenHome = join(f.home, "copied qwen"), file = join(qwenHome, "settings.json");
  restore(file, original);
  const temporary = join(f.home, "tmp"); mkdirSync(temporary);
  const env = { ...f.env, PATH: process.env.PATH, QWEN_HOME: qwenHome, QWEN_RUNTIME_DIR: join(f.home, "qwen-runtime"),
    QWEN_CODE_SYSTEM_SETTINGS_PATH: join(f.home, "system-settings.json"), QWEN_CODE_SYSTEM_DEFAULTS_PATH: join(f.home, "system-defaults.json"),
    XDG_CONFIG_HOME: join(f.home, ".config"), XDG_DATA_HOME: join(f.home, ".local", "share"), XDG_CACHE_HOME: join(f.home, ".cache"), XDG_STATE_HOME: join(f.home, ".local", "state"),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  put(env.QWEN_CODE_SYSTEM_SETTINGS_PATH, "{}\n"); put(env.QWEN_CODE_SYSTEM_DEFAULTS_PATH, "{}\n");
  const version = spawnSync("qwen", ["--version"], { cwd: f.home, env, encoding: "utf8", timeout: 10_000 });
  expect(version.status).toBe(0); expect(version.stdout.trim()).toBe("0.26.1");
  const options: SetupContext = { env, cwd: f.home, bun: f.bun, entry: fileURLToPath(new URL("../bin/amem.js", import.meta.url)) };
  const preview = planSetup("qwen", "preview", options), plan = planSetup("qwen", "apply", options);
  expect(preview.actions[0]!.registration).toEqual(plan.actions[0]!.registration);
  expect(applySetup(plan, options).applied).toEqual(["qwen"]);
  const document = JSON.parse(text(file));
  expect(document.mcpServers.amem.command).toBe(f.bun);
  expect(document.mcpServers.amem.args).toEqual(["--smol", options.entry, "mcp"]);
  expect(document.mcpServers.other).toEqual({ command: "other-server", args: ["keep"] });
  expect(document.ui).toEqual({ theme: "keep" });
  expect(document.hooks.SessionEnd[0].hooks[0].command).toBe("existing-qwen");
  expect(document.hooks.SessionEnd).toHaveLength(2); expect(image(source)).toEqual(original);
  expect(JSON.parse(text(plan.actions[0]!.receipt)).changes).toHaveLength(1);
  expect(applySetup(planSetup("qwen", "apply", options), options).unchanged).toEqual(["qwen"]);
  undoSetup(planSetup("qwen", "undo", options), options);
  expect(image(file)).toEqual(original); expect(image(source)).toEqual(original);
}, 30_000);

test("Qwen undo preserves later unrelated MCP, hook and settings changes in its shared file", () => {
  const f = fixture(); seedOtherFiles(f); const file = f.file("qwen");
  applySetup(f.plan("qwen", "apply"), f.options);
  const doc = JSON.parse(text(file)); doc.ui.theme = "later";
  doc.mcpServers.later = { command: "later-server" };
  doc.hooks.SessionEnd.push({ matcher: "*", hooks: [{ type: "command", command: "later-hook", timeout: 4 }] });
  doc.hooks.Stop = [{ hooks: [{ type: "command", command: "later-stop" }] }];
  put(file, JSON.stringify(doc), 0o640);
  expect(f.plan("qwen").actions[0]!.state).toBe("applied");
  expect(applySetup(f.plan("qwen", "apply"), f.options).unchanged).toEqual(["qwen"]);
  undoSetup(f.plan("qwen", "undo"), f.options);
  const restored = JSON.parse(text(file));
  expect(restored.ui).toEqual({ theme: "later" }); expect(restored.mcpServers.amem).toBeUndefined();
  expect(restored.mcpServers.other.command).toBe("other-server"); expect(restored.mcpServers.later.command).toBe("later-server");
  expect(restored.hooks.SessionEnd.map((row: any) => row.hooks[0].command)).toEqual(["existing-qwen", "later-hook"]);
  expect(restored.hooks.Stop[0].hooks[0].command).toBe("later-stop");
});

for (const surface of ["mcp", "hook", "async", "sequential"] as const) test(`Qwen ${surface} ownership conflict refuses the whole shared-file update`, () => {
  const f = fixture(); seedOtherFiles(f); applySetup(f.plan("qwen", "apply"), f.options);
  const file = f.file("qwen"), doc = JSON.parse(text(file));
  if (surface === "mcp") doc.mcpServers.amem.command = "user-edited-runtime";
  else if (surface === "hook") doc.hooks.SessionEnd[1].hooks[0].timeout = 9;
  else if (surface === "async") doc.hooks.SessionEnd[1].hooks[0].async = true;
  else doc.hooks.SessionEnd[1].sequential = true;
  put(file, JSON.stringify(doc)); const before = image(file), receipt = image(f.receiptFile("qwen")), calls = f.calls.length;
  expect(() => undoSetup(f.plan("qwen", "undo"), f.options)).toThrow("changed");
  expect(() => applySetup(f.plan("qwen", "apply"), f.options)).toThrow("changed");
  expect(image(file)).toEqual(before); expect(image(f.receiptFile("qwen"))).toEqual(receipt); expect(f.calls).toHaveLength(calls);
});

test("Qwen runtime upgrade and prepared recovery retain one undoable ownership image", () => {
  const f = fixture(); seedOtherFiles(f); const file = f.file("qwen"), original = image(file);
  applySetup(f.plan("qwen", "apply"), f.options);
  const value = f.receipt("qwen"); value.phase = "prepared";
  restore(file, value.changes[0]!.before); put(f.receiptFile("qwen"), JSON.stringify(value));
  const calls = f.calls.length;
  expect(applySetup(f.plan("qwen", "apply"), f.options).applied).toEqual(["qwen"]);
  expect(f.calls).toHaveLength(calls);
  const moved = { ...f.options, bun: join(f.home, "new bun"), entry: join(f.home, "new package", "amem.js") };
  expect(applySetup(planSetup("qwen", "apply", moved), moved).applied).toEqual(["qwen"]);
  const doc = JSON.parse(text(file));
  expect(doc.mcpServers.amem.command).toBe(moved.bun);
  expect(doc.hooks.SessionEnd).toHaveLength(2); expect(doc.hooks.SessionEnd[1].hooks[0].command).toContain(moved.entry);
  undoSetup(planSetup("qwen", "undo", moved), moved); expect(image(file)).toEqual(original);
});


test("Qwen tilde homes match native resolution and inherited settings redirects are staged", () => {
  const f = fixture();
  const env = { ...f.env, QWEN_HOME: "~/custom qwen", QWEN_RUNTIME_DIR: join(f.home, "never-runtime"),
    QWEN_CODE_SYSTEM_SETTINGS_PATH: join(f.home, "never-settings.json"), QWEN_CODE_SYSTEM_DEFAULTS_PATH: join(f.home, "never-defaults.json") };
  const options = { ...f.options, env }, plan = planSetup("qwen", "apply", options);
  expect(plan.actions[0]!.files).toEqual([join(f.home, "custom qwen", "settings.json")]);
  applySetup(plan, options);
  const call = f.calls[0]!;
  for (const key of ["QWEN_HOME", "QWEN_RUNTIME_DIR", "QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH"]) {
    expect(call.env[key]!.startsWith(call.cwd + "/")).toBe(true);
  }
  expect(existsSync(env.QWEN_RUNTIME_DIR)).toBe(false);
  expect(existsSync(env.QWEN_CODE_SYSTEM_SETTINGS_PATH)).toBe(false);
  expect(existsSync(env.QWEN_CODE_SYSTEM_DEFAULTS_PATH)).toBe(false);
  undoSetup(planSetup("qwen", "undo", options), options);
  expect(existsSync(plan.actions[0]!.files[0]!)).toBe(false);
});

for (const enabled of [false, true]) test(`Qwen hook controls remain user-owned when enabled is ${enabled}`, () => {
  const f = fixture(); seedOtherFiles(f); const file = f.file("qwen");
  const original = JSON.parse(text(file));
  original.hooks.enabled = enabled;
  original.hooks.disabled = ["user-disabled-hook"];
  // Native declares these as opaque non-event controls; do not infer their behavioral schema.
  original.hooks.notifications = { user: "original", enabled: false };
  put(file, JSON.stringify(original), 0o640);
  const controls = (doc: Record<string, any>) => ({ enabled: doc.hooks.enabled, disabled: doc.hooks.disabled, notifications: doc.hooks.notifications });
  const before = image(file);
  applySetup(f.plan("qwen", "apply"), f.options);
  const installed = JSON.parse(text(file));
  expect(controls(installed)).toEqual(controls(original));
  expect(installed.hooks.SessionEnd).toHaveLength(2);
  expect(f.plan("qwen").actions[0]!.mcpChange).toBe("unchanged");
  expect(applySetup(f.plan("qwen", "apply"), f.options).unchanged).toEqual(["qwen"]);
  // Current control values belong to the person even after setup; semantic undo must retain them.
  installed.ui.theme = "later";
  installed.hooks.enabled = !enabled;
  installed.hooks.disabled.push("later-disabled-hook");
  installed.hooks.notifications = false;
  put(file, JSON.stringify(installed), 0o640);
  const later = image(file), calls = f.calls.length;
  expect(applySetup(f.plan("qwen", "apply"), f.options).unchanged).toEqual(["qwen"]);
  expect(image(file)).toEqual(later); expect(f.calls).toHaveLength(calls);
  undoSetup(f.plan("qwen", "undo"), f.options);
  const restored = JSON.parse(text(file));
  expect(controls(restored)).toEqual(controls(installed));
  expect(restored.ui.theme).toBe("later");
  expect(restored.mcpServers.amem).toBeUndefined();
  expect(restored.hooks.SessionEnd).toEqual(original.hooks.SessionEnd);
  expect(image(file).mode).toBe(before.mode);
});

test("Jcode setup is direct MCP-only with one private receipt and no native invocation or hook", () => {
  const f = fixture(); seedOtherFiles(f);
  const config = join(f.env.JCODE_HOME!, "config.toml"); put(config, '[hooks]\nsession_end = "user-existing-hook"\n', 0o640);
  const action = f.plan("jcode", "apply").actions[0]!, file = action.files[0]!, before = image(file), hookBefore = image(config);
  expect(action.files).toEqual([join(f.env.JCODE_HOME!, "mcp.json")]);
  expect(action.registration).toBeNull(); expect(action.commands).toEqual([]); expect(action.hooks).toEqual([]);
  expect(action.lifecycle).toContain("MCP only");
  expect(f.plan("jcode").notes.join("\n")).toContain("capture and ingest hooks are unavailable");
  expect(applySetup(f.plan("jcode", "apply"), f.options)).toEqual({ applied: ["jcode"], unchanged: [] });
  expect(f.calls).toEqual([]); expect(image(config)).toEqual(hookBefore);
  const installed = JSON.parse(text(file));
  expect(installed.servers.amem).toEqual({ command: f.bun, args: ["--smol", f.entry, "mcp"], shared: false });
  expect(installed.servers.other).toEqual({ command: "other-server", args: ["keep"] });
  expect(installed.mcpServers).toBeUndefined();
  expect(f.receipt("jcode").changes).toHaveLength(1);
  expect(lstatSync(f.receiptFile("jcode")).mode & 0o077).toBe(0);
  const applied = image(file);
  expect(applySetup(f.plan("jcode", "apply"), f.options)).toEqual({ applied: [], unchanged: ["jcode"] });
  expect(image(file)).toEqual(applied); expect(f.calls).toEqual([]);
  undoSetup(f.plan("jcode", "undo"), f.options); expect(image(file)).toEqual(before); expect(image(config)).toEqual(hookBefore);
});

test("Jcode legacy alias registration preserves unrelated raw values and semantic undo", () => {
  const f = fixture(), file = f.file("jcode");
  const original = '{ "mcpServers": {"other":{"command":"user-server","raw":9007199254740993}}, "unknown":1e99 }\n';
  put(file, original, 0o640);
  expect(f.plan("jcode").actions[0]!.mcpChange).toBe("add");
  applySetup(f.plan("jcode", "apply"), f.options);
  expect(text(file)).toContain('"servers"'); expect(text(file)).not.toContain('"mcpServers"');
  expect(text(file)).toContain('"raw":9007199254740993'); expect(text(file)).toContain('"unknown":1e99');
  // A later root field edit must survive removing only the managed MCP entry.
  put(file, text(file).replace('"unknown":1e99', '"unknown":2e99'), 0o640);
  undoSetup(f.plan("jcode", "undo"), f.options);
  expect(text(file)).toContain('"unknown":2e99'); expect(text(file)).toContain('"raw":9007199254740993');
  expect(JSON.parse(text(file)).servers?.amem ?? JSON.parse(text(file)).mcpServers?.amem).toBeUndefined();
});

test("Jcode managed-entry edits refuse apply and undo, while runtime upgrades retire the old registration", () => {
  const f = fixture(); seedOtherFiles(f); const file = f.file("jcode"), original = image(file);
  applySetup(f.plan("jcode", "apply"), f.options);
  const moved = { ...f.options, bun: join(f.home, "new bun"), entry: join(f.home, "new package", "amem.js") };
  expect(applySetup(planSetup("jcode", "apply", moved), moved).applied).toEqual(["jcode"]);
  expect(JSON.parse(text(file)).servers.amem).toEqual({ command: moved.bun, args: ["--smol", moved.entry, "mcp"], shared: false });
  const good = image(file), altered = JSON.parse(text(file)); altered.servers.amem.args.push("user-edit"); put(file, JSON.stringify(altered));
  const before = image(file), receipt = image(f.receiptFile("jcode"));
  expect(() => undoSetup(planSetup("jcode", "undo", moved), moved)).toThrow("changed");
  expect(() => applySetup(planSetup("jcode", "apply", moved), moved)).toThrow("changed");
  expect(image(file)).toEqual(before); expect(image(f.receiptFile("jcode"))).toEqual(receipt);
  restore(file, good); undoSetup(planSetup("jcode", "undo", moved), moved);
  expect(image(file)).toEqual(original); expect(f.calls).toEqual([]);
});

test("JCODE_HOME refuses empty and relative values before any setup effect", () => {
  const f = fixture(), before = snapshot(f.home), plan = f.plan("jcode", "apply");
  for (const value of ["", "rel", "~", " rel ", "relative jcode"]) {
    const options = { ...f.options, env: { ...f.env, JCODE_HOME: value } };
    for (const mode of ["preview", "apply", "undo"] as const) {
      expect(() => planSetup("jcode", mode, options)).toThrow("absolute JCODE_HOME");
      expect(() => planSetup("all", mode, options)).toThrow("absolute JCODE_HOME");
    }
    expect(() => applySetup(plan, options)).toThrow("absolute JCODE_HOME");
    expect(() => undoSetup({ ...plan, mode: "undo" }, options)).toThrow("absolute JCODE_HOME");
    expect(snapshot(f.home)).toEqual(before);
  }
  const env = { ...f.env }; delete env.JCODE_HOME;
  expect(planSetup("jcode", "preview", { ...f.options, env }).actions[0]!.files).toEqual([join(f.home, ".jcode", "mcp.json")]);
  const absolute = join(f.home, "absolute jcode ");
  expect(planSetup("jcode", "preview", { ...f.options, env: { ...env, JCODE_HOME: absolute } }).actions[0]!.files).toEqual([join(absolute, "mcp.json")]);
  expect(snapshot(f.home)).toEqual(before); expect(f.calls).toEqual([]);
});

test("Jcode rejects native environment interpolation in runtime paths before effects", () => {
  const f = fixture(), before = snapshot(f.home);
  for (const fields of [{ bun: join(f.home, '${RUNTIME}', "bun") }, { entry: join(f.home, '${PACKAGE}', "amem.js") }]) {
    expect(() => planSetup("jcode", "apply", { ...f.options, ...fields })).toThrow("interpolates");
    expect(() => planSetup("all", "apply", { ...f.options, ...fields })).toThrow("interpolates");
  }
  expect(snapshot(f.home)).toEqual(before); expect(f.calls).toEqual([]);
});

test("Jcode canonicalizes the HOME alias but refuses a named config-directory symlink", () => {
  const f = fixture(), alias = f.home + "-alias";
  symlinkSync(f.home, alias); cleanup.push(() => rmSync(alias, { force: true }));
  const env = { ...f.env, HOME: alias, JCODE_HOME: join(alias, ".jcode") }, options = { ...f.options, env };
  const plan = planSetup("jcode", "apply", options);
  expect(plan.actions[0]!.files).toEqual([join(f.home, ".jcode", "mcp.json")]);
  expect(applySetup(plan, options).applied).toEqual(["jcode"]);
  expect(JSON.parse(text(plan.actions[0]!.files[0]!)).servers.amem.shared).toBe(false);
  expect(undoSetup(planSetup("jcode", "undo", options), options).restored).toEqual(["jcode"]);
  expect(existsSync(plan.actions[0]!.files[0]!)).toBe(false);
  const elsewhere = join(f.home, "elsewhere"), victim = join(elsewhere, "mcp.json");
  put(victim, '{"servers":{"user":{"command":"keep"}}}\n');
  symlinkSync(elsewhere, join(f.home, "named-jcode"));
  const before = image(victim);
  expect(() => planSetup("jcode", "apply", { ...options, env: { ...env, JCODE_HOME: join(alias, "named-jcode") } })).toThrow("symbolic-link");
  expect(image(victim)).toEqual(before); expect(f.calls).toEqual([]);
});

function agyGit(cwd: string, ...args: string[]) {
  const result = memoryGitSync(["-C", cwd, ...args], { env: memoryGitEnv(process.env, { repositoryIsolation: true }), encoding: "utf8" });
  expect(result.status).toBe(0); return result;
}
function agyFixture() {
  const f = fixture(); agyGit(f.home, "init", "-q");
  const options = { ...f.options, cwd: f.home };
  return { ...f, options, agyPlan: (mode: SetupPlan["mode"] = "preview") => planSetup("agy", mode, options) };
}

test("Antigravity config is repository-bound, direct and excluded from all", () => {
  const f = agyFixture(), file = join(f.home, ".agents", "mcp_config.json");
  put(file, '{"mcpServers":{"other":{"command":"keep"}}}\n', 0o640);
  const original = image(file), inode = lstatSync(file).ino, plan = f.agyPlan("apply"), action = plan.actions[0]!;
  expect(action.files).toEqual([file]); expect(action.cwd).toBe(f.home);
  expect(action.receipt).toMatch(/\/agy-[a-f0-9]{64}\.json$/);
  expect(action.commands).toEqual([]); expect(action.registration).toBeNull(); expect(action.hooks).toEqual([]);
  expect(action.available).toBe(true); expect(plan.notes.join("\n")).toContain("not Git-ignored");
  expect(planSetup("all", "preview", f.options).targets).not.toContain("agy");
  let publications = 0;
  expect(applySetup(plan, { ...f.options, beforePublish: path => {
    expect(path).toBe(file); expect(image(file)).toEqual(original); expect(lstatSync(file).ino).toBe(inode); publications++;
  } }).applied).toEqual(["agy"]);
  expect(publications).toBe(1); expect(f.calls).toEqual([]);
  expect(JSON.parse(text(file)).mcpServers.amem).toEqual({ command: f.bun, args: ["--smol", f.entry, "mcp"], cwd: f.home });
  expect(JSON.parse(text(file)).mcpServers.other.command).toBe("keep");
  expect(lstatSync(action.receipt).mode & 0o077).toBe(0);
  const installed = image(file);
  expect(applySetup(f.agyPlan("apply"), f.options).unchanged).toEqual(["agy"]); expect(image(file)).toEqual(installed);
  undoSetup(f.agyPlan("undo"), f.options); expect(image(file)).toEqual(original);
});

test("Antigravity project receipts and undo are independent in one memory home", () => {
  const f = agyFixture(), other = join(f.home, "other-repository"); mkdirSync(other); agyGit(other, "init", "-q");
  const second = { ...f.options, cwd: other }, firstPlan = f.agyPlan("apply"), secondPlan = planSetup("agy", "apply", second);
  expect(firstPlan.actions[0]!.receipt).not.toBe(secondPlan.actions[0]!.receipt);
  applySetup(firstPlan, f.options); applySetup(secondPlan, second);
  const otherFile = secondPlan.actions[0]!.files[0]!, otherBefore = image(otherFile);
  expect(JSON.parse(text(otherFile)).mcpServers.amem.cwd).toBe(other);
  undoSetup(f.agyPlan("undo"), f.options); expect(image(otherFile)).toEqual(otherBefore);
  expect(existsSync(secondPlan.actions[0]!.receipt)).toBe(true);
  undoSetup(planSetup("agy", "undo", second), second); expect(existsSync(otherFile)).toBe(false);
});

test("Antigravity refuses outside Git and tracked config in every mode", () => {
  const plain = fixture(), options = { ...plain.options, cwd: plain.home };
  for (const mode of ["preview", "apply", "undo"] as const) expect(() => planSetup("agy", mode, options)).toThrow("Git repository");
  expect(planSetup("all", "preview", options).targets).toEqual([...SETUP_ALL_TARGETS]);
  const f = agyFixture(), file = join(f.home, ".agents", "mcp_config.json"); put(file, "{}\n");
  agyGit(f.home, "add", "--", file); const original = image(file);
  for (const mode of ["preview", "apply", "undo"] as const) expect(() => f.agyPlan(mode)).toThrow("Git-tracked");
  expect(image(file)).toEqual(original); expect(f.calls).toEqual([]);
});

test("Antigravity refuses tracked config case aliases before any write", () => {
  const f = agyFixture(), file = join(f.home, ".AGENTS", "MCP_CONFIG.JSON");
  put(file, "{}\n"); agyGit(f.home, "add", "--", file);
  const original = image(file);
  for (const mode of ["preview", "apply", "undo"] as const) for (const key of ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) {
    const options = { ...f.options, env: { ...f.options.env, [key]: "1" } };
    expect(() => planSetup("agy", mode, options)).toThrow("Git-tracked");
  }
  expect(image(file)).toEqual(original); expect(f.calls).toEqual([]);
});

test("Antigravity rechecks tracked state after publication callbacks and rejects changed cwd", () => {
  const f = agyFixture(), file = join(f.home, ".agents", "mcp_config.json"); put(file, "{}\n");
  const plan = f.agyPlan("apply"), original = image(file);
  const other = join(f.home, "other"); mkdirSync(other); agyGit(other, "init", "-q");
  expect(() => applySetup(plan, { ...f.options, cwd: other })).toThrow("changed since preview");
  expect(existsSync(join(other, ".agents", "mcp_config.json"))).toBe(false);
  expect(() => applySetup(plan, { ...f.options, beforePublish: () => { agyGit(f.home, "add", "--", file); } })).toThrow("Git-tracked");
  expect(image(file)).toEqual(original); expect(f.calls).toEqual([]);
});

test("Antigravity strict JSON ceiling and semantic ownership preserve unrelated settings", () => {
  const f = agyFixture(), file = join(f.home, ".agents", "mcp_config.json");
  put(file, '{// native JSONC is deliberately outside this setup boundary\n"mcpServers":{}}');
  const invalid = image(file); expect(() => f.agyPlan("apply")).toThrow(); expect(image(file)).toEqual(invalid);
  put(file, '{"mcpServers":{"other":{"command":"keep"}},"unknown":9007199254740993}\n');
  applySetup(f.agyPlan("apply"), f.options);
  expect(text(file)).toContain('"unknown":9007199254740993');
  put(file, text(file).replace('"unknown":9007199254740993', '"unknown":9007199254740995'));
  undoSetup(f.agyPlan("undo"), f.options);
  expect(text(file)).toContain('"unknown":9007199254740995'); expect(JSON.parse(text(file)).mcpServers.amem).toBeUndefined();
  expect(JSON.parse(text(file)).mcpServers.other.command).toBe("keep");
});


test("Antigravity undo removes only its setup-created empty directory across reapply", () => {
  const f = agyFixture(), dir = join(f.home, ".agents"), plan = f.agyPlan("apply"), journal = plan.actions[0]!.receipt;
  expect(existsSync(dir)).toBe(false); applySetup(plan, f.options);
  const created = JSON.parse(text(journal)).createdDirectory;
  expect(created).toEqual({ dev: lstatSync(dir).dev, ino: lstatSync(dir).ino });
  expect(applySetup(f.agyPlan("apply"), f.options).unchanged).toEqual(["agy"]);
  const moved = { ...f.options, entry: f.entry + "-new" };
  applySetup(planSetup("agy", "apply", moved), moved);
  expect(JSON.parse(text(journal)).createdDirectory).toEqual(created);
  undoSetup(planSetup("agy", "undo", moved), moved);
  expect(existsSync(dir)).toBe(false); expect(existsSync(journal)).toBe(false);
});

test("Antigravity undo preserves pre-existing and nonempty setup-created directories", () => {
  for (const existing of [false, true]) {
    const f = agyFixture(), dir = join(f.home, ".agents");
    if (existing) mkdirSync(dir);
    applySetup(f.agyPlan("apply"), f.options);
    if (!existing) put(join(dir, "keep.txt"), "user data");
    undoSetup(f.agyPlan("undo"), f.options);
    expect(existsSync(dir)).toBe(true); expect(existsSync(join(dir, "mcp_config.json"))).toBe(false);
    if (!existing) expect(text(join(dir, "keep.txt"))).toBe("user data");
  }
});

test("Antigravity legacy receipts undo files without claiming directory ownership", () => {
  const f = agyFixture(), plan = f.agyPlan("apply"), journal = plan.actions[0]!.receipt;
  applySetup(plan, f.options); const legacy = JSON.parse(text(journal)); delete legacy.createdDirectory; put(journal, JSON.stringify(legacy));
  undoSetup(f.agyPlan("undo"), f.options);
  expect(existsSync(join(f.home, ".agents"))).toBe(true); expect(existsSync(plan.actions[0]!.files[0]!)).toBe(false);
});

test("Antigravity undo preserves a replacement directory with identical configuration", () => {
  const f = agyFixture(), dir = join(f.home, ".agents"), plan = f.agyPlan("apply");
  applySetup(plan, f.options); const installed = text(plan.actions[0]!.files[0]!);
  renameSync(dir, dir + "-original"); mkdirSync(dir); put(join(dir, "mcp_config.json"), installed);
  undoSetup(f.agyPlan("undo"), f.options);
  expect(existsSync(dir)).toBe(true); expect(existsSync(join(dir, "mcp_config.json"))).toBe(false);
  expect(text(join(dir + "-original", "mcp_config.json"))).toBe(installed);
});

test("Antigravity interrupted publication keeps directory ownership available for undo", () => {
  const f = agyFixture(), plan = f.agyPlan("apply"), journal = plan.actions[0]!.receipt, dir = join(f.home, ".agents");
  expect(() => applySetup(plan, { ...f.options, beforePublish: () => { throw Error("interrupted fixture"); } })).toThrow("interrupted fixture");
  expect(JSON.parse(text(journal)).createdDirectory).toEqual({ dev: lstatSync(dir).dev, ino: lstatSync(dir).ino });
  undoSetup(f.agyPlan("undo"), f.options); expect(existsSync(dir)).toBe(false);
});

test("Antigravity never claims a directory created after preview by another writer", () => {
  const f = agyFixture(), dir = join(f.home, ".agents"), plan = f.agyPlan("apply");
  mkdirSync(dir); applySetup(plan, f.options);
  expect(JSON.parse(text(plan.actions[0]!.receipt)).createdDirectory).toBeUndefined();
  undoSetup(f.agyPlan("undo"), f.options); expect(existsSync(dir)).toBe(true);
});

test("Antigravity refuses invalid directory ownership receipts before changing configuration", () => {
  const f = agyFixture(), plan = f.agyPlan("apply"), journal = plan.actions[0]!.receipt;
  applySetup(plan, f.options); const current = JSON.parse(text(journal)), before = image(plan.actions[0]!.files[0]!);
  for (const createdDirectory of [true, { dev: -1, ino: 1 }, { dev: 1, ino: 0 }, { dev: 1, ino: 1, path: f.home }]) {
    put(journal, JSON.stringify({ ...current, createdDirectory }));
    expect(() => undoSetup({ ...plan, mode: "undo" }, f.options)).toThrow();
    expect(image(plan.actions[0]!.files[0]!)).toEqual(before);
  }
});

test("invalid JCODE_HOME does not block other selected setup targets", () => {
  for (const JCODE_HOME of ["rel", ""]) {
    const f = fixture(), options = { ...f.options, env: { ...f.env, JCODE_HOME } }, before = snapshot(f.home);
    const plan = planSetup("claude", "apply", options);
    expect(planSetup("claude", "preview", options).targets).toEqual(["claude"]);
    expect(planSetup("codex", "preview", options).targets).toEqual(["codex"]);
    expect(snapshot(f.home)).toEqual(before);
    expect(applySetup(plan, options).applied).toEqual(["claude"]);
    expect(JSON.parse(text(plan.actions[0]!.files[0]!)).mcpServers.amem).toBeDefined();
    expect(() => planSetup("jcode", "preview", options)).toThrow("absolute JCODE_HOME");
    expect(() => planSetup("all", "preview", options)).toThrow("absolute JCODE_HOME");
    undoSetup(planSetup("claude", "undo", options), options);
    expect(existsSync(plan.actions[0]!.files[0]!)).toBe(false);
  }
});
