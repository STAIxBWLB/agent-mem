// The agent-console contract references the DOM lib; its ReadableStream then needs DOM's async-iterable part, or
// `for await` over a Bun stream elsewhere in this program stops type-checking.
/// <reference lib="dom.asynciterable" />
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
import * as pendingModule from "../src/memory/candidate-pending.ts";
import { pendingSummary } from "../src/memory/candidate-pending.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { CaptureStore, writeCaptureConfig } from "../src/memory/capture.ts";
import { appendMetrics } from "../src/memory/metrics.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { appendAlias, ensureShardDescriptor, shardDir } from "../src/memory/shard.ts";
import * as shardModule from "../src/memory/shard.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { consoleSetup } from "../src/setup-console.ts";
import { plugin } from "../src/ui/plugin.ts";
import * as briefModule from "../src/session-brief.ts";
import { configuredPolicyOptions } from "../src/memory/config.ts";
import { withBriefSnapshot } from "../src/memory/doctor.ts";
import { realPath } from "../src/memory/platform.ts";

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
  const memory = candidates.put({ project, kind: "memory", text: "Console accept writes the same note as review accept", title: "Console accept", noteKind: "decision" }, "public", { session: "0123456789abcdef", peer: "codex", at: "2026-11-16T07:00:00.000Z" });
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
  // #359: capacity recomputes on every provider call (no cursor), so the shell may reuse it for one poll.
  expect(plugin.manifest.panels.find(panel => panel.id === "capacity")?.maxAgeMs).toBe(plugin.manifest.pollMs);
  for (const id of ["timeline"]) expect(plugin.manifest.panels.find(panel => panel.id === id)).not.toHaveProperty("maxAgeMs");
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

test("Recap reuses unchanged copies and recopies after a work-log append", async () => {
  const f = fixture(), work = new WorkListStore({ base: f.base, project: f.project, policy: () => true });
  await work.write("snapshot-test", { task: "first task", status: "doing" }); work.close();
  const provider = await open(f.family), copies = spyOn(fs, "copyFileSync");
  try {
    const first = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(first.error).toBeUndefined(); const initialCopies = copies.mock.calls.length; expect(initialCopies).toBeGreaterThan(0);
    const warm = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(warm.error).toBeUndefined(); expect(copies.mock.calls.length).toBe(initialCopies);
    const writer = new WorkListStore({ base: f.base, project: f.project, policy: () => true });
    try { await writer.write("snapshot-test", { task: "second task", status: "doing" }); } finally { writer.close(); }
    const changed = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(changed.error).toBeUndefined(); expect(copies.mock.calls.length).toBeGreaterThan(initialCopies);
    expect(JSON.stringify(changed)).toContain("second task");
  } finally { copies.mockRestore(); }
});

