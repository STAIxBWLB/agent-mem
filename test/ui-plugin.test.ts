// The agent-console contract references the DOM lib; its ReadableStream then needs DOM's async-iterable part, or
// `for await` over a Bun stream elsewhere in this program stops type-checking.
/// <reference lib="dom.asynciterable" />
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ConsolePlugin } from "@staix/agent-console/contract";
import { registerConsoleConformance } from "@staix/agent-console/conformance";
import { scanPlugins } from "../node_modules/@staix/agent-console/src/plugins.ts";
import { runCli } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { CaptureStore, writeCaptureConfig } from "../src/memory/capture.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { appendAlias, ensureShardDescriptor, shardDir } from "../src/memory/shard.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { consoleSetup } from "../src/setup-console.ts";
import { plugin } from "../src/ui/plugin.ts";
import * as briefModule from "../src/session-brief.ts";
import { configuredPolicyOptions } from "../src/memory/config.ts";
import { withBriefSnapshot } from "../src/memory/doctor.ts";

// The local contract copy in src/ui/plugin.ts must satisfy the real api 1 contract.
const typed: ConsolePlugin = plugin;

const roots: string[] = [];
const oldAmem = process.env.AMEM_HOME;
afterEach(() => { if (oldAmem === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldAmem; });
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A family home ($AGENTHUB_HOME) with one project: two curated notes, a memory candidate and a fail candidate. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-console-")); roots.push(root);
  const family = join(root, "hub"), base = join(family, "memory"), project = memoryProjectKey(root);
  mkdirSync(base, { recursive: true });
  ensureShardDescriptor(base, project);
  const store = new MemoryStore({ memoryDir: base });
  const noteId = store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", title: "Console search", text: "The console search reuses the screened amem search index", about: [] });
  store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "Undo in the console search is offered for ten seconds", about: [] });
  store.close();
  const candidates = new CandidateStore({ memoryDir: base });
  const memory = candidates.put({ project, kind: "memory", text: "Console accept writes the same note as review accept", title: "Console accept", noteKind: "decision" }, "public");
  const fail = candidates.put({ project, kind: "fail", approach: "polling the console every second", symptom: "the panel flickers", cause: "re-render on every poll", evidenceRefs: ["test:fixture"], retryWhen: "the shell diffs snapshots" }, "public");
  candidates.close();
  return { root, family, base, project, noteId, memory, fail };
}
const open = (family: string) => plugin.open({ home: family, log: () => {} });
/**
 * Every file below the home with its size and mtime: a write anywhere changes it. Two SQLite sidecars hold no data and are left out: `-shm`
 * (the read-lock index, touched by any open) and an empty `-wal`. A read-only reader of a WAL database recreates an empty `-wal` when the
 * last writer's close removed it, which Linux SQLite does and macOS's does not (Ubuntu CI, run 41240923573). A committed write either leaves
 * frames in a non-empty `-wal` or, checkpointed on close, changes the database file itself; both still show here.
 */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const name of readdirSync(d).sort()) { const p = join(d, name), s = lstatSync(p); if (s.isDirectory()) walk(p); else if (!name.endsWith("-shm") && !(name.endsWith("-wal") && s.size === 0)) out.push(`${p} ${s.size} ${s.mtimeMs}`); } };
  walk(dir); return out;
}
const noteOf = (base: string, id: string, project: string) => { const store = new MemoryStore({ memoryDir: base, screen: () => "skip" }); try { return store.get(id, project); } finally { store.close(); } };
const statusOf = (base: string, id: string, project: string) => { const c = new CandidateStore({ memoryDir: base }); try { return c.get(id, project)?.status; } finally { c.close(); } };

