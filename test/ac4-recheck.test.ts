import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assertCopyHome, QUERIES, recheckMcp, recheckStore } from "../scripts/ac4-recheck.ts";
import { realPath } from "../src/memory/platform.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { appendAlias } from "../src/memory/aliases.ts";

const PROJECT = "github.com/staixbwlb/agent-hub";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A copied home (`<parent>/memory`) with a few curated notes that two frozen queries match. */
function copyHome(): string {
  const parent = realPath(mkdtempSync(join(tmpdir(), "amem-ac4-"))); roots.push(parent);
  const store = new MemoryStore({ home: parent, deferPromotions: true });
  try {
    for (const text of ["Decision: the seatbelt profile denies .git through HFS+ ignorable code points.", "Finding: macOS CI flaky timing tests need a longer budget.", "Decision: unrelated note."])
      store.note({ op: "note", project: PROJECT, scope: "project", tier: "long", kind: "decision", peer: "codex", source: "person", text, about: [] });
  } finally { store.close(); }
  return parent;
}
const env = (parent: string) => ({ AMEM_HOME: join(parent, "elsewhere-live"), HOME: parent });
const shape = (report: Awaited<ReturnType<typeof recheckStore>>) => report.queries.map(q => ({ n: q.n, query: q.query, hits: q.hits.map(h => h.title) }));

test("single-layout copy: corpus and hits as before", () => {
  const parent = copyHome(), report = recheckStore({ home: parent, project: PROJECT, limit: 10, env: env(parent) });
  expect(report.corpus).toBe(3); expect(report.queries).toHaveLength(QUERIES.length); expect(Object.keys(report)).toEqual(["project", "corpus", "engine", "queries"]);
  expect(report.queries[0]!.hits[0]!.title).toContain("seatbelt");
});

test("split copy: the project shard is read, non-zero corpus and the same hits", async () => {
  const parent = copyHome(), before = recheckStore({ home: parent, project: PROJECT, limit: 10, env: env(parent) });
  const { migrateShards } = await import("../src/memory/shard-migration.ts");
  await migrateShards({ memoryDir: join(parent, "memory"), mode: "apply", authorizedPerson: true, tty: true });
  expect(() => new MemoryStore({ home: parent })).toThrow(/curated split/);
  const after = recheckStore({ home: parent, project: PROJECT, limit: 10, env: env(parent) });
  expect(after.corpus).toBe(3);
  expect(shape(after)).toEqual(shape(before));
});

test("--mcp: the same per-query result shape through amem mcp amem_search on the copy", async () => {
  const parent = copyHome(), library = recheckStore({ home: parent, project: PROJECT, limit: 10, env: env(parent) });
  const cwd = join(parent, "checkout"); spawnSync("git", ["init", "-q", cwd]); spawnSync("git", ["-C", cwd, "remote", "add", "origin", `https://${PROJECT}`]);
  const mcp = await recheckMcp({ home: parent, project: PROJECT, limit: 10, cwd, env: env(parent) });
  expect(mcp.path).toBe("mcp"); expect(mcp.corpus).toBe(3); expect(mcp.queries).toHaveLength(QUERIES.length);
  for (const q of mcp.queries) { expect(Object.keys(q)).toEqual(["n", "query", "engine", "hits"]); for (const h of q.hits) expect(Object.keys(h)).toEqual(["source", "score", "title"]); }
  const curated = (r: typeof mcp) => r.queries.map(q => q.hits.filter(h => h.source === "curated").map(h => h.title)[0] ?? null);
  expect(curated(mcp)).toEqual(curated(library));
}, 30_000);

test("the live home is refused: the one AMEM_HOME names and the default one", () => {
  const parent = copyHome();
  expect(() => assertCopyHome(parent, { AMEM_HOME: join(parent, "memory"), HOME: parent })).toThrow(/refusing the live memory home/);
  expect(() => assertCopyHome(parent, { AGENTHUB_HOME: parent, HOME: parent })).toThrow(/refusing the live memory home/);
  expect(() => recheckStore({ home: parent, project: PROJECT, limit: 10, env: { AMEM_HOME: join(parent, "memory") } })).toThrow(/refusing the live memory home/);
  expect(() => assertCopyHome(join(parent, "missing"), env(parent))).toThrow(/no memory directory/);
  expect(assertCopyHome(parent, env(parent))).toBe(join(parent, "memory"));
});

test("a copy whose memory directory is a symlink to the live home is refused", () => {
  const live = copyHome(), parent = realPath(mkdtempSync(join(tmpdir(), "amem-ac4-link-"))); roots.push(parent);
  symlinkSync(join(live, "memory"), join(parent, "memory"));
  expect(() => assertCopyHome(parent, { AMEM_HOME: join(live, "memory"), HOME: parent })).toThrow(/refusing the live memory home/);
});

test("AMEM_HOME=A with a default home pointing to B refuses A, B and the original default directory", () => {
  const a = copyHome(), b = copyHome(), hub = copyHome();   // hub/memory is the default directory under AGENTHUB_HOME=hub
  writeFileSync(join(hub, "memory", "amem.config.json"), JSON.stringify({ home: join(b, "memory") }));
  const live = { AMEM_HOME: join(a, "memory"), AGENTHUB_HOME: hub, HOME: hub };
  for (const parent of [a, b, hub]) expect(() => assertCopyHome(parent, live)).toThrow(/refusing the live memory home/);
  const copy = copyHome(); expect(assertCopyHome(copy, live)).toBe(join(copy, "memory"));
});

test("a note under an old key aliased to --project counts in the corpus and matches the hits, library and MCP alike", async () => {
  const parent = realPath(mkdtempSync(join(tmpdir(), "amem-ac4-alias-"))); roots.push(parent);
  const OLD = "github.com/staixbwlb/agent-hub-old";
  const store = new MemoryStore({ home: parent, deferPromotions: true });
  try { store.note({ op: "note", project: OLD, scope: "project", tier: "long", kind: "decision", peer: "codex", source: "person", text: "Decision: the seatbelt profile denies .git through HFS+ ignorable code points.", about: [] }); } finally { store.close(); }
  appendAlias(join(parent, "memory"), { alias: OLD, key: PROJECT, actor: "person", machine: "fixture" });
  const library = recheckStore({ home: parent, project: PROJECT, limit: 10, env: env(parent) });
  expect(library.corpus).toBe(1); expect(library.queries[0]!.hits[0]!.title).toContain("seatbelt");
  const cwd = join(parent, "checkout"); spawnSync("git", ["init", "-q", cwd]); spawnSync("git", ["-C", cwd, "remote", "add", "origin", `https://${PROJECT}`]);
  const mcp = await recheckMcp({ home: parent, project: PROJECT, limit: 10, cwd, env: env(parent) });
  expect(mcp.corpus).toBe(1); expect(mcp.queries[0]!.hits.some(h => h.source === "curated" && h.title.includes("seatbelt"))).toBe(true);
}, 30_000);
