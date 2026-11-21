/**
 * #396: the content-hash fence in `sessionStartBrief` must observe the binding exactly as the full comparison does.
 *
 * Two properties are pinned here. First, the fence's path list covers what the readers really touch: an `node:fs` spy
 * records every path a full read opens, so a reader that grows an input reddens even if it forgets to report it. Second,
 * adoption never trusts bytes the comparison did not bracket, and the fence and the full comparison reach the same
 * verdict for the same change held at the guard instant.
 */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { appendAlias } from "../src/memory/aliases.ts";
import { collectBindingReads, reportBindingRead } from "../src/memory/binding-read-set.ts";
import { configuredPolicyOptions } from "../src/memory/config.ts";
import { canonicalJSON, hashJSON, readSelector } from "../src/memory/generation.ts";
import { FENCE_MAX_PATHS, FENCE_UNSAFE, fenceIsComplete, homeBindingPaths, sameHomeBinding, snapshotHomeBinding } from "../src/memory/home-binding-fence.ts";
import { projectState } from "../src/memory/lifecycle.ts";
import { realPath } from "../src/memory/platform.ts";
import { readPublicPruneInputSetChain } from "../src/memory/public-prune-input-chain.ts";
import { publicPruneViewHash, readPublicPruneViewForActivation, validatePublicPruneView } from "../src/memory/public-prune-view.ts";
import { aliasedKeys, readShardedSelection, resolveAlias } from "../src/memory/shard.ts";
import { sessionStartBrief, type BriefOptions, type BriefResult } from "../src/session-brief.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

// Captured while no mock is installed: a live namespace spread inside a mock factory resolves back to the factory, and a
// namespace read after an earlier test's mock would hand the next test that test's override.
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

/** The comparison the guard runs, byte for byte, so a spy over it sees the reads the fence must cover. */
function comparison(memoryDir: string, project: string) {
  const initial = readSelector(memoryDir), selection = initial.revision;
  const sharded = !!fs.lstatSync(join(memoryDir, "shards.json"), { throwIfNoEntry: false });
  const shardSelection = sharded ? JSON.stringify(readShardedSelection(memoryDir)) : undefined;
  const aliases = aliasedKeys(memoryDir, project);
  return () => {
    if (resolveAlias(memoryDir, project) !== project || aliasedKeys(memoryDir, project).join("\n") !== aliases.join("\n")
      || readSelector(memoryDir).revision !== selection || projectState(memoryDir, project) !== "active") throw new Error("binding changed");
    const split = !!fs.lstatSync(join(memoryDir, "shards.json"), { throwIfNoEntry: false });
    if (split !== sharded || split && JSON.stringify(readShardedSelection(memoryDir)) !== shardSelection) throw new Error("binding changed");
  };
}

/** Run `work` under an `node:fs` spy, so the recorded paths are the ones the file system really saw. */
async function observe<T>(work: () => T | Promise<T>): Promise<{ value: T; opened: string[]; statted: string[] }> {
  const opened: string[] = [], statted: string[] = [];
  const openSync = fs.openSync, lstatSync = fs.lstatSync;
  const openSpy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (typeof args[0] === "string") opened.push(args[0]);
    return Reflect.apply(openSync, fs, args) as number;
  }) as typeof fs.openSync);
  const statSpy = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    if (typeof args[0] === "string") statted.push(args[0]);
    return Reflect.apply(lstatSync, fs, args) as ReturnType<typeof fs.lstatSync>;
  }) as typeof fs.lstatSync);
  try { return { value: await work(), opened, statted }; } finally { openSpy.mockRestore(); statSpy.mockRestore(); }
}

const under = (root: string, paths: string[]) => [...new Set(paths.filter(path => path === root || path.startsWith(root + sep)))];

