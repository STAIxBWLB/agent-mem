import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore as LegacyStore } from "@staix/agent-mem-v1";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { migrateShards, shardMigrationStatus } from "../src/memory/shard-migration.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
const A = "example/host-a", B = "example/host-b";
const note = (project: string, text: string): NoteInput => ({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] });
function seed() {
  const home = mkdtempSync(join(tmpdir(), "amem-host-admission-"));
  const store = new MemoryStore({ home }); store.note(note(A, "source a")); store.note(note(B, "source b"));
  const file = join(store.dir, "log", store.machine.id + ".jsonl"); store.close();
  return { home, memory: join(home, "memory"), file };
}
test("F7 a plain host store refuses an active split before opening the old-layout writer", async () => {
  const { home, memory, file } = seed();
  try {
    await migrateShards({ memoryDir: memory, mode: "apply", authorizedPerson: true, tty: true });
    const before = readFileSync(file);
    expect(() => { const store = new MemoryStore({ home }); store.close(); }).toThrow(/openShardStore/);
    expect(() => { const store = new MemoryStore({ home, profile: "shared-v1" }); store.close(); }).toThrow(/openShardStore/);
    expect(readFileSync(file)).toEqual(before);
    const old = new LegacyStore({ home }); old.note(note(A, "an older writer remains byte-compatible")); old.close();
    expect(shardMigrationStatus(memory).pending.rows).toBe(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
for (const marker of ['{"schema":"agent-mem.shards/v1","phase":"captured"}', 'malformed']) test(`F7 a ${marker === 'malformed' ? 'malformed' : 'captured'} split marker cannot silently reopen the legacy host store`, () => {
  const { home, memory, file } = seed();
  try {
    writeFileSync(join(memory, "shards.json"), marker); const before = readFileSync(file);
    expect(() => { const store = new MemoryStore({ home }); store.close(); }).toThrow(/openShardStore/);
    expect(readFileSync(file)).toEqual(before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test("F10 a project write stays independent while another project's actual mutation writer lock is held", async () => {
  const { home, memory } = seed();
  try {
    await migrateShards({ memoryDir: memory, mode: "apply", authorizedPerson: true, tty: true });
    const a = openShardStore({ home, project: A }), b = openShardStore({ home, project: B });
    try {
      const release = acquireMutation(a.dir); expect(release).toBeDefined();
      try { const id = b.note(note(B, "b writes under a writer lock")); expect(b.get(id, B)?.text).toBe("b writes under a writer lock"); }
      finally { release?.(); }
      expect(a.note(note(A, "a writes after release"))).toBeTypeOf("string");
    } finally { a.close(); b.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
