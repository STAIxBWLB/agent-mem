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
import { MemoryStore } from "../src/memory/store.ts";

// agent-mem#27, option 1: after `amem alias add <old> <canonical>`, the CLI and MCP project filter for curated rows covers the canonical key AND every key aliased
// to it, so the old key's private notes, goals, candidates, vault candidates and work lists appear under the canonical project. The library MemoryStore keeps reading
// by the raw key. Both profiles: shared-v1 (one index) and curated shards (one shard per key).
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

export async function fixture(sharded: boolean, opts: { alias?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amem-alias-reconcile-")), base = join(root, "memory"), previous = process.env.AMEM_HOME;
  process.env.AMEM_HOME = base;
  cleanup.push(() => { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; rmSync(root, { recursive: true, force: true }); });
  expect(memoryGitSync(["init", "--quiet", root], { encoding: "utf8" }).status).toBe(0);
  const raw = memoryProjectKey(root), canonical = "github.com/fixture/canonical";
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
  const oldNote = store.note({ op: "note", project: raw, scope: "project", tier: "long", kind: "contract", text: "PRIVATE old-key contract about durable witnesses", peer: "person", source: "person", about: [] });
  const canonicalNote = store.note({ op: "note", project: canonical, scope: "project", tier: "long", kind: "contract", text: "canonical-key contract about append boundaries", peer: "person", source: "person", about: [] });
  store.goal({ project: raw, scope: "project", title: "OLD-KEY goal", milestones: ["one"], dependsOn: [], actor: "person" });
  store.close();
  if (opts.alias !== false) appendAlias(base, { alias: raw, key: canonical, actor: "person", machine: "fixture" });
  if (sharded) await migrateShards({ memoryDir: base, mode: "apply", authorizedPerson: true, tty: true });
  const context = { cwd: root, env: {}, stdinTTY: true };
  const cli = async (...args: string[]) => runCli(args, context);
  const mcp = () => createMemoryMcp({ cwd: root, base });
  return { root, base, raw, canonical, oldNote, canonicalNote, context, cli, mcp };
}
const ids = (text: string): string[] => (JSON.parse(text) as { id: string }[]).map(row => row.id).sort();

for (const sharded of [false, true]) {
  const profile = sharded ? "curated shards" : "shared-v1";

  test(`CLI list, show and goal list under the canonical key include the aliased old key's private rows in ${profile}`, async () => {
    const f = await fixture(sharded);
    const listed = ids(await f.cli("list", "--json"));
    expect(listed).toContain(f.oldNote);                                                       // the old key's private note appears under the canonical project
    expect(listed).toContain(f.canonicalNote);
    expect(await f.cli("show", f.oldNote)).toContain("PRIVATE old-key contract");              // and can be shown by id
    const goals = JSON.parse(await f.cli("goal", "list", "--json")) as { title: string }[];
    expect(goals.map(goal => goal.title)).toContain("OLD-KEY goal");
    const header = JSON.parse(await f.cli("list", "--json")) as { project: string }[];
    expect(new Set(header.map(row => row.project))).toEqual(new Set([f.canonical]));            // rows are presented under the canonical project, not the old key
  });

  test(`MCP search, show and the vault candidate list under the canonical key include the old key's durable rows in ${profile}`, async () => {
    const f = await fixture(sharded);
    const mcp = f.mcp();
    try {
      const found = await mcp.tools.amem_search({ query: "durable witnesses" }) as { hits: { view?: { id: string; project: string } }[] };
      const hit = found.hits.find(h => h.view?.id === f.oldNote);
      expect(hit, "the old key's note must be found through the canonical project").toBeDefined();
      expect(hit!.view!.project).toBe(f.canonical);
      const shown = await mcp.tools.amem_show({ id: f.oldNote }) as { text?: string };
      expect(JSON.stringify(shown)).toContain("PRIVATE old-key contract");
    } finally { mcp.close(); }
    const vault = JSON.parse(await f.cli("vault-candidates", "--json")) as { id: string; project: string }[];
    expect(vault.map(row => row.id)).toContain(f.oldNote);
    expect(vault.every(row => row.project === f.canonical)).toBe(true);
  });

  test(`forgetting an aliased old-key note through the CLI lands in the shard that holds it and survives a rebuild in ${profile}`, async () => {
    const f = await fixture(sharded);
    await f.cli("forget", f.oldNote);
    expect(ids(await f.cli("list", "--json"))).toEqual([f.canonicalNote]);
    await f.cli("rebuild");
    expect(ids(await f.cli("list", "--json"))).toEqual([f.canonicalNote]);
    await f.cli("alias", "remove", f.raw);                                                      // under its own key again, the row is still forgotten
    expect(ids(await f.cli("list", "--json"))).toEqual([]);
  });

  test(`candidates stored under the old key are listed, accepted and rejected under the canonical key in ${profile}`, async () => {
    const f = await fixture(sharded);
    const sidecar = new CandidateStore({ memoryDir: f.base });
    let oldCandidate: string, canonicalCandidate: string;
    try {
      oldCandidate = sidecar.put({ project: f.raw, kind: "memory", text: "Candidate saved under the old key", noteKind: "finding" }, "public");
      canonicalCandidate = sidecar.put({ project: f.canonical, kind: "memory", text: "Candidate saved under the canonical key", noteKind: "finding" }, "public");
    } finally { sidecar.close(); }
    const listed = ids(await f.cli("review", "list", "--kind", "memory", "--json"));
    expect(listed).toEqual([oldCandidate!, canonicalCandidate!].sort());
    expect(JSON.parse(await f.cli("review", "reject", oldCandidate!, "--json"))).toEqual({ candidateId: oldCandidate!, status: "rejected" });
    const after = new CandidateStore({ memoryDir: f.base });
    try { expect(after.get(oldCandidate!, f.raw)?.status).toBe("rejected"); } finally { after.close(); }
  });

  test(`work lists written under the old key are read under the canonical key by MCP in ${profile}`, async () => {
    const f = await fixture(sharded, { alias: false });
    const before = f.mcp();
    // written while the project still resolved to the raw key
    try { await before.tools.amem_work_state_write({ list: "plan", fields: { goal: "old-key work" } }); } finally { before.close(); }
    appendAlias(f.base, { alias: f.raw, key: f.canonical, actor: "person", machine: "fixture" });
    const mcp = f.mcp();
    try {
      const read = await mcp.tools.amem_work_state_read({}) as { lists: { list: string; fields: Record<string, unknown> }[] };
      expect(JSON.stringify(read)).toContain("old-key work");
    } finally { mcp.close(); }
  });
}

test("a note stays on its own key in the library: MemoryStore raw-key reads are unchanged by an alias (#27)", async () => {
  const f = await fixture(false);
  const store = new MemoryStore({ memoryDir: f.base, deferPromotions: true });
  try {
    expect(store.list({ project: f.raw }).map(view => view.id)).toContain(f.oldNote);
    expect(store.list({ project: f.canonical }).map(view => view.id)).not.toContain(f.oldNote);   // the library never widens by itself
    expect(store.list({ project: f.raw }).every(view => view.project !== f.canonical || view.scope === "shared")).toBe(true);
  } finally { store.close(); }
});
