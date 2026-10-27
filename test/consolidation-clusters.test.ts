import { expect, test } from "bun:test";
import { consolidationClusters, CONSOLIDATION_PROPOSAL_LIMIT, isAcceptedConsolidation } from "../src/memory/consolidation-clusters.ts";
import { setFts5AvailableForTest } from "../src/memory/search-fts.ts";
import type { View } from "../src/memory/store.ts";
const now = Date.parse("2026-10-25T00:00:00.000Z");
function note(n: number, extra: Partial<View> = {}): View {
  return { id: n.toString(16).padStart(32, "0"), at: "2026-10-24T00:00:00.000Z", machine: "a".repeat(16), project: "project", scope: "project", tier: "long", kind: "fail", peer: "person", title: null, text: "writer lease contention blocks transaction", task: null, about: ["path:src/writer.ts"], source: "person", supersededBy: null, supersedes: [], promotedFrom: null, expiresAt: null, local: false, ...extra };
}
test("deterministic merge and supersession proposals leave every source unchanged", () => {
  const rows = [note(1), note(2), note(3, { text: "writer lease contention blocks bounded transaction" })], before = JSON.stringify(rows);
  const a = consolidationClusters(rows, "project", now), b = consolidationClusters([...rows].reverse(), "project", now);
  expect(a).toEqual(b); expect(a.clusters.some(row => row.action === "supersession" && row.sources.map(source => source.id).sort().join() === [rows[0]!.id, rows[1]!.id].sort().join())).toBe(true);
  expect(a.clusters.some(row => row.action === "merge" && row.sources.some(source => source.id === rows[2]!.id))).toBe(true);
  expect(JSON.stringify(rows)).toBe(before);
});
test("foreign, superseded and expired entries are excluded; current future timestamps survive", () => {
  const valid = note(1), rows = [valid, note(2, { project: "foreign", scope: "shared" }), note(3, { supersededBy: "replacement" }), note(4, { expiresAt: new Date(now).toISOString() }), note(5, { at: new Date(now + 1000).toISOString() })];
  const result = consolidationClusters(rows, "project", now);
  expect(result.clusters).toHaveLength(1); expect(result.clusters[0]!.sources.map(row => row.id).sort()).toEqual([valid.id, rows[4]!.id].sort());
});
test("a recurring-fix proposal names actual related decisions without inventing a fix", () => {
  const fails = [note(1), note(2, { text: "writer lease contention blocks second transaction" })];
  expect(consolidationClusters(fails, "project", now).clusters.some(row => row.action === "recurring-fix")).toBe(false);
  const decision = note(3, { kind: "decision", text: "bound writer lease duration before transaction" });
  const result = consolidationClusters([...fails, decision], "project", now).clusters.find(row => row.action === "recurring-fix");
  expect(result?.sources.map(row => row.id).sort()).toEqual([...fails, decision].map(row => row.id).sort());
  expect(result?.reason).toContain("review whether");
});
test("a shared path alone does not imply a merge; lexical fallback stays deterministic", () => {
  const rows = [note(1), note(2, { text: "parser unicode escaping keeps strings intact" })];
  expect(consolidationClusters(rows, "project", now).clusters).toEqual([]);
  setFts5AvailableForTest(false);
  try { const a = consolidationClusters([note(1), note(2)], "project", now); expect(a.engine).toBe("substring"); expect(a.clusters[0]?.action).toBe("supersession"); }
  finally { setFts5AvailableForTest(undefined); }
});
test("bounded source and proposal windows explicitly report truncation", () => {
  const rows = Array.from({ length: 257 }, (_, i) => note(i + 1));
  const result = consolidationClusters(rows, "project", now);
  expect(result.truncated).toBe(true); expect(result.clusters).toHaveLength(CONSOLIDATION_PROPOSAL_LIMIT);
  expect(result.clusters.flatMap(row => row.sources).every(row => row.id !== rows[256]!.id)).toBe(true);
});
const accepted = (n: number, action: string, extra: Partial<View> = {}) => note(n, { text: `Accepted consolidation candidate: ${"c".repeat(64)}\nAction: ${action}\nSources: mem:${note(8).id}\n\nwriter lease contention blocks transaction`, ...extra });

test("only the complete acceptance header excludes a consolidation source, not a person's quoted prefix", () => {
  const valid = accepted(1, "merge");
  expect(isAcceptedConsolidation(valid)).toBe(true);
  for (const text of [
    "Accepted consolidation candidate: notes about the proposal",
    valid.text.replace("c".repeat(64), "c".repeat(63)),
    valid.text.replace("Action: merge", "Action: unknown"),
    valid.text.replace(`mem:${note(8).id}`, "mem:x"),
    valid.text.replace("\n\n", "\n"),
  ]) {
    const quoted = note(2, { kind: "decision", text, supersedes: [note(8).id, note(9).id] });
    expect(isAcceptedConsolidation(quoted)).toBe(false);
    expect(consolidationClusters([quoted], "project", now).clusters).toMatchObject([{ action: "merge", sources: [{ id: quoted.id }] }]);
  }
});
test("an accepted recurring-fix summary is not a fail source and does not pair with its own sources (task #439)", () => {
  const fails = [note(1), note(2, { text: "writer lease contention blocks second transaction" })], decision = note(3, { kind: "decision", text: "bound writer lease duration before transaction" });
  const first = consolidationClusters([...fails, decision], "project", now).clusters.filter(row => row.action === "recurring-fix");
  expect(first).toHaveLength(1);
  const summary = accepted(4, "recurring-fix");   // accepted: a live fail on the same path, quoting its sources
  const second = consolidationClusters([...fails, decision, summary], "project", now).clusters;
  expect(second.filter(row => row.action === "recurring-fix")).toHaveLength(1);
  expect(second.every(row => row.sources.every(source => source.id !== summary.id))).toBe(true);
});
test("an accepted merge or supersession head is not proposed again as a single-source chain summary (task #439)", () => {
  const head = accepted(1, "merge", { kind: "decision", supersedes: [note(8).id, note(9).id] }), other = note(2, { kind: "decision", text: "parser unicode escaping keeps strings intact" });
  expect(consolidationClusters([head, other], "project", now).clusters).toEqual([]);
  const plain = note(3, { kind: "decision", supersedes: [note(8).id, note(9).id] });   // a person's own multi-original head still gets the chain summary
  expect(consolidationClusters([plain, other], "project", now).clusters.map(row => row.action)).toEqual(["merge"]);
});

test("accepted merge and decision summaries never enter pair merges or seed a recurring-fix proposal", () => {
  const summary = accepted(4, "merge", { kind: "decision", supersedes: [note(8).id, note(9).id] });
  const ordinary = note(3, { kind: "decision", text: "writer lease contention blocks bounded transaction" });
  expect(consolidationClusters([summary, ordinary], "project", now).clusters).toEqual([]);
  const fails = [note(1), note(2, { text: "writer lease contention blocks second transaction" })];
  const result = consolidationClusters([...fails, summary], "project", now);
  expect(result.clusters.some(row => row.action === "recurring-fix")).toBe(false);
  expect(result.clusters.every(row => row.sources.every(source => source.id !== summary.id))).toBe(true);
});
