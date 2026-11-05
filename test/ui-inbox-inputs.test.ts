import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, openShardStore, entryId, type NoteEntry } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { shardDir } from "../src/memory/shard.ts";
import { CandidateStore, candidateTargetRevision } from "../src/memory/candidates.ts";
import { boundedInboxRows, computeInbox, createInboxSourceTracker, inboxCaptureConfigVersion, inboxPolicyVersion, inboxSourceChange,
  inboxSources, INBOX_MAX_BYTES, type InboxItem } from "../src/ui/inbox.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home() { const dir = mkdtempSync(join(tmpdir(), "amem-inbox-inputs-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const memo = (base: string) => ({ policy: inboxPolicyVersion(base), captureConfig: inboxCaptureConfigVersion(base), until: Date.now() + 300000, item: null });
const note = (text: string) => ({ op: "note" as const, project: "project", scope: "project" as const, tier: "long" as const, kind: "finding" as const, peer: "person", source: "person" as const, text, about: [] });
function sourceLine(index: number, extra: Partial<NoteEntry> = {}) {
  const body: Omit<NoteEntry, "id"> = { schema: "agent-hub.memory/v1", at: "2026-11-01T00:00:00.000Z", machine: "a".repeat(16), ...note(`plain source ${index}`), ...extra };
  const { id: _id, ...clean } = body as NoteEntry; return JSON.stringify({ ...clean, id: entryId(clean) }) + "\n";
}
function rawFixture() { const base = home(); mkdirSync(join(base, "log")); const file = join(base, "log", "author.jsonl"); writeFileSync(file, sourceLine(0)); return { base, file }; }

test("targetless inbox input inventory ignores ordinary curated accepts and hook/work/setup/capture churn", () => {
  const base = home();
  const candidates = new CandidateStore({ memoryDir: base }); try { candidates.put({ project: "project", kind: "memory", text: "targetless item" }, "public"); } finally { candidates.close(); }
  const tracker = createInboxSourceTracker(base), result = computeInbox(base, memo(base), tracker.beforeProject), before = tracker.before();
  expect(result.items.some(item => item.kind === "memory")).toBe(true); expect(before.roots).toEqual([]);
  const memory = new MemoryStore({ memoryDir: base, deferPromotions: true }); cleanup.push(() => memory.close());
  memory.note(note("ordinary accept without a dependency"));
  for (const folder of ["hook-project", "work", "setup", ".agenthub", "projects/capture-only/machine/fixture"]) { mkdirSync(join(base, folder), { recursive: true }); writeFileSync(join(base, folder, "unrelated.jsonl"), "unrelated\n"); }
  const change = inboxSourceChange(base, before); expect(change.changed).toBe(false); expect(change.hard).toBe(false);
});

test("real referenced-source plain-note append is soft, while forget is hard and target expiry is exposed", () => {
  const base = home(), memory = new MemoryStore({ memoryDir: base, deferPromotions: true }); cleanup.push(() => memory.close());
  const expiresAt = new Date(Date.now() + 60000).toISOString(), target = memory.note({ ...note("referenced target"), tier: "short", expires: expiresAt });
  const candidates = new CandidateStore({ memoryDir: base }); try { candidates.put({ project: "project", kind: "correction", target: { id: target, revision: candidateTargetRevision(memory.get(target, "project")!) }, proposedText: "ordinary proposal", reason: "evidence" }, "public"); } finally { candidates.close(); }
  const tracker = createInboxSourceTracker(base), result = computeInbox(base, memo(base), tracker.beforeProject), before = tracker.before();
  expect(before.roots).toContain("log"); expect(before.version).toBe(tracker.after().version); expect(result.expiresAt).toBe(Date.parse(expiresAt));
  memory.note(note("new ordinary source note")); const appended = inboxSourceChange(base, before); expect(appended.changed).toBe(true); expect(appended.hard).toBe(false);
  expect(memory.forget(target, "person", "project")).toBeDefined(); const forgotten = inboxSourceChange(base, appended.sources); expect(forgotten.changed).toBe(true); expect(forgotten.hard).toBe(true);
});

test("a new valid note namespace is soft but superseding/promoted notes and malformed tails are hard", () => {
  const f = rawFixture(), first = inboxSources(f.base, ["log"]); writeFileSync(join(f.base, "log", "new.jsonl"), sourceLine(1));
  const change = inboxSourceChange(f.base, first); expect(change.changed).toBe(true); expect(change.hard).toBe(false);
  for (const tail of [sourceLine(2, { supersedes: "b".repeat(32) }), sourceLine(3, { promotedFrom: "b".repeat(32) }), "{torn", "{bad}\n", JSON.stringify({ op: "future" }) + "\n"]) {
    const before = inboxSources(f.base, ["log"]); appendFileSync(f.file, tail); expect(inboxSourceChange(f.base, before).hard).toBe(true);
  }
});

for (const kind of ["replacement", "truncation", "directory"] as const) test(`referenced source ${kind} is hard even when a suffix appears ordinary`, () => {
  const f = rawFixture(), before = inboxSources(f.base, ["log"]);
  if (kind === "replacement") { const replacement = join(f.base, "replacement"); writeFileSync(replacement, sourceLine(0) + sourceLine(1)); renameSync(replacement, f.file); }
  if (kind === "truncation") truncateSync(f.file, 1);
  if (kind === "directory") { renameSync(join(f.base, "log"), join(f.base, "retired-log")); mkdirSync(join(f.base, "log")); writeFileSync(f.file, sourceLine(0)); }
  expect(inboxSourceChange(f.base, before)).toMatchObject({ changed: true, hard: true });
});

