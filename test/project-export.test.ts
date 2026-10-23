import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { appendAlias, ensureShardDescriptor, shardMachineDir } from "../src/memory/shard.ts";
import { appendLifecycle, projectState } from "../src/memory/lifecycle.ts";
import { exportHooks, exportProject, EXPORT_SCHEMA } from "../src/memory/project-export.ts";
import { searchAllProjects, vaultCandidatesAll } from "../src/memory/cross-project.ts";
import { MemoryStore, machineId } from "../src/memory/store.ts";
import { Database } from "bun:sqlite";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";

// #15 T5 / D3, D4, D8: export one project as a portable bundle, search across projects with an honest reply, and list vault candidates per project and
// across projects. None of these writes the vault, another project's shard or the lifecycle log.
const cleanup: (() => void)[] = [];
afterEach(() => { delete exportHooks.afterCheck; for (const close of cleanup.splice(0).reverse()) close(); });
function home(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "amem-export-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, base: join(dir, "memory") };
}
function capture(dir: string, project: string, rows: string[]): void {
  const store = new CaptureStore({ home: dir, project });
  rows.forEach((excerpt, i) => store.append({ project, agent: "kimi", event: "PostToolUse", excerpt, at: `2026-10-1${i}T00:00:00.000Z` }));
  store.close();
}
function note(dir: string, project: string, text: string, kind: "decision" | "finding" = "decision"): string {
  // A project has a shard once a hook session or capture touched it; the catalog lists shards, so a test project gets its descriptor as a session would.
  ensureShardDescriptor(join(dir, "memory"), project);
  const store = new MemoryStore({ home: dir, deferPromotions: true });
  try { return store.note({ op: "note", project, scope: "project", tier: "long", kind, peer: "codex", source: "person", text, about: [] }); } finally { store.close(); }
}
const out = (dir: string, name = "bundle") => join(dir, name);

test("export writes one project's capture rows, curated notes and work lists as one bundle that names its schema and counts", async () => {
  const { dir, base } = home();
  capture(dir, "github.com/o/a", ["alpha one", "alpha two"]); capture(dir, "github.com/o/b", ["beta one"]);
  note(dir, "github.com/o/a", "alpha decision text"); note(dir, "github.com/o/b", "beta decision text");
  const work = new WorkListStore({ base, project: "github.com/o/a", policy: () => true }); await work.write("checklist", { title: "alpha list" }); work.close();
  const result = await exportProject(base, "github.com/o/a", { to: out(dir) });
  expect(result.counts).toMatchObject({ capture: 2, curated: 1, workLists: 1 });
  const bundle = JSON.parse(readFileSync(result.file, "utf8"));
  expect(bundle.schema).toBe(EXPORT_SCHEMA); expect(bundle.project).toBe("github.com/o/a");
  const text = readFileSync(result.file, "utf8");
  expect(text).toContain("alpha one"); expect(text).toContain("alpha decision text"); expect(text).toContain("alpha list");
  // one project only: nothing of project b is in the bundle
  expect(text).not.toContain("beta");
  expect(statSync(result.file).mode & 0o777).toBe(0o600);
});

test("export screens secrets: a secret-looking row is withheld and counted, never written", async () => {
  const { dir, base } = home();
  capture(dir, "github.com/o/a", ["fine row", "second fine row"]);
  // Capture screens secrets as it writes, so none reaches the database through the API. A restored or hand-edited database could hold one: plant it.
  const db = new Database(join(shardMachineDir(base, "github.com/o/a", machineId(base).id), "capture.db"));
  db.query("UPDATE rows SET excerpt = ? WHERE id = (SELECT MAX(id) FROM rows)").run("token = abcdefghijklmnop1234"); db.close();
  const result = await exportProject(base, "github.com/o/a", { to: out(dir) });
  expect(readFileSync(result.file, "utf8")).not.toContain("abcdefghijklmnop1234");
  expect(result.withheld).toBe(1);
  expect(result.counts.capture).toBe(1);
});

