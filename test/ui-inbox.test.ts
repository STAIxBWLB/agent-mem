/// <reference lib="dom.asynciterable" />
import { afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fsModule from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inboxItemProblems, stableAtProblems } from "@staix/agent-console/conformance";
import { CandidateStore, candidateTargetRevision } from "../src/memory/candidates.ts";
import { DENY_SEGMENTS } from "../src/memory/platform.ts";
import { MemoryStore } from "../src/memory/store.ts";
import * as curatedRead from "../src/memory/curated-read.ts";
import { writeCaptureConfigFile } from "../src/memory/capture.ts";
import { appendAlias, ensureShardDescriptor } from "../src/memory/shard.ts";
import { appendLifecycle } from "../src/memory/lifecycle.ts";
import { plugin } from "../src/ui/plugin.ts";
import { InboxCache, InboxChangedError, InboxDeadlineError, runInboxJob, type InboxRunner, type InboxJobResult, type InboxSnapshot } from "../src/ui/inbox-cache.ts";
import { computeInbox, inboxSources, inboxSourceVersion, inboxPolicyVersion, inboxCaptureConfigVersion, CAPACITY_CACHE_MS, INBOX_MAX_BYTES, type InboxItem, type CapacityMemo } from "../src/ui/inbox.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function home() { const base = mkdtempSync(join(tmpdir(), "amem-inbox-")); cleanup.push(() => rmSync(base, { recursive: true, force: true })); return base; }
const policy = (base: string) => inboxPolicyVersion(base);
const row = (title = "ordinary inbox item"): InboxItem => ({ id: "fixture-item", group: "candidate", kind: "memory", title, at: "2026-11-01T00:00:00.000Z", verbs: [{ id: "reject", label: "Reject" }], link: { panel: "review", params: { project: "project", id: "fixture-item" } } });
function result(base: string, items: InboxItem[] = [row()], more = 0): InboxJobResult {
  const revision = policy(base); return { sources: inboxSources(base), computation: { items, more, policy: revision, expiresAt: null, capacity: { policy: revision, captureConfig: inboxCaptureConfigVersion(base), until: Date.now() + CAPACITY_CACHE_MS, item: null } } };
}
function deferredRunner() {
  const jobs: { resolve(value: InboxJobResult): void; reject(error: Error): void; cancelled: number; capacity?: CapacityMemo }[] = [];
  let active = 0, maxActive = 0;
  const runner: InboxRunner = (_base, capacity) => {
    let resolve!: (value: InboxJobResult) => void, reject!: (error: Error) => void;
    const pending = new Promise<InboxJobResult>((yes, no) => { resolve = yes; reject = no; }); active++; maxActive = Math.max(active, maxActive);
    const job = { resolve, reject, cancelled: 0, capacity }; jobs.push(job);
    return { result: pending.finally(() => { active--; }), async cancel() { job.cancelled++; reject(Error("synthetic worker cancelled")); } };
  };
  return { runner, jobs, maxActive: () => maxActive };
}
async function openProvider(family: string) {
  const previous = process.env.AMEM_HOME; process.env.AMEM_HOME = join(family, "memory");
  try { return await plugin.open({ home: family, log: () => {} }); }
  finally { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; }
}
const tick = () => Bun.sleep(0);
async function ready(snapshot: () => Promise<InboxSnapshot>, limitMs = 70000): Promise<InboxSnapshot> {
  const end = performance.now() + limitMs;
  for (;;) { const value = await snapshot(); if (value.complete) return value; if (performance.now() >= end) throw Error("inbox did not produce a complete snapshot within its worker window"); await Bun.sleep(10); }
}

