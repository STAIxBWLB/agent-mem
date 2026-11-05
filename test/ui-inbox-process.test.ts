import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as platform from "../src/memory/platform.ts";
import { InboxCache, InboxCleanupError, runInboxJob, type InboxJob } from "../src/ui/inbox-cache.ts";
import { inboxSources, inboxPolicyVersion, inboxCaptureConfigVersion, CAPACITY_CACHE_MS } from "../src/ui/inbox.ts";

const FAKE_PID = 987654321;
class FakeChild extends EventEmitter {
  readonly pid = FAKE_PID;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  sent: unknown[] = [];
  fallbackSignals: unknown[] = [];
  send(value: unknown) { this.sent.push(value); return true; }
  kill(signal?: NodeJS.Signals | number) { this.fallbackSignals.push(signal); return true; }
}
const tick = () => Bun.sleep(0);
function jobResult(base: string) {
  const policy = inboxPolicyVersion(base);
  return { type: "result", computation: { items: [], more: 0, policy,
    capacity: { policy, captureConfig: inboxCaptureConfigVersion(base), until: Date.now() + CAPACITY_CACHE_MS, item: null } }, sources: inboxSources(base) };
}

for (const uncertain of ["live", "unknown"] as const) test(`synthetic leader-first ordering keeps ${uncertain} TERM-resistant membership unresolved without post-exit signals or replacement work`, async () => {
  // No native resistant/orphan process is created. Every signal is intercepted; this models ordering,
  // while the separate cooperative fixture and product-worker test provide bounded native evidence.
  const base = mkdtempSync(join(tmpdir(), "amem-inbox-ordering-")), child = new FakeChild();
  let group: platform.Liveness = uncertain, now = Date.now(), starts = 0, job: InboxJob | undefined;
  const signals: { pid: number; signal: number | string | undefined }[] = [];
  const realSignature = platform.processSignatureAsync, realLiveness = platform.processGroupLiveness;
  const fork = spyOn(childProcess, "fork").mockImplementation((() => child as unknown as childProcess.ChildProcess) as typeof childProcess.fork);
  const signature = spyOn(platform, "processSignatureAsync").mockImplementation(pid => pid === FAKE_PID ? Promise.resolve("synthetic-start-identity") : realSignature(pid));
  const liveness = spyOn(platform, "processGroupLiveness").mockImplementation(pid => pid === FAKE_PID ? group : realLiveness(pid));
  const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== -FAKE_PID) throw Error("synthetic ordering test forbids native signal delivery");
    signals.push({ pid, signal }); return true;
  });
  const cache = new InboxCache(base, { now: () => now, runner: value => { starts++; job = runInboxJob(value); return job; } });
  try {
    await cache.snapshot(); expect(starts).toBe(1); expect(job).toBeDefined();
    const outcome = job!.result.then(() => ({ success: true as const }), error => ({ error }));
    child.emit("message", { type: "ready", pid: FAKE_PID, group: FAKE_PID, signature: "synthetic-start-identity" }); await tick();
    expect(child.sent).toHaveLength(1); child.emit("message", jobResult(base));
    const cancellation = job!.cancel().then(() => ({ success: true as const }), error => ({ error }));
    expect(signals).toEqual([{ pid: -FAKE_PID, signal: "SIGTERM" }]);
    child.exitCode = 0; child.emit("close", 0); // Leader exits, but the observed group is not gone.
    const [result, cancelled] = await Promise.all([outcome, cancellation]);
    expect("error" in result && result.error instanceof InboxCleanupError).toBe(true);
    expect("error" in cancelled && cancelled.error instanceof InboxCleanupError).toBe(true);
    await tick(); now += 100000; cache.invalidate();
    const snapshots = await Promise.all(Array.from({ length: 20 }, () => cache.snapshot()));
    expect(snapshots.every(value => !value.complete && !value.refreshing)).toBe(true); expect(starts).toBe(1);
    await expect(cache.close()).rejects.toBeInstanceOf(InboxCleanupError);
    expect(signals).toEqual([{ pid: -FAKE_PID, signal: "SIGTERM" }]); expect(child.fallbackSignals).toEqual([]);
    group = "gone"; await cache.close(); // A later close may observe cleanup, but gains no signalling authority.
    expect(starts).toBe(1); expect(signals).toHaveLength(1);
  } finally {
    group = "gone"; child.exitCode = 0; child.emit("close", 0);
    try { await job?.cancel(); await cache.close(); } finally { kill.mockRestore(); liveness.mockRestore(); signature.mockRestore(); fork.mockRestore(); rmSync(base, { recursive: true, force: true }); }
  }
}, 8000);

