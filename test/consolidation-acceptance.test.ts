import { afterEach, expect, test } from "bun:test";
import { appendFileSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CandidateStore, candidateTargetRevision, type CandidateAcceptance, type CandidateInput } from "../src/memory/candidates.ts";
import { entryId, MEMORY_SCHEMA, MemoryStore, type NoteInput } from "../src/memory/store.ts";
import { openShardStore } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { SegmentReader } from "../src/memory/bridge.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-consolidation-")), project = "project";
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: root, deferPromotions: true, screen: () => "promote" }), candidates = new CandidateStore({ memoryDir: root });
  cleanup.push(() => store.close(), () => candidates.close());
  const note = (text: string, extra: Partial<NoteInput> = {}) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text, about: ["path:src/writer.ts"], ...extra });
  const proposal = (ids: string[], action: "merge" | "supersession" | "recurring-fix" = "merge"): CandidateInput => ({ kind: "consolidation", project, action, targets: ids.map(id => ({ id, revision: candidateTargetRevision(store.get(id, project)!) })), text: "Review the combined bounded writer contract.", about: ["path:src/writer.ts"], noteKind: "decision" });
  const accept = (id: string, actor: "person" | "agent" = "person", policy = () => true) => candidates.accept(id, { project, actor, verdict: "public", store, policy, policyVersion: () => "fixed" });
  return { root, store, candidates, project, note, proposal, accept };
}
test("consolidation proposals write no curated data; person acceptance replaces the exact sources once", () => {
  const f = fixture(), a = f.note("writer boundary A"), b = f.note("writer boundary B"), id = f.candidates.put(f.proposal([a, b]), "public");
  expect(f.store.list({ project: f.project })).toHaveLength(2);
  expect(() => f.accept(id, "agent")).toThrow("person");
  const accepted = f.accept(id);
  expect(f.store.get(a, f.project)?.supersededBy).toBe(accepted.noteId); expect(f.store.get(b, f.project)?.supersededBy).toBe(accepted.noteId);
  expect(f.accept(id)).toMatchObject({ noteId: accepted.noteId, alreadyAccepted: true });
});
test("stale and foreign sources or host-policy refusal make no replacement", () => {
  for (const mode of ["stale", "foreign", "policy"] as const) {
    const f = fixture(), a = f.note("source A"), b = f.note("source B", mode === "foreign" ? { project: "foreign", scope: "shared" } : {});
    const input = f.proposal([a, b]), id = f.candidates.put(input, "public");
    if (mode === "stale") f.store.demote(a, "person", f.project);
    const before = f.store.list({ project: f.project, includeSuperseded: true }).map(row => row.id);
    expect(() => f.accept(id, "person", () => mode !== "policy")).toThrow();
    expect(f.store.list({ project: f.project, includeSuperseded: true }).map(row => row.id)).toEqual(before);
    expect(f.candidates.get(id, f.project)?.status).toBe("pending");
  }
});
test("recurring-fix acceptance preserves the source failures and decisions", () => {
  const f = fixture(), a = f.note("first fail", { kind: "fail" }), b = f.note("second fail", { kind: "fail" }), fix = f.note("bounded writer decision");
  const id = f.candidates.put(f.proposal([a, b, fix], "recurring-fix"), "public"), result = f.accept(id);
  expect(f.store.get(result.noteId, f.project)?.text).toContain(`mem:${a}`);
  for (const source of [a, b, fix]) expect(f.store.get(source, f.project)?.supersededBy).toBeNull();
});
test("a partial supersession reports its note and exact uncertain targets and refuses automatic replay", () => {
  const f = fixture(), a = f.note("first source"), b = f.note("second source"), id = f.candidates.put(f.proposal([a, b]), "public");
  const original = f.store.supersede.bind(f.store); let calls = 0;
  f.store.supersede = (...args) => { if (++calls === 2) throw Error("simulated private I/O detail"); return original(...args); };
  let message = ""; try { f.accept(id); } catch (error) { message = (error as Error).message; }
  const noteId = f.store.get(a, f.project)?.supersededBy;
  expect(noteId).toMatch(/^[a-f0-9]{32}$/); expect(message).toContain(`inspect note ${noteId}`); expect(message).toContain(`superseded ${a}`); expect(message).toContain(`remaining or uncertain ${b}`);
  expect(message).not.toContain("private I/O"); expect(f.candidates.get(id, f.project)?.status).toBe("accepting"); expect(() => f.accept(id)).toThrow("interrupted");
});
test("mixed placement refuses before the accepted note or any supersession is appended", () => {
  const f = fixture(), a = f.note("synced source"), b = f.note("local source", { tier: "short" }), id = f.candidates.put(f.proposal([a, b]), "public");
  const before = f.store.list({ project: f.project, includeSuperseded: true });
  expect(() => f.accept(id)).toThrow("synced source placement"); expect(f.store.list({ project: f.project, includeSuperseded: true })).toEqual(before);
  expect(f.candidates.get(id, f.project)?.status).toBe("pending");
});
test("legacy local long originals never get copied into a synced consolidation note", () => {
  const f = fixture(), synced = f.note("synced source"), machine = f.store.machine.id;
  const body = { schema: MEMORY_SCHEMA, op: "note", at: new Date().toISOString(), machine, project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "PRIVATE_LOCAL_LONG_ORIGINAL", about: [] } as const;
  const local = entryId(body); appendFileSync(join(f.root, "local", `${machine}.jsonl`), JSON.stringify({ ...body, id: local }) + "\n");
  expect(f.store.get(local, f.project)?.local).toBe(false);
  expect(f.store.entryPlacements([local, synced], f.project).get(local)).toBe("local");
  const id = f.candidates.put(f.proposal([local, synced]), "public"), before = readFileSync(join(f.root, "log", `${machine}.jsonl`), "utf8");
  expect(() => f.accept(id)).toThrow("synced source placement");
  expect(readFileSync(join(f.root, "log", `${machine}.jsonl`), "utf8")).toBe(before);
  expect(before).not.toContain(body.text); expect(f.store.get(local, f.project)?.text).toBe(body.text);
});
test("a policy tightened between individual source verdicts refuses before effects", () => {
  const f = fixture(), a = f.note("first source", { task: "private-association" }), b = f.note("second source"), id = f.candidates.put(f.proposal([a, b]), "public");
  let version = "old", calls = 0;
  const before = f.store.list({ project: f.project, includeSuperseded: true });
  expect(() => f.candidates.accept(id, { project: f.project, actor: "person", verdict: "public", store: f.store, policyVersion: () => version,
    policy: (_candidate, target) => { if (++calls === 2) version = "new"; return version === "old" || target?.task !== "private-association"; },
  })).toThrow("policy changed");
  expect(f.store.list({ project: f.project, includeSuperseded: true })).toEqual(before); expect(f.candidates.get(id, f.project)?.status).toBe("pending");
});
test("an acceptance context cannot change authority during source screening", () => {
  const f = fixture(), a = f.note("source A"), b = f.note("source B"), id = f.candidates.put(f.proposal([a, b]), "public"), before = f.store.list({ project: f.project });
  const context: CandidateAcceptance = { project: f.project, actor: "person", verdict: "public", store: f.store, policyVersion: () => "fixed", policy: () => { context.actor = "agent"; return true; } };
  expect(() => f.candidates.accept(id, context)).toThrow("context changed"); expect(f.store.list({ project: f.project })).toEqual(before); expect(f.candidates.get(id, f.project)?.status).toBe("pending");
});
test("a policy changed during the final placement proof refuses before the accepting receipt or append", () => {
  const f = fixture(), a = f.note("source A"), b = f.note("source B"), id = f.candidates.put(f.proposal([a, b]), "public"), before = f.store.list({ project: f.project });
  let version = "old", finalPhase = false;
  const accepted = f.store.withAcceptedNote.bind(f.store), placements = f.store.entryPlacements.bind(f.store);
  f.store.withAcceptedNote = (note, work) => accepted(note, append => { finalPhase = true; return work(append); });
  f.store.entryPlacements = (...args) => { const result = placements(...args); if (finalPhase) version = "new"; return result; };
  expect(() => f.candidates.accept(id, { project: f.project, actor: "person", verdict: "public", store: f.store, policy: () => true, policyVersion: () => version })).toThrow("policy changed");
  expect(f.store.list({ project: f.project })).toEqual(before); expect(f.candidates.get(id, f.project)?.status).toBe("pending");
});
for (const mode of ["generation", "shards"] as const) test(`verified placement survives ${mode} migration without reclassifying a local long original`, async () => {
  const root = mkdtempSync(join(tmpdir(), `amem-consolidation-${mode}-`)), project = "project";
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const initial = new MemoryStore({ memoryDir: root, deferPromotions: true });
  const synced = initial.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "public writer contract", about: [] }), machine = initial.machine.id;
  initial.close();
  const body = { schema: MEMORY_SCHEMA, op: "note", at: new Date().toISOString(), machine, project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "local-only long contract", about: [] } as const;
  const local = entryId(body); appendFileSync(join(root, "local", `${machine}.jsonl`), JSON.stringify({ ...body, id: local }) + "\n");
  if (mode === "generation") await migrate({ memoryDir: root, generation: "b".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  else await migrateShards({ memoryDir: root, mode: "apply", authorizedPerson: true, tty: true });
  const store = mode === "shards" ? openShardStore({ memoryDir: root, project, deferPromotions: true }) : new MemoryStore({ memoryDir: root, deferPromotions: true });
  try { const placements = store.entryPlacements([synced, local], project); expect(placements.get(synced)).toBe("synced"); expect(placements.get(local)).toBe("local"); }
  finally { store.close(); }
});
test("generation placement refuses a fresh oversized segment before any unbounded refresh reads it", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-placement-budget-")), project = "project"; cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const initial = new MemoryStore({ memoryDir: root, deferPromotions: true }), id = initial.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "public writer contract", about: [] }); initial.close();
  await migrate({ memoryDir: root, generation: "c".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  const store = new MemoryStore({ memoryDir: root, deferPromotions: true });
  try {
    mkdirSync(join(store.profile.dir, "log"), { recursive: true }); const fd = openSync(join(store.profile.dir, "log", "z-large.jsonl"), "w"); try { ftruncateSync(fd, 33 * 1024 * 1024); } finally { closeSync(fd); }
    const read = SegmentReader.prototype.read; let bytes = 0;
    SegmentReader.prototype.read = function(this: SegmentReader, ...args: Parameters<SegmentReader["read"]>) { const before = this.metrics().bytesRead; try { return read.apply(this, args); } finally { bytes += this.metrics().bytesRead - before; } };
    try { expect(() => store.entryPlacements([id], project)).toThrow("read byte budget"); expect(bytes).toBeLessThanOrEqual(32 * 1024 * 1024); }
    finally { SegmentReader.prototype.read = read; }
  } finally { store.close(); }
});
