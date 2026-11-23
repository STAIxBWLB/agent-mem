import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSetupWriterRoots, runSetup, SetupWriterRootsError, type SetupContext, type SetupTarget } from "../src/setup.ts";
import { realPath } from "../src/memory/platform.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { isAmemCommand, parseCommand } from "../src/commands-table.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const image = (text: string) => ({ mode: 0o600, bytes: Buffer.from(text).toString("base64") });
/** #551 AC2: the shell quoting setup uses for a suggested argument, restated here so a rendering change is visible. */
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-setup-writer-roots-"))); chmodSync(root, 0o700); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "memory"), dir = join(home, "setup"); mkdirSync(home, { mode: 0o700 }); mkdirSync(dir, { mode: 0o700 });
  const install = (name: string) => { const base = join(root, name); mkdirSync(base, { mode: 0o700 }); for (const part of ["bin", "src"]) mkdirSync(join(base, part), { mode: 0o700 });
    writeFileSync(join(base, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.21.0" }), { mode: 0o600 });
    writeFileSync(join(base, "bin", "amem.js"), "// fixture only\n", { mode: 0o600 }); writeFileSync(join(base, "src", "cli.ts"), "// fixture only\n", { mode: 0o600 }); return base; };
  return { root, home, dir, install };
}
function document(target: SetupTarget, entry: string, escaped = false): string {
  const runtime = { command: "/fixture/bin/bun", args: ["--smol", entry, "mcp"] };
  if (target === "codex") return `[mcp_servers.amem]\ncommand = ${JSON.stringify(runtime.command)}\nargs = ["--smol", ${JSON.stringify(entry)}, "mcp"]\n`;
  const text = JSON.stringify(target === "opencode" ? { mcp: { amem: { type: "local", command: [runtime.command, ...runtime.args], enabled: true } } }
    : target === "jcode" ? { servers: { amem: { ...runtime, shared: false } } } : { mcpServers: { amem: runtime } });
  return escaped ? text.replaceAll("/", "\\/") : text;
}
function receipt(target: SetupTarget, entry: string, beforeEntry = "/missing/historical/install/bin/amem.js", escaped = false) {
  const count = ["claude", "codex", "kimi", "pi", "jcode"].includes(target) ? 2 : 1;
  return { version: 2, target, intent: "a".repeat(64), phase: "applied", changes: Array.from({ length: count }, (_, index) => ({ key: `${target}:${index}`,
    path: `/native/not-opened/${target}/${index}`, before: image(index === 0 ? document(target, beforeEntry) : "{}"),
    after: image(index === 0 ? document(target, entry, escaped) : "{}"), start: image(index === 0 ? document(target, "/another/missing/start/src/cli.ts") : "{}") })) };
}
function save(dir: string, value: ReturnType<typeof receipt>, name = value.target === "agy" ? `agy-${"f".repeat(64)}.json` : `${value.target}.json`) {
  const file = join(dir, name); writeFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 }); return file;
}
function tree(root: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const visit = (file: string) => { const stat = lstatSync(file, { bigint: true }); output[file.slice(root.length)] = [String(stat.dev), String(stat.ino), String(stat.uid), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs),
    stat.isFile() ? readFileSync(file).toString("base64") : stat.isSymbolicLink() ? readlinkSync(file) : null];
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name)); }; visit(root); return output;
}
function category(work: () => unknown): string { try { work(); } catch (error) { expect(error).toBeInstanceOf(SetupWriterRootsError); return (error as SetupWriterRootsError).category; } throw Error("expected inventory refusal"); }

test("only current AFTER launcher roots are authoritative; before/start/native config files are never read", () => {
  const f = fixture(), current = f.install("current install"); save(f.dir, receipt("claude", join(current, "bin", "amem.js")));
  writeFileSync(join(f.dir, "claude.json.stale-20261106T000000Z"), "historical unknown receipt", { mode: 0o600 });
  const before = tree(f.root), read = spyOn(fs, "readFileSync").mockImplementation((() => { throw Error("no native or historical file body reads"); }) as typeof fs.readFileSync);
  try { expect(readSetupWriterRoots(f.home)).toEqual([current]); expect(read).not.toHaveBeenCalled(); }
  finally { read.mockRestore(); }
  expect(tree(f.root)).toEqual(before);
});

