import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { realPath } from "../src/memory/platform.ts";
import { acquireMutation, type MutationHandle } from "../src/memory/mutation.ts";
import { PLACEMENT_FORMAT } from "../src/memory/sync-placement-format.ts";
import { planSyncPlacementActivation, type SyncPlacementActivationContext } from "../src/memory/sync-placement-plan.ts";
import { PLACEMENT_EPOCH_SCHEMA, placementEpochHash, SyncPlacementJournalError, type PlacementEpoch } from "../src/memory/sync-placement-journal-format.ts";
import { PLACEMENT_ACTIVATION_INTENT_SCHEMA, PLACEMENT_ACTIVATION_INTENT_FILE, sealPlacementActivationIntent, readPlacementActivationIntent, writePlacementActivationIntent,
  clearPlacementActivationIntent, placementActivationFinalMarkers, type PlacementActivationIntentBody, type PlacementActivationMarkerStamp } from "../src/memory/sync-placement-activation-storage.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const text = (value: unknown) => canonicalJSON(value) + "\n";
function fixture() {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-placement-activation-storage-"))); chmodSync(home, 0o700); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = { schema: "agent-mem.profile/v2", kind: "generation", generation: "a".repeat(32), foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: "b".repeat(64) };
  const shards = { schema: "agent-mem.shards/v2", generation: profile.generation, phase: "active", selectorRevision: hashJSON(profile), sources: [], machine: { id: "c".repeat(16), label: "activation fixture" } };
  const root = lstatSync(home, { bigint: true });
  const context: SyncPlacementActivationContext = { profile, shards, homeHash: hashJSON([home, String(root.dev), String(root.ino), String(root.uid)]), sourceHash: "d".repeat(64), aliasesHash: "e".repeat(64), policyHash: "f".repeat(64), realms: [],
    writers: [{ writerId: "1".repeat(64), version: "0.21.0", pin: "2".repeat(64), publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true };
  const epoch: PlacementEpoch = { schema: PLACEMENT_EPOCH_SCHEMA, publicationFormat: PLACEMENT_FORMAT, generation: profile.generation, homeHash: context.homeHash, contextHash: hashJSON(context), nonce: "3".repeat(32) };
  const plan = planSyncPlacementActivation(context, placementEpochHash(epoch)), previousProfile = text(profile), previousShards = text(shards);
  writeFileSync(join(home, "profile.json"), previousProfile, { mode: 0o600 }); writeFileSync(join(home, "shards.json"), previousShards, { mode: 0o600 });
  const stamp = (name: string): PlacementActivationMarkerStamp => { const s = lstatSync(join(home, name), { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String) as PlacementActivationMarkerStamp; };
  const body: PlacementActivationIntentBody = { schema: PLACEMENT_ACTIVATION_INTENT_SCHEMA, home, epoch, plan, roots: [join(home, "install")], previousProfile, previousShards,
    profileStamp: stamp("profile.json"), shardsStamp: stamp("shards.json"), floorHash: "4".repeat(64) };
  const intent = sealPlacementActivationIntent(body), mutation = acquireMutation(home); if (!mutation) throw Error("fixture home mutation unavailable"); cleanup.push(mutation);
  return { home, body, intent, file: join(home, PLACEMENT_ACTIVATION_INTENT_FILE), proof: { mutation, assertCurrent() {} } };
}
function snapshot(home: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const visit = (file: string) => { const s = lstatSync(file, { bigint: true }); output[file.slice(home.length)] = [String(s.dev), String(s.ino), String(s.mode), String(s.nlink), String(s.size), String(s.mtimeNs), String(s.ctimeNs),
    s.isFile() ? readFileSync(file).toString("base64") : s.isSymbolicLink() ? readlinkSync(file) : null]; if (s.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name)); };
  visit(home); return output;
}
function code(work: () => unknown) { try { work(); } catch (error) { expect(error).toBeInstanceOf(SyncPlacementJournalError); return (error as SyncPlacementJournalError).code; } throw Error("expected refusal"); }
const staging = (f: ReturnType<typeof fixture>) => f.file + ".pending-" + createHash("sha256").update(text(f.intent)).digest("hex");

test("closed initial intent binds epoch/base markers/stamp sizes and derives the exact existing v3 pair", () => {
  const f = fixture(); expect(sealPlacementActivationIntent(f.body)).toEqual(f.intent);
  const markers = placementActivationFinalMarkers(f.intent); expect(JSON.parse(markers.profile)).toEqual(f.intent.plan.targetProfile);
  expect(hashJSON(JSON.parse(markers.shards))).toBe(f.intent.plan.targetShardsHash);
  expect(JSON.parse(markers.shards)).toMatchObject({ schema: "agent-mem.shards/v3", generation: f.intent.epoch.generation, publicationFormat: PLACEMENT_FORMAT, placementHead: placementEpochHash(f.intent.epoch) });
  expect(code(() => sealPlacementActivationIntent({ ...f.body, profileStamp: ["1", "2", "0", "3", "4"] }))).toBe("invalid");
  expect(() => sealPlacementActivationIntent({ ...f.body, plan: { ...f.body.plan, targetShardsHash: "5".repeat(64) } })).toThrow();
  expect(() => sealPlacementActivationIntent({ ...f.body, roots: ["relative-install"] })).toThrow();
});

test("codec rejects getters/proxies/unknown fields without evaluating caller data or errors", () => {
  const f = fixture(); let called = 0;
  const getter = Object.defineProperty({ ...f.body }, "epoch", { enumerable: true, get() { called++; throw Error("private caller data"); } });
  expect(() => sealPlacementActivationIntent(getter)).toThrow(); expect(called).toBe(0);
  expect(() => sealPlacementActivationIntent(new Proxy(f.body, { getPrototypeOf() { called++; throw Error("private caller data"); } }))).toThrow(); expect(called).toBe(0);
  expect(() => sealPlacementActivationIntent({ ...f.body, unsupported: true } as PlacementActivationIntentBody)).toThrow();
});

test("read is no-effect and initial write is immutable/idempotent without marker or floor writes", () => {
  const f = fixture(), profile = readFileSync(join(f.home, "profile.json")), shards = readFileSync(join(f.home, "shards.json"));
  expect(readPlacementActivationIntent(f.home)).toBeUndefined(); writePlacementActivationIntent(f.home, f.intent, f.proof); f.proof.mutation();
  const before = snapshot(f.home); expect(readPlacementActivationIntent(f.home)).toEqual(f.intent); expect(snapshot(f.home)).toEqual(before);
  expect(readFileSync(join(f.home, "profile.json"))).toEqual(profile); expect(readFileSync(join(f.home, "shards.json"))).toEqual(shards); expect(existsSync(join(f.home, "formats.json"))).toBe(false);
  const next = acquireMutation(f.home); if (!next) throw Error("replacement home fence unavailable"); cleanup.push(next);
  writePlacementActivationIntent(f.home, f.intent, { ...f.proof, mutation: next }); expect(readPlacementActivationIntent(f.home)).toEqual(f.intent);
  const changed = sealPlacementActivationIntent({ ...f.body, floorHash: "5".repeat(64) }), stable = snapshot(f.home);
  expect(code(() => writePlacementActivationIntent(f.home, changed, { ...f.proof, mutation: next }))).toBe("conflict"); expect(snapshot(f.home)).toEqual(stable);
});

test("missing/forged/released kernel proof and throwing source proof refuse before publication", () => {
  const f = fixture(), before = snapshot(f.home);
  expect(code(() => writePlacementActivationIntent(f.home, f.intent, { ...f.proof, mutation: (() => {}) as MutationHandle }))).toBe("busy"); expect(snapshot(f.home)).toEqual(before);
  let traps = 0; const hostile = new Proxy({}, { getPrototypeOf() { traps++; throw Error("private failure"); }, get() { traps++; throw Error("private failure"); } });
  expect(code(() => writePlacementActivationIntent(f.home, f.intent, { ...f.proof, assertCurrent() { throw hostile; } }))).toBe("changed"); expect(traps).toBe(0); expect(snapshot(f.home)).toEqual(before);
  f.proof.mutation(); expect(code(() => writePlacementActivationIntent(f.home, f.intent, f.proof))).toBe("busy"); expect(existsSync(f.file)).toBe(false);
});

test("reader permits only the recognized immutable-helper two-link companion without recovering it", () => {
  const f = fixture(); writePlacementActivationIntent(f.home, f.intent, f.proof); const temp = staging(f); linkSync(f.file, temp);
  const before = snapshot(f.home); expect(readPlacementActivationIntent(f.home)).toEqual(f.intent); expect(snapshot(f.home)).toEqual(before); expect(lstatSync(temp).nlink).toBe(2);
  expect(code(() => clearPlacementActivationIntent(f.home, f.intent, f.proof))).toBe("pending"); expect(snapshot(f.home)).toEqual(before);
  writePlacementActivationIntent(f.home, f.intent, f.proof); expect(existsSync(temp)).toBe(false); expect(lstatSync(f.file).nlink).toBe(1);
});

for (const damage of ["noncanonical", "seal", "mode", "wrong-hardlink", "symlink", "oversize", "wrong-home"] as const) test("initial intent read refuses unsafe or unrelated evidence: " + damage, () => {
  const f = fixture(); writePlacementActivationIntent(f.home, f.intent, f.proof);
  if (damage === "noncanonical") writeFileSync(f.file, JSON.stringify(f.intent, null, 2) + "\n", { mode: 0o600 });
  else if (damage === "seal") writeFileSync(f.file, text({ ...f.intent, seal: "9".repeat(64) }), { mode: 0o600 });
  else if (damage === "mode") chmodSync(f.file, 0o644);
  else if (damage === "wrong-hardlink") linkSync(f.file, join(f.home, "unrelated-link"));
  else if (damage === "symlink") { renameSync(f.file, f.file + ".retained"); symlinkSync(f.file + ".retained", f.file); }
  else if (damage === "oversize") truncateSync(f.file, 1024 * 1024 + 1);
  else { const other = fixture(); writeFileSync(other.file, text(f.intent), { mode: 0o600 }); expect(() => readPlacementActivationIntent(other.home)).toThrow(); return; }
  const before = snapshot(f.home); expect(() => readPlacementActivationIntent(f.home)).toThrow(); expect(snapshot(f.home)).toEqual(before);
});

for (const failedSync of [1, 2]) test("exact immutable intent retries retained temp/pair after fsync fault " + failedSync, () => {
  const f = fixture(), actual = fs.fsyncSync; let count = 0;
  const fault = spyOn(fs, "fsyncSync").mockImplementation(fd => { if (++count === failedSync) throw Error("retained activation fsync fault"); return actual(fd); });
  try { expect(() => writePlacementActivationIntent(f.home, f.intent, f.proof)).toThrow(); }
  finally { fault.mockRestore(); }
  const before = snapshot(f.home), read = readPlacementActivationIntent(f.home); expect(snapshot(f.home)).toEqual(before);
  if (failedSync === 1) expect(read).toBeUndefined(); else expect(read).toEqual(f.intent);
  writePlacementActivationIntent(f.home, f.intent, f.proof); expect(readPlacementActivationIntent(f.home)).toEqual(f.intent); expect(existsSync(staging(f))).toBe(false);
});

test("oversized unregistered own staging is refused before shared helper can read it", () => {
  const f = fixture(), file = staging(f); writeFileSync(file, "", { mode: 0o600 }); truncateSync(file, 1024 * 1024 + 1);
  expect(code(() => writePlacementActivationIntent(f.home, f.intent, f.proof))).toBe("bound"); expect(existsSync(f.file)).toBe(false); expect(lstatSync(file).size).toBe(1024 * 1024 + 1);
});

test("clear removes only exact intent bytes/inode, and retries missing-name directory fsync after a fault", () => {
  const f = fixture(); writePlacementActivationIntent(f.home, f.intent, f.proof);
  const changed = sealPlacementActivationIntent({ ...f.body, floorHash: "8".repeat(64) }), before = snapshot(f.home);
  expect(code(() => clearPlacementActivationIntent(f.home, changed, f.proof))).toBe("conflict"); expect(snapshot(f.home)).toEqual(before);
  const fault = spyOn(fs, "fsyncSync").mockImplementation(() => { throw Error("clear fsync fault"); });
  try { expect(() => clearPlacementActivationIntent(f.home, f.intent, f.proof)).toThrow(); }
  finally { fault.mockRestore(); }
  expect(existsSync(f.file)).toBe(false); clearPlacementActivationIntent(f.home, f.intent, f.proof); expect(readPlacementActivationIntent(f.home)).toBeUndefined();
});

test("replacement at the final clear proof is preserved instead of unlinked", () => {
  const f = fixture(); writePlacementActivationIntent(f.home, f.intent, f.proof); let checks = 0, replaced = false;
  expect(code(() => clearPlacementActivationIntent(f.home, f.intent, { ...f.proof, assertCurrent() {
    if (++checks === 2 && !replaced) { replaced = true; renameSync(f.file, f.file + ".original"); writeFileSync(f.file, text(f.intent), { mode: 0o600 }); }
  } }))).toBe("changed");
  expect(replaced).toBe(true); expect(readPlacementActivationIntent(f.home)).toEqual(f.intent); expect(existsSync(f.file + ".original")).toBe(true);
});


test("valid original v2 formatting is retained byte-for-byte while final v3 markers stay canonical", () => {
  const f = fixture(), previousProfile = JSON.stringify(JSON.parse(f.body.previousProfile), null, 2) + "\n\n", previousShards = "  " + JSON.stringify(JSON.parse(f.body.previousShards), null, 2) + "\n";
  writeFileSync(join(f.home, "profile.json"), previousProfile, { mode: 0o600 }); writeFileSync(join(f.home, "shards.json"), previousShards, { mode: 0o600 });
  const stamp = (name: string): PlacementActivationMarkerStamp => { const s = lstatSync(join(f.home, name), { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String) as PlacementActivationMarkerStamp; };
  const body: PlacementActivationIntentBody = { ...f.body, previousProfile, previousShards, profileStamp: stamp("profile.json"), shardsStamp: stamp("shards.json") };
  const intent = sealPlacementActivationIntent(body); writePlacementActivationIntent(f.home, intent, f.proof);
  expect(readPlacementActivationIntent(f.home)?.previousProfile).toBe(previousProfile); expect(readPlacementActivationIntent(f.home)?.previousShards).toBe(previousShards);
  const final = placementActivationFinalMarkers(intent); expect(final.profile).toBe(text(JSON.parse(final.profile))); expect(final.shards).toBe(text(JSON.parse(final.shards)));
});
