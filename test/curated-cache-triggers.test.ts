import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefCacheFile, readBriefCache } from "../src/brief-cache.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { captureShardDir } from "../src/memory/shard.ts";
import { machineId, MemoryStore } from "../src/memory/store.ts";
import { processSignature } from "../src/memory/platform.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-curated-trigger-")); roots.push(root);
  const base = join(root, "memory"), project = "github.com/example/quiet-cache-trigger";
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true }); store.close();
  const directory = captureShardDir(base, project, machineId(base).id);
  const binding = { directory, project, section: "curated" as const };
  return { root, base, project, directory, binding, cache: () => readBriefCache(binding) };
}

test("ordinary library session brief creates a first cache for a successful empty project", async () => {
  const f = fixture();
  expect(f.cache()).toBeUndefined();
  const result = await sessionStartBrief({ cwd: f.root, base: f.base, project: f.project, repository: false });
  expect(result.coverage.curated).toBe("complete");
  expect(f.cache()?.rows).toEqual([]);
  expect(f.cache()?.curated?.binding).toBeTruthy();
});

test("native and measure-only session briefs never create curated caches", async () => {
  const native = fixture();
  const signature = processSignature(process.pid)!;
  await sessionStartBrief({ cwd: native.root, base: native.base, project: native.project, repository: false,
    nativeSession: { signature }, timeRemaining: () => 2000 });
  expect(native.cache()).toBeUndefined();

  const measured = fixture(), store = new MemoryStore({ memoryDir: measured.base, deferPromotions: true });
  try {
    await sessionStartBrief({ cwd: measured.root, base: measured.base, project: measured.project, repository: false,
      measureOnly: { curated: store } });
    expect(measured.cache()).toBeUndefined();
  } finally { store.close(); }
});

test("a no-op sync does not rebuild a missing cache for an untouched project", async () => {
  const f = fixture(), other = "github.com/example/untouched-cache-peer";
  const remote = mkdtempSync(join(tmpdir(), "amem-curated-trigger-remote-")); roots.push(remote);
  const init = Bun.spawnSync(["git", "-C", remote, "init", "-q", "--bare"], { stdout: "pipe", stderr: "pipe" });
  expect(init.exitCode).toBe(0);
  const store = new MemoryStore({ memoryDir: f.base, deferPromotions: true });
  const cached = (project: string) => readBriefCache({ directory: captureShardDir(f.base, project, machineId(f.base).id), project, section: "curated" });
  try {
    for (const project of [f.project, other]) store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text: `baseline ${project}`, about: [] });
    store.prepareCuratedBriefs([f.project, other]);
    expect(cached(other)).toBeDefined();
    const first = await (await import("../src/memory/sync.ts")).syncMemory(store, { remote, visibility: async () => "private" });
    expect(first.ok).toBe(true);
    rmSync(briefCacheFile({ directory: captureShardDir(f.base, other, machineId(f.base).id), project: other, section: "curated" }), { force: true });

    const next = await (await import("../src/memory/sync.ts")).syncMemory(store, { visibility: async () => "private" });
    expect(next.ok).toBe(true);
    expect(cached(other)).toBeUndefined();
  } finally { store.close(); }
});
