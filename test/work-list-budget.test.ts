import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { WorkListStore, type WorkListFields } from "../src/memory/work-lists.ts";

const HISTORY = 10001;
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "amem-work-budget-")), project = "fixture/work-budget";
  const store = new WorkListStore({ base, project, policy: () => true });
  return { base, project, store, close() { store.close(); rmSync(base, { recursive: true, force: true }); } };
}
function seed(f: ReturnType<typeof fixture>, count: number): { file: string; text: string } {
  const machine = "a".repeat(16);
  let text = "";
  for (let i = 0; i < count; i++) {
    const fields: WorkListFields = i < count - 4 ? { progress: i, transient: "clear" }
      : i === count - 4 ? { status: "doing", transient: null, ready: true }
      : i === count - 3 ? { task: "compile", status: "todo", detail: "old" }
      : i === count - 2 ? { task: "compile", status: "done", detail: null } : { status: "done" };
    const body = { schema: "agent-mem.work-list/v1", project: f.project, machine, at: i, nonce: i.toString(16).padStart(32, "0"), list: "release", fields };
    text += canonicalJSON({ ...body, id: hashJSON(body) }) + "\n";
  }
  const file = join(f.store.dir, "log", `${machine}.jsonl`);
  writeFileSync(file, text);
  return { file, text };
}
const reduced = (count: number) => [{ list: "release", fields: { progress: count - 5, ready: true, status: "done" },
  items: [{ task: "compile", fields: { status: "done" } }], closed: true }];

for (const named of [false, true]) test(`work-list ${named ? "named-list" : "whole-project"} read reduces all 10001 valid operations without a history ceiling`, async () => {
  const f = fixture(), log = seed(f, HISTORY);
  try {
    expect(await f.store.read(named ? "release" : undefined, true)).toEqual(reduced(HISTORY));
    expect(readFileSync(log.file, "utf8")).toBe(log.text);
    f.store.rebuild();
    expect(await f.store.read(named ? "release" : undefined, true)).toEqual(reduced(HISTORY));
    expect(readFileSync(log.file, "utf8")).toBe(log.text);
  } finally { f.close(); }
});

for (const count of [4999, 5000, HISTORY]) test(`work-list ${count}-row history preserves complete reduction and rebuild; append remains allowed`, async () => {
  const f = fixture(); seed(f, count);
  try {
    const expected = reduced(count);
    expect(await f.store.read()).toEqual([]);
    expect(await f.store.read(undefined, true)).toEqual(expected);
    expect(await f.store.read("release", true)).toEqual(expected);
    f.store.rebuild();
    expect(await f.store.read(undefined, true)).toEqual(expected);
    expect(await f.store.read("release", true)).toEqual(expected);
    await expect(f.store.write("beyond", { status: "doing" })).resolves.toMatchObject({ already: false });
    expect(await f.store.read()).toEqual([{ list: "beyond", fields: { status: "doing" }, items: [], closed: false }]);
    expect(await f.store.read("release", true)).toEqual(expected);
  } finally { f.close(); }
});
