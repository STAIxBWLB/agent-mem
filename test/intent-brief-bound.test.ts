import { expect, test } from "bun:test";
import { buildIntentBrief, INTENT_BRIEF_SCREEN_LIMIT, type IntentBriefOptions, type IntentBriefSource } from "../src/memory/intent-brief.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import type { View } from "../src/memory/store.ts";

/** #316: the brief asks the policy only about rows that can reach it, and that bound changes no line it emits. */
const now = Date.parse("2026-11-19T00:00:00.000Z");
const at = (minute: number) => new Date(Date.parse("2026-11-18T00:00:00.000Z") + minute * 60_000).toISOString();
function note(n: number, extra: Partial<View> = {}): View {
  return {
    id: n.toString(16).padStart(32, "0"), at: at(n), machine: "a".repeat(16), project: "project", scope: "project", tier: "long",
    kind: "fail", peer: "person", title: null, text: "writer boundary symptom", task: null, about: ["path:src/writer.ts"],
    source: "person", supersededBy: null, supersedes: [], promotedFrom: null, expiresAt: null, local: false, ...extra,
  };
}
function options(extra: Partial<IntentBriefOptions> = {}): IntentBriefOptions {
  return { project: "project", cwd: "/unopened/repo", repo: "org/repo", intent: "repair writer", paths: ["src/writer.ts"], policy: () => createStandalonePolicy(), policyVersion: () => "v1", now: () => now, ...extra };
}
const source = (rows: readonly View[]): IntentBriefSource => ({ notes: () => rows });
const ids = (result: { items: View[] }) => result.items.map(view => view.id);

/** Twelve rows that can reach the brief, one of them only through a direct row's co-reference node. */
const relevant = (): View[] => [
  note(1, { kind: "fail" }),
  note(2),
  note(3, { kind: "decision", about: ["path:src/writer.ts", "symbol:shared@src/common.ts"] }),
  note(4, { about: ["symbol:shared@src/common.ts", "issue:org/repo#466"] }),
  note(5, { kind: "contract" }),
  note(6, { about: ["path:src/writer.ts", "issue:org/repo#9"] }),
  note(7, { about: ["issue:org/repo#9"] }),
  note(8, { kind: "decision" }),
  note(9, { kind: "decision" }), note(10, { kind: "decision" }), note(11, { kind: "decision" }), note(12, { kind: "decision" }),
];
/** Two thousand rows that cannot reach it: another path, no shared node, no intent word. */
const noise = (count = 2000): View[] => Array.from({ length: count }, (_, index) => note(1000 + index, {
  at: at(index + 200), about: [`path:src/other/module${index % 40}.ts`], text: `unrelated calendar note ${index}`,
}));

test("below the screen cap the brief is identical with and without rows it cannot reach", async () => {
  const rows = relevant(), plain = await buildIntentBrief(source(rows), options()), padded = await buildIntentBrief(source([...rows, ...noise()]), options());
  expect(plain.items.length).toBeGreaterThan(0);
  expect(padded.text).toBe(plain.text); expect(ids(padded)).toEqual(ids(plain));
  expect({ bytes: padded.bytes, truncated: padded.truncated, state: padded.state }).toEqual({ bytes: plain.bytes, truncated: plain.truncated, state: plain.state });
  // The one-hop neighbour still arrives: 4 through 3, and 7 through 6, while no unreachable row does.
  expect(ids(plain)).toContain(rows[3]!.id); expect(ids(plain)).toContain(rows[6]!.id); expect(ids(plain)).not.toContain(noise(1)[0]!.id);
});

test("the same holds on the intent-word path, where relevance is the text rather than a plan node", async () => {
  const rows = relevant().map(row => ({ ...row, about: [] })), plain = await buildIntentBrief(source(rows), options({ paths: [] })), padded = await buildIntentBrief(source([...rows, ...noise()]), options({ paths: [] }));
  expect(plain.items.length).toBeGreaterThan(0); expect(padded.text).toBe(plain.text); expect(ids(padded)).toEqual(ids(plain));
});

