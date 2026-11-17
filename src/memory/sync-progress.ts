/**
 * #418: advisory progress for a long-running placement sync. Telemetry only: never mutation authority, a publication
 * receipt or proof of success. A snapshot carries phase names, unit counts and timestamps, never a memory body, path,
 * project name, row id, policy pattern, credential or remote URL.
 *
 * There is no timer. Every update is a cooperative checkpoint reached by real work, so a blocked call or a starved
 * event loop leaves an honest stale `lastAliveUnixMs` instead of a manufactured heartbeat.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLACEMENT_REFUSAL_CATEGORIES, type PlacementRefusalCategory } from "./sync-placement-refusal-category.ts";
import { processLiveness, processSignature, type Liveness } from "./platform.ts";

export const SYNC_PROGRESS_SCHEMA = "agent-mem.sync-progress/v1", SYNC_PROGRESS_INTERVAL_MS = 1000, SYNC_PROGRESS_DIR = "sync-status";
const MAX_OPERATIONS = 8, MAX_BYTES = 4096, MAX_NAMES = 64;
const PHASES = ["writer-verification", "remote-verification", "source-capture", "policy-evaluation", "dependency-decisions", "artifact-construction",
  "publication-plan", "journal", "publication", "acknowledgment", "import", "receipt"] as const;
const UNITS = ["rows", "records", "objects"] as const, STATES = ["running", "succeeded", "failed", "cancelled", "interrupted"] as const;
const CAUSES = ["bound", "unknown-outcome", "unavailable", "cancelled"] as const;
export type SyncProgressPhase = typeof PHASES[number];
export type SyncProgressUnit = typeof UNITS[number];
export type SyncProgressState = typeof STATES[number];
export type SyncProgressCause = typeof CAUSES[number];
export interface SyncProgressCounts { permitted: number; local: number; declined: number; held: number }
export interface SyncProgressInventory { publications: number; completed: number; realms: number;
  /** Per-realm outcomes in run order: `user` or the 16-hex shard key hash, never a name. At most 32; `truncated` marks more. */
  outcomes?: { realm: string; outcome: SyncRealmOutcome }[]; truncated?: boolean }
export const SYNC_REALM_OUTCOMES = ["committed", "not-needed", "unknown", "failed", "not-run", "not-local", "inactive"] as const;
export type SyncRealmOutcome = typeof SYNC_REALM_OUTCOMES[number];
const MAX_REALM_OUTCOMES = 32;
const realmLabel = (value: unknown): value is string => typeof value === "string" && (value === "user" || /^[a-f0-9]{16}$/.test(value));
export interface SyncProgressSnapshot {
  schema: typeof SYNC_PROGRESS_SCHEMA; operationId: string; state: SyncProgressState; phase: SyncProgressPhase;
  /** How many times this operation entered this phase; completed counts are monotonic within one phase attempt. */
  attempt: number;
  startedUnixMs: number; elapsedMs: number; phaseElapsedMs: number;
  /** Absent when the phase has no countable unit or its total is not genuinely known. No percentage or ETA is derived. */
  unit?: SyncProgressUnit; completed?: number; total?: number;
  counts?: SyncProgressCounts;
  /** Complete writer/source proofs and cheap fence checks so far (#417 measurement counters). */
  proofs: { complete: number; fence: number };
  /** Advances only when a unit of work or a phase completes; `lastAliveUnixMs` is any checkpoint the process reached. */
  lastWorkProgressUnixMs: number; lastAliveUnixMs: number;
  /** #450: a whole-inventory run of sequential publications; counts only, never a realm name or key. */
  inventory?: SyncProgressInventory;
  cause?: SyncProgressCause;
  /** #426: for a failed placement sync, the fixed category of the check that refused (allowlisted, no text). */
  category?: PlacementRefusalCategory;
}
export type SyncProgressSink = (snapshot: SyncProgressSnapshot) => void;
export interface SyncProgressOptions { sink: SyncProgressSink; intervalMs?: number; now?: () => number; mono?: () => number; operationId?: string }

