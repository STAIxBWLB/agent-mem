import { expect, test } from "bun:test";
import { buildIntentBrief, type IntentBriefOptions, type IntentBriefSource } from "../src/memory/intent-brief.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import type { View } from "../src/memory/store.ts";
const now = Date.parse("2026-10-25T00:00:00.000Z");
function note(n: number, extra: Partial<View> = {}): View {
  return { id: n.toString(16).padStart(32, "0"), at: "2026-10-24T00:00:00.000Z", machine: "a".repeat(16), project: "project", scope: "project", tier: "long", kind: "fail", peer: "person", title: null, text: "writer boundary", task: null, about: ["path:src/writer.ts"], source: "person", supersededBy: null, supersedes: [], promotedFrom: null, expiresAt: null, local: false, ...extra };
}
function options(extra: Partial<IntentBriefOptions> = {}): IntentBriefOptions { return { project: "project", cwd: "/unopened/repo", repo: "org/repo", intent: "repair writer", paths: ["src/writer.ts"], policy: () => createStandalonePolicy(), policyVersion: () => "", now: () => now, ...extra }; }
const source = (rows: readonly View[]): IntentBriefSource => ({ notes: () => rows });
test("fails first, then decisions/contracts; no findings, superseded, expired or foreign notes", async () => {
  const rows = [note(1, { kind: "contract" }), note(2, { kind: "decision" }), note(3), note(4, { kind: "finding" }), note(5, { supersededBy: "replacement" }), note(6, { expiresAt: new Date(now).toISOString() }), note(7, { project: "foreign", scope: "shared" }), note(8, { tier: "short", expiresAt: new Date(now + 1000).toISOString() })];
  const before = JSON.stringify(rows), result = await buildIntentBrief(source(rows), options());
  expect(result.items.map(row => row.id)).toEqual([rows[2]!.id, rows[7]!.id, rows[1]!.id, rows[0]!.id]); expect(result.state).toBe("known"); expect(result.bytes).toBe(Buffer.byteLength(result.text)); expect(JSON.stringify(rows)).toBe(before);
});
test("one public co-reference step reaches neighbour fails but never a second hop", async () => {
  const direct = note(1, { kind: "decision", about: ["path:src/writer.ts", "symbol:shared@src/common.ts"] }), neighbour = note(2, { about: ["symbol:shared@src/common.ts", "issue:org/repo#9"] }), tooFar = note(3, { about: ["issue:org/repo#9"] });
  const result = await buildIntentBrief(source([direct, neighbour, tooFar]), options()); expect(result.items.map(row => row.id)).toEqual([neighbour.id, direct.id]); expect(result.text).not.toContain(`mem:${tooFar.id}`);
});
test("private bridges are screened before relevance or graph expansion and cannot consume item caps", async () => {
  const privateBridge = note(1, { text: "hidden bridge", about: ["path:src/writer.ts", "issue:org/repo#8"] }), neighbour = note(2, { about: ["issue:org/repo#8"] }), publicDirect = note(3);
  const result = await buildIntentBrief(source([privateBridge, neighbour, publicDirect]), options({ policy: () => createStandalonePolicy({ piiPatterns: ["hidden bridge"] }) })); expect(result.items.map(row => row.id)).toEqual([publicDirect.id]);
});
test("PII allowed=false performs no source or policy query, and source errors fail open unknown", async () => {
  let reads = 0, screens = 0;
  const result = await buildIntentBrief({ notes: () => { reads++; return []; } }, options({ allowed: () => false, policy: () => { screens++; return createStandalonePolicy(); } }));
  expect(result).toMatchObject({ text: "", items: [], state: "known" }); expect(reads).toBe(0); expect(screens).toBe(0);
  expect(await buildIntentBrief({ notes: async () => { throw Error("private failure"); } }, options())).toMatchObject({ text: "", items: [], state: "unknown" });
});
test("intent fallback uses lexical matching only when no explicit plan nodes exist", async () => {
  const match = note(1, { about: [], text: "writer lease symptom" }), other = note(2, { about: [], text: "calendar rule" });
  expect((await buildIntentBrief(source([match, other]), options({ paths: [], symbols: [] }))).items.map(row => row.id)).toEqual([match.id]);
  expect((await buildIntentBrief(source([match]), options({ paths: ["elsewhere.ts"] }))).items).toEqual([]);
});
test("late policy tightening, PII and profile drift withhold previously screened rows", async () => {
  for (const drift of ["policy", "allowed", "guard"] as const) {
    let active = true, permitted = true, tightened = false;
    const rows = [note(1), note(2, { text: "last public choice" })];
    const policy = () => createStandalonePolicy({ piiPatterns: tightened ? ["writer"] : [], host: { screen: async value => { if ((value as Partial<View>).id === rows[1]!.id) { await Promise.resolve(); if (drift === "policy") tightened = true; if (drift === "allowed") permitted = false; if (drift === "guard") active = false; } return true; } } });
    const result = await buildIntentBrief(source(rows), options({ policy, policyVersion: () => String(tightened), allowed: () => permitted, assertCurrent: () => { if (!active) throw Error("changed"); } }));
    expect(result.items.some(row => row.id === rows[0]!.id)).toBe(false); expect(result.text).not.toContain("writer");
  }
});
test("source changes across policy await are not emitted from the old live snapshot", async () => {
  const target = note(1); let rows = [target], reads = 0;
  const result = await buildIntentBrief({ notes: async () => { reads++; return rows; }, assertCurrent: () => { if (rows.length !== 1 || rows[0] !== target) throw Error("source changed"); } }, options({ policy: () => createStandalonePolicy({ host: { screen: async value => { if ((value as Partial<View>).id === target.id) { await Promise.resolve(); rows = []; } return true; } } }) }));
  expect(reads).toBe(1); expect(result.items).toEqual([]);
});
test("optional path staleness marks the note, while unknown or thrown probes preserve it without a marker", async () => {
  for (const [stale, marked] of [[() => true, true], [() => undefined, false], [() => { throw Error("unavailable"); }, false]] as const) {
    const result = await buildIntentBrief(source([note(1)]), options({ stale })); expect(result.items).toHaveLength(1); expect(result.text.includes("(stale?)")).toBe(marked);
  }
});
test("oversized first fail is safely excerpted with its id before shorter decisions, within whole UTF8 budget", async () => {
  const fail = note(1, { text: "한글 경계 😀 ".repeat(800) }), decision = note(2, { kind: "decision", text: "short choice" });
  // Stay inside the complete-value policy string bound while exceeding the output budget.
  fail.text = fail.text.slice(0, 3000);
  const result = await buildIntentBrief(source([decision, fail]), options({ maxBytes: 1100 })); expect(result.items.map(row => row.id)).toEqual([fail.id, decision.id]); expect(result.bytes).toBeLessThanOrEqual(1100); expect(result.bytes).toBe(Buffer.byteLength(result.text)); expect(result.truncated).toBe(true); expect(result.text).toContain("truncated; fetch mem:"); expect(result.text).not.toContain("�");
  for (const line of result.text.split("\n").slice(1)) expect(() => JSON.parse(line)).not.toThrow();
  expect((await buildIntentBrief(source([fail]), options({ maxBytes: 32 }))).text).toBe("");
});
test("scan and selected counts are bounded after screening, without exposing private extras", async () => {
  const rows = Array.from({ length: 5001 }, (_, i) => note(i + 1, { text: "x" }));
  const result = await buildIntentBrief(source(rows), options({ maxBytes: 8192 })); expect(result.items.length).toBeLessThanOrEqual(64); expect(result.items.length).toBeGreaterThan(0); expect(result.truncated).toBe(true); expect(result.bytes).toBeLessThanOrEqual(8192);
});

