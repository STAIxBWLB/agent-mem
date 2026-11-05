import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SpawnSyncOptionsWithBufferEncoding, SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { planPrune, applyPrune } from "../src/memory/prune.ts";
import { placementKeyId } from "../src/memory/sync-placement-journal-format.ts";
import { memoryGitEnv } from "../src/memory/platform.ts";
import * as platform from "../src/memory/platform.ts";
import { PlacementInspectionObjects } from "../src/memory/sync-placement-inspection-evidence.ts";
import { inspectSyncPlacement, MemoryStore, openShardStore, syncMemory, holdPlacementRow } from "../src/index.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { mkdtempSync, writeFileSync, truncateSync, rmSync, renameSync, symlinkSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlacementInspectionFixture, inspectionNote, inspectionFilesystemSnapshot, inspectionGit, INSPECTION_PROJECT, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";

const fixtures: PlacementInspectionFixture[] = [];
const close: (() => void)[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); for (const done of close.splice(0).reverse()) done(); });
async function fixture() { const result = await createPlacementInspectionFixture(); fixtures.push(result); return result; }

test("read-only Git diagnostics drop inherited trace/config/test switches without changing normal Git environment semantics", () => {
  const input = { PATH: "/toolchain", HOME: "/fixture", GIT_TRACE: "/unrelated-log", GIT_TRACE2_EVENT: "/another-log", GIT_TEST_REV_INDEX_WRITE: "1", GIT_DIR: "/other-repository" };
  const output = memoryGitEnv(input, { repositoryIsolation: true, readOnlyDiagnostic: true });
  expect(output).toMatchObject({ PATH: input.PATH, HOME: input.HOME, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" });
  for (const key of ["GIT_TRACE", "GIT_TRACE2_EVENT", "GIT_TEST_REV_INDEX_WRITE", "GIT_DIR"]) expect(output[key]).toBeUndefined();
  expect(memoryGitEnv(input).GIT_TRACE).toBe(input.GIT_TRACE); expect(input.GIT_DIR).toBe("/other-repository");
});

test("read-only placement capture retains special originals without inserting them into ordinary transport sources", async () => {
  const f = await fixture(), first = f.capture();
  const target = [...first.rows.values()].find(source => source.key.id === f.ids.project)!;
  const link = f.store.recordVaultLink(target.key.id, "notes/public.md", f.project, target.key.rowHash);
  const expiring = f.store.note(inspectionNote("ordinary expiring original", f.project));
  expect(f.store.demote(expiring, "person", f.project)).toBeDefined(); f.clock.now += 2000;
  const auth = { project: f.project, actor: "person" as const, authorize: () => true,
    policy: { revision: () => "isolated-prune-policy", classify: () => "public" as const, attest: () => true } };
  const plan = planPrune(f.store.prunePort(), { cutoff: new Date(f.clock.now).toISOString(), targets: [expiring] }, auth);
  expect(plan.rows).toHaveLength(1); expect(applyPrune(f.store.prunePort(), plan, auth).completed).toContain(plan.rows[0]!.payload.id);
  const before = f.snapshot(), capture = f.capture(); capture.assertCurrent();
  expect(f.snapshot()).toEqual(before);
  const specials = [...capture.specialRows.values()];
  expect(specials.find(source => source.key.id === link)).toMatchObject({ sourcePlacement: "local", intrinsicLocal: true, row: { op: "vault_link" } });
  expect(specials.find(source => source.key.id === plan.rows[0]!.payload.id)).toMatchObject({ sourcePlacement: "synced", row: { op: "prune" } });
  for (const special of specials) expect(capture.rows.has(placementKeyId(special.key))).toBe(false);
  expect(capture.sourceRowsByRealm.get(canonicalJSON(target.key.realm))?.some(source => source.row.id === expiring)).toBe(true);
}, 20_000);

test("the diagnostic source metadata shares the same full recapture drift guard", async () => {
  const f = await fixture(), captured = f.capture();
  f.store.note(inspectionNote("appended after read-only capture", f.project));
  expect(() => captured.assertCurrent()).toThrow();
});

for (const profile of ["shared-v1", "generation", "sharded", "sharded-v2"] as const) test(`inactive ${profile} reports exact migration/activation steps without effects or a fingerprint`, async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-placement-inactive-")), home = join(root, "memory"); close.push(() => rmSync(root, { recursive: true, force: true }));
  let store = new MemoryStore({ memoryDir: home, profile: "shared-v1", deferPromotions: true }); store.note(inspectionNote("inactive fixture source"));
  if (profile !== "shared-v1") {
    store.close();
    if (profile === "generation") {
      await migrate({ memoryDir: home, generation: "3".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
      store = new MemoryStore({ memoryDir: home, deferPromotions: true });
    } else {
      await migrateShards({ memoryDir: home, generation: "4".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
      if (profile === "sharded-v2") await activatePublicPruneView({ memoryDir: home, mode: "apply", authorizedPerson: true, tty: true });
      store = openShardStore({ memoryDir: home, project: INSPECTION_PROJECT, deferPromotions: true });
    }
  }
  close.push(() => store.close()); const before = inspectionFilesystemSnapshot(root), result = await inspectSyncPlacement(store);
  expect(result.complete).toBe(false); expect("fingerprint" in result).toBe(false);
  if (result.complete) throw Error("inactive fixture unexpectedly active");
  expect(result.reason).toBe("placement-not-active"); expect(result.nextStep).toContain("person-authorized placement activation");
  if (!store.profile.sharded) expect(result.nextStep).toContain("amem migrate --shards --dry-run");
  if (!store.profile.foreignPruneFormat) expect(result.nextStep).toContain("amem migrate --public-prune-view --apply");
  expect(inspectionFilesystemSnapshot(root)).toEqual(before);
});

test("missing and mismatched fresh attestations fail closed without a fingerprint", async () => {
  const f = await fixture(), before = f.snapshot();
  const absent = await inspectSyncPlacement(f.store); expect(absent).toMatchObject({ complete: false, reason: "attestation-unavailable" }); expect("fingerprint" in absent).toBe(false);
  const bad = await inspectSyncPlacement(f.store, { placementAttestation: () => ({ ...f.port.attest(), writers: f.port.attest().writers.map(writer => ({ ...writer, pin: "9".repeat(64) })) }) });
  expect(bad).toMatchObject({ complete: false, reason: "attestation-unavailable" }); expect("fingerprint" in bad).toBe(false); expect(f.snapshot()).toEqual(before);
});

test("a retained v2 handle cannot mislabel a rolled-back v3 fence as inactive", async () => {
  const f = await fixture(), profileFile = join(f.home, "profile.json"), shardsFile = join(f.home, "shards.json"), fence = join(f.home, "sync-placement", "active.json"), saved = join(f.root, "saved-owned-fence.json");
  const profileBytes = readFileSync(profileFile), shardBytes = readFileSync(shardsFile), profile = JSON.parse(profileBytes.toString()), shards = JSON.parse(shardBytes.toString());
  const { publicationFormat: _pf, placementHead: _ph, ...profileBase } = profile, v2 = { ...profileBase, schema: "agent-mem.profile/v2" };
  const { publicationFormat: _sf, placementHead: _sh, ...shardBase } = shards;
  let old: MemoryStore | undefined;
  try {
    // Fixture-only ordering models a live v2 reader retained across later activation and marker rollback.
    renameSync(fence, saved); writeFileSync(profileFile, canonicalJSON(v2) + "\n");
    writeFileSync(shardsFile, canonicalJSON({ ...shardBase, schema: "agent-mem.shards/v2", selectorRevision: hashJSON(v2) }) + "\n");
    old = openShardStore({ memoryDir: f.home, project: f.project, deferPromotions: true }); renameSync(saved, fence);
    const before = f.snapshot(), report = await inspectSyncPlacement(old, f.opts());
    expect(report).toMatchObject({ complete: false, reason: "binding-changed" }); expect("fingerprint" in report).toBe(false); expect(f.snapshot()).toEqual(before);
  } finally {
    old?.close(); if (existsSync(saved)) renameSync(saved, fence); writeFileSync(profileFile, profileBytes); writeFileSync(shardsFile, shardBytes);
  }
}, 20_000);

for (const kind of ["bytes", "rows", "torn"] as const) test(`incomplete ${kind} source never returns a fingerprint or heals input`, async () => {
  const f = await fixture(), file = join(f.store.dir, "log", `${f.store.machine.id}.jsonl`);
  writeFileSync(file, kind === "rows" ? "{}\n".repeat(20001) : kind === "torn" ? "{unfinished" : "", { mode: 0o600 });
  if (kind === "bytes") truncateSync(file, 8 * 1024 * 1024 + 1);
  const before = f.snapshot(), result = await inspectSyncPlacement(f.store, f.opts());
  expect(result.complete).toBe(false); expect("fingerprint" in result).toBe(false);
  if (!result.complete && kind !== "torn") expect(result.reason).toBe("input-bound");
  expect(f.snapshot()).toEqual(before);
});

test("unknown journal metadata is incomplete without mutation or a fingerprint", async () => {
  const f = await fixture(), file = join(f.home, "sync-placement", "epochs", f.epochHash, "unknown.json");
  writeFileSync(file, "{}\n", { mode: 0o600 }); const before = f.snapshot(), result = await inspectSyncPlacement(f.store, f.opts());
  expect(result).toMatchObject({ complete: false, reason: "journal-unavailable" }); expect("fingerprint" in result).toBe(false); expect(f.snapshot()).toEqual(before);
});

test("caller error messages and option getters are never read into diagnostics", async () => {
  const f = await fixture(); let messages = 0, getters = 0;
  const secret = "DO_NOT_RETURN_PRIVATE_CALLER_PATTERN", error = Object.defineProperty({}, "message", { get() { messages++; return secret; } });
  const result = await inspectSyncPlacement(f.store, { ...f.opts(), screen() { throw error; } });
  expect(result).toMatchObject({ complete: false, reason: "policy-unavailable" }); expect("fingerprint" in result).toBe(false); expect(messages).toBe(0); expect(JSON.stringify(result)).not.toContain(secret);
  const options = Object.defineProperty({}, "screen", { enumerable: true, get() { getters++; return () => true; } });
  expect(await inspectSyncPlacement(f.store, options)).toMatchObject({ complete: false, reason: "policy-unavailable" }); expect(getters).toBe(0);
});

test("source mutation from a host screen makes the full inspection incomplete", async () => {
  const f = await fixture(); let changed = false;
  const result = await inspectSyncPlacement(f.store, { ...f.opts(), screen() { if (!changed) { changed = true; f.store.note(inspectionNote("changed during callback", f.project)); } return true; } });
  expect(changed).toBe(true); expect(result.complete).toBe(false); expect("fingerprint" in result).toBe(false);
});

test("a policy-version change cannot produce a complete fingerprint", async () => {
  const f = await fixture(); let version = 0;
  const result = await inspectSyncPlacement(f.store, { ...f.opts(), policyVersion: () => String(version++) });
  expect(result.complete).toBe(false); expect("fingerprint" in result).toBe(false);
});

test("intrinsically local short notes and vault links are reported without publishing or returning their bodies/paths", async () => {
  const f = await fixture(), source = [...f.capture().rows.values()].find(value => value.key.id === f.ids.project)!;
  const path = "notes/inspection-private-path.md", link = f.store.recordVaultLink(source.key.id, path, f.project, source.key.rowHash);
  const short = f.store.note({ ...inspectionNote("private short body not for a report", f.project), tier: "short" });
  const before = f.snapshot(), report = await inspectSyncPlacement(f.store, f.opts());
  expect(f.snapshot()).toEqual(before); expect(report.complete).toBe(true); if (!report.complete) throw Error("local fixture inspection incomplete");
  for (const id of [link, short]) expect(report.rows.find(row => row.id === id)).toMatchObject({ sourcePlacement: "local", disposition: "held", reason: "source-local" });
  expect(JSON.stringify(report)).not.toContain(path); expect(JSON.stringify(report)).not.toContain("private short body");
  expect((await syncMemory(f.store, f.opts())).ok).toBe(true); expect(f.reachableIds()).not.toContain(link); expect(f.reachableIds()).not.toContain(short);
}, 20_000);

test("a journal write in the last host callback cannot pass the final passive proof", async () => {
  const f = await fixture(); expect((await syncMemory(f.store, f.opts())).ok).toBe(true);
  let calls = 0;
  const baseline = await inspectSyncPlacement(f.store, { ...f.opts(), policyVersion: () => { calls++; return "initial"; } });
  expect(baseline.complete).toBe(true); const last = calls; expect(last).toBeGreaterThan(0);
  const source = [...f.capture().rows.values()].find(row => row.key.id === f.ids.project)!; calls = 0; let changed = false;
  const result = await inspectSyncPlacement(f.store, { ...f.opts(), policyVersion: () => {
    if (++calls === last) {
      changed = true; holdPlacementRow(f.home, { epochHash: f.epochHash, expectedHead: f.projection().headHash, requestId: "d".repeat(64), key: source.key }, f.port, "person");
    }
    return "initial";
  } });
  expect(changed).toBe(true); expect(result.complete).toBe(false); expect("fingerprint" in result).toBe(false);
  expect(f.projection().states.find(state => state.key.id === source.key.id)?.reasons).toContain("person-local");
}, 20_000);

for (const populated of [false, true]) test(`transport-parent symlink is refused even with ${populated ? "unchanged populated" : "no"} object-cache leaf`, async () => {
  const f = await fixture(); if (populated) expect((await syncMemory(f.store, f.opts())).ok).toBe(true);
  const root = join(f.home, "shard-sync-placement"), moved = join(f.root, "moved-private-cache");
  if (populated) renameSync(root, moved); else mkdirSync(moved, { mode: 0o700 });
  symlinkSync(moved, root); const before = f.snapshot(), report = await inspectSyncPlacement(f.store, f.opts());
  expect(report.complete).toBe(false); expect("fingerprint" in report).toBe(false); expect(f.snapshot()).toEqual(before);
  expect((await syncMemory(f.store, f.opts())).ok).toBe(false); expect(f.snapshot()).toEqual(before);
}, 20_000);

test("actual offline proof reads cannot inherit Git trace-file writes", async () => {
  const f = await fixture(); expect((await syncMemory(f.store, f.opts())).ok).toBe(true);
  const previous = process.env.GIT_TRACE, trace = join(f.root, "owned-trace-control.log"); process.env.GIT_TRACE = trace;
  try {
    inspectionGit(f.remote, "rev-parse", "--is-bare-repository"); expect(existsSync(trace)).toBe(true); rmSync(trace);
    const before = f.snapshot(), report = await inspectSyncPlacement(f.store, f.opts());
    expect(report.complete).toBe(true); expect(existsSync(trace)).toBe(false); expect(f.snapshot()).toEqual(before);
  } finally { if (previous === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = previous; }
}, 20_000);

test("synthetic object-reader port keeps graph overhead separate from the 8MiB physical-row limit", async () => {
  const f = await fixture(); expect((await syncMemory(f.store, f.opts())).ok).toBe(true);
  const reader = new PlacementInspectionObjects(f.home, () => {}), real = platform.memoryGitSync, bodies = new Map<string, Buffer>();
  // Valid raw Git blobs only, not a claimed publication/DAG. The actual source fixture remains tiny.
  for (let index = 0; index < 150; index++) { const body = Buffer.from(`${index}:` + "metadata".repeat(7500)); bodies.set(createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex"), body); }
  const read = spyOn(platform, "memoryGitSync").mockImplementation(((args: string[], options: SpawnSyncOptionsWithBufferEncoding | SpawnSyncOptionsWithStringEncoding) => {
    const at = args.indexOf("cat-file"), body = at >= 0 ? bodies.get(args[at + 2]!) : undefined;
    if (!body) return Reflect.apply(real, platform, [args, options]);
    const stdout = args[at + 1] === "-t" ? Buffer.from("blob\n") : args[at + 1] === "-s" ? Buffer.from(String(body.length) + "\n") : body;
    return { pid: 0, stdout, stderr: Buffer.alloc(0), output: [null, stdout, Buffer.alloc(0)], status: 0, signal: null };
  }) as typeof platform.memoryGitSync);
  try {
    let bytes = 0; for (const [id, body] of bodies) { expect(reader.object(id, "blob", 1024 * 1024)).toEqual(body); bytes += body.length; }
    expect(bytes).toBeGreaterThan(8 * 1024 * 1024); reader.assertCurrent();
  } finally { read.mockRestore(); }
}, 20_000);