/** Reporter shared by the CLI and the transport. A sink that throws is dropped; it can never fail or alter the sync. */
export class SyncProgress {
  readonly operationId: string;
  private sink?: SyncProgressSink; private readonly intervalMs: number; private readonly now: () => number; private readonly mono: () => number;
  private readonly started: number; private readonly startedMono: number; private phaseMono: number; private emitted = -Infinity;
  private current: SyncProgressPhase = "writer-verification"; private readonly entered = new Map<SyncProgressPhase, number>();
  private unit?: SyncProgressUnit; private completed?: number; private total?: number; private outcome?: SyncProgressCounts;
  private state: SyncProgressState = "running"; private cause?: SyncProgressCause; private category?: PlacementRefusalCategory; private work: number; private aliveAt: number;
  private readonly proofs = { complete: 0, fence: 0 };
  private inventoryCounts?: SyncProgressInventory; private finishDeferred = false;
  private pendingTerminal?: { state: "failed" | "cancelled"; cause?: SyncProgressCause; category?: PlacementRefusalCategory };
  constructor(options: SyncProgressOptions) {
    this.sink = options.sink; this.intervalMs = Math.max(0, options.intervalMs ?? SYNC_PROGRESS_INTERVAL_MS);
    this.now = options.now ?? Date.now; this.mono = options.mono ?? (() => performance.now());
    this.operationId = options.operationId ?? randomBytes(8).toString("hex");
    this.started = this.work = this.aliveAt = this.now(); this.startedMono = this.phaseMono = this.mono(); this.emit(true);
  }
  snapshot(): SyncProgressSnapshot {
    const mono = this.mono();
    return { schema: SYNC_PROGRESS_SCHEMA, operationId: this.operationId, state: this.state, phase: this.current, attempt: this.entered.get(this.current) ?? 1,
      startedUnixMs: this.started, elapsedMs: Math.round(mono - this.startedMono), phaseElapsedMs: Math.round(mono - this.phaseMono),
      ...(this.unit ? { unit: this.unit, completed: this.completed ?? 0, ...(this.total !== undefined ? { total: this.total } : {}) } : {}),
      ...(this.outcome ? { counts: { ...this.outcome } } : {}), proofs: { ...this.proofs },
      lastWorkProgressUnixMs: this.work, lastAliveUnixMs: this.aliveAt, ...(this.inventoryCounts ? { inventory: { ...this.inventoryCounts } } : {}), ...(this.cause ? { cause: this.cause } : {}), ...(this.category ? { category: this.category } : {}) };
  }
  private emit(force: boolean): void {
    if (!this.sink) return; const mono = this.mono();
    if (!force && mono - this.emitted < this.intervalMs) return; this.emitted = mono;
    try { this.sink(this.snapshot()); } catch { this.sink = undefined; }
  }
  /** A phase change is always reported at once, before its long work begins. */
  phase(phase: SyncProgressPhase, unit?: SyncProgressUnit, total?: number): void {
    if (this.state !== "running") return;
    this.current = phase; this.entered.set(phase, (this.entered.get(phase) ?? 0) + 1);
    this.unit = unit; this.completed = unit ? 0 : undefined; this.total = unit && total !== undefined && Number.isSafeInteger(total) && total >= 0 ? total : undefined;
    this.phaseMono = this.mono(); this.work = this.aliveAt = this.now(); this.emit(true);
  }
  advance(count = 1): void { if (this.state !== "running" || !this.unit) return; this.completed = (this.completed ?? 0) + count; this.work = this.aliveAt = this.now(); this.emit(false); }
  /** A reached checkpoint that completed no unit: it never moves completed counts or the last-work timestamp. */
  alive(): void { if (this.state !== "running") return; this.aliveAt = this.now(); this.emit(false); }
  proof(complete: boolean): void { this.proofs[complete ? "complete" : "fence"]++; this.alive(); }
  counts(counts: SyncProgressCounts): void { this.outcome = { ...counts }; }
  /** #450: whole-inventory position. A completed publication is work progress for the run. */
  inventory(value: SyncProgressInventory): void {
    if (this.state !== "running" || ![value.publications, value.completed, value.realms].every(n => Number.isSafeInteger(n) && n >= 0) || value.completed > value.publications) return;
    const outcomes = value.outcomes?.filter(item => realmLabel(item.realm) && (SYNC_REALM_OUTCOMES as readonly string[]).includes(item.outcome)) ?? [];
    this.inventoryCounts = { publications: value.publications, completed: value.completed, realms: value.realms,
      ...(outcomes.length ? { outcomes: outcomes.slice(0, MAX_REALM_OUTCOMES).map(item => ({ ...item })) } : {}), ...(outcomes.length > MAX_REALM_OUTCOMES || value.truncated ? { truncated: true } : {}) };
    this.work = this.aliveAt = this.now(); this.emit(true);
  }
  /** #450: an inventory driver records all realm outcomes before the first terminal state is emitted. */
  deferFinish(deferred: boolean): void {
    this.finishDeferred = deferred;
    if (!deferred && this.pendingTerminal) {
      const pending = this.pendingTerminal; this.pendingTerminal = undefined;
      this.finish(pending.state, pending.cause, pending.category);
    }
  }
  /** Terminal state. Success is reported only by the caller that holds the real sync receipt. */
  finish(state: Exclude<SyncProgressState, "running" | "interrupted">, cause?: SyncProgressCause, category?: PlacementRefusalCategory): void {
    if (this.state !== "running") return;
    if (this.finishDeferred) {
      if (state !== "succeeded" && !this.pendingTerminal) this.pendingTerminal = { state, cause, category };
      return;
    }
    this.state = state; this.cause = state === "succeeded" ? undefined : cause;
    this.category = state === "failed" && category && (PLACEMENT_REFUSAL_CATEGORIES as readonly string[]).includes(category) ? category : undefined; this.aliveAt = this.now();
    if (state === "succeeded") this.work = this.aliveAt; this.emit(true);
  }
}

