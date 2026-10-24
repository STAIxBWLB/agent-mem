import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { applySetup, planSetup, runSetup, SETUP_TARGETS, undoSetup, type SetupContext, type SetupPlan, type SetupTarget } from "../src/setup.ts";
import { SETUP_CONFIG_BYTES } from "../src/setup-toml.ts";
import { realPath } from "../src/memory/platform.ts";
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
  const env: Record<string, string | undefined> = { HOME: home, AMEM_HOME: join(home, "memory"), CODEX_HOME: join(home, ".codex"), KIMI_CODE_HOME: join(home, ".kimi-code"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent") };
  const calls: Call[] = [], entry = join(home, "package with space", "bin", "amem.js"), bun = process.execPath;
  const native: NonNullable<SetupContext["native"]> = (argv, stagedEnv, cwd) => {
    calls.push({ argv: [...argv], env: { ...stagedEnv }, cwd });
    expect(stagedEnv.HOME).toBe(cwd); expect(cwd).not.toBe(home); expect(realPath(cwd)).toBe(cwd);
    const target = argv[0] as SetupTarget, remove = argv[2] === "remove", marker = argv.indexOf("--"), launch = argv.slice(marker + 1);
    expect(["claude", "codex", "pi"]).toContain(target);
    expect(argv.slice(1, 3)).toEqual(["mcp", remove ? "remove" : "add"]);
    const file = target === "claude" ? stagedEnv.CLAUDE_CONFIG_DIR ? join(stagedEnv.CLAUDE_CONFIG_DIR, ".claude.json") : join(cwd, ".claude.json")
      : target === "codex" ? join(stagedEnv.CODEX_HOME!, "config.toml") : join(stagedEnv.PI_CODING_AGENT_DIR!, "mcp.json");
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
  const rules = ["AGENTS.md", "CLAUDE.md", ".claude/rules/keep.md", ".codex/rules/keep.rules", ".pi/agent/extensions/keep.ts"].map(name => join(f.home, name));
  for (const rule of rules) put(rule, "unrelated user content\n", 0o640);
  return rules;
}
const mcp = (file: string, target: SetupTarget) => target === "codex" ? (Bun.TOML.parse(text(file)) as Record<string, any>).mcp_servers : JSON.parse(text(file)).mcpServers;
test("setup preview inventories every target without commands, files or confirmation", async () => {
  const f = fixture(); seedOtherFiles(f); const before = snapshot(f.home), shown = f.plan();
  expect(shown.targets).toEqual([...SETUP_TARGETS]); expect(shown.mode).toBe("preview"); expect(shown.actions).toHaveLength(4);
  for (const action of shown.actions) { expect(action.files).toHaveLength(2); expect(action.receipt).toBe(join(f.home, "memory", "setup", `${action.target}.json`)); expect(action.state).toBe("not installed"); }
  expect(shown.actions.find(row => row.target === "kimi")?.registration).toBeNull();
  let confirmations = 0;
  const output = await runSetup("all", "preview", { ...f.options, stdinTTY: false, confirm: async () => { confirmations++; return true; } });
  expect(JSON.parse(output).targets).toEqual([...SETUP_TARGETS]); expect(confirmations).toBe(0); expect(f.calls).toEqual([]); expect(snapshot(f.home)).toEqual(before);
});
test("all-target apply stages native commands, records private receipts and is byte/mode-idempotent", () => {
  const f = fixture(), rules = seedOtherFiles(f), rulesBefore = rules.map(image), plan = f.plan("all", "apply");
  expect(applySetup(plan, f.options)).toEqual({ applied: [...SETUP_TARGETS], unchanged: [] });
  expect(f.calls.map(call => call.argv[0])).toEqual(["claude", "codex", "pi"]);
  for (const call of f.calls) { expect(call.argv.slice(-5)).toEqual(["--", f.bun, "--smol", f.entry, "mcp"]); expect(existsSync(call.cwd)).toBe(false); expect(call.env.CODEX_HOME).toBe(join(call.cwd, ".codex")); expect(call.env.KIMI_CODE_HOME).toBe(join(call.cwd, ".kimi-code")); expect(call.env.PI_CODING_AGENT_DIR).toBe(join(call.cwd, ".pi", "agent")); }
  for (const target of SETUP_TARGETS) {
    const receipt = f.receipt(target), action = plan.actions.find(row => row.target === target)!;
    expect(receipt).toMatchObject({ version: 1, target, phase: "applied" }); expect(receipt.changes.map(change => change.path)).toEqual(action.files);
    expect(lstatSync(action.receipt).mode & 0o077).toBe(0); expect(lstatSync(dirname(action.receipt)).mode & 0o077).toBe(0);
    expect(mcp(f.file(target), target).amem).toEqual({ command: f.bun, args: ["--smol", f.entry, "mcp"] });
    expect(mcp(f.file(target), target).other).toEqual({ command: "other-server", args: ["keep"] });
  }
  const settings = JSON.parse(text(f.file("claude", 1))); expect(settings.enabledPlugins).toEqual({ "other@catalog": true }); expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("existing-start"); expect(Object.keys(settings.hooks)).toHaveLength(7);
  const codexHooks = JSON.parse(text(f.file("codex", 1))); expect(codexHooks.hooks.SessionEnd[0].hooks[0].command).toBe("existing-end"); expect(codexHooks.hooks.PostToolUse[0].hooks[0].command).toBe("existing-tool"); expect(codexHooks.hooks.SessionEnd).toHaveLength(2);
  expect(text(f.file("codex"))).toContain('# original comment\nmodel = "fixture"');
  const kimiHooks = (Bun.TOML.parse(text(f.file("kimi", 1))) as { hooks: Array<{ event: string; command: string }> }).hooks; expect(kimiHooks[0]?.command).toBe("existing-kimi"); expect(kimiHooks.filter(hook => hook.event === "SessionEnd")).toHaveLength(1);
  expect(text(f.file("pi", 1))).toContain("session_shutdown"); expect(text(f.file("pi", 1))).toContain(f.entry);
  expect(rules.map(image)).toEqual(rulesBefore);
  const beforeSecond = snapshot(f.home), calls = f.calls.length;
  expect(applySetup(f.plan("all", "apply"), f.options)).toEqual({ applied: [], unchanged: [...SETUP_TARGETS] }); expect(f.calls).toHaveLength(calls); expect(snapshot(f.home)).toEqual(beforeSecond);
});
test("undo restores original bytes, modes and missing files without touching unrelated rules", () => {
  const f = fixture(), rules = seedOtherFiles(f), plan = f.plan("all", "apply"), files = plan.actions.flatMap(action => action.files), originals = files.map(image), rulesBefore = rules.map(image);
  expect(originals.some(value => value.bytes === null)).toBe(true); applySetup(plan, f.options); const calls = f.calls.length;
  expect(undoSetup(f.plan("all", "undo"), f.options)).toEqual({ restored: [...SETUP_TARGETS] }); expect(files.map(image)).toEqual(originals); expect(rules.map(image)).toEqual(rulesBefore); expect(f.calls).toHaveLength(calls);
  for (const target of SETUP_TARGETS) expect(existsSync(f.receiptFile(target))).toBe(false);
});
test("existing amem registration is removed before add while other MCP entries survive", () => {
  const f = fixture(); seedOtherFiles(f);
  for (const target of ["claude", "pi"] as const) { const file = f.file(target), document = JSON.parse(text(file)); document.mcpServers.amem = { command: "old-amem", args: ["old"] }; put(file, JSON.stringify(document)); }
  put(f.file("codex"), text(f.file("codex")) + '\n[mcp_servers.amem]\ncommand = "old-amem"\nargs = ["old"]\n');
  const before = [...SETUP_TARGETS].flatMap(target => [f.file(target), f.file(target, 1)]).map(image);
  applySetup(f.plan("all", "apply"), f.options);
  expect(f.calls.map(call => [call.argv[0], call.argv[2]])).toEqual([["claude", "remove"], ["claude", "add"], ["codex", "remove"], ["codex", "add"], ["pi", "remove"], ["pi", "add"]]);
  expect(f.calls[0]?.argv).toEqual(["claude", "mcp", "remove", "--scope", "user", "amem"]);
  for (const target of SETUP_TARGETS) expect(mcp(f.file(target), target).other).toEqual({ command: "other-server", args: ["keep"] });
  undoSetup(f.plan("all", "undo"), f.options); expect([...SETUP_TARGETS].flatMap(target => [f.file(target), f.file(target, 1)]).map(image)).toEqual(before);
});
test("runSetup cancellation and missing terminal cause no registration or file changes", async () => {
  const f = fixture(); seedOtherFiles(f); const before = snapshot(f.home); let confirmations = 0;
  await expect(runSetup("all", "apply", { ...f.options, stdinTTY: false, confirm: async () => { confirmations++; return true; } })).rejects.toThrow("terminal on stdin");
  expect(confirmations).toBe(0); expect(JSON.parse(await runSetup("all", "apply", { ...f.options, stdinTTY: true, confirm: async plan => { confirmations++; expect(plan.mode).toBe("apply"); expect(plan.targets).toEqual([...SETUP_TARGETS]); return false; } }))).toEqual({ cancelled: true });
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
  const f = fixture(), env = { ...f.env, CLAUDE_CONFIG_DIR: join(f.home, "custom claude"), CODEX_HOME: join(f.home, "custom codex"), KIMI_CODE_HOME: join(f.home, "custom kimi"), PI_CODING_AGENT_DIR: join(f.home, "custom pi") }, options = { ...f.options, env };
  const plan = planSetup("all", "apply", options), files = plan.actions.flatMap(action => action.files);
  expect(plan.actions[0]?.files).toEqual([join(env.CLAUDE_CONFIG_DIR, ".claude.json"), join(env.CLAUDE_CONFIG_DIR, "settings.json")]);
  expect(files.every(file => !existsSync(file))).toBe(true); applySetup(plan, options);
  expect(files.every(file => existsSync(file))).toBe(true);
  expect(f.calls.find(call => call.argv[0] === "claude")?.env.CLAUDE_CONFIG_DIR).toBe(join(f.calls[0]!.cwd, ".claude"));
  for (const action of plan.actions) expect(mcp(action.files[0]!, action.target).amem).toEqual({ command: f.bun, args: ["--smol", f.entry, "mcp"] });
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
  expect(applySetup(planSetup("all", "apply", moved), moved).applied).toEqual([...SETUP_TARGETS]);
  expect(f.calls.length).toBeGreaterThan(calls); const updatedCalls = f.calls.length;
  for (const target of SETUP_TARGETS) expect(mcp(f.file(target), target).amem).toMatchObject({ command: moved.bun, args: ["--smol", moved.entry, "mcp"] });
  expect(undoSetup(planSetup("all", "undo", moved), moved)).toEqual({ restored: [...SETUP_TARGETS] });
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
