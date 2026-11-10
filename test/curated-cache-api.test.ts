import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCuratedBriefCache } from "../src/index.ts";
import { briefCacheFile, readBriefCache } from "../src/brief-cache.ts";
import { curatedProfileBinding } from "../src/memory/curated-cache-state.ts";
import { captureShardDir } from "../src/memory/shard.ts";
import { machineId, MemoryStore } from "../src/memory/store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function sourceBytes(base: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const segment of ["log", "local"]) for (const name of readdirSync(join(base, segment)).filter(name => name.endsWith(".jsonl")).sort()) {
    found[`${segment}/${name}`] = readFileSync(join(base, segment, name), "utf8");
  }
  return found;
}

test("explicit library export builds a selected private cache without promoting or changing source rows", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-curated-cache-api-")); roots.push(root);
  const base = join(root, "memory"), project = "github.com/example/explicit-cache-api";
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
  try {
    store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "explicit curated cache source", about: [] });
    store.note({ op: "note", project, scope: "project", tier: "short", kind: "decision", peer: "person", source: "person", text: "held short source", task: `${project}#held`, about: [] });
  } finally { store.close(); }
  const before = sourceBytes(base), profileBinding = curatedProfileBinding(base, project);
  const directory = captureShardDir(base, project, machineId(base).id), binding = { directory, project, section: "curated" as const };
  rmSync(briefCacheFile(binding), { force: true });
  expect(readBriefCache(binding)).toBeUndefined();

  prepareCuratedBriefCache(base, project);

  const cache = readBriefCache(binding)!;
  expect(cache.rows.map(row => (row.data as { text: string }).text)).toContain("explicit curated cache source");
  expect(cache.curated?.binding).toBe(profileBinding);
  expect(statSync(briefCacheFile(binding)).mode & 0o777).toBe(0o600);
  expect(sourceBytes(base)).toEqual(before);
});

test("explicit root export prepares a quiet empty project's first cache", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-curated-cache-api-empty-")); roots.push(root);
  const base = join(root, "memory"), project = "quiet-empty";
  prepareCuratedBriefCache(base, project);
  const cache = readBriefCache({ directory: captureShardDir(base, project, machineId(base).id), project, section: "curated" });
  expect(cache?.rows).toEqual([]);
  expect(sourceBytes(base)).toEqual({});
});