/** One brief's options; the host screen may mutate the home on its first call, and every call is counted. */
function briefOptions(home: string, project: string, mutate?: () => void, onScreen?: () => void): BriefOptions {
  let calls = 0;
  return { cwd: home, base: home, project, repository: false,
    policy: { ...configuredPolicyOptions(home), host: { screen: async () => { onScreen?.(); if (calls++ === 0) mutate?.(); return true; } } } };
}
const brief = (home: string, project: string, mutate?: () => void): Promise<BriefResult> => sessionStartBrief(briefOptions(home, project, mutate));

const verdict = (result: BriefResult) => JSON.stringify({ empty: result.context.length === 0, coverage: result.coverage });

/**
 * A brief whose guard calls are counted. The counters are installed through the module registry and the brief is
 * imported fresh afterwards, so every count is the guard's own: `collects` is one full comparison, `snapshots` is one
 * fence pass, `hashed` is every path a pass hashed. `cap` overrides the caller's bound, `afterComparison` fires inside
 * the adoption window, `onSnapshot` sees each pass, and `grow` adds paths from a chosen pass on, the way a reader that
 * reports new inputs does.
 */
async function counted(hooks: { cap?: number; label?: string; afterComparison?: () => void;
  onSnapshot?: (index: number, paths: readonly string[]) => void; grow?: (paths: readonly string[]) => string[] } = {}) {
  const { cap, label = "", afterComparison, onSnapshot, grow } = hooks;
  const fenceSpecifier = "../src/memory/home-binding-fence.ts", readSetSpecifier = "../src/memory/binding-read-set.ts";
  const counts = { snapshots: 0, collects: 0, hashed: [] as string[] };
  mock.module(fenceSpecifier, () => ({ ...realFence, ...(cap === undefined ? {} : { FENCE_MAX_PATHS: cap }),
    homeBindingPaths: (home: string, selector: Parameters<typeof realFence.homeBindingPaths>[1], reported: readonly string[] = []) => {
      const paths = realFence.homeBindingPaths(home, selector, reported);
      return grow ? grow(paths) : paths;
    },
    snapshotHomeBinding: (paths: readonly string[]) => {
      const snapshot = realFence.snapshotHomeBinding(paths);
      counts.snapshots++;
      counts.hashed.push(...paths);
      onSnapshot?.(counts.snapshots, paths);
      return snapshot;
    } }));
  mock.module(readSetSpecifier, () => ({ ...realReadSet,
    collectBindingReads: <T,>(work: () => T) => {
      counts.collects++;
      const value = realReadSet.collectBindingReads(work);
      afterComparison?.();
      return value;
    } }));
  const fresh = await import(`../src/session-brief.ts?counted=${cap ?? "real"}-${label}`);
  return { counts, sessionStartBrief: fresh.sessionStartBrief as typeof sessionStartBrief };
}

/** Selected once: this module instance keeps the bound it was imported with, so every row's fallback run stays real. */
const unboundedBrief = (await counted({ cap: 0 })).sessionStartBrief;

test("every path the readers open is in the fence's set", async () => {
  const fixture = await activated(), home = realPath(fixture.base), selector = fenceSelector(home);
  const compare = comparison(home, fixture.project);
  const { opened, statted } = await observe(() => { compare(); readSelector(home); });
  const { paths: reported } = collectBindingReads(() => comparison(home, fixture.project)());
  const list = homeBindingPaths(home, selector, reported);
  // The spy is the witness, not the report: a reader that opens an input it forgets to report reddens here.
  const seen = under(home, [...opened, ...statted]);
  expect(seen.length).toBeGreaterThan(4);
  for (const path of seen) expect(list).toContain(path);
  // And the coverage is not vacuous: the selector, the journal and the activation binding were really opened.
  expect(opened).toContain(join(home, "profile.json"));
  expect(opened).toContain(join(home, "shards.json"));
  expect(statted).toContain(join(home, "profile.lock"));
  expect(statted.some(path => path.endsWith("sync-placement-activation.json"))).toBe(true);
});