test("Recap matches a direct brief under machine policy and leaves the memory home unchanged", async () => {
  const f = fixture(), hidden = new MemoryStore({ memoryDir: f.base });
  hidden.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "recap-denied-token", about: [] }); hidden.close();
  const capture = new CaptureStore({ memoryDir: f.base, project: f.project });
  capture.append({ project: f.project, agent: "fixture", event: "PostToolUse", excerpt: "recap capture marker" }); capture.close();
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
  try { await mcp.tools.amem_work_state_write({ list: "recap-work", fields: { task: "recap work marker", status: "doing" } }); } finally { mcp.close(); }
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["recap-denied-token"] }));
  const direct = await briefModule.sessionStartBrief({ cwd: f.base, base: f.base, project: f.project, repository: false, policy: configuredPolicyOptions(f.base) });
  const provider = await open(f.family);
  const before = tree(f.base), snapshot = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
  expect(snapshot.error).toBeUndefined(); expect(snapshot.brief).toEqual(direct);
  expect(snapshot.repoAbsent).toBe(true); expect(direct.coverage).not.toHaveProperty("repo");
  expect(new Date(String(snapshot.generatedAt)).toISOString()).toBe(String(snapshot.generatedAt));
  expect(JSON.stringify(snapshot)).not.toContain("recap-denied-token");
  expect(direct.context).toContain("recap work marker"); expect(direct.context).toContain("recap capture marker");
  expect(direct.tokens).toBe(Buffer.byteLength(direct.context));
  expect(tree(f.base)).toEqual(before);
  expect(plugin.manifest.panels.map(panel => panel.id).slice(0, 3)).toEqual(["review", "recap", "find"]);
});

test("Recap cold read creates no live lease or work index beyond ordinary console reads", async () => {
  const f = fixture(), provider = await open(f.family);
  await provider.snapshot({ after: 0, panel: "goals", project: f.project });
  const before = tree(f.base), snapshot = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
  expect(snapshot.error).toBeUndefined(); expect((snapshot.brief as briefModule.BriefResult).context).toStartWith("Untrusted project memory data");
  expect(tree(f.base)).toEqual(before);
});

test("Recap includes work logs that exist only under a reconciled alias", async () => {
  const f = fixture(), old = "old-recap-project", work = new WorkListStore({ base: f.base, project: old, policy: () => true });
  try { await work.write("alias-recap", { task: "alias-only recap work", status: "doing" }); } finally { work.close(); }
  appendAlias(f.base, { alias: old, key: f.project, actor: "person", machine: "a".repeat(16) });
  const provider = await open(f.family), snapshot = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
  const direct = await briefModule.sessionStartBrief({ cwd: f.base, base: f.base, project: f.project, repository: false, policy: configuredPolicyOptions(f.base) });
  expect(snapshot.error).toBeUndefined(); expect(snapshot.brief).toEqual(direct);
  expect(direct.context).toContain("alias-only recap work");
});

test("only Recap snapshots compute the SessionStart brief", async () => {
  const f = fixture(), provider = await open(f.family), calls = spyOn(briefModule, "sessionStartBrief");
  try {
    for (const panel of [...plugin.manifest.panels.filter(panel => panel.id !== "recap").map(panel => panel.id), "inbox", "search"]) {
      await provider.snapshot({ after: 0, panel, project: f.project, q: "console" });
    }
    expect(calls).not.toHaveBeenCalled();
    expect((await provider.snapshot({ after: 0, panel: "recap", project: f.project })).error).toBeUndefined();
    expect(calls).toHaveBeenCalledTimes(1);
  } finally { calls.mockRestore(); }
});

test("Recap omits repository narrowing even when the home is inside a repository config boundary", async () => {
  const f = fixture(); mkdirSync(join(f.root, ".git")); mkdirSync(join(f.root, ".amem"));
  writeFileSync(join(f.root, ".amem", "config"), JSON.stringify({ piiPatterns: ["screened amem search index"], briefBytes: 256 }));
  const provider = await open(f.family);
  const snapshot = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
  const brief = snapshot.brief as briefModule.BriefResult;
  expect(snapshot.error).toBeUndefined(); expect(brief.context).toContain("screened amem search index");
  expect(brief.tokens).toBeGreaterThan(256); expect(brief.coverage).not.toHaveProperty("repo");
});

