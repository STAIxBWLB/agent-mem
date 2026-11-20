import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applySetup, planSetup, undoSetup, type SetupContext } from "../src/setup.ts";
import { readSetupDrift } from "../src/setup-drift.ts";
import { amemCaptureCommand } from "../src/setup-owned.ts";
import { realPath } from "../src/memory/platform.ts";

// #512: capture hooks left by a removed amem install are replaced on apply and reported by the drift check.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function put(file: string, value: string) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, value, { mode: 0o600 }); chmodSync(file, 0o600); }
const bytes = (file: string) => existsSync(file) ? { bytes: readFileSync(file), mode: lstatSync(file).mode & 0o777 } : null;

type Target = "codex" | "qwen" | "kimi" | "pi";
function fixture(target: Target) {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-stale-capture-"))); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const env: Record<string, string | undefined> = { HOME: home, AMEM_HOME: join(home, "memory"), PATH: "", CODEX_HOME: join(home, ".codex"),
    KIMI_CODE_HOME: join(home, ".kimi-code"), QWEN_HOME: join(home, ".qwen"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), XDG_CONFIG_HOME: join(home, ".config") };
  const pkg = (v: string) => join(home, "tools", "amem", v, "node_modules", "@staix", "agent-mem");
  const root = pkg("0.30.0"), gone = pkg("0.28.1");
  put(join(root, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.30.0" }) + "\n");
  put(join(root, "bin", "amem.js"), "// fixture, never executed\n");
  const native: NonNullable<SetupContext["native"]> = (argv, staged) => {
    const client = argv[0], remove = argv[2] === "remove", marker = argv.indexOf("--");
    const file = client === "codex" ? join(staged.CODEX_HOME!, "config.toml") : client === "qwen" ? join(staged.QWEN_HOME!, "settings.json") : join(staged.PI_CODING_AGENT_DIR!, "mcp.json");
    const doc: Record<string, any> = existsSync(file) ? client === "codex" ? Bun.TOML.parse(readFileSync(file, "utf8")) : JSON.parse(readFileSync(file, "utf8")) : {};
    const key = client === "codex" ? "mcp_servers" : "mcpServers"; doc[key] ??= {};
    const launch = client === "qwen" ? [argv[marker - 1], ...argv.slice(marker + 1)] : argv.slice(marker + 1);
    if (remove) delete doc[key].amem; else doc[key].amem = { command: launch[0], args: launch.slice(1) };
    put(file, client === "codex" ? Bun.TOML.stringify(doc) : JSON.stringify(doc, null, 2) + "\n");
  };
  const options: SetupContext = { env, cwd: home, bun: process.execPath, root, native, stdinTTY: false };
  const files = planSetup(target, "apply", options).actions[0]!.files;
  const surface = target === "qwen" ? files[0]! : files[1]!;
  const launch = (entryRoot: string) => `${quote(process.execPath)} --smol ${quote(join(entryRoot, "bin", "amem.js"))} ingest ${target}${target === "pi" ? "" : " --json"}`;
  return { home, env, options, files, surface, stale: launch(gone), current: launch(root),
    plan: () => planSetup(target, "apply", options), apply: () => applySetup(planSetup(target, "apply", options), options),
    undo: () => undoSetup(planSetup(target, "undo", options), options), drift: () => readSetupDrift({ home: env.AMEM_HOME!, env, cwd: home }) };
}
const foreignA = "echo before-amem", foreignB = "/usr/local/bin/notify --session-end";
function seedJson(f: ReturnType<typeof fixture>, withCurrent: boolean, extra: Record<string, unknown> = {}) {
  const handler = (command: string, timeout = 3) => ({ type: "command", command, timeout });
  put(f.surface, JSON.stringify({ ...extra, keep: "me", hooks: { SessionEnd: [
    { hooks: [handler(foreignA, 7)] }, { hooks: [handler(f.stale)] }, ...(withCurrent ? [{ hooks: [handler(f.current)] }] : []), { matcher: "*", hooks: [handler(foreignB, 9)] },
  ] } }, null, 2) + "\n");
}
function sessionEnd(f: ReturnType<typeof fixture>, target: Target): string[] {
  if (target === "kimi") return (Bun.TOML.parse(readFileSync(f.surface, "utf8")) as any).hooks.filter((h: any) => h.event === "SessionEnd").map((h: any) => h.command);
  return JSON.parse(readFileSync(f.surface, "utf8")).hooks.SessionEnd.flatMap((g: any) => g.hooks.map((h: any) => h.command));
}

test("the matcher recognizes the amem capture form at any install root and nothing else", () => {
  const entry = "/x/y z/node_modules/@staix/agent-mem/bin/amem.js";
  expect(amemCaptureCommand(`'/opt/bun' --smol ${quote(entry)} ingest codex --json`)).toEqual({ target: "codex", bun: "/opt/bun", entry });
  expect(amemCaptureCommand(`/opt/bun --smol /a/@staix/agent-mem/bin/amem.js ingest pi`)?.target).toBe("pi");
  for (const other of [foreignA, foreignB, "/opt/bun --smol /a/other/bin/amem.js ingest codex", "/opt/bun /a/@staix/agent-mem/bin/amem.js ingest codex",
    "/opt/bun --smol /a/@staix/agent-mem/bin/amem.js hook SessionEnd", "/opt/bun --smol /a/@staix/agent-mem/bin/amem.js ingest codex --json; rm -rf x"])
    expect(amemCaptureCommand(other)).toBeUndefined();
});

test("AC1/AC2/AC3 codex: preview lists the stale entry, apply leaves one, foreign entries keep order, doctor reports then clears, undo restores bytes", () => {
  const f = fixture("codex");
  put(f.files[0]!, 'keep = "me"\n');
  seedJson(f, true);
  const before = [bytes(f.files[0]!), bytes(f.surface)];
  // A receipt-less home: doctor has nothing to judge until setup has applied once; apply, then reintroduce the dangling entry.
  const removes = f.plan().actions[0]!.removes!;
  expect(removes).toEqual([{ file: f.surface, event: "SessionEnd", command: f.stale }]);
  expect(f.apply().applied).toEqual(["codex"]);
  expect(sessionEnd(f, "codex")).toEqual([foreignA, f.current, foreignB]);
  expect(f.drift().entries.filter(e => e.reason.includes("no longer exists"))).toEqual([]);
  f.undo();
  expect([bytes(f.files[0]!), bytes(f.surface)]).toEqual(before);
});

test("AC3 codex: doctor names target, file and event of a dangling entry, never its command, and is clean after apply", () => {
  const f = fixture("codex");
  put(f.files[0]!, 'keep = "me"\n');
  seedJson(f, false);
  f.apply();
  // Simulate a later manual repair that re-added an entry for the removed install.
  const doc = JSON.parse(readFileSync(f.surface, "utf8")); doc.hooks.SessionEnd.push({ hooks: [{ type: "command", command: f.stale, timeout: 3 }] });
  put(f.surface, JSON.stringify(doc, null, 2) + "\n");
  const report = f.drift(), dangling = report.entries.filter(e => e.reason.includes("no longer exists"));
  expect(dangling).toEqual([{ target: "codex", file: f.surface, entry: "hooks.SessionEnd", reason: expect.any(String), kind: "drift" }]);
  expect(report.status).toBe("attention");
  expect(JSON.stringify(report)).not.toContain("0.28.1");
  expect(f.plan().actions[0]!.removes).toHaveLength(1);
  f.apply();
  expect(sessionEnd(f, "codex")).toEqual([foreignA, foreignB, f.current]);
  expect(f.drift().entries.filter(e => e.reason.includes("no longer exists"))).toEqual([]);
});

test("AC4 qwen: the stale SessionEnd entry in settings.json is replaced, foreign entries keep order, undo restores bytes", () => {
  const f = fixture("qwen");
  seedJson(f, false, { mcpServers: { other: { command: "x", args: [] } } });
  const before = bytes(f.surface);
  expect(f.plan().actions[0]!.removes).toEqual([{ file: f.surface, event: "SessionEnd", command: f.stale }]);
  f.apply();
  expect(sessionEnd(f, "qwen")).toEqual([foreignA, foreignB, f.current]);
  f.undo();
  expect(bytes(f.surface)).toEqual(before);
});

test("AC4 kimi: the stale SessionEnd entry in config.toml is replaced, foreign entries keep order, undo restores bytes", () => {
  const f = fixture("kimi");
  const row = (command: string, timeout: number) => `{ event = "SessionEnd", command = ${JSON.stringify(command)}, timeout = ${timeout} }`;
  put(f.surface, `# mine\nkeep = "me"\nhooks = [\n  ${row(foreignA, 7)},\n  ${row(f.stale, 3)},\n  ${row(foreignB, 9)}\n]\n`);
  const before = [bytes(f.files[0]!), bytes(f.surface)];
  expect(f.plan().actions[0]!.removes).toEqual([{ file: f.surface, event: "SessionEnd", command: f.stale }]);
  f.apply();
  expect(sessionEnd(f, "kimi")).toEqual([foreignA, foreignB, f.current]);
  f.undo();
  expect([bytes(f.files[0]!), bytes(f.surface)]).toEqual(before);
});

test("pi: an amem extension left by a removed install is adopted and replaced, and undo restores its bytes", () => {
  const f = fixture("pi");
  const goneEntry = f.stale.split(" ")[2]!.slice(1, -1);
  put(f.surface, `// amem setup managed session-end ingest; no resident worker or instruction injection.\nimport { spawnSync } from 'node:child_process';\nexport default function (pi) {\n  pi.on('session_shutdown', (_event, ctx) => {\n    try { spawnSync(${JSON.stringify(process.execPath)}, ['--smol', ${JSON.stringify(goneEntry)}, 'ingest', 'pi'], { cwd: ctx.cwd, stdio: 'ignore', timeout: 2500 }); } catch {}\n  });\n}\n`);
  const before = bytes(f.surface);
  expect(f.plan().actions[0]!.removes).toEqual([{ file: f.surface, event: "session_shutdown", command: f.stale }]);
  f.apply();
  expect(readFileSync(f.surface, "utf8")).not.toContain("0.28.1");
  f.undo();
  expect(bytes(f.surface)).toEqual(before);
});

test("AC1 codex: identical duplicates of the current entry collapse to exactly one, foreign entries keep order", () => {
  const f = fixture("codex");
  put(f.files[0]!, 'keep = "me"\n');
  const h = (command: string, timeout = 3) => ({ hooks: [{ type: "command", command, timeout }] });
  put(f.surface, JSON.stringify({ hooks: { SessionEnd: [h(foreignA, 7), h(f.current), h(f.current), h(foreignB, 9)] } }, null, 2) + "\n");
  const before = bytes(f.surface);
  expect(f.plan().actions[0]!.removes).toEqual([{ file: f.surface, event: "SessionEnd", command: f.current }]);
  f.apply();
  expect(sessionEnd(f, "codex").filter(c => c === f.current)).toHaveLength(1);
  expect(sessionEnd(f, "codex").filter(c => c !== f.current)).toEqual([foreignA, foreignB]);
  f.undo();
  expect(bytes(f.surface)).toEqual(before);
});

test("pi: a customized extension that only resembles amem's is never replaced", () => {
  const f = fixture("pi");
  const goneEntry = f.stale.split(" ")[2]!.slice(1, -1);
  put(f.surface, `// amem setup managed session-end ingest; no resident worker or instruction injection.\nimport { spawnSync } from 'node:child_process';\nexport default function (pi) {\n  pi.on('session_shutdown', (_event, ctx) => {\n    console.log('my own addition');\n    try { spawnSync(${JSON.stringify(process.execPath)}, ['--smol', ${JSON.stringify(goneEntry)}, 'ingest', 'pi'], { cwd: ctx.cwd, stdio: 'ignore', timeout: 2500 }); } catch {}\n  });\n}\n`);
  const before = bytes(f.surface);
  expect(f.plan().actions[0]!.removes).toBeUndefined();
  expect(() => f.apply()).toThrow("Pi amem-session extension already exists and is not this setup's file; inspect it, move your changes to another extension file or remove it, then rerun setup");
  expect(bytes(f.surface)).toEqual(before);
});

test("AC1 codex: a retired orphan is not resurrected by a later install-root change, and undo still restores the original bytes", () => {
  const f = fixture("codex");
  put(f.files[0]!, 'keep = "me"\n');
  seedJson(f, false);
  const before = [bytes(f.files[0]!), bytes(f.surface)];
  f.apply();
  expect(sessionEnd(f, "codex")).toEqual([foreignA, foreignB, f.current]);
  const next = join(f.home, "tools", "amem", "0.31.0", "node_modules", "@staix", "agent-mem");
  put(join(next, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.31.0" }) + "\n");
  put(join(next, "bin", "amem.js"), "// fixture, never executed\n");
  const options = { ...f.options, root: next };
  applySetup(planSetup("codex", "apply", options), options);
  const nextCommand = `${quote(process.execPath)} --smol ${quote(join(next, "bin", "amem.js"))} ingest codex --json`;
  expect(sessionEnd(f, "codex")).toEqual([foreignA, foreignB, nextCommand]);
  undoSetup(planSetup("codex", "undo", options), options);
  expect([bytes(f.files[0]!), bytes(f.surface)]).toEqual(before);
});

test("a matching command under another event is neither listed for removal nor touched", () => {
  const f = fixture("codex");
  put(f.files[0]!, 'keep = "me"\n');
  const h = (command: string, timeout = 3) => ({ hooks: [{ type: "command", command, timeout }] });
  put(f.surface, JSON.stringify({ hooks: { Stop: [h(f.stale)], SessionEnd: [h(foreignA, 7)] } }, null, 2) + "\n");
  expect(f.plan().actions[0]!.removes).toBeUndefined();
  f.apply();
  expect(JSON.parse(readFileSync(f.surface, "utf8")).hooks.Stop[0].hooks[0].command).toBe(f.stale);
});
