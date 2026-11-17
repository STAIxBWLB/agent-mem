import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlacementInspectionFixture, inspectionFilesystemSnapshot, inspectionGit, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";
import { canonicalJSON, generationDescriptor, hashJSON, writeProfileJSON } from "../src/memory/generation.ts";
import { ensureShardDescriptor, shardDir } from "../src/memory/shard.ts";
import { memoryGitSync } from "../src/memory/platform.ts";
import { shardSyncRef } from "../src/memory/shard-sync-format.ts";
import { readPlacementJournal } from "../src/memory/sync-placement-journal-storage.ts";
import { readPublicPruneViewForActivation } from "../src/memory/public-prune-view.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { runCli } from "../src/cli.ts";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { readPlacementRuntimeMarkers } from "../src/memory/sync-placement-guard.ts";
import { readActivePlacementBinding } from "../src/memory/sync-placement-active.ts";
import { createRealmExtension, realmExtensionGenesis, REALM_EXTENSION_SCHEMA } from "../src/memory/sync-placement-realm-extension-format.ts";
import { readEffectiveRealmInventory } from "../src/memory/sync-placement-realm-effective.ts";
import { writerInventoryGenesis } from "../src/memory/sync-placement-writer-revision-format.ts";
import { activePlacementWriterContext } from "../src/sync-placement-writer-context.ts";
import { createHash } from "node:crypto";