test("private brief copies refuse a live forget during projection and clean their scratch store", async () => {
  const f = fixture(); let copy: string | undefined;
  await expect(withBriefSnapshot(f.base, f.project, async measureOnly => {
    copy = measureOnly.curated?.profile.home;
    const brief = await briefModule.sessionStartBrief({ cwd: f.base, base: f.base, project: f.project, repository: false, measureOnly });
    const store = new MemoryStore({ memoryDir: f.base });
    try { store.forget(f.noteId, "person", f.project); } finally { store.close(); }
    return brief;
  })).rejects.toThrow("recap source");
  expect(copy).toBeDefined(); expect(existsSync(copy!)).toBe(false);
});

test("Recap refuses a symlinked work log instead of claiming an empty complete section", async () => {
  const f = fixture(), work = join(shardDir(f.base, f.project), "work"), external = join(f.root, "external-work-log");
  mkdirSync(work, { recursive: true }); mkdirSync(external); symlinkSync(external, join(work, "log"), "dir");
  const provider = await open(f.family), before = tree(f.base), snapshot = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
  expect(snapshot.error).toBeDefined(); expect(snapshot.brief).toBeUndefined(); expect(tree(f.base)).toEqual(before);
});

const conf = fixture();
registerConsoleConformance(typed, { home: conf.family, destructive: [
  { action: "gc" }, { action: "capacity_apply" }, { action: "project_forget", project: conf.project }, { action: "decay_apply", project: conf.project, days: 1 },
] });

test("accepting a candidate in the console writes the same note as amem review accept, with the person as reviewer", async () => {
  const a = fixture(), b = join(a.root, "copy");
  cpSync(a.family, b, { recursive: true });
  process.env.AMEM_HOME = a.base;
  const cli = JSON.parse(await runCli(["review", "accept", a.memory, "--json"], { cwd: a.root, env: {} }));
  delete process.env.AMEM_HOME;
  const provider = await open(b), result = await provider.action({ action: "accept", id: a.memory, project: a.project });
  expect(result).toMatchObject({ ok: true, undo: { action: "accept_undo", id: a.memory } });
  const fields = (v: Record<string, unknown> | undefined) => v && { kind: v.kind, peer: v.peer, source: v.source, project: v.project, scope: v.scope, tier: v.tier, title: v.title, text: v.text, about: v.about };
  const viaCli = fields(noteOf(a.base, cli.noteId, a.project) as never), viaConsole = fields(noteOf(join(b, "memory"), String((result as unknown as { noteId: string }).noteId), a.project) as never);
  expect(viaConsole).toEqual(viaCli!);
  expect(viaConsole).toMatchObject({ peer: "person", source: "person", text: expect.stringContaining(`Accepted candidate: ${a.memory}`) });
  expect(statusOf(join(b, "memory"), a.memory, a.project)).toBe("accepted");
});

test("undo forgets the accepted note append-only, and a reject undo makes the candidate pending again", async () => {
  const f = fixture(), provider = await open(f.family);
  const accepted = await provider.action({ action: "accept", id: f.memory, project: f.project }) as { ok: true; noteId: string };
  expect(noteOf(f.base, accepted.noteId, f.project)).toBeDefined();
  expect(await provider.action({ action: "accept_undo", id: f.memory, project: f.project })).toMatchObject({ ok: true });
  expect(noteOf(f.base, accepted.noteId, f.project)).toBeUndefined();
  expect(await provider.action({ action: "accept_undo", id: f.memory, project: f.project })).toMatchObject({ ok: false });
  expect(await provider.action({ action: "reject", id: f.fail, project: f.project, reason: "duplicate" })).toMatchObject({ ok: true, undo: { action: "reject_undo" } });
  expect(statusOf(f.base, f.fail, f.project)).toBe("rejected");
  expect(await provider.action({ action: "reject_undo", id: f.fail, project: f.project })).toMatchObject({ ok: true });
  expect(statusOf(f.base, f.fail, f.project)).toBe("pending");
  // Undo is bound to what this console just did: a second undo, or one for a candidate it never rejected, refuses.
  expect(await provider.action({ action: "reject_undo", id: f.fail, project: f.project })).toMatchObject({ ok: false });
});

