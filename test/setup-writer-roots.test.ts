import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSetupWriterRoots, SetupWriterRootsError, type SetupTarget } from "../src/setup.ts";
import { realPath } from "../src/memory/platform.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const image = (text: string) => ({ mode: 0o600, bytes: Buffer.from(text).toString("base64") });
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
