import { afterEach, expect, test, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { capacityReport } from "../src/memory/capacity.ts";
import { CaptureStore, captureShardStats, writeCaptureConfigFile } from "../src/memory/capture.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { migrate } from "../src/memory/migrate.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { planPrune } from "../src/memory/prune.ts";
import { shardMachineDir } from "../src/memory/shard.ts";
import { MemoryStore, machineId } from "../src/memory/store.ts";

const MARKER = "MARKER";
const UNAVAILABLE = "Memory operation unavailable or refused; no partial result is shown.";
const roots: string[] = [];
const oldAmemHome = process.env.AMEM_HOME;
afterEach(() => {
  if (oldAmemHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldAmemHome;
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

interface World { root: string; cwd: string; home: string; project: string }
function world(prefix = "amem-cli-admin-"): World {
  const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root);
  const cwd = join(root, "repo"), home = join(root, "memory");
  mkdirSync(cwd, { recursive: true });
  process.env.AMEM_HOME = home;
  return { root, cwd, home, project: memoryProjectKey(cwd) };
}
function agentContext(w: World, env: Record<string, string | undefined> = {}) {
  return { cwd: w.cwd, env: { AMEM_HOME: w.home, CLAUDECODE: "fixture", ...env }, stdinTTY: false, stdoutTTY: false };
}
function policy(home: string, patterns: readonly string[] = [MARKER]): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "amem.config.json"), JSON.stringify({ piiPatterns: patterns }));
}
function openStore(home: string): MemoryStore { return new MemoryStore({ memoryDir: home, deferPromotions: true }); }
function note(store: MemoryStore, project: string, text: string, tier: "short" | "long" = "long", expires?: string): string {
  return store.note({ op: "note", project, scope: "project", tier, kind: "finding", peer: "person", source: "person", text, about: [], ...(expires ? { expires } : {}) });
}
async function errorMessage(args: string[], context: Parameters<typeof runCli>[1]): Promise<string> {
  try { await runCli(args, context); } catch (error) { return (error as Error).message; }
  throw new Error(`expected refusal: ${args.join(" ")}`);
}
async function expectUnavailable(args: string[], context: Parameters<typeof runCli>[1]): Promise<void> {
  expect(await errorMessage(args, context)).toBe(UNAVAILABLE);
}

test("marked private memory targets refuse before note, promote, demote, forget or supersede effects", async () => {
  const w = world(), store = openStore(w.home);
  const privateForget = note(store, w.project, `private ${MARKER} forget target`);
  const privateDemote = note(store, w.project, `private ${MARKER} demote target`);
  const privateOld = note(store, w.project, `private ${MARKER} supersede target`);
  const publicNew = note(store, w.project, "public replacement target");
  const privatePromote = note(store, w.project, `private ${MARKER} short target`, "short");
  const publicDemote = note(store, w.project, "public long demote control");
  const publicPromote = note(store, w.project, "public short promote control", "short");
  const publicForget = note(store, w.project, "public forget control");
  const publicOld = note(store, w.project, "public supersede source");
  const publicReplacement = note(store, w.project, "public supersede target");
  const baseline = store.dump(); store.close();
  policy(w.home);

  const agent = agentContext(w);
  for (const args of [
    ["forget", privateForget],
    ["demote", privateDemote],
    ["supersede", privateOld, publicNew],
    ["promote", privatePromote, "--policy-free"],
  ]) await expectUnavailable(args, agent);
  const addError = await errorMessage(["note", "add", `private ${MARKER} new note`, "--json"], agent);
  expect(addError).not.toContain(MARKER);

  const afterRefusals = openStore(w.home);
  try {
    expect(afterRefusals.dump()).toBe(baseline);
    expect(afterRefusals.get(privateForget, w.project)?.text).toContain(MARKER);
    expect(afterRefusals.get(privateDemote, w.project)?.tier).toBe("long");
    expect(afterRefusals.get(privateOld, w.project)?.supersededBy).toBeNull();
    expect(afterRefusals.get(publicNew, w.project)?.supersedes).toEqual([]);
    expect(afterRefusals.get(privatePromote, w.project)?.tier).toBe("short");
  } finally { afterRefusals.close(); }

  const added = JSON.parse(await runCli(["note", "add", "public note control", "--json"], agent)) as { id: string };
  await runCli(["demote", publicDemote], agent);
  await runCli(["promote", publicPromote, "--policy-free"], agent);
  await runCli(["forget", publicForget], agent);
  await runCli(["supersede", publicOld, publicReplacement], agent);
  const control = openStore(w.home);
  try {
    expect(control.get(added.id, w.project)).toMatchObject({ text: "public note control", peer: "claude" });
    expect(control.get(publicDemote, w.project)?.tier).toBe("short");
    expect(control.get(publicPromote, w.project)?.tier).toBe("long");
    expect(control.get(publicForget, w.project)).toBeUndefined();
    expect(control.get(publicOld, w.project)?.supersededBy).toBe(publicReplacement);
  } finally { control.close(); }
});

