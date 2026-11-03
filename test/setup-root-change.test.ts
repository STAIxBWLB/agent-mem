import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { applySetup, planSetup, undoSetup, type SetupContext } from "../src/setup.ts";
import { realPath } from "../src/memory/platform.ts";

const TARGETS = ["claude", "codex", "kimi", "qwen", "pi", "jcode"] as const;
type Target = typeof TARGETS[number];
type Document = Record<string, any>;
interface Image { bytes: Buffer | null; mode: number | null }
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function put(file: string, value: string) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, value, { mode: 0o600 }); chmodSync(file, 0o600); }
const text = (file: string) => readFileSync(file, "utf8");
const image = (file: string): Image => existsSync(file) ? { bytes: readFileSync(file), mode: lstatSync(file).mode & 0o777 } : { bytes: null, mode: null };

function fixture(target: Target) {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-root-change-"))); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const env: Record<string, string | undefined> = { HOME: home, AMEM_HOME: join(home, "memory"), PATH: "", CODEX_HOME: join(home, ".codex"),
    KIMI_CODE_HOME: join(home, ".kimi-code"), QWEN_HOME: join(home, ".qwen"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), JCODE_HOME: join(home, ".jcode"), XDG_CONFIG_HOME: join(home, ".config") };
  const oldRoot = join(home, "old release's package"), newRoot = join(home, "new release's \"quoted package\"");
  for (const [root, version] of [[oldRoot, "0.19.0"], [newRoot, "0.20.0"]] as const) {
    put(join(root, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version }) + "\n");
    put(join(root, "bin", "amem.js"), "// private setup fixture, never executed\n");
  }
  const calls: string[][] = [];
  const native: NonNullable<SetupContext["native"]> = (argv, staged, cwd) => {
    calls.push([...argv]);
    const client = argv[0], remove = argv[2] === "remove", marker = argv.indexOf("--");
    expect(["claude", "codex", "pi", "qwen"]).toContain(client!);
    expect(argv.slice(1, 3)).toEqual(["mcp", remove ? "remove" : "add"]);
    expect(staged.HOME).toBe(cwd); expect(cwd).not.toBe(home);
    expect(cwd.startsWith(realPath(tmpdir()) + "/amem-setup-")).toBe(true);
    const file = client === "claude" ? join(staged.HOME!, ".claude.json") : client === "codex" ? join(staged.CODEX_HOME!, "config.toml")
      : client === "qwen" ? join(staged.QWEN_HOME!, "settings.json") : join(staged.PI_CODING_AGENT_DIR!, "mcp.json");
    expect(file.startsWith(cwd + "/")).toBe(true);
    const document: Document = existsSync(file) ? client === "codex" ? Bun.TOML.parse(text(file)) : JSON.parse(text(file)) : {};
    const key = client === "codex" ? "mcp_servers" : "mcpServers"; document[key] ??= {};
    const launch = client === "qwen" ? [argv[marker - 1], ...argv.slice(marker + 1)] : argv.slice(marker + 1);
    if (remove) delete document[key].amem; else document[key].amem = { command: launch[0], args: launch.slice(1) };
    put(file, client === "codex" ? Bun.TOML.stringify(document) : JSON.stringify(document, null, 2) + "\n");
  };
  const options = (root: string): SetupContext => ({ env, cwd: home, bun: process.execPath, root, native, stdinTTY: false });
  const oldPlan = planSetup(target, "apply", options(oldRoot)), newPlan = planSetup(target, "apply", options(newRoot));
  const action = oldPlan.actions[0]!, files = action.files;
  expect(files.every(file => file.startsWith(home + "/"))).toBe(true); expect(action.receipt.startsWith(home + "/")).toBe(true);
  expect(newPlan.actions[0]!.files).toEqual(files);
  const other = { command: "fixture-unrelated-server", args: ["keep"] }, custom: Record<string, string[]> = {};
  for (const hook of action.hooks) custom[hook.event] = ["echo " + quote(hook.command), hook.command.replace("amem.js", "amem.js.backup")];
  const jsonHooks = () => Object.fromEntries(Object.entries(custom).map(([event, commands]) => [event,
    [{ matcher: "*", hooks: commands.map(command => ({ type: "command", command, timeout: 7 })) }],
  ]));
  if (target === "codex") put(files[0]!, '# original MCP comment\nfixture_setting = "keep"\n[mcp_servers.other]\ncommand = "fixture-unrelated-server"\nargs = ["keep"]\n');
  else if (target === "jcode") put(files[0]!, JSON.stringify({ fixture_setting: "keep", servers: { other } }, null, 2) + "\n");
  else put(files[0]!, JSON.stringify({ fixture_setting: "keep", mcpServers: { other },
    ...(target === "qwen" ? { hooks: { enabled: false, disabled: ["fixture-unrelated"], ...jsonHooks() } } : {}),
  }, null, 2) + "\n");
  let extra: string | undefined;
  if (target === "claude" || target === "codex") put(files[1]!, JSON.stringify({ fixture_setting: "keep", hooks: jsonHooks() }, null, 2) + "\n");
  if (target === "kimi") {
    const rows = Object.entries(custom).flatMap(([event, commands]) => commands.map(command => "{ event = " + JSON.stringify(event) + ", command = " + JSON.stringify(command) + ", timeout = 7 }"));
    put(files[1]!, '# original Kimi hooks\nfixture_setting = "keep"\nhooks = [\n  ' + rows.join(",\n  ") + "\n]\n");
  }
  if (target === "jcode") put(files[1]!, '# original Jcode hooks\nfixture_setting = "keep"\n[hooks]\n'
    + Object.entries(custom).map(([event, commands]) => event + " = " + JSON.stringify(commands)).join("\n") + '\ncustom_fixture = "echo keep-other-event"\n');
  if (target === "pi") {
    extra = join(dirname(files[1]!), "user-session.ts");
    put(extra, "// unrelated extension containing an old command lookalike\nexport default function(pi) { pi.on('session_shutdown', () => console.log("
      + JSON.stringify(custom.session_shutdown![0]) + ")); }\n");
  }
  const originals = new Map([...files, ...(extra ? [extra] : [])].map(file => [file, image(file)]));
  return { home, target, calls, oldRoot, newRoot, oldEntry: join(oldRoot, "bin", "amem.js"), newEntry: join(newRoot, "bin", "amem.js"), files, custom, extra, originals, receipt: action.receipt, options,
    oldHooks: action.hooks, newHooks: newPlan.actions[0]!.hooks,
    apply(root: string) { const opts = options(root); return applySetup(planSetup(target, "apply", opts), opts); },
    undo(root: string) { const opts = options(root); return undoSetup(planSetup(target, "undo", opts), opts); },
  };
}
type Fixture = ReturnType<typeof fixture>;

