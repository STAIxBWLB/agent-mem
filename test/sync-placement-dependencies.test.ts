import { expect, test } from "bun:test";
import { entryId } from "../src/memory/store.ts";
import { hashJSON, vaultLinkId } from "../src/memory/generation.ts";
import { pruneId, type PruneRow } from "../src/memory/prune.ts";
import { compilePlacementDependencies, PlacementDependencyInputError, type DependencySource,
  type PlacementDependencyInput, type VerifiedDependencyEndpoint } from "../src/memory/sync-placement-dependencies.ts";
import { type PlacementKey, type PlacementRealm } from "../src/memory/sync-placement-journal-format.ts";

const G = "1".repeat(32), P: PlacementRealm = { scope: "project", keyHash: "2".repeat(64) }, U: PlacementRealm = { scope: "user" };
const AT = "2026-10-01T00:00:00.000Z", UNTIL = "2026-11-01T00:00:00.000Z";
let serial = 0;
function authored(op: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const body = { schema: "agent-hub.memory/v1", op, machine: "3".repeat(16), at: AT, ...extra };
  return { ...body, id: entryId(body as never) };
}
function note(extra: Record<string, unknown> = {}) {
  return authored("note", { project: "synthetic-project", scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: `synthetic private-canary ${serial++}`, about: [], ...extra });
}
function goal(dependsOn: string[] = [], extra: Record<string, unknown> = {}) {
  return authored("goal", { project: "synthetic-project", scope: "project", title: `synthetic goal ${serial++}`, milestones: [], dependsOn, actor: "person", ...extra });
}
function key(row: Record<string, unknown>, realm: PlacementRealm = P): PlacementKey { return { realm, id: row.id as string, rowHash: hashJSON(row) }; }
function source(row: Record<string, unknown>, options: Partial<DependencySource> = {}): DependencySource {
  return { key: key(row), row, sourcePlacement: "synced", policy: { ok: true }, held: false, ...options };
}
function input(rows: DependencySource[], extra: Partial<PlacementDependencyInput> = {}): PlacementDependencyInput { return { generation: G, selectedRealms: [P, U], rows, ...extra }; }
function decisions(rows: DependencySource[], extra: Partial<PlacementDependencyInput> = {}) { return compilePlacementDependencies(input(rows, extra)); }
function forRow(result: ReturnType<typeof decisions>, row: Record<string, unknown>) { return result.find(decision => decision.key.id === row.id)!; }
const endpoint = (row: Record<string, unknown>, realm: PlacementRealm = P): VerifiedDependencyEndpoint => ({ key: key(row, realm), row });
function op(kind: string, target: Record<string, unknown>, by?: string) { return authored(kind, { target: target.id, actor: "person", ...(by === undefined ? {} : { by }) }); }

test("the operation table admits exact eligible endpoints without hydrating weak note ancestry", () => {
  const a = note(), b = note(), g = goal(), dependent = goal([g.id as string]);
  const weak = note({ promotedFrom: "a".repeat(32), supersedes: "b".repeat(32), task: "opaque#task@1", about: ["mem:opaque"] });
  const suggestion = op("suggest", a, `contradicts:${b.id}`);
  const operations = [op("supersede", a, b.id as string), op("goal_state", g, "active"), op("goal_link", g, "synthetic-project#42@1000"),
    op("lease", g, UNTIL), op("lease_force", g, UNTIL), suggestion, op("confirm", suggestion), op("reject", suggestion), op("forget", a), op("demote", a, UNTIL)];
  const result = decisions([a, b, g, dependent, weak, ...operations].map(row => source(row)));
  expect(result.every(row => row.eligible)).toBe(true);
  expect(forRow(result, weak).dependencies).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("private-canary");
  expect(JSON.stringify(result)).not.toContain("synthetic-project");
  expect(result).toHaveLength(15);
});

test("private goal dependencies propagate through a fixed point independent of input order", () => {
  const privateGoal = goal(), middle = goal([privateGoal.id as string]), last = goal([middle.id as string]);
  const state = op("goal_state", last, "done"), link = op("goal_link", last, "opaque#task@1");
  const rows = [source(state), source(link), source(last), source(middle), source(privateGoal, { policy: { ok: false, category: "host" } })];
  const result = decisions(rows);
  for (const row of [middle, last, state, link]) expect(forRow(result, row)).toMatchObject({ eligible: false, reason: "related-local" });
  expect(forRow(result, privateGoal)).toMatchObject({ eligible: false, reason: "host" });
  expect(decisions([...rows].reverse())).toEqual(result);
});

