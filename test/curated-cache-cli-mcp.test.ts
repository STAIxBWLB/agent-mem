import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { briefCacheFile, readBriefCache, writeBriefCache } from "../src/brief-cache.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { shardMachineDir } from "../src/memory/shard.ts";
import { machineId, MemoryStore } from "../src/memory/store.ts";

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

test("CLAUDECODE-marked CLI brief routes through MCP without updating a curated cache", async () => {
  const f = fixture(); prepareQuietCache(f);
  const before = readFileSync(f.file);
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
  try {
    const expected = await mcp.tools.amem_brief({ intent: "quiet context" }) as QuietBrief;
    const output = await withFakeHome(f, () => runCli(["brief", "--for", "quiet context", "--json"], {
      cwd: f.root, env: { CLAUDECODE: "" }, stdinTTY: false,
    }));
    const result = JSON.parse(output) as QuietBrief;
    expect(result).toEqual(expected);
    expect(result).toMatchObject({ brief: "", bytes: 0, state: "known" });
    expect(readFileSync(f.file)).toEqual(before);
    rmSync(f.file);
    await withFakeHome(f, () => runCli(["brief", "--for", "quiet context", "--json"], {
      cwd: f.root, env: { CLAUDECODE: "" }, stdinTTY: false,
    }));
    expect(existsSync(f.file)).toBe(false);
  } finally { mcp.close(); }
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
