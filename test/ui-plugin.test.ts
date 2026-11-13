// The agent-console contract references the DOM lib; its ReadableStream then needs DOM's async-iterable part, or
// `for await` over a Bun stream elsewhere in this program stops type-checking.
/// <reference lib="dom.asynciterable" />
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import type { ConsolePlugin } from "@staix/agent-console/contract";
import { registerConsoleConformance } from "@staix/agent-console/conformance";
import { scanPlugins } from "../node_modules/@staix/agent-console/src/plugins.ts";
import { runCli } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import * as mcpModule from "../src/mcp-memory.ts";
import * as revisionModule from "../src/ui/snapshot-revision.ts";
import { pendingSummary } from "../src/memory/candidate-pending.ts";
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
const providers = new Set<Awaited<ReturnType<typeof plugin.open>>>();
const oldAmem = process.env.AMEM_HOME;
afterEach(() => { if (oldAmem === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldAmem; });
afterAll(async () => { for (const provider of providers) await provider.close(); providers.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
const open = async (family: string) => { const provider = await plugin.open({ home: family, log: () => {} }); providers.add(provider); return provider; };
async function readyInbox(provider: Awaited<ReturnType<typeof open>>) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const snapshot = await provider.snapshot({ after: 0, panel: "inbox" });
    if (snapshot.complete === true) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("fixture inbox did not complete");
}
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

test("the manifest declares one poll of Recap reuse without adding other panel cache policies", () => {
  expect(plugin.manifest.panels.find(panel => panel.id === "recap")).toMatchObject({ maxAgeMs: 15_000 });
  expect(plugin.manifest.panels.find(panel => panel.id === "recap")?.maxAgeMs).toBe(plugin.manifest.pollMs);
  expect(plugin.manifest.panels.map(panel => panel.id)).not.toContain("inbox");
  for (const id of ["capacity", "timeline"]) expect(plugin.manifest.panels.find(panel => panel.id === id)).not.toHaveProperty("maxAgeMs");
});

test("Recap memoizes its screened projection and unchanged cursor polls take under 100 ms", async () => {
  const f = fixture(), provider = await open(f.family), calls = spyOn(briefModule, "sessionStartBrief");
  try {
    const first = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(first.error).toBeUndefined(); expect(Number.isSafeInteger(first.cursor)).toBe(true);
    const started = performance.now();
    expect(await provider.snapshot({ after: Number(first.cursor), panel: "recap", project: f.project })).toEqual({ changed: false, cursor: first.cursor });
    expect(performance.now() - started).toBeLessThan(100);
    expect(await provider.snapshot({ after: 0, panel: "recap", project: f.project })).toEqual(first);
    expect(calls).toHaveBeenCalledTimes(1);
    const store = new MemoryStore({ memoryDir: f.base });
    try { store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "external recap revision marker", about: [] }); }
    finally { store.close(); }
    const changed = await provider.snapshot({ after: Number(first.cursor), panel: "recap", project: f.project });
    expect(changed.error).toBeUndefined(); expect(changed.cursor).not.toBe(first.cursor);
    expect(JSON.stringify(changed)).toContain("external recap revision marker"); expect(calls).toHaveBeenCalledTimes(2);
  } finally { calls.mockRestore(); }
});

test("Recap expires at the selected project's candidate day boundary even when another project masks the home summary", async () => {
  const day = 86400_000, start = Date.now(); let now = start;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const f = fixture(), olderProject = memoryProjectKey(join(f.root, "older-project"));
    ensureShardDescriptor(f.base, olderProject);
    const old = new CandidateStore({ memoryDir: f.base, now: () => start - 40 * day });
    try { old.put({ project: olderProject, kind: "memory", text: "Unshown older project candidate" }, "public"); }
    finally { old.close(); }
    const provider = await open(f.family), global = pendingSummary(f.base, undefined, now);
    expect(global.oldestExpiresInDays).toBe(7);
    const first = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(first.error).toBeUndefined(); expect(JSON.stringify(first.brief)).toContain("oldest expires in 30 days");
    now = start + day - 1;
    expect(await provider.snapshot({ after: Number(first.cursor), panel: "recap", project: f.project })).toEqual({ changed: false, cursor: first.cursor });
    now++;
    expect(pendingSummary(f.base, undefined, now)).toEqual(global);
    const changed = await provider.snapshot({ after: Number(first.cursor), panel: "recap", project: f.project });
    expect(changed.error).toBeUndefined(); expect(changed.changed).toBeUndefined(); expect(changed.cursor).not.toBe(first.cursor);
    expect(JSON.stringify(changed.brief)).toContain("oldest expires in 29 days");
    expect(await provider.snapshot({ after: Number(changed.cursor), panel: "recap", project: f.project })).toEqual({ changed: false, cursor: changed.cursor });
  } finally { clock.mockRestore(); }
});

