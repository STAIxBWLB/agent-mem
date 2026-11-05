import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configuredPolicyOptions } from "../memory/config.ts";
import { processSignature, realPath } from "../memory/platform.ts";
import { INBOX_MAX_BYTES, INBOX_MAX_ITEMS, inboxSourceVersion, type CapacityMemo, type InboxComputation, type InboxItem, type InboxSources } from "./inbox.ts";

export interface InboxJobResult { computation: InboxComputation; sources: InboxSources }
export interface InboxJob { result: Promise<InboxJobResult>; cancel(): Promise<void> }
export type InboxRunner = (base: string, capacity?: CapacityMemo) => InboxJob;
export interface InboxSnapshot { items: InboxItem[]; more: number; complete: boolean; refreshing: boolean; generatedAt?: string }
const WORK_MS = 30_000, REAP_MS = 2000, RETRY_MS = 1000;

/** A detached group belongs to this live native child handle, as in the hook worker. It is never reused after exit.
 * No idle daemon/thread/watcher is added: every refresh process exits after its one result. */
export const runInboxJob: InboxRunner = (base, capacity) => {
  const child = fork(fileURLToPath(new URL("./inbox-worker.ts", import.meta.url)), [],
    { execPath: process.execPath, execArgv: ["--smol"], detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json" });
  let exited = false, ready = false, payload: InboxJobResult | undefined, changed = false;
  let fail!: (error: Error) => void, succeed!: (value: InboxJobResult) => void, exitedResolve!: () => void;
  const ended = new Promise<void>(resolve => { exitedResolve = resolve; });
  const result = new Promise<InboxJobResult>((resolve, reject) => { succeed = resolve; fail = reject; });
  const kill = (signal: NodeJS.Signals = "SIGKILL") => {
    if (exited || child.exitCode !== null || child.signalCode !== null) return;
    try { if (child.pid) process.kill(-child.pid, signal); } catch { child.kill(signal); }
  };
  let force: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => { kill("SIGTERM"); if (!force) { force = setTimeout(() => kill(), 250); force.unref(); } };
  const deadline = setTimeout(terminate, WORK_MS); deadline.unref();
  child.on("message", (value: unknown) => {
    try {
    const message = value as { type?: unknown; pid?: unknown; signature?: unknown; computation?: InboxComputation; sources?: InboxSources };
    if (message?.type === "ready" && !ready) {
      if (!child.pid || message.pid !== child.pid || typeof message.signature !== "string" || processSignature(child.pid) !== message.signature) { kill(); return; }
      ready = true; child.send({ type: "run", base, capacity });
    } else if (ready && message?.type === "result" && message.computation && message.sources) payload = { computation: message.computation, sources: message.sources };
    else if (ready && message?.type === "changed") changed = true;
    } catch { kill(); fail(Error("inbox worker unavailable")); }
  });
  child.once("error", () => { kill(); fail(Error("inbox worker unavailable")); });
  child.once("close", code => {
    exited = true; clearTimeout(deadline); if (force) clearTimeout(force); exitedResolve();
    if (code === 0 && payload) succeed(payload); else fail(Error(changed ? "inbox sources changed" : "inbox worker unavailable"));
  });
  return { result, async cancel() {
    terminate(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("inbox worker cleanup unavailable")), REAP_MS); })]); }
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
    this.base = existsSync(base) ? realPath(base) : base; this.runner = options.runner ?? runInboxJob; this.log = options.log ?? (() => {}); this.now = options.now ?? Date.now;
    this.startedAt = new Date(this.now()).toISOString();
  }
  invalidate(capacity = false): void {
    this.generation++; this.cache = undefined; if (capacity) this.capacity = undefined;
    if (this.task) this.dirty = true; this.failedAt = undefined;
  }
  private refresh(retry = true): void {
    if (this.closed || this.task) return;
    const generation = this.generation; let task: InboxJob;
    try { task = this.runner(this.base, this.capacity); } catch { this.failedAt = this.now(); return; }
    this.task = task; this.dirty = false;
    void task.result.then(result => {
      const revision = JSON.stringify(configuredPolicyOptions(this.base)), computation = result.computation;
      if (generation !== this.generation || computation.policy !== revision || inboxSourceVersion(this.base, result.sources.paths) !== result.sources.version) { this.dirty = true; return; }
      if (computation.items.length > INBOX_MAX_ITEMS || Buffer.byteLength(JSON.stringify(computation.items)) > INBOX_MAX_BYTES || !Number.isSafeInteger(computation.more) || computation.more < 0) throw Error("invalid inbox result");
      const cap = computation.items.find(item => item.id === "capacity:proposal");
      if (cap) { this.capacityAt ??= cap.at; cap.at = this.capacityAt; } else this.capacityAt = undefined;
      this.cache = result; this.capacity = computation.capacity; this.policy = revision; this.generatedAt = new Date(this.now()).toISOString(); this.failedAt = undefined;
    }).catch(() => { this.failedAt = this.now(); if (!this.closed) this.log("amem: inbox refresh unavailable; no stale result was served"); }).finally(() => {
      if (this.task === task) this.task = undefined;
      if (this.dirty && retry && !this.closed) this.refresh(false);
    });
  }
  snapshot(): Promise<InboxSnapshot> {
    if (this.request) return this.request;
    const request = Promise.resolve().then(() => {
      if (this.closed) throw Error("inbox provider is closed");
      try {
        const revision = JSON.stringify(configuredPolicyOptions(this.base));
        if (this.policy !== undefined && this.policy !== revision) this.invalidate(true);
        this.policy = revision;
        if (this.cache && (inboxSourceVersion(this.base, this.cache.sources.paths) !== this.cache.sources.version || this.capacity && this.now() >= this.capacity.until)) this.invalidate();
        if (this.cache) return { items: structuredClone(this.cache.computation.items), more: this.cache.computation.more, complete: true, refreshing: false, generatedAt: this.generatedAt };
        if (this.failedAt === undefined || this.now() - this.failedAt >= RETRY_MS) this.refresh();
        const unavailable = this.failedAt !== undefined && !this.task;
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
    return request;
  }
  async close(): Promise<void> {
    this.closed = true; this.cache = undefined; this.capacity = undefined; this.generation++;
    if (this.task) await this.task.cancel();
  }
}
