import { expect, test } from "bun:test";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { DENY_NAMES, DENY_SEGMENTS } from "../src/memory/platform.ts";

test("repeated prose tokens retain full path screening and fresh host decisions", async () => {
  let calls = 0;
  const policy = createStandalonePolicy({ denyPaths: ["hidden.ts"], host: { screen: async () => ++calls === 1 } });
  const prose = "ordinary fixture context ".repeat(70);
  const publicRow = { excerpt: `${prose}public.ts public.ts` };
  expect(await policy.screen(publicRow)).toBe(true);
  expect(await policy.screen(publicRow)).toBe(false);
  expect(calls).toBe(2);
  expect(await policy.screen({ excerpt: `${prose}hidden.ts hidden.ts` })).toBe(false);
  expect(calls).toBe(2); // Standalone refusal still precedes the host, even after many repeated tokens.
});

test("standalone policy allows public JSON scalars, capture and work metadata with explicit false privacy flags", async () => {
  const policy = createStandalonePolicy();
  for (const value of [null, true, false, 0, "public lesson", { private: false, pii: false, privateTurn: false, title: "Public contract", about: ["path:src/main.ts"] },
    { project: "repo-key", agent: "codex", event: "tool", tool: "read", paths: ["src/main.ts"], status: "ok", excerpt: "public detail" },
    { list: "release", fields: { task: "check", status: "doing", attempts: 2, detail: null } }]) expect(await policy.screen(value)).toBe(true);
});

test("standalone policy screens complete nested metadata and key-value pairs for secrets and private flags", async () => {
  const policy = createStandalonePolicy();
  for (const value of [{ nested: { api_key: "sensitivevalue123" } }, { title: "safe", about: ["ghp_" + "a".repeat(35)] },
    { source: { note: "-----BEGIN RSA PRIVATE KEY-----" } }, { private: true }, { metadata: { pii: true } }, { privateTurn: true },
    { private_turn: true }, { private: "unknown" }]) expect(await policy.screen(value)).toBe(false);
});

test("standalone policy default PII applies to titles, paths, keys and deeply nested metadata", async () => {
  const policy = createStandalonePolicy();
  for (const value of [{ title: "contact person@example.invalid" }, { paths: ["notes/person@example.invalid.md"] },
    { metadata: { identity: "900101-1234567" } }, { "123-45-6789": "record" }, { nested: [{ message: "Person <person@example.invalid>" }] }]) expect(await policy.screen(value)).toBe(false);
});

test("standalone policy reuses default deny paths across slash, backslash, case and dot segments", async () => {
  const policy = createStandalonePolicy();
  for (const value of [{ paths: [".env"] }, { about: ["path:.agenthub/state/hub.db"] }, { excerpt: "read .agenthub/archive/old.json" },
    { path: "C:\\project\\.AGENTHUB\\STATE\\hub.db" }, { path: "repo/public/../.env" }, { paths: [".ＧＩＴ/../.env"] },
    { detail: "The file CREDENTIALS.JSON contains a record" }]) expect(await policy.screen(value)).toBe(false);
});

test("standalone custom deny and PII patterns are bounded literals, copied at creation", async () => {
  const denyPaths = ["private folder/records"], piiPatterns = ["sensitive.*literal"];
  const policy = createStandalonePolicy({ denyPaths, piiPatterns });
  denyPaths[0] = "different"; piiPatterns[0] = "different";
  expect(await policy.screen({ about: ["path:PRIVATE FOLDER\\RECORDS\\row.md"] })).toBe(false);
  expect(await policy.screen({ title: "SENSITIVE.*LITERAL" })).toBe(false);
  expect(await policy.screen({ title: "sensitive anything literal" })).toBe(true);
  for (const options of [{ piiPatterns: [" "] }, { denyPaths: [""] }, { piiPatterns: Array.from({ length: 65 }, () => "x") },
    { piiPatterns: ["x".repeat(257)] }, { piiPatterns: [/unsafe/] }, { unknown: true }]) {
    expect(() => createStandalonePolicy(options as never)).toThrow();
  }
});

test("standalone host policy can only narrow default allow and receives a detached complete snapshot", async () => {
  const input = { title: "public", nested: { value: "detail" } }, seen: unknown[] = [];
  const policy = createStandalonePolicy({ host: { screen: async value => { seen.push(value); (value as typeof input).nested.value = "host changed"; return true; } } });
  expect(await policy.screen(input)).toBe(true); expect(input.nested.value).toBe("detail");
  expect(seen).toHaveLength(1); expect(seen[0]).not.toBe(input);
  expect(await policy.screen({ private: true })).toBe(false); expect(seen).toHaveLength(1);
  for (const screen of [async () => false, async () => { throw new Error("host refusal"); }, async () => "true", async () => undefined]) {
    expect(await createStandalonePolicy({ host: { screen } } as never).screen(input)).toBe(false);
  }
});