test("export applies the host policy when one is given: a withheld row is counted and not written", async () => {
  const { dir, base } = home();
  capture(dir, "github.com/o/a", ["public row", "private row PRIVATE-MARKER"]);
  const policy = createStandalonePolicy({ host: { screen: async (value: unknown) => !JSON.stringify(value).includes("PRIVATE-MARKER") } });
  const result = await exportProject(base, "github.com/o/a", { to: out(dir), policy });
  expect(readFileSync(result.file, "utf8")).not.toContain("PRIVATE-MARKER");
  expect(result.withheld).toBe(1);
});

test("export never overwrites: an existing file, a symlink at the target and a missing parent are refused with nothing written", async () => {
  const { dir, base } = home();
  capture(dir, "github.com/o/a", ["alpha one"]);
  writeFileSync(out(dir, "taken"), "keep me");
  await expect(exportProject(base, "github.com/o/a", { to: out(dir, "taken") })).rejects.toThrow(/exists/);
  expect(readFileSync(out(dir, "taken"), "utf8")).toBe("keep me");
  writeFileSync(out(dir, "victim"), "victim bytes"); symlinkSync(out(dir, "victim"), out(dir, "link"));
  await expect(exportProject(base, "github.com/o/a", { to: out(dir, "link") })).rejects.toThrow(/exists|link/);
  expect(readFileSync(out(dir, "victim"), "utf8")).toBe("victim bytes");
  await expect(exportProject(base, "github.com/o/a", { to: join(dir, "no", "such", "dir", "bundle") })).rejects.toThrow(/directory/);
});

test("export refuses a destination inside the memory home, an unknown project and a forgotten one", async () => {
  const { dir, base } = home();
  capture(dir, "github.com/o/a", ["alpha one"]);
  await expect(exportProject(base, "github.com/o/a", { to: join(base, "projects", "bundle") })).rejects.toThrow(/memory home/);
  await expect(exportProject(base, "github.com/o/none", { to: out(dir) })).rejects.toThrow(/no project shard/);
  appendLifecycle(base, { op: "forget", key: "github.com/o/a", actor: "person", machine: "m1" });
  await expect(exportProject(base, "github.com/o/a", { to: out(dir) })).rejects.toThrow(/forgotten/);
});

test("export of an archived project works, and an aliased key exports the canonical project once", async () => {
  const { dir, base } = home();
  capture(dir, "github.com/o/a", ["alpha one"]);
  appendAlias(base, { alias: "old-a", key: "github.com/o/a", actor: "person", machine: "m1" });
  appendLifecycle(base, { op: "archive", key: "github.com/o/a", actor: "person", machine: "m1" });
  const result = await exportProject(base, "old-a", { to: out(dir) });
  expect(JSON.parse(readFileSync(result.file, "utf8")).project).toBe("github.com/o/a");
  expect(result.counts.capture).toBe(1);
  expect(projectState(base, "github.com/o/a")).toBe("archived"); // export changes no state
});

// What "read-only" means here: no authored or content file changes (capture rows, curated logs, lifecycle, aliases, configs, work lists, descriptors) and no file
// appears except SQLite's own transient sidecars (-wal, -shm, -journal) and the derived indexes (index.db, search.db, mutation-lock.db, catalog.db), which any amem read
// may create or refresh and which are rebuildable from the logs. Runners differ on the sidecars (Linux leaves them after a read-only open, macOS removes them).
const DERIVED = /(?:-wal|-shm|-journal)$|\/(?:index|search|mutation-lock|catalog)\.db$/;
test("export changes no content file of the home: only derived indexes and SQLite sidecars may come or go", async () => {
  const { dir, base } = home();
  capture(dir, "github.com/o/a", ["alpha one"]);
  const snapshot = () => [...walk(base)].filter(([p]) => !DERIVED.test(p)).map(([p, s]) => `${p}:${s}`).sort();
  const before = snapshot();
  await exportProject(base, "github.com/o/a", { to: out(dir) });
  expect(snapshot()).toEqual(before);
});
function* walk(root: string): Generator<[string, string]> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield [path, `${statSync(path).size}`];
  }
}

