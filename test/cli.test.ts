import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentMarked, runCli } from "../src/cli.ts";
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

for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) test(`${key} marks attribution; help, version and completion work, unsupported reads use the MCP refusal`, async () => {
  const home = join(temp(), "isolated-memory"), unavailable = "Memory operation unavailable or refused; no partial result is shown.";
  for (const value of ["", "invalid marker", "1", "codex"]) {
    expect(agentMarked({ [key]: value })).toBe(true);
    const agent = { env: { [key]: value, AMEM_HOME: home }, stdinTTY: false, stdoutTTY: false };
    for (const args of [["--help"], ["help"], ["--help", "--json"]]) expect(await runCli(args, agent)).toContain("usage: amem");
    for (const args of [["--version"], ["version"], ["--version", "--json"]]) expect(await runCli(args, agent)).toMatch(/^amem \d/);
    expect(await runCli(["completion", "bash"], agent)).toContain("_amem_candidates");
    for (const args of [["list", "--history"], ["search", "fixture", "--as-of", "2026-01-01T00:00:00.000Z"], ["show", "a".repeat(32), "--history"]]) {
      await expect(runCli(args, agent), args.join(" ")).rejects.toThrow(unavailable);
    }
  }
  expect(existsSync(home)).toBe(false);
});

test("marked writes work without TTY and carry actor/peer attribution", async () => {
  const root = temp(), home = join(root, "memory"); process.env.AMEM_HOME = home;
  const agent = { cwd: root, env: { AGENTHUB_PEER_ID: "person" }, stdinTTY: false };
  const note = JSON.parse(await runCli(["note", "add", "an agent-authored choice", "--json"], agent));
  expect(await runCli(["goal", "new", "an agent-owned goal"], agent)).toContain("created: an agent-owned goal");
  const check = new MemoryStore({ memoryDir: home, screen: () => "keep" });
  try {
    expect(check.get(note.id, memoryProjectKey(root))).toMatchObject({ peer: "agent", source: "person", text: "an agent-authored choice" });
    const goals = JSON.parse(check.dump())[3] as { title: string; actor: string }[];
    expect(goals.find(row => row.title === "an agent-owned goal")?.actor).toBe("agent");
  } finally { check.close(); }
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

test("bin refuses Node before TS and agent unsupported reads use the fixed amem refusal", () => {
  const bin = join(import.meta.dir, "../bin/amem.js");
  const node = Bun.spawnSync(["node", bin, "--help"], { stdout: "pipe", stderr: "pipe" });
  expect(node.exitCode).toBe(1); expect(node.stderr.toString()).toContain("Bun >=1.4.2 is required");
  const home = temp(), env = { PATH: process.env.PATH, HOME: home, AMEM_HOME: join(home, "memory"), AGENTHUB_PEER_ID: "codex" };
  const help = Bun.spawnSync([process.execPath, bin, "--help"], { env, stdout: "pipe", stderr: "pipe" });
  expect(help.exitCode).toBe(0); expect(help.stdout.toString()).toContain("usage: amem");
  const version = Bun.spawnSync([process.execPath, bin, "--version"], { env, stdout: "pipe", stderr: "pipe" });
  expect(version.exitCode).toBe(0); expect(version.stdout.toString()).toMatch(/^amem \d/);
  const child = Bun.spawnSync([process.execPath, bin, "list", "--history"], { env, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1); expect(child.stderr.toString()).toContain("Memory operation unavailable or refused; no partial result is shown.");
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

test("claude-mem capture days runs through a marked nonTTY CLI with alias-scoped capture provenance", async () => {
  const root = temp(), base = join(root, "memory"); process.env.AMEM_HOME = base;
  const project = memoryProjectKey(root), source = projectChain(root).at(-1)!, file = join(root, "fixture.db"), db = new Database(file), at = Date.now();
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  db.run("CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, project TEXT, request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, created_at_epoch INTEGER)");
  db.query("INSERT INTO observations VALUES (1, ?, 'fixture', 'cli capture observation', NULL, ?, ?)").run(source, at, JSON.stringify({ peer: "codex" }));
  db.query("INSERT INTO session_summaries (id, project, learned, created_at_epoch) VALUES (1, ?, 'cli capture summary', ?)").run(source, at); db.close();
  appendAlias(base, { alias: source, key: project, actor: "person", machine: "fixture" });
  const before = readFileSync(file), args = ["import", "claude-mem", "--db", file, "--capture-days", "7", "--json"];
  const result = JSON.parse(await runCli(args, { cwd: root, env: { CODEX_THREAD_ID: "agent", HOME: root, AMEM_HOME: base }, stdinTTY: false, stdoutTTY: false }));
  expect(result.capture).toMatchObject({ read: 2, added: 2, spooled: 0, skipped: 0 }); expect(result.work).toMatchObject({ read: 0 });
  const capture = new CaptureStore({ memoryDir: base, project, cwd: root });
  try {
    const rows = capture.rows();
    expect(rows.map(row => row.excerpt).sort()).toEqual(["Learned: cli capture summary", "fixture\ncli capture observation"]);
    expect(rows.every(row => row.project === project && row.agent === "claude-mem" && row.at === new Date(at).toISOString())).toBe(true);
  } finally { capture.close(); }
  expect(readFileSync(file)).toEqual(before);
  await expect(runCli(["import", "claude-mem", "--db", file, "--capture-days", "0"], context(root, true))).rejects.toThrow("--capture-days takes a positive integer");
  const repeated = JSON.parse(await runCli(args, context(root, false)));
  expect(repeated.capture).toMatchObject({ read: 0, added: 0, spooled: 0, skipped: 0 }); expect(readFileSync(file)).toEqual(before);
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
  expect(await runCli(["completion", "bash"], { env: { CODEX_THREAD_ID: "fixture" }, stdoutTTY: false })).toContain("_amem_candidates");
  expect(existsSync(home)).toBe(false);
});
