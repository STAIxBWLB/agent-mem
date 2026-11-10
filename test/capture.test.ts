import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore, readCaptureConfig, writeCaptureConfig, writeCaptureConfigFile, CAPTURE_MAX_EXCERPT, CAPTURE_MAX_PATHS, CAPTURE_DRAIN_MAX_LINES, CAPTURE_EVICT_BATCH_ROWS, CAPTURE_EVICT_MAX_BATCHES, CAPTURE_EVICT_MAX_MS } from "../src/memory/capture.ts";
import { MemoryStore } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "amem-capture-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function capture(dir: string, opts: Partial<ConstructorParameters<typeof CaptureStore>[0]> = {}): CaptureStore {
  // Keep fixed spool/migration/cap timestamps inside their fixture clock; retention tests override it.
  const store = new CaptureStore({ home: dir, project: "proj", now: () => Date.parse("2026-10-17T03:00:00.000Z"), ...opts });
  cleanup.push(() => store.close());
  return store;
}
const input = (over: Partial<Parameters<CaptureStore["append"]>[0]> = {}) => ({ project: "proj", agent: "kimi", event: "PostToolUse", tool: "Edit", paths: ["src/a.ts"], status: "ok", excerpt: "edited the storage wiring", ...over });

function spoolLines(dir: string): string[] {
  const files = ["spool.jsonl", "spool.jsonl.draining"].map(name => join(dir, name));
  if (existsSync(join(dir, "spool"))) files.push(...readdirSync(join(dir, "spool")).filter(name => name.startsWith("spool-")).map(name => join(dir, "spool", name)));
  return files.flatMap(file => { try { return readFileSync(file, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } });
}

test("append stores one bounded, screened capture row in the project shard", () => {
  const dir = home();
  const store = capture(dir);
  expect(store.dir).toContain(join("memory", "projects"));
  expect(store.dir).toContain("machine");
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
  const store = capture(dir, { capMb: 0.0015 }); // about 1572 bytes: two of these rows fit, three do not
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
  const writer = capture(dir, { now: () => now, retentionDays: 36500 }); // appends keep every row
  writer.append(input({ excerpt: "ancient row", at: "2026-08-01T00:00:00.000Z" }));
  writer.append(input({ excerpt: "recent row", at: "2026-10-10T00:00:00.000Z" }));
  expect(writer.rows()).toHaveLength(2);
  const store = capture(dir, { now: () => now, retentionDays: 30 }); // the next invocation reads the new bound
  expect(store.evict().expired).toBe(1);
  expect(store.rows().map((r) => r.excerpt)).toEqual(["recent row"]);
  expect(writer.evict().expired).toBe(0); // already gone; eviction reports only what it removed
});

test("shard config applies at the next invocation, the home default fills in, and options win", () => {
  const dir = home();
  const probe = capture(dir);
  writeCaptureConfig(probe.dir, { capMb: 0.25, retentionDays: 7 });
  expect(readCaptureConfig(probe.dir)).toEqual({ capMb: 0.25, retentionDays: 7 });
  const fromFile = capture(dir);
  expect(fromFile.stats()).toMatchObject({ capMb: 0.25, retentionDays: 7 });
  const override = capture(dir, { retentionDays: 90 });
  expect(override.stats().retentionDays).toBe(90);
  // The home default applies to shards without their own override.
  writeCaptureConfigFile(join(dir, "memory", "capture-config.json"), { capMb: 0.5 });
  const other = capture(dir, { project: "other-proj" });
  expect(other.stats()).toMatchObject({ capMb: 0.5, retentionDays: 90 });
  const kept = capture(dir); // this shard's own file still wins over the home default
  expect(kept.stats()).toMatchObject({ capMb: 0.25, retentionDays: 7 });
  expect(() => writeCaptureConfig(probe.dir, { capMb: 0 })).toThrow();
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
  const store = capture(dir, { capMb: 0.001 });
  for (let i = 0; i < 20; i++) store.append(input({ excerpt: `capture row ${i} ${"x".repeat(300)}` }));
  store.evict();
  expect(store.stats().rows).toBeLessThan(20); // eviction really ran
  expect(segments()).toEqual(beforeSegments);
  expect(memory.derivedTables()).toEqual(beforeTables);
  expect(memory.list({ project: "proj" })).toEqual(beforeList);
});

for (const slowMs of [0, 50]) test(`contended writers preserve every row and bounded drains converge (operation delay ${slowMs} ms)`, () => {
  const dir = home(); let workMs = 0;
  // Functional work clock: completed operations consume a known budget even if
  // the host is descheduled. Dedicated R2 scripts retain the real wall gates.
  const clock = spyOn(performance, "now").mockImplementation(() => workMs);
  const drains: { instance: number; drained: number; skipped: number }[] = [];
  const diagnostic = () => JSON.stringify({ slowMs, drains });
  const observed = (store: CaptureStore, instance: number) => {
    const drain = store.drain.bind(store);
    store.drain = () => { const result = drain(); drains.push({ instance, ...result }); return result; };
    return store;
  };
  try {
    const first = observed(capture(dir), 1);
    first.append(input({ excerpt: "before the contention" }));
    const capDir = first.dir, holder = new Database(join(capDir, "capture.db"));
    holder.run("PRAGMA busy_timeout = 0"); holder.run("BEGIN EXCLUSIVE");
    try {
      const blocked = observed(capture(dir), 2);
      expect(blocked.append(input({ excerpt: "spooled under contention", at: "2026-10-17T01:00:00.000Z" }))).toEqual({ spooled: true });
      expect(blocked.append(input({ excerpt: "second spooled row", at: "2026-10-17T01:01:00.000Z" }))).toEqual({ spooled: true });
      expect(blocked.rows().map(r => r.excerpt)).toEqual(["before the contention"]);
      const spooled = spoolLines(capDir);
      expect(spooled).toHaveLength(2);
      expect(spooled.some(line => line.includes("spooled under contention"))).toBe(true);
      expect(spooled.some(line => line.includes("second spooled row"))).toBe(true);
    } finally { holder.run("ROLLBACK"); holder.close(); }
    const late = observed(capture(dir), 3);
    const internal = late as unknown as { insertRow: (row: { excerpt: string }, receipt: string | null) => number | undefined };
    const insert = internal.insertRow.bind(late);
    let slowOperations = 0;
    internal.insertRow = (row, receipt) => {
      const id = insert(row, receipt);
      if (id !== undefined && slowMs) { Bun.sleepSync(slowMs); workMs += slowMs; slowOperations++; }
      return id;
    };
    const expected = ["before the contention", "spooled under contention", "second spooled row"];
    const retained = () => [...late.rows().map(r => r.excerpt), ...spoolLines(capDir).map(line => (JSON.parse(line) as { excerpt: string }).excerpt)];
    // Two pending rows permit at most two progressing drain calls in this fixture.
    // This resumes partial work, never repeats a failed test or waits for a lucky wall time.
    for (let invocation = 0; invocation < 2 && spoolLines(capDir).length; invocation++) {
      const pending = spoolLines(capDir).length, result = late.drain();
      expect(result.skipped, diagnostic()).toBe(0);
      expect(result.drained, diagnostic()).toBeGreaterThan(0);
      expect(result.drained, diagnostic()).toBeLessThanOrEqual(CAPTURE_DRAIN_MAX_LINES);
      expect(spoolLines(capDir).length, diagnostic()).toBe(pending - result.drained);
      expect(retained().sort(), diagnostic()).toEqual([...expected].sort());
      if (slowMs && invocation === 0) { expect(result.drained).toBe(1); expect(spoolLines(capDir)).toHaveLength(1); }
    }
    expect(spoolLines(capDir), diagnostic()).toEqual([]);
    if (slowMs) expect(slowOperations).toBe(2);
    expect(drains.filter(row => row.instance === 3).reduce((n, row) => n + row.drained, 0)).toBe(2);
    const calls = drains.length;
    late.append(input({ excerpt: "after the contention" }));
    expect(drains).toHaveLength(calls + 1); // append still invokes its ordinary drain.
    expect(late.rows().map(r => r.excerpt)).toEqual([...expected, "after the contention"]);
    expect(late.rows()[1]!.at).toBe("2026-10-17T01:00:00.000Z");
    expect(late.rows()[2]!.at).toBe("2026-10-17T01:01:00.000Z");
    expect(existsSync(join(capDir, "spool.jsonl"))).toBe(false);
    expect(existsSync(join(capDir, "spool.jsonl.draining"))).toBe(false);
    expect(late.drain()).toEqual({ drained: 0, skipped: 0 });
    expect(late.rows()).toHaveLength(4);
  } finally { clock.mockRestore(); }
});

test("a leftover draining file from a crashed drain is finished without doubling rows", () => {
  const dir = home();
  const store = capture(dir);
  const line = JSON.stringify({ project: "proj", agent: "kimi", event: "Stop", excerpt: "crashed mid drain", at: "2026-10-17T02:00:00.000Z" });
  writeFileSync(join(store.dir, "spool.jsonl.draining"), line + "\n" + line + "\n", { mode: 0o600 }); // the same line twice: one row
  expect(store.drain().drained).toBe(1);
  expect(store.rows().map((r) => r.excerpt)).toEqual(["crashed mid drain"]);
  expect(existsSync(join(store.dir, "spool.jsonl.draining"))).toBe(false);
});

test("two project shards never contend: one shard locked, the other writes through (#15 AC1)", () => {
  const dir = home();
  const a = capture(dir, { project: "proj-a" });
  const b = capture(dir, { project: "proj-b" });
  expect(a.dir).not.toBe(b.dir);
  a.append(input({ project: "proj-a", excerpt: "row in shard a" }));
  const holder = new Database(join(a.dir, "capture.db"));
  holder.run("PRAGMA busy_timeout = 0");
  holder.run("BEGIN EXCLUSIVE");
  try {
    // Shard B's own lock is free: it writes straight through while A is fully contended.
    const written = b.append(input({ project: "proj-b", excerpt: "row in shard b while a is locked" }));
    expect(written).toHaveProperty("id");
    expect(b.rows().map((r) => r.excerpt)).toEqual(["row in shard b while a is locked"]);
    expect(a.append(input({ project: "proj-a", excerpt: "a spools meanwhile" }))).toEqual({ spooled: true });
  } finally { holder.run("ROLLBACK"); holder.close(); }
  expect(a.drain().drained).toBe(1);
  expect(a.rows().map((r) => r.excerpt)).toEqual(["row in shard a", "a spools meanwhile"]);
});

test("the pre-T1 machine-wide capture store migrates into the project shard on open", () => {
  const dir = home();
  const legacyDir = join(dir, "memory", "capture");
  mkdirSync(legacyDir, { recursive: true });
  const legacy = new Database(join(legacyDir, "capture.db"), { create: true });
  legacy.run(`CREATE TABLE rows (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, project TEXT NOT NULL, agent TEXT NOT NULL, event TEXT NOT NULL,
    tool TEXT, paths TEXT NOT NULL, status TEXT, excerpt TEXT NOT NULL, bytes INTEGER NOT NULL, spool_id TEXT)`);
  legacy.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = (project: string, excerpt: string, at: string) => legacy.query("INSERT INTO rows (at, project, agent, event, tool, paths, status, excerpt, bytes, spool_id) VALUES (?, ?, ?, ?, NULL, '[]', NULL, ?, 100, NULL)")
    .run(at, project, "kimi", "PostToolUse", excerpt);
  row("proj", "legacy row of proj", "2026-10-16T00:00:00.000Z");
  row("other", "legacy row of another project", "2026-10-16T00:01:00.000Z");
  legacy.close();
  const store = capture(dir);
  expect(store.migrated).toBe(1);
  expect(store.rows().map((r) => [r.at, r.excerpt])).toEqual([["2026-10-16T00:00:00.000Z", "legacy row of proj"]]);
  expect(existsSync(join(legacyDir, "capture.db"))).toBe(true); // the other project's rows wait for its own open
  const again = capture(dir);
  expect(again.migrated).toBe(0); // idempotent: nothing moves twice
  expect(again.rows()).toHaveLength(1);
  const other = capture(dir, { project: "other" });
  expect(other.migrated).toBe(1);
  expect(other.rows().map((r) => r.excerpt)).toEqual(["legacy row of another project"]);
  expect(existsSync(legacyDir)).toBe(false); // emptied: the legacy layout is gone
});

test("P1: the spool holds only the screened, bounded, deny-filtered row; any drainer inserts it as-is", () => {
  const dir = home();
  const strict = capture(dir, { screen: () => true }); // a stricter host screen: every excerpt is screened
  const holder = new Database(join(strict.dir, "capture.db"));
  holder.run("PRAGMA busy_timeout = 0");
  holder.run("BEGIN EXCLUSIVE");
  try {
    const blocked = capture(dir, { screen: () => true });
    const pii = `PATIENT ${"x".repeat(5146)}`;
    expect(blocked.append(input({ excerpt: pii, paths: [".ssh/id_rsa", "src/a.ts"] }))).toEqual({ spooled: true });
    const spooled = spoolLines(strict.dir);
    expect(spooled).toHaveLength(1);
    expect(spooled[0]).not.toContain("PATIENT"); // nothing unscreened reaches the spool
    expect(spooled[0]).not.toContain("id_rsa");
    expect(spooled[0]).toContain("[secret-screened]");
  } finally { holder.run("ROLLBACK"); holder.close(); }
  const drainer = capture(dir); // the default screen drains: the row stays exactly what the host screened
  expect(drainer.drain().drained).toBe(1);
  expect(drainer.rows()).toHaveLength(1);
  expect(drainer.rows()[0]!.excerpt).toBe("[secret-screened]");
  expect(drainer.rows()[0]!.paths).toEqual(["src/a.ts"]);
});

test("the pre-T1 legacy spool drains into the project shard instead of being deleted", () => {
  const dir = home();
  const legacyDir = join(dir, "memory", "capture");
  mkdirSync(legacyDir, { recursive: true });
  const legacy = new Database(join(legacyDir, "capture.db"), { create: true });
  legacy.run(`CREATE TABLE rows (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, project TEXT NOT NULL, agent TEXT NOT NULL, event TEXT NOT NULL,
    tool TEXT, paths TEXT NOT NULL, status TEXT, excerpt TEXT NOT NULL, bytes INTEGER NOT NULL, spool_id TEXT)`);
  legacy.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  legacy.close();
  writeFileSync(join(legacyDir, "spool.jsonl"), [
    JSON.stringify({ project: "proj", agent: "kimi", event: "Stop", excerpt: "legacy spooled row of proj", at: "2026-10-16T03:00:00.000Z" }),
    JSON.stringify({ project: "other", agent: "kimi", event: "Stop", excerpt: "legacy spooled row of another project", at: "2026-10-16T03:01:00.000Z" }),
  ].join("\n") + "\n");
  const store = capture(dir);
  store.drain();
  expect(store.rows().map((r) => [r.at, r.excerpt])).toEqual([["2026-10-16T03:00:00.000Z", "legacy spooled row of proj"]]);
  expect(readFileSync(join(legacyDir, "spool.jsonl"), "utf8")).toContain("another project"); // the other project's lines wait
  const other = capture(dir, { project: "other" });
  other.drain();
  expect(other.rows().map((r) => r.excerpt)).toEqual(["legacy spooled row of another project"]);
  expect(existsSync(legacyDir)).toBe(false); // rows and spool both emptied: the legacy layout is gone
});

test("N1: insert/byte-count rollback prevents duplicates and a post-commit eviction lock is non-fatal", () => {
  const dir = home(), store = capture(dir);
  const internals = store as unknown as { addBytes: (delta: number) => void; evict: () => { expired: number; trimmed: number } };
  const addBytes = internals.addBytes;
  internals.addBytes = () => { throw new Error("database is locked"); };
  expect(store.append(input({ excerpt: "atomic insert" }))).toEqual({ spooled: true });
  expect(store.rows()).toHaveLength(0); // the INSERT rolled back with its failed byte-count update
  internals.addBytes = addBytes;
  expect(store.drain().drained).toBe(1);
  expect(store.rows()).toHaveLength(1);

  internals.evict = () => { throw new Error("database is locked"); };
  expect(store.append(input({ excerpt: "eviction lock" }))).toHaveProperty("id");
  expect(existsSync(join(store.dir, "spool.jsonl"))).toBe(false);
  expect(store.drain().drained).toBe(0);
  expect(store.rows()).toHaveLength(2); // one event, one row: no post-commit respool
});

test("an incomplete spool row is skipped and counted without blocking later rows or appends", () => {
  const dir = home(), store = capture(dir);
  const poison = JSON.stringify({ at: "2026-10-17T00:00:00.000Z", excerpt: "missing fields", bytes: 100 });
  const valid = JSON.stringify({ at: "2026-10-17T00:00:01.000Z", project: "proj", agent: "kimi", event: "Stop", tool: null, paths: [], status: null, excerpt: "valid after poison", bytes: 100 });
  writeFileSync(join(store.dir, "spool.jsonl"), poison + "\n" + valid + "\n", { mode: 0o600 });
  expect(store.drain()).toMatchObject({ drained: 1, skipped: 1 });
  expect(store.append(input({ excerpt: "later append" }))).toHaveProperty("id");
  expect(store.rows().map((row) => row.excerpt)).toEqual(["valid after poison", "later append"]);
});

test("P2-7: cap-shrink eviction bounds each work batch and converges after a slow operation", () => {
  const dir = home(), excerpt = "e".repeat(900), writer = capture(dir, { capMb: 100 });
  for (let i = 0; i < 4000; i++) writer.append(input({ excerpt, at: `2026-10-17T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z` }));
  const oversized = writer.stats().bytes;
  expect(oversized).toBeGreaterThan(1024 * 1024);
  const shrink = capture(dir, { capMb: 0.001 }), capBytes = 0.001 * 1024 * 1024;
  type Run = ((...args: never[]) => unknown) & { immediate: (...args: never[]) => unknown };
  const internal = shrink as unknown as {
    db: { transaction: (fn: (...args: never[]) => unknown) => Run; query: (sql: string) => { get(): unknown } };
    evictWhere: (where: string, bind: string[], start: number) => { rows: number; bytes: number };
  };
  const count = () => (internal.db.query("SELECT count(*) AS n FROM rows").get() as { n: number }).n;
  const transaction = internal.db.transaction.bind(internal.db), evictWhere = internal.evictWhere.bind(shrink);
  const passes: { batches: number; rows: number }[] = [];
  let pass: { batches: number; rows: number } | undefined, workMs = 0, operationMs = 207, slowOperations = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => workMs);
  // Same instance/transaction seam used by scripts/budget-hook-child.ts. Count
  // actual rows removed, not FTS-trigger changes or a new product test port.
  internal.db.transaction = fn => {
    const run = transaction(fn);
    const observed = (call: (...args: never[]) => unknown) => (...args: never[]) => {
      const current = pass; if (!current) return call(...args);
      const before = count(), result = call(...args), removed = before - count();
      expect(removed).toBeGreaterThan(0); expect(removed).toBeLessThanOrEqual(CAPTURE_EVICT_BATCH_ROWS);
      current.batches++; current.rows += removed;
      if (operationMs === 207) { Bun.sleepSync(operationMs); slowOperations++; }
      workMs += operationMs;
      return result;
    };
    return Object.assign(observed(run), { immediate: observed(run.immediate.bind(run)) });
  };
  internal.evictWhere = (where, bind, start) => {
    const current = pass = { batches: 0, rows: 0 };
    try {
      const result = evictWhere(where, bind, start);
      expect(result.rows).toBe(current.rows);
      expect(current.batches).toBeLessThanOrEqual(CAPTURE_EVICT_MAX_BATCHES);
      return result;
    } finally { passes.push(current); pass = undefined; }
  };
  const append = (text: string) => {
    const before = count(), at = passes.length;
    expect(shrink.append(input({ excerpt: text }))).toHaveProperty("id");
    const calls = passes.slice(at), batches = calls.reduce((n, row) => n + row.batches, 0);
    expect(before + 1 - count()).toBe(calls.reduce((n, row) => n + row.rows, 0));
    // The batch count is bounded by the operation cost fed to the shared budget.
    // Four batches bound one evictWhere pass, not every possible fast append.
    expect(batches).toBeLessThanOrEqual(Math.ceil(CAPTURE_EVICT_MAX_MS / operationMs));
    expect(shrink.stats().bytes).toBe((internal.db.query("SELECT coalesce(sum(bytes), 0) AS n FROM rows").get() as { n: number }).n);
    return batches;
  };
  try {
    expect(append("trigger eviction")).toBe(1);
    expect(slowOperations).toBe(1); expect(workMs).toBe(207); // old <150ms witness would reject this completed batch.
    const afterOne = shrink.stats().bytes;
    expect(afterOne).toBeLessThan(oversized);
    expect(afterOne).toBeGreaterThan(capBytes);
    operationMs = 1;
    for (let invocation = 0; invocation < 200 && shrink.stats().bytes > capBytes; invocation++) append("x");
    expect(passes.some(row => row.batches === CAPTURE_EVICT_MAX_BATCHES)).toBe(true);
    expect(shrink.stats().bytes).toBeLessThanOrEqual(capBytes);
  } finally { clock.mockRestore(); }
});

test("AC3 tripwire: the capture and search modules make no network or model call", () => {
  for (const name of ["capture.ts", "search-fts.ts", "screen.ts", "shard.ts", "catalog.ts"]) {
    const source = readFileSync(join(import.meta.dir, "../src/memory", name), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(|node:https?\b|node:net\b|node:tls\b|node:dgram\b|Bun\.serve|Bun\.connect|WebSocket|XMLHttpRequest/);
  }
});
