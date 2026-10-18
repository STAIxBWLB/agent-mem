import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore as PublishedV02 } from "@staix/agent-mem-v02";
import { MemoryStore as PreVaultStore } from "@staix/agent-mem-pre-vault";
import { MemoryStore, type NoteEntry } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { GENERATION_OP_CONTRACTS, OP_CONTRACTS, V1_OPS, assertSharedV1Op } from "../src/memory/ops-contract.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { recordVaultLink, vaultCandidates, validateVaultLinkRow, vaultLinkId, type VaultLinkRow } from "../src/memory/vault.ts";

const frozen = JSON.parse(readFileSync(new URL("./fixtures/vault-link.json", import.meta.url), "utf8")) as { note: NoteEntry; link: VaultLinkRow; canonicalLine: string };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home() { const root = mkdtempSync(join(tmpdir(), "amem-vault-compatibility-")); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root; }
const policy = createStandalonePolicy(), project = frozen.note.project;
function segments(dir: string) {
  return Object.fromEntries(["log", "local"].flatMap(folder => readdirSync(join(dir, folder)).filter(file => file.endsWith(".jsonl")).map(file => [`${folder}/${file}`, readFileSync(join(dir, folder, file), "utf8")])));
}
async function fixture() {
  const root = home(), memory = join(root, "memory"); mkdirSync(memory);
  writeFileSync(join(memory, "machine.json"), JSON.stringify({ id: frozen.note.machine, label: "fixture" }) + "\n");
  const legacy = new MemoryStore({ home: root, now: () => Date.parse(frozen.note.at), deferPromotions: true });
  const { id, schema: _schema, at: _at, machine: _machine, ...input } = frozen.note;
  expect(legacy.note(input)).toBe(id); legacy.close();
  await migrate({ memoryDir: memory, generation: frozen.link.generation, mode: "apply", authorizedPerson: true, tty: true });
  const store = new MemoryStore({ home: root, now: () => Date.parse(frozen.link.at), deferPromotions: true }); cleanup.push(() => store.close());
  return { root, memory, store, link: () => recordVaultLink(store, id, frozen.link.path, { project, policy }) };
}
/** Small authored fixture only: never copy sqlite indexes, locks, caches or Git trees into the old reader. */
function readerCopy(memory: string): string {
  const root = home(), base = join(root, "memory"), generation = join("generations", frozen.link.generation);
  for (const folder of ["log", "local", `${generation}/log`, `${generation}/local`]) mkdirSync(join(base, folder), { recursive: true });
  for (const file of ["machine.json", "profile.json", ...["machine.json", "generation.json", "generation-seal.json", "migration-sources.json"].map(name => `${generation}/${name}`)])
    writeFileSync(join(base, file), readFileSync(join(memory, file)));
  for (const dir of ["", generation]) for (const [file, bytes] of Object.entries(segments(join(memory, dir)))) writeFileSync(join(base, dir, file), bytes);
  return root;
}

test("C1 the actual pre-vault generation reader refuses a copied vault_link generation after a positive control", async () => {
  const f = await fixture(), control = readerCopy(f.memory);
  const old = new PreVaultStore({ home: control, deferPromotions: true });
  try { expect(old.profile.kind).toBe("generation"); expect(old.get(frozen.note.id, project)?.text).toBe(frozen.note.text); } finally { old.close(); }
  await f.link();
  const unsupported = readerCopy(f.memory);
  expect(() => { const reader = new PreVaultStore({ home: unsupported, deferPromotions: true }); try { reader.list({ project }); } finally { reader.close(); } })
    .toThrow("legacy bridge input changed or is invalid; person inspection required");
  expect(f.store.get(frozen.note.id, project)?.text).toBe(frozen.note.text);
});

test("C1 vault_link leaves an unannounced published v1 reader on unchanged legacy truth", async () => {
  const f = await fixture(), old = new PublishedV02({ home: f.root });
  try {
    const before = old.list({ project }); await f.link();
    expect(old.list({ project })).toEqual(before);
    expect(old.get(frozen.note.id, project)?.text).toBe(frozen.note.text);
    expect(Object.values(segments(f.memory)).join("")).not.toContain("vault_link");
  } finally { old.close(); }
});