test("twenty same-generation requests share one computation and warm snapshots cannot mutate the cache", async () => {
  const base = home(), work = deferredRunner(), cache = new InboxCache(base, { runner: work.runner }); cleanup.push(() => cache.close());
  const cold = await Promise.all(Array.from({ length: 20 }, () => cache.snapshot()));
  expect(work.jobs).toHaveLength(1); expect(cold.every(value => !value.complete && value.refreshing)).toBe(true);
  expect(cold[0]!.items[0]?.title).toContain("refreshing");
  work.jobs[0]!.resolve(result(base)); await tick();
  const warm = await cache.snapshot(); expect(warm.complete).toBe(true); warm.items[0]!.title = "caller mutation"; warm.items[0]!.verbs.length = 0;
  await tick(); const again = await cache.snapshot(); expect(again.items[0]!.title).toBe("ordinary inbox item"); expect(again.items[0]!.verbs).toHaveLength(1);
  await Promise.all(Array.from({ length: 20 }, () => cache.snapshot())); expect(work.jobs).toHaveLength(1); expect(work.maxActive()).toBe(1);
});

test("dirty requests coalesce behind the minimum start interval without a completion respawn", async () => {
  let clock = 0; const base = home(), work = deferredRunner(), cache = new InboxCache(base, { runner: work.runner, now: () => clock }); cleanup.push(() => cache.close());
  await cache.snapshot(); cache.invalidate(); await Promise.all(Array.from({ length: 20 }, () => cache.snapshot()));
  work.jobs[0]!.resolve(result(base, [row("old generation")])); await tick(); expect(work.jobs).toHaveLength(1);
  expect(JSON.stringify(await cache.snapshot())).not.toContain("old generation");
  clock = 29999; await cache.snapshot(); expect(work.jobs).toHaveLength(1);
  clock = 30000; await Promise.all(Array.from({ length: 20 }, () => cache.snapshot())); expect(work.jobs).toHaveLength(2);
  work.jobs[1]!.resolve(result(base, [row("current generation")])); await tick(); expect((await cache.snapshot()).items[0]!.title).toBe("current generation");
  expect(work.maxActive()).toBe(1);
});

test("soft invalidation keeps other bounded rows and policy changes hide them during cooldown", async () => {
  let clock = 0; const base = home(), work = deferredRunner(), cache = new InboxCache(base, { runner: work.runner, now: () => clock }); cleanup.push(() => cache.close());
  await cache.snapshot(); const a = row("PRIVATE_INBOX_VALUE"), b = { ...row("second item"), id: "second" };
  work.jobs[0]!.resolve(result(base, [a, b])); await tick(); cache.invalidate({ removeIds: [a.id] });
  const stale = await cache.snapshot(); expect(stale.complete).toBe(false); expect(stale.refreshing).toBe(true); expect(stale.items.map(item => item.id)).toEqual([b.id]); expect(work.jobs).toHaveLength(1);
  writeFileSync(join(base, "amem.config.json"), JSON.stringify({ piiPatterns: ["second item"] }));
  const hidden = await cache.snapshot(); expect(hidden.items).toHaveLength(1); expect(hidden.items[0]!.kind).toBe("status"); expect(JSON.stringify(hidden)).not.toContain("second item");
  clock = 30000; await cache.snapshot(); expect(work.jobs).toHaveLength(2); work.jobs[1]!.resolve(result(base, [])); await tick(); expect((await cache.snapshot()).items).toEqual([]);
  writeFileSync(join(base, "amem.config.json"), "not-json"); expect((await cache.snapshot()).complete).toBe(false);
});

test("a runtime default-deny tightening immediately hides a warm row and reaches the next actual worker", async () => {
  const family = home(), base = join(family, "memory"), candidates = new CandidateStore({ memoryDir: base });
  let id: string;
  try { id = candidates.put({ project: "project", kind: "memory", text: "ordinary source path src/ui-inbox-runtime-private/value.ts" }, "public"); } finally { candidates.close(); }
  const provider = await openProvider(family); cleanup.push(() => provider.close());
  const snapshot = async () => await provider.snapshot({ panel: "inbox", after: 0 }) as unknown as InboxSnapshot;
  expect((await ready(snapshot)).items.some(value => value.id === id!)).toBe(true);
  const length = DENY_SEGMENTS.length, before = inboxPolicyVersion(base);
  try {
    DENY_SEGMENTS.push("ui-inbox-runtime-private"); expect(inboxPolicyVersion(base)).not.toBe(before);
    const invalidated = await snapshot(); expect(invalidated.complete).toBe(false);
    expect(JSON.stringify(invalidated)).not.toContain("ui-inbox-runtime-private");
    const refreshed = await ready(snapshot); expect(refreshed.items.some(value => value.id === id!)).toBe(false);
    expect(JSON.stringify(refreshed)).not.toContain("ui-inbox-runtime-private");
  } finally { DENY_SEGMENTS.splice(length); }
}, 80000);

