import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_CACHE_BYTES, briefCacheFile, readBriefCache, writeBriefCache } from "../src/brief-cache.ts";
import { buildCaptureBriefCache } from "../src/brief-capture.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { processSignature } from "../src/memory/platform.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(seed = true) {
  const root = mkdtempSync(join(tmpdir(), "amem-brief-cache-")); roots.push(root);
  const base = join(root, "memory"), project = "cache-project";
  const capture = new CaptureStore({ memoryDir: base, project });
  const append = (excerpt: string, event = "Recap", subagent = false) => {
    const result = capture.append({ project, agent: "claude", event, excerpt, paths: ["public.ts", "other.ts", "hidden.ts"], session: "a".repeat(16), subagent });
    if (!("id" in result)) throw Error("fixture append spooled");
    return result.id;
  };
  if (seed) {
    const id = append("previous recap"); append("subagent forbidden", "Recap", true);
    buildCaptureBriefCache(capture, { base, project, cwd: root, builtThrough: id });
  }
  const directory = capture.dir; capture.close();
  const binding = { directory, project, section: "capture" as const };
  const options = { cwd: root, base, project, nativeSession: { signature: processSignature(process.pid)! }, timeRemaining: () => 70 };
  return { root, base, project, binding, options };
}
const captureRows = (context: string) => context.split("\n").filter(line => line.startsWith('{"section":"capture"')).map(line => JSON.parse(line).data);

test("private cache preserves library summary display and native reads no capture database", async () => {
  const f = await fixture(), cache = readBriefCache(f.binding)!;
  expect(cache.builtThrough).toBe(2);
  expect(statSync(briefCacheFile(f.binding)).mode & 0o777).toBe(0o600);
  const library = await sessionStartBrief({ cwd: f.root, base: f.base, project: f.project });
  writeFileSync(join(f.binding.directory, "capture.db"), "invalid sqlite, native must not open it");
  const native = await sessionStartBrief(f.options);
  expect(native.coverage.capture).toBe("partial"); // display hides the third path
  expect(captureRows(native.context)).toEqual(captureRows(library.context));
  expect(native.context).toContain("previous recap");
  expect(native.context).not.toContain("subagent forbidden");
  expect(native.tokens).toBeLessThanOrEqual(1200);
});

for (const native of [true, false]) test(`capture is preloaded before slow work spends the deadline, with output order preserved: ${native ? "native" : "library"}`, async () => {
  const f = await fixture(), work = new WorkListStore({ base: f.base, project: f.project, policy: () => true });
  await work.write("queue", { task: "slow-work", status: "doing" }); work.close();
  let remaining = 70, reached = false, captureScreenedBeforeWork = false;
  const result = await sessionStartBrief({ ...f.options, nativeSession: native ? f.options.nativeSession : undefined, timeRemaining: () => remaining, policy: { host: { screen: async value => {
    const text = JSON.stringify(value);
    if (text.includes("previous recap") && !reached) captureScreenedBeforeWork = true;
    if (text.includes("slow-work")) { reached = true; remaining = -1; }
    return true;
  } } } });
  expect(reached).toBe(true);
  expect(captureScreenedBeforeWork).toBe(true);
  expect(result.context).toContain("previous recap");
  expect(result.context.indexOf('"section":"work"')).toBeLessThan(result.context.indexOf('"section":"capture"'));
});

for (const mode of ["missing", "public", "oversize", "symlink", "malformed", "foreign"] as const) test(`cache ${mode} is unavailable without repairing it`, async () => {
  const f = await fixture(), file = briefCacheFile(f.binding);
  if (mode === "missing") rmSync(file);
  if (mode === "public") chmodSync(file, 0o644);
  if (mode === "oversize") writeFileSync(file, "x".repeat(BRIEF_CACHE_BYTES + 1));
  if (mode === "malformed") writeFileSync(file, "{bad");
  if (mode === "foreign") { const cache = readBriefCache(f.binding)!; cache.project = "foreign"; writeFileSync(file, JSON.stringify(cache)); }
  if (mode === "symlink") { const target = file + ".target"; writeFileSync(target, readFileSync(file)); rmSync(file); symlinkSync(target, file); }
  const before = readdirSync(f.binding.directory).sort(), bytes = mode === "missing" ? undefined : readFileSync(file);
  const result = await sessionStartBrief(f.options);
  expect(result.coverage.capture).toBe("unavailable");
  expect(result.context).toContain("capture: capture cache missing");
  expect(readdirSync(f.binding.directory).sort()).toEqual(before);
  if (bytes) expect(readFileSync(file)).toEqual(bytes);
});

test("changed policy screens the full cached source, including undisplayed paths", async () => {
  const f = await fixture();
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ denyPaths: ["hidden.ts"] }));
  const result = await sessionStartBrief(f.options);
  expect(result.context).not.toContain("previous recap");
  expect(result.coverage.capture).toBe("partial");
});