// ---- cross-project search (D4) ----
test("default search never crosses projects; --all-projects does and the reply says it crossed, naming the projects", () => {
  const { dir, base } = home();
  note(dir, "github.com/o/a", "needle alpha text"); note(dir, "github.com/o/b", "needle beta text");
  capture(dir, "github.com/o/a", ["needle capture alpha"]); capture(dir, "github.com/o/b", ["needle capture beta"]);
  const crossed = searchAllProjects(base, "needle");
  expect(crossed.crossedProjects).toBe(true);
  expect(crossed.projects).toEqual(["github.com/o/a", "github.com/o/b"]);
  const texts = crossed.hits.map(h => JSON.stringify(h.view ?? h.capture));
  expect(texts.some(t => t.includes("alpha"))).toBe(true); expect(texts.some(t => t.includes("beta"))).toBe(true);
  expect(crossed.hits.every(h => typeof h.project === "string")).toBe(true);
  // the single-project path stays scoped (AC3)
  const store = new MemoryStore({ home: dir, deferPromotions: true });
  cleanup.push(() => store.close());
  const own = store.search("needle", { project: "github.com/o/a", includeCapture: false });
  expect(own.hits.map(h => h.view!.project)).toEqual(["github.com/o/a"]);
});

test("cross-project search leaves archived and forgotten projects out, applies the policy and caps the hits", async () => {
  const { dir, base } = home();
  for (const key of ["a", "b", "c"]) note(dir, `github.com/o/${key}`, `needle ${key} text`);
  appendLifecycle(base, { op: "archive", key: "github.com/o/b", actor: "person", machine: "m1" });
  appendLifecycle(base, { op: "forget", key: "github.com/o/c", actor: "person", machine: "m1" });
  const result = searchAllProjects(base, "needle");
  expect(result.projects).toEqual(["github.com/o/a"]);
  expect(JSON.stringify(result.hits)).not.toContain("needle b"); expect(JSON.stringify(result.hits)).not.toContain("needle c");
  const limited = searchAllProjects(base, "needle", { includeArchived: true, limit: 1 });
  expect(limited.hits).toHaveLength(1); expect(limited.projects).toEqual(["github.com/o/a", "github.com/o/b"]);
});

test("cross-project search changes no content file of the home (derived indexes and sidecars may refresh)", () => {
  const { dir, base } = home();
  note(dir, "github.com/o/a", "needle alpha"); capture(dir, "github.com/o/a", ["needle row"]);
  const snapshot = () => [...walk(base)].filter(([p]) => !DERIVED.test(p)).map(([p, s]) => `${p}:${s}`).sort();
  const before = snapshot();
  searchAllProjects(base, "needle");
  expect(snapshot()).toEqual(before);
});

// ---- vault candidates per project and across projects (D8) ----
test("vault candidates list per project and across projects, grouped by project, under the current policy, and write nothing", async () => {
  const { dir, base } = home();
  const a = note(dir, "github.com/o/a", "Decision: use sqlite for the index. Rationale: portable."), b = note(dir, "github.com/o/b", "Contract: the API returns ids only.");
  note(dir, "github.com/o/a", "task #12 completed and merged", "finding");
  const all = await vaultCandidatesAll(base, { policy: createStandalonePolicy() });
  expect(all.crossedProjects).toBe(true);
  expect(all.projects.map(p => p.project)).toEqual(["github.com/o/a", "github.com/o/b"]);
  expect(all.projects[0]!.candidates.map(c => c.id)).toEqual([a]);       // the status-like finding is not durable
  expect(all.projects[1]!.candidates.map(c => c.id)).toEqual([b]);
  const one = await vaultCandidatesAll(base, { policy: createStandalonePolicy(), project: "github.com/o/b" });
  expect(one.crossedProjects).toBe(false);
  expect(one.projects.map(p => p.project)).toEqual(["github.com/o/b"]);
  // the policy runs before anything is listed
  const hostile = createStandalonePolicy({ host: { screen: async (v: unknown) => !JSON.stringify(v).includes("sqlite") } });
  expect((await vaultCandidatesAll(base, { policy: hostile })).projects.flatMap(p => p.candidates.map(c => c.id))).toEqual([b]);
  // amem never writes the vault: no vault file or link row appears anywhere under the home
  expect([...walk(base)].some(([p]) => /vault/i.test(p))).toBe(false);
});