test("queue changes retain warm rows, while irrelevant files do not dirty the cache", async () => {
  let clock = 0; const base = home(), work = deferredRunner(), cache = new InboxCache(base, { runner: work.runner, now: () => clock }); cleanup.push(() => cache.close());
  await cache.snapshot(); work.jobs[0]!.resolve(result(base)); await tick(); expect((await cache.snapshot()).complete).toBe(true);
  mkdirSync(join(base, "hook-project")); writeFileSync(join(base, "hook-project", "unrelated.json"), "{}");
  expect((await cache.snapshot()).complete).toBe(true);
  writeFileSync(join(base, "candidates.db"), "synthetic queue version"); const stale = await cache.snapshot();
  expect(stale.complete).toBe(false); expect(stale.items[0]!.title).toBe("ordinary inbox item"); expect(work.jobs).toHaveLength(1);
  clock = 30000; await cache.snapshot(); expect(work.jobs).toHaveLength(2); work.jobs[1]!.resolve(result(base)); await tick();
  const external = join(home(), "outside.db"); writeFileSync(external, "outside fixture"); rmSync(join(base, "candidates.db")); symlinkSync(external, join(base, "candidates.db"));
  expect((await cache.snapshot()).items[0]!.kind).toBe("status");
});

test("deadline failures back off exponentially, source changes cannot bypass cooldown, success resets it", async () => {
  let clock = 0; const base = home(), work = deferredRunner(), cache = new InboxCache(base, { runner: work.runner, now: () => clock }); cleanup.push(() => cache.close());
  await cache.snapshot();
  for (let index = 0; index < 11; index++) {
    clock += 31000; work.jobs[index]!.reject(new InboxDeadlineError()); await tick();
    const delay = Math.min(300000, 1000 * 2 ** index); cache.invalidate({ hard: true });
    clock += delay - 1; await cache.snapshot(); expect(work.jobs).toHaveLength(index + 1);
    clock++; await Promise.all(Array.from({ length: 20 }, () => cache.snapshot())); expect(work.jobs).toHaveLength(index + 2);
  }
  work.jobs.at(-1)!.resolve(result(base)); await tick(); expect((await cache.snapshot()).complete).toBe(true);
  cache.invalidate(); clock += 29999; await cache.snapshot(); expect(work.jobs).toHaveLength(12);
  clock++; await cache.snapshot(); expect(work.jobs).toHaveLength(13); await cache.close(); await expect(cache.snapshot()).rejects.toThrow("closed");
});

test("changed is pending work, not failure, and status identities change between unavailable and refreshing", async () => {
  let clock = 0; const base = home(), work = deferredRunner(), logs: string[] = [], cache = new InboxCache(base, { runner: work.runner, now: () => clock, log: line => logs.push(line) }); cleanup.push(() => cache.close());
  const initial = await cache.snapshot(); work.jobs[0]!.reject(new InboxChangedError()); await tick(); expect(logs).toEqual([]);
  expect((await cache.snapshot()).items[0]!.id).toBe(initial.items[0]!.id);
  clock = 30000; await cache.snapshot(); work.jobs[1]!.reject(Error("failed read")); await tick(); const unavailable = await cache.snapshot();
  expect(unavailable.items[0]!.id).not.toBe(initial.items[0]!.id); expect(unavailable.items[0]!.at > initial.items[0]!.at).toBe(true);
  clock = 60000; const retry = await cache.snapshot(); expect(retry.items[0]!.id).toBe(initial.items[0]!.id); expect(retry.items[0]!.at > unavailable.items[0]!.at).toBe(true);
});

