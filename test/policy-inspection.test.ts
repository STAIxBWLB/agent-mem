import { expect, test } from "bun:test";
import { createStandalonePolicy, type StandalonePolicy, type StandalonePolicyDecline } from "../src/memory/policy.ts";
import { DENY_NAMES, DENY_SEGMENTS } from "../src/memory/platform.ts";

const declined = (category: StandalonePolicyDecline) => ({ ok: false as const, category });

test("standalone inspection classifies canonical refusals and returns no input or configured literals", () => {
  const policy = createStandalonePolicy({ piiPatterns: ["restricted-customer-marker"], denyPaths: ["org-private-files"] });
  const samples: [unknown, StandalonePolicyDecline][] = [
    [{ api_key: "sensitivevalue123" }, "secret"],
    ["api_'key: abcdefghijklmnopqrstuvwxyz", "secret"],
    ["person@example.invalid", "personal-data"],
    ["123456-1234567", "personal-data"],
    ["RESTRICTED-CUSTOMER-MARKER", "personal-data"],
    ["src/../.env", "deny-path"],
    ["org-private-files/review.md", "deny-path"],
    [{ private_turn: true, excerpt: "public" }, "private-or-invalid"],
  ];
  for (const [input, category] of samples) {
    expect(policy.inspectStandalone(input)).toEqual(declined(category));
    expect(policy.screenStandalone(input)).toBe(false);
    expect(Object.keys(policy.inspectStandalone(input)).sort()).toEqual(["category", "ok"]);
  }
  const publicValue = { excerpt: "public project detail", paths: ["src/public.ts"] };
  expect(policy.inspectStandalone(publicValue)).toEqual({ ok: true });
  expect(Object.keys(policy.inspectStandalone(publicValue))).toEqual(["ok"]);
  expect(policy.screenStandalone(publicValue)).toBe(true);
  // The broader legacy predicate retains its existing path/PII meaning.
  expect(policy.declinesPersonal("org-private-files/review.md")).toBe(true);
  expect(policy.declinesPersonal("RESTRICTED-CUSTOMER-MARKER")).toBe(true);
});

test("inspection uses the original structural and first-text screening order", () => {
  const policy = createStandalonePolicy({ piiPatterns: ["restricted-marker"], denyPaths: ["blocked-dir"] });
  expect(policy.inspectStandalone({ private: true, api_key: "sensitivevalue123" })).toEqual(declined("private-or-invalid"));
  expect(policy.inspectStandalone(["blocked-dir/note.md", "person@example.invalid"])).toEqual(declined("deny-path"));
  expect(policy.inspectStandalone(["person@example.invalid", "blocked-dir/note.md"])).toEqual(declined("personal-data"));
  expect(policy.inspectStandalone("api_key: sensitivevalue123 restricted-marker")).toEqual(declined("secret"));
});

test("inspection never invokes getters, proxy traps or serialization hooks and rejects complete-value bounds", () => {
  const policy = createStandalonePolicy(); let invoked = 0;
  const accessor = Object.defineProperty({}, "text", { enumerable: true, get() { invoked++; return "public"; } });
  const proxy = new Proxy({}, { ownKeys() { invoked++; throw Error("trap"); }, getPrototypeOf() { invoked++; return null; } });
  const serializer = { toJSON() { invoked++; return "public"; } };
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  let deep: unknown = "public"; for (let index = 0; index < 18; index++) deep = { nested: deep };
  for (const input of [accessor, proxy, serializer, cyclic, undefined, NaN, Infinity, 1n, Symbol("value"), new Date(), new Map(),
    { [Symbol("hidden")]: "public" }, { text: "x".repeat(17_000) }, Array.from({ length: 5000 }, () => null), deep,
    Array.from({ length: 20 }, () => "x".repeat(16_000))]) expect(policy.inspectStandalone(input)).toEqual(declined("private-or-invalid"));
  expect(invoked).toBe(0);
});

test("inspection and boolean screens share cache verdicts while default-deny revisions remain live", () => {
  const policy = createStandalonePolicy(), input = { path: "src/inspection-literal/record.md" };
  expect(policy.inspectStandalone(input)).toEqual({ ok: true }); expect(policy.screenStandalone(input)).toBe(true);
  DENY_SEGMENTS.push("inspection-literal");
  try {
    expect(policy.screenStandalone(input)).toBe(false);
    expect(policy.inspectStandalone(input)).toEqual(declined("deny-path"));
  } finally { DENY_SEGMENTS.pop(); }
  expect(policy.inspectStandalone(input)).toEqual({ ok: true });
  DENY_NAMES.push("^record[.]md$");
  try { expect(policy.inspectStandalone(input)).toEqual(declined("deny-path")); }
  finally { DENY_NAMES.pop(); }
  expect(policy.screenStandalone(input)).toBe(true);
  const descriptor = Object.getOwnPropertyDescriptor(DENY_NAMES, "0")!;
  Object.defineProperty(DENY_NAMES, "0", { configurable: true, enumerable: true, get() { throw Error("default unavailable"); } });
  try { expect(policy.inspectStandalone(input)).toEqual(declined("private-or-invalid")); expect(policy.screenStandalone(input)).toBe(false); }
  finally { Object.defineProperty(DENY_NAMES, "0", descriptor); }
  expect(policy.inspectStandalone(input)).toEqual({ ok: true });
});

test("inspection stays standalone; host decisions remain fresh and receive detached complete snapshots", async () => {
  let calls = 0, allow = false;
  const input = { text: "public detail", nested: { item: "stable" } };
  const policy = createStandalonePolicy({ host: { async screen(value) { calls++; (value as typeof input).nested.item = "host changed"; return allow; } } });
  expect(policy.inspectStandalone(input)).toEqual({ ok: true }); expect(calls).toBe(0);
  expect(policy.screenStandalone(input)).toBe(true); expect(calls).toBe(0);
  expect(await policy.screen(input)).toBe(false); allow = true;
  expect(await policy.screen(input)).toBe(true); expect(calls).toBe(2); expect(input.nested.item).toBe("stable");
  expect(policy.inspectStandalone({ api_key: "sensitivevalue123" })).toEqual(declined("secret"));
  expect(await policy.screen({ api_key: "sensitivevalue123" })).toBe(false); expect(calls).toBe(2);
  expect(policy.inspectStandalone({ ...input, private: true })).toEqual(declined("private-or-invalid"));
});


test("inspection is additive to the existing standalone policy implementation contract", () => {
  const legacy: StandalonePolicy = { screenStandalone: () => true, declinesPersonal: () => false, screen: async () => true };
  expect(legacy.screenStandalone("public")).toBe(true);
  const factoryPolicy: StandalonePolicy = createStandalonePolicy();
  expect(factoryPolicy.screenStandalone("public")).toBe(true);
  expect(createStandalonePolicy().inspectStandalone("public")).toEqual({ ok: true });
});
