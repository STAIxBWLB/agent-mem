import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SyncProgress, readSyncStatus, renderSyncProgress, renderSyncStatus, syncProgressSidecar, SYNC_PROGRESS_DIR, type SyncProgressSnapshot } from "../src/memory/sync-progress.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function home() { const dir = mkdtempSync(join(tmpdir(), "amem-sync-progress-")); chmodSync(dir, 0o700); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function clocks() { const clock = { wall: 1_000_000, mono: 0 }; return { clock, now: () => clock.wall, mono: () => clock.mono }; }

test("a phase is reported at once; unit updates are rate-limited; a heartbeat never advances work", () => {
  const { clock, now, mono } = clocks(), seen: SyncProgressSnapshot[] = [];
  const progress = new SyncProgress({ sink: s => seen.push(s), intervalMs: 1000, now, mono, operationId: "a".repeat(16) });
  expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ phase: "writer-verification", state: "running", elapsedMs: 0 });
  clock.mono = 10; clock.wall += 10; progress.phase("policy-evaluation", "rows", 1131);
  expect(seen.at(-1)).toMatchObject({ phase: "policy-evaluation", unit: "rows", completed: 0, total: 1131, attempt: 1 });
  for (let index = 0; index < 419; index++) { clock.mono += 1; clock.wall += 1; progress.advance(); }
  expect(seen).toHaveLength(2);
  clock.mono += 1000; clock.wall += 1000; progress.advance();
  expect(seen.at(-1)).toMatchObject({ completed: 420, total: 1131 });
  const work = seen.at(-1)!.lastWorkProgressUnixMs;
  clock.mono += 5000; clock.wall += 5000; progress.alive();
  expect(seen.at(-1)).toMatchObject({ completed: 420, lastWorkProgressUnixMs: work, lastAliveUnixMs: work + 5000 });
  const line = renderSyncProgress(seen.at(-1)!, clock.wall + 1000);
  expect(line).toBe("amem sync: policy evaluation: 420/1131 rows; elapsed 6s; last work progress 6s ago"); expect(line).not.toContain("%");
});

test("a re-entered phase gets a new attempt identity; terminal state is final; a throwing sink is dropped", () => {
  const { now, mono } = clocks(), seen: SyncProgressSnapshot[] = []; let calls = 0;
  const progress = new SyncProgress({ sink: s => { seen.push(s); if (++calls === 4) throw Error("observer failure"); }, intervalMs: 0, now, mono });
  progress.phase("journal", "records", 3); progress.advance(); progress.phase("journal", "records", 3);
  expect(seen.at(-1)).toMatchObject({ phase: "journal", attempt: 2, completed: 0 });
  progress.finish("failed", "unavailable"); progress.finish("succeeded"); progress.advance();
  expect(calls).toBe(4); expect(progress.snapshot()).toMatchObject({ state: "failed", cause: "unavailable" });
});

test("sidecars keep one file per operation, and status reports a dead running owner as interrupted, never success", () => {
  const dir = home(), alive = { pid: process.pid }, dead = { pid: 2 ** 22 + 12345 };
  const a = new SyncProgress({ sink: syncProgressSidecar(dir, alive), intervalMs: 0, operationId: "1".repeat(16) });
  const b = new SyncProgress({ sink: syncProgressSidecar(dir, dead), intervalMs: 0, operationId: "2".repeat(16) });
  a.phase("policy-evaluation", "rows", 10); a.advance(4); b.phase("import"); a.finish("succeeded");
  expect(readdirSync(join(dir, SYNC_PROGRESS_DIR)).sort()).toEqual(["1".repeat(16) + ".json", "2".repeat(16) + ".json"]);
  const report = readSyncStatus(dir, Date.now(), pid => pid === dead.pid ? "gone" : "live");
  const byId = new Map(report.operations.map(row => [row.operationId, row]));
  expect(byId.get("1".repeat(16))).toMatchObject({ state: "succeeded" }); expect(byId.get("2".repeat(16))).toMatchObject({ state: "interrupted", phase: "import", ownerLiveness: "gone" });
  const text = renderSyncStatus(report); expect(text).toContain("interrupted in import"); expect(text).toContain("not a successful sync");
});

