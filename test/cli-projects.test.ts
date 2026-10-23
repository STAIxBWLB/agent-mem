import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON_ONLY, runCli } from "../src/cli.ts";
import { CaptureStore, captureShardStats, writeCaptureConfig } from "../src/memory/capture.ts";
import { appendAlias, shardMachineDir } from "../src/memory/shard.ts";
import { lifecyclePath, listLifecycle, projectState } from "../src/memory/lifecycle.ts";
import { MemoryStore, machineId } from "../src/memory/store.ts";
import { readCaptureConfigFile } from "../src/memory/capture.ts";
import { ensureShardDescriptor } from "../src/memory/shard.ts";

// #15 T5 through the real `runCli` entry: authority (an agent marker and a non-terminal stdin are refused for every mutation), previews before effects,
// one project at a time, and the all-projects replies that say they crossed.
const cleanup: (() => void)[] = [];
afterEach(() => { delete process.env.AMEM_HOME; for (const close of cleanup.splice(0).reverse()) close(); });
const A = "github.com/o/a", B = "github.com/o/b", C = "github.com/o/c";
function rig(): { dir: string; base: string; person: { cwd: string; env: Record<string, string>; stdinTTY: boolean } } {
  const dir = mkdtempSync(join(tmpdir(), "amem-cli-projects-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, "memory");
  process.env.AMEM_HOME = base;
  return { dir, base, person: { cwd: dir, env: {}, stdinTTY: true } };
}
function capture(dir: string, project: string, rows: string[]): void {
  const store = new CaptureStore({ home: dir, project });
  rows.forEach((excerpt, i) => store.append({ project, agent: "kimi", event: "PostToolUse", excerpt, at: `2026-10-1${i}T00:00:00.000Z` }));
  store.close();
}
function note(dir: string, project: string, text: string): void {
  ensureShardDescriptor(join(dir, "memory"), project);
  const store = new MemoryStore({ home: dir, deferPromotions: true });
  try { store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "codex", source: "person", text, about: [] }); } finally { store.close(); }
}
const json = async (argv: string[], ctx: Parameters<typeof runCli>[1]) => JSON.parse(await runCli(argv, ctx));

test("projects lists every shard with its state and sizes, as text and as JSON, and a read needs no terminal", async () => {
  const { dir, person } = rig();
  capture(dir, A, ["alpha"]); capture(dir, B, ["beta one", "beta two"]);
  const rows = await json(["projects", "--json"], { ...person, stdinTTY: false });
  expect(rows.map((r: { key: string }) => r.key)).toEqual([A, B]);
  expect(rows[1]).toMatchObject({ state: "active", captureRows: 2 });
  const text = await runCli(["projects"], person);
  expect(text).toContain(A); expect(text).toContain(B); expect(text).toContain("active");
});

test("projects hides forgotten ones by default and --all shows them with their state", async () => {
  const { dir, person } = rig();
  capture(dir, A, ["alpha"]); capture(dir, B, ["beta"]);
  await runCli(["project", "archive", B], person);
  const preview = await runCli(["project", "forget", A], person);
  expect(preview).toMatch(/preview|--confirm/);
  await runCli(["project", "forget", A, "--confirm"], person);
  const visible = await json(["projects", "--json"], person);
  expect(visible.map((r: { key: string }) => r.key)).toEqual([B]);
  const all = await json(["projects", "--all", "--json"], person);
  expect(all.map((r: { key: string; state: string }) => [r.key, r.state])).toEqual([[A, "forgotten"], [B, "archived"]]);
});

test("usage totals the shards and names the largest, as text and JSON", async () => {
  const { dir, person } = rig();
  capture(dir, A, ["alpha"]); capture(dir, B, ["beta one", "beta two", "beta three"]);
  const report = await json(["usage", "--json", "--limit", "1"], person);
  expect(report.totals).toMatchObject({ shards: 2, captureRows: 4 });
  expect(report.largest.map((p: { key: string }) => p.key)).toEqual([B]);
  expect(await runCli(["usage"], person)).toContain("2 project shard(s)");
  await expect(runCli(["usage", "--limit", "0"], person)).rejects.toThrow(/1 to 100/);
});

test("every mutation is refused for an agent marker and a non-terminal stdin, with nothing written", async () => {
  const { dir, base, person } = rig();
  capture(dir, A, ["alpha"]);
  const mutations = [["gc", "--confirm"], ["project", "archive", A], ["project", "unarchive", A], ["project", "forget", A, "--confirm"], ["capacity", "apply", "--split", "--confirm"]];
  for (const argv of mutations) {
    await expect(runCli(argv, { ...person, env: { CODEX_THREAD_ID: "x" } })).rejects.toThrow(PERSON_ONLY);
    await expect(runCli(argv, { ...person, stdinTTY: false })).rejects.toThrow("terminal on stdin");
  }
  expect(existsSync(lifecyclePath(base))).toBe(false);
  expect(captureShardStats(shardMachineDir(base, A, machineId(base).id)).rows).toBe(1);
});