test("candidate expiry hard-drops old rows even when no file changed", async () => {
  let clock = 0; const base = home(), work = deferredRunner(), cache = new InboxCache(base, { runner: work.runner, now: () => clock }); cleanup.push(() => cache.close());
  await cache.snapshot(); const value = result(base); value.computation.expiresAt = 1000; work.jobs[0]!.resolve(value); await tick(); expect((await cache.snapshot()).complete).toBe(true);
  clock = 1000; const expired = await cache.snapshot(); expect(expired.complete).toBe(false); expect(expired.items[0]!.kind).toBe("status"); expect(work.jobs).toHaveLength(1);
});

test("source enumeration is bounded even when every directory entry would be ignored", () => {
  const base = home(); mkdirSync(join(base, "log")); let seen = 0, closed = 0;
  const directory = { readSync() { if (++seen > 20000) throw Error("synthetic fixture limit reached"); return { name: "derived-index.db", isDirectory: () => false }; }, closeSync() { closed++; } };
  const reader = spyOn(fsModule, "opendirSync").mockReturnValue(directory as unknown as ReturnType<typeof fsModule.opendirSync>);
  try {
    for (const inspect of [() => inboxSources(base, ["log"]), () => inboxSourceVersion(base, ["", "log"])]) {
      seen = 0; expect(inspect).toThrow("inbox source inventory exceeds its bound"); expect(seen).toBeLessThan(20000);
    }
    expect(closed).toBe(2);
  } finally { reader.mockRestore(); }
});

test("real read-only computation returns fifty compact newest/urgent rows and a privacy-safe more count", () => {
  const base = home(), store = new CandidateStore({ memoryDir: base, now: () => Date.parse("2026-11-01T00:00:00.000Z") });
  const ids: string[] = [];
  try {
    for (let index = 0; index < 70; index++) ids.push(store.put({ project: "project", kind: "memory", text: `ordinary ${index} ${"제주 public evidence ".repeat(80)}` }, "public"));
    for (let index = 0; index < 5; index++) store.put({ project: "project", kind: "memory", text: `INBOX_PRIVATE_${index}` }, "public");
  } finally { store.close(); }
  writeFileSync(join(base, "amem.config.json"), JSON.stringify({ piiPatterns: ["INBOX_PRIVATE_"] }));
  const alert: InboxItem = { id: "capacity:proposal", group: "alert", kind: "capacity", title: "Capacity needs review", at: "2000-01-01T00:00:00.000Z", verbs: [{ id: "capacity_apply", label: "Apply..." }], link: { panel: "capacity" } };
  const computed = computeInbox(base, { policy: policy(base), captureConfig: inboxCaptureConfigVersion(base), until: Date.now() + CAPACITY_CACHE_MS, item: alert });
  expect(computed.items).toHaveLength(50); expect(computed.more).toBe(22); expect(computed.items[0]!.id).toBe("capacity:proposal");
  expect(computed.items.filter(value => value.group === "candidate").map(value => value.id)).toEqual([...ids].sort().slice(0, 48));
  for (const item of computed.items) { expect(inboxItemProblems(item)).toEqual([]); expect(item.title.length).toBeLessThanOrEqual(120); }
  for (const item of computed.items.filter(value => value.group === "candidate")) expect(Object.keys(item).sort()).toEqual(["at", "group", "id", "kind", "link", "project", "title", "verbs"]);
  expect(Buffer.byteLength(JSON.stringify(computed.items))).toBeLessThanOrEqual(INBOX_MAX_BYTES); expect(JSON.stringify(computed)).not.toContain("INBOX_PRIVATE_");
});

