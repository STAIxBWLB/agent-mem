import { expect, test, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import fixture from "./fixtures/public-prune-witness.json";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { entryId, type Entry, type NoteEntry, type OpEntry } from "../src/memory/store.ts";
import { pruneId, prunePayloadHash, pruneRowHash, type PruneRow } from "../src/memory/prune.ts";
import { encodeShardPacks, SHARD_PACK_MAX_BYTES, type ShardSyncRealm, type ShardSyncRow } from "../src/memory/shard-sync-format.ts";
import { validatePublicPruneWitness, publicPruneWitnessHash, verifyPublicPruneWitness,
  PUBLIC_PRUNE_MANIFEST_MAX_BYTES, type PublicPruneEvidence, type PublicPruneWitnessV1 } from "../src/memory/public-prune-witness.ts";

const blob = (bytes: Uint8Array): string => createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function golden() {
  const manifest = structuredClone(fixture.manifest) as PublicPruneWitnessV1;
  const evidence: PublicPruneEvidence = { realm: structuredClone(manifest.realm), packs: fixture.packs.map(p => ({ pack: p.pack, blob: p.blob, bytes: Buffer.from(p.text) })) };
  return { manifest, evidence };
}
const originalNote = (): NoteEntry => JSON.parse(fixture.packs[1]!.text) as NoteEntry;
function reId<T extends Entry>(input: T): T { const { id: _, ...body } = input; return { ...body, id: entryId(body) } as T; }
function rePrune(row: PruneRow): PruneRow { const { id: _, ...body } = row; return { ...body, id: pruneId(body) }; }
function proofFor(rows: ShardSyncRow[], prune: PruneRow, realm: ShardSyncRealm = golden().manifest.realm) {
  const packs = [...encodeShardPacks([...rows, prune])].map(([pack, bytes]) => ({ pack, bytes, blob: blob(bytes) }));
  const occurrence = (id: string) => {
    const found = packs.find(p => p.bytes.toString().split("\n").filter(Boolean).some(line => JSON.parse(line).id === id))!;
    return { pack: found.pack, blob: found.blob };
  };
  const ids = [...new Set(prune.targets.flatMap(t => [t.id, t.basis.id]))].sort();
  const manifest: PublicPruneWitnessV1 = { schema: "agent-mem.public-prune-witness/v1", realm, prune,
    lineage: { kind: "native-generation", seal: "a".repeat(64) }, pruneOccurrence: occurrence(prune.id),
    witnesses: ids.map(id => ({ ...occurrence(id), id, rowHash: pruneRowHash(rows.find(row => row.id === id) as Entry) })) };
  return { manifest, evidence: { realm, packs } satisfies PublicPruneEvidence };
}
function replacesPack(f: ReturnType<typeof golden>, index: number, bytes: Buffer, machine?: string) {
  const before = f.evidence.packs[index]!, author = machine === undefined ? before.pack.split("/")[1]! : sha(machine);
  const pack = `rows/${author}/${sha(bytes)}.jsonl`, oid = blob(bytes);
  f.evidence.packs = f.evidence.packs.map((p, i) => i === index ? { pack, blob: oid, bytes } : p);
  for (const ref of [f.manifest.pruneOccurrence, ...f.manifest.witnesses]) if (ref.pack === before.pack) { ref.pack = pack; ref.blob = oid; }
}

test("R01/R03 frozen independent UTF8 fixture preserves full original identity, attribution and hashes", () => {
  const { manifest, evidence } = golden(), before = canonicalJSON(manifest);
  expect(manifest.prune.id).toBe(fixture.expected.pruneId);
  expect(prunePayloadHash(manifest.prune)).toBe(fixture.expected.prunePayloadHash);
  expect(pruneRowHash(originalNote())).toBe(fixture.expected.noteRowHash);
  expect(originalNote().machine).toBe("immutable legacy author");
  expect(publicPruneWitnessHash(manifest)).toBe(fixture.expected.manifestHash);
  expect(verifyPublicPruneWitness(manifest, evidence)).toEqual({ status: "verified", manifest, hash: fixture.expected.manifestHash });
  expect(canonicalJSON(manifest)).toBe(before); expect(validatePublicPruneWitness(manifest)).not.toBe(manifest);
});

test("R01/R02 validation is receiver-neutral for independent, reverse and third-generation fixtures", () => {
  for (const generation of ["1".repeat(32), "2".repeat(32), "3".repeat(32)]) {
    const prune = rePrune({ ...golden().manifest.prune, generation }), f = proofFor([originalNote()], prune);
    const result = verifyPublicPruneWitness(f.manifest, f.evidence);
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(result.manifest.prune).toEqual(prune);
    // No receiving generation, clock or profile exists in this validation-only API.
    expect(Object.keys(f.manifest).sort()).toEqual(["lineage", "prune", "pruneOccurrence", "realm", "schema", "witnesses"]);
  }
});

test("positive lineage is closed and part of manifest hash, never derived from missing receipts", () => {
  const f = golden(), hashes = new Set([publicPruneWitnessHash(f.manifest)]);
  for (const end of [0, Number.MAX_SAFE_INTEGER]) {
    f.manifest.lineage = { kind: "post-seal", seal: "b".repeat(64), end };
    expect(verifyPublicPruneWitness(f.manifest, f.evidence).status).toBe("verified"); hashes.add(publicPruneWitnessHash(f.manifest));
  }
  expect(hashes.size).toBe(3);
  for (const lineage of [{ kind: "native-generation", seal: "b".repeat(64), end: 0 }, { kind: "native-generation", seal: "BAD" },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(end => ({ kind: "post-seal", seal: "b".repeat(64), end })),
    { kind: "post-seal", seal: "b".repeat(64) }, { kind: "post-seal", seal: "b".repeat(64), end: 1, generation: "c".repeat(32) }]) {
    expect(verifyPublicPruneWitness({ ...f.manifest, lineage }, f.evidence)).toEqual({ status: "invalid" });
  }
});

test("R13 absent/historical/single-destination lineage is an explicit hold with no mask; invalid evidence still refuses", () => {
  for (const lineage of [undefined, { kind: "historical-translation", sourceId: "a".repeat(32) }, { kind: "single-destination-migration" }]) {
    const f = golden(), { lineage: _, ...base } = f.manifest;
    const input = lineage === undefined ? base : { ...base, lineage };
    expect(verifyPublicPruneWitness(input, f.evidence)).toEqual({ status: "unsupported_lineage", reason: lineage === undefined ? "lineage_missing" : "lineage_unsupported" });
    expect(() => validatePublicPruneWitness(input)).toThrow("public prune witness invalid or unavailable");
    f.evidence.packs = [];
    expect(verifyPublicPruneWitness(input, f.evidence)).toEqual({ status: "invalid" });
  }
});

test("R04/R06 selected rows, placement, person/public flags and old receipts never substitute for raw public occurrences", () => {
  const f = golden();
  for (const evidence of [{ realm: f.manifest.realm, rows: [originalNote()], publicWitness: true },
    { realm: f.manifest.realm, packs: [], placement: "synced", actor: "person" },
    { realm: f.manifest.realm, packs: f.evidence.packs, public: true }, { schema: "agent-mem.prune-hold/v1", row: f.manifest.prune }]) {
    expect(verifyPublicPruneWitness(f.manifest, evidence as unknown as PublicPruneEvidence)).toEqual({ status: "invalid" });
  }
  // A locally pruned/unwitnessed original cannot be first-published here: there is no writer or pack construction in the verifier.
  expect(verifyPublicPruneWitness(f.manifest, { realm: f.manifest.realm, packs: [f.evidence.packs[0]!] })).toEqual({ status: "invalid" });
});

test("R06 fully matching short/machine occurrences, public settle basis and local prune remain ineligible", () => {
  for (const edit of [{ tier: "short" }, { scope: "machine" }]) {
    const f = golden(), row = reId({ ...originalNote(), ...edit } as NoteEntry), rowHash = pruneRowHash(row);
    f.manifest.prune = rePrune({ ...f.manifest.prune, targets: [{ id: row.id, rowHash, expiredAt: row.expires!, basis: { kind: "note", id: row.id, rowHash } }] });
    replacesPack(f, 0, Buffer.from(canonicalJSON(f.manifest.prune) + "\n"));
    replacesPack(f, 1, Buffer.from(canonicalJSON(row) + "\n"));
    Object.assign(f.manifest.witnesses[0]!, { id: row.id, rowHash });
    expect(verifyPublicPruneWitness(f.manifest, f.evidence)).toEqual({ status: "invalid" });
  }
  const f = golden(), local = rePrune({ ...f.manifest.prune, placement: "local" });
  expect(verifyPublicPruneWitness({ ...f.manifest, prune: local }, f.evidence)).toEqual({ status: "invalid" });
  const note = reId({ ...originalNote(), task: "fixture-task" });
  const settle = reId({ schema: "agent-hub.memory/v1", op: "settle", at: note.at, machine: "legacy", target: note.task!, by: note.expires!, actor: "person", id: "" } as OpEntry);
  const prune = rePrune({ ...f.manifest.prune, targets: [{ id: note.id, rowHash: pruneRowHash(note), expiredAt: settle.by!, basis: { kind: "settle", id: settle.id, rowHash: pruneRowHash(settle) } }] });
  const packs = [note, settle, prune].map(row => {
    const bytes = Buffer.from(canonicalJSON(row) + "\n"); return { pack: `rows/${sha(row.machine)}/${sha(bytes)}.jsonl`, blob: blob(bytes), bytes };
  });
  const manifest = { ...f.manifest, prune, pruneOccurrence: { pack: packs[2]!.pack, blob: packs[2]!.blob },
    witnesses: [note, settle].map((row, i) => ({ pack: packs[i]!.pack, blob: packs[i]!.blob, id: row.id, rowHash: pruneRowHash(row) })).sort((a,b) => a.id < b.id ? -1 : 1) };
  expect(verifyPublicPruneWitness(manifest, { realm: manifest.realm, packs })).toEqual({ status: "invalid" });
});

test("R07 complete original/author bucket/blob/path/UTF8/newline proof is mandatory, with fixed private-safe errors", () => {
  for (const index of [0, 1]) for (const bad of [Buffer.from([255, 10]), Buffer.from("PRIVATE-CANARY\n"), Buffer.from(fixture.packs[index]!.text.slice(0, -1)),
    Buffer.from(fixture.packs[index]!.text.replace('"id":', '"changed":'))]) {
    const f = golden(); replacesPack(f, index, bad); expect(verifyPublicPruneWitness(f.manifest, f.evidence)).toEqual({ status: "invalid" });
  }
  for (const index of [0, 1]) {
    const f = golden(); replacesPack(f, index, Buffer.from(fixture.packs[index]!.text), "wrong author");
    expect(verifyPublicPruneWitness(f.manifest, f.evidence)).toEqual({ status: "invalid" });
    const g = golden(); g.evidence.packs = g.evidence.packs.map((p, i) => i === index ? { ...p, blob: "0".repeat(40) } : p);
    expect(verifyPublicPruneWitness(g.manifest, g.evidence)).toEqual({ status: "invalid" });
    const h = golden(); h.evidence.packs[index]!.bytes[0] = h.evidence.packs[index]!.bytes[0]! ^ 1;
    expect(verifyPublicPruneWitness(h.manifest, h.evidence)).toEqual({ status: "invalid" });
  }
});

test("R07 wrong expiry/hash/basis kind/target and partial target sets never produce a validated subset", () => {
  for (const change of ["hash", "expiry", "kind", "target", "cutoff"] as const) {
    const row = structuredClone(golden().manifest.prune), target = row.targets[0]!;
    if (change === "hash") target.rowHash = "f".repeat(64);
    if (change === "expiry") target.expiredAt = "2026-10-01T12:00:00.000Z";
    if (change === "kind") target.basis.kind = "demote";
    if (change === "target") target.basis.id = "f".repeat(32);
    if (change === "cutoff") row.cutoff = "2026-09-30T00:00:00.000Z";
    if (change === "target" || change === "cutoff") {
      const f = golden(); expect(verifyPublicPruneWitness({ ...f.manifest, prune: rePrune(row) }, f.evidence)).toEqual({ status: "invalid" });
    } else {
      const f = proofFor([originalNote()], rePrune(row)); expect(verifyPublicPruneWitness(f.manifest, f.evidence)).toEqual({ status: "invalid" });
    }
  }
  const f = golden(); f.manifest.witnesses = []; expect(verifyPublicPruneWitness(f.manifest, f.evidence)).toEqual({ status: "invalid" });
});

test("R08 duplicate, unused, unordered or colliding witness/pack data refuses in either source order", () => {
  const f = golden(), witness = f.manifest.witnesses[0]!;
  for (const witnesses of [[witness, witness], [{ ...witness, id: "f".repeat(32) }], [witness, { ...witness, id: "f".repeat(32) }]])
    expect(verifyPublicPruneWitness({ ...f.manifest, witnesses }, f.evidence)).toEqual({ status: "invalid" });
  expect(verifyPublicPruneWitness(f.manifest, { ...f.evidence, packs: [f.evidence.packs[0]!, f.evidence.packs[0]!] })).toEqual({ status: "invalid" });
  for (const reverse of [false, true]) {
    const g = golden(), changed = { ...originalNote(), text: "SAME-ID-DIFFERENT-TEXT" }, lines = [canonicalJSON(originalNote()), canonicalJSON(changed)];
    if (reverse) lines.reverse(); replacesPack(g, 1, Buffer.from(lines.join("\n") + "\n"));
    expect(verifyPublicPruneWitness(g.manifest, g.evidence)).toEqual({ status: "invalid" });
  }
});

test("R10 equal text with another ID is not an implicit target; demote uses exact relation", () => {
  const note = originalNote(), equalText = reId({ ...note, at: "2026-10-01T01:00:00.000Z" });
  const basis = reId({ schema: "agent-hub.memory/v1", op: "demote", at: "2026-10-02T00:00:00.000Z", machine: "demote-author", target: note.id,
    by: "2026-10-02T12:00:00.000Z", actor: "person", id: "" } as OpEntry);
  const row = golden().manifest.prune; row.targets[0] = { id: note.id, rowHash: pruneRowHash(note), expiredAt: basis.by!, basis: { kind: "demote", id: basis.id, rowHash: pruneRowHash(basis) } };
  const f = proofFor([note, basis, equalText], rePrune(row));
  expect(verifyPublicPruneWitness(f.manifest, f.evidence).status).toBe("verified");
  expect(f.manifest.prune.targets.map(t => t.id)).toEqual([note.id]); expect(f.manifest.witnesses.map(w => w.id)).not.toContain(equalText.id);
  f.manifest.witnesses.reverse(); expect(verifyPublicPruneWitness(f.manifest, f.evidence)).toEqual({ status: "invalid" });
});

test("R11 another project or user overlay cannot prove a selected physical realm", () => {
  for (const realm of [{ scope: "project", key: "project-B" }, { scope: "user" }] satisfies ShardSyncRealm[]) {
    const f = golden(); expect(verifyPublicPruneWitness(f.manifest, { ...f.evidence, realm })).toEqual({ status: "invalid" });
    expect(verifyPublicPruneWitness({ ...f.manifest, realm }, { ...f.evidence, realm })).toEqual({ status: "invalid" });
  }
  const shared = reId({ ...originalNote(), scope: "shared" }), row = golden().manifest.prune;
  row.targets[0] = { id: shared.id, rowHash: pruneRowHash(shared), expiredAt: shared.expires!, basis: { kind: "note", id: shared.id, rowHash: pruneRowHash(shared) } };
  const f = proofFor([shared], rePrune(row), { scope: "user" }); expect(verifyPublicPruneWitness(f.manifest, f.evidence).status).toBe("verified");
});

test("R21 manifest, witness count and raw pack budget refuse without truncating or lifetime omission", () => {
  const f = golden();
  expect(verifyPublicPruneWitness({ ...f.manifest, extra: "forbidden" }, f.evidence)).toEqual({ status: "invalid" });
  expect(verifyPublicPruneWitness({ ...f.manifest, realm: { scope: "project", key: "a".repeat(PUBLIC_PRUNE_MANIFEST_MAX_BYTES) } }, f.evidence)).toEqual({ status: "invalid" });
  expect(verifyPublicPruneWitness({ ...f.manifest, witnesses: Array(65).fill(f.manifest.witnesses[0]) }, f.evidence)).toEqual({ status: "invalid" });
  expect(verifyPublicPruneWitness(f.manifest, { ...f.evidence, packs: Array(66).fill(f.evidence.packs[0]) })).toEqual({ status: "invalid" });
  const big = golden(); replacesPack(big, 0, Buffer.alloc(SHARD_PACK_MAX_BYTES + 1, 65));
  expect(verifyPublicPruneWitness(big.manifest, big.evidence)).toEqual({ status: "invalid" });
});

test("R21 maximum 32 targets/64 distinct references remain complete under the manifest bound", () => {
  const rows: Entry[] = [], targets: PruneRow["targets"] = [];
  for (let n = 0; n < 32; n++) {
    const note = reId({ ...originalNote(), machine: `legacy-author-${n}`, text: `target ${n}` });
    const basis = reId({ schema: "agent-hub.memory/v1", op: "demote", at: "2026-10-02T00:00:00.000Z", machine: `basis-${n}`, target: note.id,
      by: note.expires!, actor: "person", id: "" } as OpEntry);
    rows.push(note, basis); targets.push({ id: note.id, rowHash: pruneRowHash(note), expiredAt: basis.by!, basis: { kind: "demote", id: basis.id, rowHash: pruneRowHash(basis) } });
  }
  targets.sort((a, b) => a.id < b.id ? -1 : 1);
  const f = proofFor(rows, rePrune({ ...golden().manifest.prune, targets }));
  expect(f.manifest.witnesses.length).toBe(64); expect(f.evidence.packs.length).toBe(65); expect(Buffer.byteLength(canonicalJSON(f.manifest))).toBeLessThan(PUBLIC_PRUNE_MANIFEST_MAX_BYTES);
  expect(verifyPublicPruneWitness(f.manifest, f.evidence).status).toBe("verified");
});

test("R21 verifier performs no filesystem, process or network work and does not mutate its inputs", () => {
  const f = golden(), before = hashJSON(f), spies = [spyOn(fs, "readFileSync"), spyOn(fs, "writeFileSync"), spyOn(Bun, "spawn"), spyOn(Bun, "spawnSync"), spyOn(globalThis, "fetch")];
  try {
    expect(verifyPublicPruneWitness(f.manifest, f.evidence).status).toBe("verified");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(hashJSON(f)).toBe(before);
  } finally { for (const spy of spies) spy.mockRestore(); }
});

for (const suffix of ["\n", "\r\n"]) test(`exact hex and pack path syntax refuses trailing ${JSON.stringify(suffix)}`, () => {
  const f = golden(); f.manifest.lineage.seal += suffix;
  expect(verifyPublicPruneWitness(f.manifest, f.evidence)).toEqual({ status: "invalid" });
  const g = golden(), original = g.manifest.pruneOccurrence.pack;
  g.manifest.pruneOccurrence.pack += suffix;
  g.evidence.packs = g.evidence.packs.map(p => p.pack === original ? { ...p, pack: p.pack + suffix } : p);
  expect(verifyPublicPruneWitness(g.manifest, g.evidence)).toEqual({ status: "invalid" });
});

test("R07 Git blob identity and pack digest are checked independently of their matching manifest refs", () => {
  const f = golden(); f.manifest.pruneOccurrence.blob = "f".repeat(40);
  f.evidence.packs = f.evidence.packs.map((p, i) => i === 0 ? { ...p, blob: "f".repeat(40) } : p);
  expect(verifyPublicPruneWitness(f.manifest, f.evidence)).toEqual({ status: "invalid" });
  const g = golden(), bytes = Buffer.from(fixture.packs[0]!.text + "\n"), oid = blob(bytes);
  g.manifest.pruneOccurrence.blob = oid;
  g.evidence.packs = g.evidence.packs.map((p, i) => i === 0 ? { ...p, bytes, blob: oid } : p);
  expect(verifyPublicPruneWitness(g.manifest, g.evidence)).toEqual({ status: "invalid" });
});