test("all revision panels honor after, query selection and external source or policy changes", async () => {
  const f = fixture(), provider = await open(f.family);
  for (const panel of ["review", "recap", "work"]) {
    const first = await provider.snapshot({ after: 0, panel, project: f.project });
    expect(first.error, panel).toBeUndefined(); expect(Number.isSafeInteger(first.cursor), panel).toBe(true);
    expect(await provider.snapshot({ after: Number(first.cursor), panel, project: f.project }), panel).toEqual({ changed: false, cursor: first.cursor });
  }
  const review = await provider.snapshot({ after: 0, panel: "review", project: f.project, id: f.memory });
  const selected = await provider.snapshot({ after: Number(review.cursor), panel: "review", project: f.project, id: f.fail });
  expect(selected.selected).toBe(f.fail); expect(selected.cursor).not.toBe(review.cursor);
  const first = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
  const capture = new CaptureStore({ memoryDir: f.base, project: f.project });
  try { capture.append({ project: f.project, agent: "fixture", event: "PostToolUse", excerpt: "external capture revision marker" }); } finally { capture.close(); }
  const captured = await provider.snapshot({ after: Number(first.cursor), panel: "recap", project: f.project });
  expect(captured.error).toBeUndefined(); expect(captured.cursor).not.toBe(first.cursor);
  expect(JSON.stringify(captured)).toContain("external capture revision marker");
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["external capture revision marker"] }));
  const narrowed = await provider.snapshot({ after: Number(captured.cursor), panel: "recap", project: f.project });
  expect(narrowed.error).toBeUndefined(); expect(narrowed.changed).not.toBe(false);
  expect(JSON.stringify(narrowed)).not.toContain("external capture revision marker");
});

test("Capacity stays uncached when its external and rolling-time inputs have no complete revision", async () => {
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const f = fixture(), provider = await open(f.family);
    const first = await provider.snapshot({ after: 0, panel: "capacity", project: f.project });
    expect(first.error).toBeUndefined(); expect(first.cursor).toBeUndefined();
    now++;
    const second = await provider.snapshot({ after: 0, panel: "capacity", project: f.project });
    expect(second.error).toBeUndefined(); expect(second.changed).toBeUndefined(); expect(second.cursor).toBeUndefined();
    expect((second.report as { at: string }).at).not.toBe((first.report as { at: string }).at);
  } finally { clock.mockRestore(); }
});

test("a revision exception disables reuse while Recap, Timeline and Capacity still read fresh", async () => {
  const f = fixture(), provider = await open(f.family);
  const before = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
  expect(before.error).toBeUndefined();
  const revision = spyOn(revisionModule, "snapshotRevision").mockImplementation(() => { throw Error("injected inventory race"); });
  const brief = spyOn(briefModule, "sessionStartBrief");
  try {
    for (const panel of ["timeline", "capacity"]) {
      const fresh = await provider.snapshot({ after: 0, panel, project: f.project });
      expect(fresh.error, panel).toBeUndefined(); expect(fresh.changed).toBeUndefined();
    }
    expect(revision).not.toHaveBeenCalled();
    const fresh = await provider.snapshot({ after: Number(before.cursor), panel: "recap", project: f.project });
    expect(fresh.error).toBeUndefined(); expect(fresh.changed).toBeUndefined(); expect(Number.isSafeInteger(fresh.cursor)).toBe(true);
    const next = await provider.snapshot({ after: Number(fresh.cursor), panel: "recap", project: f.project });
    expect(next.error).toBeUndefined(); expect(next.changed).toBeUndefined(); expect(next.cursor).not.toBe(fresh.cursor);
    expect(brief).toHaveBeenCalledTimes(2);
    revision.mockRestore();
    const recovered = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(recovered.error).toBeUndefined();
    expect(await provider.snapshot({ after: Number(recovered.cursor), panel: "recap", project: f.project })).toEqual({ changed: false, cursor: recovered.cursor });
    expect(brief).toHaveBeenCalledTimes(3);
  } finally { revision.mockRestore(); brief.mockRestore(); }
});

