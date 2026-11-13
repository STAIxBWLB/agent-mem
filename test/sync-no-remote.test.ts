import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const project = "example.test/team/no-remote", generation = "7".repeat(32);
function git(dir: string, ...args: string[]) {
  const result = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
}
function snapshot(home: string) {
  return readdirSync(home, { recursive: true }).map(String).sort().map(name => {
    const file = join(home, name);
    return [name, lstatSync(file).isFile() ? readFileSync(file).toString("base64") : "directory"];
  });
}
for (const profile of ["shared-v1", "generation", "sharded"] as const) {
  for (const repository of [false, true]) test(`${profile}: no origin (${repository ? "existing repository" : "never configured"}) returns no-remote before screening without writes`, async () => {
    const home = realPath(mkdtempSync(join(tmpdir(), "amem-no-remote-")));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    let store = new MemoryStore({ home, profile: "shared-v1", deferPromotions: true });
    store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "policy-declined fixture", about: [] });
    if (profile !== "shared-v1") {
      const memoryDir = store.dir; store.close();
      if (profile === "generation") {
        expect(await migrate({ memoryDir, generation, mode: "apply", authorizedPerson: true, tty: true })).toMatchObject({ active: true });
        store = new MemoryStore({ home, profile: { generation }, deferPromotions: true });
      } else {
        expect(await migrateShards({ memoryDir, generation, mode: "apply", authorizedPerson: true, tty: true })).toMatchObject({ active: true });
        store = openShardStore({ home, project, deferPromotions: true });
      }
    }
    cleanup.push(() => store.close());
    const dir = profile === "sharded" ? join(store.profile.home, "shard-sync") : store.dir;
    const repo = join(dir, profile === "sharded" ? "objects.git" : ".git");
    if (repository) {
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", ...(profile === "sharded" ? ["--bare", repo] : []));
    }
    let screens = 0, visibility = 0;
    const opts = { screen: () => { screens++; return false; }, visibility: async () => { visibility++; return "private" as const; } };
    const before = snapshot(home), result = await syncMemory(store, opts);
    expect(result).toMatchObject({ ok: false, pushed: false, entries: 0, error: profile === "shared-v1" ? expect.stringMatching(/^no sync remote:/) : `no ${profile === "sharded" ? "shard" : "generation"} sync remote configured` });
    expect(screens).toBe(0); expect(visibility).toBe(0);
    expect(snapshot(home)).toEqual(before); expect(existsSync(repo)).toBe(repository);
    // Explicit configuration must still screen before transport initialization or visibility work.
    expect(await syncMemory(store, { ...opts, remote: "https://example.invalid/private.git" })).toMatchObject({ ok: false, error: expect.stringContaining("declines") });
    expect(screens).toBeGreaterThan(0); expect(visibility).toBe(0); expect(snapshot(home)).toEqual(before);
    if (repository) {
      git(dir, ...(profile === "sharded" ? ["--git-dir", repo] : []), "remote", "add", "origin", "https://example.invalid/private.git");
      const configured = snapshot(home); screens = 0;
      expect(await syncMemory(store, opts)).toMatchObject({ ok: false, error: expect.stringContaining("declines") });
      expect(screens).toBeGreaterThan(0); expect(visibility).toBe(0); expect(snapshot(home)).toEqual(configured);
    }
  });
}
