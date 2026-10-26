import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createStandalonePolicy, type StandalonePolicyOptions } from "../src/memory/policy.ts";
import { DENY_NAMES, DENY_SEGMENTS } from "../src/memory/platform.ts";
import { createStandalonePolicy as before } from "./fakes/policy-before-g1f.ts";
import { policyPathCases } from "./fakes/policy-path-cases.ts";

const originalNames = [...DENY_NAMES], originalSegments = [...DENY_SEGMENTS];
const restore = () => {
  DENY_NAMES.splice(0, DENY_NAMES.length, ...originalNames);
  DENY_SEGMENTS.splice(0, DENY_SEGMENTS.length, ...originalSegments);
};

/** Compare every verdict and the order of every host invocation, including host refusals. */
async function compare(values: readonly unknown[], options: StandalonePolicyOptions = {}, mutate?: (index: number) => void): Promise<void> {
  const oldCalls: number[] = [], newCalls: number[] = []; let current = -1;
  const old = before({ ...options, host: { screen: async () => { oldCalls.push(current); return current % 17 !== 0; } } });
  const next = createStandalonePolicy({ ...options, host: { screen: async () => { newCalls.push(current); return current % 17 !== 0; } } });
  for (let index = 0; index < values.length; index++) {
    current = index; mutate?.(index);
    const expected = await old.screen(values[index]), actual = await next.screen(values[index]);
    if (actual !== expected) throw new Error(`policy verdict mismatch at sample ${index}`);
  }
  expect(newCalls).toEqual(oldCalls);
}

const archivedTexts = ["public prose", "file.secretlongword", "secretlong", "id_rsa", "foo/id_rsa", "src/public.ts", "public/../hidden.ts", ".agenthub/x/../state/data", ".agenthub//state/data", "path:src/hidden.ts", "symbol:f@src/public.ts", "HIDDEN.TS", "ｅｎｖ.txt", "학생 공개 문장", "credentials", "credentials.txt", "../credentials", "a/b/..", "../x", "person@example.invalid", "x".repeat(321) + "@", "person＠example.invalid", "api_'key: abcdefghijklmnopqrstuvwxyz", 'api_"key: abcdefghijklmnopqrstuvwxyz'];
// Preserve the archived Step 1 corpus exactly, including its escaped regex-source spellings.
const archivedPatterns = [undefined, "secretlong\\b", "secretlong\\B", "secretlong$", "^file\\.secretlong$", "^(public|secret)", "(?!secret)public", "[a-z]+", "\\^secret", "\\$secret", "^hostsecret", "^ab?", "*"];

test("frozen pre-G1f reference differs only in provenance and helper import locations", () => {
  const frozen = readFileSync(new URL("./fakes/policy-before-g1f.ts", import.meta.url), "utf8");
  const [provenance, digest, ...lines] = frozen.split("\n");
  expect(provenance).toContain("eb2ce39:src/memory/policy.ts");
  const source = lines.join("\n").replaceAll('from "../../src/memory/', 'from "./');
  expect(digest).toBe(`// Original source SHA-256: ${createHash("sha256").update(source).digest("hex")}`);
});

test("all 1207 archived Step 1 comparisons preserve verdicts and host-call order", async () => {
  const inputs = [...policyPathCases().map(sample => sample.value), ...archivedTexts, ...archivedTexts.map(excerpt => ({ excerpt, paths: ["public.ts"] })), null, {}, { private: true }];
  let comparisons = 0;
  try {
    for (const pattern of archivedPatterns) {
      restore(); if (pattern !== undefined) DENY_NAMES.push(pattern);
      await compare(inputs, { denyPaths: ["hidden.ts", "private/records"] }); comparisons += inputs.length;
    }
    for (const segment of ["secret", "private/records", "private//records", ""]) {
      restore(); DENY_SEGMENTS.push(segment);
      await compare(inputs); comparisons += inputs.length;
    }
    expect(comparisons).toBe(1207);
  } finally { restore(); }
});