test("synthetic ready group mismatch never sends GO and does not signal again after leader exit", async () => {
  const base = mkdtempSync(join(tmpdir(), "amem-inbox-invalid-ready-")), child = new FakeChild(), delivered: unknown[] = [];
  const fork = spyOn(childProcess, "fork").mockImplementation((() => child as unknown as childProcess.ChildProcess) as typeof childProcess.fork);
  const liveness = spyOn(platform, "processGroupLiveness").mockReturnValue("gone");
  const kill = spyOn(process, "kill").mockImplementation((pid, signal) => { if (pid !== -FAKE_PID) throw Error("native signal forbidden"); delivered.push(signal); return true; });
  const job = runInboxJob(base), outcome = job.result.then(() => false, () => true);
  try {
    child.emit("message", { type: "ready", pid: FAKE_PID, group: FAKE_PID - 1, signature: "synthetic-start-identity" }); await tick();
    expect(child.sent).toEqual([]); expect(delivered).toEqual(["SIGTERM"]);
    child.exitCode = 1; child.emit("close", 1); expect(await outcome).toBe(true); await job.cancel(); expect(delivered).toHaveLength(1);
  } finally { child.exitCode = 1; child.emit("close", 1); await job.cancel(); kill.mockRestore(); liveness.mockRestore(); fork.mockRestore(); rmSync(base, { recursive: true, force: true }); }
});

test("actual PRODUCT worker retains its verified idle leader on TERM before GO, then is killed only while live", async () => {
  // No compute/run message is sent, so this native test reads no memory home and spawns no workload descendants.
  const child = childProcess.fork(join(import.meta.dir, "../src/ui/inbox-worker.ts"), [], { execPath: process.execPath, execArgv: ["--smol"],
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json" });
  let exited = false, verified = false, timer: ReturnType<typeof setTimeout> | undefined;
  child.once("exit", () => { exited = true; });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const ready = new Promise<{ type: string; pid: number; group: number; signature: string }>((resolve, reject) => {
    child.once("error", reject); child.once("message", message => resolve(message as { type: string; pid: number; group: number; signature: string }));
  });
  try {
    const value = await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("product worker did not become ready")), 3000); })]);
    if (timer) clearTimeout(timer); timer = undefined;
    expect(value.type).toBe("ready"); expect(value.pid).toBe(child.pid!); expect(value.group).toBe(child.pid!);
    expect(value.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(value.signature).toBe(await platform.processSignatureAsync(child.pid!)); verified = true;
    expect(child.exitCode).toBeNull(); process.kill(-child.pid!, "SIGTERM"); await Bun.sleep(150);
    expect(exited).toBe(false); expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    expect(await platform.processSignatureAsync(child.pid!)).toBe(value.signature);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { if (verified) process.kill(-child.pid!, "SIGKILL"); else child.kill("SIGKILL"); }
    let reap: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_, reject) => { reap = setTimeout(() => reject(Error("product worker cleanup unavailable")), 2000); })]); }
    finally { if (reap) clearTimeout(reap); }
  }
  expect(platform.processGroupLiveness(child.pid)).toBe("gone");
}, 6000);

test("async identity matches the pinned synchronous self contract and rejects invalid probes", async () => {
  const expected = platform.processSignature(process.pid); expect(expected).toMatch(/^[a-f0-9]{64}$/);
  expect(await platform.processSignatureAsync(process.pid)).toBe(expected);
  const group = await platform.processGroupIdAsync(process.pid); expect(Number.isSafeInteger(group)).toBe(true); expect(group!).toBeGreaterThan(0);
  for (const pid of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    expect(await platform.processSignatureAsync(pid)).toBeUndefined(); expect(await platform.processGroupIdAsync(pid)).toBeUndefined();
  }
});

