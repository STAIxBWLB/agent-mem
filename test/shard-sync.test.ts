import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { appendAlias, shardDir, shardKeyHash } from "../src/memory/shard.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { syncShardedMemory } from "../src/memory/shard-sync.ts";
import { applyPrune, planPrune, pruneId, reducePruneRows, pruneRowHash, type PrunePlan, type PruneRow } from "../src/memory/prune.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { canonicalJSON, hashJSON, writeProfileJSON } from "../src/memory/generation.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";

const A = "example.test/team/alpha", B = "example.test/team/beta", G1 = "1".repeat(32), G2 = "2".repeat(32);
const refA = `refs/heads/amem/p/${shardKeyHash(A)}`, refB = `refs/heads/amem/p/${shardKeyHash(B)}`, refUser = "refs/heads/amem/u";
const privateRemote = { visibility: async () => "private" as const };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function temp() { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-shard-sync-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function git(dir: string, ...args: string[]) {
  const result = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture Git failed: ${result.stderr}`);
  return result.stdout.trim();
}
function remote() { const dir = temp(); git(dir, "init", "-q", "--bare"); return dir; }
const note = (project: string, text: string, scope: "project" | "shared" = "project"): NoteInput => ({ op: "note", project, scope, tier: "long", kind: "finding", peer: "fixture", source: "person", text, about: [] });
function keep(store: MemoryStore) { cleanup.push(() => store.close()); return store; }
async function split(generation: string, seeded = false) {
  const home = temp(), legacy = new MemoryStore({ home, profile: "shared-v1", deferPromotions: true }), ids: Partial<Record<"alphaLegacy" | "betaLegacy" | "userLegacy", string>> = {};
  if (seeded) {
    ids.alphaLegacy = legacy.note(note(A, "alphalegacy"));
    ids.betaLegacy = legacy.note(note(B, "UNOPENED_B_betalegacy"));
    ids.userLegacy = legacy.note(note(A, "userlegacy", "shared"));
    legacy.note({ ...note(A, "LOCAL_ONLY_legacy_short"), tier: "short" });
  }
  const memory = legacy.dir; legacy.close();
  expect(await migrateShards({ memoryDir: memory, generation, mode: "apply", authorizedPerson: true, tty: true })).toMatchObject({ active: true });
  const clock = { now: Date.now() };
  const a = keep(openShardStore({ home, project: A, deferPromotions: true, now: () => clock.now, ttlMs: 1000 }));
  return { home, memory, a, ids, clock };
}
function refs(dir: string) { return git(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"); }
function jsonlBytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (folder: string) => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) visit(file); else if (entry.isFile() && entry.name.endsWith(".jsonl")) out[file.slice(dir.length)] = readFileSync(file, "utf8");
    }
  };
  visit(dir); return out;
}
function assertPublicHistory(url: string) {
  for (const commit of git(url, "rev-list", "--all").split("\n").filter(Boolean)) {
    for (const file of git(url, "ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean)) {
      expect(file).not.toMatch(/(?:^|\/)(?:machine|local|capture|work)(?:\/|$)|(?:candidates|index|search)\.db|machine\.json/);
      expect(git(url, "show", `${commit}:${file}`)).not.toContain("LOCAL_ONLY_");
    }
  }
}
function publicPrune(store: MemoryStore, target: string, clock: { now: number }) {
  // A real public demote supplies the expiry witness, with the normal append-only API.
  expect(store.demote(target, "person", A)).toBeDefined(); clock.now += 2000;
  const auth = { project: A, actor: "person" as const, authorize: () => true,
    policy: { revision: () => "fixture-public-v1", classify: () => "public" as const, attest: () => true } };
  const plan = planPrune(store.prunePort(), { cutoff: new Date(clock.now).toISOString(), targets: [target] }, auth);
  expect(plan.rows).toHaveLength(1); expect(plan.rows[0]!.placement).toBe("synced");
  expect(applyPrune(store.prunePort(), plan, auth).completed).toContain(plan.rows[0]!.payload.id);
  return plan.rows[0]!.payload;
}

test("two split homes sync opened project plus user across generations, preserve original ids, and never fetch unopened project or machine data", async () => {
  const url = remote(), source = await split(G1, true), other = keep(openShardStore({ home: source.home, project: B, deferPromotions: true }));
  const ids = { ...source.ids, alphaCurrent: source.a.note(note(A, "alphacurrent")), userCurrent: source.a.note(note(A, "usercurrent", "shared")), betaCurrent: other.note(note(B, "UNOPENED_B_betacurrent")) };
  source.a.note({ ...note(A, "LOCAL_ONLY_short"), tier: "short" });
  writeFileSync(join(source.a.dir, "candidates.db"), "LOCAL_ONLY_candidates");
  const capture = new CaptureStore({ home: source.home, project: A });
  try { capture.append({ project: A, agent: "fixture", event: "Stop", excerpt: "LOCAL_ONLY_capture" }); } finally { capture.close(); }
  mkdirSync(join(source.a.dir, "work"), { recursive: true }); writeFileSync(join(source.a.dir, "work", "fixture.json"), "LOCAL_ONLY_work");
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(await syncMemory(other, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(git(url, "for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").sort()).toEqual([refA, refB, refUser].sort());
  const betaPack = git(url, "ls-tree", "-r", "--name-only", refB).split("\n").find(file => git(url, "show", `${refB}:${file}`).includes("UNOPENED_B_betacurrent"));
  expect(betaPack).toBeDefined(); const betaBlob = git(url, "rev-parse", `${refB}:${betaPack}`);
  const receiver = await split(G2);
  expect(existsSync(shardDir(receiver.memory, B))).toBe(false);
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const expected = [ids.alphaLegacy!, ids.alphaCurrent, ids.userLegacy!, ids.userCurrent].sort();
  expect(source.a.prunePort().snapshot().rows.find(source => source.row.id === ids.alphaLegacy)).toMatchObject({ placement: "synced", publicWitness: false, legacy: true });
  expect(source.a.prunePort().snapshot().rows.find(source => source.row.op === "note" && source.row.text === "LOCAL_ONLY_legacy_short")).toMatchObject({ placement: "local", publicWitness: false, legacy: true });
  expect(receiver.a.prunePort().snapshot().rows.find(source => source.row.id === ids.alphaLegacy)).toMatchObject({ placement: "synced", publicWitness: true });
  const rows = receiver.a.list({ project: A, limit: 100 });
  expect(rows.map(row => row.id).sort()).toEqual(expected);
  for (const id of expected) {
    const row = receiver.a.get(id, A)!; expect(row.id).toBe(id); expect(row.project).toBe(A);
    const original = source.a.get(id, A)!;
    expect({ at: row.at, machine: row.machine, peer: row.peer, text: row.text }).toEqual({ at: original.at, machine: original.machine, peer: original.peer, text: original.text });
    const transported = git(url, "ls-tree", "-r", "--name-only", row.scope === "shared" ? refUser : refA).split("\n").flatMap(file => file.startsWith("rows/") ? git(url, "show", `${row.scope === "shared" ? refUser : refA}:${file}`).split("\n") : []).map(line => JSON.parse(line)).find(value => value.id === id);
    expect(canonicalJSON(transported)).toBe(canonicalJSON(source.a.prunePort().snapshot().rows.find(source => source.row.id === id)?.row ?? source.a.openedSyncTargets()[1]!.prunePort().snapshot().rows.find(source => source.row.id === id)!.row));
    expect(row.scope).toBe([ids.userLegacy, ids.userCurrent].includes(id) ? "shared" : "project");
    expect(receiver.a.search(row.text, { project: A }).hits.some(hit => hit.view?.id === id)).toBe(true);
  }
  const cache = join(receiver.memory, "shard-sync", "objects.git"); expect(existsSync(cache)).toBe(true);
  expect(git(cache, "for-each-ref", "--format=%(refname)")).not.toContain(refB);
  expect(memoryGitSync(["--git-dir", cache, "cat-file", "-e", betaBlob], { encoding: "utf8" }).status).not.toBe(0);
  expect(existsSync(shardDir(receiver.memory, B))).toBe(false);
  const brief = await sessionStartBrief({ cwd: receiver.home, base: receiver.memory, project: A });
  for (const marker of ["alphalegacy", "alphacurrent", "userlegacy", "usercurrent"]) expect(brief.context).toContain(marker);
  expect(brief.context).not.toContain("UNOPENED_B_"); expect(brief.context).not.toContain("LOCAL_ONLY_");
  const incremental = canonicalJSON(receiver.a.list({ project: A, limit: 100 })); receiver.a.rebuild(); expect(canonicalJSON(receiver.a.list({ project: A, limit: 100 }))).toBe(incremental);
  expect(await syncMemory(receiver.a, privateRemote)).toMatchObject({ ok: true });
  expect(receiver.a.list({ project: A, limit: 100 }).map(row => row.id).sort()).toEqual(expected);
  expect(existsSync(shardDir(receiver.memory, B))).toBe(false); assertPublicHistory(url);
}, 60_000);

test("transport selection cannot supply prune proof for an unwitnessed legacy target or basis", async () => {
  for (const legacyBasis of [false, true]) {
    const url = remote(), home = temp();
    const v1 = new MemoryStore({ home, profile: "shared-v1", deferPromotions: true });
    const targetId = v1.note(note(A, "legacy prune target"));
    expect(v1.demote(targetId, "person", A)).toBeDefined();
    const memory = v1.dir; v1.close();
    expect(await migrateShards({ memoryDir: memory, generation: G1, mode: "apply", authorizedPerson: true, tty: true })).toMatchObject({ active: true });
    const a = keep(openShardStore({ home, project: A, deferPromotions: true }));
    const initial = a.prunePort().snapshot();
    const target = initial.rows.find(source => source.row.id === targetId)!;
    const basis = initial.rows.find(source => source.row.op === "demote" && source.row.target === targetId)!;
    const basisId = basis.row.id;
    expect(target.publicWitness).toBe(false); expect(basis.publicWitness).toBe(false);
    const witnessed = legacyBasis ? target : basis;
    appendFileSync(join(a.dir, "log", `${a.machine.id}.jsonl`), canonicalJSON(witnessed.row) + "\n");
    a.prunePort().refresh();
    const at = new Date(Date.parse((basis.row as { by: string }).by) + 2000).toISOString();
    const body = { schema: "agent-mem.prune/v1" as const, op: "prune" as const, generation: G1,
      at, cutoff: at, machine: a.machine.id, actor: "person" as const, placement: "synced" as const,
      targets: [{ id: target.row.id, rowHash: pruneRowHash(target.row), expiredAt: (basis.row as { by: string }).by,
        basis: { kind: "demote" as const, id: basis.row.id, rowHash: pruneRowHash(basis.row) } }] };
    const prune = { ...body, id: pruneId(body) };
    const snapshot = a.prunePort().snapshot();
    expect(snapshot.rows.find(source => source.row.id === witnessed.row.id)?.publicWitness).toBe(true);
    expect(reducePruneRows([{ row: prune, placement: "synced" }], snapshot, G1).invalid).toBe(1);
    const publicSnapshot = { ...snapshot, rows: snapshot.rows.map(source => ({ ...source, publicWitness: true })) };
    expect(reducePruneRows([{ row: prune, placement: "synced" }], publicSnapshot, G1).targets.has(targetId)).toBe(true);
    appendFileSync(join(a.dir, "log", `${a.machine.id}.jsonl`), canonicalJSON(prune) + "\n");
    expect(await syncMemory(a, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: false });
    expect(refs(url)).toBe("");
    expect(a.prunePort().snapshot().rows.find(source => source.row.id === (legacyBasis ? basisId : targetId))?.publicWitness).toBe(false);
  }
}, 60_000);

function localPrune(store: MemoryStore, target: string, clock: { now: number }) {
  const auth = { project: A, actor: "person" as const, authorize: () => true };
  const plan = planPrune(store.prunePort(), { cutoff: new Date(clock.now).toISOString(), targets: [target] }, auth);
  expect(plan.rows).toHaveLength(1); expect(plan.rows[0]!.placement).toBe("local");
  expect(applyPrune(store.prunePort(), plan, auth).completed).toContain(plan.rows[0]!.payload.id);
  expect(store.prunePort().snapshot().pruned).toContain(target);
}

test("a locally pruned unwitnessed legacy original never receives first publication", async () => {
  const url = remote(), home = temp(), clock = { now: Date.now() };
  const legacy = new MemoryStore({ home, profile: "shared-v1", deferPromotions: true, now: () => clock.now, ttlMs: 1000 });
  const text = "LOCAL_ONLY_never_publish_pruned_legacy", target = legacy.note(note(A, text));
  expect(legacy.demote(target, "person", A)).toBeDefined();
  const memory = legacy.dir; legacy.close(); clock.now += 2000;
  expect(await migrateShards({ memoryDir: memory, generation: G1, mode: "apply", authorizedPerson: true, tty: true })).toMatchObject({ active: true });
  const source = keep(openShardStore({ home, project: A, deferPromotions: true, now: () => clock.now, ttlMs: 1000 }));
  expect(source.prunePort().snapshot().rows.find(row => row.row.id === target)).toMatchObject({ placement: "synced", publicWitness: false, legacy: true });
  localPrune(source, target, clock); expect(source.get(target, A)).toBeUndefined();
  expect(await syncMemory(source, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const receiver = await split(G2);
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(receiver.a.get(target, A)).toBeUndefined();
  expect(receiver.a.list({ project: A }).some(row => row.id === target || row.text === text)).toBe(false);
  for (const commit of git(url, "rev-list", "--all").split("\n")) for (const file of git(url, "ls-tree", "-r", "--name-only", commit).split("\n")) {
    expect(git(url, "show", `${commit}:${file}`)).not.toContain(text);
  }
}, 60_000);

test("local pruning does not suppress an already witnessed original from its prior public transport", async () => {
  const url = remote(), source = await split(G1), text = "witnessed original retains public transport";
  const target = source.a.note(note(A, text));
  expect(source.a.prunePort().snapshot().rows.find(row => row.row.id === target)?.publicWitness).toBe(true);
  expect(source.a.demote(target, "person", A)).toBeDefined(); source.clock.now += 2000;
  localPrune(source.a, target, source.clock); expect(source.a.get(target, A)).toBeUndefined();
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const published = git(url, "ls-tree", "-r", "--name-only", refA).split("\n").map(file => git(url, "show", `${refA}:${file}`)).join("\n");
  expect(published).toContain(text);
}, 60_000);

test("a public blob whose text pipe normalizes different bytes refuses before publication or import", async () => {
  const url = remote(), source = await split(G1, true);
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const attacker = temp(); git(attacker, "init", "-q"); git(attacker, "fetch", "-q", url, refA); git(attacker, "checkout", "-qb", "fixture", "FETCH_HEAD");
  const file = join(attacker, "shard.json"), descriptor = readFileSync(file);
  expect(descriptor.at(-1)).toBe(10);
  const changed = Buffer.from(descriptor); changed[changed.length - 1] = 13;
  writeFileSync(file, changed); git(attacker, "add", "shard.json");
  git(attacker, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "same-size descriptor normalization fixture");
  git(attacker, "push", "-q", url, `HEAD:${refA}`);
  const receiver = await split(G2), project = jsonlBytes(receiver.a.dir), user = jsonlBytes(join(receiver.memory, "user")), before = refs(url);
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: false, error: expect.stringContaining("blob") });
  expect(jsonlBytes(receiver.a.dir)).toEqual(project); expect(jsonlBytes(join(receiver.memory, "user"))).toEqual(user); expect(refs(url)).toBe(before);
}, 60_000);

for (const visibility of ["public", "unknown"] as const) test(`split sync refuses ${visibility} visibility before cache or remote effects`, async () => {
  const url = remote(), f = await split(G1), before = refs(url), logs = jsonlBytes(f.a.dir);
  f.a.note(note(A, "public candidate")); const authored = jsonlBytes(f.a.dir);
  expect(await syncMemory(f.a, { remote: url, visibility: async () => visibility })).toMatchObject({ ok: false, pushed: false });
  expect(existsSync(join(f.memory, "shard-sync"))).toBe(false); expect(refs(url)).toBe(before); expect(jsonlBytes(f.a.dir)).toEqual(authored); expect(authored).not.toEqual(logs);
}, 30_000);

test("split sync rejects a forbidden historical tree even when the remote tip deleted the private file", async () => {
  const url = remote(), source = await split(G1, true); expect((await syncMemory(source.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const attacker = temp(); git(attacker, "init", "-q"); git(attacker, "fetch", "-q", url, refA); git(attacker, "checkout", "-qb", "fixture", "FETCH_HEAD");
  writeFileSync(join(attacker, "private-receipt.txt"), "LOCAL_ONLY_historical"); git(attacker, "add", "-f", "private-receipt.txt"); git(attacker, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "forbidden fixture history");
  git(attacker, "rm", "-q", "private-receipt.txt"); git(attacker, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "delete fixture file"); git(attacker, "push", "-q", url, `HEAD:${refA}`);
  const receiver = await split(G2), local = jsonlBytes(receiver.a.dir), user = jsonlBytes(join(receiver.memory, "user")), tips = refs(url);
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: false });
  expect(jsonlBytes(receiver.a.dir)).toEqual(local); expect(jsonlBytes(join(receiver.memory, "user"))).toEqual(user); expect(refs(url)).toBe(tips);
}, 60_000);

test("same-generation public prune sync preserves strict witnesses and rebuild parity", async () => {
  const url = remote(), source = await split(G1), target = source.a.note(note(A, "public prune target"));
  const prune = publicPrune(source.a, target, source.clock); expect((await syncMemory(source.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const receiver = await split(G1); expect((await syncMemory(receiver.a, { remote: url, ...privateRemote })).ok).toBe(true);
  expect(receiver.a.prunePort().snapshot().pruned).toContain(target); expect(receiver.a.prunePort().snapshot().durablePruneIds).toContain(prune.id);
  const before = canonicalJSON(receiver.a.prunePort().snapshot()); receiver.a.rebuild(); expect(canonicalJSON(receiver.a.prunePort().snapshot())).toBe(before);
}, 60_000);

test("a foreign-generation public prune refuses the whole selected sync before project or user append or push", async () => {
  const url = remote(), source = await split(G1), target = source.a.note(note(A, "public prune target"));
  publicPrune(source.a, target, source.clock); source.a.note(note(A, "remote user public row", "shared")); expect((await syncMemory(source.a, { remote: url, ...privateRemote })).ok).toBe(true);
  const receiver = await split(G2); receiver.a.note(note(A, "pending receiver project")); receiver.a.note(note(A, "pending receiver user", "shared"));
  const project = jsonlBytes(receiver.a.dir), user = jsonlBytes(join(receiver.memory, "user")), tips = refs(url);
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: false });
  expect(jsonlBytes(receiver.a.dir)).toEqual(project); expect(jsonlBytes(join(receiver.memory, "user"))).toEqual(user); expect(refs(url)).toBe(tips);
  expect(receiver.a.prunePort().snapshot().rows.some(row => row.row.id === target)).toBe(false);
}, 60_000);


test("same-generation public prune with a forged witness refuses before any remote publication", async () => {
  const url = remote(), source = await split(G1), target = source.a.note(note(A, "public witness target"));
  const valid = publicPrune(source.a, target, source.clock), { id: _id, ...body } = valid;
  const bad = { ...body, targets: valid.targets.map(row => ({ ...row, rowHash: "f".repeat(64) })) };
  const forged = { ...bad, id: pruneId(bad) };
  appendFileSync(join(source.a.dir, "log", `${source.a.machine.id}.jsonl`), canonicalJSON(forged) + "\n");
  const before = refs(url);
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: false });
  expect(refs(url)).toBe(before);
}, 60_000);

test("reviewed aliases remain local and never widen the selected sync targets", async () => {
  const url = remote(), source = await split(G1, true);
  appendAlias(source.memory, { alias: B, key: A, actor: "person", machine: source.a.machine.id });
  const reconciled = keep(openShardStore({ home: source.home, project: A, reconcile: { canonical: A, aliases: [B] }, deferPromotions: true }));
  expect(reconciled.list({ project: A }).some(row => row.text === "UNOPENED_B_betalegacy")).toBe(true);
  expect(await syncMemory(reconciled, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(git(url, "for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").sort()).toEqual([refA, refUser].sort());
  for (const file of git(url, "ls-tree", "-r", "--name-only", refA).split("\n")) {
    expect(git(url, "show", `${refA}:${file}`)).not.toContain("UNOPENED_B_");
  }
}, 60_000);

test("a configured public push destination cannot bypass the selected private fetch remote", async () => {
  const url = remote(), publicURL = remote(), source = await split(G1, true);
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const cache = join(source.memory, "shard-sync", "objects.git"), before = refs(url);
  git(cache, "remote", "set-url", "--push", "origin", publicURL);
  source.a.note(note(A, "not for a public destination"));
  expect(await syncMemory(source.a, { remote: url, visibility: async value => value === url ? "private" : "public" })).toMatchObject({ ok: false, pushed: false });
  expect(refs(url)).toBe(before); expect(refs(publicURL)).toBe("");
  expect(git(cache, "remote", "get-url", "--push", "origin")).toBe(publicURL);
}, 60_000);

test("machine-local project keys require an explicit remote choice on each sync", async () => {
  const url = remote(), source = await split(G1), key = "local-checkout@1234abcd";
  const local = keep(openShardStore({ home: source.home, project: key, deferPromotions: true }));
  local.note(note(key, "explicitly opted-in local project"));
  expect(await syncMemory(local, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const before = refs(url);
  expect(await syncMemory(local, privateRemote)).toMatchObject({ ok: false, pushed: false });
  expect(refs(url)).toBe(before);
}, 60_000);

test("ambient follow-tags configuration cannot publish private cache tags", async () => {
  const url = remote(), source = await split(G1, true);
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const cache = join(source.memory, "shard-sync", "objects.git");
  git(cache, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "tag", "-a", "private-local-tag", refA, "-m", "LOCAL_ONLY_private_tag");
  git(cache, "config", "push.followTags", "true"); source.a.note(note(A, "next public append"));
  expect(await syncMemory(source.a, privateRemote)).toMatchObject({ ok: true });
  expect(git(url, "for-each-ref", "--format=%(refname)", "refs/tags/")).toBe("");
}, 60_000);

test("independent ordinary writers converge without duplicate rows or no-op history growth", async () => {
  const url = remote(), a = await split(G1), b = await split(G2);
  const first = a.a.note(note(A, "first machine original")), second = b.a.note(note(A, "second machine original"));
  expect(await syncMemory(a.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(await syncMemory(b.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(await syncMemory(a.a, privateRemote)).toMatchObject({ ok: true });
  for (const store of [a.a, b.a]) expect(store.list({ project: A }).map(row => row.id).sort()).toEqual([first, second].sort());
  const before = refs(url);
  expect(await syncMemory(a.a, privateRemote)).toMatchObject({ ok: true });
  expect(await syncMemory(b.a, privateRemote)).toMatchObject({ ok: true });
  expect(refs(url)).toBe(before);
}, 60_000);

test("cancellation during private-visibility readback leaves no transport cache or published ref", async () => {
  const url = remote(), source = await split(G1), stop = new AbortController();
  source.a.note(note(A, "pending local original")); const before = jsonlBytes(source.a.dir);
  expect(await syncMemory(source.a, { remote: url, signal: stop.signal, visibility: async () => { stop.abort(); return "private"; } })).toMatchObject({ ok: false, pushed: false, error: "stopped" });
  expect(existsSync(join(source.memory, "shard-sync"))).toBe(false);
  expect(refs(url)).toBe(""); expect(jsonlBytes(source.a.dir)).toEqual(before);
});

for (const where of ["cache", "remote"] as const) test(`a symbolic selected ${where} ref cannot redirect an update to another branch`, async () => {
  const url = remote(), source = await split(G1);
  source.a.note(note(A, "first original"));
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const repo = where === "cache" ? join(source.memory, "shard-sync", "objects.git") : url;
  const other = "refs/heads/unselected", tip = git(repo, "rev-parse", refA);
  git(repo, "update-ref", other, tip); git(repo, "symbolic-ref", refA, other);
  const before = refs(url); source.a.note(note(A, "must not redirect another branch"));
  expect(await syncMemory(source.a, privateRemote)).toMatchObject({ ok: false, pushed: false });
  expect(git(repo, "rev-parse", other)).toBe(tip); expect(refs(url)).toBe(before);
}, 60_000);

test("successive appends do not republish old rows inside overlapping immutable packs", async () => {
  const url = remote(), source = await split(G1);
  const first = source.a.note(note(A, "first append"));
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const initial = git(url, "ls-tree", "-r", "--name-only", refA).split("\n").filter(file => file.startsWith("rows/"));
  const second = source.a.note(note(A, "second append"));
  expect(await syncMemory(source.a, privateRemote)).toMatchObject({ ok: true });
  const current = git(url, "ls-tree", "-r", "--name-only", refA).split("\n").filter(file => file.startsWith("rows/"));
  expect(current).toEqual(expect.arrayContaining(initial));
  const wireRows = current.flatMap(file => git(url, "show", `${refA}:${file}`).split("\n").filter(Boolean).map(line => JSON.parse(line) as { id: string }));
  expect(wireRows.map(row => row.id).sort()).toEqual([first, second].sort());
}, 60_000);


const recoveryDigest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type ImportCrash = "plan" | "claim" | "partial" | "complete";
function pendingClaim(store: MemoryStore, row: PruneRow, plan: PrunePlan, line: string, offset: number, prefix: Buffer) {
  const pending = join(store.dir, "prune-plans", `pending-log-${row.machine}.json`);
  writeProfileJSON(pending, { schema: "agent-mem.prune-append/v1", seal: plan.seal, rowId: row.id, lineHash: recoveryDigest(line), offset, prefixHash: recoveryDigest(prefix) });
  return pending;
}
async function interruptedPruneImport(mode: ImportCrash) {
  const url = remote(), source = await split(G1), target = source.a.note(note(A, "transport prune recovery target"));
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const receiver = await split(G1);
  expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const row = publicPrune(source.a, target, source.clock);
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  const originalPort = receiver.a.prunePort.bind(receiver.a);
  let plan: PrunePlan | undefined;
  const line = canonicalJSON(row) + "\n", segment = join(receiver.a.dir, "log", `${row.machine}.jsonl`);
  receiver.a.prunePort = () => {
    const port = originalPort();
    return { ...port, appendPrune: (payload, exactLine, seal) => {
      if (payload.id !== row.id) return port.appendPrune(payload, exactLine, seal);
      plan = JSON.parse(readFileSync(join(receiver.a.dir, "prune-plans", `${seal}.json`), "utf8")) as PrunePlan;
      if (mode !== "plan") {
        const fd = openSync(segment, "a"); try { fsyncSync(fd); } finally { closeSync(fd); }
        const prefix = readFileSync(segment);
        pendingClaim(receiver.a, row, plan, exactLine, prefix.length, prefix);
        if (mode === "partial" || mode === "complete") {
          appendFileSync(segment, Buffer.from(exactLine).subarray(0, mode === "complete" ? Buffer.byteLength(exactLine) : 23));
          const fd = openSync(segment, "a"); try { fsyncSync(fd); } finally { closeSync(fd); }
        }
      }
      throw new Error("fixture interrupted transport append");
    } };
  };
  try { expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: true }); }
  finally { receiver.a.prunePort = originalPort; }
  expect(plan).toBeDefined(); expect(row.machine).not.toBe(receiver.a.machine.id);
  const pending = join(receiver.a.dir, "prune-plans", `pending-log-${row.machine}.json`);
  return { url, receiver, target, row, plan: plan!, line, segment, pending };
}

for (const crash of ["plan", "claim", "partial", "complete"] as const) test(`transport prune resumes exact ${crash} crash after full preflight and survives rebuild once`, async () => {
  const f = await interruptedPruneImport(crash);
  expect(existsSync(f.pending)).toBe(crash !== "plan");
  expect(await syncMemory(f.receiver.a, { remote: f.url, ...privateRemote })).toMatchObject({ ok: true });
  expect(existsSync(f.pending)).toBe(false); expect(f.receiver.a.get(f.target, A)).toBeUndefined();
  const port = f.receiver.a.prunePort(), before = canonicalJSON(port.snapshot());
  expect(port.snapshot().pruned).toContain(f.target);
  expect(port.snapshot().durablePruneIds?.filter(id => id === f.row.id)).toHaveLength(1);
  f.receiver.a.rebuild(); expect(canonicalJSON(port.snapshot())).toBe(before);
  expect(await syncMemory(f.receiver.a, { remote: f.url, ...privateRemote })).toMatchObject({ ok: true });
  const appended = readFileSync(f.segment, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(appended.filter(row => row.id === f.row.id)).toHaveLength(1);
}, 20_000);

for (const invalid of ["seal", "realm", "prefix"] as const) test(`pending transport ${invalid} mismatch refuses before publication or local append`, async () => {
  const f = await interruptedPruneImport("partial");
  const claim = JSON.parse(readFileSync(f.pending, "utf8"));
  if (invalid === "prefix") claim.prefixHash = "f".repeat(64);
  else {
    const { seal: _seal, ...body } = f.plan;
    const changed = invalid === "realm" ? { ...body, project: "user", policyRevision: hashJSON({ schema: "agent-mem.shard-sync/v1", realm: { scope: "user" } }) } : body;
    const plan = { ...changed, seal: invalid === "seal" ? "f".repeat(64) : hashJSON(changed) };
    writeProfileJSON(join(f.receiver.a.dir, "prune-plans", `${plan.seal}.json`), plan); claim.seal = plan.seal;
  }
  writeProfileJSON(f.pending, claim);
  const bytes = jsonlBytes(f.receiver.a.dir), pending = readFileSync(f.pending), before = refs(f.url);
  expect(await syncMemory(f.receiver.a, { remote: f.url, ...privateRemote })).toMatchObject({ ok: false, pushed: false });
  expect(jsonlBytes(f.receiver.a.dir)).toEqual(bytes); expect(readFileSync(f.pending)).toEqual(pending); expect(refs(f.url)).toBe(before);
}, 20_000);

test("a pending transport prune absent from fetched history refuses before publication or append", async () => {
  const f = await interruptedPruneImport("partial"), { id: _id, ...body } = f.row;
  const changed = { ...body, cutoff: new Date(Date.parse(body.cutoff) - 1).toISOString() }, row = { ...changed, id: pruneId(changed) };
  const { seal: _seal, ...original } = f.plan;
  const next = { ...original, rows: [{ placement: "synced" as const, payload: row }] }, plan = { ...next, seal: hashJSON(next) };
  writeProfileJSON(join(f.receiver.a.dir, "prune-plans", `${plan.seal}.json`), plan);
  const claim = { ...JSON.parse(readFileSync(f.pending, "utf8")), seal: plan.seal, rowId: row.id, lineHash: recoveryDigest(canonicalJSON(row) + "\n") };
  writeProfileJSON(f.pending, claim);
  const bytes = jsonlBytes(f.receiver.a.dir), pending = readFileSync(f.pending), before = refs(f.url);
  expect(await syncMemory(f.receiver.a, { remote: f.url, ...privateRemote })).toMatchObject({ ok: false, pushed: false, error: expect.stringContaining("no exact fetched transport row") });
  expect(jsonlBytes(f.receiver.a.dir)).toEqual(bytes); expect(readFileSync(f.pending)).toEqual(pending); expect(refs(f.url)).toBe(before);
}, 20_000);

test("an unrelated person-authored pending prune is not resumed by shard transport", async () => {
  const url = remote(), source = await split(G1), target = source.a.note(note(A, "person pending target"));
  const row = publicPrune(source.a, target, source.clock), planDir = join(source.a.dir, "prune-plans");
  const plan = readdirSync(planDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => JSON.parse(readFileSync(join(planDir, name), "utf8")) as PrunePlan).find(plan => plan.rows.some(item => item.payload.id === row.id))!;
  const segment = join(source.a.dir, "log", `${row.machine}.jsonl`), data = readFileSync(segment), line = canonicalJSON(row) + "\n", offset = data.lastIndexOf(Buffer.from(line));
  expect(offset).toBeGreaterThanOrEqual(0); pendingClaim(source.a, row, plan, line, offset, data.subarray(0, offset));
  const bytes = jsonlBytes(source.a.dir), before = refs(url);
  expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: false });
  expect(jsonlBytes(source.a.dir)).toEqual(bytes); expect(refs(url)).toBe(before);
}, 20_000);

test("pending transport recovery cannot append before another selected realm passes complete preflight", async () => {
  const f = await interruptedPruneImport("partial"), attacker = temp();
  git(attacker, "init", "-q"); git(attacker, "fetch", "-q", f.url, refUser); git(attacker, "checkout", "-qb", "fixture", "FETCH_HEAD");
  writeFileSync(join(attacker, "forbidden-private-file"), "not a transport tree"); git(attacker, "add", "forbidden-private-file");
  git(attacker, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "later realm invalid fixture"); git(attacker, "push", "-q", f.url, `HEAD:${refUser}`);
  const bytes = jsonlBytes(f.receiver.a.dir), pending = readFileSync(f.pending), before = refs(f.url);
  expect(await syncMemory(f.receiver.a, { remote: f.url, ...privateRemote })).toMatchObject({ ok: false, pushed: false, error: expect.stringContaining("forbidden historical tree entry") });
  expect(jsonlBytes(f.receiver.a.dir)).toEqual(bytes); expect(readFileSync(f.pending)).toEqual(pending); expect(refs(f.url)).toBe(before);
}, 20_000);

test("pending transport recovery cannot append when atomic publication fails", async () => {
  const f = await interruptedPruneImport("partial"), binaries = temp(), actualGit = Bun.which("git");
  expect(actualGit).toBeDefined();
  writeFileSync(join(binaries, "git"), `#!${process.execPath}\nconst args=process.argv.slice(2);if(args.includes("push"))process.exit(1);const result=Bun.spawnSync([${JSON.stringify(actualGit)},...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(result.exitCode);\n`, { mode: 0o755 });
  const originalPath = process.env.PATH, bytes = jsonlBytes(f.receiver.a.dir), pending = readFileSync(f.pending), before = refs(f.url);
  process.env.PATH = `${binaries}:${originalPath}`;
  try { expect(await syncMemory(f.receiver.a, { remote: f.url, ...privateRemote })).toMatchObject({ ok: false, pushed: false, error: expect.stringContaining("selected-ref push failed") }); }
  finally { process.env.PATH = originalPath; }
  expect(jsonlBytes(f.receiver.a.dir)).toEqual(bytes); expect(readFileSync(f.pending)).toEqual(pending); expect(refs(f.url)).toBe(before);
}, 20_000);