test("all managed client formats, legacy jcode and multiple workspace agy receipts are deduplicated", () => {
  const f = fixture(), first = f.install("first"), second = f.install("second"), alias = join(f.root, "stable-current"); symlinkSync(first, alias);
  for (const target of ["claude", "codex", "kimi", "pi", "qwen", "jcode", "opencode", "gemini", "agy"] as const) save(f.dir, receipt(target, join(alias, "bin", "amem.js")));
  const legacy = receipt("jcode", join(second, "src", "cli.ts")); legacy.version = 1; legacy.changes = legacy.changes.slice(0, 1); save(f.dir, legacy);
  save(f.dir, receipt("agy", join(second, "src", "cli.ts")), `agy-${"e".repeat(64)}.json`);
  const before = tree(f.root); expect(readSetupWriterRoots(f.home)).toEqual([first, second].sort()); expect(tree(f.root)).toEqual(before);
});

test("escaped JSON slash values and quoted TOML entry paths use the shared MCP/launcher decoder", () => {
  const f = fixture(), root = f.install('release "quoted" 계정'); save(f.dir, receipt("claude", join(root, "bin", "amem.js"), undefined, true)); save(f.dir, receipt("codex", join(root, "src", "cli.ts")));
  expect(readSetupWriterRoots(f.home)).toEqual([root]);
});

test("missing setup directory/home is read-only empty, not initialization", () => {
  const f = fixture(); rmdirSync(f.dir); const before = tree(f.root); expect(readSetupWriterRoots(f.home)).toEqual([]);
  expect(readSetupWriterRoots(join(f.root, "missing-home"))).toEqual([]); expect(tree(f.root)).toEqual(before);
});

for (const damage of ["version", "unknown-schema", "unknown-target", "unknown-field", "before-base64", "prepared", "relative-entry", "unsupported-entry", "launcher-args", "console"] as const)
  test("incomplete/unsupported receipt inventory refuses without partial roots: " + damage, () => {
    const f = fixture(), current = f.install("runtime"), value = receipt("claude", join(current, "bin", "amem.js"));
    if (damage === "version") value.version = 99;
    else if (damage === "unknown-schema") Object.assign(value, { schema: "agent-mem.setup/future" });
    else if (damage === "unknown-target") Object.assign(value, { target: "future-client" });
    else if (damage === "unknown-field") Object.assign(value.changes[0]!, { unknown: true });
    else if (damage === "before-base64") value.changes[0]!.before.bytes = "not-base64";
    else if (damage === "prepared") value.phase = "prepared";
    else if (damage === "relative-entry") value.changes[0]!.after = image(document("claude", "relative/bin/amem.js"));
    else if (damage === "unsupported-entry") value.changes[0]!.after = image(document("claude", join(current, "custom.js")));
    else if (damage === "launcher-args") value.changes[0]!.after = image(JSON.stringify({ mcpServers: { amem: { command: "/bin/bun", args: ["--smol", join(current, "bin", "amem.js"), "mcp", "extra"] } } }));
    save(f.dir, value, damage === "console" ? "console.json" : "claude.json");
    const before = tree(f.root); expect(() => readSetupWriterRoots(f.home)).toThrow(SetupWriterRootsError); expect(tree(f.root)).toEqual(before);
  });

test("active setup lock and symlinked receipt/namespace refuse without cleanup or traversal", () => {
  const f = fixture(), current = f.install("runtime"), file = save(f.dir, receipt("claude", join(current, "bin", "amem.js")));
  writeFileSync(join(f.dir, "setup.lock"), "retained owner", { mode: 0o600 }); let before = tree(f.root);
  expect(category(() => readSetupWriterRoots(f.home))).toBe("pending"); expect(tree(f.root)).toEqual(before); unlinkSync(join(f.dir, "setup.lock"));
  renameReceipt(); before = tree(f.root); expect(category(() => readSetupWriterRoots(f.home))).toBe("unsafe"); expect(tree(f.root)).toEqual(before);
  function renameReceipt() { const retained = join(f.root, "retained.json"); writeFileSync(retained, readFileSync(file), { mode: 0o600 }); unlinkSync(file); symlinkSync(retained, file); }
  const other = fixture(); rmdirSync(other.dir); symlinkSync(f.dir, other.dir); before = tree(other.root);
  expect(category(() => readSetupWriterRoots(other.home))).toBe("unsafe"); expect(tree(other.root)).toEqual(before);
});

