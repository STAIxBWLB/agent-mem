import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createMemoryMcp, type MemoryMcp } from "../src/mcp-memory.ts";
import { MCP_TOOLS, serveMcp } from "../src/mcp.ts";
import { CandidateStore, candidateTargetRevision } from "../src/memory/candidates.ts";
import { MemoryStore, type NoteInput } from "../src/memory/store.ts";
import type { StandalonePolicyOptions } from "../src/memory/policy.ts";
import { realPath } from "../src/memory/platform.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const fail = { kind: "fail", approach: "use a single transaction", symptom: "the second writer waits", cause: "a long held writer lease", evidenceRefs: ["test:writer-lease", "path:src/writer.ts"], retryWhen: "the bounded contention regression passes" };
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-candidate-tools-"))), base = join(root, "memory"), project = "fixture-project";
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true, screen: () => "promote" }); cleanup.push(() => store.close());
  const sidecar = new CandidateStore({ memoryDir: base }); cleanup.push(() => sidecar.close());
  const note = (extra: Partial<NoteInput> = {}) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "the original public boundary", about: ["path:src/writer.ts"], ...extra });
  const open = (policy?: StandalonePolicyOptions) => { const mcp = createMemoryMcp({ cwd: root, base, project, ...(policy ? { policy } : {}) }); cleanup.push(() => mcp.close()); return mcp; };
  const bytes = () => readdirSync(base, { recursive: true, withFileTypes: true }).filter(file => file.isFile() && file.name.endsWith(".jsonl")).map(file => { const full = join(file.parentPath, file.name); return [full, readFileSync(full, "utf8")]; }).sort((a, b) => a[0]!.localeCompare(b[0]!));
  return { root, base, project, store, sidecar, note, open, bytes };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
const idOf = (result: unknown) => (result as { id: string }).id;

