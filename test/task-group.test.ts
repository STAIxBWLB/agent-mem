import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, fts5Available, groupByTask, taskGroupKey, type NoteInput } from "../src/index.ts";
import { setFts5AvailableForTest } from "../src/memory/search-fts.ts";

const project = "proj";
const cleanup: (() => void)[] = [];
afterEach(() => { setFts5AvailableForTest(undefined); for (const close of cleanup.splice(0).reverse()) close(); });
function store(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "amem-task-group-"));
  const s = new MemoryStore({ home: dir, screen: () => "keep" });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close());
  return s;
}
const note = (text: string, about: string[] = []): NoteInput => ({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "kimi", source: "hub", text, about });

test("taskGroupKey reads the note's task, then a task node, and drops the creation suffix", () => {
  expect(taskGroupKey({ project, task: "proj#229@1700", about: [] })).toBe("proj#229");
  expect(taskGroupKey({ project, task: null, about: ["path:a.ts", "task:proj#229"] })).toBe("proj#229");
  expect(taskGroupKey({ project, task: null, about: ["issue:o/r#1"] })).toBeUndefined();
  const rows = [{ id: 1, project, task: null, about: ["task:proj#1"] }, { id: 2, project, task: null, about: [] }, { id: 3, project, task: "proj#1@9", about: [] }];
  expect(groupByTask(rows, row => row).map(entry => [entry.item.id, entry.folded])).toEqual([[1, 1], [2, 0]]);
});

for (const fts of [true, false]) test(`search folds same-task hits into the best one and keeps the rest reachable (${fts ? "fts5" : "substring"})`, () => {
  if (fts && !fts5Available()) return;
  if (!fts) setFts5AvailableForTest(false);
  const s = store();
  for (const n of [1, 2, 3]) s.note(note(`ui-inbox blocking fixture race decision ${n}`, ["task:proj#229"]));
  s.note(note("ui-inbox blocking fixture race in another task", ["task:proj#300"]));
  s.note(note("ui-inbox blocking fixture race without a task"));
  const grouped = s.search("ui-inbox blocking fixture race", { project, limit: 3 });
  expect(grouped.hits).toHaveLength(3);
  const keys = grouped.hits.map(hit => taskGroupKey(hit.view!));
  expect(keys.filter(key => key === "proj#229")).toHaveLength(1);
  expect(grouped.hits.find(hit => taskGroupKey(hit.view!) === "proj#229")!.folded).toBe(2);
  expect(keys).toContain("proj#300");
  expect(s.search("ui-inbox blocking fixture race", { project, limit: 10, groupTasks: false }).hits).toHaveLength(5);
});
