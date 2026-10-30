import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaptureStore } from "../src/memory/capture.ts";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { migrate } from "../src/memory/migrate.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { canonicalJSON, hashJSON, readSelector, writeProfileJSON } from "../src/memory/generation.ts";
import { applyPrune, planPrune, type PrunePlan, type PruneRow } from "../src/memory/prune.ts";
import { syncMemory, type SyncOptions } from "../src/memory/sync.ts";
import { PENDING_SELECTOR_LIMIT, syncShardedMemory } from "../src/memory/shard-sync.ts";
import { appendAlias, shardDir } from "../src/memory/shard.ts";
import { shardSyncRef } from "../src/memory/shard-sync-format.ts";
import { readPublicPruneView } from "../src/memory/public-prune-view.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";

const A = "example.test/prune/alpha", B = "example.test/prune/unopened", G1 = "1".repeat(32), G2 = "2".repeat(32), G3 = "3".repeat(32);
const privateRemote = { visibility: async () => "private" as const }, cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
function temp() { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-neutral-sync-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function git(dir: string, ...args: string[]): string {
  const result = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`synthetic private Git fixture failed: ${result.stderr}`);
  return result.stdout.trim();
}
function remote() { const dir = temp(); git(dir, "init", "-q", "--bare"); return dir; }
const note = (text: string): NoteInput => ({ op: "note", project: A, scope: "project", tier: "long", kind: "finding", peer: "fixture", source: "person", text, about: [] });
async function side(generation: string, v2 = true, legacyText?: string) {
  const home = temp(), clock = { now: Date.parse("2026-10-01T00:00:00.000Z") }, legacy = new MemoryStore({ home, profile: "shared-v1", deferPromotions: true, now: () => clock.now, ttlMs: 1000 });
  const legacyId = legacyText === undefined ? undefined : legacy.note(note(legacyText)), memory = legacy.dir; legacy.close();
  await migrateShards({ memoryDir: memory, generation, mode: "apply", authorizedPerson: true, tty: true });
  const open = () => openShardStore({ home, project: A, deferPromotions: true, now: () => clock.now, ttlMs: 1000 });
  let a = open(), closed = false;
  const close = () => { if (!closed) { a.close(); closed = true; } };
  const enable = async () => { close(); await activatePublicPruneView({ memoryDir: memory, mode: "apply", authorizedPerson: true, tty: true }); a = open(); closed = false; };
  if (v2) await enable(); cleanup.push(close);
  return { home, memory, clock, generation, legacyId, get a() { return a; }, enable, close };
}
function prune(store: MemoryStore, target: string, clock: { now: number }, publicly = true, project = A): PruneRow {
  expect(store.demote(target, "person", project)).toBeDefined(); clock.now += 2000;
  const authorization = { project, actor: "person" as const, authorize: () => true,
    ...(publicly ? { policy: { revision: () => "public-fixture-v1", classify: () => "public" as const, attest: () => true } } : {}) };
  const plan = planPrune(store.prunePort(), { cutoff: new Date(clock.now).toISOString(), targets: [target] }, authorization);
  expect(plan.rows).toHaveLength(1); expect(plan.rows[0]!.placement).toBe(publicly ? "synced" : "local");
  const row = plan.rows[0]!.payload; expect(applyPrune(store.prunePort(), plan, authorization).completed).toEqual([row.id]); return row;
}
function holds(memory: string): Record<string, string> {
  const root = join(memory, "shard-sync", "prune-holds"), result: Record<string, string> = {};
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.isFile()) result[file.slice(root.length)] = readFileSync(file, "utf8");
  } };
  if (existsSync(root)) walk(root); return result;
}
function history(url: string): { commit: string; file: string; text: string }[] {
  const result: { commit: string; file: string; text: string }[] = [];
  for (const commit of git(url, "rev-list", "--all").split("\n").filter(Boolean)) for (const file of git(url, "ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean)) result.push({ commit, file, text: git(url, "show", `${commit}:${file}`) });
  return result;
}
function selectorHistoryPaths(memory: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) {
    const next = join(dir, entry.name); if (entry.name === "selector-history" || entry.name === "public-prune-selector-history") result.push(next.slice(memory.length)); visit(next);
  } };
  visit(memory); return result.sort();
}
function assertForeign(store: MemoryStore, target: string, row: PruneRow) {
  const snapshot = store.prunePort().snapshot();
  expect(snapshot.pruned).toContain(target); expect(snapshot.durablePruneIds).not.toContain(row.id);
  expect(store.get(target, A)).toBeUndefined(); expect(store.list({ project: A, includeSuperseded: true }).map(view => view.id)).not.toContain(target);
  expect(store.search("PUBLIC", { project: A, includeCapture: false }).hits.map(hit => hit.view?.id)).not.toContain(target);
  const before = canonicalJSON(snapshot); store.rebuild(); expect(canonicalJSON(store.prunePort().snapshot())).toBe(before);
}