test("historically public held goals, replacements and suggestion endpoints keep strong dependents held", () => {
  const a = note(), b = note(), g = goal(), suggestion = op("suggest", a, `same_topic:${b.id}`);
  const relation = op("supersede", a, b.id as string), state = op("goal_state", g, "active"), confirm = op("confirm", suggestion);
  const result = decisions([source(a), source(b, { held: true }), source(g, { held: true }), source(suggestion), source(relation), source(state), source(confirm)],
    { publicEndpoints: [endpoint(b), endpoint(g), endpoint(suggestion)] });
  for (const row of [suggestion, relation, state, confirm]) expect(forRow(result, row).eligible).toBe(false);
});

test("forget and demote can affect a verified public held target without selecting its body for export", () => {
  const target = note(), forget = op("forget", target), demote = op("demote", target, UNTIL);
  const rows = [source(target, { held: true, policy: { ok: false, category: "secret" } }), source(forget), source(demote)];
  const absent = decisions(rows);
  expect(forRow(absent, forget).eligible).toBe(false); expect(forRow(absent, demote).eligible).toBe(false);
  const proven = decisions(rows, { publicEndpoints: [endpoint(target)] });
  expect(forRow(proven, target).eligible).toBe(false);
  expect(forRow(proven, forget).eligible).toBe(true); expect(forRow(proven, demote).eligible).toBe(true);
  const evidenceOnly = decisions([source(forget)], { publicEndpoints: [endpoint(target)] });
  expect(evidenceOnly).toHaveLength(1); expect(evidenceOnly[0]?.eligible).toBe(true);
});

test("malformed public endpoints do not satisfy even the forget/demote exception", () => {
  const malformed = { ...note(), schema: "future" }, forget = op("forget", malformed);
  expect(forRow(decisions([source(forget)], { publicEndpoints: [endpoint(malformed)] }), forget).eligible).toBe(false);
});

test("journal and mandatory policy holds cannot be bypassed through alternate physical copies", () => {
  const a = note({ scope: "shared" }), g = goal();
  const duplicate = source(a, { key: key(a, U) });
  for (const hold of [{ held: true }, { policy: { ok: false as const, category: "deny-path" as const } }]) {
    const result = decisions([source(a, hold), duplicate]);
    expect(result.every(row => !row.eligible)).toBe(true);
  }
  // A required goal uses the same union rule, even if a public alternate copy exists.
  const dependent = goal([g.id as string]);
  expect(forRow(decisions([source(g, { held: true }), source(dependent)], { publicEndpoints: [endpoint(g, U)] }), dependent).eligible).toBe(false);
});

test("selected user/project visibility permits shared dependencies and refuses narrowing or unopened realms", () => {
  const shared = goal([], { scope: "shared" }), privateGoal = goal(), userDependent = goal([privateGoal.id as string], { scope: "shared" });
  const projectDependent = goal([shared.id as string]);
  const rows = [source(shared, { key: key(shared, U) }), source(privateGoal), source(userDependent, { key: key(userDependent, U) }), source(projectDependent)];
  const result = decisions(rows);
  expect(forRow(result, projectDependent).eligible).toBe(true); expect(forRow(result, userDependent).eligible).toBe(false);
  const sharedState = op("goal_state", shared, "active");
  expect(forRow(decisions([source(shared, { key: key(shared, U) }), source(sharedState, { key: key(sharedState, U) })]), sharedState).eligible).toBe(true);
  const old = note({ scope: "shared" }), replacement = note(), supersede = op("supersede", old, replacement.id as string);
  expect(forRow(decisions([source(old, { key: key(old, U) }), source(replacement), source(supersede)]), supersede).eligible).toBe(false);
  const foreign: PlacementRealm = { scope: "project", keyHash: "f".repeat(64) };
  expect(() => decisions([source(privateGoal, { key: key(privateGoal, foreign) })])).toThrow(PlacementDependencyInputError);
  expect(forRow(decisions([source(projectDependent)]), projectDependent).eligible).toBe(false);
});

test("source-local rows, settlements and vault links remain local with passing policy", () => {
  const a = note(), short = note({ tier: "short" }), settle = authored("settle", { target: "synthetic-project#42@1000", by: UNTIL, actor: "person" });
  const body = { schema: "agent-mem.vault-link/v1", op: "vault_link", generation: G, at: AT, machine: "3".repeat(16), actor: "person", placement: "local", target: a.id, rowHash: hashJSON(a), project: "synthetic-project", path: "fixture.md" };
  const vault = { ...body, id: vaultLinkId(body) };
  const result = decisions([source(a, { sourcePlacement: "local" }), source(short), source(settle), source(vault, { sourcePlacement: "local" })]);
  expect(result.every(row => !row.eligible && row.reason === "source-local")).toBe(true);
});

