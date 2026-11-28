import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { CandidateStore, candidateInputId, candidateTargetRevision } from "../src/memory/candidates.ts";
import { consolidationClusters } from "../src/memory/consolidation-clusters.ts";
import { MemoryStore, type NoteInput } from "../src/memory/store.ts";
import type { StandalonePolicyOptions } from "../src/memory/policy.ts";
import { realPath } from "../src/memory/platform.ts";
import { topicOf } from "../src/memory/topic.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-topic-"))), base = join(root, "memory"), project = "fixture-project";
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true, screen: () => "promote" }); cleanup.push(() => store.close());
  const sidecar = new CandidateStore({ memoryDir: base }); cleanup.push(() => sidecar.close());
  const note = (extra: Partial<NoteInput> = {}) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person",
    text: "deploy target is staging-a", about: ["topic:deploy/target"], ...extra } as NoteInput);
  const open = (policy?: StandalonePolicyOptions) => { const mcp = createMemoryMcp({ cwd: root, base, project, ...(policy ? { policy } : {}) }); cleanup.push(() => mcp.close()); return mcp; };
  const accept = (id: string) => sidecar.accept(id, { project, actor: "person", verdict: "public", store, policy: () => true });
  return { project, store, sidecar, note, open, accept };
}
const idOf = (result: unknown) => (result as { id: string }).id;
const live = (f: ReturnType<typeof fixture>) => f.store.list({ project: f.project }).filter(view => topicOf(view) === "deploy/target");

test("#580 AC1/AC2: one live note on the topic routes a correction bound to its revision; accepting leaves one live note and keeps history", async () => {
  const f = fixture(), old = f.note(), mcp = f.open();
  const id = idOf(await mcp.tools.amem_remember({ text: "deploy target is staging-b", kind: "decision", topic: "deploy/target" }));
  const candidate = f.sidecar.get(id, f.project)!;
  expect(candidate.input).toMatchObject({ kind: "correction", topic: "deploy/target", target: { id: old, revision: candidateTargetRevision(f.store.get(old, f.project)!) }, noteKind: "decision" });
  expect(f.store.get(old, f.project)?.supersededBy).toBeNull();
  const { noteId } = f.accept(id);
  expect(live(f).map(view => view.id)).toEqual([noteId]);
  expect(f.store.get(old, f.project)?.supersededBy).toBe(noteId);
  expect(f.store.list({ project: f.project, includeSuperseded: true }).find(view => view.id === old)?.text).toBe("deploy target is staging-a");
});

test("#580: a target that changes after the proposal is refused at accept", async () => {
  const f = fixture(), old = f.note(), mcp = f.open();
  const id = idOf(await mcp.tools.amem_remember({ text: "deploy target is staging-b", topic: "deploy/target" }));
  f.store.supersede(old, f.note({ text: "someone else changed it" }), "person", f.project);
  expect(() => f.accept(id)).toThrow("stale");
});

test("#580 AC3: two live notes on one topic are listed and nothing is superseded on accept", async () => {
  const f = fixture(), a = f.note(), b = f.note({ text: "deploy target is staging-c" }), mcp = f.open();
  const id = idOf(await mcp.tools.amem_remember({ text: "deploy target is staging-d", topic: "deploy/target" }));
  const input = f.sidecar.get(id, f.project)!.input;
  expect(input.kind).toBe("memory");
  expect(input.kind === "memory" ? input.topicMatches?.map(target => target.id).sort() : []).toEqual([a, b].sort());
  const { noteId } = f.accept(id);
  expect(live(f).map(view => view.id).sort()).toEqual([a, b, noteId].sort());
  expect(f.store.get(a, f.project)?.supersededBy).toBeNull(); expect(f.store.get(b, f.project)?.supersededBy).toBeNull();
  // Consolidation surfaces the shared topic for review only.
  const clusters = consolidationClusters(f.store.list({ project: f.project }), f.project, Date.now()).clusters;
  expect(clusters.some(cluster => cluster.reason.includes("topic deploy/target"))).toBe(true);
  expect(f.store.get(a, f.project)?.supersededBy).toBeNull();
});

test("#580: zero matches gives an ordinary candidate whose accepted note carries the topic", async () => {
  const f = fixture(), mcp = f.open();
  const id = idOf(await mcp.tools.amem_remember({ text: "release cadence is weekly", topic: "release/cadence" }));
  expect(f.sidecar.get(id, f.project)?.input).toEqual({ project: f.project, kind: "memory", text: "release cadence is weekly", noteKind: "finding", topic: "release/cadence" });
  const { noteId } = f.accept(id);
  expect(f.store.get(noteId, f.project)?.about).toContain("topic:release/cadence");
  const shown = await mcp.tools.amem_show({ id: noteId }) as { topic?: string };
  expect(shown.topic).toBe("release/cadence");
  const found = await mcp.tools.amem_search({ query: "release cadence", includeCapture: false }) as { hits: { view?: { topic?: string } }[] };
  expect(found.hits[0]?.view?.topic).toBe("release/cadence");
});

test("#580 AC4: an invalid topic names the allowed form; no topic behaves as before", async () => {
  const f = fixture(), mcp = f.open(); f.note();
  for (const topic of ["Deploy", "-x", "a".repeat(65), "a b", 7]) await expect(mcp.tools.amem_remember({ text: "x y z", topic })).rejects.toThrow("[a-z0-9][a-z0-9/-]{0,63}");
  await expect(mcp.tools.amem_remember({ ...{ kind: "fail", approach: "a", symptom: "b", cause: "c", evidenceRefs: ["d"], retryWhen: "e" }, topic: "deploy/target" })).rejects.toThrow();
  const plain = idOf(await mcp.tools.amem_remember({ text: "deploy target is staging-b" }));
  expect(f.sidecar.get(plain, f.project)?.input).toEqual({ project: f.project, kind: "memory", text: "deploy target is staging-b", noteKind: "finding" });
});

test("#580: the topic is part of canonical identity, and other projects' or refused notes never match", async () => {
  const base = { project: "p", kind: "memory" as const, text: "same text" };
  expect(candidateInputId({ ...base, topic: "a" })).not.toBe(candidateInputId({ ...base, topic: "b" }));
  expect(candidateInputId({ ...base, topic: "a" })).not.toBe(candidateInputId(base));
  const f = fixture(); f.note({ project: "other-project", scope: "shared" }); f.note({ text: "deploy target is SECRET-ZZZ" });
  const mcp = f.open({ piiPatterns: ["SECRET-ZZZ"] });
  const id = idOf(await mcp.tools.amem_remember({ text: "deploy target is staging-b", topic: "deploy/target" }));
  expect(f.sidecar.get(id, f.project)?.input.kind).toBe("memory");
  expect(JSON.stringify(f.sidecar.get(id, f.project)?.input)).not.toContain("topicMatches");
});

test("#580: the advertised topic schema stays bounded", () => {
  const remember = MCP_TOOLS.find(tool => tool.name === "amem_remember")!;
  expect((remember.inputSchema as { properties: Record<string, { maxLength?: number }> }).properties.topic?.maxLength).toBe(64);
});
