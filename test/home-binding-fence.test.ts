/**
 * #396: the content-hash fence in `sessionStartBrief` must observe the binding exactly as the full comparison does.
 *
 * Two properties are pinned here. First, the fence's path list is the reader's own: every path a full comparison opens
 * is in `homeBindingPaths`, so a reader that grows an input reddens instead of drifting away from the fence. Second, the
 * fence and the full comparison reach the same verdict for the same change held at the guard instant, which is what the
 * per-value screen fence promises.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { appendAlias } from "../src/memory/aliases.ts";
import { collectBindingReads, reportBindingRead } from "../src/memory/binding-read-set.ts";
import { configuredPolicyOptions } from "../src/memory/config.ts";
import { canonicalJSON, hashJSON, readSelector } from "../src/memory/generation.ts";
import { FENCE_UNSAFE, FENCE_MAX_PATHS, fenceIsComplete, homeBindingPaths, sameHomeBinding, snapshotHomeBinding } from "../src/memory/home-binding-fence.ts";
import { realPath } from "../src/memory/platform.ts";
import { readPublicPruneInputSetChain } from "../src/memory/public-prune-input-chain.ts";
import { readShardedSelection } from "../src/memory/shard.ts";
import { sessionStartBrief, type BriefOptions, type BriefResult } from "../src/session-brief.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

// Captured while no mock is installed: a live namespace spread inside a mock factory resolves back to the factory, and
// a namespace read after an earlier test's mock would hand the next test that test's override.
const realFence = { FENCE_UNSAFE, FENCE_MAX_PATHS, fenceIsComplete, homeBindingPaths, sameHomeBinding, snapshotHomeBinding };
const realReadSet = { collectBindingReads, reportBindingRead };

async function activated() {
  const fixture = await placementActivationFixture();
  cleanup.push(fixture.close);
  await activateSyncPlacement(fixture.options("apply"));
  return fixture;
}

function fenceSelector(home: string) {
  return readSelector(home).selector as { pruneInputSetHash?: string; placementHead?: string } | undefined;
}

/** One brief's options; the host screen may mutate the home on its first call and leave it mutated. */
function briefOptions(home: string, project: string, mutate?: () => void): BriefOptions {
  let calls = 0;
  return { cwd: home, base: home, project, repository: false,
    policy: { ...configuredPolicyOptions(home), host: { screen: async () => { if (calls++ === 0) mutate?.(); return true; } } } };
}
const brief = (home: string, project: string, mutate?: () => void): Promise<BriefResult> => sessionStartBrief(briefOptions(home, project, mutate));

const verdict = (result: BriefResult) => JSON.stringify({ empty: result.context.length === 0, coverage: result.coverage });

/**
 * A brief whose guard calls are counted. The counters are installed through the module registry and the brief is
 * imported fresh afterwards, so every count is the guard's own: `collects` is one full comparison, `snapshots` is one
 * fence pass. `cap` overrides the caller's bound without touching the code under test.
 */
async function counted(cap?: number, label = "", afterComparison?: () => void) {
  const fenceSpecifier = "../src/memory/home-binding-fence.ts", readSetSpecifier = "../src/memory/binding-read-set.ts";
  const counts = { snapshots: 0, collects: 0 };
  mock.module(fenceSpecifier, () => ({ ...realFence, ...(cap === undefined ? {} : { FENCE_MAX_PATHS: cap }),
    snapshotHomeBinding: (paths: readonly string[]) => { counts.snapshots++; return realFence.snapshotHomeBinding(paths); } }));
  mock.module(readSetSpecifier, () => ({ ...realReadSet,
    collectBindingReads: <T,>(work: () => T) => {
      counts.collects++;
      const value = realReadSet.collectBindingReads(work);
      // `afterComparison` runs inside the adoption's own window: the comparison proved the old bytes, the second hash
      // has not run yet.
      afterComparison?.();
      return value;
    } }));
  const fresh = await import(`../src/session-brief.ts?counted=${cap ?? "real"}-${label}`);
  return { counts, sessionStartBrief: fresh.sessionStartBrief as typeof sessionStartBrief };
}

/** Selected once: this module instance keeps the bound it was imported with, so every row's fallback run stays real. */
const unboundedBrief = (await counted(0)).sessionStartBrief;

