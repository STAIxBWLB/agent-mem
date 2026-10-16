import { canonicalJSON, hashJSON, validGeneration } from "./generation.ts";
import { entryId, type Entry, type NoteEntry } from "./store.ts";

export const PRUNE_ROW_MAX_BYTES = 16_384, PRUNE_PLAN_MAX_BYTES = 262_144;
export const PRUNE_ROW_MAX_TARGETS = 32, PRUNE_PLAN_MAX_ROWS = 16, PRUNE_PLAN_MAX_TARGETS = 256;
export type PrunePlacement = "local" | "synced";
export interface PruneTarget {
  id: string; rowHash: string; expiredAt: string;
  basis: { kind: "note" | "demote" | "settle"; id: string; rowHash: string };
}
export interface PruneRow {
  schema: "agent-mem.prune/v1"; op: "prune"; generation: string; at: string; machine: string; actor: "person";
  placement: PrunePlacement; cutoff: string; targets: PruneTarget[]; id: string;
}
export interface PrunePlan {
  schema: "agent-mem.prune-plan/v1"; generation: string; selectorRevision: string; project: string; policyRevision: string;
  rows: { placement: PrunePlacement; payload: PruneRow }[];
  counts: { eligible: number; selected: number; local: number; synced: number }; hasMore: boolean; seal: string;
}
export interface PruneSourceRow { row: Entry; placement: PrunePlacement; publicWitness: boolean; own?: boolean; legacy?: boolean }
export interface PruneExpiry { targetId: string; basisId: string; expiredAt: string }
export interface PruneSnapshot {
  rows: readonly PruneSourceRow[];
  /** Effective, explicit serialized deadlines only; implicit TTL/backstop expiry is never eligible. */
  expiries: readonly PruneExpiry[];
  pruned?: readonly string[];
  durablePruneIds?: readonly string[];
}
export interface PruneStorePort {
  generation: string; machine: string;
  selectorRevision(): string;
  now(): number;
  snapshot(): PruneSnapshot;
  withMutation<T>(work: () => T): T;
  /** Must persist/fsync exactly this local plan before append, refusing mismatched existing journals. */
  persistPrunePlan(plan: PrunePlan): void;
  /** Must fsync complete bytes; resume only an exact persisted-plan prefix, never rewrite a complete line. */
  appendPrune(row: PruneRow, line: string, planSeal: string): "written" | "already-durable";
  refresh(): void;
}
export interface PrunePolicyBinding { generation: string; project: string; payloadHash: string; policyRevision: string }
export interface PruneAuthorization {
  project: string; actor: "person" | "agent";
  /** The host authenticates intent. Neither this boolean nor actor is an authentication token. */
  authorize: () => boolean;
  policy?: {
    revision: () => string;
    classify: (row: PruneSourceRow) => "public" | "private" | "unknown";
    attest: (binding: PrunePolicyBinding) => boolean;
  };
}
const bytes = (value: unknown) => Buffer.byteLength(canonicalJSON(value), "utf8");
const fullId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is string => value === "absent" || sha(value);
const utc = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (): never => { throw new Error("prune unavailable: invalid, unavailable or withheld request"); };
function guard(condition: unknown): asserts condition { if (!condition) fail(); }
/** Full canonical authored row INCLUDING id, unlike the v1 entry-id hash which excludes id. */
export const pruneRowHash = (row: Entry): string => hashJSON(row);
export const prunePayloadHash = (row: PruneRow): string => hashJSON(row);
export function pruneId(row: Omit<PruneRow, "id">): string { return hashJSON(row).slice(0, 32); }
function protectedCall<T>(work: () => T): T { try { return work(); } catch { return fail(); } }