test("R01 independently initialized v2 homes apply original public prune identity and replay without native re-authoring", async () => {
  const url = remote(), source = await side(G1), receiver = await side(G2), target = source.a.note(note("PUBLIC_FORWARD_TARGET"));
  source.a.note({ ...note("LOCAL_ONLY_SYNC_CANARY"), tier: "short" });
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true }); // Publisher boundary precedes the prune.
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true }); expect(receiver.a.get(target, A)?.id).toBe(target);
  const authored = source.a.prunePort().snapshot().rows.find(item => item.row.id === target)!.row, row = prune(source.a, target, source.clock);
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true, pruneApplication: { phase: "complete", held: 0 } });
  const response = await syncMemory(receiver.a, { remote: url, ...privateRemote });
  expect(response).toMatchObject({ ok: true, pruneApplication: { transport: "durable", phase: "complete", projectionActive: 1, held: 0 } });
  assertForeign(receiver.a, target, row);
  expect(canonicalJSON(receiver.a.prunePort().snapshot().rows.find(item => item.row.id === target)!.row)).toBe(canonicalJSON(authored));
  const selector = readSelector(receiver.memory), raw = canonicalJSON(receiver.a.prunePort().snapshot());
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true, pruneApplication: { phase: "complete", projectionActive: 1, held: 0 } });
  expect(readSelector(receiver.memory)).toEqual(selector); expect(canonicalJSON(receiver.a.prunePort().snapshot())).toBe(raw);
  const wire = history(url), manifests = wire.filter(item => item.file.startsWith("prune-witnesses/")).map(item => JSON.parse(item.text));
  expect(manifests.some(manifest => canonicalJSON(manifest.prune) === canonicalJSON(row) && manifest.prune.generation === G1)).toBe(true);
  for (const item of wire) { expect(item.file).not.toMatch(/(?:^|\/)(?:local|machine|work|capture)(?:\/|$)/); expect(item.text).not.toContain("LOCAL_ONLY_SYNC_CANARY"); }
  expect(existsSync(shardDir(receiver.memory, B))).toBe(false);
  expect(selectorHistoryPaths(source.memory)).toEqual([]); expect(selectorHistoryPaths(receiver.memory)).toEqual([]);
}, 60_000);

