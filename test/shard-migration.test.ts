import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore as LegacyMemoryStore } from "@staix/agent-mem-v1";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { migrateShards, shardMigrationStatus } from "../src/memory/shard-migration.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { shardDir, shardKeyHash } from "../src/memory/shard.ts";

const A = "github.com/example/a", B = "github.com/example/b";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "amem-shard-migration-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function note(project: string, text: string, shared = false): NoteInput {
  return { op: "note", project, scope: shared ? "shared" : "project", tier: "long", kind: "finding", peer: "kimi", source: "hub", text, about: [] };
}
function seed(dir: string): { a: string; b: string } {
  const store = new MemoryStore({ home: dir, screen: () => "keep" });
  const a = store.note(note(A, "alpha curated")), b = store.note(note(B, "beta curated"));
  store.note(note(A, "shared user fact", true));
  store.suggest(a, b, "same_topic");
  store.close();
  return { a, b };
}
const options = (dir: string, mode: "dry-run" | "apply" | "resume") => ({ memoryDir: join(dir, "memory"), mode, authorizedPerson: true, tty: true });
const segmentBytes = (dir: string) => Object.fromEntries(["log", "local"].flatMap((folder) => readdirSync(join(dir, "memory", folder)).filter((name) => name.endsWith(".jsonl")).map((name) => [`${folder}/${name}`, readFileSync(join(dir, "memory", folder, name), "utf8")])));

test("apply shards curated rows with original ids and leaves legacy, capture and work untouched", async () => {
  const dir = home(), { a: aId, b: bId } = seed(dir);
  const capture = new CaptureStore({ home: dir, project: A });
  capture.append({ project: A, agent: "kimi", event: "Stop", excerpt: "capture stays" });
  capture.close();
  const work = join(shardDir(join(dir, "memory"), A), "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "state.json"), "keep me");
  const before = segmentBytes(dir);
  const result = await migrateShards(options(dir, "apply"));
  expect(result.active).toBe(true);
  expect(result.counts.byShard[A]).toBeGreaterThan(0);
  expect(result.counts.byShard[B]).toBeGreaterThan(0);
  expect(result.counts.byShard.user).toBeGreaterThan(0);
  expect(segmentBytes(dir)).toEqual(before);
  expect(readFileSync(join(work, "state.json"), "utf8")).toBe("keep me");
  const captureAgain = new CaptureStore({ home: dir, project: A });
  expect(captureAgain.rows().map((row) => row.excerpt)).toEqual(["capture stays"]);
  captureAgain.close();

  const a = openShardStore({ home: dir, project: A }), b = openShardStore({ home: dir, project: B }), user = openShardStore({ home: dir, user: true });
  cleanup.push(() => a.close(), () => b.close(), () => user.close());
  expect(a.list({ project: A }).map((row) => row.id)).toContain(aId);
  expect(a.list({ project: A }).map((row) => row.id)).not.toContain(bId);
  expect(b.list({ project: B }).map((row) => row.id)).toContain(bId);
  expect(a.search("alpha curated", { project: A }).hits.map((hit) => hit.view?.id)).toContain(aId);
  expect(a.search("beta curated", { project: A }).hits.map((hit) => hit.view?.id)).not.toContain(bId);
  expect(user.list().map((row) => row.text)).toContain("shared user fact");
  expect(a.suggestions().some((suggestion) => suggestion.from === aId && suggestion.to === bId)).toBe(true);
  expect(b.suggestions().some((suggestion) => suggestion.from === aId && suggestion.to === bId)).toBe(true);
});

test("status and resume carry old-format appends idempotently", async () => {
  const dir = home(); seed(dir);
  await migrateShards(options(dir, "apply"));
  const old = new LegacyMemoryStore({ home: dir });
  old.note(note(A, "late alpha from old writer"));
  old.close();
  const pending = shardMigrationStatus(join(dir, "memory"));
  expect(pending.active).toBe(true);
  expect(pending.pending.byShard[A]).toBe(1);
  const resumed = await migrateShards(options(dir, "resume"));
  expect(resumed.counts.byShard[A]).toBe(1);
  const again = await migrateShards(options(dir, "resume"));
  expect(again.alreadyActive).toBe(true);
  expect(again.counts.rows).toBe(0);
  const a = openShardStore({ home: dir, project: A });
  expect(a.list({ project: A }).filter((row) => row.text === "late alpha from old writer")).toHaveLength(1);
  a.close();
});

test("a live reader blocks apply and an interrupted build resumes without duplicates", async () => {
  const dir = home(); seed(dir);
  const reader = new MemoryStore({ home: dir });
  await expect(migrateShards(options(dir, "apply"))).rejects.toThrow("legacy reader is live");
  reader.close();
  let interrupted = true;
  await expect(migrateShards({ ...options(dir, "apply"), checkpoint: () => { if (interrupted) { interrupted = false; throw new Error("injected stop"); } } })).rejects.toThrow("injected stop");
  const resumed = await migrateShards(options(dir, "resume"));
  expect(resumed.active).toBe(true);
  const a = openShardStore({ home: dir, project: A });
  expect(a.list({ project: A }).filter((row) => row.text === "alpha curated")).toHaveLength(1);
  a.close();
});