test("C1 vault_link and a published v1 writer sharing a machine keep distinct authored segments", async () => {
  const f = await fixture(), old = new PublishedV02({ home: f.root });
  try {
    expect(old.machine.id).toBe(f.store.machine.id);
    const before = segments(f.memory); await f.link(); expect(segments(f.memory)).toEqual(before);
    const generation = segments(f.store.dir);
    const id = old.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "Late v1 independent authority", about: [] });
    expect(segments(f.store.dir)).toEqual(generation);
    expect(f.store.get(id, project)?.text).toBe("Late v1 independent authority");
    expect(await vaultCandidates(f.store, { project, policy })).not.toContainEqual(expect.objectContaining({ id: frozen.note.id }));
  } finally { old.close(); }
});

test("C1 an offline published v1 writer can arrive after vault_link without changing its exact receipt", async () => {
  const f = await fixture(); await f.link();
  const offline = new PublishedV02({ home: home() });
  try {
    for (const [file, bytes] of Object.entries(segments(f.memory))) writeFileSync(join(offline.dir, file), bytes);
    const id = offline.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "Independent offline contract", about: [] });
    const file = `log/${offline.machine.id}.jsonl`, received = segments(offline.dir)[file]!;
    appendFileSync(join(f.memory, file), received);
    expect(f.store.get(id, project)?.text).toBe("Independent offline contract");
    expect(f.store.vaultLinks(project)).toMatchObject([{ target: frozen.note.id, rowHash: frozen.link.rowHash, path: frozen.link.path }]);
  } finally { offline.close(); }
});

test("C1 a published v1 reader launched after vault_link never receives generation metadata", async () => {
  const f = await fixture(); await f.link();
  const born = f.store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "Generation-born independent authority", about: [] });
  const old = new PublishedV02({ home: f.root });
  try { expect(old.get(frozen.note.id, project)?.text).toBe(frozen.note.text); expect(old.get(born, project)).toBeUndefined(); }
  finally { old.close(); }
});

test("C2 real vault_link writer matches the frozen payload hashes identity and canonical segment bytes", async () => {
  const f = await fixture(), legacy = segments(f.memory);
  expect(await f.link()).toBe(frozen.link.id);
  expect(readFileSync(join(f.store.dir, "local", `${frozen.link.machine}.jsonl`), "utf8")).toBe(frozen.canonicalLine);
  const row = JSON.parse(frozen.canonicalLine);
  expect(row).toEqual(frozen.link); expect(canonicalJSON(row) + "\n").toBe(frozen.canonicalLine);
  expect(validateVaultLinkRow(row, frozen.link.generation, "local")).toEqual(frozen.link);
  const before = f.store.derivedTables(); f.store.rebuild(); expect(f.store.derivedTables()).toEqual(before);
  expect(f.store.get(frozen.note.id, project)?.text).toBe(frozen.note.text);
  expect(await vaultCandidates(f.store, { project, policy })).toEqual([]);
  expect(segments(f.memory)).toEqual(legacy);
});

test("C2 vault_link contract requires every frozen field and refuses shared-v1 without changing its registries", async () => {
  const oldRegistry = await import(new URL("./memory/ops-contract.ts", import.meta.resolve("@staix/agent-mem-pre-vault")).href);
  expect(V1_OPS).toEqual(oldRegistry.V1_OPS); expect(OP_CONTRACTS).toEqual(oldRegistry.OP_CONTRACTS);
  expect(V1_OPS).not.toContain("vault_link" as never); expect(OP_CONTRACTS.vault_link).toBeUndefined();
  expect(() => assertSharedV1Op("vault_link")).toThrow("not allowed in shared v1");
  const contract = GENERATION_OP_CONTRACTS.vault_link;
  expect(contract.generationOnly).toBe(true); expect(contract.validator).toBe("validateVaultLinkRow");
  expect(contract.payloadVersion).toBe(frozen.link.schema);
  expect([...contract.required].sort()).toEqual(Object.keys(frozen.link).sort());
  for (const field of contract.required) {
    const copy = structuredClone(frozen.link) as unknown as Record<string, unknown>; delete copy[field];
    if (field !== "id") { const { id: _id, ...body } = copy; copy.id = vaultLinkId(body); }
    expect(() => validateVaultLinkRow(copy, frozen.link.generation, "local")).toThrow();
  }
  const { id: _id, ...body } = frozen.link;
  const extra = { ...body, unknown: "refused" };
  expect(() => validateVaultLinkRow({ ...extra, id: vaultLinkId(extra) }, frozen.link.generation, "local")).toThrow();
  expect(() => validateVaultLinkRow(frozen.link, "f".repeat(32), "local")).toThrow();
  expect(() => validateVaultLinkRow(frozen.link, frozen.link.generation, "synced")).toThrow();
});
