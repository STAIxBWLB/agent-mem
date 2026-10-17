import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore, readCaptureConfig, writeCaptureConfig, CAPTURE_MAX_EXCERPT, CAPTURE_MAX_PATHS } from "../src/memory/capture.ts";
import { captureHome } from "../src/memory/home.ts";
import { MemoryStore } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "amem-capture-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const input = (over: Partial<Parameters<CaptureStore["append"]>[0]> = {}) => ({ project: "proj", agent: "kimi", event: "PostToolUse", tool: "Edit", paths: ["src/a.ts"], status: "ok", excerpt: "edited the storage wiring", ...over });

test("append stores one bounded, screened capture row", () => {
  const dir = home();
  const store = new CaptureStore({ home: dir });
  cleanup.push(() => store.close());
  const denied = store.append(input({ paths: [".env", "src/a.ts"], excerpt: "token=abc123456789" }));
  expect(denied).toHaveProperty("id");
  const huge = store.append(input({ paths: Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`), excerpt: "x".repeat(CAPTURE_MAX_EXCERPT + 500) }));
  expect(huge).toHaveProperty("id");
  const rows = store.rows();
  expect(rows).toHaveLength(2);
  expect(rows[0]!.paths).toEqual(["src/a.ts"]); // denied paths never enter the tier
  expect(rows[0]!.excerpt).toBe("[secret-screened]");
  expect(rows[1]!.paths).toHaveLength(CAPTURE_MAX_PATHS);
  expect(rows[1]!.excerpt).toHaveLength(CAPTURE_MAX_EXCERPT);
  expect(rows[0]).toMatchObject({ project: "proj", agent: "kimi", event: "PostToolUse", tool: "Edit", status: "ok" });
});

test("cap eviction removes the oldest capture rows first and stays under the cap", () => {
  const dir = home();
  const excerpt = "e".repeat(500);
  const store = new CaptureStore({ home: dir, capMb: 0.0015 }); // about 1572 bytes: two of these rows fit, three do not
  cleanup.push(() => store.close());
  for (let i = 0; i < 10; i++) store.append(input({ excerpt, at: `2026-10-17T00:${String(i).padStart(2, "0")}:00.000Z` }));
  const stats = store.stats();
  expect(stats.bytes).toBeLessThanOrEqual(0.0015 * 1024 * 1024);
  const rows = store.rows();
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows.length).toBeLessThan(10);
  expect(rows[rows.length - 1]!.at).toBe("2026-10-17T00:09:00.000Z"); // the newest rows survive
  expect(rows[0]!.at > "2026-10-17T00:00:00.000Z").toBe(true); // the oldest went first
});

test("retention eviction removes rows older than the window", () => {
  const dir = home();
  const now = Date.parse("2026-10-17T00:00:00.000Z");
  const writer = new CaptureStore({ home: dir, now: () => now, retentionDays: 36500 }); // appends keep every row
  cleanup.push(() => writer.close());
  writer.append(input({ excerpt: "ancient row", at: "2026-08-01T00:00:00.000Z" }));
  writer.append(input({ excerpt: "recent row", at: "2026-10-10T00:00:00.000Z" }));
  expect(writer.rows()).toHaveLength(2);
  const store = new CaptureStore({ home: dir, now: () => now, retentionDays: 30 }); // the next invocation reads the new bound
  cleanup.push(() => store.close());
  expect(store.evict().expired).toBe(1);
  expect(store.rows().map((r) => r.excerpt)).toEqual(["recent row"]);
  expect(writer.evict().expired).toBe(0); // already gone; eviction reports only what it removed
});

test("config.json applies at the next invocation and library options override it", () => {
  const dir = home();
  writeCaptureConfig(captureHome(dir), { capMb: 0.25, retentionDays: 7 });
  expect(readCaptureConfig(captureHome(dir))).toEqual({ capMb: 0.25, retentionDays: 7 });
  const fromFile = new CaptureStore({ home: dir });
  cleanup.push(() => fromFile.close());
  expect(fromFile.stats()).toMatchObject({ capMb: 0.25, retentionDays: 7 });
  const override = new CaptureStore({ home: dir, retentionDays: 90 });
  cleanup.push(() => override.close());
  expect(override.stats().retentionDays).toBe(90);
  expect(() => writeCaptureConfig(captureHome(dir), { capMb: 0 })).toThrow();
});

test("capture writes and eviction never touch the curated store", () => {
  const dir = home();
  const memory = new MemoryStore({ home: dir, screen: () => "keep" });
  cleanup.push(() => memory.close());
  memory.note({ op: "note", project: "proj", scope: "project", tier: "long", kind: "decision", peer: "kimi", source: "hub", text: "curated decision", about: ["path:src/a.ts"] });
  memory.goal({ project: "proj", scope: "project", title: "curated goal", milestones: ["ship"], dependsOn: [], actor: "person" });
  const segments = (): Record<string, string> => Object.fromEntries(["log", "local"].flatMap((sub) =>
    readdirSync(join(memory.dir, sub)).sort().filter((n) => n.endsWith(".jsonl")).map((n) => [`${sub}/${n}`, readFileSync(join(memory.dir, sub, n), "utf8")])));
  const beforeSegments = segments(), beforeTables = memory.derivedTables(), beforeList = memory.list({ project: "proj" });
  const capture = new CaptureStore({ home: dir, capMb: 0.001 });
  cleanup.push(() => capture.close());
  for (let i = 0; i < 20; i++) capture.append(input({ excerpt: `capture row ${i} ${"x".repeat(300)}` }));
  capture.evict();
  expect(capture.stats().rows).toBeLessThan(20); // eviction really ran
  expect(segments()).toEqual(beforeSegments);
  expect(memory.derivedTables()).toEqual(beforeTables);
  expect(memory.list({ project: "proj" })).toEqual(beforeList);
});

test("a contended writer spools and exits; the next uncontended writer drains the spool once", () => {
  const dir = home(), capDir = captureHome(dir);
  const first = new CaptureStore({ home: dir });
  cleanup.push(() => first.close());
  first.append(input({ excerpt: "before the contention" }));
  const holder = new Database(join(capDir, "capture.db"));
  holder.run("PRAGMA busy_timeout = 0");
  holder.run("BEGIN EXCLUSIVE");
  try {
    const blocked = new CaptureStore({ home: dir });
    cleanup.push(() => blocked.close());
    expect(blocked.append(input({ excerpt: "spooled under contention", at: "2026-10-17T01:00:00.000Z" }))).toEqual({ spooled: true });
    expect(blocked.append(input({ excerpt: "second spooled row", at: "2026-10-17T01:01:00.000Z" }))).toEqual({ spooled: true });
    // A blocked hook never half-writes: a WAL snapshot read shows only the row committed before the contention.
    expect(blocked.rows().map((r) => r.excerpt)).toEqual(["before the contention"]);
    // Both rows are in the spool: the blocked writer's bounded drain attempt may already have renamed one aside.
    const spooled = ["spool.jsonl", "spool.jsonl.draining"].flatMap((n) => { try { return readFileSync(join(capDir, n), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } });
    expect(spooled).toHaveLength(2);
    expect(spooled.some((line) => line.includes("spooled under contention"))).toBe(true);
    expect(spooled.some((line) => line.includes("second spooled row"))).toBe(true);
  } finally { holder.run("ROLLBACK"); holder.close(); }
  const late = new CaptureStore({ home: dir });
  cleanup.push(() => late.close());
  late.append(input({ excerpt: "after the contention" })); // an uncontended append drains the spool first
  expect(late.rows().map((r) => r.excerpt)).toEqual(["before the contention", "spooled under contention", "second spooled row", "after the contention"]);
  expect(late.rows()[1]!.at).toBe("2026-10-17T01:00:00.000Z"); // the original hook time, not the drain time
  expect(existsSync(join(capDir, "spool.jsonl"))).toBe(false);
  expect(existsSync(join(capDir, "spool.jsonl.draining"))).toBe(false);
  expect(late.drain().drained).toBe(0); // replay is idempotent: no row is doubled
  expect(late.rows()).toHaveLength(4);
});

test("a leftover draining file from a crashed drain is finished without doubling rows", () => {
  const dir = home(), capDir = captureHome(dir);
  const store = new CaptureStore({ home: dir });
  cleanup.push(() => store.close());
  const line = JSON.stringify({ project: "proj", agent: "kimi", event: "Stop", excerpt: "crashed mid drain", at: "2026-10-17T02:00:00.000Z" });
  writeFileSync(join(capDir, "spool.jsonl.draining"), line + "\n" + line + "\n", { mode: 0o600 }); // the same line twice: one row
  expect(store.drain().drained).toBe(1);
  expect(store.rows().map((r) => r.excerpt)).toEqual(["crashed mid drain"]);
  expect(existsSync(join(capDir, "spool.jsonl.draining"))).toBe(false);
});

test("AC3 tripwire: the capture and search modules make no network or model call", () => {
  for (const name of ["capture.ts", "search-fts.ts", "screen.ts"]) {
    const source = readFileSync(join(import.meta.dir, "../src/memory", name), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(|node:https?\b|node:net\b|node:tls\b|node:dgram\b|Bun\.serve|Bun\.connect|WebSocket|XMLHttpRequest/);
  }
});
