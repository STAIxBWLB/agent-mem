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
