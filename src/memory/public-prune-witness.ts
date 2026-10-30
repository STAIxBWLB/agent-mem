/** Layer 1 only: pure complete public-pack proof, never publication or an active mask. */
import { createHash } from "node:crypto";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { reducePruneRows, validatePruneRow, pruneRowHash, type PruneRow, type PruneSourceRow } from "./prune.ts";
import { decodeShardPack, SHARD_PACK_MAX_BYTES, type ShardSyncRealm } from "./shard-sync-format.ts";

export const PUBLIC_PRUNE_MANIFEST_MAX_BYTES = 65_536;
export const PUBLIC_PRUNE_MAX_WITNESSES = 64, PUBLIC_PRUNE_MAX_PACKS = 65;
export type PublicPruneLineage = { kind: "native-generation"; seal: string } | { kind: "post-seal"; seal: string; end: number };
interface Occurrence { pack: string; blob: string }
export interface PublicPruneWitnessV1 {
  schema: "agent-mem.public-prune-witness/v1";
  realm: ShardSyncRealm;
  prune: PruneRow;
  lineage: PublicPruneLineage;
  pruneOccurrence: Occurrence;
  witnesses: (Occurrence & { id: string; rowHash: string })[];
}
/** Supplied only from the owned, audited selected-realm source path (Layer 4).
 * Raw bytes prove content, not private-remote consent or authenticity. A flag,
 * outgoing row selection or old hold receipt cannot substitute for these packs.
 */
export interface PublicPruneEvidence {
  realm: ShardSyncRealm;
  packs: readonly (Occurrence & { bytes: Uint8Array })[];
}
export interface VerifiedPublicPruneWitness {
  status: "verified"; manifest: PublicPruneWitnessV1; hash: string;
}
export type PublicPruneVerification = VerifiedPublicPruneWitness | { status: "invalid" }
  | { status: "unsupported_lineage"; reason: "lineage_missing" | "lineage_unsupported" };
type Candidate = Omit<PublicPruneWitnessV1, "lineage"> & { lineage?: unknown };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const hex = (v: unknown, n: number): v is string => typeof v === "string" && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const bad = (): never => { throw new Error("public prune witness invalid or unavailable"); };
function guard(ok: unknown): asserts ok { if (!ok) bad(); }
function realm(input: unknown): ShardSyncRealm {
  guard(object(input));
  if (input.scope === "user") { guard(exact(input, ["scope"])); return { scope: "user" }; }
  guard(input.scope === "project" && exact(input, ["scope", "key"]) && typeof input.key === "string" && input.key.length > 0);
  guard(Buffer.byteLength(input.key, "utf8") <= PUBLIC_PRUNE_MANIFEST_MAX_BYTES);
  return { scope: "project", key: input.key };
}
function occurrence(input: unknown, witness = false): Occurrence {
  guard(object(input) && exact(input, witness ? ["pack", "blob", "id", "rowHash"] : ["pack", "blob"]));
  guard(typeof input.pack === "string" && /^rows\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl$/.test(input.pack) && hex(input.blob, 40));
  return { pack: input.pack, blob: input.blob };
}
function candidate(input: unknown): Candidate {
  guard(object(input));
  guard(exact(input, ["schema", "realm", "prune", "pruneOccurrence", "witnesses", ...(Object.hasOwn(input, "lineage") ? ["lineage"] : [])]));
  guard(input.schema === "agent-mem.public-prune-witness/v1" && Array.isArray(input.witnesses) && input.witnesses.length <= PUBLIC_PRUNE_MAX_WITNESSES);
  guard(object(input.prune) && Array.isArray(input.prune.targets) && input.prune.targets.length <= 32);
  const prune = validatePruneRow(input.prune, undefined, "synced"), selected = realm(input.realm);
  const needed = new Map<string, string>();
  for (const target of prune.targets) for (const ref of [target, target.basis]) {
    guard(!needed.has(ref.id) || needed.get(ref.id) === ref.rowHash); needed.set(ref.id, ref.rowHash);
  }
  let previous = "";
  const witnesses = input.witnesses.map(value => {
    const where = occurrence(value, true); guard(object(value) && hex(value.id, 32) && hex(value.rowHash, 64));
    guard(value.id > previous && needed.get(value.id) === value.rowHash); previous = value.id;
    return { ...where, id: value.id, rowHash: value.rowHash };
  });
  guard(witnesses.length === needed.size);
  const result: Candidate = { schema: input.schema, realm: selected, prune, pruneOccurrence: occurrence(input.pruneOccurrence), witnesses,
    ...(Object.hasOwn(input, "lineage") ? { lineage: structuredClone(input.lineage) } : {}) };
  guard(Buffer.byteLength(canonicalJSON(result), "utf8") <= PUBLIC_PRUNE_MANIFEST_MAX_BYTES);
  return result;
}
function lineage(input: unknown): PublicPruneLineage | undefined {
  if (!object(input) || !["native-generation", "post-seal"].includes(String(input.kind))) return undefined;
  guard(exact(input, input.kind === "native-generation" ? ["kind", "seal"] : ["kind", "seal", "end"]) && hex(input.seal, 64));
  if (input.kind === "native-generation") return { kind: input.kind, seal: input.seal };
  guard(Number.isSafeInteger(input.end) && (input.end as number) >= 0);
  return { kind: "post-seal", seal: input.seal, end: input.end as number };
}
export function validatePublicPruneWitness(input: unknown): PublicPruneWitnessV1 {
  try { const value = candidate(input), origin = lineage(value.lineage); guard(origin); return { ...value, lineage: origin }; }
  catch { return bad(); }
}
export function publicPruneWitnessHash(input: PublicPruneWitnessV1): string { return hashJSON(validatePublicPruneWitness(input)); }

