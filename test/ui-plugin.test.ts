// The agent-console contract references the DOM lib; its ReadableStream then needs DOM's async-iterable part, or
// `for await` over a Bun stream elsewhere in this program stops type-checking.
/// <reference lib="dom.asynciterable" />
import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ConsolePlugin } from "@staix/agent-console/contract";
import { registerConsoleConformance } from "@staix/agent-console/conformance";
import { scanPlugins } from "../node_modules/@staix/agent-console/src/plugins.ts";
import { runCli } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { ensureShardDescriptor } from "../src/memory/shard.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { consoleSetup } from "../src/setup-console.ts";
import { plugin } from "../src/ui/plugin.ts";

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
/** Every file below the home with its size and mtime: a write anywhere changes it. SQLite's `-shm` read-lock index changes on any open and holds no data. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const name of readdirSync(d).sort()) { const p = join(d, name), s = lstatSync(p); if (s.isDirectory()) walk(p); else if (!name.endsWith("-shm")) out.push(`${p} ${s.size} ${s.mtimeMs}`); } };
  walk(dir); return out;
}
const noteOf = (base: string, id: string, project: string) => { const store = new MemoryStore({ memoryDir: base, screen: () => "skip" }); try { return store.get(id, project); } finally { store.close(); } };
const statusOf = (base: string, id: string, project: string) => { const c = new CandidateStore({ memoryDir: base }); try { return c.get(id, project)?.status; } finally { c.close(); } };

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