test("an unrelated home symlink makes snapshots uncacheable without blanking healthy panels", async () => {
  const f = fixture(), provider = await open(f.family), target = join(f.root, "external.json"), link = join(f.base, "unrelated.json");
  writeFileSync(target, JSON.stringify({ fixture: true })); symlinkSync(target, link);
  for (const panel of ["recap", "timeline", "capacity"]) {
    const fresh = await provider.snapshot({ after: 0, panel, project: f.project });
    expect(fresh.error, panel).toBeUndefined(); expect(fresh.changed).toBeUndefined();
    if (panel === "recap") expect((fresh.brief as briefModule.BriefResult).context).toStartWith("Untrusted project memory data");
  }
  rmSync(link);
  const recovered = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
  expect(recovered.error).toBeUndefined();
  expect(await provider.snapshot({ after: Number(recovered.cursor), panel: "recap", project: f.project })).toEqual({ changed: false, cursor: recovered.cursor });
});

test("a capture write during Recap returns the read snapshot uncached, then the next poll caches", async () => {
  const f = fixture(), provider = await open(f.family), original = briefModule.sessionStartBrief; let reads = 0;
  const brief = spyOn(briefModule, "sessionStartBrief").mockImplementation(async options => {
    const value = await original(options);
    if (++reads === 1) {
      const capture = new CaptureStore({ memoryDir: f.base, project: f.project });
      try { capture.append({ project: f.project, agent: "fixture", event: "PostToolUse", excerpt: "capture landed during Recap" }); } finally { capture.close(); }
    }
    return value;
  });
  try {
    const first = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(first.error).toBeUndefined(); expect(first.changed).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("capture landed during Recap"); expect(reads).toBe(1);
    const next = await provider.snapshot({ after: Number(first.cursor), panel: "recap", project: f.project });
    expect(next.error).toBeUndefined(); expect(JSON.stringify(next)).toContain("capture landed during Recap");
    expect(await provider.snapshot({ after: Number(next.cursor), panel: "recap", project: f.project })).toEqual({ changed: false, cursor: next.cursor });
    expect(reads).toBe(2);
  } finally { brief.mockRestore(); }
});

test("expiry crossing during Recap affects reuse without blanking the data just read", async () => {
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  let restoreBrief: (() => void) | undefined;
  try {
    const f = fixture(), store = new MemoryStore({ memoryDir: f.base });
    try {
      const id = store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "expires while Recap returns", about: [] });
      store.demote(id, "person", f.project, new Date(now + 1000).toISOString());
    } finally { store.close(); }
    const provider = await open(f.family), original = briefModule.sessionStartBrief; let reads = 0;
    const brief = spyOn(briefModule, "sessionStartBrief").mockImplementation(async options => {
      const value = await original(options); if (++reads === 1) now += 1001; return value;
    });
    restoreBrief = () => { brief.mockRestore(); };
    const first = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(first.error).toBeUndefined(); expect(JSON.stringify(first)).toContain("expires while Recap returns"); expect(reads).toBe(1);
    const next = await provider.snapshot({ after: Number(first.cursor), panel: "recap", project: f.project });
    expect(next.error).toBeUndefined(); expect(JSON.stringify(next)).not.toContain("expires while Recap returns");
    expect(await provider.snapshot({ after: Number(next.cursor), panel: "recap", project: f.project })).toEqual({ changed: false, cursor: next.cursor });
    expect(reads).toBe(2);
  } finally { restoreBrief?.(); clock.mockRestore(); }
});

test("an action during Recap causes one fresh post-action read", async () => {
  const f = fixture(), provider = await open(f.family), original = briefModule.sessionStartBrief; let reads = 0;
  const brief = spyOn(briefModule, "sessionStartBrief").mockImplementation(async options => {
    const value = await original(options);
    if (++reads === 1) expect(await provider.action({ action: "reject", id: f.memory, project: f.project })).toMatchObject({ ok: true });
    return value;
  });
  try {
    const first = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(first.error).toBeUndefined(); expect(JSON.stringify(first)).toContain("1 candidate pending");
    expect(JSON.stringify(first)).not.toContain("2 candidates pending"); expect(reads).toBe(2);
    const next = await provider.snapshot({ after: Number(first.cursor), panel: "recap", project: f.project });
    expect(next.error).toBeUndefined();
    expect(await provider.snapshot({ after: Number(next.cursor), panel: "recap", project: f.project })).toEqual({ changed: false, cursor: next.cursor });
    expect(reads).toBe(3);
  } finally { brief.mockRestore(); }
});

