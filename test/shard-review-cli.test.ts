import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON_ONLY, runCli } from "../src/cli.ts";
import { parseCommand } from "../src/commands-table.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { migrate } from "../src/memory/migrate.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { shardDir } from "../src/memory/shard.ts";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "amem-shard-review-cli-")), memory = join(dir, "memory"), previous = process.env.AMEM_HOME;
  process.env.AMEM_HOME = memory;
  cleanup.push(() => { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; rmSync(dir, { recursive: true, force: true }); });
  const project = memoryProjectKey(dir), store = new MemoryStore({ home: dir });
  store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "project retained", about: [] }); store.close();
  return { dir, memory, project, context: { cwd: dir, env: {}, stdinTTY: true }, split: () => migrateShards({ memoryDir: memory, mode: "apply", authorizedPerson: true, tty: true }) };
}
function bytes(dir: string) {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const file = join(entry.parentPath, entry.name); return [file.slice(dir.length), readFileSync(file).toString("base64")];
  }));
}

for (const mode of ["apply", "dry-run", "resume", "deactivate"] as const) test(`#15 ordinary generation migration ${mode} refuses every split state before effects`, async () => {
  const f = fixture(); await f.split();
  for (const marker of [readFileSync(join(f.memory, "shards.json"), "utf8"), "{\"phase\":\"captured\"}\n", "{broken"]) {
    writeFileSync(join(f.memory, "shards.json"), marker);
    const before = bytes(f.memory);
    await expect(migrate({ memoryDir: f.memory, mode, authorizedPerson: true, tty: true })).rejects.toThrow("migrate --shards --resume");
    expect(bytes(f.memory)).toEqual(before);
  }
});

test("#15 CLI routes explicit shard modes and resumes while refusing ordinary generation selection", async () => {
  const f = fixture();
  expect(JSON.parse(await runCli(["migrate", "--shards", "--dry-run", "--json"], f.context)).mode).toBe("dry-run");
  expect(JSON.parse(await runCli(["migrate", "--shards", "--json"], f.context)).active).toBe(true);
  for (const args of [["migrate"], ["migrate", "--dry-run"], ["migrate", "--deactivate"]]) {
    const before = bytes(f.memory);
    await expect(runCli(args, f.context)).rejects.toThrow("migrate --shards --resume");
    expect(bytes(f.memory)).toEqual(before);
  }
  expect(JSON.parse(await runCli(["migrate", "--resume", "--json"], f.context)).alreadyActive).toBe(true);
  expect(JSON.parse(await runCli(["migrate", "--shards", "--resume", "--json"], f.context)).alreadyActive).toBe(true);
});

test("#40 split-home person acceptance writes the bound shard and preserves legacy logs", async () => {
  const f = fixture(), candidates = new CandidateStore({ home: f.dir });
  const id = candidates.put({ project: f.project, kind: "fail", approach: "fixture", symptom: "fixture", cause: "retained candidate", evidenceRefs: ["test:shards"], retryWhen: "shard-aware review is available" }, "public"); candidates.close();
  await f.split();
  const before = bytes(f.memory);
  const receipt = JSON.parse(await runCli(["review", "accept", id, "--policy-free", "--json"], f.context)) as { noteId: string };
  for (const [file, value] of Object.entries(before).filter(([name]) => /^\/(log|local)\//.test(name))) expect(bytes(f.memory)[file]).toBe(value);
  const store = openShardStore({ memoryDir: f.memory, project: f.project, deferPromotions: true });
  try { expect(store.get(receipt.noteId, f.project)).toMatchObject({ project: f.project, kind: "fail", tier: "long", source: "person" }); } finally { store.close(); }
  const after = new CandidateStore({ home: f.dir });
  try { expect(after.get(id, f.project)?.status).toBe("accepted"); } finally { after.close(); }
});

test("#15 prune --user is explicit, current-project authorized, and preserves the default project-only port", async () => {
  const f = fixture(); await f.split();
  const start = Date.now() - 10_000, user = openShardStore({ home: f.dir, user: true, now: () => start, deferPromotions: true });
  const id = user.note({ op: "note", project: "another-project", scope: "shared", tier: "short", kind: "finding", peer: "person", source: "person", text: "explicitly expired shared note", about: [], expires: new Date(start + 1000).toISOString() }); user.close();
  const cutoff = new Date(start + 2000).toISOString();
  expect(parseCommand(["prune", "--user", "--cutoff", cutoff, "--dry-run"]).options["--user"]).toBe(true);
  const ordinary = JSON.parse(await runCli(["prune", "--cutoff", cutoff, "--dry-run", "--json"], f.context));
  expect(ordinary.counts.selected).toBe(0);
  const plan = JSON.parse(await runCli(["prune", "--user", "--cutoff", cutoff, "--dry-run", "--json"], f.context));
  expect(plan.project).toBe(f.project); expect(plan.counts.selected).toBe(1);
  expect(plan.rows.flatMap((row: any) => row.payload.targets.map((target: any) => target.id))).toEqual([id]);
  const file = join(f.dir, "user-prune-plan.json"); writeFileSync(file, JSON.stringify(plan));
  const applied = JSON.parse(await runCli(["prune", "--user", "--apply", "--plan", file, "--json"], f.context));
  expect(applied.completed).toHaveLength(1);
  const check = openShardStore({ home: f.dir, user: true });
  try { expect(check.prunePort().snapshot().pruned).toContain(id); } finally { check.close(); }
});

test("#15 user prune keeps person and TTY guards before any plan or store access", async () => {
  const f = fixture(), args = ["prune", "--user", "--apply", "--plan", "/not-readable"];
  const before = bytes(f.memory);
  for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) await expect(runCli(args, { ...f.context, env: { [key]: "" } })).rejects.toThrow(PERSON_ONLY);
  await expect(runCli(args, { ...f.context, stdinTTY: false })).rejects.toThrow("terminal on stdin");
  expect(bytes(f.memory)).toEqual(before);
});

test("#15 machine label updates the shared home identity and survives reopening a project shard", async () => {
  const f = fixture(); await f.split();
  const local = join(shardDir(f.memory, f.project), "machine.json"), before = readFileSync(local, "utf8");
  const result = JSON.parse(await runCli(["machine", "--label", "reviewed laptop", "--json"], f.context));
  expect(JSON.parse(readFileSync(join(f.memory, "machine.json"), "utf8"))).toEqual(result);
  expect(readFileSync(local, "utf8")).toBe(before);
  expect(JSON.parse(await runCli(["machine", "--json"], f.context))).toEqual(result);
  expect(existsSync(join(f.memory, "profile.lock"))).toBe(false);
});