test("edit then accept writes the person's own note and closes the candidate", async () => {
  const f = fixture(), provider = await open(f.family);
  const result = await provider.action({ action: "edit_accept", id: f.memory, project: f.project, text: "Console accept writes the note; edited by the person" }) as { ok: true; noteId: string };
  expect(result.ok).toBe(true);
  expect(noteOf(f.base, result.noteId, f.project)).toMatchObject({ kind: "decision", peer: "person", text: "Console accept writes the note; edited by the person", title: "Console accept" });
  expect(statusOf(f.base, f.memory, f.project)).toBe("rejected");
});

test("a privacy-screen hit refuses with a named reason and writes nothing", async () => {
  const f = fixture(), provider = await open(f.family);
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["flickers"] }));
  const before = tree(f.base);
  // The fail candidate now matches a configured pattern: the console neither shows it nor acts on it.
  expect(await provider.action({ action: "accept", id: f.fail, project: f.project })).toEqual({ ok: false, error: expect.stringContaining("withheld by the privacy screen") });
  const review = await provider.snapshot({ after: 0, panel: "review", project: f.project });
  expect((review.rows as { id: string }[]).map(r => r.id)).toEqual([f.memory]);
  expect(review.hidden).toBe(1);
  // An edit that adds the pattern is refused by name.
  expect(await provider.action({ action: "edit_accept", id: f.memory, project: f.project, text: "the panel flickers" })).toEqual({ ok: false, error: expect.stringMatching(/^Refused by the privacy screen: personal data, a configured PII pattern or a deny path/) });
  expect(tree(f.base)).toEqual(before);
});

test("a destructive action without the console's confirmation writes nothing", async () => {
  const f = fixture(), provider = await open(f.family), before = tree(f.base);
  for (const input of [{ action: "gc" }, { action: "capacity_apply" }, { action: "project_forget", project: f.project }, { action: "decay_apply", project: f.project, days: 1 }, { action: "prune", project: f.project, cutoff: new Date().toISOString() }]) {
    const first = await provider.action(input);
    // prune needs a generation home, like `amem prune`; this fixture is a shared-v1 home, so it refuses before any plan.
    if (input.action === "prune") expect(first).toEqual({ ok: false, error: "durable prune requires an active generation handle" });
    else expect(first).toMatchObject({ ok: false, needsConfirm: true, fingerprint: expect.any(String), preview: expect.any(Array), changes: expect.any(Array) });
    // A page cannot forge a confirmation: a wrong fingerprint gets a fresh preview.
    const forged = await provider.action({ ...input, confirmed: true, fingerprint: "0".repeat(64) });
    expect(forged.ok).toBe(false);
  }
  expect(tree(f.base)).toEqual(before);
});

test("confirmed capacity apply and project forget write exactly what the preview showed", async () => {
  const f = fixture(), provider = await open(f.family);
  const preview = await provider.action({ action: "capacity_apply" }) as { fingerprint: string; changes: { target: string }[] };
  expect(await provider.action({ action: "capacity_apply", confirmed: true, fingerprint: preview.fingerprint })).toMatchObject({ ok: true });
  expect(existsSync(preview.changes[0]!.target)).toBe(true);
  const forget = await provider.action({ action: "project_forget", project: f.project }) as { fingerprint: string };
  expect(await provider.action({ action: "project_forget", project: f.project, confirmed: true, fingerprint: forget.fingerprint })).toMatchObject({ ok: true });
  expect(readFileSync(join(f.base, "lifecycle.jsonl"), "utf8")).toContain("\"forget\"");
  expect((await provider.snapshot({ after: 0, panel: "review" })).projects).toEqual([]);
});