test("only rows that can reach the brief reach the policy, once each", async () => {
  let screens = 0, reads = 0;
  const rows = relevant();
  const result = await buildIntentBrief({ notes: () => { reads++; return [...rows, ...noise()]; } }, options({
    policy: () => createStandalonePolicy({ host: { screen: async value => { if ((value as Partial<View>).id) screens++; return true; } } }),
  }));
  expect(reads).toBe(1); expect(result.items.length).toBeGreaterThan(0);
  // Every direct and neighbour row, once each, never the two thousand unreachable ones; the query itself is screened apart.
  expect(screens).toBe(rows.length);
});

test("a private direct row still bridges nothing, so its neighbour never becomes a candidate", async () => {
  const bridge = note(21, { text: "hidden bridge", about: ["path:src/writer.ts", "issue:org/repo#8"] }), neighbour = note(22, { about: ["issue:org/repo#8"] }), publicRow = note(23);
  const result = await buildIntentBrief(source([bridge, neighbour, publicRow]), options({ policy: () => createStandalonePolicy({ piiPatterns: ["hidden bridge"] }) }));
  expect(ids(result)).toEqual([publicRow.id]);
});

test("the cap keeps the rows that rank highest: newest within a kind, and direct before neighbours", async () => {
  // 400 direct rows of one kind, far over the cap; the newest ones must be the ones the brief holds.
  const rows = Array.from({ length: 400 }, (_, index) => note(5000 + index, { at: at(index) }));
  let screens = 0;
  const result = await buildIntentBrief(source(rows), options({
    maxBytes: 4096, policy: () => createStandalonePolicy({ host: { screen: async value => { if ((value as Partial<View>).id) screens++; return true; } } }),
  }));
  expect(screens).toBe(INTENT_BRIEF_SCREEN_LIMIT);
  expect(result.truncated).toBe(true);
  expect(ids(result)).toContain(rows.at(-1)!.id);
  expect(ids(result)).not.toContain(rows[0]!.id);
  const ats = result.items.map(view => view.at);
  expect([...ats].sort((a, b) => b.localeCompare(a))).toEqual(ats);
});

test("a narrowed build stays under the 250 ms bound when the host screen is expensive", async () => {
  const burn = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until); };
  const rows = [...relevant(), ...noise(2388)];
  let screens = 0;
  const started = performance.now();
  const result = await buildIntentBrief(source(rows), options({ policy: () => createStandalonePolicy({ host: { screen: async value => { if ((value as Partial<View>).id) screens++; if ((value as Partial<View>).id) burn(0.4); return true; } } }) }));
  const elapsed = performance.now() - started;
  expect(result.items.length).toBeGreaterThan(0); expect(result.state).toBe("known");
  expect(screens).toBeLessThanOrEqual(INTENT_BRIEF_SCREEN_LIMIT);
  // Without the bound every row paid that callback: 2,400 x 0.4 ms is about a second.
  expect(elapsed).toBeLessThan(250);
});

test("a policy tightened while a narrowed row is being screened withholds it", async () => {
  let tightened = false;
  const rows = [note(31), note(32, { text: "last public choice" })];
  const result = await buildIntentBrief(source(rows), options({
    policy: () => createStandalonePolicy({
      piiPatterns: tightened ? ["writer"] : [],
      host: { screen: async value => { if ((value as Partial<View>).id === rows[1]!.id) { await Promise.resolve(); tightened = true; } return true; } },
    }),
    policyVersion: () => String(tightened),
  }));
  expect(ids(result)).not.toContain(rows[0]!.id); expect(result.text).not.toContain("writer");
});

test("a row written between two builds is read by the second, so nothing is reused across calls", async () => {
  const rows = [note(41)];
  const first = await buildIntentBrief({ notes: () => [...rows] }, options());
  rows.unshift(note(42, { at: at(900), text: "newer writer boundary symptom" }));
  const second = await buildIntentBrief({ notes: () => [...rows] }, options());
  expect(ids(first)).toEqual([note(41).id]);
  expect(ids(second)).toContain(note(42).id); expect(second.text).not.toBe(first.text);
});
