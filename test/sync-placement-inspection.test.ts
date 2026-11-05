import { afterEach, expect, test } from "bun:test";
import { canonicalJSON } from "../src/memory/generation.ts";
import { planPrune, applyPrune } from "../src/memory/prune.ts";
import { placementKeyId } from "../src/memory/sync-placement-journal-format.ts";
import { memoryGitEnv } from "../src/memory/platform.ts";
import { inspectSyncPlacement, MemoryStore, openShardStore, syncMemory, holdPlacementRow } from "../src/index.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { mkdtempSync, writeFileSync, truncateSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlacementInspectionFixture, inspectionNote, inspectionFilesystemSnapshot, INSPECTION_PROJECT, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";

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