test("console search returns exactly the amem_search set for the same query", async () => {
  const f = fixture(), provider = await open(f.family);
  const mcp = createMemoryMcp({ cwd: f.base, base: f.base, project: f.project });
  try {
    for (const query of ["console search", "undo", "nothing-matches-this"]) {
      // The same hits in the same order; scores carry a recency factor that moves between the two calls.
      const unscored = (hits: unknown) => (JSON.parse(JSON.stringify(hits)) as Record<string, unknown>[]).map(({ score: _score, ...hit }) => hit);
      const direct = await mcp.tools.amem_search({ query }) as { hits: unknown[] };
      const panel = await provider.snapshot({ after: 0, panel: "find", project: f.project, q: query });
      expect(unscored(panel.hits)).toEqual(unscored(direct.hits));
      const limited = await mcp.tools.amem_search({ query, limit: 10 }) as { hits: { view?: { id: string }; capture?: { id: number } }[] };
      const palette = await provider.snapshot({ after: 0, panel: "search", q: query, limit: 10 });
      expect((palette.hits as { id: string }[]).map(h => h.id)).toEqual(limited.hits.map(h => h.view?.id ?? `capture:${h.capture?.id}`));
    }
    expect(((await provider.snapshot({ after: 0, panel: "find", project: f.project, q: "console search" })).hits as unknown[]).length).toBeGreaterThan(0);
  } finally { mcp.close(); }
});

test("inbox items are the visible pending candidates, keyed by candidate id with a stable at", async () => {
  const f = fixture(), provider = await open(f.family);
  const items = (await provider.snapshot({ after: 0, panel: "inbox" })).items as { id: string; group: string; verbs: { id: string }[]; link: { panel: string; params: Record<string, string> } }[];
  const candidates = items.filter(i => i.group === "candidate");
  expect(candidates.map(i => i.id).sort()).toEqual([f.memory, f.fail].sort());
  expect(candidates[0]!.verbs.map(v => v.id)).toEqual(["accept", "reject"]);
  expect(candidates[0]!.link).toEqual({ panel: "review", params: { project: f.project, id: candidates[0]!.id } });
  // An inbox verb carries only the item id; the provider finds the project.
  expect(await provider.action({ action: "reject", id: f.fail })).toMatchObject({ ok: true });
});

test("amem setup console writes the manifest acon verifies, and undo removes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-console-setup-")); roots.push(root);
  const env = { AGENTHUB_HOME: join(root, "hub") }, file = join(root, "hub", "console", "plugins", "amem.json");
  expect(JSON.parse(await runCli(["setup", "console", "--json"], { env }))).toMatchObject({ change: "add", file });
  expect(existsSync(file)).toBe(false);
  expect(consoleSetup("apply", env)).toMatchObject({ change: "add" });
  expect(statSync(join(root, "hub", "console", "plugins")).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  expect(manifest).toEqual({ api: 1, tool: "amem", module: manifest.module, sha256: createHash("sha256").update(readFileSync(manifest.module)).digest("hex") });
  const scan = scanPlugins(join(root, "hub"));
  expect(scan.entries.map(e => [e.tool, e.status, e.reason])).toEqual([["amem", "verified", undefined]]);
  expect(consoleSetup("apply", env).change).toBe("unchanged");
  expect(JSON.parse(await runCli(["setup", "console", "--undo", "--json"], { env }))).toMatchObject({ change: "remove" });
  expect(existsSync(file)).toBe(false);
});

/** An empty family home under a fresh temp root, with the root's own project key. */
function bare() {
  const root = mkdtempSync(join(tmpdir(), "amem-console-")); roots.push(root);
  const family = join(root, "hub"), base = join(family, "memory");
  mkdirSync(base, { recursive: true });
  return { root, family, base, project: memoryProjectKey(root) };
}

test("Codex P2 (plugin.ts:392): a confirmed prune applies the previewed plan on the first confirmation", async () => {
  const f = bare(), now = Date.now() - 10_000;
  const store = new MemoryStore({ memoryDir: f.base, now: () => now });
  const id = store.note({ op: "note", project: f.project, scope: "project", tier: "short", kind: "finding", peer: "person", source: "person", text: "synthetic expired target", about: [], expires: new Date(now + 1000).toISOString() });
  store.close();
  process.env.AMEM_HOME = f.base;
  await runCli(["migrate", "--generation", "a".repeat(32), "--apply", "--json"], { cwd: f.root, env: {} });
  delete process.env.AMEM_HOME;
  const provider = await open(f.family), input = { action: "prune", project: f.project, cutoff: new Date().toISOString() };
  const preview = await provider.action(input) as { needsConfirm?: true; fingerprint: string; changes: unknown[] };
  expect(preview).toMatchObject({ ok: false, needsConfirm: true });
  expect(preview.changes).toHaveLength(1);
  await Bun.sleep(5); // a new plan made now would carry a different authoring time and seal
  expect(await provider.action({ ...input, confirmed: true, fingerprint: preview.fingerprint })).toEqual({ ok: true, message: "Pruned: 1 rows" });
  const after = new MemoryStore({ memoryDir: f.base });
  try { expect(after.get(id)).toBeUndefined(); } finally { after.close(); }
  // The kept plan is used once: confirming the same fingerprint again previews instead of applying.
  expect(await provider.action({ ...input, confirmed: true, fingerprint: preview.fingerprint })).toMatchObject({ ok: false, needsConfirm: true });
});

