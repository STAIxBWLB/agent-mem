import { expect, test } from "bun:test";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { PLACEMENT_FORMAT, PLACEMENT_PROFILE_SCHEMA } from "../src/memory/sync-placement-format.ts";
import {
  planSyncPlacementActivation, validatePlacementPlan, decodePlacementPlan, validateSyncPlacementActivation,
  SyncPlacementPlanError, type SyncPlacementActivationContext,
} from "../src/memory/sync-placement-plan.ts";

const hex = (value: string, length = 64) => value.repeat(length);
function context(): SyncPlacementActivationContext {
  const profile = { schema: "agent-mem.profile/v2", kind: "generation", generation: hex("a", 32), foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: hex("b") };
  const shards = { schema: "agent-mem.shards/v2", generation: profile.generation, phase: "active", selectorRevision: hashJSON(profile), sources: [], machine: { id: hex("c", 16), label: "fixture" } };
  return { profile, shards, homeHash: hex("d"), sourceHash: hex("e"), aliasesHash: hex("f"), policyHash: hex("0"),
    realms: [{ scope: "project", keyHash: hex("1"), bindingHash: hex("2") }, { scope: "user", bindingHash: hex("3") }],
    writers: [{ writerId: hex("4"), version: "0.21.0", pin: hex("5"), publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true };
}
const head = hex("6");
function code(work: () => unknown) {
  try { work(); } catch (error) { expect(error).toBeInstanceOf(SyncPlacementPlanError); return (error as SyncPlacementPlanError).code; }
  throw Error("expected plan refusal");
}

test("activation preview is deterministic, detached, bounded and canonical; validation never activates", () => {
  const current = context(), before = canonicalJSON(current), plan = planSyncPlacementActivation(current, head);
  expect(canonicalJSON(current)).toBe(before);
  expect(plan).toEqual(planSyncPlacementActivation(current, head));
  expect(plan.targetProfile.schema).toBe(PLACEMENT_PROFILE_SCHEMA);
  expect(plan.previousProfileHash).toBe(hashJSON(current.profile)); expect(plan.previousShardsHash).toBe(hashJSON(current.shards));
  expect(validatePlacementPlan(plan)).toEqual(plan);
  expect(decodePlacementPlan(Buffer.from(canonicalJSON(plan) + "\n"))).toEqual(plan);
  let authorized = 0;
  const result = validateSyncPlacementActivation(plan, { current: () => current, authorize: binding => {
    authorized++; expect(Object.isFrozen(binding)).toBe(true); expect(binding.homeHash).toBe(current.homeHash); return true;
  } });
  expect(authorized).toBe(1); expect(result).toEqual({ validated: true, activated: false, plan });
  expect(canonicalJSON(current)).toBe(before);
  (current.writers[0] as { pin: string }).pin = hex("7"); expect(plan.writers[0]?.pin).toBe(hex("5"));
});

test("person authorization is explicit and neither a serialized seal nor an actor flag grants it", () => {
  const current = context(), plan = planSyncPlacementActivation(current, head);
  expect(code(() => validateSyncPlacementActivation(plan, { current: () => current, authorize: () => false }))).toBe("authorization");
  expect(code(() => validateSyncPlacementActivation(plan, { current: () => current, actor: "person" } as never))).toBe("authorization");
  expect(code(() => validateSyncPlacementActivation(plan, { current: () => current, authorize: () => { throw Error("private authorization text /private/path"); } }))).toBe("authorization");
});

for (const field of ["homeHash", "sourceHash", "aliasesHash", "policyHash"] as const) test("stale " + field + " never reaches person authorization", () => {
  const current = context(), plan = planSyncPlacementActivation(current, head); current[field] = hex("8"); let calls = 0;
  expect(code(() => validateSyncPlacementActivation(plan, { current: () => current, authorize: () => { calls++; return true; } }))).toBe("changed");
  expect(calls).toBe(0);
});

test("policy, source, writer or realm mutation inside authorization refuses without activation", () => {
  for (const mutate of [
    (value: SyncPlacementActivationContext) => { value.sourceHash = hex("8"); },
    (value: SyncPlacementActivationContext) => { value.policyHash = hex("8"); },
    (value: SyncPlacementActivationContext) => { (value.writers[0] as {pin: string}).pin = hex("8"); },
    (value: SyncPlacementActivationContext) => { (value.realms[0] as {bindingHash: string}).bindingHash = hex("8"); },
  ]) {
    const current = context(), plan = planSyncPlacementActivation(current, head);
    expect(code(() => validateSyncPlacementActivation(plan, { current: () => current, authorize: () => { mutate(current); return true; } }))).toBe("changed");
  }
});

for (const invalid of ["missing", "incompatible", "pin", "version", "version-lf", "format", "quiescence", "duplicate"] as const) test("writer attestation refuses: " + invalid, () => {
  const current = context();
  if (invalid === "missing") (current as {writers: unknown}).writers = [];
  if (invalid === "incompatible") (current.writers[0] as {compatible: boolean}).compatible = false;
  if (invalid === "pin") (current.writers[0] as {pin: string}).pin = "moving-install";
  if (invalid === "version") (current.writers[0] as {version: string}).version = "latest";
  if (invalid === "version-lf") (current.writers[0] as {version: string}).version = "0.21.0\n";
  if (invalid === "format") (current.writers[0] as {publicationFormat: string}).publicationFormat = "unknown-format";
  if (invalid === "quiescence") (current as {legacySyncQuiesced: boolean}).legacySyncQuiesced = false;
  if (invalid === "duplicate") (current as {writers: unknown}).writers = [current.writers[0], current.writers[0]];
  expect(code(() => planSyncPlacementActivation(current, head))).toBe("attestation");
});

test("activation requires the complete v2 base and cannot reinterpret v1 or a mismatched pair", () => {
  const first = context(); first.profile = { schema: "agent-mem.profile/v1", kind: "shared-v1" };
  expect(code(() => planSyncPlacementActivation(first, head))).toBe("base");
  const second = context(); second.shards = { ...(second.shards as object), selectorRevision: hex("9") };
  expect(code(() => planSyncPlacementActivation(second, head))).toBe("base");
});

test("resealing a changed context or a downgraded target cannot grant authority", () => {
  const current = context(), plan = planSyncPlacementActivation(current, head);
  const { seal: _seal, ...body } = plan, altered = { ...body, contextHash: hex("9") };
  const resealed = { ...altered, seal: hashJSON(altered) };
  expect(validatePlacementPlan(resealed)).toEqual(resealed);
  expect(code(() => validateSyncPlacementActivation(resealed, { current: () => current, authorize: () => true }))).toBe("changed");
  const downgrade = { ...body, targetProfile: { ...body.targetProfile, schema: "agent-mem.profile/v2" } };
  expect(code(() => validatePlacementPlan({ ...downgrade, seal: hashJSON(downgrade) }))).toBe("invalid");
});

test("malformed, unknown, accessor and proxy metadata does not execute code or disclose it", () => {
  const current = context(), plan = planSyncPlacementActivation(current, head); let accessed = 0;
  expect(code(() => validatePlacementPlan({ ...plan, unknown: "private-pattern" }))).toBe("invalid");
  expect(code(() => validatePlacementPlan({ ...plan, get seal() { accessed++; throw Error("private-pattern"); } }))).toBe("invalid");
  expect(code(() => validatePlacementPlan(new Proxy(plan, { get() { accessed++; throw Error("private-pattern"); } })))).toBe("invalid");
  expect(accessed).toBe(0);
  let error: unknown;
  try { validateSyncPlacementActivation(plan, { current: () => { throw Error("private-pattern /private/path"); }, authorize: () => true }); } catch (caught) { error = caught; }
  expect(String(error)).not.toContain("private-pattern"); expect(String(error)).not.toContain("/private/path");
});

test("plan framing and metadata bounds refuse rather than truncate", () => {
  const plan = planSyncPlacementActivation(context(), head);
  expect(code(() => decodePlacementPlan(Buffer.alloc(262_145)))).toBe("bound");
  expect(code(() => decodePlacementPlan(Buffer.from(canonicalJSON(plan))))).toBe("invalid");
  expect(code(() => decodePlacementPlan(Buffer.from(JSON.stringify(plan, null, 2) + "\n")))).toBe("invalid");
  const current = context(); (current as {realms: unknown}).realms = Array.from({length: 257}, () => current.realms[0]);
  expect(code(() => planSyncPlacementActivation(current, head))).toBe("bound");
});


test("byte decoder uses intrinsic typed-array bounds without invoking accessors", () => {
  const encoded = Buffer.from(canonicalJSON(planSyncPlacementActivation(context(), head)) + "\n"); let getters = 0;
  Object.defineProperty(encoded, "byteLength", { get() { getters++; throw Error("private-byte-getter"); } });
  expect(decodePlacementPlan(encoded).schema).toBe("agent-mem.sync-placement-activation-plan/v1");
  expect(getters).toBe(0);
});
