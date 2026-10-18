import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });
const A = "example/author", B = "example/reader";
const note = (text: string): NoteInput => ({ op: "note", project: A, scope: "shared", tier: "long", kind: "finding", peer: "person", source: "person", text, about: ["path:shared.ts"] });
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amem-overlay-author-"));
  closes.push(() => rmSync(home, { recursive: true, force: true }));
  const legacy = new MemoryStore({ home }); legacy.note({ ...note("private seed"), scope: "project" }); legacy.close();
  await migrateShards({ memoryDir: join(home, "memory"), mode: "apply", authorizedPerson: true, tty: true });
  const open = (project: string) => { const store = openShardStore({ home, project, screen: () => "promote" }); closes.push(() => store.close()); return store; };
  return { author: open(A), reader: open(B), home };
}

test("#15 project handles write shared notes and goals into the user overlay, preserving lifecycle and graph", async () => {
  const { author, reader, home } = await fixture();
  const id = author.note(note("shared author note"));
  expect(reader.get(id, B)?.text).toBe("shared author note");
  expect(reader.related(B, ["path:shared.ts"], 10).map(row => row.id)).toContain(id);
  const goal = author.goal({ project: A, scope: "shared", title: "shared goal", milestones: [], dependsOn: [], actor: "person" });
  author.goalState(goal, "active", "person"); author.goalLink(goal, `${A}#1@1`, "person");
  expect(reader.goalOf(goal, B)?.state).toBe("active");
  expect(reader.goalOf(goal, B)?.links.map(link => link.task)).toEqual([`${A}#1@1`]);
  const user = openShardStore({ home, user: true }); closes.push(() => user.close());
  expect(user.get(id)?.id).toBe(id); expect(user.goalOf(goal)?.state).toBe("active");
  expect(author.forget(id, "person", A)?.id).toBe(id); expect(reader.get(id, B)).toBeUndefined();
});

test("#15 shared task settlement and promotion remain visible through every project overlay", async () => {
  const { author, reader } = await fixture();
  const task = `${A}#9@1`;
  const id = author.note({ ...note("shared decision"), tier: "short", kind: "decision", task });
  expect(author.hasTask(task)).toBe(true);
  expect(author.settle(task, "person")).toBe(1);
  expect(author.settled(task)).toBe(true);
  expect(reader.get(id, B)?.tier).toBe("long");
  expect(reader.get(id.slice(0, 8), B)?.tier).toBe("long");
});

test("#15 opening an unseen project refuses a symlinked curated destination before creating metadata", async () => {
  const { home } = await fixture();
  const { mkdirSync, readFileSync, symlinkSync } = await import("node:fs");
  const { shardDir } = await import("../src/memory/shard.ts");
  const memory = join(home, "memory"), target = join(memory, "log");
  const machine = JSON.parse(readFileSync(join(memory, "machine.json"), "utf8")).id;
  const before = readFileSync(join(target, machine + ".jsonl"));
  const destination = shardDir(memory, "example/symlink"); mkdirSync(join(memory, "projects"), { recursive: true });
  symlinkSync(target, destination, "dir");
  expect(() => { const store = openShardStore({ home, project: "example/symlink" }); store.close(); }).toThrow(/curated shard path/);
  expect(readFileSync(join(target, JSON.parse(readFileSync(join(memory, "machine.json"), "utf8")).id + ".jsonl"))).toEqual(before);
});

// Main 2b5d58e store.ts:783-788 includes shared rows in every project's single-store list.
test("#15 main single-store parity: a project list keeps its own and shared user facts", () => {
  const home = mkdtempSync(join(tmpdir(), "amem-main-parity-"));
  closes.push(() => rmSync(home, { recursive: true, force: true }));
  let now = Date.parse("2026-10-18T00:00:00.000Z");
  const store = new MemoryStore({ home, now: () => now }); closes.push(() => store.close());
  store.note(note("shared user fact")); now += 1000;
  store.note({ ...note("foreign private fact"), scope: "project" }); now += 1000;
  store.note({ ...note("gamma in a new shard"), project: B, scope: "project" });
  expect(store.list({ project: B }).map(row => row.text)).toEqual(["gamma in a new shard", "shared user fact"]);
});