test("cache transport retains a newer watermark and caps the payload", async () => {
  const f = await fixture(), cache = readBriefCache(f.binding)!;
  writeBriefCache(f.binding, { ...cache, builtThrough: 10 });
  writeBriefCache(f.binding, { ...cache, builtThrough: 9, rows: [] });
  expect(readBriefCache(f.binding)?.builtThrough).toBe(10);
  expect(() => writeBriefCache(f.binding, { ...cache, rows: [{ source: "x".repeat(BRIEF_CACHE_BYTES), data: {}, partial: false }] })).toThrow("byte bound");
});

for (const event of ["Stop", "SessionEnd"] as const) test(`${event} prepares summaries for startup and the same compacted session`, async () => {
  const f = hookFixture();
  try {
    await f.seed();
    const transcript = join(f.root, "summary.jsonl");
    writeFileSync(transcript, [
      { type: "system", subtype: "away_summary", timestamp: new Date().toISOString(), content: "fresh recap marker" },
      { type: "user", isCompactSummary: true, timestamp: new Date().toISOString(), message: { content: "fresh compact marker" } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    expect(f.runFunctional(event, { transcript_path: transcript }).exitCode).toBe(0);
    for (const source of ["startup", "compact"]) {
      const next = f.runFunctional("SessionStart", { source });
      expect(next.exitCode, next.stderr.toString()).toBe(0);
      const context = JSON.parse(next.stdout.toString()).hookSpecificOutput.additionalContext as string;
      expect(context).toContain("fresh compact marker");
      expect(context).toContain("fresh recap marker");
      expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1200);
    }
  } finally { f.close(); }
});

test("a summary commit invalidates the older cache before a failed refresh can claim completeness", async () => {
  const f = await fixture(), store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try { store.append({ project: f.project, agent: "claude", event: "Recap", excerpt: "new durable summary" }); }
  finally { store.close(); }
  expect(readBriefCache(f.binding)).toBeUndefined();
  const native = await sessionStartBrief(f.options);
  expect(native.coverage.capture).toBe("unavailable");
  expect(native.context).not.toContain("previous recap");
  expect(native.context).toContain("capture cache missing");
});

test("snapshot publication serializes against a competing summary writer and its later spool replay", async () => {
  const f = await fixture(), first = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    first.withBriefCaptureSnapshot(() => {
      const second = new CaptureStore({ memoryDir: f.base, project: f.project, busyTimeoutMs: 0 });
      try { expect(second.append({ project: f.project, agent: "claude", event: "Compact", excerpt: "competing compact" })).toEqual({ spooled: true }); }
      finally { second.close(); }
      expect(readBriefCache(f.binding)).toBeDefined();
    });
    first.append({ project: f.project, agent: "claude", event: "PostToolUse", excerpt: "drain summary" });
    expect(first.briefCommitId).toBeGreaterThan(0);
    expect(readBriefCache(f.binding)).toBeUndefined();
    buildCaptureBriefCache(first, { base: f.base, project: f.project, cwd: f.root, builtThrough: first.briefCommitId });
    expect(JSON.stringify(readBriefCache(f.binding)?.rows)).toContain("competing compact");
  } finally { first.close(); }
});

test("retention eviction invalidates cached source rows without serving removed summaries", async () => {
  const f = await fixture(), store = new CaptureStore({ memoryDir: f.base, project: f.project, now: () => Date.now() + 366 * 24 * 3600_000 });
  try { expect(store.evict().expired).toBeGreaterThan(0); }
  finally { store.close(); }
  expect(readBriefCache(f.binding)).toBeUndefined();
  const native = await sessionStartBrief(f.options);
  expect(native.context).not.toContain("previous recap");
  expect(native.context).toContain("capture cache missing");
});

test("equal-budget native and library reserve only the newest recap before saturated work, ahead of large Records", async () => {
  const f = await fixture(false), store = new CaptureStore({ memoryDir: f.base, project: f.project });
  const work = new WorkListStore({ base: f.base, project: f.project, policy: () => true });
  try {
    for (let i = 0; i < 4; i++) await work.write(`queue-${i}`, { status: "doing", title: `work-${i} ` + "w".repeat(65), detail: "d".repeat(10) });
  } finally { work.close(); }
  try {
    for (let i = 0; i < 2; i++) store.append({ project: f.project, agent: "claude", event: "Record", paths: [],
      excerpt: `amem: decision | - | ${i} ${"r".repeat(280)}` });
    const budget = 868; // The existing 1200-byte hook pool after the 332-byte Record instruction reservation.
    const options = { ...f.options, maxTokens: budget, timeRemaining: () => 2000 };
    const project = async () => [await sessionStartBrief(options), await sessionStartBrief({ ...options, nativeSession: undefined })];
    const workRows = (context: string) => context.split("\n").filter(line => line.startsWith('{"section":"work"')).length;
    buildCaptureBriefCache(store, { base: f.base, project: f.project, cwd: f.root, builtThrough: store.briefCommitId });
    const before = await project();
    store.append({ project: f.project, agent: "claude", event: "Recap", paths: [], at: new Date(Date.now() + 1000).toISOString(),
      excerpt: "newest reserved recap " + "n".repeat(60) });
    buildCaptureBriefCache(store, { base: f.base, project: f.project, cwd: f.root, builtThrough: store.briefCommitId });
    const one = await project();
    store.append({ project: f.project, agent: "claude", event: "Compact", paths: [], at: new Date(Date.now() - 1000).toISOString(),
      excerpt: "older deferred compact " + "o".repeat(60) });
    buildCaptureBriefCache(store, { base: f.base, project: f.project, cwd: f.root, builtThrough: store.briefCommitId });
    expect(readBriefCache(f.binding)?.rows.filter(row => (row.source as { event: string }).event !== "Record")).toHaveLength(2);
    const both = await project();
    expect(captureRows(both[0]!.context)).toEqual(captureRows(both[1]!.context));
    for (let i = 0; i < both.length; i++) {
      const result = both[i]!;
      expect(result.context).toContain("newest reserved recap");
      expect(result.context).not.toContain("older deferred compact");
      expect(captureRows(result.context).map(row => row.event)).toEqual(["Recap"]);
      expect(result.coverage.work).toBe("partial");
      expect(workRows(result.context)).toBeGreaterThan(0);
      expect(workRows(result.context)).toBeLessThan(workRows(before[i]!.context));
      expect(workRows(result.context)).toBe(workRows(one[i]!.context));
      expect(result.tokens).toBeLessThanOrEqual(budget);
    }
  } finally { store.close(); }
});

test("an oversized newest summary is skipped whole instead of reserving the older one ahead of work", async () => {
  const f = await fixture(), store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    store.append({ project: f.project, agent: "claude", event: "Recap", paths: ["a".repeat(80), "b".repeat(80)],
      excerpt: "oversized newest " + "x".repeat(224), at: new Date(Date.now() + 1000).toISOString() });
    buildCaptureBriefCache(store, { base: f.base, project: f.project, cwd: f.root, builtThrough: store.briefCommitId });
  } finally { store.close(); }
  const work = new WorkListStore({ base: f.base, project: f.project, policy: () => true });
  try { await work.write("must-keep-work", { status: "doing", title: "w".repeat(72), detail: "d".repeat(30) }); }
  finally { work.close(); }
  const native = await sessionStartBrief({ ...f.options, maxTokens: 600, timeRemaining: () => 2000 });
  expect(native.context).toContain("must-keep-work");
  expect(native.context).not.toContain("oversized newest");
  expect(native.context).not.toContain("previous recap");
  expect(native.coverage.capture).toBe("partial");
  expect(native.tokens).toBeLessThanOrEqual(600);
});