test("private intent metadata refuses before source lookup, and late stale-probe errors do not author anything", async () => {
  let queries = 0;
  const result = await buildIntentBrief({ notes: () => { queries++; return [note(1)]; } }, options({ paths: ["private/key.ts"], policy: () => createStandalonePolicy({ denyPaths: ["private/"] }) }));
  expect(queries).toBe(0); expect(result.items).toEqual([]);
});

test("source property ordering does not silently discard an unchanged current note", async () => {
  const row = note(42); let reads = 0;
  const result = await buildIntentBrief({ notes: () => ++reads === 1 ? [row] : [Object.fromEntries(Object.entries(row).reverse()) as unknown as View] }, options());
  expect(result.items.map(view => view.id)).toEqual([row.id]); expect(result.state).toBe("known");
});
test("policy descriptor checks precede cloning or accessing source row getters", async () => {
  let getters = 0; const row = note(43); Object.defineProperty(row, "text", { enumerable: true, get: () => { getters++; return "must not execute"; } });
  const result = await buildIntentBrief(source([row]), options()); expect(getters).toBe(0); expect(result.items).toEqual([]);
});

test("AC6 public library brief accepts a hub task/adapter without importing the hub", async () => {
  const core = await import("../src/index.ts"), task = { id: 436, created: 1, title: "repair writer", refs: { paths: ["src/writer.ts"] }, plan: { paths: [], symbols: ["Writer.run(args)@src/writer.ts"] } };
  const failure = note(51), decision = note(52, { kind: "decision" });
  const adapter = { notes: () => [decision, failure] };
  const result = await core.buildIntentBrief(adapter, options({ intent: task.title, paths: [...task.refs.paths, ...task.plan.paths], symbols: task.plan.symbols, maxBytes: 512 }));
  expect(result.items.map(view => view.id)).toEqual([failure.id, decision.id]); expect(core.matchingPlanFails(task, result.items, { cwd: "/unopened/repo", project: "project", repo: "org/repo" }).map(view => view.id)).toEqual([failure.id]);
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(512); expect(core.planGuardNodes(task, { cwd: "/unopened/repo", project: "project", repo: "org/repo" })).toContain("symbol:Writer.run@src/writer.ts");
});