test("30000 seeded samples preserve each verdict and host-call order across deny revisions", async () => {
  let seed = 0x3287cafe;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const atoms = ["public", "ordinary", "private", "hidden.ts", ".env", "credentials", "id_rsa", "secretlongword", "a.pem", "a.key", "학생", "ｅｎｖ", "é", "ＡＢＣ", "src", "records", "foo.bar1234567890", "path:", "symbol:f@", "@", "x".repeat(321), "restricted-marker"];
  const separators = [" ", "/", "//", "/./", "/../", "\\", ".", "_", "-", ":", "=", "\n", "'", '"', "(", ")", "[", "]", "<", ">", ",", ";", "`"];
  const values: unknown[] = [];
  for (let index = 0; index < 30000; index++) {
    let text = atoms[random() % atoms.length]!;
    for (let part = 0, count = random() % 7; part < count; part++) text += separators[random() % separators.length]! + atoms[random() % atoms.length]!;
    switch (random() % 6) {
      case 0: values.push(text); break;
      case 1: values.push({ excerpt: text, paths: ["src/public.ts"], agent: "fixture", id: index }); break;
      case 2: values.push({ excerpt: "public", metadata: { title: text }, paths: [text] }); break;
      case 3: values.push([text, { about: ["path:src/public.ts", text] }]); break;
      case 4: values.push({ [text]: "public", private: false }); break;
      default: values.push({ excerpt: text, [index % 2 ? "private_turn" : "is-pii"]: index % 7 === 0 });
    }
  }
  try {
    await compare(values, { denyPaths: ["hidden.ts", "private/records", "a/b", "repeated-token"], piiPatterns: ["restricted-marker"] }, index => {
      if (index % 500 === 0) {
        restore();
        const group = Math.floor(index / 500) % 6;
        if (group === 1) DENY_NAMES.push("secretlong\\b");
        if (group === 2) DENY_NAMES.push("^foo(\\.|$)");
        if (group === 3) DENY_NAMES.push("[a-z]+", "(?!hidden)private");
        if (group === 4) DENY_SEGMENTS.push("private", "records");
        if (group === 5) DENY_NAMES.push("*");
      }
    });
  } finally { restore(); }
});

test("unsupported word boundaries retain the truncated-extension denial", async () => {
  try {
    DENY_NAMES.push("secretlong\\b");
    expect(before().screenStandalone("file.secretlongword")).toBe(false);
    expect(createStandalonePolicy().screenStandalone("file.secretlongword")).toBe(false);
    await compare(["file.secretlongword", "file.secretlongword/public", "symbol:f@file.secretlongword", "file.secretlong", "file.secretlonger"]);
  } finally { restore(); }
});

test("fresh descriptors, bounds, private flags and detached host snapshots remain identical", async () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "excerpt", { enumerable: true, get() { getterCalls++; return "public"; } });
  const hidden = Object.defineProperty({}, "excerpt", { enumerable: false, value: "public" });
  const symbol = { excerpt: "public", [Symbol("metadata")]: "public" };
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  let deep: unknown = "public"; for (let index = 0; index < 18; index++) deep = [deep];
  const sparse = new Array(2); sparse[1] = "public";
  const values = [accessor, hidden, symbol, cyclic, deep, sparse, new Proxy({ excerpt: "public" }, {}), new Date(0), NaN, Infinity, undefined, () => true,
    Object.assign(Object.create(null), { excerpt: "public" }), { private: false }, { private: true }, { PRIVATE: true }, { "ｐｒｉｖａｔｅ": true }, { "is-private": true }, { pii: null }, ...policyPathCases().map(sample => sample.value)];
  await compare(values);
  expect(getterCalls).toBe(0);
  for (const factory of [before, createStandalonePolicy]) {
    const input = { excerpt: "public", nested: { note: "ordinary" } };
    const policy = factory({ host: { screen: async value => { (value as typeof input).nested.note = "changed"; return true; } } });
    expect(await policy.screen(input)).toBe(true);
    expect(input.nested.note).toBe("ordinary");
  }
});

