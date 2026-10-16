import type { Entry } from "./store.ts";

export interface PayloadField {
  type: "string" | "string-array";
  values?: readonly string[];
  format?: "utc" | "id";
  maxLength?: number;
}
export interface PayloadSchema {
  version: 1;
  required: readonly string[];
  fields: Readonly<Record<string, PayloadField>>;
  /** Reader tolerance retained for pre-existing v1 logs, not permission to omit writer fields. */
  legacyOptional: readonly string[];
}
export interface OpContract {
  status: "v1-equal" | "truth-changing";
  implemented: boolean;
  payloadVersion: string;
  required: readonly string[];
  payloadSchema: PayloadSchema | null;
  immutableTargets: string;
  placement: string;
  precedence: string;
  identity: string;
  crashBoundary: string;
  fixtures: readonly string[];
}

const text: PayloadField = { type: "string" };
const id: PayloadField = { type: "string", format: "id" };
const utc: PayloadField = { type: "string", format: "utc" };
const strings: PayloadField = { type: "string-array" };
const base: Record<string, PayloadField> = {
  schema: { type: "string", values: ["agent-hub.memory/v1"] }, op: text,
  id, at: utc, machine: { type: "string", maxLength: 64 },
};
const identity = "sha256(canonical complete payload without id), first 32 hex; schema, at and machine participate; replay INSERT OR IGNORE";
const crash = "complete newline is authoritative; append precedes derived-index refresh; incomplete tail waits; refresh/rebuild recovers a complete append";
function current(op: Entry["op"], fields: Record<string, PayloadField>, required: string[], placement: string, targets: string, precedence: string, legacyOptional: string[] = []): OpContract {
  const keys = [...Object.keys(base), ...required];
  return Object.freeze<OpContract>({
    status: "v1-equal", implemented: true, payloadVersion: "agent-hub.memory/v1",
    required: keys, payloadSchema: { version: 1, required: keys, fields: { ...base, op: { type: "string", values: [op] }, ...fields }, legacyOptional },
    immutableTargets: targets, placement, precedence, identity, crashBoundary: crash,
    fixtures: [`v1-${op}`],
  });
}
function ordinaryOp(op: Entry["op"], placement: string, targets: string, precedence: string, dated = false): OpContract {
  const hasBy = !["forget", "confirm", "reject"].includes(op);
  const by = dated ? utc : op === "supersede" ? id : op === "goal_state"
    ? { type: "string" as const, values: ["open", "active", "blocked", "done", "dropped"] } : text;
  return current(op, { target: op === "settle" ? { ...text, maxLength: 400 } : id, actor: text, ...(hasBy ? { by } : {}) },
    ["target", "actor", ...(hasBy ? ["by"] : [])], placement, targets, precedence, ["actor"]);
}