test("receipt modification during descriptor read is refused without restoring or rewriting it", () => {
  const f = fixture(), current = f.install("runtime"), file = save(f.dir, receipt("claude", join(current, "bin", "amem.js"))), originalRead = fs.readSync;
  let changed = false;
  const read = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof originalRead>) => {
    const size = Reflect.apply(originalRead, fs, args); if (!changed && size > 0) { changed = true; writeFileSync(file, readFileSync(file).toString() + " ", { mode: 0o600 }); } return size;
  }) as typeof originalRead);
  try { expect(category(() => readSetupWriterRoots(f.home))).toBe("changed"); expect(changed).toBe(true); }
  finally { read.mockRestore(); }
  expect(readFileSync(file, "utf8").endsWith("\n ")).toBe(true);
});

test("receipt byte ceiling is stat-checked before opening or allocating its body", () => {
  const f = fixture(), current = f.install("runtime"), file = save(f.dir, receipt("claude", join(current, "bin", "amem.js"))); truncateSync(file, 32 * 1024 * 1024 + 1);
  const open = spyOn(fs, "openSync").mockImplementation((() => { throw Error("oversized receipt must not open"); }) as typeof fs.openSync);
  try { expect(category(() => readSetupWriterRoots(f.home))).toBe("bound"); expect(open).not.toHaveBeenCalled(); }
  finally { open.mockRestore(); }
});

test("setup namespace has a fixed entry ceiling without reading ignored history", () => {
  const f = fixture(); for (let index = 0; index < 257; index++) writeFileSync(join(f.dir, `historical-${index}.tmp`), "", { mode: 0o600 });
  expect(category(() => readSetupWriterRoots(f.home))).toBe("bound");
});

