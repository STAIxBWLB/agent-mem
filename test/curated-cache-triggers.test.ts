import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefCacheFile, readBriefCache } from "../src/brief-cache.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { captureShardDir } from "../src/memory/shard.ts";
import { machineId, MemoryStore } from "../src/memory/store.ts";
import { processSignature } from "../src/memory/platform.ts";
import { prepareCuratedBriefCache } from "../src/index.ts";

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

test("ordinary library brief neither creates nor rewrites curated cache", async () => {
  const f = fixture();
  const empty = await sessionStartBrief({ cwd: f.root, base: f.base, project: f.project, repository: false });
  expect(empty.coverage.curated).toBe("complete");
  expect(f.cache()).toBeUndefined();
  const store = new MemoryStore({ memoryDir: f.base, deferPromotions: true });
  try { store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text: "cached baseline", about: [] }); }
  finally { store.close(); }
  prepareCuratedBriefCache(f.base, f.project);
  const before = readBriefCache(f.binding)!;
  const bytes = readFileSync(briefCacheFile(f.binding));
  const result = await sessionStartBrief({ cwd: f.root, base: f.base, project: f.project, repository: false });
  expect(result.coverage.curated).toBe("complete");
  expect(result.context).toContain("cached baseline");
  expect(f.cache()).toEqual(before);
  expect(readFileSync(briefCacheFile(f.binding))).toEqual(bytes);
});

test("native and measure-only briefs do not create or rewrite curated caches", async () => {
  const nativeMissing = fixture();
  await sessionStartBrief({ cwd: nativeMissing.root, base: nativeMissing.base, project: nativeMissing.project, repository: false,
    nativeSession: { signature: processSignature(process.pid)! }, timeRemaining: () => 2000 });
  expect(nativeMissing.cache()).toBeUndefined();

  const native = fixture();
  const nativeStore = new MemoryStore({ memoryDir: native.base, deferPromotions: true });
  try { nativeStore.note({ op: "note", project: native.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text: "native cached baseline", about: [] }); }
  finally { nativeStore.close(); }
  prepareCuratedBriefCache(native.base, native.project);
  const nativeBytes = readFileSync(briefCacheFile(native.binding));
  const signature = processSignature(process.pid)!;
  await sessionStartBrief({ cwd: native.root, base: native.base, project: native.project, repository: false,
    nativeSession: { signature }, timeRemaining: () => 2000 });
  expect(readFileSync(briefCacheFile(native.binding))).toEqual(nativeBytes);

  const measuredMissing = fixture(), emptyStore = new MemoryStore({ memoryDir: measuredMissing.base, deferPromotions: true });
  try {
    await sessionStartBrief({ cwd: measuredMissing.root, base: measuredMissing.base, project: measuredMissing.project, repository: false,
      measureOnly: { curated: emptyStore } });
    expect(measuredMissing.cache()).toBeUndefined();
  } finally { emptyStore.close(); }

  const measured = fixture(), store = new MemoryStore({ memoryDir: measured.base, deferPromotions: true });
  try {
    store.note({ op: "note", project: measured.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text: "measure cached baseline", about: [] });
    store.prepareCuratedBriefs([measured.project]);
    const bytes = readFileSync(briefCacheFile(measured.binding));
    await sessionStartBrief({ cwd: measured.root, base: measured.base, project: measured.project, repository: false,
      measureOnly: { curated: store } });
    expect(readFileSync(briefCacheFile(measured.binding))).toEqual(bytes);
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