/** Exhaustive over the current writer's Entry union: adding an op requires a contract in this registry. */
const v1 = {
  note: current("note", {
    project: { type: "string", maxLength: 400 }, scope: { type: "string", values: ["project", "shared"] },
    tier: { type: "string", values: ["short", "long"] }, kind: { type: "string", values: ["decision", "finding", "contract", "fail"] },
    peer: { type: "string", maxLength: 64 }, title: text, text, task: text, about: strings,
    supersedes: id, promotedFrom: id, source: { type: "string", values: ["hub", "person", "claude-mem"] }, expires: utc,
  }, ["project", "scope", "tier", "kind", "peer", "text", "about", "source"], "short -> local; long -> synced",
  "optional supersedes and promotedFrom are full immutable entry ids; about nodes and task keys retain v1 identity",
  "newest at/id first; note supersedes joins supersede ops; promoted source hidden; expiry trusts wall clock (declared C05 rollback ceiling)", ["source"]),
  forget: ordinaryOp("forget", "follows target authored segment: local when target.local, synced otherwise", "target entry id, promotion ancestry included", "forget wins independent of timestamp; never edits source rows"),
  supersede: ordinaryOp("supersede", "follows old target authored segment: local when old.local, synced otherwise; replacement visibility never narrower", "target old id; by replacement id, never a mutable alias", "latest relation by at then replacement id; earliest cycle relation yields; gone replacement releases old entry"),
  demote: ordinaryOp("demote", "synced for long targets; local for local short targets", "target entry id; by fixed expiry", "latest demotion at/id fixes short deadline; clock rollback retains C05 ceiling", true),
  settle: ordinaryOp("settle", "local", "target immutable project#task@created key; by fixed expiry", "earliest settlement deadline wins; eligible held notes wait for promotion; clock rollback retains C05 ceiling", true),
  goal: current("goal", {
    project: { type: "string", maxLength: 400 }, scope: { type: "string", values: ["project", "shared"] },
    title: { type: "string", maxLength: 400 }, milestones: strings, dependsOn: strings, actor: text,
  }, ["project", "scope", "title", "milestones", "dependsOn", "actor"], "synced", "dependsOn goal ids; goal's full id is its immutable identity",
  "goals newest at first; initial state open; subsequent state/link/lease ops reduce separately", ["scope", "actor"]),
  goal_state: ordinaryOp("goal_state", "synced", "target full goal id; by open|active|blocked|done|dropped", "latest valid state by at/id wins"),
  goal_link: ordinaryOp("goal_link", "synced", "target full goal id; by immutable project#task@created key", "unique authored intent; links retain at/machine; identical payload replays once"),
  lease: ordinaryOp("lease", "synced", "target full goal id; by fixed UTC expiry; machine is holder identity", "claims after last forced claim; latest per machine; earliest uninterrupted active claim then machine id wins; expired holder is metadata", true),
  lease_force: ordinaryOp("lease_force", "synced", "target full goal id; by fixed UTC expiry", "latest forced claim at/id discards earlier claims, then ordinary lease ordering applies", true),
  suggest: ordinaryOp("suggest", "synced", "target source entry id; by relation:destination id", "suggestions stay dashed, never confirmed graph evidence; suggestion full id is verdict target"),
  confirm: ordinaryOp("confirm", "synced", "target immutable suggestion id", "latest confirm/reject by at/id wins; confirmation adds evidence relation only for valid endpoints"),
  reject: ordinaryOp("reject", "synced", "target immutable suggestion id", "latest confirm/reject by at/id wins; rejection excludes suggested relation from evidence"),
} satisfies Record<Entry["op"], OpContract>;

function blocked(op: string): OpContract {
  return Object.freeze({ status: "truth-changing", implemented: false, payloadVersion: "unimplemented", required: [], payloadSchema: null,
    immutableTargets: "not defined: no writer", placement: "future generation only; never local or synced shared-v1 segments",
    precedence: "not defined: person-run generation migration and contracts required first", identity: "not defined: no payload is emitted",
    crashBoundary: "refused before authoritative append", fixtures: [`deny-${op}`] });
}

export const V1_OPS: readonly Entry["op"][] = Object.freeze(Object.keys(v1) as Entry["op"][]);
export const OP_CONTRACTS: Readonly<Record<string, OpContract>> = Object.freeze({ ...v1,
  prune: blocked("prune"), correct: blocked("correct"), lift: blocked("lift"), consolidate: blocked("consolidate"), group: blocked("group"),
});

/** No reader inventory or announcement can authorize new truth in shared v1 logs. */
export function assertSharedV1Op(op: unknown): void {
  const contract = typeof op === "string" && Object.hasOwn(OP_CONTRACTS, op) ? OP_CONTRACTS[op] : undefined;
  if (!contract?.implemented || contract.status !== "v1-equal") throw new Error("operation is not allowed in shared v1 segments; a person-run generation migration and contract are required");
}