test("gc and forget preview first: without --confirm nothing is evicted or recorded, and a non-terminal stdin is fine for the preview of gc", async () => {
  const { dir, base, person } = rig();
  capture(dir, A, ["old row", "newer row"]);
  writeCaptureConfig(shardMachineDir(base, A, machineId(base).id), { retentionDays: 1 });
  const preview = await json(["gc", "--json"], { ...person, stdinTTY: false });
  expect(preview.dryRun).toBe(true);
  expect(preview.shards[0]).toMatchObject({ key: A, expired: 2 });
  expect(captureShardStats(shardMachineDir(base, A, machineId(base).id)).rows).toBe(2);
  const applied = await json(["gc", "--confirm", "--json"], person);
  expect(applied.dryRun).toBe(false);
  expect(captureShardStats(shardMachineDir(base, A, machineId(base).id)).rows).toBe(0);
  // forget preview records nothing
  const text = await runCli(["project", "forget", A], person);
  expect(text).toContain(A); expect(existsSync(lifecyclePath(base))).toBe(false);
  expect(await runCli(["project", "forget", A, "--confirm"], person)).toContain("forgot");
  expect(projectState(base, A)).toBe("forgotten");
});

test("archive, unarchive and forget act on the one named project, resolve an alias to it, and say which project", async () => {
  const { dir, base, person } = rig();
  capture(dir, A, ["alpha"]); capture(dir, B, ["beta"]);
  appendAlias(base, { alias: "old-a", key: A, actor: "person", machine: "m1" });
  const archived = await json(["project", "archive", "old-a", "--json"], person);
  expect(archived).toMatchObject({ op: "archive", key: A });
  expect(projectState(base, A)).toBe("archived"); expect(projectState(base, B)).toBe("active");
  await runCli(["project", "unarchive", A], person);
  expect(projectState(base, A)).toBe("active");
  await expect(runCli(["project", "archive", "github.com/o/nothing"], person)).rejects.toThrow(/no project shard/);
  expect(listLifecycle(base).map(op => op.key)).toEqual([A, A]);
});

test("project export writes the bundle for one project, refuses to overwrite, and reports counts and the withheld number", async () => {
  const { dir, person } = rig();
  capture(dir, A, ["alpha one", "alpha two"]); capture(dir, B, ["beta"]);
  const to = join(dir, "a.json");
  const result = await json(["project", "export", A, "--to", to, "--json"], { ...person, stdinTTY: false });   // export reads; a terminal is not required
  // The reply names the real path (a temp dir can sit behind a symlink, /var -> /private/var on macOS): compare resolved paths, not spellings.
  expect(result).toMatchObject({ project: A, withheld: 0 });
  expect(realpathSync(result.file)).toBe(realpathSync(to));
  expect(result.counts.capture).toBe(2);
  expect(readFileSync(to, "utf8")).not.toContain("beta");
  await expect(runCli(["project", "export", A, "--to", to], person)).rejects.toThrow(/exists/);
  await expect(runCli(["project", "export", A], person)).rejects.toThrow(/--to/);
  await expect(runCli(["project", "export", A, "--to", to], { ...person, env: { CLAUDECODE: "1" } })).rejects.toThrow(PERSON_ONLY);
});

test("search --all-projects crosses, says so in text and JSON, and plain search never does; ahub memory's raw command refuses the flag", async () => {
  const { dir, person } = rig();
  note(dir, A, "needle alpha"); note(dir, B, "needle beta");
  const crossed = await json(["search", "--all-projects", "needle", "--json"], person);
  expect(crossed).toMatchObject({ crossedProjects: true, projects: [A, B] });
  expect(crossed.hits.map((h: { project: string }) => h.project).sort()).toEqual([A, B]);
  const text = await runCli(["search", "--all-projects", "needle"], person);
  expect(text).toMatch(/crossed projects/i); expect(text).toContain(A); expect(text).toContain(B);
  await expect(runCli(["search", "--all-projects"], person)).rejects.toThrow(/words/);
  await expect(runCli(["search", "--include-archived", "needle"], person)).rejects.toThrow(/--all-projects/);
  const { rawMemoryCommand } = await import("../src/memory/commands.ts");
  await expect(rawMemoryCommand(["search", "needle", "--all-projects"], dir, { project: A, open: () => new MemoryStore({ home: dir, deferPromotions: true }), readable: notes => notes, importPolicy: () => () => false })).rejects.toThrow(/crosses projects/);
});

