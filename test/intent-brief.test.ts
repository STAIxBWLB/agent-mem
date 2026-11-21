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
  // #542: a direct row that matches a requested node outranks a bridge-only neighbour, whatever the neighbour's kind.
  const result = await buildIntentBrief(source([direct, neighbour, tooFar]), options()); expect(result.items.map(row => row.id)).toEqual([direct.id, neighbour.id]); expect(result.text).not.toContain(`mem:${tooFar.id}`);
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
  // #542: with no requested nodes there are no matches to count, so an intent-only brief keeps the fails-first order.
  const choice = note(3, { kind: "decision", about: [], text: "writer lease choice" }), symptom = note(4, { about: [], text: "writer lease symptom" });
  expect((await buildIntentBrief(source([choice, symptom]), options({ paths: [], symbols: [] }))).items.map(row => row.id)).toEqual([symptom.id, choice.id]);
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

test("a fail wins an equal match-count tie while a multi-path decision beats hub-only fails", async () => {
  // #542: common paths let a kind-first order spend the whole budget on
  // fails that only co-reference them. Specificity is counted per requested node over the scanned rows.
  const hub = "docs/contracts.md", log = "CHANGELOG.md", platform = "src/memory/platform.ts", guard = "src/memory/plan-guard.ts";
  const paths = [hub, log, platform, guard], at = (minute: number) => new Date(now - (60 - minute) * 60_000).toISOString();
  const rows = [
    note(1, { at: at(1), about: [`path:${hub}`], text: "hub release sweep" }),
    note(2, { at: at(2), about: [`path:${hub}`, `path:${log}`], text: "hub release sweep" }),
    note(3, { at: at(3), about: [`path:${log}`], text: "hub release sweep" }),
    note(4, { at: at(4), about: [`path:${hub}`], text: "hub release sweep" }),
    // A fail matching all requested paths wins the equal-count tie against a decision.
    note(5, { at: at(5), about: paths.map(path => `path:${path}`), text: "release versioned host API" }),
    // One decision naming every requested path belongs ahead of fails naming fewer paths.
    note(6, { at: at(6), kind: "decision", about: paths.map(path => `path:${path}`), text: "release versioned host API" }),
    note(7, { at: at(7), kind: "contract", about: [`path:${hub}`, `path:${log}`], text: "hub release sweep" }),
    note(8, { at: at(8), about: [`path:${hub}`, `path:${log}`], text: "hub release sweep" }),
  ];
  const result = await buildIntentBrief(source(rows), options({ intent: "release versioned host API", paths, maxBytes: 2048 }));
  const order = result.items.map(view => view.id), decision = order.indexOf(rows[5]!.id);
  // The fail and decision each name every requested path, so the fail wins their equal-strength tie.
  expect(order.slice(0, 2)).toEqual([rows[4]!.id, rows[5]!.id]);
  // Every hub-only fail and the hub contract rank after the decision, and none is dropped: match count reorders, it never filters.
  for (const index of [0, 1, 2, 3, 6, 7]) expect(order.indexOf(rows[index]!.id)).toBeGreaterThan(decision);
  expect(order).toHaveLength(rows.length); expect(result.truncated).toBe(false);
});

test("a multi-path decision outranks fails matching only one requested path", async () => {
  // Count the request nodes a row itself matches, without counting other rows or inferring rarity.
  const hub = "path:docs/contracts.md", log = "path:CHANGELOG.md", platform = "path:src/memory/platform.ts", guard = "path:src/memory/plan-guard.ts";
  const at = (minute: number) => new Date(now - (240 - minute) * 60_000).toISOString();
  const rows: View[] = [
    ...Array.from({ length: 6 }, (_, index) => note(1 + index, { at: at(index), about: [hub], text: "hub release sweep" })),
    ...Array.from({ length: 30 }, (_, index) => note(20 + index, { at: at(10 + index), about: [log], text: "release sweep" })),
    note(60, { at: at(45), about: [platform], text: "release versioned host API" }),
    note(61, { at: at(46), about: [guard], text: "release versioned host API" }),
    note(62, { at: at(47), kind: "decision", about: [hub, platform, guard], text: "release versioned host API" }),
    note(63, { at: at(48), kind: "decision", about: [log], text: "release sweep" }),
  ];
  const result = await buildIntentBrief(source(rows), options({ intent: "release versioned host API", paths: ["docs/contracts.md", "CHANGELOG.md", "src/memory/platform.ts", "src/memory/plan-guard.ts"], maxBytes: 8192 }));
  const order = result.items.map(view => view.id), decision = order.indexOf(rows[38]!.id);
  // The decision names three requested nodes, so it ranks before every one-node fail.
  expect(order[0]).toBe(rows[38]!.id); expect(decision).toBe(0);
  expect(order.indexOf(rows[0]!.id)).toBeGreaterThan(decision);
});

