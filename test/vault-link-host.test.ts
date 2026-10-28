import "./home.ts";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// External hosts use only the package entry, never memory implementation imports.
import {
  MemoryStore, createStandalonePolicy, migrate, migrateShards, openShardStore,
  readShardedSelection, realPath, recordVaultLink, vaultCandidates, vaultCandidatesAll,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = "synthetic/vault-host", generation = "a".repeat(32);
const path = "notes/storage-boundaries.md", policy = createStandalonePolicy({ host: { screen: async () => true } });
function fixture(): string {
  // test/home.ts isolates defaults; explicit homes also isolate each host instance.
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-vault-host-"))); roots.push(root);
  const base = join(root, "memory"), initial = new MemoryStore({ memoryDir: base, deferPromotions: true });
  initial.close(); return base;
}
function note(store: MemoryStore, text: string): string {
  return store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "host", source: "person", text, about: [] });
}

for (const layout of ["generation", "shards"] as const) test(`package host records a local vault link in ${layout} and suppresses only its exact candidate`, async () => {
  const base = fixture();
  await migrate({ memoryDir: base, mode: "apply", generation, authorizedPerson: true, tty: true });
  if (layout === "shards") {
    await migrateShards({ memoryDir: base, mode: "apply", authorizedPerson: true, tty: true });
    expect(readShardedSelection(base)).toMatchObject({ generation, phase: "active" });
  }
  const store = layout === "shards"
    ? openShardStore({ memoryDir: base, project, deferPromotions: true })
    : new MemoryStore({ memoryDir: base, deferPromotions: true });
  try {
    expect(store.profile.kind).toBe("generation");
    const target = note(store, "Immutable storage witnesses preserve the exact source identity."), control = note(store, "A separate durable storage lesson remains independent.");
    const before = await vaultCandidates(store, { project, policy });
    expect(before.map(row => row.id).sort()).toEqual([target, control].sort());
    if (layout === "shards") {
      const discovered = await vaultCandidatesAll(base, { project, policy });
      expect(discovered.projects.find(group => group.project === project)?.candidates.map(row => row.id).sort()).toEqual([target, control].sort());
    }
    const linked = await recordVaultLink(store, target, path, { project, policy });
    expect(linked).toMatch(/^[a-f0-9]{32}$/);
    expect((await vaultCandidates(store, { project, policy })).map(row => row.id)).toEqual([control]);
    expect(store.get(target, project)?.text).toBe(before.find(row => row.id === target)?.text);
    const localRows = readFileSync(join(store.dir, "local", `${store.machine.id}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(localRows.find(row => row.id === linked)).toMatchObject({ schema: "agent-mem.vault-link/v1", op: "vault_link", generation, placement: "local", target, path, project });
    if (layout === "shards") {
      const discovered = await vaultCandidatesAll(base, { project, policy });
      expect(discovered.projects.find(group => group.project === project)?.candidates.map(row => row.id)).toEqual([control]);
    }
  } finally { store.close(); }
});

test("package host receives the exact generation precondition error without an implicit migration", async () => {
  const base = fixture(), store = new MemoryStore({ memoryDir: base, deferPromotions: true });
  try {
    const target = note(store, "A durable storage lesson cannot link from a shared-v1 profile.");
    expect(store.profile.kind).toBe("shared-v1");
    let failure: unknown;
    try { await recordVaultLink(store, target, path, { project, policy }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("vault links require a generation profile; shared-v1 is unchanged");
    expect((await vaultCandidates(store, { project, policy })).map(row => row.id)).toEqual([target]);
    expect(store.vaultLinks(project)).toEqual([]);
    expect(existsSync(join(base, "generations"))).toBe(false);
  } finally { store.close(); }
});