const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;
/** One human line; unknown totals stay unknown and no percentage or ETA is printed. */
export function renderSyncProgress(snapshot: SyncProgressSnapshot, now = Date.now()): string {
  const phase = snapshot.phase.replaceAll("-", " "), units = snapshot.unit ? `: ${snapshot.completed ?? 0}${snapshot.total !== undefined ? `/${snapshot.total}` : ""} ${snapshot.unit}` : "";
  const counts = snapshot.counts ? `; permitted ${snapshot.counts.permitted}, local ${snapshot.counts.local}, declined ${snapshot.counts.declined}, held ${snapshot.counts.held}` : "";
  const attempt = snapshot.attempt > 1 ? `; attempt ${snapshot.attempt}` : "";
  const realmText = snapshot.inventory?.outcomes?.length ? `; realms ${snapshot.inventory.outcomes.map(item => `${item.realm}=${item.outcome}`).join(" ")}${snapshot.inventory.truncated ? " ..." : ""}` : "";
  const inventory = snapshot.inventory ? `; publications ${snapshot.inventory.completed}/${snapshot.inventory.publications} over ${snapshot.inventory.realms} realms${realmText}` : "";
  if (snapshot.state !== "running") return `amem sync: ${snapshot.state}${snapshot.cause ? ` (${snapshot.cause}${snapshot.category ? `, ${snapshot.category}` : ""})` : ""} in ${phase}${units}${counts}${inventory}; elapsed ${seconds(snapshot.elapsedMs)}`;
  return `amem sync: ${phase}${units}${attempt}${counts}${inventory}; elapsed ${seconds(snapshot.elapsedMs)}; last work progress ${seconds(now - snapshot.lastWorkProgressUnixMs)} ago`;
}

