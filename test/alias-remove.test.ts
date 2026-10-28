import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { memoryGitSync } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { aliasLogPath, aliasedKeys, appendAlias, appendUnalias, listAliases, resolveAlias } from "../src/memory/shard.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { scanCatalog } from "../src/memory/catalog.ts";
import { commandHelp } from "../src/commands-table.ts";
import { completionScript } from "../src/completion.ts";

// agent-mem#27, option 2: `amem alias remove <old>` is an append-only `unalias` op. The latest op for a key wins, nothing is rewritten, `old` resolves to itself again,
// and the op lives in the local `aliases.jsonl`, never in a shared-v1 segment, so an older reader skips it and keeps its own view.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home() {
  const root = mkdtempSync(join(tmpdir(), "amem-alias-remove-")), base = join(root, "memory"), previous = process.env.AMEM_HOME;
  process.env.AMEM_HOME = base;
  cleanup.push(() => { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; rmSync(root, { recursive: true, force: true }); });
  return { root, base };
}

test("an unalias op restores the raw key, the latest op wins, and nothing in the log is rewritten (#27 option 2)", () => {
  const { base } = home();
  appendAlias(base, { alias: "old/key", key: "canonical/key", actor: "person", machine: "m1" });
  expect(resolveAlias(base, "old/key")).toBe("canonical/key");
  expect(aliasedKeys(base, "canonical/key")).toEqual(["old/key"]);
  const before = readFileSync(aliasLogPath(base), "utf8");
  const op = appendUnalias(base, { alias: "old/key", actor: "person", machine: "m1" });
  expect(op).toMatchObject({ op: "unalias", alias: "old/key" });
  expect(resolveAlias(base, "old/key")).toBe("old/key");                                         // the old key resolves to itself again
  expect(aliasedKeys(base, "canonical/key")).toEqual([]);
  expect(readFileSync(aliasLogPath(base), "utf8").startsWith(before)).toBe(true);               // append only: the earlier line is byte for byte as it was
  // the latest op wins in both directions: alias again after the removal
  appendAlias(base, { alias: "old/key", key: "other/key", actor: "person", machine: "m1" });
  expect(resolveAlias(base, "old/key")).toBe("other/key"); expect(aliasedKeys(base, "other/key")).toEqual(["old/key"]);
  appendUnalias(base, { alias: "old/key", actor: "person", machine: "m1" });
  expect(resolveAlias(base, "old/key")).toBe("old/key");
});

test("removing an alias that is not in force is refused, and a target abandoned by the removal is free again (#27)", () => {
  const { base } = home();
  expect(() => appendUnalias(base, { alias: "never/aliased", actor: "person", machine: "m1" })).toThrow(/no alias to remove/);
  appendAlias(base, { alias: "a", key: "b", actor: "person", machine: "m1" });
  expect(() => appendAlias(base, { alias: "b", key: "c", actor: "person", machine: "m1" })).toThrow(/cannot become an alias/);   // b is a current target
  appendUnalias(base, { alias: "a", actor: "person", machine: "m1" });
  expect(() => appendUnalias(base, { alias: "a", actor: "person", machine: "m1" })).toThrow(/no alias to remove/);              // already removed
  appendAlias(base, { alias: "b", key: "c", actor: "person", machine: "m1" });                                                    // b is no longer a target
  expect(resolveAlias(base, "b")).toBe("c");
});