test("cache retains five whole Records and two summaries independently of the brief byte pool", async () => {
  const f = await fixture(false), store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    for (let i = 0; i < 5; i++) store.append({ project: f.project, agent: "claude", event: "Record", paths: [],
      excerpt: `amem: decision | - | ${i} ${"r".repeat(280)}` });
    store.append({ project: f.project, agent: "claude", event: "Record", paths: [],
      excerpt: "amem: decision | - | " + "한".repeat(280) });
    store.append({ project: f.project, agent: "claude", event: "Recap", excerpt: "first recap" });
    store.append({ project: f.project, agent: "claude", event: "Compact", excerpt: "second compact" });
    buildCaptureBriefCache(store, { base: f.base, project: f.project, cwd: f.root, builtThrough: store.briefCommitId });
    const cache = readBriefCache(f.binding)!;
    expect(cache.rows.map(row => (row.source as { event: string }).event)).toEqual([
      "Record", "Record", "Record", "Record", "Record", "Compact", "Recap",
    ]);
    expect(JSON.stringify(cache.rows)).not.toContain("한".repeat(280));
    expect(cache.partial).toBe(true);
    expect(statSync(briefCacheFile(f.binding)).size).toBeLessThanOrEqual(BRIEF_CACHE_BYTES);
  } finally { store.close(); }
});

test("the person-raised capture format floor gates native cache and library reads without discarding work", async () => {
  const f = await fixture(), work = new WorkListStore({ base: f.base, project: f.project, policy: () => true });
  try { await work.write("floor-work", { task: "allowed work above capture floor", status: "doing" }); }
  finally { work.close(); }
  const file = briefCacheFile(f.binding), before = readFileSync(file);
  // Acting as the person on this isolated fixture: production never writes format floors.
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "capture", minReader: "99.0.0", since: "2026-11-09" }]));
  for (const native of [true, false]) {
    const result = await sessionStartBrief({ ...f.options, nativeSession: native ? f.options.nativeSession : undefined, timeRemaining: () => 2000 });
    expect(result.coverage.capture).toBe("unavailable");
    expect(result.context).not.toContain("previous recap");
    expect(result.context).toContain("allowed work above capture floor");
    if (native) expect(result.context).toContain("floor: upgrade amem");
    expect(result.tokens).toBeLessThanOrEqual(1200);
  }
  expect(readFileSync(file)).toEqual(before);
});