test("large honest append-only prefixes remain soft without rehashing, but total new-tail reads are capped", () => {
  const f = rawFixture(); appendFileSync(f.file, Array.from({ length: 1200 }, (_, index) => sourceLine(index + 1)).join(""));
  const before = inboxSources(f.base, ["log"]); appendFileSync(f.file, sourceLine(9000)); expect(inboxSourceChange(f.base, before).hard).toBe(false);
  const next = inboxSources(f.base, ["log"]); appendFileSync(f.file, sourceLine(9001).repeat(2000)); expect(inboxSourceChange(f.base, next).hard).toBe(true);
});

for (const file of ["amem.config.json", "aliases.jsonl", "lifecycle.jsonl", "profile.json", "shards.json"]) test(`${file} changes are hard even with no curated roots`, () => {
  const base = home(), before = inboxSources(base); writeFileSync(join(base, file), "changed metadata\n"); expect(inboxSourceChange(base, before)).toMatchObject({ changed: true, hard: true });
});

test("ordinary actual candidate DB changes are soft and a missing DB returns a complete empty computation", () => {
  const base = home(), missing = computeInbox(base, memo(base)); expect(missing).toMatchObject({ items: [], more: 0, expiresAt: null }); expect(existsSync(join(base, "candidates.db"))).toBe(false);
  const candidates = new CandidateStore({ memoryDir: base }); try { candidates.put({ project: "project", kind: "memory", text: "first" }, "public");
    const before = inboxSources(base); candidates.put({ project: "project", kind: "memory", text: "second" }, "public"); expect(inboxSourceChange(base, before)).toMatchObject({ changed: true, hard: false });
  } finally { candidates.close(); }
});

test("ignored entries still consume the directory scan ceiling", () => {
  const f = rawFixture(), real = fs.opendirSync; let reads = 0, closed = false;
  const fake = { readSync() { return reads++ < 16385 ? { name: `ignored-${reads}.db` } : null; }, closeSync() { closed = true; } };
  const spy = spyOn(fs, "opendirSync").mockImplementation(((file: fs.PathLike, options?: unknown) => String(file) === join(f.base, "log") ? fake : real(file, options as never)) as typeof fs.opendirSync);
  try { expect(() => inboxSources(f.base, ["log"])).toThrow("bound"); expect(closed).toBe(true); expect(reads).toBeLessThanOrEqual(16385); } finally { spy.mockRestore(); }
});

function item(index: number): InboxItem { return { id: `item-${index}`, group: "candidate", kind: "memory", title: `item ${index}`, at: new Date(1700000000000 + index).toISOString(), verbs: [], link: { panel: "review" } }; }
test("overflow is inside the row cap, capacity comes first, and true hidden count excludes the hint", () => {
  const capacity: InboxItem = { ...item(0), id: "capacity:proposal", group: "alert", kind: "capacity" }, prior: InboxItem = { ...item(0), id: "inbox:more", group: "alert", kind: "status", at: "2000-01-01T00:00:00.000Z" };
  const result = boundedInboxRows([capacity, prior, ...Array.from({ length: 70 }, (_, index) => item(index))], 71);
  expect(result.items).toHaveLength(50); expect(result.items[0]!.id).toBe("capacity:proposal"); expect(result.items[1]).toMatchObject({ id: "inbox:more", title: "22 more in Review", verbs: [], at: prior.at });
  expect(result.more).toBe(22); expect(result.items.slice(2).map(value => value.id)).toEqual(Array.from({ length: 48 }, (_, index) => `item-${69-index}`));
  expect(boundedInboxRows([item(0)], 1)).toEqual({ items: [item(0)], more: 0 });
});

test("overflow text is recomputed after UTF-8 byte trimming and totalCount remains real-only", () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ ...item(index), project: "제".repeat(399), title: "공".repeat(120), link: { panel: "review", params: { project: "제".repeat(399) } } }));
  const result = boundedInboxRows(rows, 60), real = result.items.filter(value => value.id !== "inbox:more");
  expect(result.items.length).toBeLessThan(50); expect(result.more).toBe(60-real.length); expect(result.items[0]!.title).toBe(`${result.more} more in Review`);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(INBOX_MAX_BYTES-512);
});


test("targeted shard tracking excludes an unopened project's raw sources and machine/work data", async () => {
  const base = home(), memory = new MemoryStore({ memoryDir: base, deferPromotions: true });
  const target = memory.note(note("selected shard target")); memory.note({ ...note("unopened shard target"), project: "other-project" }); memory.close();
  await migrateShards({ memoryDir: base, generation: "a".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  await activatePublicPruneView({ memoryDir: base, mode: "apply", authorizedPerson: true, tty: true });
  const selected = openShardStore({ memoryDir: base, project: "project", deferPromotions: true });
  const candidates = new CandidateStore({ memoryDir: base });
  try { candidates.put({ project: "project", kind: "correction", target: { id: target, revision: candidateTargetRevision(selected.get(target, "project")!) }, proposedText: "ordinary proposal", reason: "evidence" }, "public"); } finally { candidates.close(); selected.close(); }
  const tracker = createInboxSourceTracker(base); computeInbox(base, memo(base), tracker.beforeProject); const before = tracker.before();
  const unopened = shardDir(base, "other-project").slice(base.length + 1);
  expect(before.paths.some(path => path === unopened || path.startsWith(unopened + "/"))).toBe(false);
  const other = openShardStore({ memoryDir: base, project: "other-project", deferPromotions: true });
  try { other.note({ ...note("unrelated shard append"), project: "other-project" }); } finally { other.close(); }
  expect(inboxSourceChange(base, before).changed).toBe(false);
});
