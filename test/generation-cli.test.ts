import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, PERSON_ONLY } from "../src/cli.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { parseCommand, completionDefinitions } from "../src/commands-table.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "amem-gen-cli-")), memory = join(parent, "memory"), before = process.env.AMEM_HOME;
  cleanup.push(() => { if (before === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = before; rmSync(parent, { recursive: true, force: true }); });
  process.env.AMEM_HOME = memory;
  const now = Date.now() - 10000, store = new MemoryStore({ now: () => now });
  const project = memoryProjectKey(parent);
  const id = store.note({ op: "note", project, scope: "project", tier: "short", kind: "finding", peer: "person", text: "synthetic expired target", about: ["path:fixture.ts"], expires: new Date(now + 1000).toISOString(), source: "person" });
  store.close();
  const context = { cwd: parent, env: {}, stdinTTY: true };
  const command = (args: string[]) => runCli(args, context);
  return { parent, memory, id, context, command };
}
function bytes(path: string): Record<string, string> {
  return Object.fromEntries(readdirSync(path, { recursive: true, withFileTypes: true }).filter(d => d.isFile()).map(d => {
    const file = join(d.parentPath, d.name); return [file.slice(path.length), readFileSync(file).toString("base64")];
  }));
}

test("generation CLI authority and TTY refuse before migration or plan file access", async () => {
  const f = fixture(), before = bytes(f.memory);
  for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CODEX_THREAD_ID"]) {
    await expect(runCli(["migrate", "--dry-run"], { ...f.context, env: { [key]: "agent" } })).rejects.toThrow(PERSON_ONLY);
    await expect(runCli(["prune", "--apply", "--plan", "/missing-plan"], { ...f.context, env: { [key]: "agent" } })).rejects.toThrow(PERSON_ONLY);
  }
  for (const args of [["migrate", "--dry-run"], ["prune", "--cutoff", new Date().toISOString(), "--dry-run"]]) await expect(runCli(args, { ...f.context, stdinTTY: false })).rejects.toThrow("terminal");
  expect(bytes(f.memory)).toEqual(before);
});

test("generation CLI dry-run is readonly; migrate/prune apply/resume/deactivate select one profile", async () => {
  const f = fixture(), before = bytes(f.memory), g = "a".repeat(32);
  const dry = JSON.parse(await f.command(["migrate", "--dry-run"]));
  expect(dry.profile.kind).toBe("shared-v1"); expect(dry.counts.validRows).toBe(1); expect(bytes(f.memory)).toEqual(before);
  const migrated = JSON.parse(await f.command(["migrate", "--generation", g])); expect(migrated.profile.generation).toBe(g);
  const afterMigration = bytes(f.memory);
  const planText = await f.command(["prune", "--cutoff", new Date().toISOString(), "--dry-run"]);
  expect(JSON.parse(planText).counts.local).toBe(1); expect(JSON.parse(planText).counts.synced).toBe(0);
  // Prune planning may refresh only derived generation state, never legacy source or an authoritative log.
  for (const [file, value] of Object.entries(afterMigration).filter(([path]) => /^\/(log|local)\//.test(path))) expect(bytes(f.memory)[file]).toBe(value);
  const planFile = join(f.parent, "person plan.json"); writeFileSync(planFile, planText);
  const applied = JSON.parse(await f.command(["prune", "--apply", "--plan", planFile])); expect(applied.completed).toHaveLength(1);
  const gen = new MemoryStore(); try { expect(gen.get(f.id)).toBeUndefined(); } finally { gen.close(); }
  expect(JSON.parse(await f.command(["migrate", "--resume"])).profile.generation).toBe(g);
  const beforeReview = bytes(f.memory);
  expect(JSON.parse(await f.command(["review", "--json"]))).toEqual([]);
  for (const [file, value] of Object.entries(beforeReview).filter(([name]) => name.endsWith(".jsonl"))) expect(bytes(f.memory)[file]).toBe(value);
  const deactivated = JSON.parse(await f.command(["migrate", "--deactivate"])); expect(deactivated.profile.kind).toBe("shared-v1");
  expect(JSON.parse(await f.command(["migrate", "--generation", g])).profile.generation).toBe(g);
});

test("generation command definitions drive parser/help/completion and refuse ambiguous modes", async () => {
  const f = fixture();
  expect(parseCommand(["migrate", "--generation", "a".repeat(32)]).definition.mutates).toBe(true);
  const prune = completionDefinitions().find(row => row.path.join(" ") === "prune")!;
  expect(prune.options["--plan"]?.value).toBe("path");
  expect((await f.command(["--help"]))).toContain("migrate");
  await expect(f.command(["migrate", "--resume", "--deactivate"])).rejects.toThrow("mutually exclusive");
  await expect(f.command(["prune", "--dry-run", "--apply"])).rejects.toThrow("usage:");
  await expect(f.command(["prune", "--policy-free", "--dry-run"])).rejects.toThrow("unknown option");
});
