import { afterEach, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { createInspectionRemote, inspectionFilesystemSnapshot, reachableInspectionRowIds } from "./fakes/sync-placement-inspection.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

type HostApi = typeof import("../src/index.ts");
const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });

/** Real isolated install bytes, never dependencies, build products or another memory home. */
async function copiedHost(root: string) {
  const install = join(root, "host install"); mkdirSync(install, { mode: 0o700 });
  for (const name of ["src", "bin", "hooks", ".claude-plugin"]) cpSync(join(activationOwnRoot, name), join(install, name), { recursive: true, errorOnExist: true, force: false });
  copyFileSync(join(activationOwnRoot, "package.json"), join(install, "package.json"));
  expect(existsSync(join(install, "node_modules"))).toBe(false);
  const api = await import(pathToFileURL(join(install, "src", "index.ts")).href) as HostApi;
  expect(typeof api.createPlacementAttestation).toBe("function");
  return { install, api };
}
async function active(declareHost = true) {
  const f = await placementActivationFixture(); clean.push(f.close);
  const host = await copiedHost(f.root);
  await activateSyncPlacement({ ...f.options("apply"), writerRoots: declareHost ? [activationOwnRoot, host.install] : [activationOwnRoot] });
  return { ...f, ...host };
}
async function refusal(work: () => unknown | Promise<unknown>, category: string, causeClass?: string) {
  let caught: unknown;
  try { await work(); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ name: "PlacementWriterContextError", category, ...(causeClass ? { causeClass } : {}) });
  expect((caught as Error).message).toContain("amem migrate --sync-placement --dry-run");
  expect((caught as Error).message).not.toContain("NEVER_PUBLIC_ACTIVATION_BODY");
  expect((caught as Error).message).not.toContain("/host install");
  return caught as Error;
}

// Functional migration/transport fixtures use explicit test timeouts; no production deadline changes.
test("public host factory derives its copied package root and supplies read-only fresh attestations", async () => {
  const f = await active(), before = inspectionFilesystemSnapshot(f.base);
  const attest = f.api.createPlacementAttestation(f.base);
  expect(typeof attest).toBe("function");
  expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  const first = await attest(), second = await attest();
  expect(first).toEqual(second);
  expect(first).toMatchObject({ legacySyncQuiesced: true });
  expect(first.writers).toHaveLength(2);
  expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
}, 120_000);

test("declared copied host performs actual filtered sync without exposing the held original", async () => {
  const f = await active(), remote = createInspectionRemote(f.root);
  // Store, sync and attestation all come from this same independently imported package instance.
  const store = f.api.openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
  try {
    const result = await f.api.syncMemory(store, { remote, visibility: async () => "private", placementAttestation: f.api.createPlacementAttestation(f.base) });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.placementPublication).toMatchObject({ exported: 1, withheld: 1 });
    expect(reachableInspectionRowIds(remote)).toEqual([f.allowed]);
    expect(reachableInspectionRowIds(remote)).not.toContain(f.declined);
    expect(store.get(f.declined, f.project)?.text).toBe("NEVER_PUBLIC_ACTIVATION_BODY");
  } finally { store.close(); }
}, 120_000);

test("undeclared actual host package cannot impersonate an inventoried root through an extra JS argument", async () => {
  const f = await active(false), before = inspectionFilesystemSnapshot(f.base);
  // JavaScript can supply extra arguments; they cannot override import.meta.url authority.
  await refusal(async () => {
    const attest = Reflect.apply(f.api.createPlacementAttestation, undefined, [f.base, activationOwnRoot]) as ReturnType<HostApi["createPlacementAttestation"]>;
    return attest();
  }, "host package", "missing");
  expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
}, 120_000);

test("an already-created callback remeasures its copied host index pin at every call", async () => {
  const f = await active(), attest = f.api.createPlacementAttestation(f.base);
  await attest(); const before = inspectionFilesystemSnapshot(f.base);
  appendFileSync(join(f.install, "src", "index.ts"), "\n// isolated fixture pin changed after first host attestation\n");
  await refusal(() => attest(), "host package", "changed");
  expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
}, 120_000);

test("an already-created callback refuses an unreachable host install rather than trusting stored pins", async () => {
  const f = await active(), attest = f.api.createPlacementAttestation(f.base);
  await attest(); const before = inspectionFilesystemSnapshot(f.base);
  unlinkSync(join(f.install, "package.json"));
  await refusal(() => attest(), "host package", "unavailable");
  expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
}, 120_000);

for (const floor of ["missing", "lower", "future"] as const) test(`host callback names ${floor} home-floor refusal without placement effects`, async () => {
  const f = await active(), attest = f.api.createPlacementAttestation(f.base);
  await attest();
  const file = join(f.base, "formats.json");
  if (floor === "missing") unlinkSync(file);
  else writeFileSync(file, JSON.stringify([{ surface: "home", minReader: floor === "lower" ? "0.20.3" : "999.0.0", since: "2026-11-08" }]) + "\n", { mode: 0o600 });
  const before = inspectionFilesystemSnapshot(f.base);
  const error = await refusal(() => attest(), "home floor", "unavailable");
  expect(error.message).toContain("formats.json");
  expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
}, 120_000);