export function verifyPublicPruneWitness(input: unknown, evidence: PublicPruneEvidence): PublicPruneVerification {
  try {
    const value = candidate(input);
    guard(object(evidence) && exact(evidence, ["realm", "packs"]) && canonicalJSON(realm(evidence.realm)) === canonicalJSON(value.realm));
    guard(Array.isArray(evidence.packs) && evidence.packs.length <= PUBLIC_PRUNE_MAX_PACKS);
    const required = new Map<string, string>();
    for (const ref of [value.pruneOccurrence, ...value.witnesses]) {
      guard(!required.has(ref.pack) || required.get(ref.pack) === ref.blob); required.set(ref.pack, ref.blob);
    }
    guard(evidence.packs.length === required.size);
    const packs = new Map<string, Map<string, PruneRow | PruneSourceRow["row"]>>(), seen = new Map<string, string>();
    for (const pack of evidence.packs) {
      guard(object(pack) && exact(pack, ["pack", "blob", "bytes"]) && required.get(pack.pack) === pack.blob && !packs.has(pack.pack));
      guard(pack.bytes instanceof Uint8Array && pack.bytes.byteLength > 0 && pack.bytes.byteLength <= SHARD_PACK_MAX_BYTES);
      const bytes = Buffer.from(pack.bytes);
      const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      guard(blob === pack.blob);
      const rows = decodeShardPack(pack.pack, bytes, value.realm, value.prune.generation);
      const contents = new Map<string, PruneRow | PruneSourceRow["row"]>();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!, canonical = canonicalJSON(row);
        guard(!seen.has(row.id) || seen.get(row.id) === canonical);
        seen.set(row.id, canonical); contents.set(row.id, row);
      }
      packs.set(pack.pack, contents);
    }
    guard(canonicalJSON(packs.get(value.pruneOccurrence.pack)?.get(value.prune.id)) === canonicalJSON(value.prune));
    const sources: PruneSourceRow[] = [];
    for (const witness of value.witnesses) {
      const row = packs.get(witness.pack)?.get(witness.id);
      guard(row && row.op !== "prune" && pruneRowHash(row) === witness.rowHash);
      sources.push({ row, placement: "synced", publicWitness: true }); // only after complete public pack proof
    }
    const proof = reducePruneRows([{ row: value.prune, placement: "synced" }], { rows: sources, expiries: [] }, value.prune.generation);
    guard(proof.invalid === 0 && proof.pending.length === 0 && proof.targets.size === value.prune.targets.length);
    const origin = lineage(value.lineage);
    if (!origin) return { status: "unsupported_lineage", reason: value.lineage === undefined ? "lineage_missing" : "lineage_unsupported" };
    const manifest: PublicPruneWitnessV1 = { ...value, lineage: origin };
    return { status: "verified", manifest, hash: hashJSON(manifest) };
  } catch { return { status: "invalid" }; }
}