test("a change between the adoption's two hashes is never stamped", async () => {
  const fixture = await activated();
  let armed = true;
  const { counts, sessionStartBrief: fenced } = await counted(undefined, "midread", () => {
    if (!armed) return;
    armed = false;
    appendAlias(fixture.base, { alias: "https://example.test/fence/midread.git", key: fixture.project, actor: "person", machine: "a".repeat(16) });
  });
  try {
    const result = await fenced(briefOptions(fixture.base, fixture.project));
    expect(armed, "the mid-read change never ran, so nothing was proved").toBe(false);
    // The next guard reads the moved binding for real instead of trusting a half-stamped home: two fence passes around
    // the refused comparison, and none after it, because nothing was adopted. An adopted stale stamp would be consulted
    // by every later guard instead (three more passes per guarded step) and would surface only at assembly.
    expect(counts.snapshots).toBe(2);
    expect(result.context, JSON.stringify(result)).toBe("");
    expect(result.coverage.work).toBe("unavailable");
  } finally { mock.restore(); }
});

test("the fence lists every path the full comparison opens", async () => {
  const fixture = await activated(), selector = fenceSelector(fixture.base);
  const { paths } = collectBindingReads(() => { readSelector(fixture.base); readShardedSelection(fixture.base); });
  // The fixed part must cover every input the reader opens except the prune chain, whose members can only be known
  // after a read and are therefore merged in from the report. This is the assertion that reddens when a reader grows
  // an input the fence does not name.
  const fixed = homeBindingPaths(realPath(fixture.base), selector), chainClass = (path: string) => path.includes("public-prune-input-sets");
  const opened = paths.filter(path => !chainClass(path));
  expect(opened.length).toBeGreaterThan(2);
  for (const path of opened) expect(fixed).toContain(path);
  // And the merge carries the rest, so nothing a reader reported can be missing from the adopted list.
  for (const path of paths) expect(homeBindingPaths(realPath(fixture.base), selector, [path])).toContain(path);
  // The selector and shard reads always consult these two, so an empty collection would make the loop above vacuous.
  expect(paths).toContain(join(fixture.base, "profile.json"));
  expect(paths.some(path => path.endsWith("shards.json"))).toBe(true);
});

test("the fence lists the prune chain files the reader opens", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-fence-chain-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "projects", "a".repeat(16)), folder = join(dir, "public-prune-input-sets");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const generation = "b".repeat(32), older = "a".repeat(64), newer = "b".repeat(64);
  const first = { schema: "agent-mem.public-prune-input-set/v1", receivingGeneration: generation, previous: null, inputs: [older] };
  const firstHash = hashJSON(first);
  writeFileSync(join(folder, `${firstHash}.json`), canonicalJSON(first) + "\n", { mode: 0o600 });
  const second = { schema: "agent-mem.public-prune-input-set/v1", receivingGeneration: generation, previous: firstHash, inputs: [older, newer] };
  const secondHash = hashJSON(second);
  writeFileSync(join(folder, `${secondHash}.json`), canonicalJSON(second) + "\n", { mode: 0o600 });
  const { paths } = collectBindingReads(() => readPublicPruneInputSetChain({ dir, receivingGeneration: generation, inputSetHash: secondHash }));
  expect(paths).toContain(join(folder, `${firstHash}.json`));
  expect(paths).toContain(join(folder, `${secondHash}.json`));
  expect(homeBindingPaths(root, undefined, paths)).toContain(join(folder, `${firstHash}.json`));
});

test("a snapshot describes absence, content and identity, and refuses a shape the readers refuse", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-fence-snapshot-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "profile.json");
  expect(snapshotHomeBinding([file]).entries).toEqual(["-"]);
  writeFileSync(file, "{\"a\":1}\n", { mode: 0o600 });
  const original = snapshotHomeBinding([file]), entry = original.entries[0]!;
  expect(entry.startsWith("f:")).toBe(true);
  expect(fenceIsComplete(original)).toBe(true);
  // A same-size in-place rewrite is a different hash, so no timestamp inference is involved.
  writeFileSync(file, "{\"a\":2}\n", { mode: 0o600 });
  expect(sameHomeBinding(original, snapshotHomeBinding([file]))).toBe(false);
  // A byte-identical replacement changes only the inode, which the entry carries.
  const beforeReplace = snapshotHomeBinding([file]), replaced = join(root, "replacement.json");
  copyFileSync(file, replaced);
  renameSync(replaced, file);
  const afterReplace = snapshotHomeBinding([file]);
  expect(afterReplace.entries[0]).not.toBe(beforeReplace.entries[0]);
  expect(sameHomeBinding(beforeReplace, afterReplace)).toBe(false);
  expect(afterReplace.entries[0]!.endsWith(beforeReplace.entries[0]!.slice(-65))).toBe(true);
  // A group-writable file is one the full read refuses, so the fence must not describe it as safe; and an unsafe entry
  // is never a fingerprint, so a snapshot carrying one is incomplete and the guard keeps its full read.
  chmodSync(file, 0o666);
  expect(snapshotHomeBinding([file]).entries[0]).toBe(FENCE_UNSAFE);
  expect(fenceIsComplete(snapshotHomeBinding([file]))).toBe(false);
});