test("vault-candidates lists one project or all, grouped, and never writes the vault", async () => {
  const { dir, base, person } = rig();
  note(dir, A, "Decision: keep the portable format. Rationale: older readers."); note(dir, B, "Contract: ids only in replies.");
  const all = await json(["vault-candidates", "--all-projects"], person);
  expect(all.crossedProjects).toBe(true); expect(all.projects.map((p: { project: string }) => p.project)).toEqual([A, B]);
  const one = await json(["vault-candidates", "--project", B], person);
  expect(one.crossedProjects).toBe(false); expect(one.projects.map((p: { project: string }) => p.project)).toEqual([B]);
  await expect(runCli(["vault-candidates", "--all-projects", "--project", A], person)).rejects.toThrow(/either/);
  expect(existsSync(join(base, "vault"))).toBe(false);
});

test("capacity --json carries the split, and capacity apply --split previews then writes each shard's own config only with --confirm", async () => {
  const { dir, base, person } = rig();
  capture(dir, A, ["alpha"]); capture(dir, B, ["beta"]); capture(dir, C, ["gamma"]);
  await runCli(["project", "forget", C, "--confirm"], person);
  const report = await json(["capacity", "--json"], person);
  expect(report.split.map((r: { key: string }) => r.key)).toEqual([A, B]);
  const configOf = (key: string) => join(shardMachineDir(base, key, machineId(base).id), "config.json");
  await expect(runCli(["capacity", "apply", "--split", "--confirm"], person)).rejects.toThrow("preview first");
  const preview = await json(["capacity", "apply", "--split"], person);
  expect(preview.split.map((r: { key: string }) => r.key)).toEqual([A, B]); expect(preview.confirm).toMatch(/--confirm/);
  expect(existsSync(configOf(A))).toBe(false);
  const written = await json(["capacity", "apply", "--split", "--confirm"], person);
  expect(written.written.map((r: { key: string }) => r.key)).toEqual([A, B]);
  for (const key of [A, B]) expect(readCaptureConfigFile(configOf(key))).toMatchObject({ capMb: expect.any(Number), retentionDays: expect.any(Number) });
  expect(existsSync(configOf(C))).toBe(false);                      // the forgotten shard is not written
  expect(existsSync(join(base, "capture-config.json"))).toBe(false); // --split leaves the home default alone
});

test("a split preview is bound to the shards it was made for: a new shard or a changed bound makes --confirm refuse", async () => {
  const { dir, base, person } = rig();
  capture(dir, A, ["alpha"]);
  await runCli(["capacity", "apply", "--split"], person);
  capture(dir, B, ["beta"]);
  await expect(runCli(["capacity", "apply", "--split", "--confirm"], person)).rejects.toThrow(/changed|preview/);
  expect(existsSync(join(shardMachineDir(base, A, machineId(base).id), "config.json"))).toBe(false);
  writeFileSync(join(base, "capture-config.json"), "{}");
});

test("an archived project is out of recall: a writable capture open, and the CLI's own search of that project, refuse it, and unarchive restores it", async () => {
  const { dir, person } = rig();
  capture(dir, A, ["alpha"]);
  await runCli(["project", "archive", A], person);
  expect(() => new CaptureStore({ home: dir, project: A })).toThrow(/archived/);
  await runCli(["project", "unarchive", A], person);
  expect(() => new CaptureStore({ home: dir, project: A }).close()).not.toThrow();
});

test("curated counts are unavailable on an unsplit home, never 0: projects, usage and the forget preview all say so, and after the split they are real", async () => {
  const { dir, person } = rig();
  note(dir, A, "Decision: one curated note. Rationale: it exists."); capture(dir, A, ["alpha row"]);
  const rows = await json(["projects", "--json"], person);
  expect(rows[0].curatedAvailable === false || rows[0].curatedEntries === 0).toBe(true);     // the catalog's own field is a lower bound on an unsplit home
  const text = await runCli(["projects"], person);
  expect(text).toContain("curated unavailable (home not split)"); expect(text).not.toMatch(/curated 0\b/);
  const usage = await json(["usage", "--json"], person);
  expect(usage.curatedSplit).toBe(false); expect(usage.totals.curatedEntries).toBeNull();
  expect(await runCli(["usage"], person)).toContain("home not split into shards");
  expect(await runCli(["project", "forget", A], person)).toContain("curated unavailable (home not split)");
  const { migrateShards } = await import("../src/memory/shard-migration.ts");
  await migrateShards({ memoryDir: join(dir, "memory"), mode: "apply", authorizedPerson: true, tty: true });
  expect(await runCli(["projects"], person)).toMatch(/curated 1\b/);
  expect((await json(["usage", "--json"], person)).totals.curatedEntries).toBe(1);
});