export function validatePruneRow(input: unknown, generation?: string, placement?: PrunePlacement): PruneRow {
  return protectedCall(() => {
    guard(object(input) && bytes(input) <= PRUNE_ROW_MAX_BYTES);
    const row = input as Record<string, unknown>;
    guard(exact(row, ["schema", "op", "generation", "at", "machine", "actor", "placement", "cutoff", "targets", "id"]));
    guard(row.schema === "agent-mem.prune/v1" && row.op === "prune" && validGeneration(row.generation) && utc(row.at) && utc(row.cutoff));
    guard(typeof row.machine === "string" && /^[a-f0-9]{16}$/.test(row.machine) && row.actor === "person" && ["local", "synced"].includes(String(row.placement)));
    guard((generation === undefined || row.generation === generation) && (placement === undefined || row.placement === placement));
    guard(String(row.cutoff) <= String(row.at));
    guard(Array.isArray(row.targets) && row.targets.length >= 1 && row.targets.length <= PRUNE_ROW_MAX_TARGETS);
    let previous = "";
    for (const value of row.targets as unknown[]) {
      guard(object(value) && exact(value, ["id", "rowHash", "expiredAt", "basis"]));
      const target = value as Record<string, unknown>, basis = target.basis;
      guard(fullId(target.id) && sha(target.rowHash) && utc(target.expiredAt) && target.id > previous && String(target.expiredAt) <= String(row.cutoff));
      guard(object(basis) && exact(basis, ["kind", "id", "rowHash"]) && ["note", "demote", "settle"].includes(String(basis.kind)) && fullId(basis.id) && sha(basis.rowHash));
      previous = target.id as string;
    }
    guard(fullId(row.id));
    const { id, ...body } = row;
    guard(pruneId(body as Omit<PruneRow, "id">) === id);
    return structuredClone(row) as unknown as PruneRow;
  });
}
function sources(snapshot: PruneSnapshot): Map<string, PruneSourceRow> {
  const result = new Map<string, PruneSourceRow>();
  for (const source of snapshot.rows) {
    const row = source.row, previous = result.get(row.id);
    guard(fullId(row.id) && utc(row.at) && row.schema === "agent-hub.memory/v1");
    const { id, ...body } = row;
    guard(entryId(body) === id);
    guard(!previous || canonicalJSON(previous.row) === canonicalJSON(row));
    // Any verified public occurrence establishes provenance; local-only occurrences never establish it.
    if (!previous || source.publicWitness && source.placement === "synced") result.set(row.id, source);
  }
  return result;
}
function proof(target: PruneTarget, row: PruneRow, all: Map<string, PruneSourceRow>): "valid" | "pending" | "invalid" {
  const note = all.get(target.id)?.row, basis = all.get(target.basis.id)?.row;
  if (!note || !basis) return "pending";
  if (note.op !== "note" || pruneRowHash(note) !== target.rowHash || pruneRowHash(basis) !== target.basis.rowHash || note.at > row.cutoff || basis.at > row.cutoff || basis.op !== target.basis.kind) return "invalid";
  if (basis.op === "note") return basis.id === note.id && utc(basis.expires) && basis.expires === target.expiredAt ? "valid" : "invalid";
  if (basis.op === "demote") return basis.target === note.id && utc(basis.by) && basis.by === target.expiredAt ? "valid" : "invalid";
  if (basis.op === "settle") return !!note.task && basis.target === note.task && utc(basis.by) && basis.by === target.expiredAt ? "valid" : "invalid";
  return "invalid";
}
/** Pure exact-entry reducer. No clock, writer policy, ancestry traversal, append or mutation occurs here. */
export function reducePruneRows(rows: readonly { row: unknown; placement: PrunePlacement }[], snapshot: PruneSnapshot, generation: string): { targets: Set<string>; pending: string[]; invalid: number } {
  const targets = new Set<string>(), pending: string[] = [];
  let invalid = 0;
  const all = sources(snapshot);
  for (const input of rows) {
    let row: PruneRow;
    try { row = validatePruneRow(input.row, generation, input.placement); } catch { invalid++; continue; }
    const states = row.targets.map(target => proof(target, row, all));
    if (states.includes("invalid")) { invalid++; continue; }
    if (states.includes("pending")) { pending.push(row.id); continue; }
    if (row.placement === "synced" && row.targets.some(target => [target.id, target.basis.id].some(id => !all.get(id)?.publicWitness || all.get(id)?.placement !== "synced"))) { invalid++; continue; }
    for (const target of row.targets) targets.add(target.id);
  }
  return { targets, pending: [...new Set(pending)].sort(), invalid };
}
function authenticate(port: PruneStorePort, auth: PruneAuthorization): void {
  guard(validGeneration(port.generation) && /^[a-f0-9]{16}$/.test(port.machine) && revision(port.selectorRevision()));
  guard(auth.actor === "person" && typeof auth.authorize === "function" && auth.authorize() === true && typeof auth.project === "string" && auth.project.length > 0);
}
function policyRevision(auth: PruneAuthorization): string {
  if (!auth.policy) return "local-only";
  const current = auth.policy.revision();
  guard(typeof current === "string" && current.length > 0 && Buffer.byteLength(current, "utf8") <= 1024 && current !== "local-only");
  return current;
}
function visible(note: NoteEntry, project: string): boolean { return note.project === project || note.scope === "shared"; }
function targetFor(id: string, snapshot: PruneSnapshot, all: Map<string, PruneSourceRow>, cutoff: string, project: string): PruneTarget | undefined {
  const found = all.get(id), expiry = snapshot.expiries.find(item => item.targetId === id);
  if (!found || found.row.op !== "note" || !visible(found.row, project) || !expiry || !utc(expiry.expiredAt) || expiry.expiredAt > cutoff) return undefined;
  const basis = all.get(expiry.basisId)?.row;
  if (!basis || !["note", "demote", "settle"].includes(basis.op)) return undefined;
  const target: PruneTarget = { id, rowHash: pruneRowHash(found.row), expiredAt: expiry.expiredAt, basis: { kind: basis.op as "note" | "demote" | "settle", id: basis.id, rowHash: pruneRowHash(basis) } };
  const shell = { cutoff } as PruneRow;
  return proof(target, shell, all) === "valid" ? target : undefined;
}
function placementFor(target: PruneTarget, all: Map<string, PruneSourceRow>, auth: PruneAuthorization): PrunePlacement {
  if (!auth.policy) return "local";
  const sources = [all.get(target.id)!, all.get(target.basis.id)!];
  const verdicts = sources.map(source => auth.policy!.classify(structuredClone(source)));
  guard(verdicts.every(value => ["public", "private", "unknown"].includes(value)));
  return sources.every(source => source.placement === "synced" && source.publicWitness) && verdicts.every(verdict => verdict === "public") ? "synced" : "local";
}
function attest(row: PruneRow, auth: PruneAuthorization, expectedRevision: string): void {
  guard(policyRevision(auth) === expectedRevision);
  if (row.placement === "synced") guard(!!auth.policy && auth.policy.attest({ generation: row.generation, project: auth.project, payloadHash: prunePayloadHash(row), policyRevision: expectedRevision }) === true);
  guard(policyRevision(auth) === expectedRevision);
}
function sealPlan(plan: Omit<PrunePlan, "seal">): PrunePlan { return { ...plan, seal: hashJSON(plan) }; }
function checkPlanSize(plan: PrunePlan): boolean { return bytes(plan) <= PRUNE_PLAN_MAX_BYTES && plan.rows.length <= PRUNE_PLAN_MAX_ROWS && plan.counts.selected <= PRUNE_PLAN_MAX_TARGETS; }

