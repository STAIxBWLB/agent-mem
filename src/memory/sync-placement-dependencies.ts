import { types } from "node:util";
import { checkedEntry } from "./bridge.ts";
import { canonicalJSON, hashJSON, validateVaultLinkRow } from "./generation.ts";
import { OP_CONTRACTS } from "./ops-contract.ts";
import { validatePruneRow } from "./prune.ts";
import { SUGGESTED } from "./store.ts";
import { placementKeyId, validatePlacementKey, type PlacementKey, type PlacementRealm } from "./sync-placement-journal-format.ts";
import type { OutboundVerdict, SyncPolicyCategory } from "./sync-screen.ts";

export interface DependencySource {
  key: PlacementKey; row: unknown; sourcePlacement: "local" | "synced"; policy: OutboundVerdict; held: boolean;
}
/** Trusted input only after the caller independently verifies the exact public occurrence.
 * Neither source placement nor a journal exposure flag constitutes this proof. */
export interface VerifiedDependencyEndpoint { key: PlacementKey; row: unknown }
export interface PlacementDependencyInput {
  generation: string; selectedRealms: readonly PlacementRealm[]; rows: readonly DependencySource[];
  publicEndpoints?: readonly VerifiedDependencyEndpoint[];
  /** Exact original prune keys whose complete realm/generation/target/basis witness graph the caller verified. */
  verifiedPrunes?: readonly PlacementKey[];
}
export type DependencyHoldReason = SyncPolicyCategory | "journal-hold" | "source-local" | "related-local" | "unsupported-reference" | "unverified-prune";
export interface DependencyDecision { key: PlacementKey; eligible: boolean; reason?: DependencyHoldReason; dependencies: PlacementKey[] }
export class PlacementDependencyInputError extends Error {
  constructor() { super("Sync placement dependency inputs are invalid, incomplete or exceed supported bounds; capture and verify the selected sources again."); this.name = "PlacementDependencyInputError"; }
}
function fail(): never { throw new PlacementDependencyInputError(); }
const fullId = (v: unknown): v is string => typeof v === "string" && v.length === 32 && /^[a-f0-9]+$/.test(v);
const realmId = (v: PlacementRealm) => canonicalJSON(v);
const categories: readonly string[] = ["secret", "personal-data", "deny-path", "private-or-invalid", "host"];
interface Reference { id: string; op?: "note" | "goal" | "suggest"; hash?: string; publicHeld?: boolean; sameRealm?: boolean }
interface Node {
  key: PlacementKey; row: Record<string, unknown>; output: boolean; sourcePlacement: "local" | "synced";
  policy: OutboundVerdict; held: boolean; public: boolean; reason?: DependencyHoldReason; syntaxValid: boolean; refs: Reference[];
}
/** Descriptor-only bounded JSON copy, including private flags: those are data for the mandatory verdict,
 * never a reason to invoke getters or silently omit a source. */
// Check physical cardinality and canonical source bytes before constructing any copied source collection.
function preflight(raw: unknown): void {
  const descriptors = (value: unknown, array = false) => {
    if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) !== array || Object.getOwnPropertySymbols(value).length) return fail();
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail();
    return Object.getOwnPropertyDescriptors(value);
  };
  const fields = descriptors(raw);
  const arrayFields = (value: unknown, max: number) => {
    if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value)) return fail();
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length > max) return fail();
    const own = descriptors(value, true);
    if (Object.keys(own).length !== length + 1) return fail();
    for (let i = 0; i < length; i++) if (!own[String(i)] || !("value" in own[String(i)]!) || !own[String(i)]!.enumerable) fail();
    return { own, length: length as number };
  };
  for (const [key, field] of Object.entries(fields)) if (!("value" in field) || !field.enumerable || !["generation", "selectedRealms", "rows", "publicEndpoints", "verifiedPrunes"].includes(key)) fail();
  arrayFields(fields.selectedRealms?.value, 256);
  const sources = arrayFields(fields.rows?.value, 20000);
  let bytes = 0, nodes = 0;
  const seen = new Set<object>();
  const size = (v: unknown, depth: number): number => {
    if (++nodes > 1_000_000 || depth > 64) return fail();
    if (v === null) return 4;
    if (typeof v === "boolean") return v ? 4 : 5;
    if (typeof v === "number") { if (!Number.isFinite(v)) return fail(); return String(v).length; }
    if (typeof v === "string") { if (Buffer.byteLength(v) > 8 * 1024 * 1024) return fail(); return Buffer.byteLength(JSON.stringify(v)); }
    if (!v || typeof v !== "object" || types.isProxy(v) || seen.has(v)) return fail();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const { own, length } = arrayFields(v, 20000); let total = 2 + Math.max(0, length - 1);
        for (let i = 0; i < length; i++) { total += size(own[String(i)]!.value, depth + 1); if (total > 8 * 1024 * 1024) fail(); }
        return total;
      }
      const own = descriptors(v); let total = 2, count = 0;
      for (const [key, field] of Object.entries(own)) {
        if (!("value" in field) || !field.enumerable) fail();
        total += size(key, depth + 1) + 1 + size(field.value, depth + 1) + Number(count++ > 0);
        if (total > 8 * 1024 * 1024) fail();
      }
      return total;
    } finally { seen.delete(v); }
  };
  for (let i = 0; i < sources.length; i++) {
    const source = descriptors(sources.own[String(i)]!.value), row = source.row;
    if (!row || !("value" in row)) return fail();
    bytes += size(row.value, 0) + 1;
    if (bytes > 8 * 1024 * 1024) fail();
  }
  for (const key of ["publicEndpoints", "verifiedPrunes"]) if (fields[key]) arrayFields(fields[key]!.value, 20000);
}
/** ponytail: descriptor-only JSON safety stops at depth64, one million nodes and16MiB including supplied evidence.
 * A reviewed chunked endpoint interface is required before larger proofs can enter this compiler. */
