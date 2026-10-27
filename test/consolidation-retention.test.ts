import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CandidateStore, CANDIDATE_RETENTION, CONSOLIDATION_REVIEW_LIMIT, ConsolidationReviewLimit, candidateTargetRevision, type CandidateInput } from "../src/memory/candidates.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { proposeConsolidation } from "../src/memory/consolidate.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-consolidation-retention-")), project = "project", clock = { now: Date.parse("2026-10-25T00:00:00.000Z") };
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: root, now: () => clock.now, deferPromotions: true, screen: () => "promote" }); cleanup.push(() => store.close());
  let candidates = new CandidateStore({ memoryDir: root, now: () => clock.now }); cleanup.push(() => candidates.close());
  const note = () => { clock.now++; return store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "bounded writer lease avoids transaction contention", about: ["path:src/writer.ts"] }); };
  const target = note();
  const input = (text = "review the bounded writer contract"): CandidateInput => ({ kind: "consolidation", project, action: "recurring-fix", targets: [{ id: target, revision: candidateTargetRevision(store.get(target, project)!) }], text, about: ["path:src/writer.ts"], noteKind: "decision" });
  const reopen = () => { candidates.close(); candidates = new CandidateStore({ memoryDir: root, now: () => clock.now }); return candidates; };
  return { root, project, clock, store, note, input, reopen, get candidates() { return candidates; } };
}

for (const status of ["accepted", "rejected"] as const) test(`consolidation ${status} identity survives age pruning and reopening without retaining its payload`, () => {
  const f = fixture(), input = f.input(), id = f.candidates.put(input, "public");
  let noteId: string | null = null;
  if (status === "rejected") f.candidates.reject(id, { project: f.project, actor: "person", verdict: "public" });
  else noteId = f.candidates.accept(id, { project: f.project, actor: "person", verdict: "public", store: f.store, policy: () => true, policyVersion: () => "fixed" }).noteId;
  expect(f.candidates.reviewedConsolidation(id, f.project)).toEqual({ status, acceptedNoteId: noteId });
  f.clock.now += CANDIDATE_RETENTION.ageMs + 1;
  const candidates = f.reopen();
  expect(candidates.get(id, f.project)).toBeUndefined();
  expect(candidates.reviewedConsolidation(id, f.project)).toEqual({ status, acceptedNoteId: noteId });
  expect(candidates.put(input, "public")).toBe(id);
  expect(candidates.list({ project: f.project, status: "all" })).toEqual([]);
  const db = new Database(candidates.path, { readonly: true });
  try {
    expect((db.query("PRAGMA table_info(consolidation_reviews)").all() as { name: string }[]).map(row => row.name)).toEqual(["id", "project", "status", "note_id"]);
    expect(JSON.stringify(db.query("SELECT * FROM consolidation_reviews").all())).not.toContain("bounded writer contract");
  } finally { db.close(); }
});

test("opening an older candidate database saves reviewed identities before deleting aged payloads", () => {
  const f = fixture(), id = f.candidates.put(f.input(), "public");
  f.candidates.reject(id, { project: f.project, actor: "person", verdict: "public" });
  const db = new Database(f.candidates.path); try { db.run("DROP TABLE consolidation_reviews"); } finally { db.close(); }
  f.clock.now += CANDIDATE_RETENTION.ageMs + 1;
  const candidates = f.reopen();
  expect(candidates.get(id, f.project)).toBeUndefined();
  expect(candidates.reviewedConsolidation(id, f.project)?.status).toBe("rejected");
});

test("candidate count eviction cannot requeue a reviewed consolidation even while the payload queue is full", () => {
  const f = fixture(), input = f.input(), id = f.candidates.put(input, "public");
  f.candidates.reject(id, { project: f.project, actor: "person", verdict: "public" });
  for (let i = 0; i < CANDIDATE_RETENTION.count; i++) f.candidates.put({ kind: "memory", project: f.project, text: `unshown fixture ${i}` }, "public");
  expect(f.candidates.get(id, f.project)).toBeUndefined();
  expect(f.candidates.put(input, "public")).toBe(id);
  expect(f.candidates.reviewedConsolidation(id, f.project)?.status).toBe("rejected");
  expect(f.candidates.list({ project: f.project, status: "all" })).toHaveLength(CANDIDATE_RETENTION.count);
});