test("marked rejection leaves a private candidate pending while a public candidate can be rejected", async () => {
  const w = world(), store = openStore(w.home), baseline = store.dump(); store.close();
  const candidates = new CandidateStore({ memoryDir: w.home });
  const privateId = candidates.put({ project: w.project, kind: "memory", text: `candidate ${MARKER} private`, noteKind: "finding" }, "public");
  const publicId = candidates.put({ project: w.project, kind: "memory", text: "safe candidate control", noteKind: "finding" }, "public");
  candidates.close();
  policy(w.home);
  const agent = agentContext(w);

  await expectUnavailable(["review", "reject", privateId, "--json"], agent);
  const afterRefusal = new CandidateStore({ memoryDir: w.home });
  try { expect(afterRefusal.get(privateId, w.project)?.status).toBe("pending"); } finally { afterRefusal.close(); }
  const afterCuratedRefusal = openStore(w.home);
  try { expect(afterCuratedRefusal.dump()).toBe(baseline); } finally { afterCuratedRefusal.close(); }

  await runCli(["review", "reject", publicId, "--json"], agent);
  const afterControl = new CandidateStore({ memoryDir: w.home });
  try {
    expect(afterControl.get(privateId, w.project)?.status).toBe("pending");
    expect(afterControl.get(publicId, w.project)?.status).toBe("rejected");
  } finally { afterControl.close(); }
});

test("a marked goal-state write refuses a private goal before its operation and allows a public control", async () => {
  const w = world(), store = openStore(w.home);
  const privateGoal = store.goal({ project: w.project, scope: "project", title: `private ${MARKER} goal`, milestones: [], dependsOn: [], actor: "person" });
  const publicGoal = store.goal({ project: w.project, scope: "project", title: "public goal control", milestones: [], dependsOn: [], actor: "person" });
  const baseline = store.dump(); store.close(); policy(w.home);
  const agent = agentContext(w);

  await expectUnavailable(["goal", "state", privateGoal, "done"], agent);
  const afterRefusal = openStore(w.home);
  try {
    expect(afterRefusal.dump()).toBe(baseline);
    expect(afterRefusal.goalOf(privateGoal, w.project)?.state).toBe("open");
  } finally { afterRefusal.close(); }

  await runCli(["goal", "state", publicGoal, "active"], agent);
  const afterControl = openStore(w.home);
  try { expect(afterControl.goalOf(publicGoal, w.project)?.state).toBe("active"); }
  finally { afterControl.close(); }
});

test("marked decay screens an explicitly selected private target before demote and allows a public target", async () => {
  const now = Date.parse("2026-10-01T00:00:00.000Z"), clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const w = world(), store = openStore(w.home);
    const privateId = note(store, w.project, `old ${MARKER} note`);
    const publicId = note(store, w.project, "old public note control");
    const baseline = store.dump(); store.close();
    clock.mockReturnValue(now + 5 * 24 * 3600_000);
    policy(w.home);
    const agent = agentContext(w);

    const privateError = await errorMessage(["decay", privateId, "--days", "1", "--apply", "--confirm", "--json"], agent);
    expect(privateError).toBe(UNAVAILABLE);
    expect(privateError).not.toContain(MARKER);
    const afterRefusal = openStore(w.home);
    try {
      expect(afterRefusal.dump()).toBe(baseline);
      expect(afterRefusal.get(privateId, w.project)?.tier).toBe("long");
    } finally { afterRefusal.close(); }

    await runCli(["decay", publicId, "--days", "1", "--apply", "--confirm", "--json"], agent);
    const afterControl = openStore(w.home);
    try { expect(afterControl.get(publicId, w.project)?.tier).toBe("short"); }
    finally { afterControl.close(); }
  } finally { clock.mockRestore(); }
});