test("listAliases keeps the history and an older reader's view: the unalias line is a new op kind in aliases.jsonl only (#27, C1)", () => {
  const { base } = home();
  appendAlias(base, { alias: "x", key: "y", actor: "person", machine: "m1" });
  appendUnalias(base, { alias: "x", actor: "person", machine: "m1" });
  const lines = readFileSync(aliasLogPath(base), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(lines.map(line => line.op)).toEqual(["alias", "unalias"]);
  expect(lines[1]).toMatchObject({ schema: lines[0].schema, alias: "x", actor: "person" });
  // an older reader only understands `op: "alias"` lines and skips the rest, so it keeps resolving x -> y; this build reads the removal
  expect(lines.filter(line => line.op === "alias" && line.alias === "x")).toHaveLength(1);
  expect(listAliases(base).map(op => op.op)).toEqual(["alias", "unalias"]);                      // the full ordered history is listed
  // a malformed or unknown line is skipped, never fatal, and a stray unalias with no alias is inert
  writeFileSync(aliasLogPath(base), readFileSync(aliasLogPath(base), "utf8") + 'not json\n{"op":"surprise"}\n', { mode: 0o600 });
  expect(resolveAlias(base, "x")).toBe("x");
});

test("the catalog lists an alias only while it is in force (#27)", async () => {
  const { base } = home();
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
  store.note({ op: "note", project: "canonical/key", scope: "project", tier: "long", kind: "finding", text: "a canonical row", peer: "person", source: "person", about: [] });
  store.close();
  await migrateShards({ memoryDir: base, mode: "apply", authorizedPerson: true, tty: true });                 // the catalog walks shards: it needs the canonical key's shard
  appendAlias(base, { alias: "old/key", key: "canonical/key", actor: "person", machine: "m1" });
  expect(scanCatalog(base).find(p => p.key === "canonical/key")?.aliases ?? []).toEqual(["old/key"]);
  appendUnalias(base, { alias: "old/key", actor: "person", machine: "m1" });
  expect(scanCatalog(base).find(p => p.key === "canonical/key")?.aliases ?? []).toEqual([]);
});

async function cliFixture() {
  const { root, base } = home();
  expect(memoryGitSync(["init", "--quiet", root], { encoding: "utf8" }).status).toBe(0);
  const raw = memoryProjectKey(root), canonical = "github.com/fixture/canonical";
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
  const oldNote = store.note({ op: "note", project: raw, scope: "project", tier: "long", kind: "contract", text: "PRIVATE old-key contract about durable witnesses", peer: "person", source: "person", about: [] });
  const canonicalNote = store.note({ op: "note", project: canonical, scope: "project", tier: "long", kind: "contract", text: "canonical-key contract about append boundaries", peer: "person", source: "person", about: [] });
  store.close();
  return { root, base, raw, canonical, oldNote, canonicalNote, person: { cwd: root, env: {}, stdinTTY: true } };
}

test("amem alias remove works for a marked nonTTY CLI, records its actor and shows the old key's rows again (#27 option 2)", async () => {
  const f = await cliFixture();
  const listed = async () => (JSON.parse(await runCli(["list", "--json"], f.person)) as { id: string }[]).map(row => row.id);
  expect(await listed()).toEqual([f.oldNote]);                                                          // no alias yet: the checkout binds to its raw key
  await runCli(["alias", "add", f.raw, f.canonical], f.person);
  expect((await listed()).sort()).toEqual([f.oldNote, f.canonicalNote].sort());                         // aliased: the canonical project covers both keys
  const removed = JSON.parse(await runCli(["alias", "remove", f.raw, "--json"], { ...f.person, env: { CLAUDECODE: "1" }, stdinTTY: false }));
  expect(removed).toMatchObject({ op: "unalias", alias: f.raw, actor: "agent" });
  const log = readFileSync(aliasLogPath(f.base), "utf8"); expect(JSON.parse(log.trim().split("\n").at(-1)!)).toMatchObject({ op: "unalias", actor: "agent" });
  expect(resolveAlias(f.base, f.raw)).toBe(f.raw);
  // the key is restored: the checkout binds to its raw key again, so the canonical key's note is no longer part of its project
  expect(await listed()).toEqual([f.oldNote]);
  expect(await runCli(["alias", "add", f.raw, f.canonical], f.person)).toContain("->");                  // and it can be aliased again: the latest op wins
  expect((await listed()).sort()).toEqual([f.oldNote, f.canonicalNote].sort());
});

test("alias remove --json prints the appended op (#27)", async () => {
  const f = await cliFixture();
  await runCli(["alias", "add", f.raw, f.canonical], f.person);
  const op = JSON.parse(await runCli(["alias", "remove", f.raw, "--json"], f.person));
  expect(op).toMatchObject({ op: "unalias", alias: f.raw, actor: "person" });
});

test("alias remove names its usage and refuses what is not an alias (#27)", async () => {
  const f = await cliFixture();
  await expect(runCli(["alias", "remove"], f.person)).rejects.toThrow("usage: amem alias remove <alias-key>");
  await expect(runCli(["alias", "remove", "never/aliased"], f.person)).rejects.toThrow(/no alias to remove/);
  const listed = await runCli(["alias", "list"], f.person);
  expect(listed).toBe("no aliases recorded");
  await runCli(["alias", "add", f.raw, f.canonical], f.person);
  await runCli(["alias", "remove", f.raw], f.person);
  expect(await runCli(["alias", "list"], f.person)).toContain(`${f.raw} -> ${f.canonical}`);        // the history stays visible
  expect(await runCli(["alias", "list"], f.person)).toMatch(/removed/);
});

test("help and completion name `alias remove` (#27)", () => {
  expect(commandHelp()).toContain("alias remove");
  for (const shell of ["zsh", "bash", "fish"]) expect(completionScript(shell)).toContain("remove");
});

test("incremental indexing equals a rebuild after an alias and after its removal, in both profiles (#27)", async () => {
  for (const sharded of [false, true]) {
    const f = await cliFixture();
    if (sharded) await migrateShards({ memoryDir: f.base, mode: "apply", authorizedPerson: true, tty: true });
    const listing = async () => JSON.stringify((JSON.parse(await runCli(["list", "--json"], f.person)) as { id: string }[]).map(row => row.id).sort());
    await runCli(["alias", "add", f.raw, f.canonical], f.person);
    const aliased = await listing();
    expect(JSON.parse(aliased)).toHaveLength(2);
    await runCli(["rebuild"], f.person);                                                                  // a full rebuild of the derived index from the rows
    expect(await listing()).toBe(aliased);                                                                // shows exactly what the incremental index showed
    await runCli(["alias", "remove", f.raw], f.person);
    const removed = await listing();
    expect(JSON.parse(removed)).toEqual([f.oldNote]);
    await runCli(["rebuild"], f.person);
    expect(await listing()).toBe(removed);
    const mcp = createMemoryMcp({ cwd: f.root, base: f.base });
    try { expect(JSON.stringify(await mcp.tools.amem_search({ query: "durable witnesses" }))).toContain(f.oldNote); } finally { mcp.close(); }
  }
});
