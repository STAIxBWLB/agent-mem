import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CandidateStore, candidateTargetRevision } from "../src/memory/candidates.ts";
import { candidateOverlaps, candidateOverlapsBatch } from "../src/memory/candidate-overlaps.ts";
import { overlapWords, wordOverlap } from "../src/memory/consolidation-clusters.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "../src/memory/policy.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";

const roots: string[] = [], close: (() => void)[] = [];
const oldHome = process.env.AMEM_HOME;
afterEach(() => {
  for (const fn of close.splice(0).reverse()) fn();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldHome;
});
const prose = "transaction leases protect atomic storage writes";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-overlaps-")); roots.push(root);
  const base = join(root, "memory"), project = memoryProjectKey(root);
  let now = Date.parse("2026-10-31T00:00:00.000Z");
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true, now: () => now }), sidecar = new CandidateStore({ memoryDir: base });
  close.push(() => store.close(), () => sidecar.close());
  const note = (text: string, options: { title?: string; project?: string; about?: string[]; peer?: string; scope?: "project" | "shared" } = {}) =>
    store.note({ op: "note", project: options.project ?? project, scope: options.scope ?? "project", tier: "long", kind: "finding", peer: options.peer ?? "person", source: "person", text, about: options.about ?? [], ...(options.title ? { title: options.title } : {}) });
  const put = (text = prose) => sidecar.get(sidecar.put({ project, kind: "memory", text }, "public"), project)!;
  const hints = (candidate = put(), policy: StandalonePolicyOptions = {}) => candidateOverlaps(candidate, store,
    { project, policy: () => createStandalonePolicy(policy), policyVersion: () => JSON.stringify({ denyPaths: policy.denyPaths, piiPatterns: policy.piiPatterns }) });
  return { root, base, project, store, sidecar, note, put, hints, advance: (ms: number) => { now += ms; } };
}

test("duplicate and related notes use consolidate's deterministic measure without deciding the candidate", async () => {
  const f = fixture(), exact = f.note(prose), relatedText = "transaction leases protect recovery checkpoints", related = f.note(relatedText), candidate = f.put();
  f.note("orchards require seasonal irrigation");
  const before = f.store.dump(), result = await f.hints(candidate);
  expect(result).toEqual([
    { id: exact, title: null, score: 1 },
    { id: related, title: null, score: wordOverlap(overlapWords({ title: null, text: prose }), overlapWords({ title: null, text: relatedText })) },
  ]);
  expect(result[1]!.score).toBeGreaterThan(0); expect(result[1]!.score).toBeLessThan(1);
  expect(f.store.dump()).toBe(before); expect(f.sidecar.get(candidate.id, f.project)).toEqual(candidate);
  f.sidecar.reject(candidate.id, { project: f.project, actor: "person", verdict: "public" });
  expect(await f.hints(f.sidecar.get(candidate.id, f.project)!)).toEqual([]);
});

test("superseded, expired, forgotten, foreign shared and screened notes reveal neither ids nor counts", async () => {
  const f = fixture(), safe = f.note(prose), old = f.note(prose, { title: "obsolete" }), replacement = f.note("orchards require seasonal irrigation");
  f.store.supersede(old, replacement, "person", f.project);
  const expired = f.note(prose, { title: "expired" }); f.store.demote(expired, "person", f.project, new Date(f.store.readNow() + 1000).toISOString());
  const forgotten = f.note(prose, { title: "forgotten" }); f.store.forget(forgotten, "person", f.project);
  const foreign = f.note(prose, { project: "different-project", scope: "shared" });
  const hidden = f.note(prose, { about: ["path:private/hidden.ts"] });
  f.advance(2000);
  const result = await f.hints(f.put(), { denyPaths: ["private/"] });
  expect(result).toEqual([{ id: safe, title: null, score: 1 }]);
  for (const id of [old, expired, forgotten, foreign, hidden]) expect(JSON.stringify(result)).not.toContain(id);
  expect(Object.keys(result[0]!)).toEqual(["id", "title", "score"]);
});

test("selection scans beyond a page, screens before the top-three limit and breaks ties by id", async () => {
  const f = fixture();
  for (let i = 0; i < 130; i++) f.note(prose, { title: `hidden-${i}`, about: ["path:private/hidden.ts"] });
  const visible = Array.from({ length: 4 }, (_, i) => f.note(prose, { title: `visible-${i}` }));
  expect(await f.hints(f.put(), { denyPaths: ["private/"] })).toEqual(visible.sort().slice(0, 3).map(id => ({ id, title: f.store.get(id, f.project)!.title, score: 1 })));
});

test("a candidate batch screens each live project note once, including repeated promotion targets", async () => {
  const f = fixture(), publicIds = Array.from({ length: 4 }, (_, i) => f.note(prose, { title: `visible-${i}` }));
  const hidden = f.note(prose, { peer: "host-only" }); f.note(prose, { project: "different-project", scope: "shared" });
  const candidates = Array.from({ length: 12 }, (_, i) => f.put(`${prose} candidate${i}`));
  const target = f.store.get(publicIds[0]!, f.project)!;
  for (const goalId of ["e".repeat(32), "f".repeat(32)]) candidates.push(f.sidecar.get(f.sidecar.put({ project: f.project, kind: "promotion",
    target: { id: target.id, revision: candidateTargetRevision(target) }, goalId }, "public"), f.project)!);
  const screens = new Map<string, number>(), policy = createStandalonePolicy({ host: { screen: async value => {
    const row = value as { id: string }; screens.set(row.id, (screens.get(row.id) ?? 0) + 1);
    return !JSON.stringify(value).includes("host-only");
  } } });
  const result = await candidateOverlapsBatch(candidates, f.store, { project: f.project, policy: () => policy, policyVersion: () => "stable" });
  expect([...screens.keys()].sort()).toEqual([...publicIds, hidden].sort());
  expect([...screens.values()]).toEqual(Array(5).fill(1));
  expect(result).toHaveLength(candidates.length);
  for (const hints of result) {
    expect(hints.map(row => row.id)).toEqual([...publicIds].sort().slice(0, 3));
    expect(JSON.stringify(hints)).not.toContain(hidden);
  }
});