test("the fence sets the chain files a reader opens, and a missing link refuses", () => {
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
  const read = () => readPublicPruneInputSetChain({ dir, receivingGeneration: generation, inputSetHash: secondHash });
  const { opened } = { opened: [] as string[] };
  const openSync = fs.openSync;
  const openSpy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (typeof args[0] === "string") opened.push(args[0]);
    return Reflect.apply(openSync, fs, args) as number;
  }) as typeof fs.openSync);
  try { read(); } finally { openSpy.mockRestore(); }
  // An advanced chain: the second link is opened too, and neither is in the fixed list, so the report is what sets them.
  const chainTip = join(folder, `${secondHash}.json`), olderLink = join(folder, `${firstHash}.json`);
  expect(opened).toContain(chainTip);
  expect(opened).toContain(olderLink);
  const { paths: reported } = collectBindingReads(read), list = homeBindingPaths(root, undefined, reported);
  for (const path of under(root, opened)) expect(list).toContain(path);
  expect(homeBindingPaths(root, undefined)).not.toContain(olderLink);
  // A missing link is a refusal, and the list still names it: absence is compared, never adopted away.
  unlinkSync(olderLink);
  expect(read).toThrow();
  expect(list).toContain(olderLink);
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
  const { paths: reported } = collectBindingReads(() => comparison(home, fixture.project)());
  const paths = homeBindingPaths(home, selector, reported);
  // This fixture is one the fence can describe, so only the caller's bound can latch it off; the cap below is real.
  expect(fenceIsComplete(snapshotHomeBinding(paths))).toBe(true);
  expect(paths.length).toBeGreaterThan(8);
  const { counts, sessionStartBrief: bounded } = await counted({ cap: 8 });
  try {
    const result = await bounded({ cwd: fixture.base, base: fixture.base, project: fixture.project, repository: false, policy: configuredPolicyOptions(fixture.base) });
    expect(result.context.length, JSON.stringify(result)).toBeGreaterThan(0);
    // One full comparison for the whole brief: the bound is read on the first guard, the fence gives up there, and
    // neither the checks before assembly nor any later guard pays for a hash pass it never adopted.
    expect(counts.collects).toBe(1);
    expect(counts.snapshots).toBe(2);
  } finally { mock.restore(); }
});

test("a set that grows past the bound is never hashed", async () => {
  const fixture = await activated(), home = realPath(fixture.base);
  // `realFence`, not the live binding: the module registry is mocked by this file's own counted() calls.
  const extra = Array.from({ length: realFence.FENCE_MAX_PATHS + 1 }, (_, index) => join(home, `late-${index}.json`));
  let armed = false;
  const { counts, sessionStartBrief: fenced } = await counted({ label: "overbound",
    onSnapshot: index => { if (index === 1) armed = true; },
    grow: paths => (armed ? [...new Set([...paths, ...extra])] : [...paths]) });
  try {
    const result = await fenced(briefOptions(fixture.base, fixture.project));
    expect(result.context.length, JSON.stringify(result)).toBeGreaterThan(0);
    expect(armed).toBe(true);
    // The bound is read on the reported list, so not one of the over-limit paths is ever opened: the fence falls back.
    expect(counts.hashed.filter(path => extra.includes(path))).toEqual([]);
    expect(counts.collects).toBe(1);
    expect(counts.snapshots).toBe(2);
  } finally { mock.restore(); }
});

test("an unsafe snapshot latches the fence off instead of being adopted", async () => {
  const fixture = await activated();
  // A session-private file the readers accept but the fence refuses to describe: its entry is `!`, in both passes.
  writeFileSync(join(fixture.base, "aliases.jsonl"), "", { mode: 0o600 });
  chmodSync(join(fixture.base, "aliases.jsonl"), 0o644);
  const { counts, sessionStartBrief: fenced } = await counted({ label: "unsafe" });
  try {
    const result = await fenced(briefOptions(fixture.base, fixture.project));
    expect(result.context.length, JSON.stringify(result)).toBeGreaterThan(0);
    // One pair, no stamp, then the existing comparison for every later guard: an unsafe entry is not a fingerprint.
    expect(counts.snapshots).toBe(2);
    expect(counts.collects).toBe(1);
  } finally { mock.restore(); }
});

