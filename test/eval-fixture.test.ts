import { expect, test } from "bun:test";
import { parseEvalSet, type EvalSet } from "../src/memory/eval.ts";
import { evalSeeded, readEvalSet } from "../src/memory/eval-fixture.ts";

const PROJECT = "example.test/eval/fixture";
const small = (): EvalSet => ({ schema: "amem.eval/v1", entries: [
  { key: "new", title: "New note", text: "signal new protocol", at: "2025-06-01T12:00:00Z" },
  { key: "old", title: "Old note", text: "signal old protocol", at: "2021-02-03" },
], questions: [{ q: "signal", expect: ["new", "old"] }] });

test("strict eval parser accepts calendar dates and UTC timestamps, preserving optional field absence", () => {
  const input = small(); input.now = "2025-06-10T12:00:00.123Z";
  expect(parseEvalSet(input)).toEqual(input);
  for (const invalid of [null, 42, "", "yesterday", "06/01/2025", "2025-02-29", "2024-02-30T00:00:00Z", "2025-06-01T24:00:00Z", "2025-06-01T12:00:00"]) {
    expect(() => parseEvalSet({ ...small(), now: invalid }), String(invalid)).toThrow("ISO date");
    const set = small(); (set.entries![0] as any).at = invalid;
    expect(() => parseEvalSet(set), String(invalid)).toThrow("ISO date");
  }
  expect(() => parseEvalSet({ schema: "amem.eval/v1", questions: [{ q: "signal", expect: ["12345678"] }], now: "2025-01-01" })).toThrow("self-contained entries");
  const undated = { schema: "amem.eval/v1", entries: [{ key: "one", text: "signal" }], questions: [{ q: "signal", expect: ["one"] }] };
  expect(JSON.stringify(parseEvalSet(undated))).toBe(JSON.stringify(undated));
  expect(() => parseEvalSet({ ...undated, clock: "2025-01-01" })).toThrow("unknown key");
});

test("dated seeding honours timestamps and searches one day after the latest entry, not the last row", () => {
  let observed: unknown;
  evalSeeded(parseEvalSet(small()), [1, 2], store => {
    observed = { now: new Date(store.readNow()).toISOString(), entries: store.list({ project: PROJECT }).map(v => [v.title, v.at]).sort() };
    return [];
  });
  expect(observed).toEqual({ now: "2025-06-02T12:00:00.000Z", entries: [
    ["New note", "2025-06-01T12:00:00.000Z"], ["Old note", "2021-02-03T00:00:00.000Z"],
  ] });
});

test("explicit now changes the search clock and short-note coverage without rewriting seed dates", () => {
  const set = parseEvalSet({ schema: "amem.eval/v1", entries: [{ key: "short", text: "signal", tier: "short", at: "2025-01-01" }], questions: [{ q: "signal", expect: ["short"] }] });
  expect(evalSeeded(set).perQuestion[0]).toMatchObject({ present: 1, missing: 0 });
  set.now = "2025-01-30";
  let clock: number | undefined;
  const report = evalSeeded(set, [1], store => { clock = store.readNow(); return []; });
  expect(clock).toBe(Date.parse(set.now));
  expect(report.perQuestion[0]).toMatchObject({ present: 0, missing: 1, answerable: false });
});

test("undated entries keep long-first daily seeding and the original stopped clock", () => {
  let observed: unknown;
  const set: EvalSet = { schema: "amem.eval/v1", entries: [
    { key: "short", title: "Short", text: "signal", tier: "short" },
    { key: "first", title: "First", text: "signal first" },
    { key: "second", title: "Second", text: "signal second" },
  ], questions: [{ q: "signal", expect: ["first"] }] };
  evalSeeded(set, [1], store => {
    observed = { now: new Date(store.readNow()).toISOString(), entries: store.list({ project: PROJECT }).map(v => [v.title, v.at]).sort() };
    return [];
  });
  expect(observed).toEqual({ now: "2026-01-04T00:00:00.000Z", entries: [
    ["First", "2026-01-01T00:00:00.000Z"], ["Second", "2026-01-02T00:00:00.000Z"], ["Short", "2026-01-03T00:00:00.000Z"],
  ] });
});

test("mixed sets keep positional dates for undated entries and use the latest actual seed date", () => {
  const set = small(); delete set.entries![1]!.at;
  let now: number | undefined;
  evalSeeded(set, [1], store => { now = store.readNow(); return []; });
  expect(now).toBe(Date.parse("2026-01-03T00:00:00.000Z"));
});

test("temporal fixture is dated, synthetic and covers both versions, newest, earlier and timeless retrieval", () => {
  const set = readEvalSet(new URL("./fixtures/eval-temporal.json", import.meta.url));
  expect(set.questions).toHaveLength(36);
  expect(set.entries).toHaveLength(39);
  expect(set.entries!.every(e => e.at !== undefined && e.tier === "long")).toBe(true);
  const dates = set.entries!.map(e => Date.parse(e.at!));
  expect(Math.max(...dates) - Math.min(...dates)).toBeGreaterThan(4 * 365 * 86400_000);
  for (const tag of ["knowledge-update", "newest-state", "earlier-state", "timeless-control"]) expect(set.questions.filter(q => q.tag === tag)).toHaveLength(9);
  const byKey = new Map(set.entries!.map(e => [e.key, e]));
  for (const q of set.questions.filter(q => q.tag === "knowledge-update")) {
    expect(q.expect).toHaveLength(2);
    expect(new Set(q.expect.map(key => byKey.get(key)!.at)).size).toBe(2);
  }
  expect(JSON.stringify(set)).not.toMatch(/\/Users\/|\/home\/|@[a-z0-9-]+\.[a-z]{2,}|agent-hub|AKIA|BEGIN [A-Z ]*PRIVATE KEY/);
});
