import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { MemoryStore, type NoteInput } from "../src/memory/store.ts";
import type { EvidenceBundle } from "../src/memory/evidence.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-evidence-mcp-")), base = join(root, "memory"), project = "project";
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true }); cleanup.push(() => store.close());
  const note = (text: string, extra: Partial<NoteInput> = {}) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text, about: ["path:src/writer.ts"], ...extra });
  const open = (extra: Partial<Parameters<typeof createMemoryMcp>[0]> = {}) => { const mcp = createMemoryMcp({ cwd: root, base, project, ...extra }); cleanup.push(() => mcp.close()); return mcp; };
  return { root, base, project, store, note, open };
}
test("evidence cites only matching live curated entries, bounded over the complete JSON", async () => {
  const f = fixture(), id = f.note("bounded writer lease contract"), old = f.note("writer lease old contract"), current = f.note("writer lease replacement contract");
  f.store.supersede(old, current, "person", f.project);
  f.note("writer lease foreign", { project: "foreign", scope: "shared" }); f.note("writer lease model answer", { peer: "amem-model" });
  const mcp = f.open(), response = await mcp.tools.amem_evidence({ question: "writer lease", maxBytes: 1024 }) as EvidenceBundle;
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(1024);
  expect(response.entries.map(row => row.citation).sort()).toEqual([`mem:${id}`, `mem:${current}`].sort());
  expect(JSON.stringify(response)).not.toContain("foreign"); expect(JSON.stringify(response)).not.toContain("model answer");
  const candidates = new CandidateStore({ memoryDir: f.base }); try { expect(candidates.counters(f.project)).toEqual([]);
    mcp.onEmitted("amem_evidence", "request", response);
    expect(candidates.counters(f.project).map(row => row.key.entryId).sort()).toEqual([id, current].sort());
    for (const row of candidates.counters(f.project)) expect([row.rendered, row.delivered, row.cited]).toEqual([1, null, null]);
  } finally { candidates.close(); }
});
test("evidence screens the question and entries, and refuses policy drift without partial output", async () => {
  const f = fixture(); f.note("writer lease visible"); f.note("writer lease hidden wording");
  const mcp = f.open({ policy: { piiPatterns: ["hidden wording"] } });
  const response = await mcp.tools.amem_evidence({ question: "writer lease" }) as EvidenceBundle;
  expect(response.entries).toHaveLength(1); expect(response.entries[0]!.text).toContain("visible");
  await expect(mcp.tools.amem_evidence({ question: "hidden wording" })).rejects.toThrow("memory operation unavailable");
  let change = false;
  const drifting = f.open({ policy: { host: { screen: async () => { if (change) writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ denyPaths: ["src/writer.ts"] })); return true; } } } });
  change = true;
  await expect(drifting.tools.amem_evidence({ question: "writer lease" })).rejects.toThrow("memory operation unavailable");
});
test("evidence rejects scope/authority knobs and invalid limits, and PII does not start a query", async () => {
  const f = fixture(); f.note("writer lease visible"); const mcp = f.open();
  for (const args of [{ question: "writer", project: "foreign" }, { question: "writer", history: true }, { question: "writer", limit: 21 }, { question: "writer", maxBytes: 255 }]) await expect(mcp.tools.amem_evidence(args)).rejects.toThrow();
  let allowed = true, calls = 0;
  const privateSession = f.open({ allowed: () => allowed, policy: { host: { screen: async () => { calls++; return true; } } } });
  allowed = false;
  await expect(privateSession.tools.amem_evidence({ question: "writer" })).rejects.toThrow(); expect(calls).toBe(0);
});
