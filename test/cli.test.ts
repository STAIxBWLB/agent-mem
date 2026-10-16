import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON_ONLY, agentMarked, runCli } from "../src/cli.ts";
import { MemoryStore, memoryProjectKey, projectChain } from "../src/index.ts";

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
    for (const args of [["--help"], ["--version"], ["list"], ["forget", "missing"]]) await expect(runCli(args, { env: { [key]: value }, stdinTTY: true })).rejects.toThrow(PERSON_ONLY);
  }
  expect(existsSync(home)).toBe(false);
});

test("mutations need stdin TTY and crossing policy needs explicit acknowledgement before store open", async () => {
  const root = temp(), home = join(root, "must-not-open"); process.env.AMEM_HOME = home;
  for (const args of [["promote", "missing", "--policy-free"], ["dedupe", "--apply"], ["machine", "--label", "fixture"], ["goal", "new", "fixture"], ["sync", "--policy-free"]]) await expect(runCli(args, context(root))).rejects.toThrow("terminal on stdin");
  for (const sub of ["promote", "import", "sync"]) await expect(runCli([sub], context(root, true))).rejects.toThrow(`use ahub memory ${sub}`);
  expect(existsSync(home)).toBe(false);
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

test("bin refuses Node before TS and actual agent-marked CLI refuses help", () => {
  const bin = join(import.meta.dir, "../bin/amem.js");
  const node = Bun.spawnSync(["node", bin, "--help"], { stdout: "pipe", stderr: "pipe" });
  expect(node.exitCode).toBe(1); expect(node.stderr.toString()).toContain("Bun >=1.4.2 is required");
  const child = Bun.spawnSync([process.execPath, bin, "--help"], { env: { PATH: process.env.PATH, AGENTHUB_PEER_ID: "codex" }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1); expect(child.stderr.toString()).toContain(PERSON_ONLY);
});

test("help and version work without opening a store", async () => {
  const home = join(temp(), "must-not-open"); process.env.AMEM_HOME = home;
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  expect(await runCli(["--version"], { env: {} })).toBe(`amem ${version}`);
  expect(await runCli(["--help"], { env: {} })).toContain("usage: amem"); expect(existsSync(home)).toBe(false);
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
  await expect(runCli(["goal", "link", "missing", "1"], context(root, true))).rejects.toThrow("use ahub goal link");
  expect(existsSync(process.env.AMEM_HOME!)).toBe(false);
  const file = join(root, "fixture.db"), db = new Database(file);
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  db.query("INSERT INTO observations VALUES (1, ?, 'fixture', 'password: synthetic-fixture', NULL, 1790000000000, ?)").run(projectChain(root).at(-1)!, JSON.stringify({ peer: "codex", kind: "decision" })); db.close();
  const result = JSON.parse(await runCli(["import", "claude-mem", "--db", file, "--policy-free", "--json"], context(root, true)));
  expect(result.skipped).toEqual({ model: 0, pii: 0, secret: 1 }); expect(result.added).toBe(0);
});


test("completion generation is read-only and unsupported shells exit 2", async () => {
  const root = temp(), home = join(root, "must-not-open"); process.env.AMEM_HOME = home;
  for (const shell of ["zsh", "bash", "fish"]) expect(await runCli(["completion", shell], context(root))).toContain("_amem_candidates");
  const env: NodeJS.ProcessEnv = { ...process.env, AMEM_HOME: home };
  for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete env[key];
  for (const shell of ["nushell", ""]) {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../bin/amem.js"), "completion", ...(shell ? [shell] : [])], { env, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(2); expect(child.stdout.toString()).toBe(""); expect(child.stderr.toString()).toContain(shell ? "shell takes" : "usage:");
  }
  await expect(runCli(["completion", "bash"], { env: { CODEX_THREAD_ID: "fixture" } })).rejects.toThrow(PERSON_ONLY);
  expect(existsSync(home)).toBe(false);
});