test("Recap excludes observation journals while a capture write still invalidates its result", async () => {
  const f = fixture(), metrics = join(f.base, "metrics.jsonl"), variants = join(f.base, "record-variants.jsonl");
  const variantTemp = join(f.base, "record-variants.jsonl.tmp-12345678-1234-4abc-8abc-123456789abc");
  appendMetrics(f.base, [{ at: new Date().toISOString(), kind: "hook", wallMs: 1 }]);
  writeFileSync(variants, "synthetic observation\n");
  const writer = new CaptureStore({ memoryDir: f.base, project: f.project, cwd: f.root });
  const provider = await open(f.family), log = realPath(join(f.base, "log", readdirSync(join(f.base, "log")).find(name => name.endsWith(".jsonl"))!));
  const copyOriginal = fs.copyFileSync, readOriginal = fs.readFileSync, openOriginal = fs.openSync, existsOriginal = fs.existsSync, copied: string[] = [], read: string[] = [];
  let writes = 0;
  const copies = spyOn(fs, "copyFileSync").mockImplementation((from, to, flags) => {
    copied.push(String(from)); const value = copyOriginal(from, to, flags);
    if (String(from) === log && writes < 3) {
      writes++;
      writer.append({ project: f.project, agent: "fixture", event: "PostToolUse", excerpt: "new capture during recap" });
      appendMetrics(f.base, [{ at: new Date().toISOString(), kind: "hook", wallMs: 1 }]);
      writeFileSync(variantTemp, "synthetic observation\n");
    }
    return value;
  });
  const reads = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file === "string" && (file.endsWith("/metrics.jsonl") || file.endsWith("/record-variants.jsonl"))) read.push(file);
    return Reflect.apply(readOriginal, fs, [file, ...args]);
  }) as typeof fs.readFileSync);
  const opened = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
    const readAccess = typeof flags === "number" ? (flags & 3) === 0 : typeof flags === "string" && flags.startsWith("r");
    if (readAccess && typeof file === "string" && (file.endsWith("/metrics.jsonl") || file.endsWith("/record-variants.jsonl"))) read.push(file);
    return openOriginal(file, flags, mode);
  }) as typeof fs.openSync);
  const exists = spyOn(fs, "existsSync").mockImplementation(file => {
    if (typeof file === "string" && (file.endsWith("/metrics.jsonl") || file.endsWith("/record-variants.jsonl"))) read.push(file);
    return existsOriginal(file);
  });
  try {
    const first = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(first.error).toBeUndefined(); expect(writes).toBeGreaterThan(0);
    expect(copied).toContain(log);
    expect(copied).not.toContain(metrics); expect(copied).not.toContain(variants); expect(copied).not.toContain(variantTemp);
    expect(read).toEqual([]);
    expect(JSON.stringify(first)).toContain("new capture during recap");
    fs.renameSync(variantTemp, variants);
    const next = await provider.snapshot({ after: Number(first.cursor), panel: "recap", project: f.project });
    expect(next.error).toBeUndefined();
    if (next.changed !== false) expect(JSON.stringify(next)).toContain("new capture during recap");
  } finally { exists.mockRestore(); opened.mockRestore(); reads.mockRestore(); copies.mockRestore(); writer.close(); }
});

test("Recap retains the 64 MiB authoritative copy limit", async () => {
  const f = fixture(), file = join(f.base, "log", "oversized-fixture.bin");
  const fd = fs.openSync(file, "w", 0o600);
  try { fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
  await expect(withBriefSnapshot(f.base, f.project, async () => null)).rejects.toThrow("recap snapshot exceeds the 64 MiB copy limit");
});

test("Recap invalidates when a copied input omitted from the broad revision changes", async () => {
  const f = fixture(), extra = join(f.base, "log", "snapshot-input.bin"); writeFileSync(extra, "first");
  const provider = await open(f.family), brief = spyOn(briefModule, "sessionStartBrief");
  try {
    expect((await provider.snapshot({ after: 0, panel: "recap", project: f.project })).error).toBeUndefined();
    expect((await provider.snapshot({ after: 0, panel: "recap", project: f.project })).error).toBeUndefined();
    expect(brief).toHaveBeenCalledTimes(1);
    appendFileSync(extra, " changed");
    expect((await provider.snapshot({ after: 0, panel: "recap", project: f.project })).error).toBeUndefined();
    expect(brief).toHaveBeenCalledTimes(2);
  } finally { brief.mockRestore(); }
});

for (const interruptions of [1, 3]) test(`Recap retries ${interruptions} concurrent copy change(s) with a bounded remedy`, async () => {
  const f = fixture(), logs: string[] = [], provider = await plugin.open({ home: f.family, log: line => logs.push(line) }); providers.add(provider);
  const source = realPath(join(f.base, "log", readdirSync(join(f.base, "log")).find(name => name.endsWith(".jsonl"))!));
  const original = fs.copyFileSync; let injected = 0;
  const copies = spyOn(fs, "copyFileSync").mockImplementation((from, to, flags) => {
    original(from, to, flags);
    if (String(from) === source && injected < interruptions) { injected++; appendFileSync(source, "\n"); }
  });
  try {
    const result = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(injected).toBe(interruptions);
    if (interruptions === 1) {
      expect(result.error).toBeUndefined();
      const copied = copies.mock.calls.length;
      expect((await provider.snapshot({ after: 0, panel: "recap", project: f.project })).error).toBeUndefined();
      expect(copies.mock.calls.length).toBe(copied);
    }
    else expect(result.error).toBe("recap source changed during snapshot after 3 attempts; wait for memory writes to settle, then retry Recap.");
    expect(logs.filter(line => line.startsWith("amem: recap cache miss:"))).toEqual(["amem: recap cache miss: failed copy"]);
  } finally { copies.mockRestore(); }
});

test("Recap logs one content-free reason when a revision is unavailable", async () => {
  const f = fixture(), logs: string[] = [], provider = await plugin.open({ home: f.family, log: line => logs.push(line) }); providers.add(provider);
  const revision = spyOn(revisionModule, "snapshotRevision").mockImplementation(() => { throw Error("private fixture detail"); });
  try {
    expect((await provider.snapshot({ after: 0, panel: "recap", project: f.project })).error).toBeUndefined();
    expect(logs.filter(line => line.startsWith("amem: recap cache miss:"))).toEqual(["amem: recap cache miss: uncacheable selection"]);
    expect(logs.filter(line => line.startsWith("amem: recap cache miss:")).join()).not.toContain(f.project);
  } finally { revision.mockRestore(); }
});

test("Recap logs one content-free reason when its cached revision changes", async () => {
  const f = fixture(), logs: string[] = [], provider = await plugin.open({ home: f.family, log: line => logs.push(line) }); providers.add(provider);
  expect((await provider.snapshot({ after: 0, panel: "recap", project: f.project })).error).toBeUndefined();
  logs.length = 0;
  const store = new MemoryStore({ memoryDir: f.base });
  try { store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "fixture revision", about: [] }); } finally { store.close(); }
  expect((await provider.snapshot({ after: 0, panel: "recap", project: f.project })).error).toBeUndefined();
  expect(logs.filter(line => line.startsWith("amem: recap cache miss:"))).toEqual(["amem: recap cache miss: revision change"]);
});