test("a byte-identical replacement re-adopts with one full comparison, not one per guard", async () => {
  const fixture = await activated(), target = join(fixture.base, "shards.json"), replacement = join(fixture.base, "shards.copy");
  copyFileSync(target, replacement);
  let screens = 0;
  const { counts, sessionStartBrief: fenced } = await counted({ label: "replacement" });
  try {
    const result = await fenced({ ...briefOptions(fixture.base, fixture.project), policy: { ...configuredPolicyOptions(fixture.base),
      host: { screen: async () => { if (screens++ === 0) renameSync(replacement, target); return true; } } } });
    expect(screens, JSON.stringify(result)).toBeGreaterThan(1);
    expect(result.context.length).toBeGreaterThan(0);
    // The comparison that adopts, the one that sees the new inode, and the check before assembly: every other guard
    // answered from the fence, so a stamp is adopted for the replacement without a per-guard re-read.
    expect(counts.collects).toBe(3);
    expect(counts.snapshots).toBeGreaterThan(counts.collects * 2);
  } finally { mock.restore(); }
});

test("a change between the adoption's two hashes never reaches the screen", async () => {
  const fixture = await activated(), state = { screens: 0, screensAtMutation: -1 };
  let armed = true;
  const { counts, sessionStartBrief: fenced } = await counted({ label: "midread", afterComparison: () => {
    if (!armed) return;
    armed = false;
    state.screensAtMutation = state.screens;
    appendAlias(fixture.base, { alias: "https://example.test/fence/midread.git", key: fixture.project, actor: "person", machine: "a".repeat(16) });
  } });
  try {
    const result = await fenced(briefOptions(fixture.base, fixture.project, undefined, () => { state.screens++; }));
    expect(armed, "the mid-read change never ran, so nothing was proved").toBe(false);
    // The pair disagreed and the re-read refuses in the same guard, so no screened value sees the moved binding.
    expect(state.screens, "a screen callback ran after the observed change").toBe(state.screensAtMutation);
    expect(counts.collects).toBe(2);
    expect(result.context, JSON.stringify(result)).toBe("");
    expect(result.coverage.work).toBe("unavailable");
  } finally { mock.restore(); }
});

test("a change after the adoption's second hash refuses at the next guard", async () => {
  const fixture = await activated(), state = { screens: 0, screensAtMutation: -1 };
  let armed = true;
  const { counts, sessionStartBrief: fenced } = await counted({ label: "afterhash", onSnapshot: index => {
    // The adoption's second hash is pass 2. A change landing right after it must not be inside the stamped state.
    if (index !== 2 || !armed) return;
    armed = false;
    state.screensAtMutation = state.screens;
    appendAlias(fixture.base, { alias: "https://example.test/fence/afterhash.git", key: fixture.project, actor: "person", machine: "a".repeat(16) });
  } });
  try {
    const result = await fenced(briefOptions(fixture.base, fixture.project, undefined, () => { state.screens++; }));
    expect(armed, "the after-hash change never ran, so nothing was proved").toBe(false);
    // Pass 3 is the next guard's look at the stamp, pass 4 the re-read that refuses before any value is screened. A third
    // hash taken after pass 2 would have absorbed the change instead.
    expect(counts.snapshots).toBe(4);
    expect(counts.collects).toBe(2);
    expect(state.screens, "a screen callback ran after the observed change").toBe(state.screensAtMutation);
    expect(result.context, JSON.stringify(result)).toBe("");
    expect(result.coverage.work).toBe("unavailable");
  } finally { mock.restore(); }
});

