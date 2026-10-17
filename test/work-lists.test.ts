import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shardDir } from "../src/memory/shard.ts";
import { realPath } from "../src/memory/platform.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";

type Fields = Record<string, string | number | boolean | null>;
type Policy = (row: unknown) => boolean | Promise<boolean>;
interface Store {
  dir: string;
  read(list?: string, includeClosed?: boolean): Promise<{ list: string; fields: Fields; items: { task: string; fields: Fields }[]; closed: boolean }[]>;
  write(list: string, fields: Fields, source?: { source: string; id: string; machine?: string; at?: number }): Promise<{ id: string; already: boolean }>;
  rebuild(): void;
  close(): void;
}
type Constructor = new(options: { base: string; project: string; policy: Policy; now?: () => number }) => Store;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const loader = async (): Promise<Constructor> => {
  const path = "../src/memory/work-lists.ts";
  const module = await import(path).catch(() => undefined);
  expect(typeof module?.WorkListStore).toBe("function");
  return module.WorkListStore as Constructor;
};
async function fixture(policy: Policy = () => true, project = "fixture/work") {
  const WorkListStore = await loader(), base = realPath(mkdtempSync(join(tmpdir(), "amem-work-lists-")));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const clock = { now: 1000 };
  const store = new WorkListStore({ base, project, policy, now: () => clock.now++ });
  cleanup.push(() => store.close());
  return { WorkListStore, base, store, project, clock };
}
function logs(dir: string): [string, string][] {
  const path = join(dir, "log");
  return existsSync(path) ? readdirSync(path).sort().map(name => [name, readFileSync(join(path, name), "utf8")]) : [];
}

test("work lists reduce latest scalar values, clear nulls, track items and close only from list status", async () => {
  const f = await fixture();
  await f.store.write("release", { goal: "ship", count: 1, ready: false });
  await f.store.write("release", { task: "first", status: "todo", detail: "old" });
  await f.store.write("release", { task: "first", status: "doing", detail: null });
  await f.store.write("release", { task: "second", status: "dropped" });
  await f.store.write("release", { goal: null, count: 2, ready: true });
  expect(await f.store.read("release")).toEqual([{ list: "release", fields: { count: 2, ready: true }, items: [{ task: "first", fields: { status: "doing" } }, { task: "second", fields: { status: "dropped" } }], closed: false }]);
  await f.store.write("release", { task: "first", status: "done" });
  expect(await f.store.read("release")).toHaveLength(1);
  await f.store.write("release", { status: "done" });
  expect(await f.store.read()).toEqual([]);
  expect((await f.store.read("release", true))[0]!.closed).toBe(true);
  await f.store.write("release", { status: null });
  expect((await f.store.read())[0]!.closed).toBe(false);
});

test("work-list policy errors, private metadata and built-in secrets refuse before appending", async () => {
  let fail = false;
  const f = await fixture(async row => { if (fail) throw new Error("screen unavailable"); return !JSON.stringify(row).includes("private-source"); });
  const before = logs(f.store.dir);
  await expect(f.store.write("release", { detail: "safe" }, { source: "private-source", id: "one" })).rejects.toThrow("privacy");
  await expect(f.store.write("release", { detail: "password=not-for-export" })).rejects.toThrow("privacy");
  fail = true;
  await expect(f.store.write("release", { detail: "safe" })).rejects.toThrow("privacy");
  expect(logs(f.store.dir)).toEqual(before);
});

test("screening precedes work-list reduction and open-list selection", async () => {
  let hide = false;
  const f = await fixture(row => !(hide && JSON.stringify(row).includes("withheld-marker")));
  await f.store.write("release", { detail: "visible", status: "doing" });
  await f.store.write("release", { detail: "withheld-marker", status: "done" });
  hide = true;
  expect(await f.store.read()).toEqual([{ list: "release", fields: { detail: "visible", status: "doing" }, items: [], closed: false }]);
});

test("withheld item rows and read-policy errors cannot influence visible counts or state", async () => {
  let hide = false, fail = false;
  const f = await fixture(row => { if (fail) throw new Error("screen unavailable"); return !(hide && JSON.stringify(row).includes("withheld-marker")); });
  await f.store.write("release", { task: "visible", status: "todo" });
  await f.store.write("release", { task: "visible", status: "done", reason: "withheld-marker" });
  await f.store.write("release", { task: "hidden", status: "todo", reason: "withheld-marker" });
  hide = true;
  expect((await f.store.read())[0]!.items).toEqual([{ task: "visible", fields: { status: "todo" } }]);
  fail = true;
  expect(await f.store.read(undefined, true)).toEqual([]);
});

test("work stores are bound to their project shard and do not enter generation or capture storage", async () => {
  const f = await fixture(), other = new f.WorkListStore({ base: f.base, project: "other/work", policy: () => true });
  cleanup.push(() => other.close());
  expect(f.store.dir).toBe(join(shardDir(f.base, f.project), "work"));
  await f.store.write("same", { detail: "first project" });
  await other.write("same", { detail: "other project" });
  expect(JSON.stringify(await f.store.read())).not.toContain("other project");
  expect(JSON.stringify(await other.read())).not.toContain("first project");
  expect(existsSync(join(f.base, "profile.json"))).toBe(false);
  expect(existsSync(join(f.base, "log"))).toBe(false);
});

