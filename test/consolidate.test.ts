import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeConsolidation, type ConsolidationOptions } from "../src/memory/consolidate.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { entryId, MEMORY_SCHEMA, MemoryStore } from "../src/memory/store.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-consolidate-")), project = "project";
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let at = Date.parse("2026-10-25T00:00:00.000Z");
  const store = new MemoryStore({ memoryDir: root, deferPromotions: true, screen: () => "promote", now: () => at }), candidates = new CandidateStore({ memoryDir: root });
  cleanup.push(() => store.close(), () => candidates.close());
  const note = (text: string, about = ["path:src/writer.ts"]) => { at++; return store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text, about }); };
  const options: ConsolidationOptions = { project, actor: "person", policy: () => createStandalonePolicy(), policyVersion: () => "fixed" };
  const run = (extra: Partial<ConsolidationOptions> = {}) => proposeConsolidation(store, candidates, { ...options, ...extra });
  return { root, store, candidates, project, note, run };
}
test("deterministic pass queues candidates only and re-running does not duplicate them", async () => {
  const f = fixture(); f.note("bounded writer lease avoids transaction contention"); f.note("bounded writer lease avoids transaction contention");
  const before = f.store.list({ project: f.project }), a = await f.run(), b = await f.run();
  expect(a.candidates.length).toBeGreaterThan(0); expect(a).toEqual(b);
  expect(f.candidates.list({ project: f.project })).toHaveLength(a.candidates.length); expect(f.store.list({ project: f.project })).toEqual(before);
});
test("private source rows never reach candidates and late policy changes refuse before any candidate write", async () => {
  const f = fixture(); f.note("bounded writer lease avoids transaction contention"); f.note("bounded writer lease avoids transaction contention");
  const denied = await f.run({ policy: () => createStandalonePolicy({ denyPaths: ["src/writer.ts"] }) }); expect(denied.candidates).toEqual([]);
  let version = "old";
  await expect(f.run({ policyVersion: () => version, policy: () => createStandalonePolicy({ host: { screen: async () => { version = "new"; return true; } } }) })).rejects.toThrow("context changed");
  expect(f.candidates.list({ project: f.project })).toEqual([]);
});
test("PII host gate and agent identity refuse before policy or source work", async () => {
  const f = fixture(); let calls = 0;
  const policy = () => { calls++; return createStandalonePolicy(); };
  await expect(f.run({ allowed: () => false, policy })).rejects.toThrow();
  await expect(f.run({ actor: "agent", policy })).rejects.toThrow("person");
  expect(calls).toBe(0); expect(f.candidates.list({ project: f.project })).toEqual([]);
});
test("oversized source quotations are counted instead of silently truncating proposed memory", async () => {
  const f = fixture(); const text = "bounded writer lease contention ".repeat(90); f.note(text); f.note(text);
  const result = await f.run(); expect(result.oversized).toBeGreaterThan(0); expect(result.candidates).toEqual([]);
});
test("local long originals are excluded and counted before any source text is copied into proposals", async () => {
  const f = fixture(); f.note("bounded writer lease avoids transaction contention");
  const machine = f.store.machine.id, body = { schema: MEMORY_SCHEMA, op: "note", at: new Date().toISOString(), machine, project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "bounded writer lease avoids transaction contention", about: ["path:src/writer.ts"] } as const;
  appendFileSync(join(f.root, "local", `${machine}.jsonl`), JSON.stringify({ ...body, id: entryId(body) }) + "\n");
  const result = await f.run(); expect(result.localExcluded).toBe(1); expect(result.candidates).toEqual([]); expect(f.candidates.list({ project: f.project })).toEqual([]);
});
test("an explicit library model pass follows deterministic proposals without ever writing curated memory", async () => {
  const f = fixture(); f.note("bounded writer lease avoids transaction contention"); f.note("bounded writer lease avoids transaction contention");
  const before = f.store.list({ project: f.project }); let calls = 0;
  const result = await f.run({ model: { enabled: true, run: async () => { calls++; expect(f.candidates.list({ project: f.project }).some(row => row.input.kind === "consolidation")).toBe(true); return { text: "review bounded writer leases" }; } } });
  expect(calls).toBe(1); expect(result.model?.ids).toHaveLength(1); expect(result.model?.state).toBe("known"); expect(f.store.list({ project: f.project })).toEqual(before);
  const model = f.candidates.get(result.model!.ids[0]!, f.project); expect(model?.input.kind).toBe("model-answer");
});
test("a merge proposal retains each source task as an explicit about node", async () => {
  const f = fixture();
  for (const task of ["work#1", "work#2"]) f.store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "bounded writer lease avoids contention", task, about: ["path:src/writer.ts"] });
  const report = await f.run(), input = f.candidates.get(report.candidates[0]!.id, f.project)!.input;
  expect(input.kind).toBe("consolidation"); if (input.kind !== "consolidation") throw Error("wrong candidate");
  expect(input.about).toContain("task:work#1"); expect(input.about).toContain("task:work#2");
});
test("the report counts only new or still-pending candidates as queued; accepted and rejected ones are already reviewed (task #439)", async () => {
  const f = fixture(); f.note("bounded writer lease avoids transaction contention"); f.note("bounded writer lease avoids transaction contention");
  const first = await f.run(); expect(first.candidates).toHaveLength(1); expect(first.alreadyReviewed).toBe(0);
  const again = await f.run(); expect(again.candidates).toHaveLength(1); expect(again.alreadyReviewed).toBe(0);   // pending: still queued, still reported
  f.candidates.reject(first.candidates[0]!.id, { project: f.project, actor: "person", verdict: "public" });
  const rejected = await f.run(); expect(rejected.candidates).toEqual([]); expect(rejected.alreadyReviewed).toBe(1);
  expect(f.candidates.list({ project: f.project, status: "all" })).toHaveLength(1);
});
test("an accepted consolidation does not make the next run propose a summary of it (task #439)", async () => {
  const f = fixture(); f.note("bounded writer lease avoids transaction contention"); f.note("bounded writer lease avoids transaction contention");
  const first = await f.run();
  f.candidates.accept(first.candidates[0]!.id, { project: f.project, actor: "person", verdict: "public", store: f.store, policy: () => true, policyVersion: () => "fixed" });
  const next = await f.run(); expect(next.candidates).toEqual([]); expect(next.alreadyReviewed).toBe(0);
});