test("one unsplit curated reader serves targeted candidates from distinct unaliased projects", () => {
  const base = home(), memory = new MemoryStore({ memoryDir: base }), candidates = new CandidateStore({ memoryDir: base });
  const ids: string[] = [];
  try {
    for (const project of ["project-a", "project-b"]) {
      const target = memory.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: `ordinary target ${project}`, about: [] });
      ids.push(candidates.put({ project, kind: "correction", target: { id: target, revision: candidateTargetRevision(memory.get(target, project)!) }, proposedText: `corrected ${project}`, reason: "fixture evidence" }, "public"));
    }
  } finally { candidates.close(); memory.close(); }
  const calls = spyOn(curatedRead, "openCuratedForRead");
  try {
    const value = computeInbox(base, { policy: policy(base), captureConfig: inboxCaptureConfigVersion(base), until: Date.now() + CAPACITY_CACHE_MS, item: null });
    expect(value.items.map(item => item.id).sort()).toEqual(ids.sort()); expect(calls).toHaveBeenCalledTimes(1);
    expect(new Set(value.items.map(item => item.project))).toEqual(new Set(["project-a", "project-b"]));
  } finally { calls.mockRestore(); }
});

test("a changed home capture config does not reuse old capacity advice inside its memo lifetime", () => {
  const base = home(), item: InboxItem = { id: "capacity:proposal", group: "alert", kind: "capacity", title: "Old cached proposal", at: new Date().toISOString(),
    verbs: [{ id: "capacity_apply", label: "Apply..." }], link: { panel: "capacity" } };
  const memo: CapacityMemo = { policy: policy(base), captureConfig: inboxCaptureConfigVersion(base), until: Date.now() + CAPACITY_CACHE_MS, item };
  expect(computeInbox(base, memo).items[0]!.title).toBe("Old cached proposal");
  writeCaptureConfigFile(join(base, "capture-config.json"), { capMb: 2, retentionDays: 2 });
  const current = computeInbox(base, memo);
  expect(current.capacity.captureConfig).not.toBe(memo.captureConfig);
  expect(current.items.some(value => value.title === "Old cached proposal")).toBe(false);
}, 20_000);

test("UTF-8 payload trimming preserves the visible overflow count under the full envelope bound", () => {
  const base = home(), project = "제".repeat(399), store = new CandidateStore({ memoryDir: base });
  try { for (let index = 0; index < 60; index++) store.put({ project, kind: "memory", text: `공개 ${index} ${"기록 ".repeat(80)}` }, "public"); } finally { store.close(); }
  const value = computeInbox(base, { policy: policy(base), captureConfig: inboxCaptureConfigVersion(base), until: Date.now() + CAPACITY_CACHE_MS, item: null });
  expect(value.items.length).toBeGreaterThan(0); expect(value.items.length).toBeLessThan(50);
  expect(value.more).toBe(60 - value.items.filter(item => item.id !== "inbox:more").length);
  expect(Buffer.byteLength(JSON.stringify({ items: value.items, more: value.more, complete: true, refreshing: false }))).toBeLessThanOrEqual(INBOX_MAX_BYTES);
});

test("alias retarget and archive change the source version and current candidate destinations", () => {
  const base = home(); for (const key of ["old-project", "canonical-a", "canonical-b"]) ensureShardDescriptor(base, key);
  const store = new CandidateStore({ memoryDir: base }); let id: string;
  try { id = store.put({ project: "old-project", kind: "memory", text: "alias pending item" }, "public"); } finally { store.close(); }
  const memo = { policy: policy(base), captureConfig: inboxCaptureConfigVersion(base), until: Date.now() + CAPACITY_CACHE_MS, item: null };
  appendAlias(base, { alias: "old-project", key: "canonical-a", actor: "person", machine: "a".repeat(16) });
  const before = inboxSources(base), first = computeInbox(base, memo); expect(first.items.find(value => value.id === id!)?.link.params?.project).toBe("canonical-a");
  appendAlias(base, { alias: "old-project", key: "canonical-b", actor: "person", machine: "a".repeat(16) });
  expect(inboxSourceVersion(base, before.paths)).not.toBe(before.version); expect(computeInbox(base, memo).items.find(value => value.id === id!)?.link.params?.project).toBe("canonical-b");
  appendLifecycle(base, { op: "archive", key: "canonical-b", actor: "person", machine: "a".repeat(16) });
  expect(computeInbox(base, memo).items.some(value => value.id === id!)).toBe(false);
});

