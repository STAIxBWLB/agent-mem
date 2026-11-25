import { afterEach, expect, spyOn, test } from "bun:test";
import { openShardStore } from "../src/memory/store.ts";
import { syncMemory, type SyncResult } from "../src/memory/sync.ts";
import { bareRemote, closeInventoryFixtures, inventoryFixture, note } from "./fakes/sync-placement-inventory.ts";

// #626: remote verification reads the placement advertisement once per run and fetches only a tip it does not hold.
afterEach(closeInventoryFixtures);

/** Counts the Git network operations a run starts, by the subcommand that follows the global options. */
function countGit() {
  const counts = { lsRemote: 0, fetch: 0, push: 0 };
  const real = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: unknown, opts: unknown) => {
    const argv = Array.isArray(cmd) ? cmd as string[] : [];
    if (argv.includes("amem-git")) {
      if (argv.includes("ls-remote")) counts.lsRemote++;
      else if (argv.includes("fetch")) counts.fetch++;
      else if (argv.includes("push")) counts.push++;
    }
    return (real as (...args: unknown[]) => unknown)(cmd, opts);
  }) as typeof Bun.spawn);
  return { counts, restore: () => spy.mockRestore() };
}
const receipt = (result: SyncResult) => ({ ok: result.ok, pushed: result.pushed, entries: result.entries,
  realms: result.placementRealms?.map(item => ({ realm: item.realm, outcome: item.outcome, publication: item.publication })),
  outcome: result.placementPublication?.outcome, withheld: result.placementPublication?.withheld, exported: result.placementPublication?.exported });

test("#626 AC2: a warm no-op over several publications reads the advertisement once and fetches nothing", async () => {
  // Enough realms for more than one publication, so sharing across publications is what is measured.
  // 4 realms with the user realm: two publications of two targets.
  const f = await inventoryFixture(3), remote = bareRemote();
  expect((await syncMemory(f.entry(), f.opts(remote))).ok).toBe(true);
  const before = await syncMemory(f.entry(), f.opts(remote));
  const git = countGit();
  let after: SyncResult;
  try { after = await syncMemory(f.entry(), f.opts(remote)); } finally { git.restore(); }
  expect(after.placementRealms!.every(item => item.outcome === "not-needed")).toBe(true);
  expect(new Set(after.placementRealms!.map(item => item.publication)).size).toBeGreaterThan(1);
  expect(git.counts).toEqual({ lsRemote: 1, fetch: 0, push: 0 });
  expect(receipt(after)).toEqual(receipt(before));
}, 300_000);

test("#626 AC3: a moved remote head is fetched and audited, and a publishing run keeps today's receipt", async () => {
  const f = await inventoryFixture(2), remote = bareRemote();
  expect((await syncMemory(f.entry(), f.opts(remote))).ok).toBe(true);
  // Another machine publishes to the same remote: the advertised user-realm tip moves past this cache.
  const other = await inventoryFixture(2);
  const shared = openShardStore({ memoryDir: other.home, deferPromotions: true, user: true });
  try { shared.note(note("an independent shared original", other.projects[0]!, "shared")); } finally { shared.close(); }
  expect((await syncMemory(other.entry(), other.opts(remote))).ok).toBe(true);
  const git = countGit();
  let moved: SyncResult;
  try { moved = await syncMemory(f.entry(), f.opts(remote)); } finally { git.restore(); }
  expect(moved.ok).toBe(true);
  expect(git.counts.fetch).toBeGreaterThanOrEqual(1);   // the moved tip is not held locally, so it is fetched
  // The fetched shared original was audited and imported: this home can now read it.
  const read = openShardStore({ memoryDir: f.home, deferPromotions: true, user: true });
  try { expect(JSON.stringify(read.list({ limit: 100 }))).toContain("an independent shared original"); } finally { read.close(); }
  // A publishing run: a new local row commits, and the run after it reads a fresh advertisement (the push dropped the shared one).
  const store = openShardStore({ memoryDir: f.home, deferPromotions: true, project: f.projects[0]! });
  try { store.note(note("a later allowed original", f.projects[0]!)); } finally { store.close(); }
  const published = await syncMemory(f.entry(), f.opts(remote));
  expect(published).toMatchObject({ ok: true, pushed: true });
  expect(published.placementRealms!.some(item => item.outcome === "committed")).toBe(true);
  const settled = await syncMemory(f.entry(), f.opts(remote));
  expect(settled.placementRealms!.every(item => item.outcome === "not-needed")).toBe(true);
}, 300_000);
