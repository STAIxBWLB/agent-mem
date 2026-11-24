import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { briefCacheFile, readBriefCache, writeBriefCache } from "../src/brief-cache.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { appendAlias, shardMachineDir } from "../src/memory/shard.ts";
import { machineId, MemoryStore } from "../src/memory/store.ts";
import { workBriefFile, workPolicyRevision } from "../src/brief-work.ts";
import { configuredPolicyOptions } from "../src/memory/config.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { processSignature } from "../src/memory/platform.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { sessionStartBrief } from "../src/session-brief.ts";

interface QuietBrief { brief: string; bytes: number; truncated: boolean; state: string }
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-curated-cli-mcp-")); roots.push(root);
  const base = join(root, "memory"), project = memoryProjectKey(root);
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true }); store.close();
  const binding = { directory: shardMachineDir(base, project, machineId(base).id), project, section: "curated" as const };
  return { root, base, project, binding, file: briefCacheFile(binding), cache: () => readBriefCache(binding) };
}

async function withFakeHome<T>(f: ReturnType<typeof fixture>, work: () => Promise<T>): Promise<T> {
  const priorHome = process.env.HOME, priorBase = process.env.AMEM_HOME;
  process.env.HOME = f.root; process.env.AMEM_HOME = f.base;
  try { return await work(); }
  finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorBase === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = priorBase;
  }
}

function prepareQuietCache(f: ReturnType<typeof fixture>): void {
  const store = new MemoryStore({ memoryDir: f.base, deferPromotions: true });
  try { store.prepareCuratedBriefs([f.project]); } finally { store.close(); }
  const cache = f.cache();
  if (!cache?.curated) throw new Error("fixture failed to build a curated cache");
  writeBriefCache(f.binding, { ...cache, builtThrough: Math.max(cache.builtThrough, Date.now()), curated: { ...cache.curated, builtAt: 1, binding: "fixture-sentinel-binding" } });
}

test("unmarked person CLI brief builds the quiet project's curated cache", async () => {
  const f = fixture();
  expect(existsSync(f.file)).toBe(false);
  const output = await withFakeHome(f, () => runCli(["brief", "--for", "quiet context", "--json"], { cwd: f.root, env: {}, stdinTTY: true }));
  const result = JSON.parse(output) as QuietBrief;
  expect(result).toMatchObject({ brief: "", bytes: 0, state: "known" });
  expect(f.cache()).toMatchObject({ project: f.project, section: "curated", rows: [] });
  expect(f.cache()?.curated?.binding).toBeTruthy();
});

test("#431 AC2: a CLAUDECODE-marked CLI brief prepares the curated cache like a person run", async () => {
  const f = fixture();
  expect(existsSync(f.file)).toBe(false);
  const output = await withFakeHome(f, () => runCli(["brief", "--for", "quiet context", "--json"], { cwd: f.root, env: { CLAUDECODE: "" }, stdinTTY: false }));
  expect(JSON.parse(output) as QuietBrief).toMatchObject({ brief: "", bytes: 0, state: "known" });
  expect(f.cache()).toMatchObject({ project: f.project, section: "curated", rows: [] });
  expect(f.cache()?.curated?.binding).toBeTruthy();
});

test("direct MCP amem_brief neither creates a missing cache nor overwrites an existing one", async () => {
  const f = fixture();
  let session = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
  try {
    expect(existsSync(f.file)).toBe(false);
    const result = await session.tools.amem_brief({ intent: "quiet context" }) as QuietBrief;
    expect(result).toMatchObject({ brief: "", bytes: 0, state: "known" });
    expect(existsSync(f.file)).toBe(false);
  } finally { session.close(); }

  prepareQuietCache(f);
  const before = readFileSync(f.file);
  session = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
  try {
    const result = await session.tools.amem_brief({ intent: "quiet context" }) as QuietBrief;
    expect(result).toMatchObject({ brief: "", bytes: 0, state: "known" });
    expect(readFileSync(f.file)).toEqual(before);
    expect(f.cache()?.curated?.binding).toBe("fixture-sentinel-binding");
  } finally { session.close(); }
});

test("CLI brief backfills native work from existing aliased generation logs under the repository policy", async () => {
  const f = fixture(), alias = "work-history-alias", machine = machineId(f.base).id;
  const seed = new MemoryStore({ memoryDir: f.base, deferPromotions: true });
  try {
    seed.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person",
      source: "person", text: "generation note marker", about: [] });
  } finally { seed.close(); }
  await migrateShards({ memoryDir: f.base, mode: "apply", authorizedPerson: true, tty: true });
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "curated", minReader: "0.24.0", since: "fixture" }]));
  const work = new WorkListStore({ base: f.base, project: alias, exact: true, policy: () => true });
  try {
    await work.write("old queue", { task: "historical work marker", status: "doing" });
    await work.write("private queue", { task: "repository-hidden marker", status: "doing" });
  } finally { work.close(); }
  // Simulate logs from before work snapshot publication existed.
  rmSync(workBriefFile({ base: f.base, project: alias, machine }));
  appendAlias(f.base, { alias, key: f.project, actor: "person", machine });
  mkdirSync(join(f.root, ".git"));
  mkdirSync(join(f.root, ".amem"));
  writeFileSync(join(f.root, ".amem", "config"), JSON.stringify({ piiPatterns: ["repository-hidden"] }));
  const revision = workPolicyRevision(configuredPolicyOptions(f.base, f.root));
  expect(revision).not.toBe(workPolicyRevision(configuredPolicyOptions(f.base)));
  const scoped = workBriefFile({ base: f.base, project: f.project, machine, revision });
  const native = () => sessionStartBrief({ cwd: f.root, base: f.base, project: alias,
    nativeSession: { signature: processSignature(process.pid)! }, timeRemaining: () => 1000 });
  expect((await native()).context).toContain("work cache missing");
  await withFakeHome(f, () => runCli(["brief", "--for", "quiet context", "--json"], { cwd: f.root, env: {} }));
  expect(existsSync(scoped)).toBe(true);
  const result = await native();
  expect(result.context).toContain("historical work marker");
  expect(result.context).toContain("generation note marker");
  expect(result.context).not.toContain("repository-hidden marker");
  expect(result.context).not.toContain("work cache missing");
  expect(result.context).not.toContain("curated cache missing");
});