export function planPrune(port: PruneStorePort, input: { cutoff: string; targets?: readonly string[] }, auth: PruneAuthorization): PrunePlan {
  return protectedCall(() => {
    authenticate(port, auth); guard(utc(input.cutoff) && input.cutoff <= new Date(port.now()).toISOString());
    const explicit = input.targets !== undefined;
    if (explicit) guard(Array.isArray(input.targets) && input.targets!.length >= 1 && input.targets!.length <= PRUNE_PLAN_MAX_TARGETS && input.targets!.every(fullId) && new Set(input.targets).size === input.targets!.length);
    const snapshot = port.snapshot(), all = sources(snapshot), already = new Set(snapshot.pruned ?? []);
    const ids = explicit ? [...input.targets!] : snapshot.expiries.map(expiry => expiry.targetId).filter(id => !already.has(id));
    const candidates: { target: PruneTarget; placement: PrunePlacement }[] = [];
    for (const id of [...new Set(ids)].sort()) {
      const target = targetFor(id, snapshot, all, input.cutoff, auth.project);
      if (!target || already.has(id)) { if (explicit) fail(); else continue; }
      guard(target !== undefined);
      candidates.push({ target, placement: placementFor(target, all, auth) });
    }
    const currentPolicy = policyRevision(auth), selector = port.selectorRevision(), at = new Date(port.now()).toISOString();
    const build = (selected: typeof candidates): PrunePlan => {
      const rows: PrunePlan["rows"] = [];
      for (const placement of ["local", "synced"] as const) {
        const targets = selected.filter(item => item.placement === placement).map(item => item.target);
        for (let index = 0; index < targets.length; index += PRUNE_ROW_MAX_TARGETS) {
          const body: Omit<PruneRow, "id"> = { schema: "agent-mem.prune/v1", op: "prune", generation: port.generation, at, machine: port.machine, actor: "person", placement, cutoff: input.cutoff, targets: targets.slice(index, index + PRUNE_ROW_MAX_TARGETS) };
          const payload = validatePruneRow({ ...body, id: pruneId(body) }); rows.push({ placement, payload });
        }
      }
      return sealPlan({ schema: "agent-mem.prune-plan/v1", generation: port.generation, selectorRevision: selector, project: auth.project, policyRevision: currentPolicy, rows,
        counts: { eligible: candidates.length, selected: selected.length, local: selected.filter(item => item.placement === "local").length, synced: selected.filter(item => item.placement === "synced").length }, hasMore: selected.length < candidates.length });
    };
    let selected = candidates.slice(0, PRUNE_PLAN_MAX_TARGETS), plan = build(selected);
    while (!checkPlanSize(plan) && selected.length) { if (explicit) fail(); selected = selected.slice(0, -1); plan = build(selected); }
    guard(checkPlanSize(plan));
    for (const row of plan.rows) attest(row.payload, auth, currentPolicy);
    guard(port.selectorRevision() === selector && policyRevision(auth) === currentPolicy);
    return plan;
  });
}

