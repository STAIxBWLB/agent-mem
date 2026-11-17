import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlacementInspectionFixture, inspectionGit, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";
import { canonicalJSON, generationDescriptor, hashJSON, writeProfileJSON } from "../src/memory/generation.ts";
import { ensureShardDescriptor, shardDir } from "../src/memory/shard.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { runCli } from "../src/cli.ts";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";

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

test("#448 N-1: 0.28.2 ignores an unknown top-level extension record during old-realm sync", async () => {
  const f = await createPlacementInspectionFixture(); homes.push(f);
  const record = canonicalJSON({ schema: "agent-mem.realm-extension-probe/v1", epoch: f.epochHash }) + "\n";
  writeFileSync(join(f.home, "placement-realm-extensions.jsonl"), record, { mode: 0o600 });
  // A complete synthetic new shard models post-commit local materialization, not admission authority.
  const newProject = "example.test/placement/new-realm";
  installSyntheticRealm(f.home, f.generation, newProject);
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
  expect(inspectionGit(f.remote, "rev-list", "--all")).not.toBe("");
}, 180_000);


test("#448 N-1: 0.28.2 writer renewal ignores the new top-level extension probe", async () => {
  const runtime = previousRuntime(), extraRuntime = previousRuntime(), f = await placementActivationFixture(); roots.push(f.root);
  const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  try {
    await runCli(["formats", "raise", "home", "0.22.0", "--confirm"], { cwd: f.cwd, env: {}, processTable: () => "" });
    const initial = f.options("apply"); initial.writerRoots = [activationOwnRoot, runtime];
    expect((await activateSyncPlacement(initial)).active).toBe(true);
    const active = JSON.parse(readFileSync(join(f.base, "profile.json"), "utf8"));
    writeFileSync(join(f.base, "placement-realm-extensions.jsonl"), canonicalJSON({ schema: "agent-mem.realm-extension-probe/v1", epoch: active.placementHead }) + "\n", { mode: 0o600 });
    installSyntheticRealm(f.base, active.generation, "example.test/placement/renewal-new-realm");
    const source = `import { activateSyncPlacement } from ${JSON.stringify(join(runtime, "src/memory/sync-placement-activation.ts"))};
const result = await activateSyncPlacement({ memoryDir: ${JSON.stringify(f.base)}, mode: "apply", writerRoots: ${JSON.stringify([activationOwnRoot, runtime, extraRuntime])}, ownRoot: ${JSON.stringify(runtime)}, authorize: () => true });
console.log(JSON.stringify(result));`;
    const child = Bun.spawnSync([process.execPath, "--smol", "-e", source], { env: { PATH: process.env.PATH ?? "", HOME: f.root, AMEM_HOME: f.base, TMPDIR: f.root }, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    expect(child.exitCode, child.stderr.toString()).toBe(0); expect(JSON.parse(child.stdout.toString())).toMatchObject({ active: true, renewed: true, sequence: 1 });
  } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
}, 180_000);