test("post-action Recap rereads project selection when the last candidate-only project disappears", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-console-candidate-only-")); roots.push(root);
  const family = join(root, "hub"), base = join(family, "memory"), project = "candidate-only";
  const candidates = new CandidateStore({ memoryDir: base });
  const id = candidates.put({ project, kind: "memory", text: "only waiting fixture" }, "public"); candidates.close();
  const provider = await open(family), original = briefModule.sessionStartBrief; let reads = 0;
  const brief = spyOn(briefModule, "sessionStartBrief").mockImplementation(async options => {
    const value = await original(options);
    if (++reads === 1) expect(await provider.action({ action: "reject", id, project })).toMatchObject({ ok: true });
    return value;
  });
  try {
    const changed = await provider.snapshot({ after: 0, panel: "recap", project });
    expect(changed.error).toBeUndefined(); expect(changed.projects).toEqual([]); expect(changed.project).toBeNull();
    expect(changed.brief).toBeUndefined(); expect(Number.isSafeInteger(changed.cursor)).toBe(true); expect(reads).toBe(1);
  } finally { brief.mockRestore(); }
});

test("Timeline refreshes referenced-file stale markers without a memory-store write", async () => {
  const f = fixture(), file = join(f.base, "public.txt");
  writeFileSync(file, "fixture source"); utimesSync(file, new Date(0), new Date(0));
  const store = new MemoryStore({ memoryDir: f.base }); let id: string;
  try { id = store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "referenced file marker", about: ["path:public.txt"] }); }
  finally { store.close(); }
  const provider = await open(f.family), first = await provider.snapshot({ after: 0, panel: "timeline", project: f.project });
  expect(first.error).toBeUndefined(); expect(first.cursor).toBeUndefined();
  expect((first.entries as { id: string; stale?: boolean }[]).find(row => row.id === id)!.stale).toBeUndefined();
  utimesSync(file, new Date(), new Date(Date.now() + 60_000));
  const changed = await provider.snapshot({ after: 0, panel: "timeline", project: f.project });
  expect(changed.error).toBeUndefined(); expect(changed.changed).toBeUndefined(); expect(changed.cursor).toBeUndefined();
  expect((changed.entries as { id: string; stale?: boolean }[]).find(row => row.id === id)!.stale).toBe(true);
});

test("provider open warms Review once and successful actions invalidate its cached rows", async () => {
  const f = fixture(), started = performance.now(), provider = await open(f.family);
  expect(performance.now() - started).toBeLessThan(5000);
  const first = await provider.snapshot({ after: 0, panel: "review", project: f.project });
  expect((first.rows as { id: string }[]).some(row => row.id === f.memory)).toBe(true);
  expect(await provider.action({ action: "reject", id: f.memory, project: f.project })).toMatchObject({ ok: true });
  const changed = await provider.snapshot({ after: Number(first.cursor), panel: "review", project: f.project });
  expect(changed.error).toBeUndefined(); expect(changed.cursor).not.toBe(first.cursor);
  expect((changed.rows as { id: string }[]).some(row => row.id === f.memory)).toBe(false);
});

test("a cached Recap cannot retain a short note after its exact expiry without a write", async () => {
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const f = fixture(), store = new MemoryStore({ memoryDir: f.base });
    try {
      const id = store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "exact expiry recap marker", about: [] });
      store.demote(id, "person", f.project, new Date(now + 1000).toISOString());
    } finally { store.close(); }
    const provider = await open(f.family), first = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(first.error).toBeUndefined(); expect(JSON.stringify(first)).toContain("exact expiry recap marker");
    now += 1001;
    const expired = await provider.snapshot({ after: Number(first.cursor), panel: "recap", project: f.project });
    expect(expired.error).toBeUndefined(); expect(expired.changed).not.toBe(false);
    expect(JSON.stringify(expired)).not.toContain("exact expiry recap marker");
  } finally { clock.mockRestore(); }
});