test("malformed, oversized or injected sidecars are counted, never rendered; a missing directory reports nothing", () => {
  const dir = home(); expect(readSyncStatus(dir)).toEqual({ operations: [], malformed: 0 });
  mkdirSync(join(dir, SYNC_PROGRESS_DIR), { mode: 0o700 });
  writeFileSync(join(dir, SYNC_PROGRESS_DIR, "3".repeat(16) + ".json"), "{not json", { mode: 0o600 });
  writeFileSync(join(dir, SYNC_PROGRESS_DIR, "4".repeat(16) + ".json"), JSON.stringify({ schema: "agent-mem.sync-progress/v1", operationId: "4".repeat(16), state: "running", phase: "import\u001b[2J" }), { mode: 0o600 });
  writeFileSync(join(dir, SYNC_PROGRESS_DIR, "5".repeat(16) + ".json"), "x".repeat(5000), { mode: 0o600 });
  const report = readSyncStatus(dir); expect(report).toEqual({ operations: [], malformed: 3 });
  expect(renderSyncStatus(report)).toBe("no placement sync operation recorded (3 unreadable status files ignored)");
});

test("status is read-only and bounded to the newest operations", () => {
  const dir = home();
  for (let index = 0; index < 12; index++) new SyncProgress({ sink: syncProgressSidecar(dir, { pid: process.pid }), intervalMs: 0, operationId: index.toString(16).padStart(16, "0") }).finish("succeeded");
  const before = readdirSync(join(dir, SYNC_PROGRESS_DIR)).sort(); expect(before.length).toBeLessThanOrEqual(8);
  expect(readSyncStatus(dir).operations.length).toBeLessThanOrEqual(8); expect(readdirSync(join(dir, SYNC_PROGRESS_DIR)).sort()).toEqual(before);
});

test("#426: a failed operation records its refusal category in the sidecar and amem sync --status shows it; a tampered category is rejected", () => {
  const dir = home(), { now, mono } = clocks();
  const progress = new SyncProgress({ sink: syncProgressSidecar(dir), intervalMs: 0, now, mono, operationId: "c".repeat(16) });
  progress.phase("remote-verification"); progress.finish("failed", "unavailable", "remote");
  const report = readSyncStatus(dir, now());
  expect(report.operations[0]).toMatchObject({ state: "failed", cause: "unavailable", category: "remote", phase: "remote-verification" });
  expect(renderSyncStatus(report, now())).toContain("failed (unavailable, remote) in remote verification");
  const ok = new SyncProgress({ sink: () => {}, now, mono }); ok.finish("succeeded", undefined, "lock");
  const file = join(dir, SYNC_PROGRESS_DIR, `${"c".repeat(16)}.json`), saved = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...saved, category: "\u001b[31m/etc/passwd" }), { mode: 0o600 });
  expect(readSyncStatus(dir, now()).operations).toHaveLength(0);
});

test("N-1: the 0.28.2 status reader reads a 0.29.0 inventory sidecar without a strict-schema refusal", async () => {
  // Fixture is the verbatim v0.28.2 reader (`git show v0.28.2:src/memory/sync-progress.ts` and its two imports).
  const old = await import("./fixtures/sync-progress-0.28.2/sync-progress.ts");
  const dir = home(), progress = new SyncProgress({ sink: syncProgressSidecar(dir, { pid: process.pid }), intervalMs: 0, operationId: "3".repeat(16) });
  progress.inventory({ publications: 2, completed: 1, realms: 3, outcomes: [{ realm: "user", outcome: "committed" }, { realm: "a".repeat(16), outcome: "not-local" }] });
  const current = readSyncStatus(dir, Date.now(), () => "live");
  expect(current.operations[0]?.inventory?.outcomes).toContainEqual({ realm: "a".repeat(16), outcome: "not-local" });
  const report = old.readSyncStatus(dir, Date.now(), () => "live");
  expect(report.malformed).toBe(0); expect(report.operations).toHaveLength(1);
  expect(report.operations[0]).toMatchObject({ operationId: "3".repeat(16), state: "running" });
  expect(old.renderSyncStatus(report)).toContain(`${"3".repeat(16)} writer verification`);
});


test("#450: deferred failure retains category until all inventory outcomes are recorded", () => {
  const dir = home(), progress = new SyncProgress({ sink: syncProgressSidecar(dir), intervalMs: 0 });
  progress.deferFinish(true);
  progress.finish("failed", "unavailable", "remote");
  expect(progress.snapshot().state).toBe("running");
  progress.inventory({ publications: 2, completed: 1, realms: 3, outcomes: [
    { realm: "user", outcome: "committed" }, { realm: "a".repeat(16), outcome: "failed" }, { realm: "b".repeat(16), outcome: "not-run" },
  ] });
  progress.deferFinish(false);
  expect(readSyncStatus(dir).operations[0]).toMatchObject({ state: "failed", cause: "unavailable", category: "remote", inventory: { completed: 1, outcomes: [
    { realm: "user", outcome: "committed" }, { realm: "a".repeat(16), outcome: "failed" }, { realm: "b".repeat(16), outcome: "not-run" },
  ] } });
});
