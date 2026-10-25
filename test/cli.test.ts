import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON_ONLY, agentMarked, runCli } from "../src/cli.ts";
import { appendAlias, CaptureStore, MemoryStore, memoryProjectKey, projectChain } from "../src/index.ts";

const dirs: string[] = [];
const oldHome = process.env.AGENTHUB_HOME, oldAmem = process.env.AMEM_HOME;
afterEach(() => {
  if (oldHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = oldHome;
  if (oldAmem === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldAmem;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "amem-cli-")); dirs.push(dir); return dir; };
const context = (cwd: string, stdinTTY = false) => ({ cwd, env: {}, stdinTTY });

for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) test(`every command refuses a present ${key} marker before touching memory`, async () => {
  const home = join(temp(), "must-not-open"); process.env.AMEM_HOME = home;
  for (const value of ["", "invalid marker", "1", "codex"]) {
    expect(agentMarked({ [key]: value })).toBe(true);
    // F1: only the two commands that print text work in an agent shell; every other command keeps the honest-session refusal.
    for (const args of [["list"], ["forget", "missing"], ["--help", "--json"], ["list", "--help"], ["review", "--help"], ["sync"]]) await expect(runCli(args, { env: { [key]: value }, stdinTTY: true })).rejects.toThrow(PERSON_ONLY);
    for (const args of [["--help"], ["help"], ["--version"], ["version"]]) expect(await runCli(args, { env: { [key]: value }, stdinTTY: true })).toMatch(/^usage: amem|^amem \d/);
  }
  expect(existsSync(home)).toBe(false);
});

test("mutations need stdin TTY and crossing policy needs explicit acknowledgement before store open", async () => {
  const root = temp(), home = join(root, "must-not-open"); process.env.AMEM_HOME = home;
  for (const args of [["promote", "missing", "--policy-free"], ["dedupe", "--apply"], ["machine", "--label", "fixture"], ["goal", "new", "fixture"], ["sync", "--policy-free"]]) await expect(runCli(args, context(root))).rejects.toThrow("terminal on stdin");
  // F4: the configured policy applies, so these no longer demand `--policy-free`; each reaches its own usage check instead, never a hub-worded one.
  for (const sub of ["promote", "import", "sync"]) {
    const refusal = await runCli([sub], context(root, true)).then(() => "", error => (error as Error).message);
    expect(refusal).not.toContain("--policy-free"); expect(refusal).not.toMatch(/\bahub\b|hub_memory/);
  }
});

test("person reads are unscreened and flags keep their list default; promotion remains secret-screened", async () => {
  const root = temp(); process.env.AMEM_HOME = join(root, "memory");
  const store = new MemoryStore({ screen: () => "keep" }), project = memoryProjectKey(root);
  const secret = store.note({ op: "note", project, scope: "project", tier: "short", kind: "decision", peer: "codex", text: "password: synthetic-fixture", about: [], source: "person" });
  const clean = store.note({ op: "note", project, scope: "project", tier: "short", kind: "contract", peer: "codex", text: "preserve the contract", about: [], source: "person" }); store.close();
  expect(JSON.parse(await runCli(["--json", "--tier", "short"], context(root))).map((row: { id: string }) => row.id).sort()).toEqual([secret, clean].sort());
  expect(JSON.parse(await runCli(["show", secret, "--json"], context(root))).text).toBe("password: synthetic-fixture");
  await expect(runCli(["promote", secret, "--policy-free"], context(root, true))).rejects.toThrow("stays short-term");
  expect(await runCli(["promote", clean, "--policy-free"], context(root, true))).toContain("promoted to long-term");
  expect(await runCli(["goal", "new", "synthetic goal"], context(root, true))).toContain("created: synthetic goal");
  expect(JSON.parse(await runCli(["goal", "list", "--json"], context(root)))).toHaveLength(1);
});

