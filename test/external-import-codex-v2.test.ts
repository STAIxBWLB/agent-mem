import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CandidateStore } from "../src/memory/candidates.ts";
import { importExternalMemory } from "../src/memory/external-import.ts";
import { runCli } from "../src/cli.ts";

// #177: Codex memories v1 (`$CODEX_HOME/memories`) and v2 (`$CODEX_HOME/memories_v2`, default since codex-rs 0.165.0).
const PROJECT = "fixture/project";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const allow = () => true;
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "amem-codex-v2-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function titles(base: string): string[] {
  const store = new CandidateStore({ memoryDir: base });
  try { return store.list({ project: PROJECT }).map(row => row.input.kind === "memory" ? row.input.title ?? "" : "").sort(); } finally { store.close(); }
}
/** The files codex-rs writes under one memory root (rust-v0.165.0 memories/write and ext/memories). */
function codexRoot(dir: string, tag: string): void {
  put(join(dir, "memory_summary.md"), `v1\n## User Profile\n${tag} profile\n## User preferences\n## General Tips\n## What's in Memory\n`);
  put(join(dir, "rollout_summaries", "2026-10-30-fix.md"), `${tag} rollout summary`);
  put(join(dir, "extensions", "ad_hoc", "notes", "remember.md"), `${tag} ad hoc note`);
}

test("v1 profile: output is unchanged and nothing is reported as checked", async () => {
  const root = temp(), codex = join(root, "codex-home"), base = join(root, "memory");
  codexRoot(join(codex, "memories"), "v1");
  put(join(codex, "memories", "MEMORY.md"), "v1 index");
  put(join(codex, "memories", "raw_memories.md"), "v1 raw");
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", env: { HOME: root, CODEX_HOME: codex }, policy: allow });
  expect(result).toMatchObject({ files: 5, added: 5 });
  expect(result).not.toHaveProperty("checked");
  expect(titles(base)).toEqual(["codex: MEMORY.md", "codex: extensions/ad_hoc/notes/remember.md", "codex: memory_summary.md", "codex: raw_memories.md", "codex: rollout_summaries/2026-10-30-fix.md"]);
});

test("v2 profile: memories_v2 Markdown is imported with a memories_v2/ title prefix", async () => {
  const root = temp(), codex = join(root, "codex-home"), base = join(root, "memory");
  codexRoot(join(codex, "memories_v2"), "v2");
  // The v2 state lives in SQLite beside the roots; it is never read.
  put(join(codex, "memories_v2_1.sqlite"), "not a memory root");
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", env: { HOME: root, CODEX_HOME: codex }, policy: allow });
  expect(result).toMatchObject({ files: 3, added: 3 });
  expect(result).not.toHaveProperty("checked");
  expect(titles(base)).toEqual(["codex: memories_v2/extensions/ad_hoc/notes/remember.md", "codex: memories_v2/memory_summary.md", "codex: memories_v2/rollout_summaries/2026-10-30-fix.md"]);
});

test("both layouts import side by side; a v2 symlink root or entry is refused", async () => {
  const root = temp(), codex = join(root, "codex-home"), base = join(root, "memory"), outside = join(root, "outside");
  codexRoot(join(codex, "memories"), "v1");
  codexRoot(join(codex, "memories_v2"), "v2");
  put(join(outside, "secret.md"), "outside the profile");
  symlinkSync(join(outside, "secret.md"), join(codex, "memories_v2", "linked.md"));
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", env: { HOME: root, CODEX_HOME: codex }, policy: allow });
  expect(result).toMatchObject({ files: 6, added: 6 });
  expect(result.skipped.rules).toBe(1);
  expect(titles(base).filter(t => t.includes("memories_v2/"))).toHaveLength(3);

  const linked = temp(), linkedHome = join(linked, "codex-home"), linkedBase = join(linked, "memory");
  codexRoot(join(linked, "real-v2"), "v2");
  mkdirSync(linkedHome, { recursive: true });
  symlinkSync(join(linked, "real-v2"), join(linkedHome, "memories_v2"));
  const refused = await importExternalMemory({ base: linkedBase, project: PROJECT, source: "codex", env: { HOME: linked, CODEX_HOME: linkedHome }, policy: allow });
  expect(refused.files).toBe(0);
});

test("explicit --from stays a single root and never adds memories_v2", async () => {
  const root = temp(), codex = join(root, "codex-home"), base = join(root, "memory");
  codexRoot(join(codex, "memories"), "v1");
  codexRoot(join(codex, "memories_v2"), "v2");
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: join(codex, "memories"), policy: allow });
  expect(result.files).toBe(3);
  expect(titles(base).some(t => t.includes("memories_v2"))).toBe(false);
});

test("empty profile: the receipt names both locations checked", async () => {
  const root = temp(), codex = join(root, "codex-home"), base = join(root, "memory"), repo = join(root, "repo");
  mkdirSync(codex, { recursive: true }); mkdirSync(repo);
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", env: { HOME: root, CODEX_HOME: codex }, policy: allow });
  expect(result).toMatchObject({ files: 0, added: 0, checked: [join(codex, "memories"), join(codex, "memories_v2")] });
  const text = await runCli(["import", "codex"], { cwd: repo, env: { HOME: root, CODEX_HOME: codex, AMEM_HOME: base }, stdinTTY: false, stdoutTTY: false });
  expect(text).toBe(`no codex memory found; checked ${join(codex, "memories")} and ${join(codex, "memories_v2")}`);
});
