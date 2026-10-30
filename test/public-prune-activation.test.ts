import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activatePublicPruneView, type PublicPruneActivationStage } from "../src/memory/public-prune-activation.ts";
import { MemoryStore, openShardStore, buildPublicPruneIndex, type NoteInput } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { canonicalJSON, hashJSON, readSelector } from "../src/memory/generation.ts";
import { resolveShardProfile } from "../src/memory/shard.ts";
import { applyPrune, planPrune } from "../src/memory/prune.ts";
import { persistPublicPruneInput, preparePublicPruneInput } from "../src/memory/public-prune-inputs.ts";
import { PUBLIC_PRUNE_INTENT, readPublicPruneView } from "../src/memory/public-prune-view.ts";
import { publicPruneGraph } from "./fixtures/public-prune-graph.ts";

const A = "github.com/fixture/public-prune", B = "github.com/fixture/second", cleanup: (() => void)[] = [];
afterEach(() => { for (const done of cleanup.splice(0).reverse()) done(); });
const note = (project: string, text: string, shared = false): NoteInput => ({ op: "note", project, scope: shared ? "shared" : "project", tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] });
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string, prefix = "") => { for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), stat = lstatSync(path), key = prefix + name;
    result[key] = stat.isDirectory() ? `directory:${stat.mode}` : `${stat.mode}:${readFileSync(path).toString("base64")}`;
    if (stat.isDirectory()) walk(path, key + "/");
  } };
  walk(root); return result;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-prune-activation-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const memoryDir = join(root, "memory"), legacy = new MemoryStore({ home: root, screen: () => "keep" });
  const visible = legacy.note(note(A, "LOCAL-CONTROL-VISIBLE")); legacy.note(note(B, "OTHER-SEALED-REALM")); legacy.note(note(A, "USER-OVERLAY", true)); legacy.close();
  await migrateShards({ memoryDir, mode: "apply", authorizedPerson: true, tty: true });
  const opts = { memoryDir, authorizedPerson: true, tty: true };
  const markers = () => ({ profile: existsSync(join(memoryDir, "profile.json")) ? readFileSync(join(memoryDir, "profile.json"), "utf8") : "absent", shards: readFileSync(join(memoryDir, "shards.json"), "utf8") });
  const sources = () => {
    const result: Record<string, string> = {};
    for (const project of [A, B]) {
      const profile = resolveShardProfile(memoryDir, { project });
      for (const folder of ["log", "local", "legacy/log", "legacy/local", "legacy-main/log", "legacy-main/local"]) {
        const dir = join(profile.dir, folder); if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) result[project + "/" + folder + "/" + name] = readFileSync(join(dir, name), "utf8");
      }
    }
    return result;
  };
  return { root, memoryDir, opts, visible, markers, sources };
}

test("dry-run is read-only and explicitly defers mask building until apply", async () => {
  const f = await fixture(), before = f.markers(), source = f.sources();
  const files = snapshot(f.root), selected = readSelector(f.memoryDir);
  const result = await activatePublicPruneView({ ...f.opts, mode: "dry-run" });
  expect(result.active).toBe(false); expect(result.maskBuildCheck).toBe("deferred"); expect(result.realms).toBe(3);
  expect(snapshot(f.root)).toEqual(files); expect(f.markers()).toEqual(before); expect(f.sources()).toEqual(source);
  expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(false);
  expect(readSelector(f.memoryDir)).toEqual(selected);
});

test("an active split born from an explicit shared-v1 root activates its existing receiving generation", async () => {
  const f = await fixture(), profile = { schema: "agent-mem.profile/v1", kind: "shared-v1" }, shards = JSON.parse(f.markers().shards);
  writeFileSync(join(f.memoryDir, "profile.json"), canonicalJSON(profile) + "\n", { mode: 0o600 });
  writeFileSync(join(f.memoryDir, "shards.json"), canonicalJSON({ ...shards, selectorRevision: hashJSON(profile) }) + "\n");
  const dry = await activatePublicPruneView({ ...f.opts, mode: "dry-run" }); expect(dry.generation).toBe(shards.generation);
  expect((await activatePublicPruneView({ ...f.opts, mode: "apply" })).generation).toBe(shards.generation);
  expect(readSelector(f.memoryDir).selector).toMatchObject({ schema: "agent-mem.profile/v2", generation: shards.generation });
});

test("unknown v1 shard journal fields refuse before locks, indexes, maps or intents are written", async () => {
  const f = await fixture(), path = join(f.memoryDir, "shards.json"), journal = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, canonicalJSON({ ...journal, unsupportedFutureField: true }) + "\n"); const before = snapshot(f.root);
  for (const mode of ["dry-run", "apply"] as const) {
    await expect(activatePublicPruneView({ ...f.opts, mode })).rejects.toThrow(); expect(snapshot(f.root)).toEqual(before);
  }
});

