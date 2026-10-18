import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { memoryGitSync } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { appendAlias } from "../src/memory/shard.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(sharded: boolean) {
  const root = mkdtempSync(join(tmpdir(), "amem-mcp-cli-alias-")), base = join(root, "memory"), previous = process.env.AMEM_HOME;
  process.env.AMEM_HOME = base;
  cleanup.push(() => { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; rmSync(root, { recursive: true, force: true }); });
  expect(memoryGitSync(["init", "--quiet", root], { encoding: "utf8" }).status).toBe(0);
  const raw = memoryProjectKey(root), canonical = "github.com/fixture/canonical";
  expect(raw).not.toBe(canonical);
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
  const seed = store.note({ op: "note", project: canonical, scope: "project", tier: "long", kind: "contract", text: "Durable immutable transaction witnesses preserve identity", peer: "person", source: "person", about: [] });
  store.close();
  appendAlias(base, { alias: raw, key: canonical, actor: "person", machine: "fixture" });
  if (sharded) await migrateShards({ memoryDir: base, mode: "apply", authorizedPerson: true, tty: true });
  const context = { cwd: root, env: {}, stdinTTY: true };
  const remember = async (text: string) => {
    // No project override: exercise the same checkout identity binding as the real stdio entry point.
    const mcp = createMemoryMcp({ cwd: root, base });
    try { return (await mcp.tools.amem_remember({ text, kind: "finding" }) as { id: string }).id; }
    finally { mcp.close(); }
  };
  return { root, base, raw, canonical, seed, context, remember,
    open: () => sharded ? openShardStore({ memoryDir: base, project: canonical, deferPromotions: true }) : new MemoryStore({ memoryDir: base, deferPromotions: true }) };
}

for (const sharded of [false, true]) {
  const profile = sharded ? "curated shards" : "shared-v1";
  test(`person CLI lists, accepts and rejects canonical MCP candidates through a reviewed checkout alias in ${profile}`, async () => {
    const f = await fixture(sharded);
    const accepted = await f.remember("Reusable atomic append boundaries"), rejected = await f.remember("A candidate rejected by the person");
    const sidecar = new CandidateStore({ memoryDir: f.base });
    let rawOnly: string;
    try {
      expect(sidecar.get(accepted, f.canonical)?.input.project).toBe(f.canonical);
      expect(sidecar.get(accepted, f.raw)).toBeUndefined();
      rawOnly = sidecar.put({ project: f.raw, kind: "memory", text: "Old unmapped namespace must stay separate", noteKind: "finding" }, "public");
    } finally { sidecar.close(); }
    const listed = JSON.parse(await runCli(["review", "list", "--kind", "memory", "--json"], f.context)) as { id: string }[];
    expect(listed.map(row => row.id).sort()).toEqual([accepted, rejected].sort());
    expect(listed.map(row => row.id)).not.toContain(rawOnly!);
    const receipt = JSON.parse(await runCli(["review", "accept", accepted, "--kind", "memory", "--policy-free", "--json"], f.context)) as { candidateId: string; noteId: string; alreadyAccepted: boolean };
    expect(receipt).toMatchObject({ candidateId: accepted, alreadyAccepted: false });
    const store = f.open();
    try {
      expect(store.get(receipt.noteId, f.canonical)).toMatchObject({ project: f.canonical, kind: "finding" });
      expect(store.get(receipt.noteId, f.canonical)?.text).toContain("Reusable atomic append boundaries");
      expect(store.get(receipt.noteId, f.raw)).toBeUndefined();
    } finally { store.close(); }
    expect(JSON.parse(await runCli(["review", "reject", rejected, "--json"], f.context))).toEqual({ candidateId: rejected, status: "rejected" });
    const result = new CandidateStore({ memoryDir: f.base });
    try {
      expect(result.get(accepted, f.canonical)).toMatchObject({ status: "accepted", acceptedNoteId: receipt.noteId });
      expect(result.get(rejected, f.canonical)?.status).toBe("rejected");
      expect(result.get(rawOnly!, f.raw)?.status).toBe("pending");
    } finally { result.close(); }
  });

  test(`person CLI vault candidates select canonical durable notes through a reviewed checkout alias in ${profile}`, async () => {
    const f = await fixture(sharded);
    const selected = JSON.parse(await runCli(["vault-candidates", "--json"], f.context)) as { id: string; project: string }[];
    expect(selected.map(row => row.id)).toEqual([f.seed]);
    expect(selected.map(row => row.project)).toEqual([f.canonical]);
  });
}
