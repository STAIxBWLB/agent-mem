import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { processGroupLiveness, processSignatureAsync, realPath } from "../memory/platform.ts";
import { INBOX_MAX_BYTES, INBOX_MAX_ITEMS, inboxPolicyDefaults, inboxPolicyVersion, inboxSourceVersion, type CapacityMemo, type InboxComputation, type InboxItem, type InboxSources } from "./inbox.ts";

export interface InboxJobResult { computation: InboxComputation; sources: InboxSources }
export interface InboxJob { result: Promise<InboxJobResult>; cancel(): Promise<void> }
export type InboxRunner = (base: string, capacity?: CapacityMemo) => InboxJob;
export interface InboxSnapshot { items: InboxItem[]; more: number; complete: boolean; refreshing: boolean; generatedAt?: string }
const WORK_MS = 30_000, REAP_MS = 2000, RETRY_MS = 1000;

export class InboxCleanupError extends Error {
  readonly group: number | undefined;
  constructor(group?: number) {
    const valid = group !== undefined && Number.isSafeInteger(group) && group > 0 ? group : undefined;
    super(`inbox worker group ${valid ?? "unknown"} cleanup is unresolved`); this.name = "InboxCleanupError"; this.group = valid;
  }
}
/** Observation never becomes signal authority: after leader exit, a nonempty/reused group is unresolved. */
async function waitForGroupGone(group: number | undefined): Promise<void> {
  if (group === undefined) return; // Failed native spawn: there was no process to admit.
  const until = performance.now() + REAP_MS;
  for (;;) {
    const state = processGroupLiveness(group);
    if (state === "gone") return;
    if (state === "unknown" || performance.now() >= until) throw new InboxCleanupError(group);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
/** A detached group belongs to this live native child handle. Retired groups are observed, never signalled.
 * Every refresh process exits after its one result; cleanup uncertainty blocks another job. */
export const runInboxJob: InboxRunner = (base, capacity) => {
  const defaults = inboxPolicyDefaults();
  const child = fork(fileURLToPath(new URL("./inbox-worker.ts", import.meta.url)), [],
    { execPath: process.execPath, execArgv: ["--smol"], detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json" });
  let exited = false, cleaned = false, ready = false, terminating = false, payload: InboxJobResult | undefined, changed = false;
  let readyProbe: Promise<void> | undefined;
  let fail!: (error: Error) => void, succeed!: (value: InboxJobResult) => void, exitedResolve!: () => void, exitedReject!: (error: Error) => void;
  const ended = new Promise<void>((resolve, reject) => { exitedResolve = resolve; exitedReject = reject; });
  void ended.catch(() => {});
  const result = new Promise<InboxJobResult>((resolve, reject) => { succeed = resolve; fail = reject; });
  const kill = (signal: NodeJS.Signals = "SIGKILL") => {
    if (exited || child.exitCode !== null || child.signalCode !== null) return;
    try { if (child.pid) process.kill(-child.pid, signal); } catch { child.kill(signal); }
  };
  let force: ReturnType<typeof setTimeout> | undefined, cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
  const boundCleanup = () => {
    if (!cleanupDeadline) { cleanupDeadline = setTimeout(() => { const error = new InboxCleanupError(child.pid); exitedReject(error); fail(error); }, REAP_MS + 750); cleanupDeadline.unref(); }
  };
  const terminate = () => {
    if (terminating || exited) return;
    terminating = true; boundCleanup(); kill("SIGTERM");
    if (!exited) { force = setTimeout(() => kill(), 250); force.unref(); }
  };
  const deadline = setTimeout(terminate, WORK_MS); deadline.unref();
  child.on("message", (value: unknown) => {
    const message = value as { type?: unknown; pid?: unknown; group?: unknown; signature?: unknown; computation?: InboxComputation; sources?: InboxSources };
    if (message?.type === "ready" && !ready && !readyProbe) {
      readyProbe = (async () => {
        if (!child.pid || message.pid !== child.pid || message.group !== child.pid || typeof message.signature !== "string") { terminate(); return; }
        const signature = await processSignatureAsync(child.pid);
        if (exited || terminating) return;
        if (signature !== message.signature) { terminate(); return; }
        ready = true; child.send({ type: "run", base, capacity, defaults });
      })().catch(() => { terminate(); });
    } else if (ready && message?.type === "result" && message.computation && message.sources) payload = { computation: message.computation, sources: message.sources };
    else if (ready && message?.type === "changed") changed = true;
  });
  child.once("error", () => { terminate(); });
  child.once("close", code => {
    exited = true; clearTimeout(deadline); if (force) clearTimeout(force); boundCleanup();
    void (async () => {
      await readyProbe;
      try { await waitForGroupGone(child.pid); }
      catch { if (cleanupDeadline) clearTimeout(cleanupDeadline); const error = new InboxCleanupError(child.pid); exitedReject(error); fail(error); return; }
      cleaned = true; if (cleanupDeadline) clearTimeout(cleanupDeadline); exitedResolve();
      if (code === 0 && payload && !terminating) succeed(payload); else fail(Error(changed ? "inbox sources changed" : "inbox worker unavailable"));
    })();
  });
  return { result, async cancel() {
    if (cleaned) return;
    terminate(); let timer: ReturnType<typeof setTimeout> | undefined;
    const proof = exited ? (async () => { await readyProbe; await waitForGroupGone(child.pid); cleaned = true; })() : ended;
    try { await Promise.race([proof, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InboxCleanupError(child.pid)), REAP_MS + 1000); })]); }
    finally { if (timer) clearTimeout(timer); }
  } };
};