for (const mutation of ["policy", "source"] as const) test(`a ${mutation} change during policy await refuses stale hints`, async () => {
  const f = fixture(), old = f.note(prose), replacement = f.note("orchards require seasonal irrigation"), candidate = f.put(); let revision = "before", changed = false;
  const policy = createStandalonePolicy({ host: { screen: async value => {
    if (!changed && (value as { id?: string }).id === old) {
      changed = true;
      if (mutation === "policy") revision = "after"; else f.store.supersede(old, replacement, "person", f.project);
    }
    return true;
  } } });
  await expect(candidateOverlaps(candidate, f.store, { project: f.project, policy: () => policy, policyVersion: () => revision })).rejects.toThrow();
  expect(f.sidecar.get(candidate.id, f.project)?.status).toBe("pending");
});

test("JSON listing adds only overlaps, and walk prints each hint before the unchanged prompt", async () => {
  const f = fixture(), exact = f.note(prose, { title: "Lease boundary" }), hidden = f.note(prose, { about: ["path:private/hidden.ts"] }), candidate = f.put();
  process.env.AMEM_HOME = f.base;
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ denyPaths: ["private/"] }));
  f.put(`${prose} related`);
  const context = { cwd: f.root, env: {}, stdinTTY: true }, original = f.sidecar.list({ project: f.project }), before = f.store.dump();
  const readPage = MemoryStore.prototype.readPage; let pages = 0, output: string;
  MemoryStore.prototype.readPage = function(this: MemoryStore, window) { if (window.project === f.project) pages++; return readPage.call(this, window); };
  try { output = await runCli(["review", "list", "--json"], context); } finally { MemoryStore.prototype.readPage = readPage; }
  const rows = JSON.parse(output);
  expect(rows).toHaveLength(2); expect(pages).toBe(2); // One nonempty page and its end, for both candidates together.
  expect(rows.find((row: { id: string }) => row.id === candidate.id).overlaps).toEqual([{ id: exact, title: "Lease boundary", score: 1 }]);
  expect(JSON.stringify(rows.map(({ overlaps, ...previous }: { overlaps: unknown }) => previous), null, 2)).toBe(JSON.stringify(original, null, 2));
  expect(output).not.toContain(hidden); expect(f.store.dump()).toBe(before);
  const lines: string[] = [];
  const result = await runCli(["review", "walk"], { ...context, write: line => { lines.push(line); }, prompt: question => {
    expect(question).toBe("[a]ccept [e]dit [r]eject [s]kip [q]uit: ");
    expect(lines.filter(line => line.includes("overlap mem:"))).toEqual([`  overlap mem:${exact} (1.000): Lease boundary`]);
    return "q";
  } });
  expect(result).toBe("accepted 0, edited 0, rejected 0, skipped 0, failed 0");
  expect(f.sidecar.get(candidate.id, f.project)?.status).toBe("pending"); expect(f.store.dump()).toBe(before);
});

test("remember adds only public overlap ids after full-row host screening and still writes only a candidate", async () => {
  const f = fixture(), safe = f.note(prose), hidden = f.note(prose, { peer: "host-only" }), foreign = f.note(prose, { project: "different-project", scope: "shared" });
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, policy: { host: { screen: async value => !JSON.stringify(value).includes("host-only") } } }); close.push(mcp.close);
  const before = f.store.dump(), result = await mcp.tools.amem_remember({ text: prose }) as { id: string; overlaps: string[] };
  expect(result.overlaps).toEqual([safe]); expect(Object.keys(result)).toEqual(["id", "overlaps"]);
  for (const id of [hidden, foreign]) expect(JSON.stringify(result)).not.toContain(id);
  expect(f.sidecar.get(result.id, f.project)?.status).toBe("pending"); expect(f.store.dump()).toBe(before);
});

test("JSON list retains the whole-command home binding fence across its shared pass", async () => {
  const f = fixture(); f.note(prose); const candidate = f.put(), before = f.store.dump();
  process.env.AMEM_HOME = f.base;
  const other = join(f.root, "other-memory"); mkdirSync(other);
  const readPage = MemoryStore.prototype.readPage; let changed = false;
  MemoryStore.prototype.readPage = function(this: MemoryStore, window) {
    const page = readPage.call(this, window);
    if (!changed && window.project === f.project && page.rows.length) { changed = true; process.env.AMEM_HOME = other; }
    return page;
  };
  try { await expect(runCli(["review", "list", "--json"], { cwd: f.root, env: {} })).rejects.toThrow("binding changed"); }
  finally { MemoryStore.prototype.readPage = readPage; process.env.AMEM_HOME = f.base; }
  expect(changed).toBe(true); expect(f.store.dump()).toBe(before); expect(f.sidecar.get(candidate.id, f.project)?.status).toBe("pending");
});

test("remember never appends when policy tightens while overlap notes are screened", async () => {
  const f = fixture(), safe = f.note(prose);
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, policy: { host: { screen: async value => {
    if ((value as { id?: string }).id === safe) writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ denyPaths: ["public/"] }));
    return true;
  } } } }); close.push(mcp.close);
  await expect(mcp.tools.amem_remember({ text: prose })).rejects.toThrow();
  expect(f.sidecar.list({ project: f.project })).toEqual([]);
});