test("unexpected shard sync errors are observable only through the opt-in internal test port", async () => {
  const source = await split(G1), unexpected = new Error("PRIVATE_UNEXPECTED_DIAGNOSTIC_CANARY");
  const options = { remote: "synthetic-private-remote", visibility: async (): Promise<"private"> => { throw unexpected; } };
  const methods = ["log", "warn", "error"] as const, saved = methods.map(key => console[key]), logs: unknown[][] = [];
  for (const key of methods) console[key] = (...args: unknown[]) => { logs.push(args); };
  try {
    const ordinary = await syncMemory(source.a, options), seen: unknown[] = [];
    expect(ordinary).toMatchObject({ ok: false, pushed: false, error: "shard sync unavailable" });
    expect(await syncShardedMemory(source.a, options, error => { seen.push(error); })).toEqual(ordinary);
    expect(seen).toEqual([unexpected]); expect(JSON.stringify(ordinary)).not.toContain("PRIVATE_UNEXPECTED_DIAGNOSTIC_CANARY");
    expect(await syncShardedMemory(source.a, options, () => { throw new Error("PRIVATE_OBSERVER_FAILURE"); })).toEqual(ordinary);
    let expectedRefusals = 0;
    expect(await syncShardedMemory(source.a, { remote: "synthetic-private-remote", visibility: async () => "public" }, () => { expectedRefusals++; })).toMatchObject({ ok: false, pushed: false });
    expect(expectedRefusals).toBe(0); expect(logs).toEqual([]);
  } finally { for (const [index, key] of methods.entries()) console[key] = saved[index]!; }
});