test("Recap logs one content-free reason when selected candidate timing is unavailable", async () => {
  const f = fixture(), logs: string[] = [], provider = await plugin.open({ home: f.family, log: line => logs.push(line) }); providers.add(provider);
  const original = pendingModule.pendingSummary;
  const pending = spyOn(pendingModule, "pendingSummary").mockImplementation(((base, projects, now, strict, onExpiry) =>
    projects && strict ? null : Reflect.apply(original, undefined, [base, projects, now, strict, onExpiry])) as typeof pendingModule.pendingSummary);
  try {
    expect((await provider.snapshot({ after: 0, panel: "recap", project: f.project })).error).toBeUndefined();
    expect(logs.filter(line => line.startsWith("amem: recap cache miss:"))).toEqual(["amem: recap cache miss: onExpiry -Infinity"]);
  } finally { pending.mockRestore(); }
});

test("Recap reports a directory that keeps changing after the retry bound", async () => {
  const f = fixture(), provider = await open(f.family), directory = join(f.base, "log");
  const source = realPath(join(directory, readdirSync(directory).find(name => name.endsWith(".jsonl"))!));
  const original = fs.copyFileSync; let injected = 0;
  const copies = spyOn(fs, "copyFileSync").mockImplementation((from, to, flags) => {
    original(from, to, flags);
    if (String(from) === source && injected < 3) writeFileSync(join(directory, `added-${++injected}.txt`), "fixture");
  });
  try {
    const result = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(injected).toBe(3);
    expect(result.error).toBe("recap source directory changed during snapshot after 3 attempts; wait for memory writes to settle, then retry Recap.");
  } finally { copies.mockRestore(); }
});