test("activation preserves every old shard journal field and native mask; resume is a verified no-op", async () => {
  const f = await fixture(), store = openShardStore({ memoryDir: f.memoryDir, project: A, screen: () => "keep" });
  const expired = store.note({ ...note(A, "EXPLICIT-NATIVE-PRUNE"), expires: "2000-01-01T00:00:00.000Z" });
  const port = store.prunePort(), authorization = { project: A, actor: "person" as const, authorize: () => true };
  applyPrune(port, planPrune(port, { cutoff: new Date().toISOString(), targets: [expired] }, authorization), authorization); store.close();
  const old = f.markers(), oldShards = JSON.parse(old.shards), source = f.sources(), profile = resolveShardProfile(f.memoryDir, { project: A });
  const native = buildPublicPruneIndex(profile); expect(native.targets).toContain(expired);
  const result = await activatePublicPruneView({ ...f.opts, mode: "apply" }); expect(result.active).toBe(true);
  const next = f.markers(), nextShards = JSON.parse(next.shards);
  const { schema: _oldSchema, selectorRevision: _oldRevision, ...kept } = oldShards;
  const { schema: _newSchema, selectorRevision: _newRevision, ...actual } = nextShards;
  expect(actual).toEqual(kept); expect(nextShards.schema).toBe("agent-mem.shards/v2");
  expect(readSelector(f.memoryDir).selector?.schema).toBe("agent-mem.profile/v2");
  expect(buildPublicPruneIndex(resolveShardProfile(f.memoryDir, { project: A })).targets).toContain(expired);
  expect(f.sources()).toEqual(source);
  expect(await activatePublicPruneView({ ...f.opts, mode: "resume" })).toMatchObject({ active: true, alreadyActive: true });
  expect(f.markers()).toEqual(next);
  const reader = openShardStore({ memoryDir: f.memoryDir, project: A });
  try { expect(reader.list({ project: A }).map(row => row.id)).toContain(f.visible); expect(reader.list({ project: A }).map(row => row.id)).not.toContain(expired); }
  finally { reader.close(); }
});

for (const stage of ["after-intent", "after-shards", "after-profile", "after-remove"] as const) test(`activation ${stage} fault resumes forward without rewriting authored sources`, async () => {
  const f = await fixture(), before = f.markers(), source = f.sources(); let reached = false;
  await expect(activatePublicPruneView({ ...f.opts, mode: "apply", checkpoint: current => {
    if (current === stage) { reached = true; throw new Error("ACTIVATION-FAULT"); }
  } })).rejects.toThrow("ACTIVATION-FAULT");
  expect(reached).toBe(true);
  if (stage !== "after-remove") {
    expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(true);
    expect(() => readSelector(f.memoryDir)).toThrow();
    expect(() => openShardStore({ memoryDir: f.memoryDir, project: A })).toThrow();
    // No normal reader can interpret the partly switched profile/shard pair.
  } else expect(readSelector(f.memoryDir).selector?.schema).toBe("agent-mem.profile/v2");
  const resumed = await activatePublicPruneView({ ...f.opts, mode: "resume" }); expect(resumed.active).toBe(true);
  expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(false); expect(f.sources()).toEqual(source);
  const after = f.markers(); expect(after.profile).not.toBe(before.profile);
  await activatePublicPruneView({ ...f.opts, mode: "resume" }); expect(f.markers()).toEqual(after);
});

test("activation refuses live readers and non-person requests before publishing an intent", async () => {
  const f = await fixture(), before = f.markers();
  for (const change of [{ authorizedPerson: false }, { tty: false }]) await expect(activatePublicPruneView({ ...f.opts, ...change, mode: "apply" })).rejects.toThrow();
  const reader = openShardStore({ memoryDir: f.memoryDir, project: A });
  try { await expect(activatePublicPruneView({ ...f.opts, mode: "apply" })).rejects.toThrow(/reader.*live/); }
  finally { reader.close(); }
  expect(f.markers()).toEqual(before); expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(false);
});

test("checkpoint alias and source drift refuse while intent blocks readers; exact restoration permits resume", async () => {
  for (const drift of ["alias", "source"] as const) {
    const f = await fixture(), profile = resolveShardProfile(f.memoryDir, { project: A });
    const path = drift === "alias" ? join(f.memoryDir, "aliases.jsonl") : join(profile.dir, "log", "f".repeat(16) + ".jsonl");
    const existed = existsSync(path), previous = existed ? readFileSync(path) : undefined;
    await expect(activatePublicPruneView({ ...f.opts, mode: "apply", checkpoint: (stage: PublicPruneActivationStage) => {
      if (stage === "after-intent") writeFileSync(path, drift === "alias" ? "ALIASES-DRIFT\n" : "INVALID-SOURCE-DRIFT\n", { mode: 0o600 });
    } })).rejects.toThrow();
    expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(true); expect(() => readSelector(f.memoryDir)).toThrow();
    if (previous) writeFileSync(path, previous); else rmSync(path);
    expect((await activatePublicPruneView({ ...f.opts, mode: "resume" })).active).toBe(true);
  }
});

