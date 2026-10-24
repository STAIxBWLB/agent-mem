import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, type Counter, type CounterKey } from "../src/memory/candidates.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryUseCallbacks, readMemoryUse, recordMemoryUse, type MemoryUsePort } from "../src/memory/use-telemetry.ts";
import { realPath } from "../src/memory/platform.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-use-telemetry-"))), base = join(home, "memory"); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  let now = Date.parse("2026-10-25T00:00:00.000Z");
  const store = new MemoryStore({ memoryDir: base, now: () => now, deferPromotions: true }), project = "public-project";
  const id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "public telemetry fixture", about: [] }); store.close();
  const port = new CandidateStore({ memoryDir: base, now: () => now }); cleanup.push(() => port.close());
  const bytes = () => Object.fromEntries(readdirSync(base, { recursive: true, withFileTypes: true }).filter(row => row.isFile() && row.name.endsWith(".jsonl")).map(row => { const file = join(row.parentPath, row.name); return [file, readFileSync(file, "utf8")]; }));
  const key: CounterKey = { project, entryId: id, deliveryId: "delivery-1" };
  return { port, key, bytes, tick: () => { now += 1000; } };
}
test("explicit callbacks merge only their metric and replay is idempotent per delivery, without authoring JSONL", () => {
  const f = fixture(), before = f.bytes(), callbacks = memoryUseCallbacks(f.port, { ...f.key, entryId: `mem:${f.key.entryId}` });
  expect(f.port.counters(f.key.project)).toEqual([]); expect(f.bytes()).toEqual(before);
  expect(callbacks.rendered()).toBe(true); expect(callbacks.rendered()).toBe(true);
  expect(readMemoryUse(f.port, f.key.project, f.key.entryId)).toEqual({ state: "known", records: 1, rendered: 1, delivered: null, cited: null });
  const created = f.port.counters(f.key.project)[0]!.createdAt; f.tick(); expect(callbacks.delivered(0)).toBe(true); expect(callbacks.cited(2)).toBe(true);
  expect(readMemoryUse(f.port, f.key.project, `mem:${f.key.entryId}`)).toEqual({ state: "known", records: 1, rendered: 1, delivered: 0, cited: 2 });
  expect(f.port.counters(f.key.project)[0]!.createdAt).toBe(created); expect(f.bytes()).toEqual(before);
});
test("known empty is zero records with unknown metrics, while missing fields remain unknown across deliveries", () => {
  const f = fixture(); expect(readMemoryUse(f.port, f.key.project, f.key.entryId)).toEqual({ state: "known", records: 0, rendered: null, delivered: null, cited: null });
  expect(recordMemoryUse(f.port, f.key, { rendered: 2, delivered: 0, cited: 1 })).toBe(true);
  expect(recordMemoryUse(f.port, { ...f.key, deliveryId: "delivery-2" }, { rendered: 3, delivered: 0, cited: null })).toBe(true);
  expect(readMemoryUse(f.port, f.key.project, f.key.entryId)).toEqual({ state: "known", records: 2, rendered: 5, delivered: 0, cited: null });
});
test("PII and failed guards make zero port calls; read and write failures are neutral optional telemetry", () => {
  let calls = 0;
  const port: MemoryUsePort = { recordCounter: () => { calls++; throw Error("private write failure"); }, counters: () => { calls++; throw Error("private read failure"); } };
  const key = { project: "project", entryId: "a".repeat(32), deliveryId: "delivery" };
  for (const context of [{ allowed: () => false }, { assertCurrent: () => { throw Error("changed"); } }]) {
    expect(recordMemoryUse(port, key, { rendered: 1 }, context)).toBe(false); expect(readMemoryUse(port, key.project, key.entryId, context)).toMatchObject({ state: "unknown", records: null });
  }
  expect(calls).toBe(0); expect(recordMemoryUse(port, key, { rendered: 1 })).toBe(false); expect(readMemoryUse(port, key.project, key.entryId)).toEqual({ state: "unknown", records: null, rendered: null, delivered: null, cited: null }); expect(calls).toBe(2);
});
test("post-seam guard detects binding or PII changes before returning telemetry", () => {
  const key = { project: "project", entryId: "a".repeat(32), deliveryId: "delivery" }; let allowed = true, valid = true;
  const port: MemoryUsePort = { recordCounter: () => { valid = false; return "id"; }, counters: () => { allowed = false; return []; } };
  expect(readMemoryUse(port, key.project, key.entryId, { allowed: () => allowed })).toMatchObject({ state: "unknown", records: null });
  expect(recordMemoryUse(port, key, { rendered: 1 }, { assertCurrent: () => { if (!valid) throw Error("changed"); } })).toBe(false);
});
function row(id: string, project = "project", entryId = "a".repeat(32), extra: Partial<Counter> = {}): Counter { return { id, key: { project, entryId, deliveryId: id }, createdAt: "2026-10-25T00:00:00.000Z", rendered: 1, delivered: 0, cited: 0, ...extra }; }
test("read filters foreign projects and entries; explicit aliases are queried and reconciled duplicate rows counted once", () => {
  const own = row("own"), alias = row("alias", "old-project"), foreign = row("foreign", "other-project"), other = row("other-entry", "project", "b".repeat(32)), queries: string[] = [];
  const port: MemoryUsePort = { recordCounter: () => "unused", counters: project => { queries.push(project); return [own, alias, foreign, other]; } };
  expect(readMemoryUse(port, "project", "a".repeat(32))).toMatchObject({ records: 1, rendered: 1, delivered: 0, cited: 0 });
  expect(readMemoryUse(port, "project", "a".repeat(32), { aliases: ["old-project", "old-project"] })).toMatchObject({ records: 2, rendered: 2, delivered: 0, cited: 0 }); expect(queries).toEqual(["project", "project", "old-project"]);
});
test("invalid or missing individual metrics and overflowing totals never become partial known sums", () => {
  for (const bad of [undefined, null, -1, 1.5, NaN, Infinity, "1"]) {
    const port: MemoryUsePort = { recordCounter: () => "unused", counters: () => [row("one"), row("two", "project", "a".repeat(32), { rendered: bad as number })] };
    expect(readMemoryUse(port, "project", "a".repeat(32))).toMatchObject({ state: "known", records: 2, rendered: null, delivered: 0, cited: 0 });
  }
  const port: MemoryUsePort = { recordCounter: () => "unused", counters: () => [row("one", "project", "a".repeat(32), { rendered: Number.MAX_SAFE_INTEGER }), row("two")] };
  expect(readMemoryUse(port, "project", "a".repeat(32)).rendered).toBeNull();
});
test("invalid exact keys and counts refuse without port calls; reading never records use", () => {
  let writes = 0, reads = 0; const port: MemoryUsePort = { recordCounter: () => { writes++; return "id"; }, counters: () => { reads++; return []; } }, key = { project: "project", entryId: "a".repeat(32), deliveryId: "delivery" };
  for (const entryId of ["a".repeat(8), "capture:1", "repo:" + "a".repeat(32)]) { expect(recordMemoryUse(port, { ...key, entryId }, { cited: 1 })).toBe(false); expect(readMemoryUse(port, key.project, entryId).state).toBe("unknown"); }
  for (const count of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(memoryUseCallbacks(port, key).rendered(count)).toBe(false);
  expect(recordMemoryUse(port, { ...key, project: " " }, { rendered: 1 })).toBe(false); expect(recordMemoryUse(port, { ...key, deliveryId: "" }, { rendered: 1 })).toBe(false); expect(writes).toBe(0); expect(reads).toBe(0);
  readMemoryUse(port, key.project, key.entryId); expect(reads).toBe(1); expect(writes).toBe(0);
});