test("bin refuses Node before TS, and an agent-marked CLI prints help and version (F1) but refuses a command", () => {
  const bin = join(import.meta.dir, "../bin/amem.js");
  const node = Bun.spawnSync(["node", bin, "--help"], { stdout: "pipe", stderr: "pipe" });
  expect(node.exitCode).toBe(1); expect(node.stderr.toString()).toContain("Bun >=1.4.2 is required");
  const help = Bun.spawnSync([process.execPath, bin, "--help"], { env: { PATH: process.env.PATH, AGENTHUB_PEER_ID: "codex" }, stdout: "pipe", stderr: "pipe" });
  expect(help.exitCode).toBe(0); expect(help.stdout.toString()).toContain("usage: amem");
  const child = Bun.spawnSync([process.execPath, bin, "list"], { env: { PATH: process.env.PATH, AGENTHUB_PEER_ID: "codex" }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1); expect(child.stderr.toString()).toContain(PERSON_ONLY);
});

test("help and version work without opening a store", async () => {
  const home = join(temp(), "must-not-open"); process.env.AMEM_HOME = home;
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  expect(await runCli(["--version"], { env: {} })).toBe(`amem ${version}`);
  expect(await runCli(["--help"], { env: {} })).toContain("usage: amem");
  expect(await runCli(["import", "claude-mem", "--help"], { env: {} })).toContain("--capture-days"); expect(existsSync(home)).toBe(false);
});

test("a person read never promotes a settled held note without TTY and policy-free acknowledgement", async () => {
  const root = temp(); process.env.AMEM_HOME = join(root, "memory");
  const store = new MemoryStore({ screen: () => "skip" }), project = memoryProjectKey(root), task = `${project}#7@1`;
  const id = store.note({ op: "note", project, scope: "project", tier: "short", kind: "contract", peer: "codex", task, text: "held contract awaiting host policy", about: [], source: "person" });
  expect(store.settle(task, "user")).toBe(0); store.close();
  const rows = JSON.parse(await runCli(["list", "--json"], context(root))) as { id: string; tier: string }[];
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id, tier: "short" });
  const check = new MemoryStore({ screen: () => "skip" });
  try { expect(check.list({ project }).map(row => row.tier)).toEqual(["short"]); expect(check.counts(project).long).toBe(0); }
  finally { check.close(); }
});


test("standalone import counts secret skips and goal links fail explicitly before store access", async () => {
  const root = temp(); process.env.AMEM_HOME = join(root, "memory");
  await expect(runCli(["goal", "link", "missing", "1"], context(root, true))).rejects.toThrow("amem alone has none");
  expect(existsSync(process.env.AMEM_HOME!)).toBe(false);
  const file = join(root, "fixture.db"), db = new Database(file);
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  db.query("INSERT INTO observations VALUES (1, ?, 'fixture', 'password: synthetic-fixture', NULL, 1790000000000, ?)").run(projectChain(root).at(-1)!, JSON.stringify({ peer: "codex", kind: "decision" })); db.close();
  const result = JSON.parse(await runCli(["import", "claude-mem", "--db", file, "--policy-free", "--json"], context(root, true)));
  expect(result.skipped).toEqual({ model: 0, pii: 0, secret: 1 }); expect(result.added).toBe(0);
});

test("claude-mem capture days runs through the person CLI with alias-scoped capture results", async () => {
  const root = temp(), base = join(root, "memory"); process.env.AMEM_HOME = base;
  const project = memoryProjectKey(root), source = projectChain(root).at(-1)!, file = join(root, "fixture.db"), db = new Database(file), at = Date.now();
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  db.run("CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, project TEXT, request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, created_at_epoch INTEGER)");
  db.query("INSERT INTO observations VALUES (1, ?, 'fixture', 'cli capture observation', NULL, ?, ?)").run(source, at, JSON.stringify({ peer: "codex" }));
  db.query("INSERT INTO session_summaries (id, project, learned, created_at_epoch) VALUES (1, ?, 'cli capture summary', ?)").run(source, at); db.close();
  appendAlias(base, { alias: source, key: project, actor: "person", machine: "fixture" });
  const before = readFileSync(file), args = ["import", "claude-mem", "--db", file, "--capture-days", "7", "--json"];
  const result = JSON.parse(await runCli(args, context(root, true)));
  expect(result.capture).toMatchObject({ read: 2, added: 2, spooled: 0, skipped: 0 }); expect(result.work).toMatchObject({ read: 0 });
  const capture = new CaptureStore({ memoryDir: base, project, cwd: root });
  try { expect(capture.rows().map(row => row.excerpt).sort()).toEqual(["Learned: cli capture summary", "fixture\ncli capture observation"]); } finally { capture.close(); }
  expect(readFileSync(file)).toEqual(before);
  await expect(runCli(["import", "claude-mem", "--db", file, "--capture-days", "0"], context(root, true))).rejects.toThrow("--capture-days takes a positive integer");
  await expect(runCli(args, { cwd: root, env: { CODEX_THREAD_ID: "agent" }, stdinTTY: true })).rejects.toThrow(PERSON_ONLY);
});


test("completion generation is read-only and unsupported shells exit 2", async () => {
  const root = temp(), home = join(root, "must-not-open"); process.env.AMEM_HOME = home;
  for (const shell of ["zsh", "bash", "fish"]) {
    const script = await runCli(["completion", shell], context(root));
    expect(script).toContain("_amem_candidates"); expect(script).toContain("--capture-days");
  }
  const env: NodeJS.ProcessEnv = { ...process.env, AMEM_HOME: home };
  for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete env[key];
  for (const shell of ["nushell", ""]) {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../bin/amem.js"), "completion", ...(shell ? [shell] : [])], { env, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(2); expect(child.stdout.toString()).toBe(""); expect(child.stderr.toString()).toContain(shell ? "shell takes" : "usage:");
  }
  await expect(runCli(["completion", "bash"], { env: { CODEX_THREAD_ID: "fixture" } })).rejects.toThrow(PERSON_ONLY);
  expect(existsSync(home)).toBe(false);
});