test("standalone policy refuses malformed objects without invoking accessors or serialization hooks", async () => {
  const policy = createStandalonePolicy(), cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  let invoked = 0;
  const accessor = Object.defineProperty({}, "text", { enumerable: true, get() { invoked++; return "public"; } });
  const serializer = { toJSON() { invoked++; return { title: "public" }; } };
  for (const value of [undefined, NaN, Infinity, 1n, () => "public", Symbol("value"), new Date(), new Map(), cyclic, accessor, serializer,
    { text: undefined }, Object.assign({ title: "public" }, { [Symbol("hidden")]: "private" }), new Proxy({}, { ownKeys() { throw new Error("unknown shape"); } })]) expect(await policy.screen(value)).toBe(false);
  expect(invoked).toBe(0);
});

test("standalone policy refuses oversized or deeply nested complete values rather than truncating them", async () => {
  const policy = createStandalonePolicy();
  let deep: unknown = "public"; for (let i = 0; i < 18; i++) deep = { nested: deep };
  expect(await policy.screen(deep)).toBe(false);
  expect(await policy.screen({ text: "가".repeat(6000) })).toBe(false);
  expect(await policy.screen(Array.from({ length: 5000 }, () => null))).toBe(false);
  expect(await policy.screen({ chunks: Array.from({ length: 20 }, () => "x".repeat(16_000)) })).toBe(false);
});

test("repeated text checks preserve fresh structure, bounds, split secrets and host decisions", async () => {
  let allow = true, calls = 0;
  const policy = createStandalonePolicy({ host: { async screen() { calls++; return allow; } } });
  const input: Record<string, unknown> = { text: "public detail", private: false };
  expect(await policy.screen(input)).toBe(true);
  expect(await policy.screen(input)).toBe(true);
  allow = false;
  expect(await policy.screen(input)).toBe(false); expect(calls).toBe(3);
  allow = true;
  input.private = true;
  expect(await policy.screen(input)).toBe(false); expect(calls).toBe(3);
  input.private = false; input.text = "person@example.invalid";
  expect(await policy.screen(input)).toBe(false);
  let invoked = 0;
  expect(await policy.screen(Object.defineProperty({}, "text", { enumerable: true, get() { invoked++; return "public detail"; } }))).toBe(false);
  expect(invoked).toBe(0);
  expect(await policy.screen({ chunks: Array.from({ length: 4096 }, () => "public detail") })).toBe(false);
  expect(await policy.screen({ api_key: "sensitivevalue123" })).toBe(false);
  expect(await policy.screen(input)).toBe(false);
});

test("text-check cache eviction and policy instances preserve exact standalone verdicts", async () => {
  const plain = createStandalonePolicy(), restricted = createStandalonePolicy({ piiPatterns: ["public detail"], denyPaths: ["src/private"] });
  const samples = ["public detail", "src/private/row.ts", "person@example.invalid", "repo/public/../.env", "safe note"];
  for (const policy of [plain, restricted]) {
    const expected = samples.map(text => policy.screenStandalone({ text }));
    // Cross entry-count and text-byte ceilings separately.
    for (const detail of ["", "detail ".repeat(100)]) for (let i = 0; i < 700; i++) expect(policy.screenStandalone({ text: `public observation ${i} ${detail}` })).toBe(true);
    expect(samples.map(text => policy.screenStandalone({ text }))).toEqual(expected);
  }
  expect(plain.screenStandalone({ text: "public detail" })).toBe(true);
  expect(restricted.screenStandalone({ text: "public detail" })).toBe(false);
  expect(restricted.screenStandalone({ text: "src/private/row.ts" })).toBe(false);
});

test("cached text observes host changes to the exported default deny lists", async () => {
  const policy = createStandalonePolicy(), input = { paths: ["src/private/row.md"] };
  expect(policy.screenStandalone(input)).toBe(true);
  DENY_NAMES.push("^row[.]md$");
  try { expect(policy.screenStandalone(input)).toBe(false); }
  finally { DENY_NAMES.pop(); }
  expect(policy.screenStandalone(input)).toBe(true);
  DENY_SEGMENTS.push("src/private");
  try { expect(policy.screenStandalone(input)).toBe(false); }
  finally { DENY_SEGMENTS.pop(); }
  expect(policy.screenStandalone(input)).toBe(true);
});