test("marked prune screens preview and sealed apply targets before appending, while a public target still applies", async () => {
  const w = world(), createdAt = Date.now() - 5 * 24 * 3600_000, expires = new Date(createdAt + 24 * 3600_000).toISOString();
  const legacy = new MemoryStore({ memoryDir: w.home, deferPromotions: true, now: () => createdAt });
  const privateId = note(legacy, w.project, `expired ${MARKER} note`, "short", expires);
  const publicId = note(legacy, w.project, "expired public note control", "short", expires);
  legacy.close();
  await migrate({ memoryDir: w.home, mode: "apply", generation: "a".repeat(32), authorizedPerson: true, tty: true });
  const source = new MemoryStore({ memoryDir: w.home, deferPromotions: true });
  const cutoff = new Date().toISOString(), port = source.prunePort(), auth = { project: w.project, actor: "agent" as const, authorize: () => true };
  const privatePlan = planPrune(port, { cutoff, targets: [privateId] }, auth), publicPlan = planPrune(port, { cutoff, targets: [publicId] }, auth);
  const baseline = source.dump(), beforePrunes = port.snapshot().durablePruneIds ?? [];
  source.close();
  const privatePlanFile = join(w.root, "private-plan.json"), publicPlanFile = join(w.root, "public-plan.json");
  writeFileSync(privatePlanFile, JSON.stringify(privatePlan), { mode: 0o600 });
  writeFileSync(publicPlanFile, JSON.stringify(publicPlan), { mode: 0o600 });
  policy(w.home);
  const agent = agentContext(w);

  await expectUnavailable(["prune", "--cutoff", cutoff, "--dry-run", "--json"], agent);
  await expectUnavailable(["prune", "--apply", "--plan", privatePlanFile, "--json"], agent);
  const afterRefusal = new MemoryStore({ memoryDir: w.home, deferPromotions: true }), afterPort = afterRefusal.prunePort();
  try {
    expect(afterRefusal.dump()).toBe(baseline);
    expect(afterPort.snapshot().durablePruneIds).toEqual(beforePrunes);
    expect(afterPort.snapshot().pruned).not.toContain(privateId);
  } finally { afterRefusal.close(); }

  const applied = JSON.parse(await runCli(["prune", "--apply", "--plan", publicPlanFile, "--json"], agent)) as { completed: string[] };
  expect(applied.completed).toEqual(publicPlan.rows.map(row => row.payload.id));
  const afterControl = new MemoryStore({ memoryDir: w.home, deferPromotions: true });
  try {
    const snapshot = afterControl.prunePort().snapshot();
    expect(snapshot.pruned).toContain(publicId);
    expect(snapshot.pruned).not.toContain(privateId);
  } finally { afterControl.close(); }
});

test("marked migration screens its administrative receipt before apply", async () => {
  const w = world("amem-admin-MARKER-migrate-"), store = openStore(w.home);
  const id = note(store, w.project, "safe migration fixture row"), baseline = store.dump(); store.close();
  policy(w.home);
  const agent = agentContext(w), generation = "b".repeat(32);

  await expectUnavailable(["migrate", "--generation", generation, "--apply", "--json"], agent);
  const unchanged = openStore(w.home);
  try { expect(unchanged.dump()).toBe(baseline); expect(unchanged.get(id, w.project)?.text).toBe("safe migration fixture row"); }
  finally { unchanged.close(); }
  expect(existsSync(join(w.home, "migration.json"))).toBe(false);
  expect(existsSync(join(w.home, "profile.json"))).toBe(false);
  expect(existsSync(join(w.home, "generations"))).toBe(false);

  policy(w.home, []);
  const migrated = JSON.parse(await runCli(["migrate", "--generation", generation, "--apply", "--json"], agent)) as { profile: { generation?: string } };
  expect(migrated.profile.generation).toBe(generation);
});

function repositoryWithPrivateKey(): World & { project: string; dir: string } {
  const w = world("amem-cli-admin-key-"), origin = "https://github.com/private/MARKER.git";
  execFileSync("git", ["init", "-q", w.cwd]);
  execFileSync("git", ["-C", w.cwd, "remote", "add", "origin", origin]);
  const project = memoryProjectKey(w.cwd);
  if (!project.toLowerCase().includes("marker")) throw new Error(`fixture project key lost private marker: ${project}`);
  const capture = new CaptureStore({ home: w.root, project, cwd: w.cwd });
  capture.append({ project, agent: "fixture", event: "PostToolUse", excerpt: "safe capture control", at: new Date(Date.now() - 10 * 24 * 3600_000).toISOString() });
  capture.close();
  const dir = shardMachineDir(w.home, project, machineId(w.home).id);
  writeCaptureConfigFile(join(w.home, "capture-config.json"), { retentionDays: 1 });
  return { ...w, project, dir };
}

test("marked GC and capacity split screen private shard keys before eviction or confirmation", async () => {
  const w = repositoryWithPrivateKey(); policy(w.home);
  const agent = agentContext(w), before = captureShardStats(w.dir), config = join(w.dir, "config.json"), splitReceipt = join(w.home, "capacity-split.preview.json");
  await expectUnavailable(["gc", "--confirm", "--json"], agent);
  await expectUnavailable(["capacity", "apply", "--split", "--confirm", "--json"], agent);
  expect(captureShardStats(w.dir)).toEqual(before);
  expect(existsSync(config)).toBe(false);
  expect(existsSync(splitReceipt)).toBe(false);

  policy(w.home, []);
  await runCli(["gc", "--confirm", "--json"], agent);
  expect(captureShardStats(w.dir).rows).toBe(0);
  const preview = JSON.parse(await runCli(["capacity", "apply", "--split", "--json"], agent)) as { split: unknown[] };
  expect(preview.split.length).toBe(1);
  await runCli(["capacity", "apply", "--split", "--confirm", "--json"], agent);
  expect(existsSync(config)).toBe(true);
  expect(existsSync(splitReceipt)).toBe(false);
});