function prune(targets: Record<string, unknown>[]) {
  const body: Omit<PruneRow, "id"> = { schema: "agent-mem.prune/v1", op: "prune", generation: G, at: AT, machine: "3".repeat(16), actor: "person", placement: "synced", cutoff: AT,
    targets: targets.map(row => ({ id: row.id as string, rowHash: hashJSON(row), expiredAt: AT, basis: { kind: "note" as const, id: row.id as string, rowHash: hashJSON(row) } })).sort((a,b) => a.id.localeCompare(b.id)) };
  return { ...body, id: pruneId(body) };
}
test("prune requires exact whole-original proof and all target/basis endpoints in its own physical realm", () => {
  const a = note(), b = note(), manifest = prune([a, b]);
  const rows = [source(a), source(b), source(manifest)];
  expect(forRow(decisions(rows), manifest)).toMatchObject({ eligible: false, reason: "unverified-prune" });
  expect(forRow(decisions(rows, { verifiedPrunes: [key(manifest)] }), manifest).eligible).toBe(true);
  expect(forRow(decisions([source(a), source(b, { held: true }), source(manifest)], { verifiedPrunes: [key(manifest)] }), manifest).eligible).toBe(false);
  expect(forRow(decisions([source(a), source(manifest)], { verifiedPrunes: [key(manifest)], publicEndpoints: [endpoint(b, U)] }), manifest).eligible).toBe(false);
  const demotion = op("demote", a, UNTIL);
  const { id: _id, ...original } = prune([a]);
  const basisBody: Omit<PruneRow, "id"> = { ...original, targets: [{ ...original.targets[0]!, basis: { kind: "demote", id: demotion.id as string, rowHash: hashJSON(demotion) } }] };
  const withBasis = { ...basisBody, id: pruneId(basisBody) };
  expect(forRow(decisions([source(a), source(withBasis)], { verifiedPrunes: [key(withBasis)] }), withBasis).eligible).toBe(false);
  expect(forRow(decisions([source(a), source(demotion), source(withBasis)], { verifiedPrunes: [key(withBasis)] }), withBasis).eligible).toBe(true);
  const wrongHash = { ...key(manifest), rowHash: "a".repeat(64) };
  expect(forRow(decisions(rows, { verifiedPrunes: [wrongHash] }), manifest).eligible).toBe(false);
});

test("unsupported operations and reference forms are explicitly held without invented parsing", () => {
  const a = note(), b = note(), g = goal();
  const malformed = [authored("future", { text: "private-canary" }), goal([`goal:${g.id}`]),
    op("suggest", a, `unknown:${b.id}`), op("suggest", a, `same_topic:${b.id}\n`), op("suggest", a, `same_topic:${a.id}`),
    op("confirm", a), op("lease", g), op("demote", a), op("supersede", a, a.id as string)];
  const result = decisions([source(a), source(b), source(g), ...malformed.map(row => source(row))]);
  for (const row of malformed) expect(forRow(result, row).eligible).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private-canary");
});

test("exact ID/hash conflicts, mismatched body hashes and unknown selected realms fail closed", () => {
  const a = note(), b = { ...note(), id: a.id };
  expect(() => decisions([source(a), source(b, { key: key(b, U) })])).toThrow(PlacementDependencyInputError);
  expect(() => decisions([source(a, { key: { ...key(a), rowHash: "a".repeat(64) } })])).toThrow(PlacementDependencyInputError);
  expect(() => decisions([source(a)], { selectedRealms: [] })).toThrow(PlacementDependencyInputError);
});

test("getters, proxies and serialization hooks are never executed", () => {
  let calls = 0;
  const a = note(), raw = input([source(a)]);
  const getter = Object.defineProperty({ ...raw }, "rows", { enumerable: true, get() { calls++; return raw.rows; } });
  expect(() => compilePlacementDependencies(getter)).toThrow(PlacementDependencyInputError);
  const proxy = new Proxy(raw, { ownKeys() { calls++; return []; }, getPrototypeOf() { calls++; return Object.prototype; } });
  expect(() => compilePlacementDependencies(proxy)).toThrow(PlacementDependencyInputError);
  const hooked = { ...a, toJSON() { calls++; return a; } };
  expect(() => decisions([{ ...source(a), row: hooked }])).toThrow(PlacementDependencyInputError);
  expect(calls).toBe(0);
});

test("physical row/realm/byte bounds refuse before traversing later source getters", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "row", { enumerable: true, get() { calls++; return note(); } });
  expect(() => compilePlacementDependencies(input(Array(20001).fill(getter)))).toThrow(PlacementDependencyInputError);
  expect(() => compilePlacementDependencies(input([getter as DependencySource], { selectedRealms: Array(257).fill(P) }))).toThrow(PlacementDependencyInputError);
  const huge = note({ text: "x".repeat(8 * 1024 * 1024) });
  expect(() => decisions([source(huge)])).toThrow(PlacementDependencyInputError);
  expect(calls).toBe(0);
});