test("vault candidates skip archived and forgotten projects and honor the limit per project", async () => {
  const { dir, base } = home();
  for (const key of ["a", "b", "c"]) for (let i = 0; i < 3; i++) note(dir, `github.com/o/${key}`, `Decision ${key}${i}: keep the portable format. Rationale ${i}.`);
  appendLifecycle(base, { op: "archive", key: "github.com/o/b", actor: "person", machine: "m1" });
  appendLifecycle(base, { op: "forget", key: "github.com/o/c", actor: "person", machine: "m1" });
  const all = await vaultCandidatesAll(base, { policy: createStandalonePolicy(), limit: 2 });
  expect(all.projects.map(p => p.project)).toEqual(["github.com/o/a"]);
  expect(all.projects[0]!.candidates).toHaveLength(2);
});

test("a file that appears after the existence check but before the open is not truncated: O_EXCL, not the check, is what protects it", async () => {
  const { dir, base } = home();
  capture(dir, "github.com/o/a", ["alpha one"]);
  const target = out(dir, "raced");
  exportHooks.afterCheck = file => writeFileSync(file, "another writer's bytes");
  await expect(exportProject(base, "github.com/o/a", { to: target })).rejects.toThrow(/exists/);
  expect(readFileSync(target, "utf8")).toBe("another writer's bytes");
});

test("the destination is claimed with O_EXCL before anything is read: a file that appears while rows are being screened is never replaced or truncated, and a failed export removes only its own partial file", async () => {
  const { dir, base } = home();
  capture(dir, "github.com/o/a", ["alpha one", "alpha two"]);
  const target = out(dir, "claimed");
  // the first screened row proves the export already holds its file: a second exporter to the same path is refused, and the first keeps working
  let second: unknown;
  const policy = createStandalonePolicy({ host: { screen: async () => {
    if (second === undefined) second = await exportProject(base, "github.com/o/a", { to: target }).then(() => "wrote", error => (error as Error).message);
    return true;
  } } });
  const result = await exportProject(base, "github.com/o/a", { to: target, policy });
  expect(second).toMatch(/exists/);
  expect(JSON.parse(readFileSync(result.file, "utf8")).counts.capture).toBe(2);
  // a failure mid-write removes the partial file it created, and only that one
  const broken = out(dir, "broken"), keep = out(dir, "keep"); writeFileSync(keep, "untouched");
  let calls = 0;
  const failing = { screen: async () => { if (++calls === 2) throw new Error("policy failed"); return true; } };
  await expect(exportProject(base, "github.com/o/a", { to: broken, policy: failing })).rejects.toThrow(/policy failed/);
  expect(existsSync(broken)).toBe(false);
  expect(readFileSync(keep, "utf8")).toBe("untouched");
});

test("the export's own secret screen holds with a host policy that waves everything through", async () => {
  const { dir, base } = home();
  capture(dir, "github.com/o/a", ["fine row", "second row"]);
  const db = new Database(join(shardMachineDir(base, "github.com/o/a", machineId(base).id), "capture.db"));
  db.query("UPDATE rows SET excerpt = ? WHERE id = (SELECT MAX(id) FROM rows)").run("password: hunter2hunter2hunter2"); db.close();
  // a permissive host (a different standalone policy object, as a host passes) must not widen what leaves the home
  const permissive = { screen: async () => true };
  const result = await exportProject(base, "github.com/o/a", { to: out(dir), policy: permissive });
  expect(readFileSync(result.file, "utf8")).not.toContain("hunter2hunter2hunter2");
  expect(result.withheld).toBe(1);
});
