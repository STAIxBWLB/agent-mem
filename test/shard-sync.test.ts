import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { appendAlias, shardDir, shardKeyHash } from "../src/memory/shard.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { applyPrune, planPrune, pruneId, reducePruneRows, pruneRowHash } from "../src/memory/prune.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
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