const homes: PlacementInspectionFixture[] = [], roots: string[] = [];
afterEach(() => { for (const home of homes.splice(0).reverse()) home.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const RELEASE = "3f193b7c0947f165fe7628dafe976873c30d97d9"; // v0.28.2
function previousRuntime(): string {
  const root = mkdtempSync(join(tmpdir(), "amem-extension-n1-")); roots.push(root);
  const archive = Bun.spawnSync(["git", "archive", RELEASE], { stdout: "pipe", stderr: "pipe" });
  expect(archive.exitCode, archive.stderr.toString()).toBe(0);
  const extract = Bun.spawnSync(["tar", "-x", "-C", root], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
  expect(extract.exitCode, extract.stderr.toString()).toBe(0); return root;
}

function installSyntheticRealm(home: string, generation: string, project: string): void {
  const dir = shardDir(home, project); ensureShardDescriptor(home, project);
  for (const folder of ["log", "local", "legacy/log", "legacy/local", "legacy-main/log", "legacy-main/local"]) mkdirSync(join(dir, folder), { recursive: true, mode: 0o700 });
  const machine = JSON.parse(readFileSync(join(home, "machine.json"), "utf8")), descriptor = generationDescriptor(generation), sources: unknown[] = [];
  for (const [name, value] of [["generation.json", descriptor], ["machine.json", machine], ["legacy/machine.json", machine], ["legacy-main/machine.json", machine],
    ["migration-sources.json", { schema: "agent-mem.migration-sources/v1", sources }], ["generation-seal.json", { schema: "agent-mem.generation-seal/v1", generation: generation,
      descriptorHash: hashJSON(descriptor), sourceDigest: hashJSON({ sources, legacyCommit: undefined }) }]] as const) writeProfileJSON(join(dir, name), value);
}

test("#448 N-1: 0.28.2 ignores extension and leaves the unadmitted realm untouched", async () => {
  const f = await createPlacementInspectionFixture(); homes.push(f);
  // Synthetic sealed data exercises the old reader against the new record shape, not actual person admission.
  const markers = readPlacementRuntimeMarkers(f.home), active = readActivePlacementBinding(f.home, markers.profile, markers.shards)!;
  const newProject = "example.test/placement/new-realm", keyHash = createHash("sha256").update(newProject).digest("hex");
  const record = createRealmExtension({ schema: REALM_EXTENSION_SCHEMA, epochHash: f.epochHash, activationHash: active.activation.seal,
    homeHash: active.epoch.homeHash, generation: f.generation, sequence: 1, previousHash: realmExtensionGenesis(f.epochHash, active.activation.seal),
    realm: { scope: "project", keyHash, bindingHash: "1".repeat(64) }, sourceHash: "2".repeat(64), aliasesHash: "3".repeat(64), policyHash: "4".repeat(64),
    writerHash: writerInventoryGenesis(f.epochHash, active.activation.seal), journal: { sequence: 0, headHash: f.epochHash } });
  writeFileSync(join(f.home, "placement-realm-extensions.jsonl"), canonicalJSON(record) + "\n", { mode: 0o600 });
  installSyntheticRealm(f.home, f.generation, newProject);
  const shardBefore = inspectionFilesystemSnapshot(shardDir(f.home, newProject)), realmRef = shardSyncRef({ scope: "project", key: newProject });
  const tree = memoryGitSync(["-C", f.remote, "mktree"], { encoding: "utf8", input: "" }); expect(tree.status).toBe(0);
  const commit = memoryGitSync(["-C", f.remote, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit-tree", tree.stdout.trim(), "-m", "synthetic remote realm"], { encoding: "utf8" });
  expect(commit.status).toBe(0); inspectionGit(f.remote, "update-ref", realmRef, commit.stdout.trim());
  const remoteBefore = inspectionGit(f.remote, "rev-parse", realmRef), beforeView = readPublicPruneViewForActivation(f.home, active.profile.pruneInputSetHash, f.generation);
  const runtime = previousRuntime();
  const source = `import { openShardStore, syncMemory } from ${JSON.stringify(join(runtime, "src/index.ts"))};
let refused = false;
try { const newStore = openShardStore({ memoryDir: ${JSON.stringify(f.home)}, project: ${JSON.stringify(newProject)}, deferPromotions: true }); newStore.close(); }
catch (error) { if (!String(error).includes("outside the activated inventory")) throw error; refused = true; }
if (!refused) throw Error("old reader opened an unadmitted realm");
const store = openShardStore({ memoryDir: ${JSON.stringify(f.home)}, project: ${JSON.stringify(f.project)}, deferPromotions: true });
try {
  const result = await syncMemory(store, { remote: ${JSON.stringify(f.remote)}, visibility: async () => "private",
    placementAttestation: () => ({ writers: [{ writerId: "1".repeat(64), version: "0.22.0", pin: "2".repeat(64), publicationFormat: "agent-mem.sync-placement/v1", compatible: true }], legacySyncQuiesced: true }), policyVersion: () => "initial" });
  console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 2;
} finally { store.close(); }`;
  const child = Bun.spawnSync([process.execPath, "--smol", "-e", source], { env: { PATH: process.env.PATH ?? "", HOME: f.root, AMEM_HOME: f.home, TMPDIR: f.root }, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(JSON.parse(child.stdout.toString()).ok).toBe(true);
  expect(inspectionGit(f.remote, "rev-parse", realmRef)).toBe(remoteBefore);
  expect(inspectionFilesystemSnapshot(shardDir(f.home, newProject))).toEqual(shardBefore);
  const current = readPlacementRuntimeMarkers(f.home), bound = readActivePlacementBinding(f.home, current.profile, current.shards)!;
  const afterView = readPublicPruneViewForActivation(f.home, bound.profile.pruneInputSetHash, f.generation);
  expect(afterView.realms[`project:${newProject}`]).toEqual(beforeView.realms[`project:${newProject}`]);
  expect(readPlacementJournal(f.home, f.epochHash).records.some(row => row.key.realm.scope === "project" && row.key.realm.keyHash === keyHash)).toBe(false);

  // The same old writer must also leave an interrupted, generation-less staging
  // directory alone. The directory is an isolated fixture, not a real home.
  rmSync(join(shardDir(f.home, newProject), "generation.json"));
  const stagedBefore = inspectionFilesystemSnapshot(shardDir(f.home, newProject));
  const stagedRun = Bun.spawnSync([process.execPath, "--smol", "-e", source], { env: { PATH: process.env.PATH ?? "", HOME: f.root, AMEM_HOME: f.home, TMPDIR: f.root }, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  expect(stagedRun.exitCode, stagedRun.stderr.toString()).toBe(0);
  expect(JSON.parse(stagedRun.stdout.toString()).ok).toBe(true);
  expect(inspectionFilesystemSnapshot(shardDir(f.home, newProject))).toEqual(stagedBefore);
  expect(inspectionGit(f.remote, "rev-parse", realmRef)).toBe(remoteBefore);
  expect(readPlacementJournal(f.home, f.epochHash).records.some(row => row.key.realm.scope === "project" && row.key.realm.keyHash === keyHash)).toBe(false);
}, 180_000);


test("#448 N-1: old writer renewal keeps the committed extension as a historical prefix", async () => {
  const runtime = previousRuntime(), extraRuntime = previousRuntime(), f = await placementActivationFixture(); roots.push(f.root);
  const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  try {
    await runCli(["formats", "raise", "home", "0.22.0", "--confirm"], { cwd: f.cwd, env: {}, processTable: () => "" });
    const initial = f.options("apply"); initial.writerRoots = [activationOwnRoot, runtime];
    expect((await activateSyncPlacement(initial)).active).toBe(true);
    const markers = readPlacementRuntimeMarkers(f.base), active = readActivePlacementBinding(f.base, markers.profile, markers.shards)!;
    const project = "example.test/placement/renewal-new-realm", keyHash = createHash("sha256").update(project).digest("hex");
    const record = createRealmExtension({ schema: REALM_EXTENSION_SCHEMA, epochHash: active.profile.placementHead, activationHash: active.activation.seal,
      homeHash: active.epoch.homeHash, generation: active.epoch.generation, sequence: 1,
      previousHash: realmExtensionGenesis(active.profile.placementHead, active.activation.seal), realm: { scope: "project", keyHash, bindingHash: "1".repeat(64) },
      sourceHash: "2".repeat(64), aliasesHash: "3".repeat(64), policyHash: "4".repeat(64),
      writerHash: writerInventoryGenesis(active.profile.placementHead, active.activation.seal), journal: { sequence: 0, headHash: active.profile.placementHead } });
    writeFileSync(join(f.base, "placement-realm-extensions.jsonl"), canonicalJSON(record) + "\n", { mode: 0o600 });
    installSyntheticRealm(f.base, active.epoch.generation, project);
    expect(readEffectiveRealmInventory(f.base, active).realms).toContainEqual(record.realm);
    const source = `import { activateSyncPlacement } from ${JSON.stringify(join(runtime, "src/memory/sync-placement-activation.ts"))};
const result = await activateSyncPlacement({ memoryDir: ${JSON.stringify(f.base)}, mode: "apply", writerRoots: ${JSON.stringify([activationOwnRoot, runtime, extraRuntime])}, ownRoot: ${JSON.stringify(runtime)}, authorize: () => true });
console.log(JSON.stringify(result));`;
    const child = Bun.spawnSync([process.execPath, "--smol", "-e", source], { env: { PATH: process.env.PATH ?? "", HOME: f.root, AMEM_HOME: f.base, TMPDIR: f.root }, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    expect(child.exitCode, child.stderr.toString()).toBe(0); expect(JSON.parse(child.stdout.toString())).toMatchObject({ active: true, renewed: true, sequence: 1 });
    const effective = readEffectiveRealmInventory(f.base, active); expect(effective.realms).toContainEqual(record.realm);
    expect(activePlacementWriterContext(f.base, activationOwnRoot).attest().writers).toHaveLength(3);
    const log = join(f.base, "sync-placement", "epochs", active.profile.placementHead, "writer-revisions.jsonl"), original = readFileSync(log);
    writeFileSync(log, Buffer.from(original.toString().replace(/"seal":"[a-f0-9]{64}"/, `"seal":"${"0".repeat(64)}"`)));
    expect(() => readEffectiveRealmInventory(f.base, active)).toThrow();
    writeFileSync(log, original); expect(() => effective.assertCurrent()).toThrow();
  } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
}, 180_000);