test("structured fail proposals are pending machine-local candidates and never author curated rows", async () => {
  const f = fixture(); f.note(); const mcp = f.open(), before = f.bytes();
  const id = idOf(await mcp.tools.amem_remember(fail));
  expect(f.sidecar.path).toBe(join(f.base, "candidates.db"));
  expect(f.sidecar.get(id, f.project)).toMatchObject({ status: "pending", acceptedNoteId: null, input: { project: f.project, ...fail } });
  expect(f.bytes()).toEqual(before); expect(f.store.list({ project: f.project })).toHaveLength(1);
  expect(await mcp.tools.amem_search({ query: "single transaction", includeCapture: false })).toMatchObject({ hits: [] });
});
test("legacy remember defaults and explicit memory kinds remain compatible", async () => {
  const f = fixture(), mcp = f.open();
  const fallback = idOf(await mcp.tools.amem_remember({ text: "legacy public choice" }));
  expect(f.sidecar.get(fallback, f.project)?.input).toEqual({ project: f.project, kind: "memory", text: "legacy public choice", noteKind: "finding" });
  for (const kind of ["decision", "finding", "contract", "fail"] as const) {
    const id = idOf(await mcp.tools.amem_remember({ text: "public explicit choice", title: "Choice", kind }));
    expect(f.sidecar.get(id, f.project)?.input).toEqual({ project: f.project, kind: "memory", text: "public explicit choice", title: "Choice", noteKind: kind });
  }
});
test("malformed structured fails and model-selected authority/scope refuse without pending candidates", async () => {
  const f = fixture(), mcp = f.open(), before = f.bytes();
  for (const args of [
    { ...fail, cause: undefined }, { ...fail, evidenceRefs: [] }, { ...fail, evidenceRefs: Array(17).fill("test:x") }, { ...fail, evidenceRefs: ["x".repeat(401)] }, { ...fail, evidenceRefs: [1] },
    { ...fail, kind: "decision" }, { ...fail, text: "do not silently ignore" }, { ...fail, title: "do not silently ignore" }, { ...fail, project: "other" }, { ...fail, status: "accepted" },
  ]) await expect(mcp.tools.amem_remember(args)).rejects.toThrow();
  expect(f.sidecar.list({ project: f.project, status: "all" })).toEqual([]); expect(f.bytes()).toEqual(before);
});
test("correction binds an exact current public target revision without writing a note or supersession", async () => {
  const f = fixture(), target = f.note(), mcp = f.open(), before = f.bytes();
  const id = idOf(await mcp.tools.amem_correct({ id: `mem:${target}`, proposedText: "use the bounded writer lease", reason: "the regression establishes the corrected boundary", kind: "contract" }));
  expect(f.sidecar.get(id, f.project)).toMatchObject({ status: "pending", acceptedNoteId: null, input: { project: f.project, kind: "correction", target: { id: target, revision: candidateTargetRevision(f.store.get(target, f.project)!) }, proposedText: "use the bounded writer lease", noteKind: "contract" } });
  expect(f.sidecar.get(id, f.project)?.input).not.toHaveProperty("targetView"); expect(f.store.get(target, f.project)?.supersededBy).toBeNull(); expect(f.bytes()).toEqual(before);
});
test("correction rejects foreign local, superseded, missing or ambiguous-prefix targets and injected revisions", async () => {
  const f = fixture(), target = f.note(), foreign = f.note({ project: "other-project" }), old = f.note({ text: "old contract" }), replacement = f.note({ text: "replacement contract" }); f.store.supersede(old, replacement, "person", f.project);
  let screens = 0; const mcp = f.open({ host: { screen: async () => { screens++; return true; } } }), before = f.bytes();
  for (const id of [foreign, old, "f".repeat(32), target.slice(0, 8), `repo:${target}`, `capture:${target}`]) await expect(mcp.tools.amem_correct({ id, proposedText: "public correction", reason: "public evidence" })).rejects.toThrow();
  await expect(mcp.tools.amem_correct({ id: target, proposedText: "public correction", reason: "public evidence", revision: "a".repeat(64) })).rejects.toThrow();
  expect(screens).toBe(0); expect(f.sidecar.list({ project: f.project })).toEqual([]); expect(f.bytes()).toEqual(before);
});
test("foreign shared-source correction refuses generically like show and search without candidate or curated writes", async () => {
  const f = fixture(), shared = f.note({ project: "source-project", scope: "shared", text: "foreignsharedpublicneedle" }), mcp = f.open(), before = f.bytes();
  expect(await mcp.tools.amem_show({ id: shared })).toBeNull();
  expect(await mcp.tools.amem_search({ query: "foreignsharedpublicneedle", includeCapture: false })).toMatchObject({ hits: [] });
  for (const id of [shared, "f".repeat(32)]) await expect(mcp.tools.amem_correct({ id, proposedText: "public replacement", reason: "public evidence" })).rejects.toThrow("memory operation unavailable");
  expect(f.sidecar.list({ project: f.project, status: "all" })).toEqual([]); expect(f.bytes()).toEqual(before);
});
test("correction proposal bounds the exact persisted body including headers and reason at 4000 characters", async () => {
  const f = fixture(), target = f.note(), mcp = f.open(), before = f.bytes(), reason = "documented public evidence", revision = candidateTargetRevision(f.store.get(target, f.project)!);
  const headers = `Accepted candidate: ${"0".repeat(64)}\nTarget revision: ${"0".repeat(64)}\nTarget entry: ${target}\n\n`;
  const available = 4000 - headers.length - `\n\nReason: ${reason}`.length;
  const proposedText = "public boundary ".repeat(300).slice(0, available);
  const tooLong = { id: target, proposedText: proposedText + "x", reason };
  expect(tooLong.proposedText.length).toBeLessThan(4000); expect(reason.length).toBeLessThan(4000);
  await expect(mcp.tools.amem_correct(tooLong)).rejects.toThrow("memory operation unavailable");
  expect(f.sidecar.list({ project: f.project })).toEqual([]); expect(f.bytes()).toEqual(before);
  const id = idOf(await mcp.tools.amem_correct({ id: target, proposedText, reason })); expect(f.bytes()).toEqual(before);
  expect(() => f.sidecar.accept(id, { project: f.project, actor: "agent", verdict: "public", store: f.store, policy: () => true })).toThrow("person");
  const accepted = f.sidecar.accept(id, { project: f.project, actor: "person", verdict: "public", store: f.store, policy: () => true });
  const note = f.store.get(accepted.noteId, f.project)!; expect(note.text.length).toBe(4000); expect(note.text).toBe(`Accepted candidate: ${id}\nTarget revision: ${revision}\nTarget entry: ${target}\n\n${proposedText}\n\nReason: ${reason}`);
});
test("structured fail acceptance stays person-only in the existing core", async () => {
  const f = fixture(), mcp = f.open(), id = idOf(await mcp.tools.amem_remember(fail)), before = f.bytes();
  expect(() => f.sidecar.accept(id, { project: f.project, actor: "agent", verdict: "public", store: f.store, policy: () => true })).toThrow("person"); expect(f.bytes()).toEqual(before);
  const accepted = f.sidecar.accept(id, { project: f.project, actor: "person", verdict: "public", store: f.store, policy: () => true });
  const note = f.store.get(accepted.noteId, f.project)!; expect(note).toMatchObject({ kind: "fail", project: f.project, peer: "person", source: "person" }); expect(note.text).toContain("Approach: " + fail.approach); expect(note.text).toContain("Retry when: " + fail.retryWhen);
});
test("current standalone/host privacy and complete correction target metadata are enforced", async () => {
  const f = fixture(), hidden = f.note({ about: ["path:private/contract.ts"] }), mcp = f.open({ denyPaths: ["private/"], host: { screen: async value => !JSON.stringify(value).includes("HOST_DENIED") } });
  for (const args of [{ ...fail, cause: "Contact fixture.person@example.com" }, { ...fail, cause: "HOST_DENIED" }]) await expect(mcp.tools.amem_remember(args)).rejects.toThrow();
  await expect(mcp.tools.amem_correct({ id: hidden, proposedText: "public replacement", reason: "public reason" })).rejects.toThrow();
  expect(f.sidecar.list({ project: f.project })).toEqual([]);
});
test("host tightening during an awaited complete correction screen refuses without exposing targetView in storage", async () => {
  const f = fixture(), target = f.note(), entered = deferred(), release = deferred(); let permitted = true, observed: Record<string, any> | undefined;
  const mcp = f.open({ host: { screen: async value => { observed = value as Record<string, any>; entered.resolve(); await release.promise; return permitted; } } }), before = f.bytes();
  const proposal = mcp.tools.amem_correct({ id: target, proposedText: "public replacement", reason: "public reason" });
  await entered.promise; permitted = false; release.resolve(); await expect(proposal).rejects.toThrow();
  expect(observed).toMatchObject({ project: f.project, kind: "correction", targetView: { id: target, text: "the original public boundary" } }); expect(f.sidecar.list({ project: f.project })).toEqual([]); expect(f.bytes()).toEqual(before);
});
test("configured policy tightening while a host screen awaits is re-read before put", async () => {
  for (const correction of [false, true]) {
    const f = fixture(), target = f.note(), mcp = f.open({ host: { screen: async () => { await Promise.resolve(); writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["LATE_POLICY"] })); return true; } } }), before = f.bytes();
    const result = correction ? mcp.tools.amem_correct({ id: target, proposedText: "LATE_POLICY", reason: "public reason" }) : mcp.tools.amem_remember({ ...fail, cause: "LATE_POLICY" });
    await expect(result).rejects.toThrow(); expect(f.sidecar.list({ project: f.project })).toEqual([]); expect(f.bytes()).toEqual(before);
  }
});
test("target revision drift across await and before person acceptance never authors a stale correction", async () => {
  const f = fixture(), target = f.note(); let mutated: ReturnType<typeof f.bytes> = [];
  const mcp = f.open({ host: { screen: async () => { await Promise.resolve(); f.store.demote(target, "person", f.project); mutated = f.bytes(); return true; } } });
  await expect(mcp.tools.amem_correct({ id: target, proposedText: "public replacement", reason: "public evidence" })).rejects.toThrow(); expect(f.sidecar.list({ project: f.project })).toEqual([]); expect(f.bytes()).toEqual(mutated);
  const fresh = f.open(), id = idOf(await fresh.tools.amem_correct({ id: target, proposedText: "another correction", reason: "public evidence" }));
  const replacement = f.note({ text: "a newer public boundary" }); f.store.supersede(target, replacement, "person", f.project); const beforeAccept = f.bytes();
  expect(() => f.sidecar.accept(id, { project: f.project, actor: "person", verdict: "public", store: f.store, policy: () => true })).toThrow("stale"); expect(f.bytes()).toEqual(beforeAccept); expect(f.sidecar.get(id, f.project)?.status).toBe("pending");
});
test("closing a bound MCP server during privacy await refuses the pending candidate", async () => {
  const f = fixture(); let mcp: MemoryMcp;
  mcp = f.open({ host: { screen: async () => { await Promise.resolve(); mcp.close(); return true; } } }); const before = f.bytes();
  await expect(mcp.tools.amem_remember(fail)).rejects.toThrow(); expect(f.sidecar.list({ project: f.project })).toEqual([]); expect(f.bytes()).toEqual(before);
});
test("stdio exposes eleven project-bound tools and validates structured evidence arrays before handler effects", async () => {
  const f = fixture(), mcp = f.open(), input = new PassThrough(), output = new PassThrough(); let encoded = "";
  output.on("data", chunk => { encoded += chunk.toString(); });
  const request = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  const run = serveMcp({ input, output, tools: mcp.tools });
  input.end(request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } }) + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" + request(2, "tools/list", {})
    + request(3, "tools/call", { name: "amem_remember", arguments: { ...fail, evidenceRefs: [1] } }) + request(4, "tools/call", { name: "amem_remember", arguments: { ...fail, evidenceRefs: Array(17).fill("test:x") } })
    + request(5, "tools/call", { name: "amem_remember", arguments: fail }));
  await run;
  const replies = encoded.trim().split("\n").map(line => JSON.parse(line)); expect(replies.find(row => row.id === 2).result.tools).toHaveLength(11);
  expect(replies.find(row => row.id === 2).result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["amem_brief", "amem_capacity", "amem_correct", "amem_graph", "amem_remember", "amem_search", "amem_show", "amem_timeline", "amem_vault_candidates", "amem_work_state_read", "amem_work_state_write"]); expect(MCP_TOOLS.find(tool => tool.name === "amem_correct")?.annotations.readOnlyHint).toBe(false);
  for (const id of [3, 4]) expect(replies.find(row => row.id === id).error.code).toBe(-32602);
  expect(JSON.parse(replies.find(row => row.id === 5).result.content[0].text).id).toMatch(/^[a-f0-9]{64}$/); expect(f.sidecar.list({ project: f.project })).toHaveLength(1);
});