/** Separate registry: importing this metadata never authorizes prune in OP_CONTRACTS/shared v1. */
export interface GenerationPayloadField {
  type: "string" | "object" | "array";
  values?: readonly string[];
  pattern?: string;
  format?: "canonical-utc";
  required?: readonly string[];
  fields?: Readonly<Record<string, GenerationPayloadField>>;
  additionalProperties?: false;
  items?: GenerationPayloadField;
  minItems?: number;
  maxItems?: number;
  sortedUniqueBy?: string;
}
export interface GenerationOpContract extends Omit<OpContract, "implemented" | "payloadSchema"> {
  implemented: true;
  generationOnly: true;
  targetSemantics: "exact-entry-v1";
  validator: "validatePruneRow";
  validation: readonly string[];
  payloadSchema: {
    version: 1;
    required: readonly string[];
    fields: Readonly<Record<string, GenerationPayloadField>>;
    additionalProperties: false;
    maxUtf8Bytes: number;
  };
}
const generationId: GenerationPayloadField = { type: "string", pattern: "^[a-f0-9]{32}$" };
const authoredHash: GenerationPayloadField = { type: "string", pattern: "^[a-f0-9]{64}$" };
const canonicalUtc: GenerationPayloadField = { type: "string", format: "canonical-utc" };
const pruneRequired = ["schema", "op", "generation", "at", "machine", "actor", "placement", "cutoff", "targets", "id"] as const;
export const PRUNE_GENERATION_CONTRACT: GenerationOpContract = Object.freeze<GenerationOpContract>({
  status: "truth-changing", implemented: true, generationOnly: true, targetSemantics: "exact-entry-v1", validator: "validatePruneRow",
  validation: ["exact required keys at each nested level; no additional fields", "canonical UTC; cutoff <= at; each expiredAt <= cutoff", "1..32 targets, strictly sorted unique full ids; canonical row <=16384 UTF-8 bytes", "id equals first 32 hex of canonical complete payload hash excluding id", "generation and authored segment placement match the bound generation/input", "target/basis full authored hashes and explicit expires/by relationship verified separately by reducer; missing witnesses remain pending"],
  payloadVersion: "agent-mem.prune/v1", required: pruneRequired,
  payloadSchema: { version: 1, required: pruneRequired, additionalProperties: false, maxUtf8Bytes: 16_384, fields: {
    schema: { type: "string", values: ["agent-mem.prune/v1"] }, op: { type: "string", values: ["prune"] },
    generation: generationId, at: canonicalUtc, machine: { type: "string", pattern: "^[a-f0-9]{16}$" },
    actor: { type: "string", values: ["person"] }, placement: { type: "string", values: ["local", "synced"] }, cutoff: canonicalUtc, id: generationId,
    targets: { type: "array", minItems: 1, maxItems: 32, sortedUniqueBy: "id", items: {
      type: "object", required: ["id", "rowHash", "expiredAt", "basis"], additionalProperties: false, fields: {
        id: generationId, rowHash: authoredHash, expiredAt: canonicalUtc,
        basis: { type: "object", required: ["kind", "id", "rowHash"], additionalProperties: false, fields: {
          kind: { type: "string", values: ["note", "demote", "settle"] }, id: generationId, rowHash: authoredHash,
        } },
      },
    } },
  } },
  immutableTargets: "only explicit full note id plus SHA-256 of complete canonical authored row including id; exact note.expires or demote/settle.by basis id/hash; no implicit TTL/backstop proof or ancestry traversal",
  placement: "generation local by default; synced only for positively attested public target and basis already in verified cached legacy-main or generation public segments; no policy-free bypass",
  precedence: "validated exact target is permanently gone, union/idempotent across prune rows; later clock/deadline changes do not revoke it; missing witnesses pending; different IDs and independent replacements survive; raw promotion metadata remains for v1 source hiding",
  identity: "sha256(canonical complete prune payload excluding id), first 32 hex; generation/at/machine/placement/cutoff/ordered targets participate; rowHash is full SHA-256 of authored witness including id",
  crashBoundary: "fsync exact local sealed plan, mutation fence, revalidate proofs/policy, append+fsync complete row then refresh; per-row atomicity; retry skips durable IDs; incomplete own tail completes only from identical persisted-plan prefix; mismatched tail refuses",
  fixtures: ["test/generation-prune.test.ts#only explicit note expires or demote settle by values can prove expiry", "test/generation-prune.test.ts#exact-entry reducer waits for witnesses and cannot be reversed by clock or later deadlines", "test/generation-prune.test.ts#prune partitions private target or basis locally and public attestations bind only public rows", "test/generation-prune.test.ts#prune row shape hashes canonical time ordering placement and byte bounds are strict"],
});
export const GENERATION_OP_CONTRACTS: Readonly<Record<"prune", GenerationOpContract>> = Object.freeze({ prune: PRUNE_GENERATION_CONTRACT });