function copyInput(value: unknown): unknown {
  let bytes = 0, nodes = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 1_000_000 || depth > 64) fail();
    if (v === null || typeof v === "boolean") { bytes += 5; return v; }
    if (typeof v === "number") { if (!Number.isFinite(v)) fail(); bytes += 24; return v; }
    if (typeof v === "string") { bytes += Buffer.byteLength(v); if (bytes > 16 * 1024 * 1024) fail(); return v; }
    if (!v || typeof v !== "object" || types.isProxy(v) || seen.has(v) || Object.getOwnPropertySymbols(v).length) fail();
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail();
    const fields = Object.getOwnPropertyDescriptors(v); seen.add(v);
    try {
      if (array) {
        const length = fields.length?.value;
        if (!Number.isSafeInteger(length) || length > 20000 || Object.keys(fields).length !== length + 1) fail();
        const out: unknown[] = [];
        for (let i = 0; i < length; i++) { const field = fields[String(i)]; if (!field || !("value" in field) || !field.enumerable) fail(); out.push(visit(field.value, depth + 1)); }
        return out;
      }
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, field] of Object.entries(fields)) { if (!("value" in field) || !field.enumerable) fail(); bytes += Buffer.byteLength(key); out[key] = visit(field.value, depth + 1); }
      return out;
    } finally { seen.delete(v); }
  };
  return visit(value, 0);
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return fail(); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) fail();
}
function realm(value: unknown): PlacementRealm { return validatePlacementKey({ realm: value, id: "0".repeat(32), rowHash: "0".repeat(64) }).realm; }
function syntax(node: Node, generation: string): boolean {
  const row = node.row;
  try {
    // Existing validators require a plain JSON object, not our safe null-prototype copy.
    const plain = JSON.parse(canonicalJSON(row));
    if (row.op === "prune") validatePruneRow(plain, generation, node.sourcePlacement);
    else if (row.op === "vault_link") validateVaultLinkRow(plain, generation, "local");
    else if (typeof row.op === "string" && Object.hasOwn(OP_CONTRACTS, row.op)) checkedEntry(plain);
    else return false;
    return true;
  } catch { return false; }
}
function utc(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function suggestion(row: Record<string, unknown>): { from: string; to: string } | undefined {
  if (row.op !== "suggest" || !fullId(row.target) || typeof row.by !== "string") return;
  const match = /^([^:]+):([a-f0-9]{32})$/.exec(row.by);
  if (!match || match[0] !== row.by || !(SUGGESTED as readonly string[]).includes(match[1]!) || row.target === match[2]) return;
  return { from: row.target, to: match[2]! };
}
function visible(from: Node, to: Node): boolean {
  // Shared/user facts must not acquire a dependency on a private project endpoint.
  const sharedEndpoint = to.key.realm.scope === "user" && (to.row.scope === undefined || to.row.scope === "shared");
  if (from.key.realm.scope === "user" || from.row.scope === "shared") return sharedEndpoint;
  return sharedEndpoint
    || from.key.realm.scope === "project" && to.key.realm.scope === "project" && from.key.realm.keyHash === to.key.realm.keyHash;
}
/** Pure, body-free dependency decisions. The caller supplies authoritative coalesced physical rows and
 * mandatory policy/journal verdicts; this function performs no screening, hydration, I/O or publication. */
export function compilePlacementDependencies(raw: PlacementDependencyInput): DependencyDecision[] {
  try { return compile(raw); } catch (error) { if (error instanceof PlacementDependencyInputError) throw error; return fail(); }
}
function compile(raw: PlacementDependencyInput): DependencyDecision[] {
  preflight(raw);
  const input = object(copyInput(raw)); keys(input, ["generation", "selectedRealms", "rows"], ["publicEndpoints", "verifiedPrunes"]);
  if (!fullId(input.generation) || !Array.isArray(input.selectedRealms) || input.selectedRealms.length > 256 || !Array.isArray(input.rows)
    || input.rows.length > 20000 || input.publicEndpoints !== undefined && !Array.isArray(input.publicEndpoints)
    || input.verifiedPrunes !== undefined && !Array.isArray(input.verifiedPrunes)) return fail();
  const selected = new Set(input.selectedRealms.map(x => realmId(realm(x)))); if (!selected.size || selected.size !== input.selectedRealms.length) fail();
  const nodes: Node[] = [], byKey = new Map<string, Node>(), byId = new Map<string, Node[]>(), hashes = new Map<string, string>();
  let sourceBytes = 0;
  const add = (value: unknown, output: boolean): void => {
    const item = object(value); keys(item, output ? ["key", "row", "sourcePlacement", "policy", "held"] : ["key", "row"]);
    const key = validatePlacementKey(item.key), row = object(item.row), id = placementKeyId(key);
    if (!selected.has(realmId(key.realm)) || row.id !== key.id || hashJSON(row) !== key.rowHash) fail();
    if (hashes.has(key.id) && hashes.get(key.id) !== key.rowHash) fail(); hashes.set(key.id, key.rowHash);
    if (output && (sourceBytes += Buffer.byteLength(canonicalJSON(row) + "\n")) > 8 * 1024 * 1024) fail();
    let policy: OutboundVerdict = { ok: true };
    if (output) {
      const verdict = object(item.policy); keys(verdict, ["ok"], ["category"]);
      if (verdict.ok === false && typeof verdict.category === "string" && categories.includes(verdict.category)) policy = { ok: false, category: verdict.category as SyncPolicyCategory };
      else if (verdict.ok !== true || Object.hasOwn(verdict, "category")) fail();
      if (!["local", "synced"].includes(item.sourcePlacement as string) || typeof item.held !== "boolean") fail();
    }
    const old = byKey.get(id);
    if (old) { if (output || old.public) fail(); old.public = true; return; }
    const node: Node = { key, row, output, sourcePlacement: output ? item.sourcePlacement as "local" | "synced" : "synced", policy,
      held: output ? item.held as boolean : false, public: !output, syntaxValid: false, refs: [] };
    nodes.push(node); byKey.set(id, node); byId.set(key.id, [...(byId.get(key.id) ?? []), node]);
  };
  for (const value of input.rows) add(value, true);
  const endpoints = input.publicEndpoints as unknown[] | undefined;
  if ((endpoints?.length ?? 0) > 20000) fail(); for (const value of endpoints ?? []) add(value, false);
  const proofs = input.verifiedPrunes as unknown[] | undefined;
  if ((proofs?.length ?? 0) > 20000) fail();
  const verified = new Set((proofs ?? []).map(value => { const key = validatePlacementKey(value); if (!selected.has(realmId(key.realm))) fail(); return placementKeyId(key); }));
  const heldIds = new Set(nodes.filter(node => node.held).map(node => node.key.id));
  const policyHolds = new Map<string, SyncPolicyCategory>();
  for (const node of nodes) if (!node.policy.ok) policyHolds.set(node.key.id, node.policy.category);
  const refs = (node: Node, ids: unknown[], op?: Reference["op"], publicHeld = false): boolean => {
    if (ids.some(id => !fullId(id))) return false;
    node.refs.push(...ids.map(id => ({ id: id as string, ...(op ? { op } : {}), ...(publicHeld ? { publicHeld: true } : {}) }))); return true;
  };
  for (const node of nodes) {
    const row = node.row;
    node.syntaxValid = syntax(node, input.generation);
    if (!node.syntaxValid) { node.reason = "unsupported-reference"; continue; }
    if (node.sourcePlacement === "local" || row.op === "settle" || row.op === "vault_link" || row.op === "note" && row.tier === "short") node.reason = "source-local";
    else if (heldIds.has(node.key.id)) node.reason = "journal-hold";
    else if (policyHolds.has(node.key.id)) node.reason = policyHolds.get(node.key.id)!;
    let valid = true;
    switch (row.op) {
      case "note": break; // Both ancestry fields are weak; never fetch or export their originals.
      case "goal": valid = Array.isArray(row.dependsOn) && refs(node, row.dependsOn, "goal"); break;
      case "supersede": valid = row.target !== row.by && refs(node, [row.target, row.by], "note"); break;
      case "goal_state": valid = ["open", "active", "blocked", "done", "dropped"].includes(row.by as string) && refs(node, [row.target], "goal"); break;
      case "goal_link": valid = typeof row.by === "string" && row.by.length > 0 && refs(node, [row.target], "goal"); break;
      case "lease": case "lease_force": valid = utc(row.by) && refs(node, [row.target], "goal"); break;
      case "suggest": { const edge = suggestion(row); valid = !!edge && refs(node, [edge.from, edge.to], "note"); break; }
      case "confirm": case "reject": {
        valid = refs(node, [row.target], "suggest");
        const suggestions = fullId(row.target) ? byId.get(row.target) ?? [] : [];
        const edge = suggestions.map(n => suggestion(n.row)).find(Boolean);
        valid = valid && !!edge && refs(node, [edge.from, edge.to], "note"); break;
      }
      case "forget": valid = refs(node, [row.target], "note", true); break;
      case "demote": valid = utc(row.by) && refs(node, [row.target], "note", true); break;
      case "prune":
        if (!verified.has(placementKeyId(node.key))) node.reason ??= "unverified-prune";
        for (const target of row.targets as { id: string; rowHash: string; basis: { id: string; rowHash: string } }[]) {
          node.refs.push({ id: target.id, hash: target.rowHash, sameRealm: true, publicHeld: true }, { id: target.basis.id, hash: target.basis.rowHash, sameRealm: true, publicHeld: true });
        }
        break;
      case "settle": case "vault_link": break;
      default: valid = false;
    }
    if (!valid) node.reason ??= "unsupported-reference";
  }
  const candidates = (from: Node, ref: Reference): Node[] => (byId.get(ref.id) ?? []).filter(to => visible(from, to)
    && (!ref.op || to.row.op === ref.op) && (!ref.hash || to.key.rowHash === ref.hash)
    && (!ref.sameRealm || realmId(from.key.realm) === realmId(to.key.realm)));
  const usable = (from: Node, ref: Reference): Node | undefined => candidates(from, ref).find(to => {
    if (to.public && ref.publicHeld && to.syntaxValid) return true;
    return !heldIds.has(to.key.id) && !policyHolds.has(to.key.id) && !to.reason;
  });
  const reverse = new Map<string, Set<Node>>();
  for (const node of nodes) for (const ref of node.refs) {
    let dependents = reverse.get(ref.id); if (!dependents) reverse.set(ref.id, dependents = new Set()); dependents.add(node);
  }
  const queue = [...nodes];
  for (let at = 0; at < queue.length; at++) {
    const node = queue[at]!; if (node.reason) continue;
    const endpoints = node.refs.map(ref => usable(node, ref));
    let good = endpoints.every(Boolean);
    if (good && node.row.op === "supersede") good = endpoints[0]!.row.scope !== "shared" || endpoints[1]!.row.scope === "shared";
    if (!good) { node.reason = "related-local"; for (const dependent of reverse.get(node.key.id) ?? []) queue.push(dependent); }
  }
  return nodes.filter(node => node.output).map(node => ({ key: validatePlacementKey(node.key), eligible: !node.reason,
    ...(node.reason ? { reason: node.reason } : {}), dependencies: [...new Map(node.refs.flatMap(ref => candidates(node, ref).map(to => [placementKeyId(to.key), to.key] as const))).values()].sort((a,b) => placementKeyId(a).localeCompare(placementKeyId(b))).map(validatePlacementKey) }))
    .sort((a,b) => placementKeyId(a.key).localeCompare(placementKeyId(b.key)));
}