test("stable import receipts are idempotent and conflicting replay refuses without an append", async () => {
  const f = await fixture(), receipt = { source: "claude-mem:db-digest", id: "row-17", machine: "imported-machine", at: 500 };
  const first = await f.store.write("imported", { task: "one", status: "todo" }, receipt), before = logs(f.store.dir);
  const replay = await f.store.write("imported", { status: "todo", task: "one" }, receipt);
  expect(replay.id).toBe(first.id); expect(replay.already).toBe(true);
  expect(logs(f.store.dir)).toEqual(before);
  await expect(f.store.write("imported", { task: "one", status: "done" }, receipt)).rejects.toThrow("receipt");
  expect(logs(f.store.dir)).toEqual(before);
});

test("ordinary repeated writes have distinct identities and can restore an earlier value", async () => {
  const f = await fixture();
  const a = await f.store.write("release", { status: "doing" });
  await f.store.write("release", { status: "done" });
  const b = await f.store.write("release", { status: "doing" });
  expect(a.id).not.toBe(b.id);
  expect((await f.store.read())[0]!.fields.status).toBe("doing");
});

test("append truth repairs a removed index and observes another store's writes", async () => {
  const f = await fixture();
  await f.store.write("release", { task: "one", status: "doing" });
  const second = new f.WorkListStore({ base: f.base, project: f.project, policy: () => true, now: () => f.clock.now++ });
  cleanup.push(() => second.close());
  await second.write("release", { task: "one", status: "done" });
  const expected = await f.store.read(undefined, true), before = logs(f.store.dir);
  f.store.rebuild();
  expect(await f.store.read(undefined, true)).toEqual(expected);
  expect(logs(f.store.dir)).toEqual(before);
  f.store.close(); second.close();
  for (const name of ["index.db", "index.db-wal", "index.db-shm"]) rmSync(join(f.store.dir, name), { force: true });
  const reopened = new f.WorkListStore({ base: f.base, project: f.project, policy: () => true });
  cleanup.push(() => reopened.close());
  expect(await reopened.read(undefined, true)).toEqual(expected);
  expect(logs(reopened.dir)).toEqual(before);
});

test("invalid scalar, status and prototype fields refuse without appending", async () => {
  const f = await fixture(), before = logs(f.store.dir);
  for (const invalid of [{ count: Infinity }, { detail: {} }, { task: "one", status: "unknown" }, JSON.parse('{"__proto__":"poison"}'), { constructor: "poison" }]) {
    await expect(f.store.write("release", invalid as Fields)).rejects.toThrow();
  }
  expect(logs(f.store.dir)).toEqual(before);
  expect(({} as Record<string, unknown>).poison).toBeUndefined();
});

test("a corrupt hashed log row fails closed rather than becoming visible work state", async () => {
  const f = await fixture();
  await f.store.write("release", { detail: "valid" });
  const [name, text] = logs(f.store.dir)[0]!, row = JSON.parse(text.trim());
  appendFileSync(join(f.store.dir, "log", name), JSON.stringify({ ...row, fields: { detail: "tampered" } }) + "\n");
  await expect(f.store.read(undefined, true)).rejects.toThrow("work log");
});

test("same-epoch imported updates preserve numeric source-row order rather than random content hashes", async () => {
  const f = await fixture();
  await f.store.write("seed", { value: "unrelated" });
  const [name, text] = logs(f.store.dir)[0]!, seed = JSON.parse(text.trim());
  const oldBody = { schema: seed.schema, project: f.project, machine: seed.machine, at: 500, nonce: "0".repeat(32), list: "imported", fields: { value: "older" }, source: { source: "claude-mem:fixture", id: "9", machine: "source-device", at: 500 } };
  const oldRow = { ...oldBody, id: hashJSON(oldBody) };
  let latest: Record<string, unknown> | undefined;
  for (let attempt = 1; attempt <= 1024; attempt++) {
    const body = { ...oldBody, nonce: attempt.toString(16).padStart(32, "0"), fields: { value: "newer" }, source: { ...oldBody.source, id: "10" } };
    const row = { ...body, id: hashJSON(body) };
    if (row.id < oldRow.id) { latest = row; break; }
  }
  expect(latest).toBeDefined();
  // Valid source rows deliberately have adverse hash order. Numeric source sequence, not hashes, decides latest.
  appendFileSync(join(f.store.dir, "log", name), canonicalJSON(oldRow) + "\n" + canonicalJSON(latest) + "\n");
  expect((await f.store.read("imported"))[0]!.fields.value).toBe("newer");
  f.store.rebuild();
  expect((await f.store.read("imported"))[0]!.fields.value).toBe("newer");
});

test("same-clock authored writes keep the latest accepted append after asynchronous policy screening", async () => {
  const WorkListStore = await loader(), base = realPath(mkdtempSync(join(tmpdir(), "amem-work-clock-")));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  let held = true;
  const pending: { id: string; value: string; release: (allow: boolean) => void }[] = [];
  const store = new WorkListStore({ base, project: "fixture/clock", now: () => 1000, policy: row => {
    if (!held) return true;
    const value = row as { id: string; fields: { value: string } };
    return new Promise<boolean>(release => pending.push({ id: value.id, value: value.fields.value, release }));
  } });
  cleanup.push(() => store.close());
  const a = store.write("same", { value: "A" }), b = store.write("same", { value: "B" });
  expect(pending).toHaveLength(2);
  const ordered = [...pending].sort((a, b) => b.id.localeCompare(a.id));
  const promises = { A: a, B: b };
  ordered[0]!.release(true); await promises[ordered[0]!.value as "A" | "B"];
  held = false; // a writer may re-screen refreshed ordering metadata after it discovers the competing append
  ordered[1]!.release(true); await promises[ordered[1]!.value as "A" | "B"];
  expect((await store.read("same"))[0]!.fields.value).toBe(ordered[1]!.value);
  store.rebuild();
  expect((await store.read("same"))[0]!.fields.value).toBe(ordered[1]!.value);
});