test("owned shard cache sync never launches automatic Git maintenance beside strict cache validation", async () => {
  const url = remote(), source = await split(G1), receiver = await split(G1), diagnostics = temp(), trace = join(diagnostics, "git-trace.jsonl"), config = join(diagnostics, "gitconfig");
  // The remote is a separate repository; only the two owned client caches are under this contract.
  git(url, "config", "maintenance.auto", "false"); git(url, "config", "gc.auto", "0");
  writeFileSync(config, "[maintenance]\n\tauto = true\n[gc]\n\tauto = 1\n");
  const oldTrace = process.env.GIT_TRACE2_EVENT, oldConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_TRACE2_EVENT = trace; process.env.GIT_CONFIG_GLOBAL = config;
  try {
    source.a.note(note(A, "ordinary cache maintenance regression"));
    expect(await syncMemory(source.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
    expect(await syncMemory(receiver.a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
    const events = readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { event?: string; argv?: string[] });
    const automatic = events.filter(event => event.event === "child_start" && event.argv?.includes("--auto")
      && (event.argv.includes("maintenance") || event.argv.includes("gc"))).map(event => event.argv!.includes("maintenance") ? "maintenance run --auto" : "gc --auto");
    expect(automatic).toEqual([]);
    expect(receiver.a.search("ordinary cache maintenance regression", { project: A }).hits).toHaveLength(1);
  } finally {
    if (oldTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = oldTrace;
    if (oldConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldConfig;
  }
}, 20_000);
