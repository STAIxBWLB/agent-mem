import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemoryStore as Reader011 } from "@staix/agent-mem-v011";
import { MemoryStore as Reader012 } from "@staix/agent-mem-v012";
import { appendAlias, appendUnalias, SHARD_SCHEMA } from "../src/memory/aliases.ts";
import { ensureShardDescriptor } from "../src/memory/shard.ts";
import { appendLifecycle } from "../src/memory/lifecycle.ts";
import { MemoryStore, type NoteInput } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { pruneId, type PruneRow } from "../src/memory/prune.ts";
import { repoEntryId, REPO_SCHEMA, repoLogPath, type RepoLine } from "../src/memory/repo-scope.ts";

// Frozen published tarballs, verified on dgx02. Bun's lockfile also pins each registry SHA-512 integrity.
const readers = [
  { version: "0.11.0", tarballSha256: "f516c4dee027b5948f86d1f88bf42039ad5335e9c9f4466a1a26b8656c26a645", integrity: "sha512-lFxYVTSysFCiBINvxztfmDPRf2ydBP1AIwmbX5KLSjZYLoECy4eIFZjvKl3Li8X1CJn2/0kJo0ywxoWHvCsiPA==", specifier: "@staix/agent-mem-v011", Store: Reader011 },
  { version: "0.12.0", tarballSha256: "e491ff43873ddae2f66cbc1d21989296f32fa4237825dd19df04e1df9c36415e", integrity: "sha512-5B25wjkTgt63a8uUYNk55UMcH9QzdyeItgGX3ceTlRRZMVcs8DdUDBycYEXCDxdS71ApJnPcc63yy/bhdy4ydA==", specifier: "@staix/agent-mem-v012", Store: Reader012 },
] as const;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const at = "2026-10-29T00:00:00.000Z", now = Date.parse(at), project = "github.com/fixture/actor-reader";
function home(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix)); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root;
}
function note(text: string, extra: Partial<NoteInput> = {}): NoteInput {
  return { op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "fixture-peer", source: "person", text, about: [], ...extra };
}
function sourceRoot(specifier: string): string {
  return dirname(dirname(fileURLToPath(import.meta.resolve(specifier))));
}
async function legacyModules(root: string) {
  const file = (name: string) => pathToFileURL(join(root, "src", "memory", name)).href;
  return {
    aliases: await import(file("aliases.ts")),
    lifecycle: await import(file("lifecycle.ts")),
    prune: await import(file("prune.ts")),
    repo: await import(file("repo-scope.ts")),
  };
}
function noteRows(dir: string): Record<string, unknown>[] {
  return ["log", "local"].flatMap(folder => readdirSync(join(dir, folder), { withFileTypes: true }).filter(row => row.isFile() && row.name.endsWith(".jsonl"))
    .flatMap(row => readFileSync(join(dir, folder, row.name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)));
}

for (const reader of readers) {
  test(`published ${reader.version}: agent canonical ops and goal rows open, project, and rebuild`, () => {
    const root = sourceRoot(reader.specifier), manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    expect(manifest.version).toBe(reader.version);
    expect(readFileSync(new URL("../bun.lock", import.meta.url), "utf8")).toContain(reader.integrity);
    expect(reader.tarballSha256).toMatch(/^[a-f0-9]{64}$/);

    const parent = home(`amem-actor-reader-${reader.version}-`), current = new MemoryStore({ home: parent, profile: "shared-v1", now: () => now, deferPromotions: true });
    const original = current.note(note("superseded by an agent")), replacement = current.note(note("agent replacement")), third = current.note(note("agent suggestion target"));
    current.demote(replacement, "agent", project);
    current.supersede(original, replacement, "agent", project);
    const forgotten = current.note(note("forgotten by an agent")); current.forget(forgotten, "agent", project);
    const task = `${project}#1@1799999999000`, short = current.note(note("settled by an agent", { tier: "short", kind: "decision", task }), true);
    current.settle(task, "agent");
    const suggestion = current.suggest(original, replacement, "same_topic"); expect(suggestion).toBeDefined();
    current.judge(suggestion!, "confirm", "agent", project);
    const rejected = current.suggest(replacement, third, "contradicts"); expect(rejected).toBeDefined(); current.judge(rejected!, "reject", "agent", project);
    const expiringShort = current.note(note("promoted without actor metadata", { tier: "short" }));
    const promoted = current.promote(expiringShort, "agent", project); expect(promoted).toBeDefined();
    const goal = current.goal({ project, scope: "project", title: "agent goal", milestones: [], dependsOn: [], actor: "agent" });
    current.goalState(goal, "active", "agent"); current.goalLink(goal, task, "agent"); current.take(goal, "agent", { ms: 60_000 }); current.take(goal, "agent", { force: true, ms: 60_000 });
    const machine = current.machine.id, authoredDir = current.dir;
    const rows = noteRows(authoredDir);
    const agentOps = rows.filter(row => row.op !== "note" && row.actor === "agent");
    expect(agentOps.map(row => row.op)).toEqual(expect.arrayContaining(["demote", "supersede", "forget", "settle", "confirm", "reject", "goal_state", "goal_link", "lease", "lease_force"]));
    expect(agentOps.every(row => !Object.hasOwn(row, "peer"))).toBe(true);
    const forgetRow = agentOps.find(row => row.op === "forget")!;
    expect(Object.hasOwn(forgetRow, "by")).toBe(false);
    const noteRow = rows.find(row => row.id === original)!;
    expect(noteRow.peer).toBe("fixture-peer"); expect(Object.hasOwn(noteRow, "actor")).toBe(false); expect(Object.hasOwn(noteRow, "by")).toBe(false);
    const promotedRow = rows.find(row => row.id === promoted)!;
    expect(promotedRow.promotedFrom).toBe(expiringShort); expect(promotedRow.peer).toBe("fixture-peer");
    expect(Object.hasOwn(promotedRow, "actor")).toBe(false); expect(Object.hasOwn(promotedRow, "by")).toBe(false);
    const goalRow = rows.find(row => row.op === "goal")!;
    expect(goalRow.actor).toBe("agent"); expect(Object.hasOwn(goalRow, "peer")).toBe(false); expect(Object.hasOwn(goalRow, "by")).toBe(false);
    current.close();

    const old = new reader.Store({ home: parent, now: () => now });
    try {
      expect(old.machine.id).toBe(machine);
      expect(old.get(original, project)?.supersededBy).toBe(replacement);
      expect(old.get(replacement, project)?.tier).toBe("short");
      expect(old.get(forgotten, project)).toBeUndefined();
      expect(old.get(short, project)?.tier).toBe("short");
      expect(old.goals(project)[0]).toMatchObject({ id: goal, state: "active", links: [{ task }], lease: { holder: machine } });
      const before = old.list({ project }).map(row => row.id).sort();
      old.rebuild(); expect(old.list({ project }).map(row => row.id).sort()).toEqual(before);
    } finally { old.close(); }
    const reopened = new reader.Store({ home: parent, now: () => now });
    try { expect(reopened.get(replacement, project)?.tier).toBe("short"); expect(reopened.goals(project)[0]?.state).toBe("active"); }
    finally { reopened.close(); }
  });

  test(`published ${reader.version}: agent lifecycle and alias ops are consumed without changing their payload shapes`, async () => {
    const root = sourceRoot(reader.specifier), old = await legacyModules(root), parent = home(`amem-actor-aux-${reader.version}-`);
    const current = new MemoryStore({ home: parent, profile: "shared-v1", now: () => now, deferPromotions: true });
    current.note(note("readable under the alias")); current.close();
    const base = join(parent, "memory"), alias = `${project}-alias`, machine = "a".repeat(16);
    ensureShardDescriptor(base, project);
    appendAlias(base, { alias, key: project, actor: "agent", machine, at });
    appendUnalias(base, { alias, actor: "agent", machine, at: "2026-10-29T00:00:01.000Z" });
    appendLifecycle(base, { op: "archive", key: project, actor: "agent", machine, at: "2026-10-29T00:00:02.000Z" });
    const aliasRows = old.aliases.listAliases(base) as { op: string; actor: string; alias: string }[];
    expect(aliasRows.map(row => row.op)).toEqual(["alias", "unalias"]);
    expect(aliasRows.every(row => row.actor === "agent" && row.alias === alias && !("peer" in row) && !("by" in row))).toBe(true);
    expect(old.aliases.resolveAlias(base, alias)).toBe(alias);
    const lifecycleRows = old.lifecycle.listLifecycle(base) as { op: string; actor: string; key: string }[];
    expect(lifecycleRows).toEqual([expect.objectContaining({ op: "archive", actor: "agent", key: project })]);
    expect(old.lifecycle.projectState(base, project)).toBe("archived");
    const reopened = new reader.Store({ home: parent, now: () => now });
    try { expect(reopened.list({ project }).length).toBe(1); }
    finally { reopened.close(); }
    expect(SHARD_SCHEMA).toBe("agent-hub.memory.shard/v1");
  });

  test(`published ${reader.version}: prune stays person-authored; repo agent rows are skipped, not fatal`, async () => {
    const root = sourceRoot(reader.specifier), old = await legacyModules(root);
    const body = {
      schema: "agent-mem.prune/v1", op: "prune", generation: "c".repeat(32), at, machine: "a".repeat(16), actor: "person",
      placement: "local", cutoff: at, targets: [{ id: "b".repeat(32), rowHash: "d".repeat(64), expiredAt: at, basis: { kind: "note", id: "e".repeat(32), rowHash: "f".repeat(64) } }],
    } as Omit<PruneRow, "id">;
    const personRow = { ...body, id: pruneId(body) };
    expect(old.prune.validatePruneRow(personRow)).toEqual(personRow);
    const agentBody = { ...body, actor: "agent" as const }, agentPrune = { ...agentBody, id: pruneId(agentBody as Omit<PruneRow, "id">) };
    expect(() => old.prune.validatePruneRow(agentPrune)).toThrow();

    const repo = home(`amem-actor-repo-${reader.version}-`), directory = join(repo, ".amem"); mkdirSync(directory, { recursive: true });
    const repoBody: Omit<RepoLine, "id"> = { schema: REPO_SCHEMA, op: "note", at, kind: "decision", text: "published reader fixture", about: [], actor: "person" };
    const personRepo = { ...repoBody, id: repoEntryId(repoBody) };
    const agentRepoBody = { ...repoBody, actor: "agent" }, agentRepo = { ...agentRepoBody, id: old.repo.repoEntryId(agentRepoBody) };
    expect(old.repo.parseRepoLine(JSON.stringify(personRepo))).toHaveProperty("view");
    expect(old.repo.parseRepoLine(JSON.stringify(agentRepo))).toEqual({ error: "malformed" });
    writeFileSync(repoLogPath(repo), `${JSON.stringify(personRepo)}\n${JSON.stringify(agentRepo)}\n`);
    const read = await old.repo.readRepoScope(repo, { screen: async () => true });
    expect(read.state).toBe("ok"); expect(read.views.map((view: { id: string }) => view.id)).toEqual([personRepo.id]);
    expect(read.skipped.malformed).toBe(1); expect(read.partial).toBe(true);
    expect(Object.keys(agentRepo).sort()).toEqual(["about", "actor", "at", "id", "kind", "op", "schema", "text"].sort());
    expect(agentRepo.actor).toBe("agent");
    expect(Object.hasOwn(agentRepo, "peer")).toBe(false); expect(Object.hasOwn(agentRepo, "by")).toBe(false);
  });

  test(`published ${reader.version}: a generation prune row with actor=agent blocks the old reader's home open`, async () => {
    const parent = home(`amem-actor-prune-open-${reader.version}-`);
    const legacy = new MemoryStore({ home: parent, profile: "shared-v1", now: () => now, deferPromotions: true });
    legacy.note(note("positive control before prune row")); const base = legacy.dir; legacy.close();
    await migrate({ memoryDir: base, generation: "9".repeat(32), mode: "apply", authorizedPerson: true, tty: true, now: () => now });
    const selected = new MemoryStore({ home: parent, now: () => now, deferPromotions: true }), machine = selected.machine.id, generationDir = selected.dir;
    const positive = new reader.Store({ home: parent, now: () => now });
    try { expect(positive.list({ project }).map(row => row.text)).toContain("positive control before prune row"); }
    finally { positive.close(); selected.close(); }
    const body = {
      schema: "agent-mem.prune/v1", op: "prune", generation: "9".repeat(32), at, machine, actor: "agent",
      placement: "local", cutoff: at, targets: [{ id: "b".repeat(32), rowHash: "d".repeat(64), expiredAt: at, basis: { kind: "note", id: "e".repeat(32), rowHash: "f".repeat(64) } }],
    } as Omit<PruneRow, "id">;
    const bad = { ...body, id: pruneId(body as Omit<PruneRow, "id">) };
    appendFileSync(join(generationDir, "log", `${machine}.jsonl`), JSON.stringify(bad) + "\n");
    expect(() => { const unsupported = new reader.Store({ home: parent, now: () => now }); try { unsupported.list({ project }); } finally { unsupported.close(); } }).toThrow();
  });
}