interface Owner { pid: number; signature?: string }
function privateDirectory(dir: string): boolean {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  return !!stat && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
}
function names(dir: string): string[] {
  const reader = opendirSync(dir), found: string[] = [];
  try { for (;;) { const entry = reader.readSync(); if (!entry || found.length >= MAX_NAMES) break; if (/^[a-f0-9]{16}\.json$/.test(entry.name)) found.push(entry.name); } } finally { reader.closeSync(); }
  return found;
}
function readBounded(file: string): Buffer | undefined {
  const before = lstatSync(file, { throwIfNoEntry: false });
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size > MAX_BYTES) return undefined;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
    const bytes = Buffer.alloc(stat.size); let at = 0;
    while (at < bytes.length) { const count = readSync(fd, bytes, at, bytes.length - at, at); if (count <= 0) return undefined; at += count; }
    return bytes;
  } finally { closeSync(fd); }
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Allowlisted enumerations and non-negative integers only: a tampered sidecar cannot inject text into a terminal. */
function validate(value: unknown, operationId: string): { snapshot: SyncProgressSnapshot; owner: Owner } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>, owner = v.owner as Record<string, unknown> | undefined, proofs = v.proofs as Record<string, unknown> | undefined, counts = v.counts as Record<string, unknown> | undefined, inventory = v.inventory as Record<string, unknown> | undefined;
  if (v.schema !== SYNC_PROGRESS_SCHEMA || v.operationId !== operationId || !(STATES as readonly unknown[]).includes(v.state) || !(PHASES as readonly unknown[]).includes(v.phase)
    || ![v.attempt, v.startedUnixMs, v.elapsedMs, v.phaseElapsedMs, v.lastWorkProgressUnixMs, v.lastAliveUnixMs].every(count)
    || !proofs || !count(proofs.complete) || !count(proofs.fence) || !owner || !count(owner.pid) || owner.signature !== undefined && (typeof owner.signature !== "string" || owner.signature.length > 256)
    || v.unit !== undefined && (!(UNITS as readonly unknown[]).includes(v.unit) || !count(v.completed)) || v.total !== undefined && !count(v.total)
    || v.cause !== undefined && !(CAUSES as readonly unknown[]).includes(v.cause)
    || v.category !== undefined && !(PLACEMENT_REFUSAL_CATEGORIES as readonly unknown[]).includes(v.category)
    || counts !== undefined && ![counts.permitted, counts.local, counts.declined, counts.held].every(count)
    || inventory !== undefined && (!inventory || typeof inventory !== "object" || ![inventory.publications, inventory.completed, inventory.realms].every(count) || (inventory.completed as number) > (inventory.publications as number)
      || inventory.truncated !== undefined && inventory.truncated !== true
      || inventory.outcomes !== undefined && (!Array.isArray(inventory.outcomes) || inventory.outcomes.length > MAX_REALM_OUTCOMES
        || inventory.outcomes.some((item: unknown) => !item || typeof item !== "object" || !realmLabel((item as { realm?: unknown }).realm) || !(SYNC_REALM_OUTCOMES as readonly unknown[]).includes((item as { outcome?: unknown }).outcome))))) return undefined;
  const snapshot: SyncProgressSnapshot = { schema: SYNC_PROGRESS_SCHEMA, operationId, state: v.state as SyncProgressState, phase: v.phase as SyncProgressPhase, attempt: v.attempt as number,
    startedUnixMs: v.startedUnixMs as number, elapsedMs: v.elapsedMs as number, phaseElapsedMs: v.phaseElapsedMs as number,
    ...(v.unit !== undefined ? { unit: v.unit as SyncProgressUnit, completed: v.completed as number, ...(v.total !== undefined ? { total: v.total as number } : {}) } : {}),
    ...(counts ? { counts: { permitted: counts.permitted as number, local: counts.local as number, declined: counts.declined as number, held: counts.held as number } } : {}),
    proofs: { complete: proofs.complete as number, fence: proofs.fence as number }, lastWorkProgressUnixMs: v.lastWorkProgressUnixMs as number, lastAliveUnixMs: v.lastAliveUnixMs as number,
    ...(inventory ? { inventory: { publications: inventory.publications as number, completed: inventory.completed as number, realms: inventory.realms as number,
      ...(Array.isArray(inventory.outcomes) ? { outcomes: (inventory.outcomes as { realm: string; outcome: SyncRealmOutcome }[]).map(item => ({ realm: item.realm, outcome: item.outcome })) } : {}),
      ...(inventory.truncated === true ? { truncated: true } : {}) } } : {}),
    ...(v.cause !== undefined ? { cause: v.cause as SyncProgressCause } : {}), ...(v.category !== undefined ? { category: v.category as PlacementRefusalCategory } : {}) };
  return { snapshot, owner: { pid: owner.pid as number, ...(typeof owner.signature === "string" ? { signature: owner.signature } : {}) } };
}
function load(dir: string, name: string): { snapshot: SyncProgressSnapshot; owner: Owner } | undefined {
  try { const bytes = readBounded(join(dir, name)); return bytes ? validate(JSON.parse(bytes.toString("utf8")), name.slice(0, 16)) : undefined; } catch { return undefined; }
}

