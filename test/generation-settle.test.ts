import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type NoteInput } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { realPath } from "../src/memory/platform.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const NOW = Date.parse("2030-01-01T00:00:00.000Z"), TASK = "agent-hub#1@1", G = "d".repeat(32);
const input = (text: string, kind: NoteInput["kind"] = "decision"): NoteInput => ({ op: "note", project: "agent-hub", scope: "project", tier: "short", kind, peer: "person", source: "person", task: TASK, text, about: [] });
async function fixture(settled = false) {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-gen-settle-")));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const old = new MemoryStore({ home, now: () => NOW, deferPromotions: true });
  const decision = old.note(input("legacy held decision")), finding = old.note(input("legacy finding", "finding"));
  if (settled) old.settle(TASK, "person");
  old.close();
  await migrate({ memoryDir: join(home, "memory"), mode: "apply", generation: G, authorizedPerson: true, tty: true });
  const store = new MemoryStore({ home, now: () => NOW, screen: () => "promote", deferPromotions: true, ttlMs: 1000 });
  cleanup.push(() => store.close());
  return { store, decision, finding };
}
function bytes(store: MemoryStore) { return Object.fromEntries(["log", "local"].flatMap(folder => readdirSync(join(store.dir, folder)).map(name => [`${folder}/${name}`, readFileSync(join(store.dir, folder, name), "utf8")]))); }
test("generation settle promotes only generation-born held notes and preserves the bridged projection", async () => {
  const { store, decision, finding } = await fixture(), beforeDecision = store.get(decision), beforeFinding = store.get(finding);
  const own = store.note(input("generation held decision"));
  expect(store.settle(TASK, "person")).toBe(1);
  expect(store.get(decision)).toEqual(beforeDecision);
  expect(store.get(finding)).toEqual(beforeFinding);
  expect(store.get(own)?.tier).toBe("long");
  const snapshot = store.prunePort().snapshot();
  expect(snapshot.expiries.some(expiry => expiry.targetId === finding)).toBe(false);
  const before = store.derivedTables(); store.rebuild(); expect(store.derivedTables()).toEqual(before);
});
test("explicit generation promotion refuses a bridged legacy note without authoring any row", async () => {
  const { store, decision } = await fixture(), before = bytes(store);
  expect(store.promote(decision, "person")).toBeUndefined();
  expect(bytes(store)).toEqual(before);
  expect(store.get(decision)?.id).toBe(decision);
});

test("legacy settlement is opt-in for reconciliation and does not settle generation-born notes", async () => {
  const { store, finding } = await fixture(true);
  const legacy = store.get(finding), before = bytes(store);
  expect(store.hasTask(TASK)).toBe(true);
  expect(store.settled(TASK)).toBe(false);
  expect(store.settled(TASK, { includeLegacy: true })).toBe(true);
  expect(store.settled("unknown", { includeLegacy: true })).toBe(false);
  expect(bytes(store)).toEqual(before);

  const own = store.note(input("new generation held decision"));
  expect(store.get(own)?.expiresAt).toBe(new Date(NOW + 180 * 24 * 60 * 60 * 1000).toISOString());
  expect(store.get(own)?.tier).toBe("short");
  expect(store.settle(TASK, "person")).toBe(1);
  expect(store.settled(TASK)).toBe(true);
  expect(store.get(own)?.tier).toBe("long");
  const late = store.note(input("late generation finding", "finding"));
  expect(store.get(late)?.expiresAt).toBe(new Date(NOW + 1000).toISOString());
  expect(store.get(finding)).toEqual(legacy);
  const projection = store.derivedTables();
  store.rebuild();
  expect(store.derivedTables()).toEqual(projection);
  expect(store.settled(TASK, { includeLegacy: true })).toBe(true);
});