test("a path a reader reports for the first time is bracketed before it is adopted", async () => {
  const fixture = await activated(), late = join(realPath(fixture.base), "reported-late.json");
  const state = { armed: false, screens: 0, screensAtMutation: -1, mutated: false };
  const { counts, sessionStartBrief: fenced } = await counted({ label: "grown",
    // The opening list predates the first pass; from then on every list carries one more path.
    onSnapshot: (index, paths) => {
      if (index === 1) state.armed = true;
      // The first pass that covers the new path must be followed by a comparison, not by a stamp: changing the path
      // while it is bracketed therefore refuses.
      if (!state.mutated && index > 1 && paths.includes(late)) { state.mutated = true; state.screensAtMutation = state.screens; writeFileSync(late, "{\"late\":1}\n", { mode: 0o600 }); }
    },
    grow: paths => (state.armed && !paths.includes(late) ? [...paths, late] : [...paths]) });
  try {
    const result = await fenced(briefOptions(fixture.base, fixture.project, undefined, () => { state.screens++; }));
    expect(state.armed, "the reader never reported the new path").toBe(true);
    expect(state.mutated, "no pass covered the new path, so nothing was bracketed").toBe(true);
    // The new path is hashed inside a pair, so the write lands between that pair and refuses; it is never stamped.
    expect(counts.hashed).toContain(late);
    expect(state.screens, "a screen callback ran after the new path moved").toBe(state.screensAtMutation);
    expect(result.context, JSON.stringify(result)).toBe("");
    expect(result.coverage.work).toBe("unavailable");
  } finally { mock.restore(); }
});

/**
 * The prune-view advance the maintenance writer produces, carrying a two-link chain on the user realm. The chain links
 * are written in the readers' own format rather than by `persistPublicPruneInput`, which keeps the previous hash for an
 * empty input and so cannot grow a chain to two links; the profile and shards bytes are the writer's own (`pruneInputSetHash`
 * and `selectorRevision` move, nothing else).
 */
function advancedPruneChain(home: string) {
  const profile = JSON.parse(readFileSync(join(home, "profile.json"), "utf8")) as { generation: string; pruneInputSetHash: string };
  const shards = JSON.parse(readFileSync(join(home, "shards.json"), "utf8")) as Record<string, unknown>;
  const view = readPublicPruneViewForActivation(home, profile.pruneInputSetHash, profile.generation);
  const folder = join(home, "user", "public-prune-input-sets");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const older = { schema: "agent-mem.public-prune-input-set/v1", receivingGeneration: profile.generation, previous: null, inputs: ["a".repeat(64)] },
    tip = { schema: "agent-mem.public-prune-input-set/v1", receivingGeneration: profile.generation, previous: hashJSON(older), inputs: ["a".repeat(64), "b".repeat(64)] };
  const olderHash = hashJSON(older), tipHash = hashJSON(tip);
  for (const [hash, set] of [[olderHash, older], [tipHash, tip]] as const) writeFileSync(join(folder, `${hash}.json`), canonicalJSON(set) + "\n", { mode: 0o600 });
  const next = validatePublicPruneView({ ...view, realms: { ...view.realms, user: tipHash } }), viewHash = publicPruneViewHash(next);
  writeFileSync(join(home, "public-prune-input-sets", `${viewHash}.json`), canonicalJSON(next) + "\n", { mode: 0o600 });
  const final = { ...profile, pruneInputSetHash: viewHash };
  writeFileSync(join(home, "profile.json"), canonicalJSON(final) + "\n", { mode: 0o600 });
  writeFileSync(join(home, "shards.json"), canonicalJSON({ ...shards, selectorRevision: hashJSON(final) }) + "\n", { mode: 0o600 });
  return { viewHash, tip: join(folder, `${tipHash}.json`), older: join(folder, `${olderHash}.json`), generation: profile.generation, chain: [tipHash, olderHash] };
}