test("split screens exact directories before preview persistence and approved targets before writes", async () => {
  const base = world("amem-cli-exact-split-"), w = { ...base, home: join(base.root, "MARKER-memory") };
  process.env.AMEM_HOME = w.home;
  const capture = new CaptureStore({ memoryDir: w.home, project: w.project, cwd: w.cwd });
  try { capture.append({ project: w.project, agent: "fixture", event: "message", excerpt: "public capture control" }); }
  finally { capture.close(); }
  const report = capacityReport({ memoryDir: w.home });
  expect(report.split).toHaveLength(1); expect(JSON.stringify(report)).not.toContain(MARKER);
  const agent = agentContext(w), receipt = join(w.home, "capacity-split.preview.json"), dir = shardMachineDir(w.home, w.project, machineId(w.home).id), config = join(dir, "config.json");
  policy(w.home);
  await expectUnavailable(["capacity", "apply", "--split", "--json"], agent);
  expect(existsSync(receipt)).toBe(false); expect(existsSync(config)).toBe(false);

  policy(w.home, []);
  await runCli(["capacity", "apply", "--split", "--json"], agent);
  const approved = readFileSync(receipt);
  policy(w.home);
  await expectUnavailable(["capacity", "apply", "--split", "--confirm", "--json"], agent);
  expect(readFileSync(receipt).equals(approved)).toBe(true); expect(existsSync(config)).toBe(false);
  policy(w.home, []);
  await runCli(["capacity", "apply", "--split", "--confirm", "--json"], agent);
  expect(existsSync(config)).toBe(true); expect(existsSync(receipt)).toBe(false);
});

function setupWorld(name: string, withPrivatePattern: boolean) {
  const w = world(name), home = join(w.root, name.includes("MARKER") ? "MARKER-home" : "home"), bin = join(w.root, "bin"), log = join(w.root, "native-registration.log");
  mkdirSync(home, { recursive: true }); mkdirSync(bin, { recursive: true });
  const memory = join(home, "memory"); process.env.AMEM_HOME = memory;
  if (withPrivatePattern) policy(memory);
  const bun = join(bin, "bun"), claude = join(bin, "claude");
  symlinkSync(process.execPath, bun);
  const fake = join(w.root, "fake-native.ts"), quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(fake, `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst args = process.argv.slice(2);\nif (args.includes("--version")) { console.log("claude 2.1.312"); process.exit(0); }\nif (args.includes("--help")) { console.log("  mcp Manage servers"); process.exit(0); }\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");\nconst file = join(process.env.HOME!, ".claude.json");\nconst document = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};\ndocument.mcpServers ??= {};\nif (args[1] === "remove") delete document.mcpServers.amem;\nelse { const marker = args.indexOf("--"), launch = args.slice(marker + 1); document.mcpServers.amem = { command: launch[0], args: launch.slice(1) }; }\nmkdirSync(join(process.env.HOME!, "."), { recursive: true });\nwriteFileSync(file, JSON.stringify(document, null, 2) + "\\n");`);
  writeFileSync(claude, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`);
  chmodSync(claude, 0o700);
  const context = { cwd: w.cwd, env: { HOME: home, AMEM_HOME: memory, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, CLAUDECODE: "fixture" }, stdinTTY: false, stdoutTTY: false };
  return { ...w, home, memory, bin, log, context };
}

test("marked setup screens its native config paths before MCP registration; version probes stay in staging", async () => {
  const privateTarget = setupWorld("amem-cli-setup-MARKER-", true);
  const refused = await errorMessage(["setup", "claude", "--apply", "--json"], privateTarget.context);
  expect(refused).toBe(UNAVAILABLE);
  expect(existsSync(privateTarget.log)).toBe(false);
  expect(existsSync(join(privateTarget.home, ".claude.json"))).toBe(false);
  expect(existsSync(join(privateTarget.memory, "setup", "claude.json"))).toBe(false);

  const publicTarget = setupWorld("amem-cli-setup-control-", false);
  await runCli(["setup", "claude", "--apply", "--json"], publicTarget.context);
  expect((JSON.parse(readFileSync(publicTarget.log, "utf8")) as string[]).slice(0, 2)).toEqual(["mcp", "add"]);
  expect(existsSync(join(publicTarget.home, ".claude.json"))).toBe(true);
});