test("host callback rechecks newly applied setup receipts rather than caching completeness", async () => {
  const f = await active(), attest = f.api.createPlacementAttestation(f.base);
  await attest();
  const extra = join(f.root, "new configured writer");
  for (const dir of [extra, join(extra, "src"), join(extra, "bin")]) mkdirSync(dir, { mode: 0o755 });
  writeFileSync(join(extra, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.22.1" }), { mode: 0o644 });
  writeFileSync(join(extra, "src", "index.ts"), "// fixture install, never executed\n", { mode: 0o644 });
  writeFileSync(join(extra, "bin", "amem.js"), "// fixture install, never executed\n", { mode: 0o755 });
  const setup = join(f.base, "setup"); mkdirSync(setup, { mode: 0o700 });
  const image = (value: unknown) => ({ mode: 0o600, bytes: Buffer.from(JSON.stringify(value)).toString("base64") });
  writeFileSync(join(setup, "claude.json"), JSON.stringify({ version: 2, target: "claude", intent: "a".repeat(64), phase: "applied",
    changes: [0, 1].map(index => ({ key: `claude:${index}`, path: join(f.root, "home", index === 0 ? ".claude.json" : "settings.json"), before: { mode: 0o600, bytes: null },
      after: image(index === 0 ? { mcpServers: { amem: { command: process.execPath, args: ["--smol", join(extra, "bin", "amem.js"), "mcp"] } } } : {}) })) }), { mode: 0o600 });
  const before = inspectionFilesystemSnapshot(f.base);
  await refusal(() => attest(), "setup receipt", "missing");
  expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
}, 120_000);

test("public factory is lazy and ordinary legacy sync ignores its placement callback", async () => {
  const f = hookFixture(); clean.push(f.close);
  const { api } = await copiedHost(f.root);
  expect(existsSync(f.base)).toBe(false);
  const attest = api.createPlacementAttestation(f.base);
  expect(existsSync(f.base)).toBe(false);
  const store = new api.MemoryStore({ memoryDir: f.base, deferPromotions: true });
  const remote = createInspectionRemote(f.root); let called = 0;
  try {
    store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "legacy host fixture note", about: [] });
    const result = await api.syncMemory(store, { remote, visibility: async () => "private", placementAttestation: () => { called++; return attest(); } });
    expect(result.ok, JSON.stringify(result)).toBe(true); expect(called).toBe(0);
    expect(existsSync(join(f.base, "sync-placement"))).toBe(false);
    expect(existsSync(join(f.base, "sync-placement-writer-roots.json"))).toBe(false);
    expect(existsSync(join(f.base, "formats.json"))).toBe(false);
  } finally { store.close(); }
}, 120_000);


test("prepared v2 sync ignores the host port and keeps its whole-segment policy refusal", async () => {
  const f = await placementActivationFixture(); clean.push(f.close);
  const { api } = await copiedHost(f.root), attest = api.createPlacementAttestation(f.base);
  const remote = createInspectionRemote(f.root), store = api.openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
  let called = 0;
  try {
    const result = await api.syncMemory(store, { remote, visibility: async () => "private", placementAttestation: () => { called++; return attest(); } });
    expect(called).toBe(0); expect(result.ok).toBe(false);
    expect(reachableInspectionRowIds(remote)).toEqual([]);
    expect(store.get(f.allowed, f.project)).toBeDefined(); expect(store.get(f.declined, f.project)).toBeDefined();
    expect(existsSync(join(f.base, "sync-placement-writer-roots.json"))).toBe(false);
  } finally { store.close(); }
}, 120_000);

test("an existing host callback follows a genuinely committed effective-inventory renewal", async () => {
  const f = await active(), attest = f.api.createPlacementAttestation(f.base), first = await attest();
  appendFileSync(join(f.install, "src", "index.ts"), "\n// isolated host upgrade approved by the next person renewal\n");
  await refusal(() => attest(), "host package", "changed");
  const floorFile = join(f.base, "formats.json"), floors = JSON.parse(readFileSync(floorFile, "utf8"));
  writeFileSync(floorFile, JSON.stringify([...floors, { surface: "home", minReader: "0.22.0", since: "2026-11-08" }]) + "\n", { mode: 0o600 });
  const renewed = await activateSyncPlacement({ ...f.options("apply"), writerRoots: [activationOwnRoot, f.install] });
  expect(renewed.active).toBe(true);
  const before = inspectionFilesystemSnapshot(f.base), current = await attest();
  expect(current.writers).not.toEqual(first.writers);
  expect(current.writers).toHaveLength(2);
  expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  // The effective renewed inventory still requires its stronger person-authored floor.
  writeFileSync(floorFile, JSON.stringify(floors) + "\n", { mode: 0o600 });
  const afterFloorNarrowing = inspectionFilesystemSnapshot(f.base);
  await refusal(() => attest(), "home floor", "unavailable");
  expect(inspectionFilesystemSnapshot(f.base)).toEqual(afterFloorNarrowing);
}, 120_000);