test("read-only group observations distinguish occupancy and missing permission without signalling fake PIDs", () => {
  const kill = spyOn(process, "kill");
  try {
    kill.mockImplementation(() => true); expect(platform.processGroupLiveness(FAKE_PID)).toBe("live");
    kill.mockImplementation(() => { throw Object.assign(Error("missing permission"), { code: "EPERM" }); }); expect(platform.processGroupLiveness(FAKE_PID)).toBe("unknown");
    kill.mockImplementation(() => { throw Object.assign(Error("absent group"), { code: "ESRCH" }); }); expect(platform.processGroupLiveness(FAKE_PID)).toBe("gone");
    kill.mockClear();
    for (const invalid of [undefined, "1", 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(platform.processGroupLiveness(invalid)).toBe("unknown");
    expect(kill).not.toHaveBeenCalled();
  } finally { kill.mockRestore(); }
});

async function boundedSyntheticObservation<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("synthetic cleanup observations did not settle")), 4500); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test("SYNTHETIC no-close leader rejects result/cancel within the cleanup bound and blocks replacement work", async () => {
  const base = mkdtempSync(join(tmpdir(), "amem-inbox-no-close-")), child = new FakeChild();
  let group: platform.Liveness = "live", starts = 0, job: InboxJob | undefined;
  const signals: (number | string | undefined)[] = [];
  const fork = spyOn(childProcess, "fork").mockImplementation((() => child as unknown as childProcess.ChildProcess) as typeof childProcess.fork);
  const signature = spyOn(platform, "processSignatureAsync").mockResolvedValue("synthetic-start-identity");
  const liveness = spyOn(platform, "processGroupLiveness").mockImplementation(() => group);
  const kill = spyOn(process, "kill").mockImplementation((pid, signal) => { if (pid !== -FAKE_PID) throw Error("native signal forbidden"); signals.push(signal); return true; });
  const cache = new InboxCache(base, { runner: value => { starts++; job = runInboxJob(value); return job; } });
  try {
    await cache.snapshot(); const outcome = job!.result.then(() => ({ success: true as const }), error => ({ error }));
    child.emit("message", { type: "ready", pid: FAKE_PID, group: FAKE_PID, signature: "synthetic-start-identity" }); await tick();
    expect(child.sent).toHaveLength(1);
    const at = performance.now(), cancelled = job!.cancel().then(() => ({ success: true as const }), error => ({ error }));
    // Neither signal changes this fake native handle or emits close, modelling uncompleted termination.
    const [result, cancellation] = await boundedSyntheticObservation(Promise.all([outcome, cancelled]));
    expect("error" in result && result.error instanceof InboxCleanupError).toBe(true);
    expect("error" in cancellation && cancellation.error instanceof InboxCleanupError).toBe(true);
    expect(performance.now() - at).toBeGreaterThanOrEqual(2500); expect(performance.now() - at).toBeLessThan(3500);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]); expect(child.exitCode).toBeNull();
    await tick(); cache.invalidate();
    const blocked = await Promise.all(Array.from({ length: 20 }, () => cache.snapshot()));
    expect(blocked.every(value => !value.complete && !value.refreshing)).toBe(true); expect(starts).toBe(1);
  } finally {
    // Only synthetic state is released. No signal is delivered to any native PID in this test.
    group = "gone"; child.exitCode = 0; child.emit("close", 0);
    try { await job?.cancel(); await cache.close(); } finally { kill.mockRestore(); liveness.mockRestore(); signature.mockRestore(); fork.mockRestore(); rmSync(base, { recursive: true, force: true }); }
  }
}, 8000);

test("SYNTHETIC pending identity probe cannot keep a closed leader result/cancel pending beyond cleanup bound", async () => {
  const base = mkdtempSync(join(tmpdir(), "amem-inbox-probe-pending-")), child = new FakeChild();
  let group: platform.Liveness = "live", release!: (value: string | undefined) => void;
  const probe = new Promise<string | undefined>(resolve => { release = resolve; }), signals: (number | string | undefined)[] = [];
  const fork = spyOn(childProcess, "fork").mockImplementation((() => child as unknown as childProcess.ChildProcess) as typeof childProcess.fork);
  const signature = spyOn(platform, "processSignatureAsync").mockImplementation(() => probe);
  const liveness = spyOn(platform, "processGroupLiveness").mockImplementation(() => group);
  const kill = spyOn(process, "kill").mockImplementation((pid, signal) => { if (pid !== -FAKE_PID) throw Error("native signal forbidden"); signals.push(signal); return true; });
  const job = runInboxJob(base), outcome = job.result.then(() => ({ success: true as const }), error => ({ error }));
  try {
    child.emit("message", { type: "ready", pid: FAKE_PID, group: FAKE_PID, signature: "synthetic-start-identity" }); await tick();
    expect(signature).toHaveBeenCalledTimes(1); expect(child.sent).toEqual([]);
    child.exitCode = 0; const at = performance.now(); child.emit("close", 0); // readyProbe remains deliberately unresolved.
    const cancelled = job.cancel().then(() => ({ success: true as const }), error => ({ error }));
    const [result, cancellation] = await boundedSyntheticObservation(Promise.all([outcome, cancelled]));
    expect("error" in result && result.error instanceof InboxCleanupError).toBe(true);
    expect("error" in cancellation && cancellation.error instanceof InboxCleanupError).toBe(true);
    expect(performance.now() - at).toBeGreaterThanOrEqual(2500); expect(performance.now() - at).toBeLessThan(3500);
    expect(child.sent).toEqual([]); expect(signals).toEqual([]); expect(child.fallbackSignals).toEqual([]);
  } finally {
    group = "gone"; release("synthetic-start-identity"); await tick();
    try { await job.cancel(); } finally { kill.mockRestore(); liveness.mockRestore(); signature.mockRestore(); fork.mockRestore(); rmSync(base, { recursive: true, force: true }); }
  }
}, 8000);