/** Rows of the same table: the mutation is applied on the first screen call and stays for the guard that follows. */
const rows: { name: string; mutate: (fixture: { base: string; project: string }) => () => void; expectRefusal: boolean }[] = [
  { name: "a byte-identical replacement", expectRefusal: false, mutate: fixture => {
    const copy = join(fixture.base, "shards.copy");
    copyFileSync(join(fixture.base, "shards.json"), copy);
    return () => renameSync(copy, join(fixture.base, "shards.json"));
  } },
  { name: "an alias that changes the compared value", expectRefusal: true, mutate: fixture => () => {
    appendAlias(fixture.base, { alias: "https://example.test/fence/alias.git", key: fixture.project, actor: "person", machine: "a".repeat(16) });
  } },
  { name: "a missing shards.json held at the guard", expectRefusal: true, mutate: fixture => {
    const copy = join(fixture.base, "shards.held");
    copyFileSync(join(fixture.base, "shards.json"), copy);
    return () => { unlinkSync(join(fixture.base, "shards.json")); };
  } },
];

for (const row of rows) {
  test(`fence and full comparison agree on ${row.name}`, async () => {
    const fenced = await activated(), full = await activated();
    const mutate = (home: string) => row.mutate({ base: home, project: fenced.project });
    const fencedVerdict = await brief(fenced.base, fenced.project, mutate(fenced.base));
    // A fresh import with `FENCE_MAX_PATHS: 0` reached the guard through the module registry, so this run really is
    // today's full comparison: the bound is below the fixture's 16 paths and no guard adopts a stamp.
    const fullVerdict = await unboundedBrief(briefOptions(full.base, full.project, mutate(full.base)));
    expect(verdict(fencedVerdict)).toEqual(verdict(fullVerdict));
    if (row.expectRefusal) {
      expect(fencedVerdict.context, JSON.stringify(fencedVerdict)).toBe("");
      expect(fencedVerdict.coverage.work).toBe("unavailable");
    } else {
      // The control matters: a fixture whose brief is unavailable for an unrelated reason would satisfy the row above.
      expect(fencedVerdict.context.length, JSON.stringify(fencedVerdict)).toBeGreaterThan(0);
    }
  });
}

test("the fence keeps the brief complete on an unchanged home", async () => {
  const fixture = await activated();
  const result = await brief(fixture.base, fixture.project);
  expect(result.context.length, JSON.stringify(result)).toBeGreaterThan(0);
  expect(result.coverage.curated).toBe("complete");
});

test("a set above the caller's bound hands every guard back to the full comparison", async () => {
  const fixture = await activated(), home = realPath(fixture.base), selector = fenceSelector(fixture.base);
  const { paths: reported } = collectBindingReads(() => { readSelector(home); readShardedSelection(home); });
  const paths = homeBindingPaths(home, selector, reported);
  // This fixture is one the fence can describe, so only the caller's bound can latch it off; the cap below is real.
  expect(fenceIsComplete(snapshotHomeBinding(paths))).toBe(true);
  expect(paths.length).toBeGreaterThan(8);
  const { counts, sessionStartBrief: bounded } = await counted(8);
  try {
    const result = await bounded({ cwd: fixture.base, base: fixture.base, project: fixture.project, repository: false, policy: configuredPolicyOptions(fixture.base) });
    expect(result.context.length, JSON.stringify(result)).toBeGreaterThan(0);
    // One full comparison for the whole brief: the bound is read on the first guard, the fence gives up there, and
    // neither the checks before assembly nor any later guard pays for a hash pass it never adopted.
    expect(counts.collects).toBe(1);
    expect(counts.snapshots).toBe(3);
  } finally { mock.restore(); }
});

test("a byte-identical replacement re-adopts with one full comparison, not one per guard", async () => {
  const fixture = await activated(), target = join(fixture.base, "shards.json"), replacement = join(fixture.base, "shards.copy");
  copyFileSync(target, replacement);
  let screens = 0;
  const { counts, sessionStartBrief: fenced } = await counted();
  try {
    const result = await fenced({ cwd: fixture.base, base: fixture.base, project: fixture.project, repository: false,
      policy: { ...configuredPolicyOptions(fixture.base), host: { screen: async () => { if (screens++ === 0) renameSync(replacement, target); return true; } } } });
    expect(screens, JSON.stringify(result)).toBeGreaterThan(1);
    expect(result.context.length).toBeGreaterThan(0);
    // The comparison that adopts, the one that sees the new inode, and the check before assembly: every other guard
    // answered from the fence, so a stamp is adopted for the replacement without a per-guard re-read.
    expect(counts.collects).toBe(3);
    expect(counts.snapshots).toBeGreaterThan(counts.collects * 2);
  } finally { mock.restore(); }
});
