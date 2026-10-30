import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { advancePublicPruneView, type PublicPruneAdvanceStage } from "../src/memory/public-prune-advance.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { MemoryStore, openShardStore, buildPublicPruneIndex, type NoteInput } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { canonicalJSON, readSelector } from "../src/memory/generation.ts";
import { resolveShardProfile } from "../src/memory/shard.ts";
import { acquireMutation, type MutationHandle } from "../src/memory/mutation.ts";
import { persistPublicPruneInput, preparePublicPruneInput } from "../src/memory/public-prune-inputs.ts";
import { PUBLIC_PRUNE_INTENT, publicPruneViewHash, type PublicPruneViewV1 } from "../src/memory/public-prune-view.ts";
import { applyPrune, planPrune } from "../src/memory/prune.ts";
import { realPath } from "../src/memory/platform.ts";
import { publicPruneGraph } from "./fixtures/public-prune-graph.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const now = () => Date.parse("2026-10-01T12:00:00.000Z");
async function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-prune-advance-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const memoryDir = join(root, "memory"), graph = publicPruneGraph(), second = publicPruneGraph({ note: { at: "2026-10-01T01:00:00.000Z" } }), project = graph.note.project;
  const legacy = new MemoryStore({ home: root, now, screen: () => "keep" });
  for (const proof of [graph, second]) {
    const { id, at, machine, schema: _schema, ...input } = proof.note;
    legacy.importNote(input as NoteInput, at, { machine, expectedId: id });
  }
  legacy.close();
  await migrateShards({ memoryDir, generation: "7".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  const opts = { memoryDir, authorizedPerson: true, tty: true };
  await activatePublicPruneView({ ...opts, mode: "apply" });
  const profile = resolveShardProfile(memoryDir, { project }), key = `project:${project}`;
  const prepare = (proof = graph, previous: string | null = null) => {
    const binding = { realm: proof.manifest.realm, receivingGeneration: profile.generation!, selectorRevision: readSelector(memoryDir).revision, inputSetHash: previous };
    return persistPublicPruneInput(preparePublicPruneInput({ dir: profile.dir, binding, current: () => binding, input: proof.input }));
  };
  const view = (set?: string): PublicPruneViewV1 => ({ schema: "agent-mem.public-prune-view/v1", receivingGeneration: profile.generation!, realms: set ? { [key]: set } : {} });
  const markers = () => ({ profile: readFileSync(join(memoryDir, "profile.json"), "utf8"), shards: readFileSync(join(memoryDir, "shards.json"), "utf8") });
  const sources = () => {
    const result: Record<string, string> = {};
    for (const folder of ["log", "local", "legacy/log", "legacy/local", "legacy-main/log", "legacy-main/local"]) {
      const dir = join(profile.dir, folder); if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).sort()) if (name.endsWith(".jsonl")) result[folder + "/" + name] = readFileSync(join(dir, name), "utf8");
    }
    return result;
  };
  const advance = (next: PublicPruneViewV1, checkpoint?: (stage: PublicPruneAdvanceStage) => void | Promise<void>, mutations?: MutationHandle[]) =>
    advancePublicPruneView({ memoryDir, view: next, expectedRevision: readSelector(memoryDir).revision, checkpoint, mutations });
  return { root, memoryDir, opts, graph, second, project, profile, key, prepare, view, markers, sources, advance };
}
/** Exercise the real reader wait bound with a deterministic clock, without sleeping the test runner. */
function blocked(work: () => void): void {
  let clock = 0;
  const date = spyOn(Date, "now").mockImplementation(() => clock), sleep = spyOn(Bun, "sleepSync").mockImplementation(ms => { clock += Number(ms); });
  try { expect(work).toThrow(); } finally { date.mockRestore(); sleep.mockRestore(); }
}

for (const stage of ["after-intent", "after-shards", "after-profile", "after-remove"] as const) test(`advance ${stage} fault resumes forward through the person activation API`, async () => {
  const f = await fixture(), registration = f.prepare(), view = f.view(registration.inputSetHash), old = f.markers(), source = f.sources();
  let reached = false;
  await expect(f.advance(view, current => { if (current === stage) { reached = true; throw new Error("ADVANCE-FAULT"); } })).rejects.toThrow("ADVANCE-FAULT");
  expect(reached).toBe(true); expect(f.sources()).toEqual(source);
  const interrupted = f.markers();
  expect(interrupted.profile === old.profile).toBe(stage === "after-intent" || stage === "after-shards");
  expect(interrupted.shards === old.shards).toBe(stage === "after-intent");
  if (stage !== "after-remove") {
    expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(true);
    blocked(() => readSelector(f.memoryDir));
    blocked(() => { const reader = openShardStore({ memoryDir: f.memoryDir, project: f.project, now }); try { reader.get(f.graph.note.id, f.project); } finally { reader.close(); } });
    for (const change of [{ authorizedPerson: false }, { tty: false }]) {
      await expect(activatePublicPruneView({ ...f.opts, ...change, mode: "resume" })).rejects.toThrow();
      expect(f.markers()).toEqual(interrupted); expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(true);
    }
  } else expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(false);
  const resumed = await activatePublicPruneView({ ...f.opts, mode: "resume" });
  expect(resumed.active).toBe(true); expect(resumed.viewHash).toBe(publicPruneViewHash(view));
  expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(false);
  expect(readSelector(f.memoryDir).selector).toMatchObject({ pruneInputSetHash: publicPruneViewHash(view) });
  const reader = openShardStore({ memoryDir: f.memoryDir, project: f.project, now });
  try { expect(reader.get(f.graph.note.id, f.project)).toBeUndefined(); expect(reader.get(f.second.note.id, f.project)?.id).toBe(f.second.note.id); } finally { reader.close(); }
  const final = f.markers(); await activatePublicPruneView({ ...f.opts, mode: "resume" }); expect(f.markers()).toEqual(final); expect(f.sources()).toEqual(source);
});

