import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applySetup, planSetup, undoSetup, type SetupContext, type SetupTarget } from "../src/setup.ts";
import { SETUP_CONFIG_BYTES } from "../src/setup-toml.ts";
import { realPath } from "../src/memory/platform.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function put(file: string, value: string, mode = 0o640) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); chmodSync(file, mode); }
const text = (file: string) => readFileSync(file, "utf8");
const json = (file: string) => JSON.parse(text(file)) as Record<string, any>;
const toml = (file: string) => Bun.TOML.parse(text(file)) as Record<string, any>;
function hooks(document: Record<string, any>): Array<Record<string, any>> { return Object.values(document.hooks ?? {}).flatMap((groups: any) => groups.flatMap((group: any) => group.hooks)); }
function fixture() {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-setup-semantic-"))); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const env: Record<string, string | undefined> = { HOME: home, AMEM_HOME: join(home, "memory"), CODEX_HOME: join(home, ".codex"), KIMI_CODE_HOME: join(home, ".kimi-code"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent") };
  const entry = join(home, "installed package", "bin", "amem.js"), calls: Array<{ argv: string[]; home: string; cwd: string }> = [];
  const options: SetupContext = { env, entry, native: (argv, staged, cwd) => {
    expect(staged.HOME).toBe(cwd); expect(cwd).not.toBe(home); calls.push({ argv: [...argv], home: staged.HOME!, cwd });
    const target = argv[0], removing = argv[2] === "remove", marker = argv.indexOf("--"), launch = argv.slice(marker + 1);
    const file = target === "claude" ? staged.CLAUDE_CONFIG_DIR ? join(staged.CLAUDE_CONFIG_DIR, ".claude.json") : join(cwd, ".claude.json") : target === "codex" ? join(staged.CODEX_HOME!, "config.toml") : join(staged.PI_CODING_AGENT_DIR!, "mcp.json");
    const document = existsSync(file) ? target === "codex" ? toml(file) : json(file) : {}, key = target === "codex" ? "mcp_servers" : "mcpServers";
    document[key] ??= {}; if (removing) delete document[key].amem; else document[key].amem = { command: launch[0], args: launch.slice(1) };
    put(file, target === "codex" ? Bun.TOML.stringify(document) : JSON.stringify(document, null, 2) + "\n");
  } };
  const initial = planSetup("all", "preview", options), file = (target: SetupTarget, index = 0) => initial.actions.find(action => action.target === target)!.files[index]!;
  const plan = (target: SetupTarget, mode: "apply" | "undo" = "apply", context = options) => planSetup(target, mode, context);
  return { home, env, entry, options, calls, file, plan };
}
function seedClaude(f: ReturnType<typeof fixture>, previousAmem = true) {
  const oldServer = { command: "legacy-amem", args: ["old"] };
  put(f.file("claude"), JSON.stringify({ numStartups: 1, projects: { "/old": { allowedTools: ["Read"] } }, mcpServers: { other: { command: "keep", args: ["before"] }, ...(previousAmem ? { amem: oldServer } : {}) } }, null, 2) + "\n");
  put(f.file("claude", 1), JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "original-observer" }] }] } }) + "\n");
  return oldServer;
}
test("Claude routine metadata/other MCP writes keep reapply unchanged and semantic undo restores only the prior amem entry", () => {
  const f = fixture(), oldServer = seedClaude(f); applySetup(f.plan("claude"), f.options);
  const live = json(f.file("claude")); expect(live.mcpServers.amem.command).toBe(Bun.which("bun")); live.numStartups = 11; live.projects["/new"] = { enabled: true }; live.mcpServers.other.args = ["routine update"]; live.mcpServers.later = { command: "later" }; put(f.file("claude"), JSON.stringify(live, null, 2) + "\n");
  const before = readFileSync(f.file("claude")), calls = f.calls.length;
  expect(applySetup(f.plan("claude"), f.options)).toMatchObject({ applied: [], unchanged: ["claude"] }); expect(f.calls).toHaveLength(calls); expect(readFileSync(f.file("claude"))).toEqual(before);
  undoSetup(f.plan("claude", "undo"), f.options);
  const restored = json(f.file("claude")); expect(restored.mcpServers.amem).toEqual(oldServer); expect(restored.numStartups).toBe(11); expect(restored.projects["/new"]).toEqual({ enabled: true }); expect(restored.mcpServers.other.args).toEqual(["routine update"]); expect(restored.mcpServers.later).toEqual({ command: "later" }); expect(f.calls).toHaveLength(calls);
});
test("native trusted_hash and group metadata do not make managed JSON hooks irremovable", () => {
  for (const target of ["claude", "codex"] as const) {
    const f = fixture(), settings = f.file(target, 1); put(settings, '{"unrelated":"keep"}\n'); applySetup(f.plan(target), f.options);
    const live = json(settings), groups = Object.values(live.hooks).flat() as Array<Record<string, any>>;
    for (const group of groups) { group.trusted_hash = "native-group-hash"; group.nativeMetadata = { source: "native review" }; group.matcher ??= "*"; for (const handler of group.hooks) handler.trusted_hash = "native-handler-hash"; }
    groups[0]!.hooks.push({ type: "command", command: "new-native-observer", trusted_hash: "unrelated-handler" }); put(settings, JSON.stringify(live, null, 2) + "\n");
    const calls = f.calls.length; expect(applySetup(f.plan(target), f.options)).toMatchObject({ applied: [], unchanged: [target] }); expect(f.calls).toHaveLength(calls);
    undoSetup(f.plan(target, "undo"), f.options);
    const restored = json(settings); expect(restored.unrelated).toBe("keep"); expect(hooks(restored).map(handler => handler.command)).toEqual(["new-native-observer"]);
    const remaining = (Object.values(restored.hooks).flat() as Array<Record<string, any>>)[0]!; expect(remaining.trusted_hash).toBe("native-group-hash"); expect(remaining.nativeMetadata).toEqual({ source: "native review" });
  }
});
test("a changed setup-owned MCP command refuses both reapply and undo without clobbering it", () => {
  const f = fixture(); seedClaude(f); applySetup(f.plan("claude"), f.options); const undo = f.plan("claude", "undo");
  const edited = json(f.file("claude")); edited.mcpServers.amem.command = "person-edited-command"; put(f.file("claude"), JSON.stringify(edited) + "\n");
  const bytes = readFileSync(f.file("claude")), settings = readFileSync(f.file("claude", 1)), mode = lstatSync(f.file("claude")).mode, calls = f.calls.length;
  expect(() => applySetup(f.plan("claude"), f.options)).toThrow(); expect(() => undoSetup(undo, f.options)).toThrow(); expect(readFileSync(f.file("claude"))).toEqual(bytes); expect(readFileSync(f.file("claude", 1))).toEqual(settings); expect(lstatSync(f.file("claude")).mode).toBe(mode); expect(f.calls).toHaveLength(calls);
});
test("Codex semantic undo preserves later project trust/model and other MCP tables", () => {
  const f = fixture(), config = f.file("codex"); put(config, 'model = "before"\n[mcp_servers.other]\ncommand = "keep"\n'); applySetup(f.plan("codex"), f.options);
  const trust = '\n# native project trust\n[projects."/new project"]\ntrust_level = "trusted"\n[mcp_servers.later]\ncommand = "later"\n';
  put(config, text(config).replace('model = "before"', 'model = "after"') + trust); const before = readFileSync(config), calls = f.calls.length;
  expect(applySetup(f.plan("codex"), f.options)).toMatchObject({ applied: [], unchanged: ["codex"] }); expect(readFileSync(config)).toEqual(before); expect(f.calls).toHaveLength(calls);
  undoSetup(f.plan("codex", "undo"), f.options); const restored = toml(config);
  expect(restored.mcp_servers.amem).toBeUndefined(); expect(restored.mcp_servers.other.command).toBe("keep"); expect(restored.mcp_servers.later.command).toBe("later"); expect(restored.model).toBe("after"); expect(restored.projects["/new project"].trust_level).toBe("trusted"); expect(text(config)).toContain(trust); expect(f.calls).toHaveLength(calls);
});
test("Kimi inline empty/nonempty hooks remain parseable and undo retains a later unrelated field", () => {
  for (const original of ['hooks = [] # original\n[model]\nprovider = "keep"\n', 'hooks = [{ event = "Stop", command = "original-kimi", options = { keep = true } }]\n[model]\nprovider = "keep"\n']) {
    const f = fixture(), config = f.file("kimi", 1); put(config, original); const oldHooks = toml(config).hooks;
    applySetup(f.plan("kimi"), f.options); expect(toml(config).hooks).toHaveLength(oldHooks.length + 1);
    put(config, 'owner = "later"\n' + text(config)); const live = readFileSync(config), calls = f.calls.length;
    expect(applySetup(f.plan("kimi"), f.options)).toMatchObject({ applied: [], unchanged: ["kimi"] }); expect(readFileSync(config)).toEqual(live); expect(f.calls).toHaveLength(calls);
    undoSetup(f.plan("kimi", "undo"), f.options); const restored = toml(config);
    expect(restored.hooks).toEqual(oldHooks); expect(restored.owner).toBe("later"); expect(restored.model.provider).toBe("keep"); expect(f.calls).toHaveLength(calls);
  }
});
test("changed launcher/entry automatically update managed fields while retaining the original backup and routine writes", () => {
  const f = fixture(), oldServer = seedClaude(f); applySetup(f.plan("claude"), f.options);
  const live = json(f.file("claude")); live.numStartups = 22; live.projects["/later"] = { trusted: true }; live.mcpServers.other.args = ["new args"]; put(f.file("claude"), JSON.stringify(live) + "\n");
  const moved: SetupContext = { ...f.options, bun: join(f.home, "new runtime", "bun"), entry: join(f.home, "new package", "bin", "amem.js") };
  expect(applySetup(f.plan("claude", "apply", moved), moved).applied).toContain("claude");
  const updated = json(f.file("claude")); expect(updated.mcpServers.amem).toEqual({ command: moved.bun, args: ["--smol", moved.entry, "mcp"] }); expect(updated.numStartups).toBe(22); expect(updated.projects["/later"]).toEqual({ trusted: true }); expect(updated.mcpServers.other.args).toEqual(["new args"]);
  const managed = hooks(json(f.file("claude", 1))).filter(handler => handler.command.includes(" hook ")); expect(managed).toHaveLength(7); expect(managed.every(handler => handler.command.includes(moved.entry!) && !handler.command.includes(f.entry))).toBe(true);
  undoSetup(f.plan("claude", "undo", moved), moved); const restored = json(f.file("claude")); expect(restored.mcpServers.amem).toEqual(oldServer); expect(restored.numStartups).toBe(22); expect(restored.projects["/later"]).toEqual({ trusted: true }); expect(restored.mcpServers.other.args).toEqual(["new args"]); expect(hooks(json(f.file("claude", 1))).map(handler => handler.command)).toEqual(["original-observer"]);
});
test("routine writes in a Claude config above one MiB remain within the supported eight-MiB path", () => {
  const f = fixture(), config = f.file("claude"), padding = "x".repeat(1024 * 1024 + 128); put(config, JSON.stringify({ numStartups: 1, padding, mcpServers: { other: { command: "keep" } } }));
  expect(readFileSync(config).length).toBeGreaterThan(1024 * 1024); expect(readFileSync(config).length).toBeLessThan(SETUP_CONFIG_BYTES);
  applySetup(f.plan("claude"), f.options); const live = json(config); live.numStartups = 2; put(config, JSON.stringify(live)); const bytes = readFileSync(config), calls = f.calls.length;
  expect(applySetup(f.plan("claude"), f.options)).toMatchObject({ applied: [], unchanged: ["claude"] }); expect(readFileSync(config)).toEqual(bytes); expect(f.calls).toHaveLength(calls);
  undoSetup(f.plan("claude", "undo"), f.options); expect(json(config).padding).toBe(padding); expect(json(config).numStartups).toBe(2); expect(json(config).mcpServers.other).toEqual({ command: "keep" }); expect(json(config).mcpServers.amem).toBeUndefined();
});
test("a native metadata write after temporary fsync and before publish is refused and preserved", () => {
  const f = fixture(), oldServer = seedClaude(f), config = f.file("claude"), settings = readFileSync(f.file("claude", 1)); let races = 0;
  const racing = { ...f.options, beforePublish: (file: string) => { if (file !== config || races) return; races++; const live = json(config); live.numStartups = 99; live.nativeWritten = "between planning and rename"; put(config, JSON.stringify(live) + "\n"); } };
  expect(() => applySetup(f.plan("claude", "apply", racing), racing)).toThrow(); expect(races).toBe(1);
  const after = json(config); expect(after.numStartups).toBe(99); expect(after.nativeWritten).toBe("between planning and rename"); expect(after.mcpServers.amem).toEqual(oldServer); expect(readFileSync(f.file("claude", 1))).toEqual(settings);
  expect(readdirSync(dirname(config)).some(name => name.startsWith(".amem-setup-"))).toBe(false);
});
test("prepared runtime update recovers the old hook generation after MCP publication without leaving duplicate hooks", () => {
  const f = fixture(), oldServer = seedClaude(f); applySetup(f.plan("claude"), f.options);
  const hookFile = f.file("claude", 1), moved: SetupContext = { ...f.options, entry: join(f.home, "runtime B package", "bin", "amem.js") };
  const update = f.plan("claude", "apply", moved); let interrupted = 0;
  const crashing: SetupContext = { ...moved, beforePublish: file => { if (file === hookFile) { interrupted++; throw Error("fixture interrupted before hook publication"); } } };
  expect(() => applySetup(update, crashing)).toThrow("fixture interrupted before hook publication"); expect(interrupted).toBe(1);
  expect(json(f.file("claude")).mcpServers.amem.args).toEqual(["--smol", moved.entry, "mcp"]);
  const oldHooks = hooks(json(hookFile)).filter(handler => handler.command.includes(" hook ")); expect(oldHooks).toHaveLength(7); expect(oldHooks.every(handler => handler.command.includes(f.entry) && !handler.command.includes(moved.entry!))).toBe(true);
  const prepared = JSON.parse(text(update.actions[0]!.receipt)); expect(prepared.phase).toBe("prepared"); expect(Buffer.from(prepared.changes[1].start.bytes, "base64").toString("utf8")).toContain(f.entry);
  expect(applySetup(f.plan("claude", "apply", moved), moved).applied).toContain("claude");
  const recovered = hooks(json(hookFile)).filter(handler => handler.command.includes(" hook ")); expect(recovered).toHaveLength(7); expect(recovered.every(handler => handler.command.includes(moved.entry!) && !handler.command.includes(f.entry))).toBe(true);
  undoSetup(f.plan("claude", "undo", moved), moved);
  expect(hooks(json(hookFile)).map(handler => handler.command)).toEqual(["original-observer"]); expect(json(f.file("claude")).mcpServers.amem).toEqual(oldServer); expect(existsSync(update.actions[0]!.receipt)).toBe(false);
});
test("a hook carrying the owned command but a changed core refuses apply and undo without changing files", () => {
  for (const target of ["claude", "codex", "kimi"] as const) {
    const f = fixture(), hookFile = f.file(target, 1);
    if (target === "claude") seedClaude(f);
    if (target === "codex") put(hookFile, '{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"original-observer"}]}]}}\n');
    if (target === "kimi") put(hookFile, 'hooks = [{ event = "Stop", command = "original-observer" }]\n');
    applySetup(f.plan(target), f.options); const undo = f.plan(target, "undo"), receipt = readFileSync(undo.actions[0]!.receipt);
    const document = target === "kimi" ? toml(hookFile) : json(hookFile), handlers = target === "kimi" ? document.hooks as Array<Record<string, any>> : hooks(document);
    const owned = handlers.find(handler => typeof handler.command === "string" && handler.command.includes(f.entry))!; expect(owned).toBeDefined(); owned.timeout = 999;
    put(hookFile, target === "kimi" ? Bun.TOML.stringify(document) : JSON.stringify(document, null, 2) + "\n");
    const files = [f.file(target), hookFile], before = files.map(file => ({ bytes: readFileSync(file), mode: lstatSync(file).mode & 0o777 })), calls = f.calls.length;
    expect(() => applySetup(f.plan(target), f.options)).toThrow(); expect(() => undoSetup(undo, f.options)).toThrow();
    expect(files.map(file => ({ bytes: readFileSync(file), mode: lstatSync(file).mode & 0o777 }))).toEqual(before); expect(readFileSync(undo.actions[0]!.receipt)).toEqual(receipt); expect(f.calls).toHaveLength(calls);
  }
});
test("semantic undo retains a pre-existing empty JSON config after a formatting-only native rewrite", () => {
  for (const target of ["claude", "kimi", "pi"] as const) {
    const f = fixture(), config = f.file(target); put(config, '{}\n', 0o640); applySetup(f.plan(target), f.options);
    put(config, ' \n' + JSON.stringify(json(config)) + '\n\n', 0o640); const calls = f.calls.length;
    undoSetup(f.plan(target, "undo"), f.options);
    expect(existsSync(config)).toBe(true); expect(json(config)).toEqual({}); expect(lstatSync(config).mode & 0o777).toBe(0o640); expect(f.calls).toHaveLength(calls);
  }
});
test("empty semantic restore does not resurrect unrelated root fields deleted after setup", () => {
  const f = fixture(), config = f.file("claude"); put(config, '{"numStartups":1}\n', 0o640); applySetup(f.plan("claude"), f.options);
  const installed = json(config); put(config, JSON.stringify({ mcpServers: { amem: installed.mcpServers.amem } }) + "\n", 0o600); const calls = f.calls.length;
  undoSetup(f.plan("claude", "undo"), f.options);
  expect(existsSync(config)).toBe(true); expect(json(config)).toEqual({}); expect(json(config).numStartups).toBeUndefined(); expect(lstatSync(config).mode & 0o777).toBe(0o600); expect(f.calls).toHaveLength(calls);
});
test("removed managed MCP entries restore earlier person entries and can be reapplied, including all-target undo", () => {
  for (const target of ["claude", "codex"] as const) {
    for (const previous of [false, true]) {
      const f = fixture(), config = f.file(target), old = { command: "person-original", args: ["keep"] };
      put(config, target === "codex" ? Bun.TOML.stringify({ model: "keep", ...(previous ? { mcp_servers: { amem: old } } : {}) }) : JSON.stringify({ counter: 1, ...(previous ? { mcpServers: { amem: old } } : {}) }));
      applySetup(f.plan(target), f.options);
      const remove = () => { const live = target === "codex" ? toml(config) : json(config); delete live[target === "codex" ? "mcp_servers" : "mcpServers"].amem; put(config, target === "codex" ? Bun.TOML.stringify(live) : JSON.stringify(live)); };
      remove(); expect(applySetup(f.plan(target), f.options).applied).toEqual([target]);
      expect((target === "codex" ? toml(config).mcp_servers : json(config).mcpServers).amem.command).toBe(Bun.which("bun"));
      remove(); expect(undoSetup(planSetup("all", "undo", f.options), f.options).restored).toContain(target);
      const restored = target === "codex" ? toml(config) : json(config);
      expect(restored[target === "codex" ? "mcp_servers" : "mcpServers"]?.amem).toEqual(previous ? old : undefined);
      expect(existsSync(f.plan(target).actions[0]!.receipt)).toBe(false);
    }
  }
});
test("missing managed hooks and new person hooks on the same event/matcher never wedge apply or undo", () => {
  for (const target of ["claude", "codex", "kimi"] as const) {
    const f = fixture(), config = f.file(target, 1); applySetup(f.plan(target), f.options);
    const replace = () => {
      const doc = target === "kimi" ? toml(config) : json(config), person = { type: "command", command: "person-new-observer", timeout: 12 };
      if (target === "kimi") { doc.hooks = doc.hooks.filter((row: any) => !row.command.includes(f.entry)); doc.hooks.push({ event: "SessionEnd", command: person.command, timeout: 12 }); }
      else { const event = target === "claude" ? "SessionStart" : "SessionEnd"; doc.hooks[event] = [{ hooks: [person] }]; }
      put(config, target === "kimi" ? Bun.TOML.stringify(doc) : JSON.stringify(doc));
    };
    replace(); expect(applySetup(f.plan(target), f.options).applied).toEqual([target]);
    const applied = target === "kimi" ? toml(config).hooks : hooks(json(config)); expect(applied.some((row: any) => row.command === "person-new-observer")).toBe(true);
    replace(); undoSetup(f.plan(target, "undo"), f.options);
    const restored = target === "kimi" ? toml(config).hooks : hooks(json(config)); expect(restored.some((row: any) => row.command === "person-new-observer")).toBe(true); expect(restored.some((row: any) => row.command.includes(f.entry))).toBe(false);
  }
});
test("semantic Codex undo drops setup-created empty parent tables and preserves later fields", () => {
  for (const original of [undefined, 'model = "keep"\n', '[mcp_servers]\n']) {
    const f = fixture(), config = f.file("codex"); if (original !== undefined) put(config, original);
    applySetup(f.plan("codex"), f.options); put(config, text(config) + '\n# later native rewrite\n[projects."/keep"]\ntrust_level = "trusted"\n');
    undoSetup(f.plan("codex", "undo"), f.options); const restored = toml(config);
    expect(restored.projects["/keep"].trust_level).toBe("trusted"); expect(restored.mcp_servers).toEqual(original === '[mcp_servers]\n' ? {} : undefined);
  }
  const f = fixture(), config = f.file("codex"); applySetup(f.plan("codex"), f.options); put(config, '\n' + text(config)); undoSetup(f.plan("codex", "undo"), f.options); expect(existsSync(config)).toBe(false);
});
test("PATH-resolved stable symlink runtime launches MCP and hooks even with a GUI minimal PATH", () => {
  const f = fixture(), bin = join(f.home, "bin"), stable = join(bin, "bun"), record = join(f.home, "launches"); mkdirSync(bin); symlinkSync(process.execPath, stable);
  put(f.entry, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(record)}, process.argv.slice(2).join(' ')+'\\n');`);
  const options = { ...f.options, env: { ...f.env, PATH: bin } }, plan = planSetup("claude", "apply", options);
  expect(plan.actions[0]!.registration).toContain(stable); applySetup(plan, options);
  const server = json(f.file("claude")).mcpServers.amem, minimal = { HOME: f.home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  expect(server.command).toBe(stable); expect(spawnSync(server.command, server.args, { env: minimal }).status).toBe(0);
  expect(spawnSync("/bin/sh", ["-c", plan.actions[0]!.hooks[0]!.command], { env: minimal }).status).toBe(0);
  expect(text(record)).toContain("mcp"); expect(text(record)).toContain("hook SessionStart");
});
test("ordinary setup refuses temporary installed entry before any mutation", () => {
  const f = fixture(); put(f.entry, "// temporary bunx fixture\n"); const { native: unused, ...production } = f.options;
  expect(() => planSetup("claude", "apply", production)).toThrow("temporary package entry"); expect(f.calls).toHaveLength(0); expect(existsSync(join(f.home, "memory"))).toBe(false);
});
test("dry run names installed agent-mem plugin before direct Claude setup", () => {
  const f = fixture(); put(f.file("claude", 1), JSON.stringify({ enabledPlugins: { "agent-mem@agent-mem": true, "other@market": true } }));
  put(join(f.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "agent-mem@private-market": [{ installPath: "/unused" }] } }));
  const plan = planSetup("claude", "preview", f.options); expect(plan.notes.join("\n")).toContain("Installed Claude plugin agent-mem@agent-mem"); expect(plan.notes.join("\n")).toContain("agent-mem@private-market"); expect(plan.notes.join("\n")).toContain("duplicate"); expect(f.calls).toHaveLength(0);
});

test("Codex undo also removes a setup-created parent after native MCP removal", () => {
  const f = fixture(), config = f.file("codex"); applySetup(f.plan("codex"), f.options);
  put(config, '[mcp_servers]\n'); undoSetup(f.plan("codex", "undo"), f.options); expect(existsSync(config)).toBe(false);
});

test("a pre-existing matcher-restricted hook never suppresses the unrestricted setup hook", () => {
  const f = fixture(), file = f.file("claude", 1), command = f.plan("claude").actions[0]!.hooks.find(row => row.event === "PreToolUse")!.command;
  const restricted = { matcher: "Bash", hooks: [{ type: "command", command, timeout: 1 }] };
  put(file, JSON.stringify({ hooks: { PreToolUse: [restricted] } })); const original = text(file);
  applySetup(f.plan("claude"), f.options); const groups = json(file).hooks.PreToolUse;
  expect(groups).toContainEqual(restricted); expect(groups.filter((group: any) => group.matcher === undefined)).toHaveLength(1);
  expect(groups.find((group: any) => group.matcher === undefined).hooks).toEqual([{ type: "command", command, timeout: 1 }]);
  expect(applySetup(f.plan("claude"), f.options).unchanged).toEqual(["claude"]);
  undoSetup(f.plan("claude", "undo"), f.options); expect(text(file)).toBe(original);
});
test("Kimi setup and later semantic undo retain person hook source comments, float spelling and CRLF", () => {
  for (const source of ['# retained banner\r\n[[hooks]]\r\n# retained element comment\r\nevent = "Stop"\r\ncommand = "person-observer"\r\ntimeout = 5.0\r\n', 'hooks = [\r\n  # retained element comment\r\n  { event = "Stop", command = "person-observer", timeout = 5.0 }, # tail comment\r\n]\r\n']) {
    const f = fixture(), config = f.file("kimi", 1); put(config, source); applySetup(f.plan("kimi"), f.options);
    for (const fragment of ['# retained element comment\r\n', 'timeout = 5.0']) expect(text(config)).toContain(fragment);
    expect(text(config).replaceAll("\r\n", "")).not.toContain("\n");
    put(config, 'owner = "later"\r\n' + text(config)); undoSetup(f.plan("kimi", "undo"), f.options);
    for (const fragment of ['# retained element comment\r\n', 'timeout = 5.0']) expect(text(config)).toContain(fragment);
    expect(text(config).replaceAll("\r\n", "")).not.toContain("\n"); expect(toml(config).owner).toBe("later"); expect(toml(config).hooks).toEqual((Bun.TOML.parse(source) as any).hooks);
  }
});
test("a temporary entry symlink to a persistent binary is still refused", () => {
  const f = fixture(); mkdirSync(dirname(f.entry), { recursive: true }); symlinkSync(process.execPath, f.entry); const { native: unused, ...production } = f.options;
  expect(() => planSetup("claude", "apply", production)).toThrow("temporary package entry"); expect(f.calls).toHaveLength(0);
});