test("Codex P2 (plugin.ts:132): a shared home with one curated note lists its project, and Search returns the note", async () => {
  const f = bare(), store = new MemoryStore({ memoryDir: f.base });
  store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "Shared store discovery reaches the console", about: [] });
  store.close();
  const provider = await open(f.family);
  const found = await provider.snapshot({ after: 0, panel: "find", q: "discovery" });
  expect(found).toMatchObject({ projects: [f.project], project: f.project });
  expect((found.hits as unknown[]).length).toBe(1);
  expect(await provider.snapshot({ after: 0, panel: "find", project: f.project, q: "discovery" })).toMatchObject({ project: f.project });
  expect(((await provider.snapshot({ after: 0, panel: "search", q: "discovery" })).hits as unknown[]).length).toBe(1);
});

test("Codex P2 (plugin.ts:338): a gc preview of a shard over its cap names the rows trimming would remove", async () => {
  const f = bare(), store = new CaptureStore({ memoryDir: f.base, project: f.project, retentionDays: 100_000, capMb: 100_000 });
  const start = Date.now() - 3_600_000;
  for (let i = 0; i < 1000; i++) store.append({ project: f.project, agent: "kimi", event: "PostToolUse", excerpt: `row ${i} ${"z".repeat(1500)}`, at: new Date(start + i * 1000).toISOString() });
  const machineDir = store.dir; store.close();
  writeCaptureConfig(machineDir, { capMb: 1, retentionDays: 90 });
  const provider = await open(f.family), before = tree(f.base);
  const preview = await provider.action({ action: "gc" }) as { needsConfirm?: true; preview: string[]; changes: { op: string; note?: string }[]; warnings?: string[] };
  expect(preview.needsConfirm).toBe(true);
  const trimmed = Number(/(\d+) trimmed to fit 1 MB/.exec(preview.changes[0]?.note ?? "")?.[1]);
  expect(trimmed).toBeGreaterThan(0);
  expect(trimmed).toBeLessThan(1000);
  expect(preview.changes[0]).toMatchObject({ op: "delete" });
  expect(preview.preview[0]).toContain(`${trimmed} oldest unexpired row(s) over the 1 MB cap`);
  expect(preview.warnings?.[0]).toContain("whole batches of 256");
  expect(tree(f.base)).toEqual(before);
});

test("Codex P2 (plugin.ts:440): reject then undo restores a 31-day-old unshown candidate that retention deletes once rejected", async () => {
  const f = fixture(), created = Date.now() - 31 * 86_400_000;
  const old = new CandidateStore({ memoryDir: f.base, now: () => created });
  const id = old.put({ project: f.project, kind: "memory", text: "An old unshown candidate keeps its place" }, "public");
  old.close();
  const provider = await open(f.family);
  expect(await provider.action({ action: "reject", id, project: f.project })).toMatchObject({ ok: true, undo: { action: "reject_undo" } });
  expect(statusOf(f.base, id, f.project)).toBeUndefined(); // the next open's retention removed the decided 31-day-old row
  expect(await provider.action({ action: "reject_undo", id, project: f.project })).toEqual({ ok: true, message: "Reject undone; the candidate is pending again" });
  const after = new CandidateStore({ memoryDir: f.base });
  try { expect(after.get(id, f.project)).toMatchObject({ status: "pending", createdAt: new Date(created).toISOString() }); } finally { after.close(); }
});
