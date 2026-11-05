import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";
import { realPath } from "../src/memory/platform.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { captureSyncPlacementContext } from "../src/memory/sync-placement-capture.ts";
import { canonicalJSON, vaultLinkId, validateVaultLinkRow } from "../src/memory/generation.ts";
import { pruneId, validatePruneRow, type PruneRow } from "../src/memory/prune.ts";
import { PLACEMENT_FORMAT } from "../src/memory/sync-placement-format.ts";
import { planPlacementJournal, preparePlacementJournal } from "../src/memory/sync-placement-journal.ts";
import { readPlacementJournal } from "../src/memory/sync-placement-journal-storage.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-placement-capture-"))); roots.push(root);
  const home = join(root, "memory"), store = new MemoryStore({ memoryDir: home, deferPromotions: true });
  const common = { op: "note" as const, project: "placement-capture", scope: "project" as const, tier: "long" as const,
    kind: "finding" as const, peer: "person", source: "person" as const, about: [] };
  const project = store.note({ ...common, text: "synthetic project source" });
  const user = store.note({ ...common, scope: "shared", text: "synthetic user source" });
  const local = store.note({ ...common, tier: "short", task: "placement-capture#42@1000", text: "synthetic local source" });
  store.close();
  await migrateShards({ memoryDir: home, generation: "e".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  await activatePublicPruneView({ memoryDir: home, mode: "apply", authorizedPerson: true, tty: true });
  let version = "initial", pin = "2".repeat(64);
  const port = { attest: () => ({ writers: [{ writerId: "1".repeat(64), version: "0.22.0", pin,
    publicationFormat: PLACEMENT_FORMAT, compatible: true as const }], legacySyncQuiesced: true as const }),
    policyVersion: () => version, authorize: () => true };
  return { home, port, project, user, local, setVersion: () => { version = "changed"; }, setPin: () => { pin = "3".repeat(64); } };
}

test("capture covers actual user, project and intrinsic-local sources", async () => {
  const f = await fixture(), capture = captureSyncPlacementContext(f.home, f.port);
  const rows = [...capture.rows.values()];
  expect(rows.find(row => row.row.id === f.project)?.key.realm.scope).toBe("project");
  expect(rows.find(row => row.row.id === f.user)?.key.realm).toEqual({ scope: "user" });
  expect(rows.find(row => row.row.id === f.local)).toMatchObject({ sourcePlacement: "local", intrinsicLocal: true });
  expect(capture.context.writers).toHaveLength(1);
  expect(capture.context.realms).toHaveLength(2);
  capture.assertCurrent();
});

for (const change of ["policy", "host", "writer", "source"] as const) test(`capture rejects ${change} drift instead of trusting an earlier snapshot`, async () => {
  const f = await fixture(), capture = captureSyncPlacementContext(f.home, f.port);
  if (change === "policy") writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["synthetic-policy"] }), { mode: 0o600 });
  if (change === "host") f.setVersion();
  if (change === "writer") f.setPin();
  if (change === "source") {
    const store = openShardStore({ memoryDir: f.home, user: true, deferPromotions: true });
    try { store.note({ op: "note", project: "placement-capture", scope: "shared", tier: "long", kind: "finding", peer: "person", source: "person", text: "new captured source", about: [] }); }
    finally { store.close(); }
  }
  expect(() => capture.assertCurrent()).toThrow();
});

test("preview and prepare preserve v2 markers and create only an empty private epoch", async () => {
  const f = await fixture(), names = ["profile.json", "shards.json", "formats.json"];
  const before = names.map(name => { try { return readFileSync(join(f.home, name), "utf8"); } catch { return undefined; } });
  const entries = readdirSync(f.home).sort(), preview = planPlacementJournal(f.home, f.port);
  expect(readdirSync(f.home).sort()).toEqual(entries);
  const prepared = preparePlacementJournal(f.home, preview, f.port);
  expect(prepared.activated).toBe(false);
  expect(readPlacementJournal(f.home, prepared.epochHash).records).toEqual([]);
  for (const [index, name] of names.entries()) {
    let actual: string | undefined; try { actual = readFileSync(join(f.home, name), "utf8"); } catch { actual = undefined; }
    expect(actual).toBe(before[index]);
  }
});

for (const change of ["policy", "host", "writer"] as const) test(`prepare refuses stale ${change} proof without activating markers`, async () => {
  const f = await fixture(), preview = planPlacementJournal(f.home, f.port), before = readFileSync(join(f.home, "profile.json"), "utf8");
  if (change === "policy") writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["changed"] }), { mode: 0o600 });
  if (change === "host") f.setVersion();
  if (change === "writer") f.setPin();
  expect(() => preparePlacementJournal(f.home, preview, f.port)).toThrow();
  expect(readFileSync(join(f.home, "profile.json"), "utf8")).toBe(before);
});


test("missing public-prune input and missing compatible writer proof refuse instead of producing partial capture", async () => {
  const f = await fixture();
  expect(() => captureSyncPlacementContext(f.home, { ...f.port, attest: () => ({ writers: [], legacySyncQuiesced: true }) })).toThrow();
  const profile = JSON.parse(readFileSync(join(f.home, "profile.json"), "utf8"));
  rmSync(join(f.home, "public-prune-input-sets", `${profile.pruneInputSetHash}.json`));
  expect(() => captureSyncPlacementContext(f.home, f.port)).toThrow();
});


for (const folder of ["log", "local"] as const) test(`capture refuses a symlinked generation ${folder} directory even with valid owned contents`, async () => {
  const f = await fixture(), directory = join(f.home, "user", folder), external = join(f.home, "..", `external-${folder}`);
  renameSync(directory, external);
  symlinkSync(external, directory, "dir");
  expect(() => captureSyncPlacementContext(f.home, f.port)).toThrow();
});

for (const kind of ["prune", "vault_link"] as const) test(`capture rejects a valid ${kind} row under a different machine's segment`, async () => {
  const f = await fixture(), generation = "e".repeat(32), machine = "a".repeat(16);
  const capture = captureSyncPlacementContext(f.home, f.port), source = [...capture.rows.values()].find(row => row.row.id === f.local)!;
  const at = "2026-10-01T00:00:00.000Z";
  let row: unknown;
  if (kind === "prune") {
    const body: Omit<PruneRow, "id"> = { schema: "agent-mem.prune/v1", op: "prune", generation, machine, at, actor: "person", placement: "local", cutoff: at,
      targets: [{ id: source.key.id, rowHash: source.key.rowHash, expiredAt: at, basis: { kind: "note", id: source.key.id, rowHash: source.key.rowHash } }] };
    row = validatePruneRow({ ...body, id: pruneId(body) }, generation, "local");
  } else {
    const body = { schema: "agent-mem.vault-link/v1", op: "vault_link", generation, machine, at, actor: "person", placement: "local",
      target: source.key.id, rowHash: source.key.rowHash, project: "placement-capture", path: "synthetic/fixture.md" };
    row = validateVaultLinkRow({ ...body, id: vaultLinkId(body) }, generation, "local");
  }
  // The validators above prove this is a valid special row, so refusal must bind its physical segment too.
  const project = readdirSync(join(f.home, "projects"))[0]!;
  writeFileSync(join(f.home, "projects", project, "local", "different-machine.jsonl"), canonicalJSON(row) + "\n", { mode: 0o600 });
  expect(() => captureSyncPlacementContext(f.home, f.port)).toThrow();
});