test("late default tightening, removal, new policy and host refusal match the reference", async () => {
  const sequence = async (factory: typeof before) => {
    restore(); const calls: unknown[] = []; let tighten = true;
    const policy = factory({ host: { screen: async value => { calls.push(value); if (tighten) { tighten = false; DENY_NAMES.push("^lateblocked$"); } return value !== "host-refusal"; } } });
    const verdicts = [await policy.screen("lateblocked"), await policy.screen("lateblocked"), await policy.screen("ordinary"), await policy.screen("host-refusal")];
    restore(); verdicts.push(await policy.screen("lateblocked"));
    verdicts.push(await factory({ denyPaths: ["lateblocked"] }).screen("lateblocked"));
    verdicts.push(await factory({ piiPatterns: ["ordinary"] }).screen("ordinary"));
    return { verdicts, calls };
  };
  try { const expected = await sequence(before); expect(await sequence(createStandalonePolicy)).toEqual(expected); }
  finally { restore(); }
});

test("unsupported default-list shapes preserve verdicts and getter invocation counts", async () => {
  const run = async (factory: typeof before, variant: number) => {
    restore(); let getterCalls = 0; const calls: unknown[] = [];
    if (variant === 0) Object.defineProperty(DENY_NAMES, String(DENY_NAMES.length), { configurable: true, enumerable: true, get() { getterCalls++; return "^hostonly$"; } });
    if (variant === 1) DENY_NAMES.length++;
    if (variant === 2) DENY_NAMES.push(42 as unknown as string);
    if (variant === 3) DENY_SEGMENTS.push(null as unknown as string);
    if (variant === 4) Object.defineProperty(DENY_SEGMENTS, String(DENY_SEGMENTS.length), { configurable: true, enumerable: true, get() { getterCalls++; return "hostonly"; } });
    const policy = factory({ host: { screen: async value => { calls.push(value); return true; } } });
    const verdicts = [];
    for (const value of ["ordinary public prose", "hostonly", { excerpt: "ordinary", paths: ["src/public.ts"] }, 42, null]) verdicts.push(await policy.screen(value));
    return { verdicts, calls, getterCalls };
  };
  try {
    for (let variant = 0; variant < 5; variant++) {
      const expected = await run(before, variant);
      expect(await run(createStandalonePolicy, variant)).toEqual(expected);
    }
  } finally { restore(); }
});

test("probe count and source-size ceilings retain the canonical deny verdict", async () => {
  try {
    DENY_NAMES.push(...Array.from({ length: 65 }, (_, index) => `^ceiling_${index}$`));
    await compare(["public prose", "ceiling_64", { excerpt: "public ceiling_64" }]);
    restore();
    DENY_SEGMENTS.push(...Array.from({ length: 65 }, (_, index) => `segment_${index}`));
    await compare(["public prose", "segment_64", "src/segment_64/file.ts"]);
    restore();
    for (const length of [255, 256, 257]) {
      DENY_NAMES.push("^" + "x".repeat(length) + "$");
      await compare(["public prose", "x".repeat(length), { excerpt: "x".repeat(length) }]);
      restore();
    }
  } finally { restore(); }
});

test("warmed probes fall back when a same-revision default becomes an accessor", async () => {
  const run = async (factory: typeof before, segments: boolean) => {
    restore();
    const values = segments ? DENY_SEGMENTS : DENY_NAMES;
    const descriptor = Object.getOwnPropertyDescriptor(values, "0")!;
    const calls: unknown[] = [];
    const policy = factory({ host: { screen: async value => { calls.push(value); return true; } } });
    expect(await policy.screen("warm public prose")).toBe(true);
    let reads = 0;
    Object.defineProperty(values, "0", { configurable: true, enumerable: true, get() { return ++reads === 1 ? descriptor.value : segments ? "ordinary" : "^ordinary$"; } });
    try {
      const verdict = await policy.screen("ordinary");
      return { verdict, reads, calls };
    } finally { Object.defineProperty(values, "0", descriptor); }
  };
  try {
    for (const segments of [false, true]) {
      const expected = await run(before, segments);
      expect(expected.verdict).toBe(false);
      expect(await run(createStandalonePolicy, segments)).toEqual(expected);
    }
  } finally { restore(); }
});