test("a receipt naming a removed install root keeps the category, names its target and remedy, and never its path", () => {
  const f = fixture(), removed = join(f.root, "removed release"); save(f.dir, receipt("agy", join(removed, "bin", "amem.js")));
  const before = tree(f.root); let caught: unknown;
  try { readSetupWriterRoots(f.home); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(SetupWriterRootsError);
  const error = caught as SetupWriterRootsError;
  expect(error.category).toBe("unavailable"); expect(error.target).toBe("agy");
  expect(error.message).toContain("agy"); expect(error.message).toContain("amem setup agy --apply"); expect(error.message).toContain("amem setup agy --undo");
  expect(error.message).not.toContain(removed); expect(error.message).not.toContain("/bin/amem.js");
  expect(tree(f.root)).toEqual(before);
});

test("a runtime root that exists but is not a directory stays an anonymous refusal", () => {
  const f = fixture(), root = join(f.root, "not a directory"); writeFileSync(root, "", { mode: 0o600 }); save(f.dir, receipt("claude", join(root, "bin", "amem.js")));
  let caught: unknown; try { readSetupWriterRoots(f.home); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(SetupWriterRootsError);
  expect((caught as SetupWriterRootsError).category).toBe("unavailable"); expect((caught as SetupWriterRootsError).target).toBeUndefined();
});

test("a same-stamp newly registered receipt cannot be omitted from completeness", () => {
  const f = fixture(), first = f.install("first"), second = f.install("second"); save(f.dir, receipt("claude", join(first,"bin","amem.js")));
  const original = fs.readSync, nativeStat = fs.lstatSync, directoryStat = lstatSync(f.dir,{bigint:true}); let changed = false;
  const metadata = spyOn(fs,"lstatSync").mockImplementation(((...args:Parameters<typeof fs.lstatSync>) => args[0]===f.dir ? directoryStat : Reflect.apply(nativeStat,fs,args)) as typeof fs.lstatSync);
  const write = spyOn(fs,"readSync").mockImplementation(((...args:Parameters<typeof fs.readSync>) => {
    const result = Reflect.apply(original,fs,args);
    if (!changed) { changed=true; save(f.dir,receipt("qwen",join(second,"bin","amem.js"))); }
    return result;
  }) as typeof fs.readSync);
  try { expect(category(()=>readSetupWriterRoots(f.home))).toBe("changed"); }
  finally { write.mockRestore(); metadata.mockRestore(); }
  expect(changed).toBe(true); expect(readFileSync(join(f.dir,"qwen.json"),"utf8")).toContain("qwen");
});

/**
 * #551 AC2: setup names a root the active placement inventory provably does not hold, with the renewal step to run first,
 * while a state it cannot prove is reported as unverified rather than as a missing entry. Setup still writes only on
 * `--apply`, writes no inventory entry, renews nothing and never refuses on this alone.
 */
test("#551 AC2: setup warns when the root it would register is outside the placement writer inventory", async () => {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  expect((await activateSyncPlacement(f.options("apply"))).active).toBe(true);
  const outside = join(f.root, "outside ' install");
  for (const part of [outside, join(outside, "bin"), join(outside, "src")]) mkdirSync(part, { mode: 0o755 });
  writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.21.0" }), { mode: 0o600 });
  writeFileSync(join(outside, "bin", "amem.js"), "// fixture only\n", { mode: 0o600 }); writeFileSync(join(outside, "src", "cli.ts"), "// fixture only\n", { mode: 0o600 });
  // kimi registers through its own configuration file, so the seam below is never invoked: the fixture entry only lifts the
  // temporary-package refusal that a fixture install root would otherwise hit.
  const seam: NonNullable<SetupContext["native"]> = () => { throw Error("no native client runs for this target"); };
  const options = (root: string): SetupContext & { json: true } => ({ env: f.env, root, native: seam, stdinTTY: false, cwd: f.cwd, json: true });
  const inventory = readFileSync(join(f.base, "sync-placement-writer-roots.json")), formats = readFileSync(join(f.base, "formats.json"));
  const epochs = () => readdirSync(join(f.base, "sync-placement", "epochs"), { recursive: true }).map(String).sort();
  const before = epochs(); expect(before.some(name => name.split("/").pop()!.startsWith("writer-"))).toBe(false);
  // The running install's own root is the inventory's only entry, so it draws no warning.
  expect(JSON.parse(await runSetup("kimi", "preview", options(activationOwnRoot))).placementWriter).toBeUndefined();
  const plan = JSON.parse(await runSetup("kimi", "preview", options(outside))) as { placementWriter?: string; notes: string[] };
  const warning = plan.placementWriter!;
  expect(warning).toContain("outside the active placement writer inventory");
  // AC2: the suggested argument is shell-quoted, so the space in this root never splits it into two arguments.
  expect(warning).toContain(`amem migrate --sync-placement --dry-run --writer-root ${quote(outside)}`);
  expect(warning).not.toContain(`--writer-root ${outside}`);
  expect(warning).toContain("never refuses on this alone");
  expect(plan.notes).toContain(warning);
  const preview = await runSetup("kimi", "preview", { ...options(outside), json: false } as SetupContext);
  expect(preview).toContain("> Attention"); expect(preview).toContain(`--writer-root ${quote(outside)}`);
  const narrow = await runSetup("kimi", "preview", { ...options(outside), json: false, columns: 80 } as SetupContext & { columns: number });
  const commands = narrow.replace(/\\\n\s+/g, " ").split("\n").filter(line => line.trimStart().startsWith("-> amem migrate "));
  expect(commands).toHaveLength(2);
  for (const line of commands) {
    // Fixture roots are controlled; ask the shell to split the displayed, quoted arguments without running amem.
    const command = line.trim().slice("-> amem ".length);
    const split = Bun.spawnSync(["sh", "-c", `set -- ${command}; printf '%s\\n' "$@"`]);
    expect(split.exitCode).toBe(0);
    const args = split.stdout.toString().trimEnd().split("\n");
    expect(parseCommand(args).path).toEqual(["migrate"]);
    // The shared checker accepts placeholders rather than shell-quoted paths; shell splitting above checks the actual arguments.
    expect(isAmemCommand(`amem ${args.map(arg => arg.startsWith("/") ? "<path>" : arg).join(" ")}`)).toBe(true);
    expect(args).toContain(realPath(outside));
    expect(args).toContain(realPath(activationOwnRoot));
  }
  // A preview writes nothing at all.
  expect(readFileSync(join(f.base, "sync-placement-writer-roots.json"))).toEqual(inventory); expect(epochs()).toEqual(before);
  const applied = JSON.parse(await runSetup("kimi", "apply", options(outside))) as { applied: string[]; unchanged: string[]; warnings?: string[] };
  expect(applied.warnings).toEqual([warning]);
  expect([...applied.applied, ...applied.unchanged]).toEqual(["kimi"]);
  expect(await runSetup("kimi", "apply", { ...options(outside), json: false } as SetupContext)).toContain("outside the active placement writer inventory");
  // Applying registered the client and still wrote no inventory entry, no floor and no writer revision.
  expect(readFileSync(join(f.base, "sync-placement-writer-roots.json"))).toEqual(inventory);
  expect(readFileSync(join(f.base, "formats.json"))).toEqual(formats); expect(epochs()).toEqual(before);
  // Setup's own receipt now names the new root while the placement inventory still does not, which is exactly the
  // refusal the warning predicted: renew the inventory first, then register a receipt at the new root.
  expect(readSetupWriterRoots(f.base)).toEqual([outside]);
  // AC2: a root carrying a space, a quote and shell metacharacters is quoted in preview, human output and the apply
  // receipt alike, so a person who pastes the suggested command passes one argument and runs no expansion.
  const hostile = join(f.root, `it's $(touch pwned) & "quoted" install`);
  for (const part of [hostile, join(hostile, "bin"), join(hostile, "src")]) mkdirSync(part, { mode: 0o755 });
  writeFileSync(join(hostile, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.21.0" }), { mode: 0o600 });
  writeFileSync(join(hostile, "bin", "amem.js"), "// fixture only\n", { mode: 0o600 }); writeFileSync(join(hostile, "src", "cli.ts"), "// fixture only\n", { mode: 0o600 });
  const hostilePlan = JSON.parse(await runSetup("kimi", "preview", options(hostile))) as { placementWriter?: string };
  const hostileWarning = hostilePlan.placementWriter!;
  expect(hostileWarning).toContain(`--writer-root ${quote(hostile)}`); expect(hostileWarning).not.toContain(`--writer-root ${hostile}`);
  expect(await runSetup("kimi", "preview", { ...options(hostile), json: false } as SetupContext)).toContain(`--writer-root ${quote(hostile)}`);
  const hostileApplied = JSON.parse(await runSetup("kimi", "apply", options(hostile))) as { warnings?: string[] };
  expect(hostileApplied.warnings).toEqual([hostileWarning]);
  // A real shell reads the rendered command back: one argv entry, the exact root, and no `$(...)` side effect.
  const stub = join(f.root, "shell-proof-bin"); mkdirSync(stub, { mode: 0o700 });
  writeFileSync(join(stub, "amem"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o700 });
  const command = /amem migrate --sync-placement --dry-run --writer-root .*?(?=, then --apply)/.exec(hostileWarning)![0];
  const shell = Bun.spawnSync(["bash", "-c", command], { cwd: f.root, env: { ...f.env, PATH: `${stub}:${f.env.PATH}` } });
  expect(shell.exitCode).toBe(0);
  expect(shell.stdout.toString().split("\n").filter(Boolean)).toEqual(["migrate", "--sync-placement", "--dry-run", "--writer-root", hostile]);
  expect(fs.existsSync(join(f.root, "pwned"))).toBe(false);
  // AC2: a marker that does not parse proves neither state, so setup reports it as unverified instead of treating the home
  // as one that never activated placement sync, and it still never claims this root is missing from an inventory.
  const profile = readFileSync(join(f.base, "profile.json"));
  writeFileSync(join(f.base, "profile.json"), "not a profile\n", { mode: 0o600 });
  const malformed = JSON.parse(await runSetup("kimi", "preview", options(outside))) as { placementWriter?: string };
  const malformedWarning = malformed.placementWriter!;
  expect(malformedWarning).toContain("could not be verified here"); expect(malformedWarning).toContain("neither confirmed nor refused");
  expect(malformedWarning).not.toContain("outside the active placement writer inventory"); expect(malformedWarning).not.toContain(outside);
  const malformedApplied = JSON.parse(await runSetup("kimi", "apply", options(outside))) as { warnings?: string[] };
  expect(malformedApplied.warnings).toEqual([malformedWarning]);
  // AC2: a marker the reader will not open - here a symlink it refuses to follow - is unverified for the same reason, so a
  // home whose state cannot be read is never reported as one that never activated placement sync.
  const copy = join(f.root, "profile-copy.json"); writeFileSync(copy, profile, { mode: 0o600 });
  rmSync(join(f.base, "profile.json")); symlinkSync(copy, join(f.base, "profile.json"));
  const unreadable = JSON.parse(await runSetup("kimi", "preview", options(outside))) as { placementWriter?: string };
  expect(unreadable.placementWriter).toContain("could not be verified here");
  expect(unreadable.placementWriter).not.toContain("outside the active placement writer inventory");
  rmSync(join(f.base, "profile.json")); writeFileSync(join(f.base, "profile.json"), profile, { mode: 0o600 });
  // An inventory that cannot be read far enough is unverified, not a root declared unregistered.
  const epoch = join(f.base, "sync-placement", "epochs", readdirSync(join(f.base, "sync-placement", "epochs"))[0]!);
  writeFileSync(join(epoch, "writer-revision-00001.json"), "not a writer revision\n", { mode: 0o600 });
  const unproven = JSON.parse(await runSetup("kimi", "preview", options(outside))) as { placementWriter?: string };
  expect(unproven.placementWriter).toContain("could not be verified here");
  expect(unproven.placementWriter).toContain("neither confirmed nor refused");
  expect(unproven.placementWriter).not.toContain("outside the active placement writer inventory");
}, 120_000);

test("setup writer commands use the plan's HOME-only relocated memory home", async () => {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  expect((await activateSyncPlacement(f.options("apply"))).active).toBe(true);
  const outside = join(f.root, "outside"), home = f.env.HOME!;
  for (const part of [outside, join(outside, "bin"), join(outside, "src")]) mkdirSync(part, { mode: 0o755 });
  writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.21.0" }), { mode: 0o600 });
  writeFileSync(join(outside, "bin", "amem.js"), "// fixture\n", { mode: 0o600 });
  writeFileSync(join(outside, "src", "cli.ts"), "// fixture\n", { mode: 0o600 });
  const defaultHome = join(home, ".agenthub", "memory"); mkdirSync(defaultHome, { recursive: true });
  writeFileSync(join(defaultHome, "amem.config.json"), JSON.stringify({ home: f.base }), { mode: 0o600 });
  const env = { ...f.env }; delete env.AMEM_HOME; delete env.AGENTHUB_HOME;
  const text = await runSetup("kimi", "preview", { env, root: outside, cwd: f.cwd, native: () => { throw Error("unexpected native call"); } });
  expect(text).toContain("amem migrate --sync-placement --dry-run");
  expect(text).toContain(`--writer-root ${quote(outside)}`);
  expect(text).not.toContain("-> amem doctor");
});

test("#551 AC2: a home that never activated placement sync tells setup nothing about writers", async () => {
  const f = hookFixture(); cleanup.push(f.close);
  const outside = join(f.root, "outside install");
  for (const part of [outside, join(outside, "bin"), join(outside, "src")]) mkdirSync(part, { mode: 0o755 });
  writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.21.0" }), { mode: 0o600 });
  writeFileSync(join(outside, "bin", "amem.js"), "// fixture only\n", { mode: 0o600 }); writeFileSync(join(outside, "src", "cli.ts"), "// fixture only\n", { mode: 0o600 });
  const plan = JSON.parse(await runSetup("kimi", "preview", { env: f.env, root: outside, native: () => { throw Error("no native client runs for this target"); }, stdinTTY: false, cwd: f.cwd, json: true })) as { placementWriter?: string };
  expect(plan.placementWriter).toBeUndefined();
}, 60_000);