test("previews and failed actions do not explicitly invalidate a warm inbox; successful writes remove only their row", async () => {
  const family = home(), base = join(family, "memory"), candidates = new CandidateStore({ memoryDir: base }); let a: string, b: string;
  try { a = candidates.put({ project: "project", kind: "memory", text: "first triage proposal" }, "public"); b = candidates.put({ project: "project", kind: "memory", text: "second triage proposal" }, "public"); } finally { candidates.close(); }
  const provider = await openProvider(family); cleanup.push(() => provider.close()); const snapshot = async () => await provider.snapshot({ panel: "inbox", after: 0 }) as unknown as InboxSnapshot;
  await ready(snapshot); const calls = spyOn(InboxCache.prototype, "invalidate");
  try {
    expect(await provider.action({ action: "capacity_apply" })).toMatchObject({ ok: false, needsConfirm: true });
    expect(await provider.action({ action: "reject", id: "missing", project: "project" })).toMatchObject({ ok: false }); expect(calls).not.toHaveBeenCalled();
    expect(await provider.action({ action: "accept", id: a!, project: "project" })).toMatchObject({ ok: true }); expect(calls).toHaveBeenCalledTimes(1);
  } finally { calls.mockRestore(); }
  const stale = await snapshot(); expect(stale.complete).toBe(false); expect(stale.refreshing).toBe(true);
  expect(stale.items.some(item => item.id === a!)).toBe(false); expect(stale.items.some(item => item.id === b!)).toBe(true);
  expect(stale.items.some(item => item.kind === "status")).toBe(false);
}, 80000);

test("public provider reports cold cost separately and refreshes actions while the real worker leaves the event loop responsive", async () => {
  const family = home(), base = join(family, "memory"), store = new CandidateStore({ memoryDir: base });
  try { for (let i = 0; i < 120; i++) store.put({ project: "project", kind: "memory", text: `real worker pending ${i} ${"공개 evidence ".repeat(80)}` }, "public"); } finally { store.close(); }
  const opened = performance.now(), provider = await openProvider(family), openMs = performance.now() - opened; cleanup.push(() => provider.close());
  const snapshot = async () => await provider.snapshot({ panel: "inbox", after: 0 }) as unknown as InboxSnapshot;
  let maxLag = 0, ticks = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 10); last = now; ticks++; }, 10);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => request.headers.get("authorization") === "Bearer fixture-token" ? Response.json({ ok: true }) : new Response("unauthorized", { status: 401 }) });
  const requests: number[] = [];
  try {
    const coldAt = performance.now(), cold = await snapshot(), coldMs = performance.now() - coldAt;
    expect(cold.complete).toBe(false); expect(cold.items[0]?.title).toContain("refreshing"); expect(openMs).toBeLessThan(1000); expect(coldMs).toBeLessThan(1000);
    const pending = ready(snapshot); void pending.catch(() => {});
    for (let index = 0; index < 10; index++) { const at = performance.now(), response = await fetch(server.url, { headers: { authorization: "Bearer fixture-token" } }); expect(response.status).toBe(200); requests.push(performance.now() - at); await Bun.sleep(10); }
    const complete = await pending; expect(complete.items).toHaveLength(50); expect(complete.more).toBeGreaterThan(0); expect(ticks).toBeGreaterThan(0); expect(maxLag).toBeLessThan(1000); expect(Math.max(...requests)).toBeLessThan(1000);
    const item = complete.items.find(value => value.group === "candidate")!;
    expect(await provider.action({ action: "reject", id: item.id, project: item.link.params!.project })).toMatchObject({ ok: true });
    const triage = await snapshot(); expect(triage.complete).toBe(false); expect(triage.items.some(value => value.kind === "status")).toBe(false); expect(triage.items.some(value => value.id === item.id)).toBe(false);
    expect(triage.items.some(value => value.group === "candidate")).toBe(true); expect((await ready(snapshot)).items.some(value => value.id === item.id)).toBe(false);
    expect(await provider.action({ action: "reject_undo", id: item.id, project: item.link.params!.project })).toMatchObject({ ok: true });
    expect((await ready(snapshot)).items.some(value => value.id === item.id)).toBe(true);
    expect(stableAtProblems(complete.items, (await snapshot()).items)).toEqual([]);
  } finally { clearInterval(timer); await server.stop(true); }
}, 120000);