/** One source/policy generation, one background computation, and one shared request-side revision check. */
export class InboxCache {
  private readonly base: string;
  private readonly runner: InboxRunner;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private cache?: InboxJobResult;
  private capacity?: CapacityMemo;
  private task?: InboxJob;
  private blockedTask?: InboxJob;
  private request?: Promise<InboxSnapshot>;
  private generation = 0;
  private closed = false;
  private dirty = false;
  private failedAt?: number;
  private generatedAt?: string;
  private policy?: string;
  private readonly startedAt: string;
  private capacityAt?: string;
  constructor(base: string, options: { runner?: InboxRunner; log?: (line: string) => void; now?: () => number } = {}) {
    const absolute = resolve(base);
    this.base = existsSync(absolute) ? realPath(absolute) : absolute; this.runner = options.runner ?? runInboxJob; this.log = options.log ?? (() => {}); this.now = options.now ?? Date.now;
    this.startedAt = new Date(this.now()).toISOString();
  }
  invalidate(capacity = false): void {
    this.generation++; this.cache = undefined; if (capacity) this.capacity = undefined;
    if (this.task) this.dirty = true; this.failedAt = undefined;
  }
  private refresh(retry = true): void {
    if (this.closed || this.task || this.blockedTask) return;
    const generation = this.generation; let task: InboxJob;
    try { task = this.runner(this.base, this.capacity); } catch { this.failedAt = this.now(); return; }
    this.task = task; this.dirty = false;
    void task.result.then(result => {
      const revision = inboxPolicyVersion(this.base), computation = result.computation;
      if (generation !== this.generation || computation.policy !== revision || inboxSourceVersion(this.base, result.sources.paths) !== result.sources.version) { this.dirty = true; return; }
      if (computation.items.length > INBOX_MAX_ITEMS || Buffer.byteLength(JSON.stringify(computation.items)) > INBOX_MAX_BYTES || !Number.isSafeInteger(computation.more) || computation.more < 0) throw Error("invalid inbox result");
      const cap = computation.items.find(item => item.id === "capacity:proposal");
      if (cap) { this.capacityAt ??= cap.at; cap.at = this.capacityAt; } else this.capacityAt = undefined;
      this.cache = result; this.capacity = computation.capacity; this.policy = revision; this.generatedAt = new Date(this.now()).toISOString(); this.failedAt = undefined;
    }).catch(error => {
      const unresolved = error instanceof InboxCleanupError;
      if (unresolved) this.blockedTask = task;
      this.failedAt = this.now();
      if (!this.closed) try {
        this.log(unresolved ? `amem: inbox worker group ${error.group ?? "unknown"} cleanup is unresolved; refresh is stopped until it is inspected.`
          : "amem: inbox refresh unavailable; no stale result was served");
      } catch { /* A logger never grants permission to restart an unresolved owned job. */ }
    }).finally(() => {
      if (this.task === task) this.task = undefined;
      if (this.dirty && retry && !this.closed) this.refresh(false);
    });
  }
  snapshot(): Promise<InboxSnapshot> {
    if (this.request) return this.request.then(snapshot => structuredClone(snapshot));
    const request = Promise.resolve().then(() => {
      if (this.closed) throw Error("inbox provider is closed");
      try {
        const revision = inboxPolicyVersion(this.base);
        if (this.policy !== undefined && this.policy !== revision) this.invalidate(true);
        this.policy = revision;
        if (this.cache && (inboxSourceVersion(this.base, this.cache.sources.paths) !== this.cache.sources.version || this.capacity && this.now() >= this.capacity.until)) this.invalidate();
        if (this.cache && inboxPolicyVersion(this.base) !== revision) throw Error("inbox policy changed");
        if (this.cache) return { items: structuredClone(this.cache.computation.items), more: this.cache.computation.more, complete: true, refreshing: false, generatedAt: this.generatedAt };
        if (this.failedAt === undefined || this.now() - this.failedAt >= RETRY_MS) this.refresh();
        const unavailable = !!this.blockedTask || this.failedAt !== undefined && !this.task;
        return { items: [{ id: "inbox:refresh", group: "alert" as const, kind: "status", title: unavailable ? "Memory inbox is unavailable" : "Memory inbox is refreshing",
          detail: unavailable ? "Open Review or check the terminal." : "Pending items will appear when the refresh finishes.", at: this.startedAt,
          verbs: [], link: { panel: "review" } }], more: 0, complete: false, refreshing: !unavailable };
      } catch {
        this.invalidate(true);
        return { items: [{ id: "inbox:unavailable", group: "alert" as const, kind: "status", title: "Memory inbox is unavailable", at: this.startedAt, verbs: [], link: { panel: "review" } }], more: 0, complete: false, refreshing: false };
      }
    });
    this.request = request;
    void request.finally(() => { if (this.request === request) this.request = undefined; }).catch(() => {});
    return request.then(snapshot => structuredClone(snapshot));
  }
  async close(): Promise<void> {
    this.closed = true; this.cache = undefined; this.capacity = undefined; this.generation++;
    const job = this.task ?? this.blockedTask;
    if (job) await job.cancel();
    this.blockedTask = undefined;
  }
}