test("Recap retries a file removed while it is being copied", async () => {
  const f = fixture(), file = join(f.base, "log", "transient-input.bin"); writeFileSync(file, "fixture");
  const source = realPath(file);
  const provider = await open(f.family), original = fs.copyFileSync; let removed = false;
  const copies = spyOn(fs, "copyFileSync").mockImplementation((from, to, flags) => {
    if (!removed && String(from) === source) { removed = true; rmSync(source); }
    return original(from, to, flags);
  });
  try {
    const result = await provider.snapshot({ after: 0, panel: "recap", project: f.project });
    expect(removed).toBe(true); expect(result.error).toBeUndefined();
  } finally { copies.mockRestore(); }
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
  // #323 AC2: the Review rows carry the recorded origin ids, or null when the proposer supplied none.
  const rowsOf = (snapshot: unknown) => (snapshot as { rows: { id: string; origin: unknown }[] }).rows;
  expect(rowsOf(review).find(row => row.id === f.memory)?.origin).toEqual({ session: "0123456789abcdef", peer: "codex", at: "2026-11-16T07:00:00.000Z" });
  expect(rowsOf(review).find(row => row.id === f.fail)?.origin).toBeNull();
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

test("Capacity reads fresh hook metrics even when reusable panel revisions ignore them", async () => {
  const f = fixture(), provider = await open(f.family);
  const first = await provider.snapshot({ after: 0, panel: "capacity", project: f.project });
  expect(first.error).toBeUndefined();
  appendMetrics(f.base, [{ at: new Date().toISOString(), kind: "hook", wallMs: 123 }]);
  const next = await provider.snapshot({ after: 0, panel: "capacity", project: f.project });
  expect(next.error).toBeUndefined();
  expect((next.report as { metrics: { samples: number } }).metrics.samples)
    .toBeGreaterThan((first.report as { metrics: { samples: number } }).metrics.samples);
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
    // #359: the project picker cache now consults the revision on every panel; a revision failure only disables reuse, never the panel.
    expect(revision).toHaveBeenCalled();
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

test("private brief copies retry a live forget without exposing the forgotten row and clean every scratch store", async () => {
  const f = fixture(), copies: string[] = []; let calls = 0;
  const result = await withBriefSnapshot(f.base, f.project, async measureOnly => {
    if (measureOnly.curated) copies.push(measureOnly.curated.profile.home);
    const brief = await briefModule.sessionStartBrief({ cwd: f.base, base: f.base, project: f.project, repository: false, measureOnly });
    if (++calls === 1) {
      const store = new MemoryStore({ memoryDir: f.base });
      try { store.forget(f.noteId, "person", f.project); } finally { store.close(); }
    }
    return brief;
  });
  expect(calls).toBe(2); expect(result.context).not.toContain("screened amem search index");
  expect(copies).toHaveLength(2); for (const copy of copies) expect(existsSync(copy)).toBe(false);
});

test("a recap binding change is refused without retry", async () => {
  const f = fixture(); let calls = 0;
  await expect(withBriefSnapshot(f.base, f.project, async () => {
    calls++;
    appendAlias(f.base, { alias: "example.test/changed-alias", key: f.project, actor: "person", machine: "a".repeat(16) });
    return null;
  })).rejects.toThrow("recap binding changed");
  expect(calls).toBe(1);
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

test("#525: the picker marks projects outside the activated inventory by class, and each marked project's panels name that class", async () => {
  // A real activated placement home, so the inventory proof is the production one, not a stub.
  const { closeInventoryFixtures, inventoryFixture } = await import("./fakes/sync-placement-inventory.ts");
  const { applyRealmAdmission } = await import("../src/memory/sync-placement-realm-admission.ts");
  const admitted = "example.test/placement/admitted", localKey = "scratch/widget@1a2b3c4d",
    captured = "https://github.com/acme/captured.git", scaffold = "https://github.com/acme/scaffold.git",
    overfull = "https://github.com/acme/overfull.git";
  try {
    const f = await inventoryFixture(1, [admitted], true);
    // The three states #525 measured, each proved by its own evidence: a local-key project, a capture-only store and an
    // empty scaffold a candidate put on the list. None holds a curated marker, so none is opened here.
    for (const key of [localKey, captured, scaffold, overfull]) ensureShardDescriptor(f.home, key);
    const rows = new CaptureStore({ memoryDir: f.home, project: captured });
    try { rows.append({ project: captured, agent: "fixture", event: "PostToolUse", excerpt: "fixture capture row" }); } finally { rows.close(); }
    // More machine directories than the class scan's bound (64) and no store among them: the scan cannot rule capture out,
    // so the class is unverified rather than the empty scaffold's no-memory, whatever order the filesystem lists them in.
    const machineRoot = join(shardDir(f.home, overfull), "machine");
    for (let index = 0; index < 65; index++) mkdirSync(join(machineRoot, `m${String(index).padStart(2, "0")}`), { recursive: true });
    const provider = await open(f.root);
    const snapshot = await provider.snapshot({ after: 0, panel: "review" });
    // AC1: all five listed, and exactly the four that cannot open are marked with their own class.
    expect([...(snapshot.projects as string[])].sort()).toEqual([admitted, captured, scaffold, localKey, overfull].sort());
    expect(snapshot.gaps).toEqual({ [localKey]: "local-key", [captured]: "capture-only", [scaffold]: "no-memory", [overfull]: "unverified" });
    // AC2 and AC3: each marked project's Timeline and Work state the class and the next step for that class, with no key,
    // path or name in the text.
    const classes: Record<string, string> = { [localKey]: "class=local-key", [captured]: "class=capture-only", [scaffold]: "class=no-memory", [overfull]: "class=unverified" };
    for (const [key, cls] of Object.entries(classes)) for (const panel of ["timeline", "work"]) {
      const refused = await provider.snapshot({ after: 0, panel, project: key }), text = String(refused.error);
      expect(refused.project, `${panel} ${cls}`).toBe(key);
      expect(text, `${panel} ${cls}`).toContain("outside the activated inventory");
      expect(text, `${panel} ${cls}`).toContain(cls);
      expect(text, `${panel} ${cls}`).toContain(`keyHash=${createHash("sha256").update(key).digest("hex")}`);
      expect(text, `${panel} ${cls}`).not.toContain(key);
      expect(text, `${panel} ${cls}`).not.toContain(f.home);
      expect(text, `${panel} ${cls}`).not.toContain(".git");
      expect(text, `${panel} ${cls}`).not.toContain("/projects/");
    }
    // AC2: an admitted project keeps its memory, and every listing carries the same marks.
    const timeline = await provider.snapshot({ after: 0, panel: "timeline", project: admitted });
    expect(timeline.error).toBeUndefined();
    expect(JSON.stringify(timeline)).toContain(`inventory note for ${admitted}`);
    expect(timeline.gaps).toEqual(snapshot.gaps);
    expect((await provider.snapshot({ after: 0, panel: "work", project: admitted })).error).toBeUndefined();
    // The class comes from the activated inventory, so admitting the realm re-derives the marks on the next snapshot.
    expect(await applyRealmAdmission(f.home, captured, { mode: "apply" })).toMatchObject({ state: "admitted" });
    const afterAdmission = await provider.snapshot({ after: 0, panel: "review" });
    expect(afterAdmission.projects).toContain(captured);
    expect(afterAdmission.gaps).toEqual({ [localKey]: "local-key", [scaffold]: "no-memory", [overfull]: "unverified" });
  } finally { closeInventoryFixtures(); }
}, 120_000);

test("#525: an unavailable inventory proof is retried at the same revision and never enters a cached payload", async () => {
  const { closeInventoryFixtures, inventoryFixture } = await import("./fakes/sync-placement-inventory.ts");
  const admitted = "example.test/placement/admitted", localKey = "scratch/widget@1a2b3c4d";
  // The proof is unavailable for the whole first call, which is what a transient binding or inventory read error looks like.
  const spy = spyOn(shardModule, "placementRealmView").mockReturnValue(undefined);
  try {
    const f = await inventoryFixture(1, [admitted]);
    ensureShardDescriptor(f.home, localKey);
    const provider = await open(f.root);
    const blocked = await provider.snapshot({ after: 0, panel: "review" });
    // Nothing was proved, so no realm claims a class: every project reads unverified.
    expect(blocked.gaps).toEqual({ [admitted]: "unverified", [localKey]: "unverified" });
    expect(Number.isSafeInteger(blocked.cursor)).toBe(true);
    spy.mockRestore();
    // Same revision and the cursor of the unproved reply: neither the view nor its payload was retained.
    const recovered = await provider.snapshot({ after: Number(blocked.cursor), panel: "review" });
    expect(recovered.changed).toBeUndefined();
    expect(recovered.gaps).toEqual({ [localKey]: "local-key" });
  } finally { spy.mockRestore(); closeInventoryFixtures(); }
}, 120_000);

test("#525: capture evidence that cannot be proved is unverified, and a store inside the scan still proves capture", async () => {
  const { closeInventoryFixtures, inventoryFixture } = await import("./fakes/sync-placement-inventory.ts");
  const admitted = "example.test/placement/admitted", linked = "https://github.com/acme/linked.git",
    loose = "https://github.com/acme/loose.git", stray = "https://github.com/acme/stray.git",
    dense = "https://github.com/acme/dense.git", empty = "https://github.com/acme/empty.git", denseLast = "https://github.com/acme/dense-last.git",
    linkedMachine = "https://github.com/acme/linked-machine.git";
  try {
    const f = await inventoryFixture(1, [admitted]);
    for (const key of [linked, loose, stray, dense, empty, denseLast]) ensureShardDescriptor(f.home, key);
    // A real capture store, then its database loosened to group/world write: present bytes this user no longer alone owns.
    const looseStore = new CaptureStore({ memoryDir: f.home, project: loose });
    let looseDir: string;
    try { looseStore.append({ project: loose, agent: "fixture", event: "PostToolUse", excerpt: "fixture capture row" }); looseDir = looseStore.dir; } finally { looseStore.close(); }
    fs.chmodSync(join(looseDir, "capture.db"), 0o666);
    // A machine id that is a link to that same store: the store exists, but not at a path this class may follow.
    const linkedRoot = join(shardDir(f.home, linked), "machine");
    mkdirSync(linkedRoot, { recursive: true });
    symlinkSync(looseDir, join(linkedRoot, "m00"));
    // A machine directory holding 100 plain files and no store: every entry counts toward the scan bound.
    const strayRoot = join(shardDir(f.home, stray), "machine");
    mkdirSync(strayRoot, { recursive: true });
    for (let index = 0; index < 100; index++) writeFileSync(join(strayRoot, `s${String(index).padStart(3, "0")}`), "x");
    // Exactly the bound of machine directories, with the store in the first name (dense) or the last (denseLast): at or
    // under the bound every directory is scanned, so the store proves capture wherever the listing puts it.
    const denseStore = new CaptureStore({ memoryDir: f.home, project: dense });
    let denseDir: string;
    try { denseStore.append({ project: dense, agent: "fixture", event: "PostToolUse", excerpt: "fixture capture row" }); denseDir = denseStore.dir; } finally { denseStore.close(); }
    const denseRoot = join(shardDir(f.home, dense), "machine");
    fs.renameSync(denseDir, join(denseRoot, "d00"));
    for (let index = 1; index < 64; index++) mkdirSync(join(denseRoot, `d${String(index).padStart(2, "0")}`));
    const lastStore = new CaptureStore({ memoryDir: f.home, project: denseLast });
    let lastDir: string;
    try { lastStore.append({ project: denseLast, agent: "fixture", event: "PostToolUse", excerpt: "fixture capture row" }); lastDir = lastStore.dir; } finally { lastStore.close(); }
    const lastRoot = join(shardDir(f.home, denseLast), "machine");
    fs.renameSync(lastDir, join(lastRoot, "d63"));
    for (let index = 0; index < 63; index++) mkdirSync(join(lastRoot, `d${String(index).padStart(2, "0")}`));
    // A machine/ that is a link to a real capture scope is not followed: unverified. (A linked shard directory is not
    // listed by the picker at all; the refusal path's classification of one is pinned in sync-placement-realm-refusal.)
    ensureShardDescriptor(f.home, linkedMachine);
    symlinkSync(join(shardDir(f.home, dense), "machine"), join(shardDir(f.home, linkedMachine), "machine"));
    const provider = await open(f.root);
    const snapshot = await provider.snapshot({ after: 0, panel: "review" });
    expect(snapshot.gaps).toEqual({ [linked]: "unverified", [loose]: "unverified", [stray]: "unverified", [dense]: "capture-only", [empty]: "no-memory",
      [denseLast]: "capture-only", [linkedMachine]: "unverified" });
    // The class reaches each panel unchanged: an unsafe entry asks for inspection instead of naming an effect.
    for (const key of [linked, loose, stray]) {
      const text = String((await provider.snapshot({ after: 0, panel: "timeline", project: key })).error);
      expect(text, key).toContain("class=unverified");
      expect(text, key).not.toContain("--admit");
      expect(text, key).not.toContain(key);
    }
    expect(String((await provider.snapshot({ after: 0, panel: "timeline", project: dense })).error)).toContain("class=capture-only");
  } finally { closeInventoryFixtures(); }
}, 120_000);

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

test("#544: the console timeline renders a capture-run summary through the real panel, never blank or undefined", async () => {
  const f = fixture(), capture = new CaptureStore({ memoryDir: f.base, project: f.project });
  const t0 = Date.now() - 60_000;
  for (let i = 0; i < 4; i++) capture.append({ project: f.project, at: new Date(t0 + i * 1000).toISOString(), agent: "claude", event: i % 2 ? "PostToolUse" : "PreToolUse",
    tool: "Bash", excerpt: `RUNEXCERPTCANARY ${i}`, paths: [], session: "c".repeat(16) });
  capture.close();
  const provider = await open(f.family), snap = await provider.snapshot({ after: 0, panel: "timeline", project: f.project });
  expect(snap.error).toBeUndefined();
  const entries = snap.entries as { source?: string }[];
  expect(entries.filter(entry => entry.source === "capture-run")).toHaveLength(1);
  type Node = { tag: string; props: Record<string, unknown>; kids: Node[]; append(...k: Node[]): void; replaceChildren(...k: Node[]): void; querySelectorAll(): unknown[]; contains(): boolean };
  const node = (tag: string, props: Record<string, unknown> = {}, ...kids: Node[]): Node => ({ tag, props, kids,
    append(...k) { this.kids.push(...k); }, replaceChildren(...k) { this.kids = [...k]; }, querySelectorAll() { return []; }, contains() { return false; } });
  const rows: Record<string, unknown>[] = []; let emit: ((s: Record<string, unknown>) => void) | undefined;
  const mount = node("mount");
  const host = { tool: "amem", mount, navigate() {}, action() {}, onSnapshot(cb: typeof emit) { emit = cb; }, ui: { h: node, button: (text: string) => node("button", { text }),
    rows: (items: unknown[], render: (item: never) => Node) => items.length ? node("rows", {}, ...items.map(item => render(item as never))) : null,
    notice: (text: string) => node("notice", { text }), row: (props: Record<string, unknown>) => { rows.push(props); return node("row", props); },
    empty: (text: string) => node("empty", { text }), detail: (props: Record<string, unknown>) => node("detail", props) } };
  const { runInNewContext } = await import("node:vm");
  const render = runInNewContext(readFileSync(join(import.meta.dir, "../src/ui/panel.js"), "utf8").replace("export default", ""), { document: { activeElement: null } }) as (host: unknown) => { show(id: string): void };
  render(host).show("timeline"); emit!({ ...snap, project: f.project, projects: [f.project] });
  const run = rows.find(row => String(row.sub).startsWith("capture run"))!;
  expect(run.title).toBe("4 tool calls · Bash ×4");
  expect(run.sub).toMatch(/^capture run · claude · \d{4}-\d\d-\d\d \d\d:\d\d–\d{4}-\d\d-\d\d \d\d:\d\d$/);
  const text = JSON.stringify(rows);
  expect(text).not.toContain("undefined"); expect(text).not.toContain("RUNEXCERPTCANARY");
  expect(rows.every(row => typeof row.title === "string" && (row.title as string).length > 0)).toBe(true);
});