export function validatePrunePlan(input: unknown): PrunePlan {
  return protectedCall(() => {
    if (typeof input === "string") { guard(Buffer.byteLength(input, "utf8") <= PRUNE_PLAN_MAX_BYTES); input = JSON.parse(input); }
    guard(object(input) && bytes(input) <= PRUNE_PLAN_MAX_BYTES);
    const p = input as Record<string, unknown>;
    guard(exact(p, ["schema", "generation", "selectorRevision", "project", "policyRevision", "rows", "counts", "hasMore", "seal"]));
    guard(p.schema === "agent-mem.prune-plan/v1" && validGeneration(p.generation) && revision(p.selectorRevision) && typeof p.project === "string" && p.project.length > 0 && typeof p.policyRevision === "string" && p.policyRevision.length > 0 && typeof p.hasMore === "boolean" && sha(p.seal));
    guard(Array.isArray(p.rows) && p.rows.length <= PRUNE_PLAN_MAX_ROWS && object(p.counts) && exact(p.counts, ["eligible", "selected", "local", "synced"]));
    const counts = p.counts as Record<string, unknown>;
    guard(Object.values(counts).every(value => Number.isSafeInteger(value) && Number(value) >= 0));
    let total = 0, local = 0, previous = "";
    const seen = new Set<string>();
    for (const value of p.rows as unknown[]) {
      guard(object(value) && exact(value, ["placement", "payload"]) && ["local", "synced"].includes(String(value.placement)));
      const row = validatePruneRow(value.payload, p.generation as string, value.placement as PrunePlacement);
      const order = `${row.placement === "local" ? "0" : "1"}:${row.targets[0]!.id}`; guard(order > previous); previous = order;
      for (const target of row.targets) { guard(!seen.has(target.id)); seen.add(target.id); }
      total += row.targets.length; if (row.placement === "local") local += row.targets.length;
    }
    guard(total <= PRUNE_PLAN_MAX_TARGETS && total === counts.selected && local === counts.local && total - local === counts.synced && Number(counts.eligible) >= total && p.hasMore === (Number(counts.eligible) > total));
    const { seal, ...body } = p; guard(hashJSON(body) === seal);
    return structuredClone(p) as unknown as PrunePlan;
  });
}
export function applyPrune(port: PruneStorePort, input: unknown, auth: PruneAuthorization): { completed: string[] } {
  return protectedCall(() => {
    authenticate(port, auth);
    const plan = validatePrunePlan(input);
    return port.withMutation(() => {
      authenticate(port, auth);
      guard(plan.generation === port.generation && plan.project === auth.project && plan.selectorRevision === port.selectorRevision() && plan.policyRevision === policyRevision(auth));
      const verify = () => {
        const snapshot = port.snapshot(), all = sources(snapshot), durable = new Set(snapshot.durablePruneIds ?? []);
        for (const item of plan.rows) {
          guard(item.payload.machine === port.machine);
          if (durable.has(item.payload.id)) continue;
          for (const target of item.payload.targets) {
            const current = targetFor(target.id, snapshot, all, item.payload.cutoff, auth.project);
            guard(!!current && canonicalJSON(current) === canonicalJSON(target) && placementFor(target, all, auth) === item.placement);
          }
          guard(item.payload.at <= new Date(port.now()).toISOString());
          attest(item.payload, auth, plan.policyRevision);
        }
        guard(plan.selectorRevision === port.selectorRevision() && plan.policyRevision === policyRevision(auth));
        return durable;
      };
      verify(); verify(); // A policy callback can mutate external state; re-read immutable proofs before effects.
      port.persistPrunePlan(plan);
      const completed: string[] = [];
      for (const item of plan.rows) {
        verify();
        // Parsed complete bytes are not proof of a successful fsync; the backend must reconfirm durability.
        port.appendPrune(item.payload, canonicalJSON(item.payload) + "\n", plan.seal);
        completed.push(item.payload.id);
      }
      port.refresh();
      return { completed };
    });
  });
}