/**
 * Telemetry sidecar under `<home>/sync-status/<operationId>.json`: outside every source, journal and proof namespace,
 * one file per operation, replaced atomically at most once per reporting interval. It keeps the newest 8 operations;
 * a running operation whose owner is alive is never pruned. Any failure throws into the reporter, which drops the sink.
 */
export function syncProgressSidecar(home: string, owner: Owner = { pid: process.pid, ...(processSignature(process.pid) ? { signature: processSignature(process.pid)! } : {}) }): SyncProgressSink {
  const dir = join(home, SYNC_PROGRESS_DIR); let ready = false;
  return snapshot => {
    if (!ready) {
      mkdirSync(dir, { mode: 0o700, recursive: true }); if (!privateDirectory(dir)) throw new Error("sync status directory unavailable");
      const kept = names(dir).filter(name => name !== `${snapshot.operationId}.json`).map(name => ({ name, mtimeMs: lstatSync(join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0 })).sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const { name } of kept.slice(MAX_OPERATIONS - 1)) {
        const old = load(dir, name);
        if (!old || old.snapshot.state !== "running" || processLiveness(old.owner.pid, old.owner.signature) === "gone") rmSync(join(dir, name), { force: true });
      }
      ready = true;
    }
    const file = join(dir, `${snapshot.operationId}.json`), temporary = join(dir, `.${snapshot.operationId}.tmp`);
    rmSync(temporary, { force: true }); writeFileSync(temporary, JSON.stringify({ ...snapshot, owner }) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temporary, file);
  };
}

export interface SyncOperationStatus extends SyncProgressSnapshot { ownerLiveness: Liveness; lastAliveAgoMs: number; lastWorkProgressAgoMs: number }
export interface SyncStatusReport { operations: SyncOperationStatus[]; malformed: number }
/**
 * Read-only status for another terminal: opens no realm, takes no lock, renews no proof and writes nothing. A running
 * operation whose owner is gone is reported as interrupted, never as a success; unreadable sidecars are only counted.
 */
export function readSyncStatus(home: string, now = Date.now(), liveness: (pid: number, signature?: string) => Liveness = processLiveness): SyncStatusReport {
  const dir = join(home, SYNC_PROGRESS_DIR), report: SyncStatusReport = { operations: [], malformed: 0 };
  if (!privateDirectory(dir)) return report;
  for (const name of names(dir)) {
    const read = load(dir, name); if (!read) { report.malformed++; continue; }
    const ownerLiveness = read.snapshot.state === "running" ? liveness(read.owner.pid, read.owner.signature) : "gone";
    report.operations.push({ ...read.snapshot, ...(read.snapshot.state === "running" && ownerLiveness === "gone" ? { state: "interrupted" as const } : {}), ownerLiveness,
      lastAliveAgoMs: Math.max(0, now - read.snapshot.lastAliveUnixMs), lastWorkProgressAgoMs: Math.max(0, now - read.snapshot.lastWorkProgressUnixMs) });
  }
  report.operations.sort((a, b) => b.startedUnixMs - a.startedUnixMs || a.operationId.localeCompare(b.operationId));
  report.operations.splice(MAX_OPERATIONS); return report;
}
export function renderSyncStatus(report: SyncStatusReport, now = Date.now()): string {
  if (!report.operations.length) return `no placement sync operation recorded${report.malformed ? ` (${report.malformed} unreadable status file${report.malformed === 1 ? "" : "s"} ignored)` : ""}`;
  const lines = report.operations.map(row => {
    const line = renderSyncProgress(row, now).replace(/^amem sync: /, "");
    const tail = row.state === "running" ? `; last observed alive ${seconds(row.lastAliveAgoMs)} ago${row.ownerLiveness === "unknown" ? "; owner liveness unknown" : ""}; percentage and ETA unknown`
      : row.state === "interrupted" ? `; owner process is gone; last observed alive ${seconds(row.lastAliveAgoMs)} ago; not a successful sync` : "";
    return `${row.operationId} ${row.state === "interrupted" ? line.replace(/; last work progress .*$/, "").replace(/^/, "interrupted in ") : line}${tail}`;
  });
  return [...lines, ...(report.malformed ? [`(${report.malformed} unreadable status file${report.malformed === 1 ? "" : "s"} ignored)`] : [])].join("\n");
}
