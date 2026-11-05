import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { configuredPolicy } from "../memory/config.ts";
import { processGroupLiveness, processSignatureAsync, realPath, type Liveness } from "../memory/platform.ts";
import { INBOX_MAX_BYTES, INBOX_MAX_ITEMS, boundedInboxRows, inboxPolicyDefaults, inboxPolicyVersion, inboxSourceChange, type CapacityMemo, type InboxComputation, type InboxItem, type InboxSources } from "./inbox.ts";
import { inboxWorkerHash } from "./inbox-worker-version.ts";

export const INBOX_WORKER_HASH = inboxWorkerHash();
export interface InboxJobResult { computation: InboxComputation; sources: InboxSources }
export interface InboxJob { result: Promise<InboxJobResult>; cancel(): Promise<void>; observeCleanup?(): Liveness }
export type InboxRunner = (base: string, capacity?: CapacityMemo) => InboxJob;
export interface InboxSnapshot { items: InboxItem[]; more: number; complete: boolean; refreshing: boolean; generatedAt?: string }
const WORK_MS = 30_000, REAP_MS = 2000, MIN_START_MS = 30_000, MAX_BACKOFF_MS = 300_000;
export class InboxCleanupError extends Error {
  readonly group: number | undefined;
  constructor(group?: number) {
    const valid = group !== undefined && Number.isSafeInteger(group) && group > 0 ? group : undefined;
    super(`inbox worker group ${valid ?? "unknown"} cleanup is unresolved`); this.name = "InboxCleanupError"; this.group = valid;
  }
}
export class InboxDeadlineError extends InboxCleanupError { constructor(group?: number) { super(group); this.name = "InboxDeadlineError"; } }
export class InboxChangedError extends Error { constructor() { super("inbox sources changed"); this.name = "InboxChangedError"; } }
export class InboxRuntimeError extends Error { constructor(message: string) { super(message); this.name = "InboxRuntimeError"; } }
async function waitForGroupGone(group: number | undefined): Promise<void> {
  if (group === undefined) return;
  const until = performance.now() + REAP_MS;
  for (;;) {
    const state = processGroupLiveness(group);
    if (state === "gone") return;
    if (state === "unknown" || performance.now() >= until) throw new InboxCleanupError(group);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
/** Native child handle plus verified detached group: no retired group is ever signalled. */
export const runInboxJob: InboxRunner = (base, capacity) => {
  if (!existsSync(process.execPath)) throw new InboxRuntimeError("bun moved; restart acon serve");
  if (!INBOX_WORKER_HASH || inboxWorkerHash() !== INBOX_WORKER_HASH) throw new InboxRuntimeError("inbox worker changed; restart acon serve");
  const defaults = inboxPolicyDefaults();
  const child = fork(fileURLToPath(new URL("./inbox-worker.ts", import.meta.url)), [], { execPath: process.execPath, execArgv: ["--smol"], detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json", env: { ...process.env, AMEM_UI_WORKER_HASH: INBOX_WORKER_HASH } });
  let exited = false, cleaned = false, ready = false, groupKnown = false, terminating = false, changed = false, workerMoved = false, payload: InboxJobResult | undefined;
  let readyProbe: Promise<void> | undefined, force: ReturnType<typeof setTimeout> | undefined;
  let fail!: (error: Error) => void, succeed!: (value: InboxJobResult) => void, endedResolve!: () => void, endedReject!: (error: Error) => void;
  const ended = new Promise<void>((resolve, reject) => { endedResolve = resolve; endedReject = reject; }); void ended.catch(() => {});
  const result = new Promise<InboxJobResult>((resolve, reject) => { succeed = resolve; fail = reject; });
  const kill = (signal: NodeJS.Signals) => {
    if (exited || child.exitCode !== null || child.signalCode !== null) return;
    try { if (child.pid) process.kill(-child.pid, signal); } catch { child.kill(signal); }
  };
  const clear = () => { clearTimeout(deadline); if (force) clearTimeout(force); };
  const clean = () => { cleaned = true; exited = true; clear(); endedResolve(); };
  const observe = (): Liveness => {
    if (cleaned) return "gone";
    const state = child.pid === undefined ? "gone" : processGroupLiveness(child.pid);
    if (state === "gone" && (groupKnown || exited || child.exitCode !== null || child.signalCode !== null || child.pid === undefined)) { clean(); return "gone"; }
    return state === "gone" ? "unknown" : state;
  };
  const terminate = () => {
    if (terminating || exited || cleaned) return;
    terminating = true; kill("SIGTERM");
    if (!exited) { force = setTimeout(() => kill("SIGKILL"), 250); force.unref(); }
  };
  const deadline = setTimeout(() => { terminate(); fail(new InboxDeadlineError(child.pid)); }, WORK_MS); deadline.unref();
  child.on("message", (value: unknown) => {
    const message = value as { type?: unknown; pid?: unknown; group?: unknown; signature?: unknown; workerHash?: unknown; computation?: InboxComputation; sources?: InboxSources };
    if (message?.type === "ready" && !ready && !readyProbe) {
      readyProbe = (async () => {
        if (message.workerHash !== INBOX_WORKER_HASH) { workerMoved = true; terminate(); return; }
        if (!child.pid || message.pid !== child.pid || message.group !== child.pid || typeof message.signature !== "string") { terminate(); return; }
        groupKnown = true;
        const signature = await processSignatureAsync(child.pid);
        if (exited || terminating) return;
        if (signature !== message.signature) { terminate(); return; }
        ready = true; child.send({ type: "run", base, capacity, defaults });
      })().catch(() => terminate());
    } else if (ready && message?.type === "result" && message.computation && message.sources) payload = { computation: message.computation, sources: message.sources };
    else if (ready && message?.type === "changed") changed = true;
    else if (message?.type === "moved") workerMoved = true;
  });
  child.once("error", () => {
    if (child.pid === undefined) { clean(); fail(Error("inbox worker unavailable")); } else terminate();
  });
  child.once("close", code => {
    exited = true; clear();
    if (cleaned) return;
    // The proof budget starts here, not at TERM: unrelated event-loop work before close cannot consume it.
    void waitForGroupGone(child.pid).then(() => {
      clean();
      if (code === 0 && payload && !terminating) succeed(payload);
      else fail(workerMoved ? new InboxRuntimeError("inbox worker changed; restart acon serve") : changed ? new InboxChangedError() : Error("inbox worker unavailable"));
    }).catch(() => { const error = new InboxCleanupError(child.pid); endedReject(error); fail(error); });
  });
  return { result, observeCleanup: observe, async cancel() {
    if (observe() === "gone") { fail(Error("inbox worker cancelled")); return; }
    terminate(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ended, new Promise<void>((resolve, reject) => { timer = setTimeout(() => {
      if (observe() === "gone") { fail(Error("inbox worker cancelled")); resolve(); }
      else { const error = new InboxCleanupError(child.pid); endedReject(error); fail(error); reject(error); }
    }, REAP_MS + 1000); })]); fail(Error("inbox worker cancelled")); }
    finally { if (timer) clearTimeout(timer); }
  } };
};

export interface InboxInvalidation { hard?: boolean; capacity?: boolean; removeIds?: readonly string[]; added?: number }
/** Request-driven refresh only. Cooldown/backoff survive source changes and actions. */
export class InboxCache {
  private readonly base: string; private readonly runner: InboxRunner; private readonly log: (line: string) => void;
  private readonly now: () => number; private readonly clock: () => number;
  private cache?: InboxJobResult; private capacity?: CapacityMemo; private observed?: InboxSources;
  private task?: InboxJob; private blockedTask?: InboxJob; private blockedGroup?: number; private request?: Promise<InboxSnapshot>;
  private generation = 0; private closed = false; private pending = true; private stale = false;
  private failureCount = 0; private retryAt = 0; private lastStart?: number; private lastDuration = 0;
  private error?: "failure" | "cleanup" | "runtime"; private errorDetail?: string;
  private generatedAt?: string; private policy?: string; private capacityAt?: string; private overflowAt?: string;
  private state = ""; private stateAt = 0;
  constructor(base: string, options: { runner?: InboxRunner; log?: (line: string) => void; now?: () => number; monotonicNow?: () => number } = {}) {
    const absolute = resolve(base); this.base = existsSync(absolute) ? realPath(absolute) : absolute;
    this.runner = options.runner ?? runInboxJob; this.log = options.log ?? (() => {}); this.now = options.now ?? Date.now;
    this.clock = options.monotonicNow ?? (options.now ? options.now : () => performance.now());
  }
  invalidate(input: boolean | InboxInvalidation = {}): void {
    const change = typeof input === "boolean" ? { hard: input, capacity: input } : input;
    this.generation++; this.pending = true; this.stale = true;
    if (change.hard) { this.cache = undefined; this.observed = undefined; }
    else if (this.cache && (change.removeIds?.length || change.added)) {
      const old = this.cache.computation, actual = old.items.filter(item => item.id !== "inbox:more");
      const removed = new Set(change.removeIds ?? []), shown = actual.filter(item => !removed.has(item.id));
      const total = Math.max(shown.length, actual.length + old.more - removed.size + (change.added ?? 0));
      const hint = old.items.find(item => item.id === "inbox:more");
      Object.assign(old, boundedInboxRows(hint ? [...shown, hint] : shown, total));
    }
    if (change.capacity) this.capacity = undefined;
  }
  private allowed(): boolean {
    return this.clock() >= Math.max(this.retryAt, this.lastStart === undefined ? 0 : this.lastStart + Math.max(MIN_START_MS, this.lastDuration));
  }
  private recover(): void {
    if (!this.blockedTask) return;
    const state = this.blockedTask.observeCleanup ? this.blockedTask.observeCleanup()
      : this.blockedGroup === undefined ? "gone" : processGroupLiveness(this.blockedGroup);
    if (state === "gone") { if (this.task === this.blockedTask) this.task = undefined; this.blockedTask = undefined; this.blockedGroup = undefined; this.error = undefined; }
  }
  private failed(error: unknown, job?: InboxJob): void {
    if (error instanceof InboxChangedError) { this.pending = true; return; }
    this.failureCount = Math.min(20, this.failureCount + 1);
    this.retryAt = this.clock() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(19, this.failureCount - 1));
    this.pending = true; this.error = error instanceof InboxRuntimeError ? "runtime" : error instanceof InboxCleanupError ? "cleanup" : "failure";
    if (error instanceof InboxCleanupError && job && error.group !== undefined) { this.blockedTask = job; this.blockedGroup = error.group; }
    if (error instanceof InboxRuntimeError) { this.cache = undefined; this.errorDetail = error.message; }
    if (!this.closed) try { this.log(error instanceof InboxRuntimeError ? error.message : this.error === "cleanup"
      ? `amem: inbox group ${this.blockedGroup ?? "unknown"} cleanup unresolved; snapshots will observe recovery without signalling it.` : "amem: inbox refresh failed; bounded backoff applies"); } catch {}
  }
  private refresh(): void {
    if (this.closed || this.task || this.blockedTask || !this.pending || !this.allowed()) return;
    const generation = this.generation, started = this.clock(); this.lastStart = started; this.pending = false; this.error = undefined; this.errorDetail = undefined;
    let job: InboxJob;
    try { job = this.runner(this.base, this.capacity); } catch (error) { this.lastDuration = Math.max(0, this.clock() - started); this.failed(error); return; }
    this.task = job;
    void job.result.then(result => {
      const revision = inboxPolicyVersion(this.base), computation = result.computation;
      if (generation !== this.generation || computation.policy !== revision || inboxSourceChange(this.base, result.sources).changed) { this.pending = true; return; }
      if (computation.expiresAt !== null && (!Number.isFinite(computation.expiresAt) || computation.expiresAt < 0)) throw Error("invalid inbox expiry");
      if (computation.expiresAt !== null && this.now() >= computation.expiresAt) { this.invalidate({ hard: true }); return; }
      if (computation.items.length > INBOX_MAX_ITEMS || Buffer.byteLength(JSON.stringify(computation.items)) > INBOX_MAX_BYTES || !Number.isSafeInteger(computation.more) || computation.more < 0) throw Error("invalid inbox result");
      const screen = configuredPolicy(this.base);
      if (computation.items.some(item => item.id !== "inbox:more" && !screen.screenStandalone(item))) throw Error("inbox result declined");
      this.cache = structuredClone(result); this.observed = this.cache.sources; this.capacity = this.cache.computation.capacity;
      const cap = this.cache.computation.items.find(item => item.id === "capacity:proposal");
      if (cap) { this.capacityAt ??= cap.at; cap.at = this.capacityAt; } else this.capacityAt = undefined;
      const overflow = this.cache.computation.items.find(item => item.id === "inbox:more");
      if (overflow) { this.overflowAt ??= overflow.at; overflow.at = this.overflowAt; } else this.overflowAt = undefined;
      this.policy = revision; this.generatedAt = new Date(this.now()).toISOString(); this.stale = false; this.pending = false;
      this.failureCount = 0; this.retryAt = 0; this.error = undefined; this.errorDetail = undefined;
    }).catch(error => this.failed(error, job)).finally(() => {
      this.lastDuration = Math.max(0, this.clock() - started); if (this.task === job) this.task = undefined;
      // No timer or completion callback spawns another process. A later snapshot services one pending rerun.
    });
  }
  private status(): InboxSnapshot {
    const kind = this.error || this.blockedTask ? "unavailable" : "refreshing";
    if (this.state !== kind) { this.state = kind; this.stateAt = Math.max(this.now(), this.stateAt + 1); }
    return { items: [{ id: `inbox:${kind}`, group: "alert", kind: "status", title: kind === "refreshing" ? "Memory inbox is refreshing" : "Memory inbox is unavailable",
      detail: this.errorDetail ?? (kind === "refreshing" ? "Pending items will appear when the refresh finishes." : "Refresh is paused; it will retry after the cooldown."),
      at: new Date(this.stateAt).toISOString(), verbs: [], link: { panel: "review" } }], more: 0, complete: false, refreshing: true };
  }
  snapshot(): Promise<InboxSnapshot> {
    if (this.request) return this.request.then(value => structuredClone(value));
    const request = Promise.resolve().then(() => {
      if (this.closed) throw Error("inbox provider is closed");
      try {
        this.recover(); const revision = inboxPolicyVersion(this.base);
        if (this.policy !== undefined && this.policy !== revision) this.invalidate({ hard: true, capacity: true });
        this.policy = revision;
        if (this.cache) {
          const changed = inboxSourceChange(this.base, this.observed ?? this.cache.sources);
          this.observed = changed.sources;
          if (changed.changed) this.invalidate({ hard: changed.hard, capacity: changed.hard });
          if (this.cache && this.cache.computation.expiresAt !== null && this.now() >= this.cache.computation.expiresAt) this.invalidate({ hard: true });
          if (this.capacity && this.now() >= this.capacity.until && !this.stale) this.invalidate();
        }
        this.refresh();
        if (this.cache && inboxPolicyVersion(this.base) !== revision) throw Error("inbox policy changed");
        if (this.cache && (!this.stale || this.cache.computation.items.length)) {
          this.state = this.stale ? "stale" : "ready";
          return { items: structuredClone(this.cache.computation.items), more: this.cache.computation.more, complete: !this.stale, refreshing: this.stale, generatedAt: this.generatedAt };
        }
        return this.status();
      } catch { this.invalidate({ hard: true, capacity: true }); this.error = "failure"; return this.status(); }
    });
    this.request = request; void request.finally(() => { if (this.request === request) this.request = undefined; }).catch(() => {});
    return request.then(value => structuredClone(value));
  }
  async close(): Promise<void> {
    this.closed = true; this.cache = undefined; this.capacity = undefined; this.generation++;
    const job = this.task ?? this.blockedTask; if (job) await job.cancel(); this.blockedTask = undefined;
  }
}