test("an advanced prune chain on an activated home is in the fence's set, and a change on it refuses", async () => {
  const fixture = await activated(), home = realPath(fixture.base), links = advancedPruneChain(home);
  const selector = fenceSelector(home);
  expect(selector?.pruneInputSetHash).toBe(links.viewHash);
  // The guard's own comparison, observed at the file system: both links are opened, and neither is in the fixed list, so
  // only the readers' report can put them in the fence's set.
  const { opened } = await observe(() => comparison(home, fixture.project)());
  expect(opened).toContain(links.tip);
  expect(opened).toContain(links.older);
  const { paths: reported } = collectBindingReads(() => comparison(home, fixture.project)());
  const list = homeBindingPaths(home, selector, reported);
  for (const link of [links.tip, links.older]) { expect(list).toContain(link); expect(homeBindingPaths(home, selector)).not.toContain(link); }
  // The chain really has two links: the tip names the older one, and the guard's comparison opened both.
  expect((JSON.parse(readFileSync(links.tip, "utf8")) as { previous: string }).previous).toBe(links.chain[1]!);

  // The race is held through the guard: a byte-identical replacement of the older link lands in every adoption window,
  // and the full comparison accepts it, so a refusal here can only come from the fence covering that reported path.
  const compare = comparison(home, fixture.project), state = { screens: 0, screensAtMutation: -1, replacements: 0 };
  const { counts, sessionStartBrief: fenced } = await counted({ label: "chain", afterComparison: () => {
    if (state.screensAtMutation < 0) state.screensAtMutation = state.screens;
    const copy = `${links.older}.copy`;
    copyFileSync(links.older, copy); renameSync(copy, links.older); state.replacements++;
  } });
  try {
    const result = await fenced(briefOptions(home, fixture.project, undefined, () => { state.screens++; }));
    expect(() => compare()).not.toThrow();
    expect(counts.hashed).toContain(links.older);
    expect(counts.hashed).toContain(links.tip);
    expect(state.replacements).toBe(2);
    expect(state.screens, "a screen callback ran after the chain moved").toBe(state.screensAtMutation);
    expect(result.context, JSON.stringify(result)).toBe("");
    expect(result.coverage.work).toBe("unavailable");
  } finally { mock.restore(); }
});

// Last in this file: `mock.module` installs the hook for the rest of the process, so the hook below must not outlive a
// direct reader call in a later test.
test("a change held inside the adoption's comparison window refuses instead of reaching the screen", async () => {
  const fixture = await activated(), home = realPath(fixture.base), target = join(home, "shards.json");
  const compare = comparison(home, fixture.project);
  const state = { screens: 0, screensAtMutation: -1, replacements: 0 };
  const { counts, sessionStartBrief: fenced } = await counted({ label: "window", afterComparison: () => {
    // The change lands between the comparison and the adoption's second hash, on every pair this guard takes.
    if (state.screensAtMutation < 0) state.screensAtMutation = state.screens;
    const copy = join(home, "shards.copy");
    copyFileSync(target, copy); renameSync(copy, target); state.replacements++;
  } });
  try {
    const result = await fenced(briefOptions(home, fixture.project, undefined, () => { state.screens++; }));
    // Identical bytes, so the full comparison accepts this change: the refusal can only be the pair's own disagreement.
    expect(() => compare()).not.toThrow();
    expect(state.replacements, "the pair was never re-read, so nothing was proved").toBe(2);
    expect(counts.collects).toBe(2);
    expect(counts.snapshots).toBe(4);
    expect(state.screens, "a screen callback ran after the pair disagreed twice").toBe(state.screensAtMutation);
    expect(result.context, JSON.stringify(result)).toBe("");
    expect(result.coverage.work).toBe("unavailable");
  } finally { mock.restore(); }
});
