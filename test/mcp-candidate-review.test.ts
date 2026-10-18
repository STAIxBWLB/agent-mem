import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { migrate } from "../src/memory/migrate.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
type Mode = "generation" | "shards";
async function fixture(mode: Mode) {
  const root = mkdtempSync(join(tmpdir(), "amem-mcp-candidate-review-")), base = join(root, "memory"), previous = process.env.AMEM_HOME;
  process.env.AMEM_HOME = base;
  cleanup.push(() => { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; rmSync(root, { recursive: true, force: true }); });
  const project = memoryProjectKey(root), initial = new MemoryStore({ home: root, deferPromotions: true });
  initial.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", text: "original authority", peer: "person", source: "person", about: [] }); initial.close();
  if (mode === "generation") await migrate({ memoryDir: base, generation: "c".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  else await migrateShards({ memoryDir: base, mode: "apply", authorizedPerson: true, tty: true });
  const open = () => mode === "generation" ? new MemoryStore({ memoryDir: base, deferPromotions: true }) : openShardStore({ memoryDir: base, project, deferPromotions: true });
  return { root, base, project, open, context: { cwd: root, env: {}, stdinTTY: true } };
}
function logBytes(base: string) {
  return Object.fromEntries(readdirSync(base, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map(entry => { const file = join(entry.parentPath, entry.name); return [file.slice(base.length), readFileSync(file, "utf8")]; }));
}
function legacyBytes(base: string) {
  return Object.fromEntries(Object.entries(logBytes(base)).filter(([file]) => /^\/(log|local)\//.test(file)));
}

for (const mode of ["generation", "shards"] as const) {
  test(`MCP remember person acceptance writes the selected ${mode} profile and replays once`, async () => {
    const f = await fixture(mode), mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
    let id: string;
    try {
      const result = await mcp.tools.amem_remember({ text: "A reusable transaction boundary", title: "Boundary", kind: "finding" }) as { id: string };
      id = result.id;
      expect(await mcp.tools.amem_search({ query: "reusable" })).toMatchObject({ hits: [] });
    } finally { mcp.close(); }
    const beforeLegacy = legacyBytes(f.base);
    const result = JSON.parse(await runCli(["review", "accept", id!, "--policy-free", "--json"], f.context)) as { noteId: string; candidateId: string; alreadyAccepted: boolean };
    expect(result).toMatchObject({ candidateId: id!, alreadyAccepted: false });
    expect(legacyBytes(f.base)).toEqual(beforeLegacy);
    const store = f.open();
    try {
      expect(store.profile.kind).toBe("generation");
      expect(store.get(result.noteId, f.project)).toMatchObject({ project: f.project, kind: "finding", title: "Boundary", source: "person", peer: "person", tier: "long" });
      expect(store.get(result.noteId, f.project)?.text).toContain("A reusable transaction boundary");
      const before = store.dump(); store.rebuild(); expect(store.dump()).toBe(before);
    } finally { store.close(); }
    const authored = logBytes(f.base);
    expect(JSON.parse(await runCli(["review", "accept", id!, "--policy-free", "--json"], f.context)))
      .toEqual({ ...result, alreadyAccepted: true });
    expect(logBytes(f.base)).toEqual(authored);
    const candidates = new CandidateStore({ memoryDir: f.base });
    try { expect(candidates.get(id!, f.project)).toMatchObject({ status: "accepted", acceptedNoteId: result.noteId }); } finally { candidates.close(); }
  });

  test(`current standalone PII policy refuses a previously public candidate in ${mode} without authoring a note`, async () => {
    const f = await fixture(mode), candidates = new CandidateStore({ memoryDir: f.base });
    const id = candidates.put({ project: f.project, kind: "memory", text: "Contact fixture.person@example.com for the reusable choice", noteKind: "finding" }, "public");
    candidates.close();
    const before = logBytes(f.base);
    await expect(runCli(["review", "accept", id, "--policy-free", "--json"], f.context)).rejects.toThrow("current standalone privacy policy");
    expect(logBytes(f.base)).toEqual(before);
    const pending = new CandidateStore({ memoryDir: f.base });
    try { expect(pending.get(id, f.project)).toMatchObject({ status: "pending", acceptedNoteId: null }); } finally { pending.close(); }
    const store = f.open();
    try { expect(store.list({ project: f.project }).map(note => note.text)).toEqual(["original authority"]); } finally { store.close(); }
  });

  test(`person review cannot accept another project's memory candidate in ${mode}`, async () => {
    const f = await fixture(mode), candidates = new CandidateStore({ memoryDir: f.base });
    const id = candidates.put({ project: "other-project", kind: "memory", text: "Another project's retained choice", noteKind: "decision" }, "public");
    candidates.close();
    const before = logBytes(f.base);
    await expect(runCli(["review", "accept", id, "--policy-free", "--json"], f.context)).rejects.toThrow("candidate unavailable");
    expect(logBytes(f.base)).toEqual(before);
    const pending = new CandidateStore({ memoryDir: f.base });
    try { expect(pending.get(id, "other-project")).toMatchObject({ status: "pending", acceptedNoteId: null }); } finally { pending.close(); }
  });
}