test("a withheld row cannot move a public brief's order, bytes or truncation flag", async () => {
  // Below the screen cap, a withheld row cannot change another row's match count or the resulting output.
  // The two withheld rows used to affect cross-row rarity and reorder the public rows.
  const hub = "path:docs/contracts.md", rare = "path:src/memory/plan-guard.ts";
  const at = (minute: number) => new Date(now - (120 - minute) * 60_000).toISOString();
  const publicRows = [
    note(1, { at: at(1), about: [hub], text: "hub release sweep" }),
    note(2, { at: at(2), about: [hub], text: "hub release sweep" }),
    note(3, { at: at(3), kind: "decision", about: [hub, rare], text: "release versioned host API" }),
    note(4, { at: at(4), about: [rare], text: "release plan guard" }),
  ];
  const withheld = [
    note(5, { at: at(5), about: [rare], text: "PRIVATE_MARKER hub release sweep" }),
    note(6, { at: at(6), about: [rare], text: "PRIVATE_MARKER hub release sweep" }),
  ];
  const policy = () => createStandalonePolicy({ piiPatterns: ["PRIVATE_MARKER"] });
  const plain = await buildIntentBrief(source(publicRows), options({ intent: "release versioned host API", paths: ["docs/contracts.md", "src/memory/plan-guard.ts"], policy, maxBytes: 700 }));
  const padded = await buildIntentBrief(source([...publicRows, ...withheld]), options({ intent: "release versioned host API", paths: ["docs/contracts.md", "src/memory/plan-guard.ts"], policy, maxBytes: 700 }));
  expect(plain.items.length).toBeGreaterThan(1);
  expect(padded.text).toBe(plain.text); expect(padded.items.map(view => view.id)).toEqual(plain.items.map(view => view.id));
  expect({ bytes: padded.bytes, truncated: padded.truncated }).toEqual({ bytes: plain.bytes, truncated: plain.truncated });
  expect(padded.items.some(view => withheld.some(row => row.id === view.id))).toBe(false);
  expect(padded.text).not.toContain("PRIVATE_MARKER");
});

test("a decision naming several requested paths is screened before a hundred generic direct fails", async () => {
  // #542: the metered screen budget was spent kind-first, so 96 fails naming only docs/contracts.md could exhaust it and the
  // decision never reached the ranking at all - visible only as its absence. The screening key is row-local (how many requested
  // nodes the row itself names), so a decision on the work is screened first and the cap then falls on the generic fails.
  const hub = "path:docs/contracts.md", rare = "path:src/memory/platform.ts";
  const at = (minute: number) => new Date(now - (300 - minute) * 60_000).toISOString();
  const generic = Array.from({ length: 100 }, (_, index) => note(200 + index, { at: at(index), about: [hub], text: "hub release sweep" }));
  const decision = note(9, { at: at(100), kind: "decision", about: [hub, rare], text: "release versioned host API" });
  const result = await buildIntentBrief(source([...generic, decision]), options({ intent: "release versioned host API", paths: ["docs/contracts.md", "src/memory/platform.ts"], maxBytes: 1024 }));
  expect(result.items[0]?.id).toBe(decision.id);
  // 101 direct rows against 96 metered screens: the cap still binds and still reports itself.
  expect(result.truncated).toBe(true);
});

test("three and four requested-node matches tie, so fails lead", async () => {
  const paths = ["a.ts", "b.ts", "c.ts", "d.ts"];
  const fail = note(800, { kind: "fail", about: paths.slice(0, 3).map(path => `path:${path}`) });
  const decision = note(801, { kind: "decision", about: paths.map(path => `path:${path}`) });
  const result = await buildIntentBrief(source([decision, fail]), options({ paths, maxBytes: 2048 }));
  expect(result.items.map(row => row.id)).toEqual([fail.id, decision.id]);
});