test("one policy snapshot and one screen per eligible row with a single source read", async () => {
  let built = 0, reads = 0, screens = 0;
  const rows = [note(71), note(72, { kind: "decision" }), note(73, { kind: "contract" })];
  const result = await buildIntentBrief({ notes: () => { reads++; return rows; } }, options({ policy: () => { built++; return createStandalonePolicy({ host: { screen: async value => { if ((value as Partial<View>).id) screens++; return true; } } }); } }));
  expect(result.items).toHaveLength(3); expect(built).toBe(1); expect(reads).toBe(1); expect(screens).toBe(3);
});
test("invalid named scope never broadens into intent fallback and stopwords query nothing", async () => {
  let reads = 0; const input = { notes: () => { reads++; return [note(74)]; } };
  for (const paths of [["../outside.ts"], ["/outside/repo.ts"]]) expect((await buildIntentBrief(input, options({ paths }))).items).toEqual([]);
  expect((await buildIntentBrief(input, options({ paths: [], intent: "to the and for" }))).items).toEqual([]); expect(reads).toBe(0);
});
test("default custom brief sources keep finite future valid-at notes for clock skew", async () => {
  const future = note(75, { at: new Date(now + 86400_000).toISOString() }), invalid = note(76, { at: "invalid" });
  expect((await buildIntentBrief(source([future, invalid]), options())).items.map(view => view.id)).toEqual([future.id]);
});

test("missing, malformed or non-string policy revision guard refuses before policy or source queries", async () => {
  for (const version of [undefined, "not a callback", () => undefined, () => 1, () => { throw Error("revision unavailable"); }]) {
    let policies = 0, reads = 0;
    const config = { ...options(), policyVersion: version, policy: () => { policies++; return createStandalonePolicy(); } } as unknown as IntentBriefOptions;
    const result = await buildIntentBrief({ notes: () => { reads++; return [note(81)]; } }, config);
    expect(result).toMatchObject({ state: "unknown", text: "", items: [] }); expect(policies).toBe(0); expect(reads).toBe(0);
  }
});
test("mutable policy factory without a revision cannot publish an earlier public row", async () => {
  let tightened = false, policies = 0, reads = 0;
  const rows = [note(82, { text: "EARLY_ALLOWED writer" }), note(83, { text: "late trigger writer" })];
  const { policyVersion: _revision, ...unversioned } = options({ policy: () => {
    policies++; return createStandalonePolicy({ piiPatterns: tightened ? ["EARLY_ALLOWED"] : [], host: { screen: async value => { if ((value as Partial<View>).id === rows[1]!.id) { await Promise.resolve(); tightened = true; } return true; } } });
  } });
  const result = await buildIntentBrief({ notes: () => { reads++; return rows; } }, unversioned as IntentBriefOptions);
  expect(result).toMatchObject({ state: "unknown", text: "", items: [] }); expect(policies).toBe(0); expect(reads).toBe(0); expect(tightened).toBe(false);
});