test("an interrupted accepting identity survives a shown payload's age expiry without granting replay", () => {
  const f = fixture(), input = f.input(), id = f.candidates.put(input, "public"), db = new Database(f.candidates.path);
  try { db.query("UPDATE candidates SET status = 'accepting', shown_at = ? WHERE id = ?").run(f.clock.now, id); }
  finally { db.close(); }
  f.clock.now += CANDIDATE_RETENTION.ageMs + 1;
  const candidates = f.reopen();
  expect(candidates.get(id, f.project)).toBeUndefined();
  expect(candidates.reviewedConsolidation(id, f.project)).toEqual({ status: "accepting", acceptedNoteId: null });
  expect(candidates.put(input, "public")).toBe(id);
  expect(candidates.list({ project: f.project })).toEqual([]);
});

test("deterministic consolidation reports a rejected proposal as reviewed after payload retention", async () => {
  const f = fixture(); f.note();
  const options = { project: f.project, actor: "person" as const, policy: () => createStandalonePolicy(), policyVersion: () => "fixed" };
  const first = await proposeConsolidation(f.store, f.candidates, options); expect(first.candidates).toHaveLength(1);
  f.candidates.reject(first.candidates[0]!.id, { project: f.project, actor: "person", verdict: "public" });
  f.clock.now += CANDIDATE_RETENTION.ageMs + 1;
  f.reopen();
  const repeated = await proposeConsolidation(f.store, f.candidates, options);
  expect(repeated.candidates).toEqual([]); expect(repeated.alreadyReviewed).toBe(1);
  expect(f.candidates.list({ project: f.project })).toEqual([]);
});

test("the bounded receipt cap reserves room for queued review and never evicts a past decision", async () => {
  const f = fixture(), db = new Database(f.candidates.path);
  try {
    const insert = db.query("INSERT INTO consolidation_reviews (id, project, status) VALUES (?, ?, 'rejected')");
    db.transaction(() => { for (let i = 0; i < CONSOLIDATION_REVIEW_LIMIT - 1; i++) insert.run(i.toString(16).padStart(64, "0"), f.project); }).immediate();
  } finally { db.close(); }
  const input = f.input(), id = f.candidates.put(input, "public");
  let refusal: unknown;
  try { f.candidates.put(f.input("a second proposal"), "public"); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(ConsolidationReviewLimit);
  expect(refusal).toMatchObject({ code: "consolidation_review_limit", project: f.project, count: CONSOLIDATION_REVIEW_LIMIT, limit: CONSOLIDATION_REVIEW_LIMIT });
  f.candidates.reject(id, { project: f.project, actor: "person", verdict: "public" });
  f.clock.now += CANDIDATE_RETENTION.ageMs + 1;
  const candidates = f.reopen();
  expect(candidates.put(input, "public")).toBe(id);
  expect(candidates.get(id, f.project)).toBeUndefined();
  expect(candidates.reviewedConsolidation("0".repeat(64), f.project)?.status).toBe("rejected");
  expect(() => candidates.put(f.input("a third proposal"), "public")).toThrow(`consolidation review cap reached: project ${f.project}, count ${CONSOLIDATION_REVIEW_LIMIT}`);
  const count = new Database(candidates.path, { readonly: true });
  try { expect((count.query("SELECT count(*) AS n FROM consolidation_reviews WHERE project = ?").get(f.project) as { n: number }).n).toBe(CONSOLIDATION_REVIEW_LIMIT); }
  finally { count.close(); }
  expect(candidates.list({ project: f.project, status: "all" })).toEqual([]);
  f.note();
  await expect(proposeConsolidation(f.store, candidates, { project: f.project, actor: "person", policy: () => createStandalonePolicy(), policyVersion: () => "fixed" })).rejects.toThrow(`consolidation review cap reached: project ${f.project}, count ${CONSOLIDATION_REVIEW_LIMIT}`);
});