test("project discovery still prunes expired shown candidates before the Recap count", async () => {
  const f = fixture(), now = Date.now(), candidates = new CandidateStore({ memoryDir: f.base, now: () => now - 40 * 86400_000 });
  const old = candidates.put({ project: f.project, kind: "memory", text: "expired shown fixture" }, "public"); candidates.close();
  const db = new Database(join(f.base, "candidates.db"));
  try { db.query("UPDATE candidates SET shown_at = ? WHERE id = ?").run(now - 8 * 86400_000, old); } finally { db.close(); }
  const provider = await open(f.family), review = await provider.snapshot({ after: 0, panel: "review", project: f.project });
  expect((review.rows as { id: string }[]).map(row => row.id).sort()).toEqual([f.memory, f.fail].sort());
  const recap = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
  expect(recap.error).toBeUndefined(); expect(JSON.stringify(recap)).toContain("2 candidates pending");
  expect(JSON.stringify(recap)).not.toContain("3 candidates pending");
});

test("Timeline re-reads instead of caching a row whose expiry crosses the MCP return", async () => {
  const f = fixture(); let now = Date.now(), calls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now), original = mcpModule.createMemoryMcp;
  const factory = spyOn(mcpModule, "createMemoryMcp").mockImplementation(options => {
    const reader = original(options), timeline = reader.tools.amem_timeline;
    reader.tools.amem_timeline = async args => {
      calls++;
      if (calls !== 1) return timeline(args);
      const expiresAt = now + 1000;
      const selected = [{ id: "e".repeat(32), tier: "short", kind: "finding", text: "expires during return", expiresAt: new Date(expiresAt).toISOString() }];
      await Promise.resolve(); now = expiresAt + 1;
      return selected;
    };
    return reader;
  });
  try {
    const provider = await open(f.family), first = await provider.snapshot({ after: 0, panel: "timeline", project: f.project });
    expect(first.error).toBeUndefined(); expect(first.cursor).toBeUndefined();
    const recovered = await provider.snapshot({ after: 0, panel: "timeline", project: f.project });
    expect(recovered.error).toBeUndefined(); expect(JSON.stringify(recovered)).not.toContain("expires during return");
    const third = await provider.snapshot({ after: 0, panel: "timeline", project: f.project });
    expect(third.changed).toBeUndefined(); expect(third.cursor).toBeUndefined();
    expect(calls).toBe(3);
  } finally { factory.mockRestore(); clock.mockRestore(); }
});

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
      if (panel === "inbox") await readyInbox(provider); else await provider.snapshot({ after: 0, panel, project: f.project, q: "console" });
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
  const items = (await readyInbox(provider)).items as { id: string; group: string; verbs: { id: string }[]; link: { panel: string; params: Record<string, string> } }[];
  const candidates = items.filter(i => i.group === "candidate");
  expect(candidates.map(i => i.id).sort()).toEqual([f.memory, f.fail].sort());
  expect(candidates[0]!.verbs.map(v => v.id)).toEqual(["accept", "reject"]);
  expect(candidates[0]!.link).toEqual({ panel: "review", params: { project: f.project, id: candidates[0]!.id } });
  // An inbox verb carries only the item id; the provider finds the project.
  expect(await provider.action({ action: "reject", id: f.fail })).toMatchObject({ ok: true });
}, 20_000);

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


test("an unavailable explicit project never falls back to another project's memory", async () => {
  const f = fixture(), provider = await open(f.family);
  expect((await provider.snapshot({ after: 0, panel: "find", project: f.project, q: "console" })).hits).not.toEqual([]);
  for (const panel of ["find", "search", "timeline", "work", "goals", "review", "recap", "capacity"]) {
    const result = await provider.snapshot({ after: 0, panel, project: "missing-project", q: "console" });
    expect(result).toMatchObject({ project: null, error: expect.stringContaining("choose an active project") });
    expect(result.hits).toBeUndefined();
    expect(result.rows).toBeUndefined();
    expect(result.entries).toBeUndefined();
  }
  // An omitted project still uses the person's previous valid selection.
  expect(await provider.snapshot({ after: 0, panel: "find", q: "console" })).toMatchObject({ project: f.project });
});

test("acon refuses a changed module hash until setup refreshes the manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-console-hash-")); roots.push(root);
  const family = join(root, "hub"), module = join(root, "plugin.ts"), env = { AGENTHUB_HOME: family };
  writeFileSync(module, "export default {};\n");
  consoleSetup("apply", env, module);
  expect(scanPlugins(family).entries[0]?.status).toBe("verified");
  writeFileSync(module, "export default { changed: true };\n");
  expect(scanPlugins(family).entries[0]?.status).not.toBe("verified");
  const before = tree(family);
  expect(consoleSetup("preview", env, module).change).toBe("replace");
  expect(tree(family)).toEqual(before);
  consoleSetup("apply", env, module);
  expect(scanPlugins(family).entries[0]?.status).toBe("verified");
});
