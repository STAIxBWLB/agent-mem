import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { vaultCandidates, recordVaultLink, validateVaultLinkRow, vaultLinkId } from "../src/memory/vault.ts";
import { assertSharedV1Op, V1_OPS, GENERATION_OP_CONTRACTS } from "../src/memory/ops-contract.ts";

const roots: string[] = [], handles: MemoryStore[] = [];
afterEach(() => { for (const store of handles.splice(0)) { try { store.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = "synthetic/vault", policy = createStandalonePolicy();
function fixture() { const root = mkdtempSync(join(tmpdir(), "amem-vault-")); roots.push(root); return { root, memoryDir: join(root, "memory") }; }
function open(memoryDir: string) { const store = new MemoryStore({ memoryDir, deferPromotions: true }); handles.push(store); return store; }
function add(store: MemoryStore, extra: Partial<NoteInput> = {}) { return store.note({ op: "note", project, scope: "project", tier: "long", kind: "fail", peer: "person", title: "Durable lesson", text: "Use explicit generation witnesses to preserve immutable identity.", about: ["path:src/storage.ts"], source: "person", ...extra }); }
function segments(dir: string) { return Object.fromEntries(["log", "local"].flatMap(folder => readdirSync(join(dir, folder)).map(name => [`${folder}/${name}`, readFileSync(join(dir, folder, name), "utf8")]))); }

test("vault candidates screen all values before limit and expose only durable startup-project curated entries", async () => {
  const f = fixture(), store = open(f.memoryDir);
  const durable = add(store);
  add(store, { text: "PRIVATE durable finding", title: "Host-private" });
  add(store, { text: "Contact person@example.invalid", title: "PII" });
  add(store, { text: "Token sk-" + "a".repeat(48), title: "Secret" });
  add(store, { text: "Task #12 completed after CI passed", title: "Task progress" });
  add(store, { text: "PR #14 merged", title: "PR status" });
  add(store, { text: "Review approved", title: "Review verdict" });
  add(store, { text: "CI passed", title: "CI status" });
  add(store, { text: "Short capture-like event", tier: "short" });
  add(store, { project: "other/project", scope: "shared", text: "Other project durable lesson" });
  add(store, { about: ["path:secrets/config.ts"], text: "Denied path lesson" });
  const before = segments(store.dir), seen: string[] = [];
  const narrowed = createStandalonePolicy({ denyPaths: ["secrets"], host: { async screen(value) { const text = JSON.stringify(value); seen.push(text); return !text.includes("PRIVATE"); } } });
  const result = await vaultCandidates(store, { project, policy: narrowed, limit: 1 });
  expect(result.map(v => v.id)).toEqual([durable]);
  expect(seen.some(text => text.includes("PRIVATE"))).toBe(true);
  expect(segments(store.dir)).toEqual(before);
  expect(await vaultCandidates(store, { project, policy: { async screen() { throw new Error("unavailable"); } } })).toEqual([]);
});

test("vault links refuse shared-v1 and bind exact generation entries, survive rebuild, and never touch v1 logs", async () => {
  const f = fixture(), legacy = open(f.memoryDir), source = add(legacy), before = segments(legacy.dir);
  await expect(recordVaultLink(legacy, source, "notes/storage.md", { project, policy })).rejects.toThrow("generation");
  expect(() => assertSharedV1Op("vault_link")).toThrow();
  expect(V1_OPS).not.toContain("vault_link" as never);
  expect(GENERATION_OP_CONTRACTS.vault_link.generationOnly).toBe(true);
  expect(GENERATION_OP_CONTRACTS.vault_link.validator).toBe("validateVaultLinkRow");
  expect(GENERATION_OP_CONTRACTS.vault_link.payloadVersion).toBe("agent-mem.vault-link/v1");
  legacy.close(); handles.splice(handles.indexOf(legacy), 1);
  await migrate({ memoryDir: f.memoryDir, mode: "apply", generation: "a".repeat(32), authorizedPerson: true, tty: true });
  const store = open(f.memoryDir);
  const linked = await recordVaultLink(store, source, "notes/storage.md", { project, policy });
  expect(linked).toMatch(/^[a-f0-9]{32}$/);
  expect(await recordVaultLink(store, source, "notes/storage.md", { project, policy })).toBe(linked);
  expect(await vaultCandidates(store, { project, policy })).toEqual([]);
  const fresh = add(store, { text: "A separately authored replacement remains a vault candidate." });
  expect((await vaultCandidates(store, { project, policy })).map(v => v.id)).toEqual([fresh]);
  const incremental = store.derivedTables(); store.rebuild();
  expect(store.derivedTables()).toEqual(incremental);
  expect(store.vaultLinks(project).map(v => [v.target, v.path])).toEqual([[source, "notes/storage.md"]]);
  expect(segments(f.memoryDir)).toEqual(before);
  await expect(recordVaultLink(store, source.slice(0, 8), "notes/storage.md", { project, policy })).rejects.toThrow();
  await expect(recordVaultLink(store, fresh, "../outside.md", { project, policy })).rejects.toThrow();
  await expect(recordVaultLink(store, fresh, "notes/private.md", { project, policy: { async screen() { return false; } } })).rejects.toThrow();
  await expect(recordVaultLink(store, source, "notes/cross-project.md", { project: "other/project", policy })).rejects.toThrow();
});

test("vault link validation rejects changed payload hashes, foreign generation and public placement", async () => {
  const f = fixture(), legacy = open(f.memoryDir); add(legacy); legacy.close(); handles.splice(handles.indexOf(legacy), 1);
  const generation = "b".repeat(32);
  await migrate({ memoryDir: f.memoryDir, mode: "apply", generation, authorizedPerson: true, tty: true });
  const store = open(f.memoryDir), id = add(store);
  await recordVaultLink(store, id, "notes/한글.md", { project, policy });
  const raw = Object.values(segments(store.dir)).join("").trim().split("\n").map(line => JSON.parse(line)).find(row => row.op === "vault_link");
  expect(validateVaultLinkRow(raw, generation, "local")).toEqual(raw);
  expect(() => validateVaultLinkRow({ ...raw, path: "notes/changed.md" }, generation, "local")).toThrow();
  const { id: _id, ...body } = raw;
  expect(() => validateVaultLinkRow({ ...body, extra: true, id: vaultLinkId({ ...body, extra: true }) }, generation, "local")).toThrow();
  expect(() => validateVaultLinkRow(raw, "c".repeat(32), "local")).toThrow();
  expect(() => validateVaultLinkRow(raw, generation, "synced")).toThrow();
});

test("vault links retain their exact target through curated shard migration", async () => {
  const f = fixture(), legacy = open(f.memoryDir), id = add(legacy); legacy.close(); handles.splice(handles.indexOf(legacy), 1);
  await migrate({ memoryDir: f.memoryDir, mode: "apply", generation: "d".repeat(32), authorizedPerson: true, tty: true });
  const store = open(f.memoryDir); await recordVaultLink(store, id, "notes/storage.md", { project, policy }); store.close(); handles.splice(handles.indexOf(store), 1);
  await migrateShards({ memoryDir: f.memoryDir, mode: "apply", authorizedPerson: true, tty: true });
  const shard = openShardStore({ memoryDir: f.memoryDir, project, deferPromotions: true }); handles.push(shard);
  expect(await vaultCandidates(shard, { project, policy })).toEqual([]);
  const incremental = shard.derivedTables(); shard.rebuild(); expect(shard.derivedTables()).toEqual(incremental);
  expect(shard.vaultLinks(project)[0]?.target).toBe(id);
});