test("a curated target forget invalidates real-worker visibility even though candidates.db is unchanged", async () => {
  const family = home(), base = join(family, "memory"), memory = new MemoryStore({ memoryDir: base }); cleanup.push(() => memory.close());
  const target = memory.note({ op: "note", project: "project", scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "curated target", about: [] });
  const candidates = new CandidateStore({ memoryDir: base }); let id: string;
  try { id = candidates.put({ project: "project", kind: "correction", target: { id: target, revision: candidateTargetRevision(memory.get(target, "project")!) }, proposedText: "replacement", reason: "ordinary correction" }, "public"); } finally { candidates.close(); }
  const cache = new InboxCache(base); cleanup.push(() => cache.close()); expect((await ready(() => cache.snapshot())).items.some(value => value.id === id!)).toBe(true);
  const before = readFileSync(join(base, "candidates.db")); expect(memory.forget(target, "person", "project")).toBeDefined();
  expect(readFileSync(join(base, "candidates.db"))).toEqual(before);
  expect((await cache.snapshot()).complete).toBe(false); expect((await ready(() => cache.snapshot())).items.some(value => value.id === id!)).toBe(false);
}, 80000);

async function blockingJob(base: string) {
  const real = childProcess.fork, entry = join(import.meta.dir, "fakes", "ui-inbox-blocking-worker.ts");
  const replacement = ((modulePath: string | URL, args?: readonly string[] | childProcess.ForkOptions, options?: childProcess.ForkOptions) => {
    const selected = String(modulePath).endsWith("inbox-worker.ts") ? entry : modulePath;
    return Array.isArray(args) ? real(selected, args, options) : real(selected, args as childProcess.ForkOptions | undefined);
  }) as typeof childProcess.fork;
  const spy = spyOn(childProcess, "fork").mockImplementation(replacement);
  try {
    const job = runInboxJob(base); const settled = job.result.then(value => ({ value }), error => ({ error }));
    const until = performance.now() + 5000;
    while (!existsSync(join(base, "ui-inbox-worker.json"))) { if (performance.now() >= until) { await job.cancel(); throw Error("blocking fixture did not start"); } await Bun.sleep(10); }
    const pids = JSON.parse(readFileSync(join(base, "ui-inbox-worker.json"), "utf8")) as { pid: number; child: number };
    return { job, settled, pids };
  } finally { spy.mockRestore(); }
}
function gone(pid: number) { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } }
test("closing a cooperative native fixture reaps its worker and owned descendant", async () => {
  const f = await blockingJob(home()); cleanup.push(() => f.job.cancel());
  const at = performance.now(); await f.job.cancel(); await f.settled;
  expect(performance.now() - at).toBeLessThan(2500); expect(gone(f.pids.pid)).toBe(true); expect(gone(f.pids.child)).toBe(true);
}, 7000);
test("the actual thirty-second refresh deadline reaps a cooperative native fixture group", async () => {
  const started = performance.now(), f = await blockingJob(home()); cleanup.push(() => f.job.cancel());
  const outcome = await f.settled; expect("error" in outcome).toBe(true);
  await f.job.cancel(); // A deadline failure is not itself a group-gone acknowledgement.
  expect(performance.now() - started).toBeGreaterThanOrEqual(29000); expect(performance.now() - started).toBeLessThan(34000);
  expect(gone(f.pids.pid)).toBe(true); expect(gone(f.pids.child)).toBe(true);
}, 35000);
