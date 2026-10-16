import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_SCHEMA, MemoryStore, entryId, type Entry, type NoteEntry, type OpEntry, type GoalEntry } from "../src/memory/store.ts";

const at = (minute: number) => `2026-10-16T00:${String(minute).padStart(2, "0")}:00.000Z`;
const signed = (entry: Omit<NoteEntry, "id"> | Omit<OpEntry, "id"> | Omit<GoalEntry, "id">): Entry => ({ ...entry, id: entryId(entry) });
const base = { schema: MEMORY_SCHEMA, at: at(0), machine: "fixture-a" } as const;
const note = (over: Partial<NoteEntry> = {}): NoteEntry => signed({ ...base, op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "contract", peer: "codex", text: "preserve the contract", about: ["path:src/public.ts"], source: "hub", ...over }) as NoteEntry;
const op = (operation: OpEntry["op"], target: string, by?: string, minute = 3): Entry => signed({ ...base, at: at(minute), machine: "fixture-b", op: operation, target, actor: "claude", ...(by === undefined ? {} : { by }) });

/** Every SQLite table, including offsets and prefix hashes, rather than only user-visible entries. */
function tables(dir: string): Record<string, unknown[]> {
  const db = new Database(join(dir, "index.db"), { readonly: true });
  db.run("PRAGMA busy_timeout = 3000");
  try {
    const names = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(names.map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
  } finally { db.close(); }
}

const contract = note();
const failed = note({ at: at(1), machine: "fixture-b", kind: "fail", text: "do not retry the failed approach", about: ["path:src/public.ts", "issue:owner/repo#12"] });
const forgotten = note({ at: at(2), text: "forget this finding", kind: "finding" });
const short = note({ tier: "short", text: "held contract", task: "agent-hub#1@1", expires: "2027-01-01T00:00:00.000Z" });
const promoted = note({ at: at(4), machine: "fixture-c", text: short.text, task: short.task, promotedFrom: short.id });
const goal = signed({ ...base, op: "goal", project: "agent-hub", scope: "project", title: "fixture goal", milestones: ["deliver"], dependsOn: [], actor: "user" });
const suggestion = op("suggest", contract.id, `contradicts:${failed.id}`, 5);
const segments: { path: string; rows: Entry[] }[] = [
  { path: "log/fixture-a.jsonl", rows: [contract, goal, forgotten, op("forget", forgotten.id), suggestion] },
  { path: "log/fixture-b.jsonl", rows: [failed, op("supersede", contract.id, failed.id), op("goal_state", goal.id, "active"), op("lease", goal.id, "2027-01-01T00:00:00.000Z")] },
  { path: "log/fixture-c.jsonl", rows: [promoted, op("confirm", suggestion.id), op("goal_link", goal.id, "agent-hub#1@1"), signed({ ...base, at: at(6), machine: "fixture-c", op: "lease", target: goal.id, by: "2027-01-01T00:00:00.000Z", actor: "pi" })] },
  { path: "local/fixture-a.jsonl", rows: [short, op("settle", "agent-hub#1@1", "2027-01-01T00:00:00.000Z"), op("demote", failed.id, "2027-01-01T00:00:00.000Z", 7)] },
];

for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2]]) test(`golden full derived tables equal rebuild under shuffled incremental segments ${order.join("")} (#412)`, () => {
  expect(contract.id).toBe("ba9c0d804f5894bd57fff65640594281");
  const home = mkdtempSync(join(tmpdir(), "amem-golden-"));
  const store = new MemoryStore({ home, now: () => Date.parse("2026-10-16T01:00:00.000Z"), screen: () => "keep" });
  try {
    for (let phase = 0; phase < 2; phase++) for (const index of order) {
      const segment = segments[index]!;
      const middle = Math.ceil(segment.rows.length / 2);
      const rows = phase === 0 ? segment.rows.slice(0, middle) : segment.rows.slice(middle);
      appendFileSync(join(store.dir, segment.path), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      store.refresh();
      const incremental = tables(store.dir);
      store.rebuild();
      expect(tables(store.dir)).toEqual(incremental);
    }
    const beforeReads = tables(store.dir);
    expect(Object.keys(beforeReads)).toEqual(["edges", "entries", "goals", "heads", "ops", "segments"]);
    expect(beforeReads.entries).toHaveLength(5);
    expect(beforeReads.ops).toHaveLength(10);
    expect(beforeReads.goals).toHaveLength(1);
    expect(beforeReads.heads).toHaveLength(4);
    expect(beforeReads.segments).toHaveLength(4);
    const views = store.list({ project: "agent-hub", limit: 100, includeSuperseded: true });
    const goals = store.goals("agent-hub");
    const graph = store.graph("agent-hub", `mem:${failed.id}`, 2);
    store.rebuild();
    expect(store.list({ project: "agent-hub", limit: 100, includeSuperseded: true })).toEqual(views);
    expect(store.goals("agent-hub")).toEqual(goals);
    expect(store.graph("agent-hub", `mem:${failed.id}`, 2)).toEqual(graph);
    expect(tables(store.dir)).toEqual(beforeReads);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});