test("cumulative advance preserves every prior mask and authored source; dropped or unrelated chains refuse", async () => {
  const f = await fixture(), first = f.prepare(), source = f.sources(); await f.advance(f.view(first.inputSetHash));
  const unrelated = f.prepare(f.second), old = f.markers();
  await expect(f.advance(f.view())).rejects.toThrow(); expect(f.markers()).toEqual(old);
  await expect(f.advance(f.view(unrelated.inputSetHash))).rejects.toThrow(); expect(f.markers()).toEqual(old);
  const second = f.prepare(f.second, first.inputSetHash), next = f.view(second.inputSetHash), result = await f.advance(next);
  expect(result.viewHash).toBe(publicPruneViewHash(next));
  const targets = buildPublicPruneIndex(resolveShardProfile(f.memoryDir, { project: f.project })).targets;
  expect(targets).toContain(f.graph.note.id); expect(targets).toContain(f.second.note.id); expect(f.sources()).toEqual(source);
  const complete = f.markers(); expect(await f.advance(next)).toEqual(result); expect(f.markers()).toEqual(complete);
});

test("stale selector and forged, missing or released mutation authority refuse before intent publication", async () => {
  const f = await fixture(), registration = f.prepare(), view = f.view(registration.inputSetHash), old = f.markers();
  await expect(advancePublicPruneView({ memoryDir: f.memoryDir, view, expectedRevision: "0".repeat(64) })).rejects.toThrow();
  for (const handles of [[], [(() => {}) as MutationHandle]]) {
    await expect(f.advance(view, undefined, handles)).rejects.toThrow(); expect(f.markers()).toEqual(old); expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(false);
  }
  const released = acquireMutation(f.profile.dir); expect(released).toBeDefined(); released!();
  const root = acquireMutation(f.memoryDir); expect(root).toBeDefined();
  try { await expect(f.advance(view, undefined, [root!, released!])).rejects.toThrow(); } finally { root!(); }
  expect(f.markers()).toEqual(old); expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(false);
});

test("malformed and tampered pending intents remain unavailable and are never silently removed", async () => {
  const f = await fixture(), registration = f.prepare();
  await expect(f.advance(f.view(registration.inputSetHash), stage => { if (stage === "after-intent") throw new Error("FAULT"); })).rejects.toThrow("FAULT");
  const file = join(f.memoryDir, PUBLIC_PRUNE_INTENT), original = readFileSync(file, "utf8"), markers = f.markers();
  for (const bad of ["MALFORMED-INTENT-CANARY", canonicalJSON({ ...JSON.parse(original), finalProfileHash: "0".repeat(64) }) + "\n"]) {
    writeFileSync(file, bad, { mode: 0o600 }); blocked(() => readSelector(f.memoryDir));
    await expect(activatePublicPruneView({ ...f.opts, mode: "resume" })).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(bad); expect(f.markers()).toEqual(markers);
  }
  writeFileSync(file, original, { mode: 0o600 }); await activatePublicPruneView({ ...f.opts, mode: "resume" });
  expect(existsSync(file)).toBe(false);
});


test("advance retains an effective native prune alongside newly activated neutral masks", async () => {
  const f = await fixture(); let clock = now();
  const store = openShardStore({ memoryDir: f.memoryDir, project: f.project, now: () => clock, screen: () => "keep" });
  const id = store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "NATIVE-MASK-CONTROL", about: [] });
  store.demote(id, "person", f.project, new Date(clock + 1000).toISOString()); clock += 2000;
  const port = store.prunePort(), authority = { project: f.project, actor: "person" as const, authorize: () => true };
  applyPrune(port, planPrune(port, { cutoff: new Date(clock).toISOString(), targets: [id] }, authority), authority); store.close();
  const source = f.sources(), before = buildPublicPruneIndex(resolveShardProfile(f.memoryDir, { project: f.project })).targets;
  expect(before).toContain(id);
  const first = f.prepare(); await f.advance(f.view(first.inputSetHash));
  const after = buildPublicPruneIndex(resolveShardProfile(f.memoryDir, { project: f.project })).targets;
  expect(after).toContain(id); expect(after).toContain(f.graph.note.id); expect(f.sources()).toEqual(source);
});

test("missing required proof after intent blocks recovery until exact evidence is restored", async () => {
  const f = await fixture(), first = f.prepare();
  await expect(f.advance(f.view(first.inputSetHash), stage => { if (stage === "after-intent") throw new Error("FAULT"); })).rejects.toThrow("FAULT");
  const file = join(f.profile.dir, "public-prune-objects", f.graph.input.source.manifestBlob + ".git"), bytes = readFileSync(file), markers = f.markers(), intent = readFileSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT), "utf8");
  rmSync(file);
  await expect(activatePublicPruneView({ ...f.opts, mode: "resume" })).rejects.toThrow();
  expect(f.markers()).toEqual(markers); expect(readFileSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT), "utf8")).toBe(intent);
  blocked(() => readSelector(f.memoryDir));
  writeFileSync(file, bytes, { mode: 0o600 }); await activatePublicPruneView({ ...f.opts, mode: "resume" });
  expect(buildPublicPruneIndex(resolveShardProfile(f.memoryDir, { project: f.project })).targets).toContain(f.graph.note.id);
});
