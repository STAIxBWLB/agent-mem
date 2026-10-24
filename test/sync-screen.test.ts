import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { CONFIG_FILE, repoConfigPath } from "../src/memory/config.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { syncMemory } from "../src/memory/sync.ts";

// agent-mem#40 F4, review of #416: sync screens the rows it would actually publish, under the repository-narrowed policy too.
const WORD = "zebra-project-codename";
const privately = { visibility: async () => "private" as const };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function temp() { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-sync-screen-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function git(dir: string, ...args: string[]) { const r = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" }); if (r.status !== 0) throw new Error(`fixture Git failed: ${r.stderr}`); return r.stdout.trim(); }
function bare() { const dir = temp(); git(dir, "init", "-q", "--bare"); return dir; }
const refs = (dir: string) => git(dir, "for-each-ref", "--format=%(refname)", "refs/heads/");
const note = (project: string, text: string): NoteInput => ({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "fixture", source: "person", text, about: [] });

test("a migrated home's legacy note is screened before the first shard publication: the configured pattern refuses it and nothing reaches the remote", async () => {
  const project = "example.test/team/alpha", url = bare(), home = temp();
  const legacy = new MemoryStore({ home, profile: "shared-v1", deferPromotions: true });
  const bad = legacy.note(note(project, `a finding about ${WORD}`)), good = legacy.note(note(project, "an ordinary finding"));
  const memory = legacy.dir; legacy.close();
  expect(await migrateShards({ memoryDir: memory, generation: "1".repeat(32), mode: "apply", authorizedPerson: true, tty: true })).toMatchObject({ active: true });
  writeFileSync(join(memory, CONFIG_FILE), JSON.stringify({ piiPatterns: [WORD] }));
  const store = openShardStore({ home, project, deferPromotions: true }); cleanup.push(() => store.close());
  const refused = await syncMemory(store, { remote: url, ...privately });
  expect(refused.ok).toBe(false);
  expect(refused.error).toContain(bad.slice(0, 8)); expect(refused.error).not.toContain(good.slice(0, 8)); expect(refused.error).not.toContain(WORD);
  expect(refs(url)).toBe("");                                                          // no shard ref was published
  writeFileSync(join(memory, CONFIG_FILE), JSON.stringify({}));
  expect(await syncMemory(store, { remote: url, ...privately })).toMatchObject({ ok: true });   // the same rows sync once the pattern is gone
  expect(refs(url)).not.toBe("");
});

test("amem sync applies the repository's narrowing to an existing long-term note, with or without --policy-free", async () => {
  const root = temp(), memory = join(root, "memory"), cwd = join(root, "repo"), url = bare();
  mkdirSync(memory, { recursive: true }); mkdirSync(join(cwd, ".git"), { recursive: true });
  const project = memoryProjectKey(cwd);
  const store = new MemoryStore({ memoryDir: memory, screen: () => "keep" });
  const id = store.note(note(project, `a long-term note about ${WORD}`)); store.close();
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = memory;                // runCli resolves the home from process.env
  cleanup.push(() => { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; });
  const person = { cwd, env: {}, stdinTTY: true };
  // Machine config is silent about the word; only the repository's .amem/config names it.
  mkdirSync(join(cwd, ".amem"), { recursive: true }); writeFileSync(repoConfigPath(cwd), JSON.stringify({ piiPatterns: [WORD] }));
  for (const args of [["sync", "--remote", url], ["sync", "--policy-free", "--remote", url]]) {
    const message = await runCli(args, person).then(() => "synced", error => (error as Error).message);
    expect(message, args.join(" ")).toContain(id.slice(0, 8)); expect(message).not.toContain(WORD);
  }
  rmSync(repoConfigPath(cwd));                                                         // without the narrowing the same note syncs
  expect(await runCli(["sync", "--remote", url], person).then(() => "synced", error => (error as Error).message)).toContain("synced");
});

test("a store whose rows cannot be read refuses the sync with a result, never an exception", async () => {
  const { screenOutboundRows } = await import("../src/memory/sync-screen.ts");
  const broken = { prunePort() { throw new Error("durable prune requires an active generation handle"); } } as unknown as MemoryStore;
  expect(screenOutboundRows(broken, () => true)).toEqual({ ok: false, reason: expect.stringContaining("not screened") });
});