test("R02 reverse publication and a third generation retain both independent original prune identities", async () => {
  const url = remote(), one = await side(G1), two = await side(G2), target1 = one.a.note(note("PUBLIC_G1_TARGET"));
  expect((await syncMemory(one.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const row1 = prune(one.a, target1, one.clock); expect((await syncMemory(one.a, { remote: url, ...privateRemote })).ok).toBe(true);
  expect((await syncMemory(two.a, { remote: url, ...privateRemote })).ok).toBe(true); assertForeign(two.a, target1, row1);
  const target2 = two.a.note(note("PUBLIC_G2_TARGET")), row2 = prune(two.a, target2, two.clock);
  expect((await syncMemory(two.a, { remote: url, ...privateRemote })).ok).toBe(true);
  expect((await syncMemory(one.a, { remote: url, ...privateRemote })).ok).toBe(true); assertForeign(one.a, target2, row2);
  const third = await side(G3); expect(await syncMemory(third.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true, pruneApplication: { projectionActive: 2, held: 0 } });
  assertForeign(third.a, target1, row1); assertForeign(third.a, target2, row2);
  expect(third.a.prunePort().snapshot().durablePruneIds).not.toContain(row1.id); expect(third.a.prunePort().snapshot().durablePruneIds).not.toContain(row2.id);
}, 60_000);

test("R03 verified immutable legacy-main ordinary bytes support a newly authored post-boundary prune", async () => {
  const url = remote(), home = temp(), clock = { now: Date.parse("2026-10-01T00:00:00.000Z") };
  const legacy = new MemoryStore({ home, profile: "shared-v1", deferPromotions: true, now: () => clock.now, ttlMs: 1000 }); let closed = false;
  cleanup.push(() => { if (!closed) legacy.close(); });
  const target = legacy.note(note("PUBLIC_IMMUTABLE_LEGACY_TARGET")), memory = legacy.dir, file = join(memory, "log", legacy.machine.id + ".jsonl");
  const originalBytes = readFileSync(file, "utf8"), original = originalBytes.trimEnd().split("\n").map(line => JSON.parse(line)).find(row => row.id === target);
  expect(await syncMemory(legacy, { remote: url, ...privateRemote })).toMatchObject({ ok: true, pushed: true });
  legacy.close(); closed = true;
  await migrate({ memoryDir: memory, generation: G1, mode: "apply", authorizedPerson: true, tty: true });
  const generation = new MemoryStore({ memoryDir: memory, profile: { generation: G1 }, deferPromotions: true, now: () => clock.now, ttlMs: 1000 });
  try {
    // Existing generation sync establishes the verified legacy-main occurrence; no asserted witness bit.
    expect((await syncMemory(generation, { remote: url, ...privateRemote })).ok).toBe(true);
    expect(generation.prunePort().snapshot().rows.find(item => item.row.id === target)).toMatchObject({ placement: "synced", publicWitness: true });
  } finally { generation.close(); }
  await migrateShards({ memoryDir: memory, generation: G1, mode: "apply", authorizedPerson: true, tty: true });
  const sealed = openShardStore({ home, project: A, deferPromotions: true, now: () => clock.now, ttlMs: 1000 });
  try { expect(sealed.prunePort().snapshot().rows.find(item => item.row.id === target)).toMatchObject({ publicWitness: true, legacy: true }); }
  finally { sealed.close(); }
  await activatePublicPruneView({ memoryDir: memory, mode: "apply", authorizedPerson: true, tty: true });
  const source = openShardStore({ home, project: A, deferPromotions: true, now: () => clock.now, ttlMs: 1000 }); cleanup.push(() => source.close());
  expect((await syncMemory(source, { remote: url, ...privateRemote })).ok).toBe(true); // Prime the conservative own-log boundary first.
  const row = prune(source, target, clock); expect((await syncMemory(source, { remote: url, ...privateRemote })).ok).toBe(true);
  const receiver = await side(G2); expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true, pruneApplication: { projectionActive: 1, held: 0 } });
  assertForeign(receiver.a, target, row);
  expect(canonicalJSON(receiver.a.prunePort().snapshot().rows.find(item => item.row.id === target)!.row)).toBe(canonicalJSON(original));
  expect(readFileSync(file, "utf8")).toBe(originalBytes);
}, 60_000);

test("R19 a local v1 floor refuses a v2 remote tip before any ordinary import or public update", async () => {
  const url = remote(), source = await side(G1), target = source.a.note(note("PUBLIC_NEW_FLOOR_TARGET"));
  expect((await syncMemory(source.a, { remote: url, ...privateRemote })).ok).toBe(true);
  prune(source.a, target, source.clock); expect((await syncMemory(source.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const receiver = await side(G2, false), before = canonicalJSON(receiver.a.prunePort().snapshot()), refs = git(url, "for-each-ref", "--format=%(refname) %(objectname)");
  const result = await syncMemory(receiver.a, { remote: url, ...privateRemote });
  expect(result).toMatchObject({ ok: false, pushed: false }); expect(result.error).toMatch(/v2|public prune/);
  expect(canonicalJSON(receiver.a.prunePort().snapshot())).toBe(before); expect(receiver.a.get(target, A)).toBeUndefined();
  expect(git(url, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs); expect(Object.keys(holds(receiver.memory))).toHaveLength(0);
}, 60_000);

for (const phase of ["published", "inputs-installed", "view-committed", "imported"] as const) test(`R16 v2 ${phase} interruption retries exact input membership before ordinary import`, async () => {
  const url = remote(), source = await side(G1), target = source.a.note(note("PUBLIC_FAULT_TARGET"));
  expect((await syncMemory(source.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const row = prune(source.a, target, source.clock); expect((await syncMemory(source.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const receiver = await side(G2), previous = readSelector(receiver.memory).revision; let interrupted = false;
  const result = await syncShardedMemory(receiver.a, { remote: url, ...privateRemote }, undefined, current => {
    if (current === phase && !interrupted) { interrupted = true; throw new Error("NEUTRAL-INPUT-FAULT"); }
  });
  expect(interrupted, JSON.stringify(result)).toBe(true); expect(result).toMatchObject({ ok: false, pushed: true });
  if (phase === "published" || phase === "inputs-installed") {
    expect(readSelector(receiver.memory).revision).toBe(previous);
    expect(receiver.a.prunePort().snapshot().rows.some(item => item.row.id === target)).toBe(false);
  } else expect(receiver.a.prunePort().snapshot().pruned).toContain(target);
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true, pruneApplication: { phase: "complete", projectionActive: 1, held: 0 } });
  assertForeign(receiver.a, target, row); const committed = readSelector(receiver.memory);
  expect((await syncMemory(receiver.a, { remote: url, ...privateRemote })).ok).toBe(true); expect(readSelector(receiver.memory)).toEqual(committed);
}, 60_000);

test("R04/R13 old foreign holds and pre-boundary prunes never become neutral application authority", async () => {
  const url = remote(), source = await side(G1, false), receiver = await side(G2, false), target = source.a.note(note("PUBLIC_UNSUPPORTED_OLD_TARGET"));
  const row = prune(source.a, target, source.clock); // Intentionally predates the first v2 publisher boundary.
  expect((await syncMemory(source.a, { remote: url, ...privateRemote })).ok).toBe(true);
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const before = holds(receiver.memory); expect(Object.keys(before)).toHaveLength(1);
  const ref = shardSyncRef({ scope: "project", key: A }), expected = `/${sha(url)}/${sha(ref)}/${G2}/${G1}/${row.id}-${hashJSON(row)}.json`;
  expect(before[expected]).toBeDefined(); expect(receiver.a.prunePort().snapshot().pruned).not.toContain(target);
  await source.enable(); await receiver.enable();
  expect((await syncMemory(source.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const response = await syncMemory(receiver.a, { remote: url, ...privateRemote });
  expect(response).toMatchObject({ ok: true, pruneApplication: { phase: "complete", projectionActive: 0, held: 1 } });
  expect(response.warning).toContain("held, not applied"); expect(holds(receiver.memory)).toEqual(before);
  expect(receiver.a.prunePort().snapshot().pruned).not.toContain(target); expect(receiver.a.get(target, A)?.id).toBe(target);
  const selected = readSelector(receiver.memory).selector;
  expect(selected?.schema).toBe("agent-mem.profile/v2");
  if (selected?.schema === "agent-mem.profile/v2") expect(readPublicPruneView(receiver.memory, selected.pruneInputSetHash, G2).realms[`project:${A}`]).toBeUndefined();
}, 60_000);

test("R04 a locally pruned unwitnessed legacy body is never first-published by v2 sync", async () => {
  const marker = "LOCAL_ONLY_LEGACY_PRUNED_CANARY", source = await side(G1, false, marker), target = source.legacyId!;
  expect(source.a.prunePort().snapshot().rows.find(item => item.row.id === target)?.publicWitness).toBe(false);
  prune(source.a, target, source.clock, false); await source.enable(); const url = remote();
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  for (const item of history(url)) expect(item.text).not.toContain(marker);
}, 60_000);

for (const change of ["policy", "alias"] as const) test(`R12 ${change} drift across remote visibility await refuses before publication/import`, async () => {
  const url = remote(), source = await side(G1), target = source.a.note(note("PUBLIC_MUST_NOT_PUBLISH_ON_DRIFT")), before = git(url, "for-each-ref", "--format=%(refname) %(objectname)");
  let version = "before", changed = false;
  const options: SyncOptions = { remote: url, policyVersion: () => version, visibility: async () => {
    await Promise.resolve();
    if (!changed) { changed = true; if (change === "policy") version = "after"; else appendAlias(source.memory, { alias: B, key: A, actor: "person", machine: source.a.machine.id }); }
    return "private";
  } };
  expect(await syncMemory(source.a, options)).toMatchObject({ ok: false, pushed: false }); expect(changed).toBe(true);
  expect(git(url, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(before);
  expect(source.a.get(target, A)?.id).toBe(target); expect(Object.keys(holds(source.memory))).toHaveLength(0);
}, 60_000);

async function partialNativeForeign() {
  const url = remote(), sibling = await side(G2), receiver = await side(G2), nativeTarget = sibling.a.note(note("PUBLIC_NATIVE_PENDING_TARGET"));
  expect((await syncMemory(sibling.a, { remote: url, ...privateRemote })).ok).toBe(true);
  expect((await syncMemory(receiver.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const nativeRow = prune(sibling.a, nativeTarget, sibling.clock);
  expect((await syncMemory(sibling.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const originalPort = receiver.a.prunePort.bind(receiver.a), nativeLine = canonicalJSON(nativeRow) + "\n";
  const segment = join(receiver.a.dir, "log", nativeRow.machine + ".jsonl"), claim = join(receiver.a.dir, "prune-plans", "pending-log-" + nativeRow.machine + ".json");
  let originalPlan: PrunePlan | undefined, prefix: Buffer | undefined;
  receiver.a.prunePort = () => {
    const port = originalPort();
    return { ...port, appendPrune: (payload, line, seal) => {
      if (payload.id !== nativeRow.id) return port.appendPrune(payload, line, seal);
      originalPlan = JSON.parse(readFileSync(join(receiver.a.dir, "prune-plans", seal + ".json"), "utf8")) as PrunePlan;
      const fd = openSync(segment, "a"); try { fsyncSync(fd); } finally { closeSync(fd); }
      prefix = readFileSync(segment);
      writeProfileJSON(claim, { schema: "agent-mem.prune-append/v1", seal, rowId: payload.id, lineHash: sha(line), offset: prefix.length, prefixHash: sha(prefix) });
      appendFileSync(segment, Buffer.from(line).subarray(0, 23));
      const partial = openSync(segment, "a"); try { fsyncSync(partial); } finally { closeSync(partial); }
      throw new Error("PARTIAL-NATIVE-TRANSPORT-FAULT");
    } };
  };
  try { expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: true }); }
  finally { receiver.a.prunePort = originalPort; }
  expect(originalPlan).toBeDefined(); expect(prefix).toBeDefined(); expect(nativeRow.machine).not.toBe(receiver.a.machine.id);
  const plan = originalPlan!, planFile = join(receiver.a.dir, "prune-plans", plan.seal + ".json"), planBytes = readFileSync(planFile), claimBytes = readFileSync(claim), partialBytes = readFileSync(segment);
  expect(readSelector(receiver.memory).revision).toBe(plan.selectorRevision);

  const foreign = await side(G1);
  expect((await syncMemory(foreign.a, { remote: url, ...privateRemote })).ok).toBe(true); // Prime its own boundary while importing the sibling's foreign proof.
  const foreignTarget = foreign.a.note(note("PUBLIC_FOREIGN_DURING_NATIVE_PENDING")), foreignRow = prune(foreign.a, foreignTarget, foreign.clock);
  expect((await syncMemory(foreign.a, { remote: url, ...privateRemote })).ok).toBe(true);
  let interrupted = false;
  const result = await syncShardedMemory(receiver.a, { remote: url, ...privateRemote }, undefined, phase => {
    if (phase === "view-committed") { interrupted = true; throw new Error("FOREIGN-VIEW-COMMITTED-FAULT"); }
  });
  expect(interrupted, JSON.stringify(result)).toBe(true); expect(result).toMatchObject({ ok: false, pushed: true });
  expect(readSelector(receiver.memory).revision).not.toBe(plan.selectorRevision);
  expect(readFileSync(planFile)).toEqual(planBytes); expect(readFileSync(claim)).toEqual(claimBytes); expect(readFileSync(segment)).toEqual(partialBytes);
  const historyFile = join(receiver.a.dir, "prune-plans", "selector-history", plan.seal + ".json");
  expect(hashJSON(JSON.parse(readFileSync(historyFile, "utf8")))).toBe(plan.selectorRevision);
  expect(existsSync(join(receiver.memory, "public-prune-selector-history"))).toBe(false);
  expect(receiver.a.prunePort().snapshot().pruned).toContain(foreignTarget);
  return { url, receiver, nativeTarget, nativeRow, foreignTarget, foreignRow, plan, planFile, planBytes, claim, claimBytes, segment,
    partialBytes, prefix: prefix!, nativeLine, historyFile, historyBytes: readFileSync(historyFile) };
}

test("R16 an old partial native transport plan resumes unchanged after a simultaneous foreign view advance", async () => {
  const { url, receiver, nativeTarget, nativeRow, foreignTarget, foreignRow, planFile, planBytes, claim, segment, prefix, nativeLine, historyFile } = await partialNativeForeign();
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true, pruneApplication: { phase: "complete", projectionActive: 1, held: 0 } });
  expect(existsSync(claim)).toBe(false); expect(existsSync(historyFile)).toBe(false); expect(readFileSync(planFile)).toEqual(planBytes);
  expect(readFileSync(segment)).toEqual(Buffer.concat([prefix, Buffer.from(nativeLine)]));
  const snapshot = receiver.a.prunePort().snapshot();
  expect(snapshot.durablePruneIds?.filter(id => id === nativeRow.id)).toHaveLength(1); expect(snapshot.durablePruneIds).not.toContain(foreignRow.id);
  expect(snapshot.pruned).toEqual(expect.arrayContaining([nativeTarget, foreignTarget]));
  assertForeign(receiver.a, foreignTarget, foreignRow);
}, 60_000);

for (const damage of ["missing", "altered"] as const) test(`R16 ${damage} needed selector copy refuses exact-plan recovery before publication or append`, async () => {
  const f = await partialNativeForeign(), tips = git(f.url, "for-each-ref", "--format=%(refname) %(objectname)");
  if (damage === "missing") rmSync(f.historyFile);
  else writeFileSync(f.historyFile, canonicalJSON({ ...JSON.parse(f.historyBytes.toString()), pruneInputSetHash: "f".repeat(64) }) + "\n");
  const record = existsSync(f.historyFile) ? readFileSync(f.historyFile) : undefined;
  const result = await syncMemory(f.receiver.a, { remote: f.url, ...privateRemote });
  expect(result).toMatchObject({ ok: false, pushed: false }); expect(result.error).toContain("pending prune");
  expect(git(f.url, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(tips);
  expect(readFileSync(f.planFile)).toEqual(f.planBytes); expect(readFileSync(f.claim)).toEqual(f.claimBytes); expect(readFileSync(f.segment)).toEqual(f.partialBytes);
  expect(existsSync(f.historyFile)).toBe(damage !== "missing"); if (record) expect(readFileSync(f.historyFile)).toEqual(record);
  expect(f.receiver.a.prunePort().snapshot().pruned).toContain(f.foreignTarget);
}, 60_000);

test("R21 65 retained selector copies refuse as a resource bound before cleanup, push or append", async () => {
  const f = await partialNativeForeign(), folder = join(f.receiver.a.dir, "prune-plans", "selector-history");
  expect(PENDING_SELECTOR_LIMIT).toBe(64);
  for (let n = 0; n < PENDING_SELECTOR_LIMIT; n++) writeFileSync(join(folder, sha("synthetic orphan plan seal " + n) + ".json"), f.historyBytes, { mode: 0o600 });
  const inventory = Object.fromEntries(readdirSync(folder).sort().map(name => [name, readFileSync(join(folder, name)).toString("base64")]));
  expect(Object.keys(inventory)).toHaveLength(PENDING_SELECTOR_LIMIT + 1);
  const tips = git(f.url, "for-each-ref", "--format=%(refname) %(objectname)"), result = await syncMemory(f.receiver.a, { remote: f.url, ...privateRemote });
  expect(result).toMatchObject({ ok: false, pushed: false }); expect(result.error).toMatch(/resource/i);
  expect(Object.fromEntries(readdirSync(folder).sort().map(name => [name, readFileSync(join(folder, name)).toString("base64")]))).toEqual(inventory);
  expect(readFileSync(f.historyFile)).toEqual(f.historyBytes); expect(readFileSync(f.planFile)).toEqual(f.planBytes);
  expect(readFileSync(f.claim)).toEqual(f.claimBytes); expect(readFileSync(f.segment)).toEqual(f.partialBytes);
  expect(git(f.url, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(tips);
}, 60_000);

test("R16 a post-completion crash leaves a non-authoritative orphan cleaned only by the next fenced reproof", async () => {
  const f = await partialNativeForeign(), original = f.receiver.a.prunePort.bind(f.receiver.a); let interrupted = false;
  f.receiver.a.prunePort = () => {
    const port = original(); return { ...port, appendPrune: (row, line, seal) => {
      const result = port.appendPrune(row, line, seal);
      if (row.id === f.nativeRow.id && !interrupted) { interrupted = true; throw new Error("AFTER-NATIVE-DURABILITY-BEFORE-SELECTOR-CLEANUP"); }
      return result;
    } };
  };
  try { expect(await syncMemory(f.receiver.a, { remote: f.url, ...privateRemote })).toMatchObject({ ok: false, pushed: true }); }
  finally { f.receiver.a.prunePort = original; }
  expect(interrupted).toBe(true); expect(existsSync(f.claim)).toBe(false); expect(readFileSync(f.historyFile)).toEqual(f.historyBytes);
  expect(f.receiver.a.prunePort().snapshot().durablePruneIds?.filter(id => id === f.nativeRow.id)).toHaveLength(1);
  expect(await syncMemory(f.receiver.a, { remote: f.url, ...privateRemote })).toMatchObject({ ok: true });
  expect(existsSync(f.historyFile)).toBe(false); expect(readFileSync(f.planFile)).toEqual(f.planBytes);
  expect(readFileSync(f.segment)).toEqual(Buffer.concat([f.prefix, Buffer.from(f.nativeLine)]));
  assertForeign(f.receiver.a, f.foreignTarget, f.foreignRow);
}, 60_000);

async function appliedForeign() {
  const url = remote(), source = await side(G1), target = source.a.note(note("PUBLIC_RETAINED_PROOF_TARGET"));
  expect((await syncMemory(source.a, {remote:url,...privateRemote})).ok).toBe(true);
  const row = prune(source.a,target,source.clock);
  expect((await syncMemory(source.a,{remote:url,...privateRemote})).ok).toBe(true);
  const receiver=await side(G2);
  expect((await syncMemory(receiver.a,{remote:url,...privateRemote})).ok).toBe(true);
  assertForeign(receiver.a,target,row);return{url,source,receiver,target,row};
}
for (const missing of ["map","set","input","object"] as const) test(`R15 v2 sync-committed ${missing} loss stays unavailable after SQLite deletion`,async()=>{
  const f=await appliedForeign(), selected=readSelector(f.receiver.memory).selector!;
  if(selected.schema!=="agent-mem.profile/v2")throw new Error("fixture floor");
  const mapFile=join(f.receiver.memory,"public-prune-input-sets",selected.pruneInputSetHash+".json"),view=JSON.parse(readFileSync(mapFile,"utf8"));
  const dir=f.receiver.a.dir,setFile=join(dir,"public-prune-input-sets",view.realms[`project:${A}`]+".json"),set=JSON.parse(readFileSync(setFile,"utf8"));
  const file=missing==="map"?mapFile:missing==="set"?setFile:missing==="input"?join(dir,"public-prune-inputs",set.inputs[0]+".json"):join(dir,"public-prune-objects",readdirSync(join(dir,"public-prune-objects")).find(name=>name.endsWith(".git"))!);
  f.receiver.close();rmSync(file);
  for(const base of ["index.db","index-v2.db"])for(const suffix of ["","-wal","-shm"])rmSync(join(dir,base+suffix),{force:true});
  expect(()=>{const reader=openShardStore({memoryDir:f.receiver.memory,project:A,now:()=>f.receiver.clock.now});try{reader.rebuild();reader.list({project:A});}finally{reader.close();}}).toThrow();
},60_000);

test("R18 replacement remote missing a registered manifest's original commit refuses even after cache loss",async()=>{
  const f=await appliedForeign(),ref=shardSyncRef({scope:"project",key:A}),revision=readSelector(f.receiver.memory).revision;
  const replacement=git(f.url,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit-tree",git(f.url,"rev-parse",ref+"^{tree}"),"-m","replacement root without original history");
  git(f.url,"update-ref",ref,replacement);rmSync(join(f.receiver.memory,"shard-sync","objects.git"),{recursive:true,force:true});
  const tips=git(f.url,"for-each-ref","--format=%(refname) %(objectname)");
  expect(await syncMemory(f.receiver.a,{remote:f.url,...privateRemote})).toMatchObject({ok:false,pushed:false});
  expect(git(f.url,"for-each-ref","--format=%(refname) %(objectname)")).toBe(tips);expect(readSelector(f.receiver.memory).revision).toBe(revision);
  assertForeign(f.receiver.a,f.target,f.row);
},60_000);

test("R20/R21 active proof replay and capture stay offline without the transport cache",async()=>{
  const f=await appliedForeign();rmSync(join(f.receiver.memory,"shard-sync","objects.git"),{recursive:true,force:true});
  const network=spyOn(globalThis,"fetch").mockRejectedValue(new Error("unexpected network")),spawn=spyOn(Bun,"spawn").mockImplementation(()=>{throw new Error("unexpected resident helper");});
  try{
    assertForeign(f.receiver.a,f.target,f.row);
    const capture=new CaptureStore({home:f.receiver.home,project:A});
    try{capture.append({project:A,agent:"fixture",event:"PostToolUse",excerpt:"offline capture proof"});expect(capture.stats().rows).toBe(1);}finally{capture.close();}
    expect(network).not.toHaveBeenCalled();expect(spawn).not.toHaveBeenCalled();
  }finally{network.mockRestore();spawn.mockRestore();}
},60_000);

test("R16 a durable selector copy journals the exact transport plan before any native claim or log write", async () => {
  const url = remote(), sibling = await side(G2), receiver = await side(G2), nativeTarget = sibling.a.note(note("PUBLIC_UNCLAIMED_NATIVE_TARGET"));
  expect((await syncMemory(sibling.a, { remote: url, ...privateRemote })).ok).toBe(true);
  expect((await syncMemory(receiver.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const row = prune(sibling.a, nativeTarget, sibling.clock); expect((await syncMemory(sibling.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const original = receiver.a.prunePort.bind(receiver.a), segment = join(receiver.a.dir, "log", row.machine + ".jsonl"), claim = join(receiver.a.dir, "prune-plans", "pending-log-" + row.machine + ".json");
  const previous = existsSync(segment) ? readFileSync(segment) : undefined; let captured: PrunePlan | undefined;
  receiver.a.prunePort = () => { const port = original(); return { ...port, appendPrune: (payload, line, seal) => {
    if (payload.id !== row.id) return port.appendPrune(payload, line, seal);
    captured = JSON.parse(readFileSync(join(receiver.a.dir, "prune-plans", seal + ".json"), "utf8")) as PrunePlan;
    expect(existsSync(join(receiver.a.dir, "prune-plans", "selector-history", seal + ".json"))).toBe(true);
    throw new Error("PINNED-BEFORE-NATIVE-CLAIM-FAULT");
  } }; };
  try { expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: true }); }
  finally { receiver.a.prunePort = original; }
  expect(captured).toBeDefined(); expect(existsSync(claim)).toBe(false); expect(existsSync(segment)).toBe(previous !== undefined);
  if (previous) expect(readFileSync(segment)).toEqual(previous);
  const plan = captured!, planFile = join(receiver.a.dir, "prune-plans", plan.seal + ".json"), copy = join(receiver.a.dir, "prune-plans", "selector-history", plan.seal + ".json");
  const planBytes = readFileSync(planFile), copyBytes = readFileSync(copy);
  expect(hashJSON(JSON.parse(copyBytes.toString()))).toBe(plan.selectorRevision);
  const foreign = await side(G1); expect((await syncMemory(foreign.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const foreignTarget = foreign.a.note(note("PUBLIC_FOREIGN_WITH_UNCLAIMED_NATIVE")), foreignRow = prune(foreign.a, foreignTarget, foreign.clock);
  expect((await syncMemory(foreign.a, { remote: url, ...privateRemote })).ok).toBe(true); let advanced = false;
  expect(await syncShardedMemory(receiver.a, { remote: url, ...privateRemote }, undefined, phase => {
    if (phase === "view-committed") { advanced = true; throw new Error("UNCLAIMED-PLAN-VIEW-ADVANCE-FAULT"); }
  })).toMatchObject({ ok: false, pushed: true });
  expect(advanced).toBe(true); expect(readSelector(receiver.memory).revision).not.toBe(plan.selectorRevision);
  expect(existsSync(claim)).toBe(false); expect(readFileSync(planFile)).toEqual(planBytes); expect(readFileSync(copy)).toEqual(copyBytes);
  expect(receiver.a.prunePort().snapshot().pruned).toContain(foreignTarget);
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(existsSync(copy)).toBe(false); expect(readFileSync(planFile)).toEqual(planBytes);
  expect(readFileSync(segment)).toEqual(Buffer.concat([previous ?? Buffer.alloc(0), Buffer.from(canonicalJSON(row) + "\n")]));
  expect(receiver.a.prunePort().snapshot().durablePruneIds?.filter(id => id === row.id)).toHaveLength(1);
  assertForeign(receiver.a, foreignTarget, foreignRow);
}, 60_000);

test("R16 an unopened B native partial plan survives a separate A foreign map advance in the same home", async () => {
  const url = remote(), sibling = await side(G2), receiver = await side(G2);
  const publisherB = openShardStore({ home: sibling.home, project: B, deferPromotions: true, now: () => sibling.clock.now, ttlMs: 1000 }); cleanup.push(() => publisherB.close());
  const targetB = publisherB.note({ ...note("PUBLIC_B_PARTIAL_NATIVE_TARGET"), project: B });
  expect((await syncMemory(publisherB, { remote: url, ...privateRemote })).ok).toBe(true);
  let readerB: MemoryStore | undefined = openShardStore({ home: receiver.home, project: B, deferPromotions: true, now: () => receiver.clock.now, ttlMs: 1000 });
  cleanup.push(() => readerB?.close()); const selectedB = readerB;
  expect((await syncMemory(selectedB, { remote: url, ...privateRemote })).ok).toBe(true);
  const row = prune(publisherB, targetB, sibling.clock, true, B);
  expect((await syncMemory(publisherB, { remote: url, ...privateRemote })).ok).toBe(true);
  const original = selectedB.prunePort.bind(selectedB), segment = join(selectedB.dir, "log", row.machine + ".jsonl"), claim = join(selectedB.dir, "prune-plans", "pending-log-" + row.machine + ".json");
  let captured: PrunePlan | undefined, prefix: Buffer | undefined;
  selectedB.prunePort = () => { const port = original(); return { ...port, appendPrune: (payload, line, seal) => {
    if (payload.id !== row.id) return port.appendPrune(payload, line, seal);
    captured = JSON.parse(readFileSync(join(selectedB.dir, "prune-plans", seal + ".json"), "utf8")) as PrunePlan;
    expect(existsSync(join(selectedB.dir, "prune-plans", "selector-history", seal + ".json"))).toBe(true);
    const fd = openSync(segment, "a"); try { fsyncSync(fd); } finally { closeSync(fd); }
    prefix = readFileSync(segment); writeProfileJSON(claim, { schema: "agent-mem.prune-append/v1", seal, rowId: payload.id, lineHash: sha(line), offset: prefix.length, prefixHash: sha(prefix) });
    appendFileSync(segment, Buffer.from(line).subarray(0, 23)); const partial = openSync(segment, "a"); try { fsyncSync(partial); } finally { closeSync(partial); }
    throw new Error("B-PARTIAL-NATIVE-FAULT");
  } }; };
  try { expect(await syncMemory(selectedB, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: true }); }
  finally { selectedB.prunePort = original; }
  expect(captured).toBeDefined(); expect(prefix).toBeDefined();
  const plan = captured!, planFile = join(selectedB.dir, "prune-plans", plan.seal + ".json"), copy = join(selectedB.dir, "prune-plans", "selector-history", plan.seal + ".json");
  const planBytes = readFileSync(planFile), copyBytes = readFileSync(copy), claimBytes = readFileSync(claim), partialBytes = readFileSync(segment);
  selectedB.close(); readerB = undefined; // A's next sync must not open or rewrite B to retain its pending authority.
  const foreign = await side(G1), targetA = foreign.a.note(note("PUBLIC_A_ADVANCES_WHILE_B_UNOPENED"));
  expect((await syncMemory(foreign.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const foreignRow = prune(foreign.a, targetA, foreign.clock); expect((await syncMemory(foreign.a, { remote: url, ...privateRemote })).ok).toBe(true);
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(readSelector(receiver.memory).revision).not.toBe(plan.selectorRevision); expect(readFileSync(copy)).toEqual(copyBytes);
  expect(readFileSync(planFile)).toEqual(planBytes); expect(readFileSync(claim)).toEqual(claimBytes); expect(readFileSync(segment)).toEqual(partialBytes);
  assertForeign(receiver.a, targetA, foreignRow);
  readerB = openShardStore({ home: receiver.home, project: B, deferPromotions: true, now: () => receiver.clock.now, ttlMs: 1000 });
  expect(await syncMemory(readerB, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(existsSync(copy)).toBe(false); expect(existsSync(claim)).toBe(false); expect(readFileSync(planFile)).toEqual(planBytes);
  expect(readFileSync(segment)).toEqual(Buffer.concat([prefix!, Buffer.from(canonicalJSON(row) + "\n")]));
  expect(readerB.prunePort().snapshot().durablePruneIds?.filter(id => id === row.id)).toHaveLength(1); expect(readerB.get(targetB, B)).toBeUndefined();
  assertForeign(receiver.a, targetA, foreignRow);
}, 60_000);