test("root map activates already-proved Layer2 inputs without importing ordinary rows or changing native sources", async () => {
  const f = await fixture(), graph = publicPruneGraph(), profile = resolveShardProfile(f.memoryDir, { project: A });
  const binding = { realm: graph.manifest.realm, receivingGeneration: profile.generation!, selectorRevision: profile.selectorRevision, inputSetHash: null };
  const prepared = preparePublicPruneInput({ dir: profile.dir, binding, current: () => binding, input: graph.input }), registration = persistPublicPruneInput(prepared);
  const source = f.sources();
  const result = await activatePublicPruneView({ ...f.opts, mode: "apply", view: { schema: "agent-mem.public-prune-view/v1", receivingGeneration: profile.generation!, realms: { [`project:${A}`]: registration.inputSetHash } } });
  expect(result.active).toBe(true); expect(f.sources()).toEqual(source);
  expect(readPublicPruneView(f.memoryDir, result.viewHash, profile.generation!).realms[`project:${A}`]).toBe(registration.inputSetHash);
  const rebuilt = buildPublicPruneIndex(resolveShardProfile(f.memoryDir, { project: A })); expect(rebuilt.targets).toContain(graph.note.id);
  const reader = openShardStore({ memoryDir: f.memoryDir, project: A });
  try { expect(reader.list({ project: A }).map(row => row.id)).not.toContain(graph.note.id); }
  finally { reader.close(); }
});

test("missing Layer2 membership or an unopened root-map realm refuses before activation intent", async () => {
  const f = await fixture(), generation = resolveShardProfile(f.memoryDir, { project: A }).generation!, before = f.markers();
  for (const key of [`project:${A}`, "project:github.com/unopened/private"]) {
    await expect(activatePublicPruneView({ ...f.opts, mode: "apply", view: { schema: "agent-mem.public-prune-view/v1", receivingGeneration: generation, realms: { [key]: "e".repeat(64) } } })).rejects.toThrow();
    expect(f.markers()).toEqual(before); expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(false);
  }
});

test("malformed intent is never removed or treated as a rollback instruction", async () => {
  const f = await fixture(), file = join(f.memoryDir, PUBLIC_PRUNE_INTENT), before = f.markers();
  writeFileSync(file, canonicalJSON({ schema: "UNKNOWN", rollback: true }) + "\n", { mode: 0o600 });
  const intent = readFileSync(file, "utf8");
  await expect(activatePublicPruneView({ ...f.opts, mode: "resume" })).rejects.toThrow();
  expect(readFileSync(file, "utf8")).toBe(intent); expect(f.markers()).toEqual(before);
});

test("v2 root maps cannot omit old realms or replace membership with an unrelated equal-mask chain", async () => {
  const f = await fixture(), graph = publicPruneGraph(), original = resolveShardProfile(f.memoryDir, { project: A });
  const register = (selectorRevision: string, inputSetHash: string | null) => {
    const binding = { realm: graph.manifest.realm, receivingGeneration: original.generation!, selectorRevision, inputSetHash };
    return persistPublicPruneInput(preparePublicPruneInput({ dir: original.dir, binding, current: () => binding, input: graph.input }));
  };
  const first = register(original.selectorRevision, null), view = (set?: string): PublicPruneViewV1 => ({ schema: "agent-mem.public-prune-view/v1" as const,
    receivingGeneration: original.generation!, realms: set ? { [`project:${A}`]: set } : {} });
  await activatePublicPruneView({ ...f.opts, mode: "apply", view: view(first.inputSetHash) });
  const selected = resolveShardProfile(f.memoryDir, { project: A }), unrelated = register(selected.selectorRevision, null);
  expect(unrelated.inputSetHash).not.toBe(first.inputSetHash);
  for (const next of [view(), view(unrelated.inputSetHash)]) {
    const before = snapshot(f.root);
    await expect(activatePublicPruneView({ ...f.opts, mode: "apply", view: next })).rejects.toThrow();
    expect(snapshot(f.root)).toEqual(before);
  }
  const descendant = register(selected.selectorRevision, first.inputSetHash);
  expect((await activatePublicPruneView({ ...f.opts, mode: "apply", view: view(descendant.inputSetHash) })).active).toBe(true);
});