function hookCommands(f: Fixture): Map<string, string[]> {
  const file = f.target === "qwen" ? f.files[0]! : f.files[1]!;
  if (!existsSync(file)) return new Map();
  if (f.target === "pi") {
    const source = text(file), calls = [...source.matchAll(/spawnSync\(("(?:\\.|[^"\\])*"),\s*\['--smol',\s*("(?:\\.|[^"\\])*"),\s*'ingest',\s*'pi'\]/g)];
    expect((source.match(/pi\.on\('session_shutdown'/g) ?? []).length).toBe(1);
    return new Map([["session_shutdown", calls.map(call => quote(JSON.parse(call[1]!)) + " --smol " + quote(JSON.parse(call[2]!)) + " ingest pi")]]);
  }
  const document: Document = f.target === "kimi" || f.target === "jcode" ? Bun.TOML.parse(text(file)) : JSON.parse(text(file));
  if (f.target === "kimi") {
    const entries = new Map<string, string[]>();
    for (const hook of document.hooks ?? []) entries.set(hook.event, [...(entries.get(hook.event) ?? []), hook.command]);
    return entries;
  }
  if (f.target === "jcode") return new Map(Object.entries(document.hooks ?? {}).map(([event, value]) => [event, typeof value === "string" ? [value] : value as string[]]));
  return new Map(Object.entries(document.hooks ?? {}).filter(([, value]) => Array.isArray(value)).map(([event, groups]) => [event,
    (groups as Document[]).flatMap(group => (group.hooks ?? []).filter((hook: Document) => hook.type === "command").map((hook: Document) => hook.command as string)),
  ]));
}

function registeredOnly(f: Fixture, which: "old" | "new"): void {
  const commands = hookCommands(f), wanted = which === "new" ? f.newHooks : f.oldHooks, removed = which === "new" ? f.oldHooks : f.newHooks;
  for (const hook of wanted) {
    const event = commands.get(hook.event) ?? [], prior = removed.find(row => row.event === hook.event)!;
    expect(event.filter(command => command === hook.command), f.target + " " + hook.event + ": exactly one selected-root command").toHaveLength(1);
    expect(event.filter(command => command === prior.command), f.target + " " + hook.event + ": other-root command absent").toHaveLength(0);
    if (f.target !== "pi") for (const custom of f.custom[hook.event]!) expect(event.filter(command => command === custom)).toHaveLength(1);
  }
  const document: Document = f.target === "codex" ? Bun.TOML.parse(text(f.files[0]!)) : JSON.parse(text(f.files[0]!));
  const servers = document[f.target === "codex" ? "mcp_servers" : f.target === "jcode" ? "servers" : "mcpServers"];
  expect(servers.other).toEqual({ command: "fixture-unrelated-server", args: ["keep"] });
  expect(servers.amem).toMatchObject({ command: process.execPath, args: ["--smol", which === "new" ? f.newEntry : f.oldEntry, "mcp"] });
  expect(document.fixture_setting).toBe("keep");
  if (f.target === "qwen") { expect(document.hooks.enabled).toBe(false); expect(document.hooks.disabled).toEqual(["fixture-unrelated"]); }
  if (f.target === "jcode") expect(hookCommands(f).get("custom_fixture")).toEqual(["echo keep-other-event"]);
  if (f.extra) expect(image(f.extra)).toEqual(f.originals.get(f.extra)!);
  if (f.target === "kimi" || f.target === "jcode") expect(f.calls).toHaveLength(0);
  else expect(f.calls.some(call => call[0] === f.target && call[1] === "mcp")).toBe(true);
}
function restored(expected: Map<string, Image>): void { for (const [file, before] of expected) expect(image(file), file).toEqual(before); }
function adopt(f: Fixture): Map<string, Image> {
  f.apply(f.oldRoot); registeredOnly(f, "old"); expect(existsSync(f.receipt)).toBe(true); rmSync(f.receipt);
  const before = new Map([...f.originals.keys()].map(file => [file, image(file)]));
  expect(f.apply(f.oldRoot).applied).toEqual([f.target]); restored(before);
  const receipt = JSON.parse(text(f.receipt)) as { changes: { before: { bytes: string | null }; after: { bytes: string | null } }[] };
  expect(receipt.changes.every(change => change.before.bytes === change.after.bytes), "adoption has no ownership delta").toBe(true);
  return before;
}

for (const target of TARGETS) test(target + ": a new --root replaces managed hooks once and undo restores original bytes", () => {
  const f = fixture(target);
  expect(f.apply(f.oldRoot).applied).toEqual([target]); registeredOnly(f, "old");
  expect(JSON.parse(text(f.receipt)).version, "initial setup stays receipt v1").toBe(1);
  expect(f.apply(f.newRoot).applied).toEqual([target]); registeredOnly(f, "new");
  expect(JSON.parse(text(f.receipt)).version, "ordinary receipt-owned relocation stays receipt v1").toBe(1);
  f.undo(f.newRoot); restored(f.originals); expect(existsSync(f.receipt)).toBe(false);
});

for (const target of TARGETS) test(target + ": a new --root replaces adopted pre-existing hooks even when the receipt owns no delta", () => {
  const f = fixture(target), preAdoption = adopt(f);
  expect(f.apply(f.newRoot).applied).toEqual([target]); registeredOnly(f, "new");
  expect(JSON.parse(text(f.receipt)).version, "removing an adopted original hook requires receipt v2").toBe(2);
  f.undo(f.newRoot); restored(preAdoption); expect(existsSync(f.receipt)).toBe(false);
});

for (const target of TARGETS) test(target + ": a new --root directly replaces receipt-less old wiring and undo restores that original wiring", () => {
  const f = fixture(target);
  f.apply(f.oldRoot); registeredOnly(f, "old"); expect(existsSync(f.receipt)).toBe(true); rmSync(f.receipt);
  const originalWiring = new Map([...f.originals.keys()].map(file => [file, image(file)]));
  // No same-root adoption occurs here. Pi's existing extension is accepted only
  // through its exact previous MCP binding, not a broad managed-looking comment.
  expect(f.apply(f.newRoot).applied).toEqual([target]); registeredOnly(f, "new");
  expect(JSON.parse(text(f.receipt)).version, "removing receipt-less original wiring requires receipt v2").toBe(2);
  f.undo(f.newRoot); restored(originalWiring); expect(existsSync(f.receipt)).toBe(false);
});

for (const target of TARGETS) test(target + ": semantic undo restores adopted old commands and preserves unrelated later settings", () => {
  const f = fixture(target); adopt(f);
  expect(f.apply(f.newRoot).applied).toEqual([target]); registeredOnly(f, "new");
  const file = target === "qwen" || target === "pi" ? f.files[0]! : f.files[1]!;
  if (target === "kimi" || target === "jcode") put(file, 'later_fixture = "preserved"\n' + text(file));
  else { const document: Document = JSON.parse(text(file)); document.later_fixture = "preserved"; put(file, JSON.stringify(document, null, 2) + "\n"); }
  f.undo(f.newRoot); registeredOnly(f, "old"); expect(existsSync(f.receipt)).toBe(false);
  const restoredDocument: Document = target === "kimi" || target === "jcode" ? Bun.TOML.parse(text(file)) : JSON.parse(text(file));
  expect(restoredDocument.later_fixture).toBe("preserved");
});

for (const target of TARGETS) test(target + ": same-root apply repairs a frozen 0.20.0 v1 receipt that accepted old and new hooks", () => {
  const f = fixture(target), originalOldWiring = adopt(f);
  const primary: Document = target === "codex" ? Bun.TOML.parse(text(f.files[0]!)) : JSON.parse(text(f.files[0]!));
  const key = target === "codex" ? "mcp_servers" : target === "jcode" ? "servers" : "mcpServers";
  primary[key].amem = { ...primary[key].amem, command: process.execPath, args: ["--smol", f.newEntry, "mcp"] };
  put(f.files[0]!, target === "codex" ? Bun.TOML.stringify(primary) : JSON.stringify(primary, null, 2) + "\n");
  const hookFile = target === "qwen" ? f.files[0]! : f.files[1]!;
  if (target === "pi") {
    const source = text(hookFile), old = JSON.stringify(f.oldEntry);
    expect(source.split(old)).toHaveLength(2);
    put(hookFile, source.replace(old, JSON.stringify(f.newEntry)));
  } else {
    const document: Document = target === "kimi" || target === "jcode" ? Bun.TOML.parse(text(hookFile)) : JSON.parse(text(hookFile));
    for (const hook of f.newHooks) {
      if (target === "kimi") document.hooks.push({ event: hook.event, command: hook.command, timeout: hook.timeout });
      else if (target === "jcode") {
        const value = document.hooks[hook.event];
        document.hooks[hook.event] = [...(typeof value === "string" ? [value] : value), hook.command];
      } else document.hooks[hook.event].push({ hooks: [{ type: "command", command: hook.command, timeout: hook.timeout }] });
    }
    put(hookFile, target === "kimi" || target === "jcode" ? Bun.TOML.stringify(document) : JSON.stringify(document, null, 2) + "\n");
  }
  // Frozen legacy intent algorithm, deliberately independent of setup's current
  // implementation. Its matching intent used to skip repair of this live state.
  const legacyIntent: unknown[] = [1, target, f.files, process.execPath, f.newEntry];
  if (target === "codex" || target === "kimi" || target === "qwen") legacyIntent.push("capture-json-v1");
  if (target === "jcode") legacyIntent.push("jcode-hooks-v1");
  const receipt = JSON.parse(text(f.receipt)) as {
    version: number; phase: string; intent: string;
    changes: { path: string; before: { bytes: string | null; mode: number }; after: { bytes: string | null; mode: number } }[];
  };
  receipt.version = 1; receipt.phase = "applied";
  receipt.intent = createHash("sha256").update(JSON.stringify(legacyIntent)).digest("hex");
  for (const change of receipt.changes) {
    const current = image(change.path);
    change.after = { bytes: current.bytes?.toString("base64") ?? null, mode: current.mode ?? 0o600 };
    expect(change.before.bytes).toBe(originalOldWiring.get(change.path)!.bytes?.toString("base64") ?? null);
  }
  put(f.receipt, JSON.stringify(receipt) + "\n");
  expect(f.apply(f.newRoot).applied, "legacy matching intent must trigger repair, not unchanged").toEqual([target]);
  registeredOnly(f, "new");
  f.undo(f.newRoot); restored(originalOldWiring); expect(existsSync(f.receipt)).toBe(false);
});

const previousRoot = process.env.AMEM_PREV_ROOT, previousRequired = process.env.AMEM_PREV_REQUIRED === "1";
if (previousRoot && !isAbsolute(previousRoot)) throw Error("AMEM_PREV_ROOT must be an absolute published package root");
const previousManifest = previousRoot ? JSON.parse(text(join(previousRoot, "package.json"))) as { name: string; version: string } : undefined;
if (previousManifest && previousManifest.name !== "@staix/agent-mem") throw Error("AMEM_PREV_ROOT is not an @staix/agent-mem package");
const previousReleaseTest = previousRoot ? previousManifest!.version === "0.20.0" ? test : test.skip : previousRequired ? test : test.skip;
for (const target of TARGETS) previousReleaseTest(target + ": published 0.20.0 setup refuses replacement receipts before config publication", async () => {
  expect(previousRoot, "AMEM_PREV_ROOT is required by the previous-release gate").toBeTruthy();
  if (!previousRoot) throw Error("AMEM_PREV_ROOT is required");
  expect(isAbsolute(previousRoot)).toBe(true);
  const pkg = previousManifest!;
  expect(pkg.name).toBe("@staix/agent-mem"); expect(pkg.version).toBe("0.20.0");
  const previous = await import(pathToFileURL(join(previousRoot, "src", "setup.ts")).href) as {
    applySetup: typeof applySetup; undoSetup: typeof undoSetup;
  };
  const f = fixture(target); adopt(f); f.apply(f.newRoot);
  expect(JSON.parse(text(f.receipt)).version).toBe(2);
  const publications: string[] = [], opts = { ...f.options(f.newRoot), beforePublish: (file: string) => publications.push(file) };
  const apply = planSetup(target, "apply", opts), undo = planSetup(target, "undo", opts), nativeCalls = f.calls.length;
  const before = new Map([...f.originals.keys(), f.receipt].map(file => [file, image(file)]));
  expect(() => previous.applySetup(apply, opts), "published " + pkg.version + " apply must refuse receipt v2").toThrow(/setup receipt.*(?:match|version)/);
  expect(publications).toEqual([]); expect(f.calls).toHaveLength(nativeCalls); restored(before);
  expect(() => previous.undoSetup(undo, opts), "published " + pkg.version + " undo must refuse receipt v2").toThrow(/setup receipt.*(?:match|version)/);
  expect(publications).toEqual([]); expect(f.calls).toHaveLength(nativeCalls); restored(before);
  console.log(JSON.stringify({ diagnostic: "setup-receipt-v2-published-reader", version: pkg.version, target, refusedApply: true, refusedUndo: true, configPublications: publications.length }));
});

for (const target of TARGETS) previousReleaseTest(target + ": published 0.20.0 undo accepts an ordinary receipt-v1 root relocation", async () => {
  expect(previousRoot, "AMEM_PREV_ROOT is required by the previous-release gate").toBeTruthy();
  if (!previousRoot) throw Error("AMEM_PREV_ROOT is required");
  const pkg = previousManifest!; expect(pkg.name).toBe("@staix/agent-mem"); expect(pkg.version).toBe("0.20.0");
  const previous = await import(pathToFileURL(join(previousRoot, "src", "setup.ts")).href) as { undoSetup: typeof undoSetup };
  const f = fixture(target); f.apply(f.oldRoot);
  expect(JSON.parse(text(f.receipt)).version).toBe(1);
  f.apply(f.newRoot); registeredOnly(f, "new"); expect(JSON.parse(text(f.receipt)).version).toBe(1);
  const options = f.options(f.newRoot);
  previous.undoSetup(planSetup(target, "undo", options), options);
  restored(f.originals); expect(existsSync(f.receipt)).toBe(false);
  console.log(JSON.stringify({ diagnostic: "setup-receipt-v1-published-undo", version: pkg.version, target, acceptedUndo: true, originalBytesRestored: true }));
});

for (const target of ["claude", "codex", "qwen", "kimi", "jcode"] as const) test(target + ": semantic undo restores adopted OLD hooks before observers in their original ordered position", () => {
  const f = fixture(target); f.apply(f.oldRoot); registeredOnly(f, "old");
  const file = target === "qwen" ? f.files[0]! : f.files[1]!, isToml = target === "kimi" || target === "jcode";
  const document: Document = isToml ? Bun.TOML.parse(text(file)) : JSON.parse(text(file));
  for (const old of f.oldHooks) {
    const observer = "echo ordered observer " + old.event;
    if (target === "jcode") {
      const commands = document.hooks[old.event] as string[];
      document.hooks[old.event] = [old.command, observer, ...commands.filter(command => command !== old.command)];
    } else if (target === "kimi") {
      const hooks = document.hooks as Document[], owned = hooks.find(hook => hook.event === old.event && hook.command === old.command)!;
      document.hooks = [owned, { event: old.event, command: observer, timeout: 11 }, ...hooks.filter(hook => hook !== owned)];
    } else {
      const hooks = (document.hooks[old.event] as Document[]).flatMap(group => group.hooks as Document[]), owned = hooks.find(hook => hook.command === old.command)!;
      // OLD and observers deliberately occupy one group, so restoring a removed
      // OLD row at the end instead of its original index is observable.
      document.hooks[old.event] = [{ matcher: "*", hooks: [owned, { type: "command", command: observer, timeout: 11 }, ...hooks.filter(hook => hook !== owned)] }];
    }
  }
  put(file, isToml ? Bun.TOML.stringify(document) : JSON.stringify(document, null, 2) + "\n");
  const orderedHooks = structuredClone(document.hooks), beforeAdoption = new Map([...f.originals.keys()].map(file => [file, image(file)]));
  rmSync(f.receipt); f.apply(f.oldRoot); restored(beforeAdoption);
  const adopted = JSON.parse(text(f.receipt)) as { changes: { before: { bytes: string | null }; after: { bytes: string | null } }[] };
  expect(adopted.changes.every(change => change.before.bytes === change.after.bytes), "ordered adoption owns no delta").toBe(true);
  f.apply(f.newRoot); registeredOnly(f, "new");
  if (isToml) put(file, 'later_fixture = "preserved"\n' + text(file));
  else { const later: Document = JSON.parse(text(file)); later.later_fixture = "preserved"; put(file, JSON.stringify(later, null, 2) + "\n"); }
  f.undo(f.newRoot); registeredOnly(f, "old");
  const result: Document = isToml ? Bun.TOML.parse(text(file)) : JSON.parse(text(file));
  expect(result.hooks).toEqual(orderedHooks); expect(result.later_fixture).toBe("preserved"); expect(existsSync(f.receipt)).toBe(false);
});

for (const target of ["claude", "codex", "qwen", "kimi", "jcode"] as const) test(target + ": same current-intent apply repairs a reintroduced known OLD hook without rerunning native MCP registration", () => {
  const f = fixture(target), originalOldWiring = adopt(f);
  f.apply(f.newRoot); registeredOnly(f, "new");
  const receiptBefore = text(f.receipt), intent = JSON.parse(receiptBefore).intent as string, nativeCalls = f.calls.length;
  const file = target === "qwen" ? f.files[0]! : f.files[1]!, isToml = target === "kimi" || target === "jcode";
  const document: Document = isToml ? Bun.TOML.parse(text(file)) : JSON.parse(text(file));
  for (const old of f.oldHooks) {
    if (target === "kimi") document.hooks.push({ event: old.event, command: old.command, timeout: old.timeout });
    else if (target === "jcode") {
      const value = document.hooks[old.event];
      document.hooks[old.event] = [...(typeof value === "string" ? [value] : value), old.command];
    } else document.hooks[old.event].push({ hooks: [{ type: "command", command: old.command, timeout: old.timeout }] });
  }
  put(file, isToml ? Bun.TOML.stringify(document) : JSON.stringify(document, null, 2) + "\n");
  expect(text(f.receipt)).toBe(receiptBefore); // current intent and its recorded images were not changed
  const primary: Document = target === "codex" ? Bun.TOML.parse(text(f.files[0]!)) : JSON.parse(text(f.files[0]!));
  const servers = primary[target === "codex" ? "mcp_servers" : target === "jcode" ? "servers" : "mcpServers"];
  expect(servers.amem.args).toEqual(["--smol", f.newEntry, "mcp"]);
  for (const old of f.oldHooks) expect(hookCommands(f).get(old.event)!.filter(command => command === old.command)).toHaveLength(1);
  expect(f.apply(f.newRoot).applied, "matching intent must not hide reintroduced known OLD hooks").toEqual([target]);
  registeredOnly(f, "new"); expect(f.calls).toHaveLength(nativeCalls); expect(JSON.parse(text(f.receipt)).intent).toBe(intent);
  f.undo(f.newRoot); registeredOnly(f, "old");
  // Reinsertion models an external writer whose TOML serialization discarded
  // comments/formatting. Undo restores full configuration semantics, not those discarded bytes.
  for (const [file, before] of originalOldWiring) {
    expect(before.bytes).not.toBeNull();
    const original = before.bytes!.toString("utf8"), current = text(file);
    expect(file.endsWith(".toml") ? Bun.TOML.parse(current) : JSON.parse(current), file)
      .toEqual(file.endsWith(".toml") ? Bun.TOML.parse(original) : JSON.parse(original));
  }
  expect(existsSync(f.receipt)).toBe(false);
});

for (const flow of ["adopted", "receipt-less"] as const) for (const surface of ["async", "sequential"] as const) test("qwen: NEW root refuses customized OLD " + surface + " settings in " + flow + " wiring", () => {
  const f = fixture("qwen"); f.apply(f.oldRoot); registeredOnly(f, "old");
  const file = f.files[0]!, document: Document = JSON.parse(text(file)), command = f.oldHooks.find(hook => hook.event === "SessionEnd")!.command;
  const group = (document.hooks.SessionEnd as Document[]).find(row => row.hooks.some((hook: Document) => hook.command === command))!;
  if (surface === "async") group.hooks.find((hook: Document) => hook.command === command)!.async = true;
  else group.sequential = true;
  put(file, JSON.stringify(document, null, 2) + "\n"); rmSync(f.receipt);
  const customized = new Map([...f.originals.keys()].map(file => [file, image(file)]));
  if (flow === "adopted") {
    f.apply(f.oldRoot); restored(customized);
    const receipt = JSON.parse(text(f.receipt)) as { changes: { before: { bytes: string | null }; after: { bytes: string | null } }[] };
    expect(receipt.changes.every(change => change.before.bytes === change.after.bytes), "same-root adoption preserves customized controls without owning them").toBe(true);
  }
  const before = new Map([...f.originals.keys(), f.receipt].map(file => [file, image(file)])), publications: string[] = [];
  const options = { ...f.options(f.newRoot), beforePublish: (path: string) => { publications.push(path); } };
  // Native MCP work in private staging is permitted; publishing any live image
  // or dropping the user's behavioral controls is not.
  expect(() => applySetup(planSetup("qwen", "apply", options), options))
    .toThrow("previous-runtime hook settings are customized; review hook configuration before retrying setup");
  restored(before); expect(publications).toEqual([]);
});
