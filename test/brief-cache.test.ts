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
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-brief-cache-")); roots.push(root);
  const base = join(root, "memory"), project = "cache-project";
  const capture = new CaptureStore({ memoryDir: base, project });
  const append = (excerpt: string, event = "Recap", subagent = false) => {
    const result = capture.append({ project, agent: "claude", event, excerpt, paths: ["public.ts", "other.ts", "hidden.ts"], session: "a".repeat(16), subagent });
    if (!("id" in result)) throw Error("fixture append spooled");
    return result.id;
  };
  const id = append("previous recap"); append("subagent forbidden", "Recap", true);
  await buildCaptureBriefCache(capture, { base, project, cwd: root, builtThrough: id });
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

test("capture is preloaded before slow work spends the deadline, with output order preserved", async () => {
  const f = await fixture(), work = new WorkListStore({ base: f.base, project: f.project, policy: () => true });
  await work.write("queue", { task: "slow-work", status: "doing" }); work.close();
  let remaining = 70, reached = false, captureScreenedBeforeWork = false;
  const native = await sessionStartBrief({ ...f.options, timeRemaining: () => remaining, policy: { host: { screen: async value => {
    const text = JSON.stringify(value);
    if (text.includes("previous recap") && !reached) captureScreenedBeforeWork = true;
    if (text.includes("slow-work")) { reached = true; remaining = -1; }
    return true;
  } } } });
  expect(reached).toBe(true);
  expect(captureScreenedBeforeWork).toBe(true);
  expect(native.context).toContain("previous recap");
  expect(native.context.indexOf('"section":"work"')).toBeLessThan(native.context.indexOf('"section":"capture"'));
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
