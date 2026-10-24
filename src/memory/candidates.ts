import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CANDIDATE_SHOWN_GRACE_MS, hasShownColumn } from "./candidate-pending.ts";
import { oneLine } from "./note-add.ts";
import { memoryHome } from "./home.ts";
import { realPath } from "./platform.ts";
import { stripPrivateDeep } from "./private-spans.ts";
import { MemoryStore, type GoalView, type NoteInput, type View } from "./store.ts";

export const CANDIDATE_DB_BUSY_TIMEOUT_MS = 3000;
export const CANDIDATE_RETENTION = { count: 500, ageMs: 30 * 86400_000 } as const;
export const COUNTER_RETENTION = { count: 10_000, ageMs: 90 * 86400_000 } as const;
export type CandidateVerdict = "public" | "private" | "pii" | "unknown";
export interface CandidateTarget { id: string; revision: string }
export type CandidateInput = { project: string } & (
  | { kind: "correction"; target: CandidateTarget; proposedText: string; reason: string; noteKind?: "decision" | "contract" | "fail" }
  | { kind: "fail"; target?: CandidateTarget; approach: string; symptom: string; cause: string; evidenceRefs: string[]; retryWhen: string }
  | { kind: "memory"; text: string; title?: string; noteKind?: "decision" | "finding" | "contract" | "fail" }
  | { kind: "decay"; target: CandidateTarget; reason: string }
  | { kind: "promotion"; target: CandidateTarget; goalId: string }
);
export type CandidateStatus = "pending" | "accepting" | "accepted" | "rejected";
export interface Candidate { id: string; createdAt: string; status: CandidateStatus; input: CandidateInput; acceptedNoteId: string | null }
export interface CandidateFilter { project: string; status?: CandidateStatus | "all"; kind?: CandidateInput["kind"]; limit?: number }
export interface CounterKey { entryId: string; project: string; task?: string | null; turn?: string | null; session?: string | null; deliveryId: string }
export interface CounterValues { rendered?: number | null; delivered?: number | null; cited?: number | null }
export interface Counter extends CounterValues { id: string; key: CounterKey; createdAt: string; rendered: number | null; delivered: number | null; cited: number | null }
export interface CandidateAcceptance {
  project: string;
  /** The host binds this to authenticated person intent; it is not an authentication token. */
  actor: "person" | "agent";
  verdict: CandidateVerdict;
  store: MemoryStore;
  policy: (candidate: Candidate, target: View | undefined, note: NoteInput, goal?: GoalView) => boolean;
}
export interface CandidateAcceptanceResult { candidateId: string; noteId: string; alreadyAccepted: boolean }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const text = (value: unknown, max = 4000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
const entryId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const candidateId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const publicOnly = (verdict: CandidateVerdict) => { if (verdict !== "public") throw new Error("candidate data refused by host privacy verdict"); };
const personOnly = (actor: string) => { if (actor !== "person") throw new Error("candidate acceptance and rejection require a person"); };
const validTarget = (value: CandidateTarget | undefined) => value !== undefined && entryId(value.id) && candidateId(value.revision);
function validate(input: CandidateInput): void {
  if (!input || !text(input.project, 400)) throw new Error("invalid candidate project");
  if (input.kind === "correction") {
    if (!validTarget(input.target) || !text(input.proposedText) || !text(input.reason) || input.noteKind !== undefined && !["decision", "contract", "fail"].includes(input.noteKind)) throw new Error("invalid correction candidate");
  } else if (input.kind === "fail") {
    if (input.target !== undefined && !validTarget(input.target) || ![input.approach, input.symptom, input.cause, input.retryWhen].every(x => text(x)) || !Array.isArray(input.evidenceRefs) || input.evidenceRefs.length < 1 || input.evidenceRefs.length > 16 || !input.evidenceRefs.every(x => text(x, 400))) throw new Error("invalid fail candidate");
  } else if (input.kind === "memory") {
    if (!text(input.text, 3000) || input.title !== undefined && !text(input.title, 200) || input.noteKind !== undefined && !["decision", "finding", "contract", "fail"].includes(input.noteKind)) throw new Error("invalid memory candidate");
  } else if (input.kind === "promotion") {
    if (!validTarget(input.target) || !entryId(input.goalId)) throw new Error("invalid promotion candidate");
  } else if (input.kind === "decay") {
    if (!validTarget(input.target) || !text(input.reason)) throw new Error("invalid decay candidate");
  } else throw new Error("invalid candidate kind");
  if (Buffer.byteLength(canonical(input), "utf8") > 16_384) throw new Error("candidate payload exceeds 16 KiB");
}

/** The same normalized identity used by put(), without a sidecar write or a capped listing. */
export function candidateInputId(rawInput: CandidateInput): string {
  const input = stripPrivateDeep(rawInput); validate(input);
  return hash({ schema: "agent-mem.candidate/v1", input });
}
/** Exact correction body shared by proposal validation and person acceptance. */
export function acceptedCorrectionText(input: Extract<CandidateInput, { kind: "correction" }>, id = candidateInputId(input)): string {
  const data = stripPrivateDeep(input);
  return `Accepted candidate: ${id}\nTarget revision: ${data.target.revision}\nTarget entry: ${data.target.id}\n\n${data.proposedText}\n\nReason: ${data.reason}`;
}
export function goalPromotionLinked(view: Pick<View, "task" | "about">, goal: Pick<GoalView, "id" | "links">): boolean {
  const tasks = new Set(goal.links.map(link => link.task));
  return !!view.task && tasks.has(view.task) || view.about.some(node => node === `goal:${goal.id}` || node.startsWith("task:") && tasks.has(node.slice(5)));
}
/** Includes current lifecycle state, so a changed promotion, supersession or demotion makes a proposal stale. */
export function candidateTargetRevision(target: View): string {
  return hash({ ...target, about: [...target.about].sort(), supersedes: [...target.supersedes].sort() });
}

function counterKey(key: CounterKey): CounterKey {
  if (!key || !entryId(key.entryId) || !text(key.project, 400) || !text(key.deliveryId, 200)) throw new Error("invalid counter key");
  for (const value of [key.task, key.turn, key.session]) if (value !== undefined && value !== null && !text(value, 400)) throw new Error("invalid counter context");
  return { entryId: key.entryId, project: key.project, task: key.task ?? null, turn: key.turn ?? null, session: key.session ?? null, deliveryId: key.deliveryId };
}

/** Explicitly opened machine-local data. Importing this module never opens a store or registers a consumer. */
/** Run `work`, retrying only SQLite's "database is locked" for at most about two seconds; any other error, or the last lock error, is thrown. */
function retryLocked(work: () => void): void {
  const until = Date.now() + 2000;
  for (let delay = 5;; delay = Math.min(delay * 2, 100)) {
    try { work(); return; }
    catch (error) {
      if (!/database is locked|SQLITE_BUSY/i.test((error as Error).message) || Date.now() >= until) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

/** The queue holds the cap's worth of candidates nobody has seen. Named so a caller (the MCP tool) can map it; the message is worded for an agent, which cannot run the person-only commands itself. */
export class CandidateQueueFull extends Error {
  readonly code = "candidate_queue_full";
  constructor(readonly waiting: number) { super(`${waiting} unshown candidates await the person's review; no more are accepted until they have run \`amem review\`. Ask the person to review them`); this.name = "CandidateQueueFull"; }
}
export class CandidateStore {
  readonly dir: string;
  readonly path: string;
  private readonly db: Database;
  private readonly now: () => number;
  /** #27: the keys aliased to the canonical project; its candidates read, accept and reject under the canonical key. Absent in the library default. */
  private readonly reconcile?: { canonical: string; aliases: readonly string[] };
  private scope(project: string): string { return JSON.stringify(this.reconcile && project === this.reconcile.canonical ? [project, ...this.reconcile.aliases] : [project]); }
  constructor(options: { home?: string; memoryDir?: string; now?: () => number; reconcile?: { canonical: string; aliases: readonly string[] } } = {}) {
    if (options.reconcile?.aliases.length) this.reconcile = { canonical: options.reconcile.canonical, aliases: [...options.reconcile.aliases] };
    if (options.memoryDir !== undefined && options.home !== undefined) throw new Error("choose a home or an exact memory directory");
    this.dir = options.memoryDir ?? (options.home === undefined ? memoryHome() : join(options.home, "memory"));
    this.now = options.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 }); chmodSync(this.dir, 0o700);
    this.path = join(this.dir, "candidates.db");
    this.db = new Database(this.path, { create: true });
    this.db.run(`PRAGMA busy_timeout = ${CANDIDATE_DB_BUSY_TIMEOUT_MS}`);
    chmodSync(this.path, 0o600);
    // `journal_mode = WAL` takes a lock that busy_timeout does not always wait for, so several processes opening a brand-new home at once (every `amem mcp` builds this store at
    // startup) can see "database is locked". It is retried for a bounded time: the first caller switches the mode, the others then find it already WAL.
    retryLocked(() => this.db.run("PRAGMA journal_mode = WAL"));
    this.db.run("CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, note_id TEXT)");
    // F7 / AC4: when a candidate was first shown to the person. In place and nullable: an older database gains it here, and a reader without it treats every row as unshown.
    // Several processes open this store at once (every `amem mcp` builds it at startup), so the check and the ALTER are one immediate transaction: the loser waits, then sees the column.
    if (!hasShownColumn(this.db)) this.db.transaction(() => { if (!hasShownColumn(this.db)) this.db.run("ALTER TABLE candidates ADD COLUMN shown_at INTEGER"); }).immediate();
    this.db.run("CREATE TABLE IF NOT EXISTS counters (id TEXT PRIMARY KEY, project TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, rendered INTEGER, delivered INTEGER, cited INTEGER)");
    this.prune();
  }
  close(): void { this.db.close(); }
  private prune(): void {
    this.db.transaction(() => {
      const now = this.now();
      // Candidates (AC4, no candidate expires unshown): by age only a decided one, or a pending one that was shown and has had its grace period, goes. By count three tiers decide who is
      // kept: unshown pending first, then shown pending, then decided, so a cap eviction takes decided rows before a shown one (which is owed its grace) and shown ones before an unseen one.
      this.db.query("DELETE FROM candidates WHERE at <= ? AND (status IN ('accepted', 'rejected') OR (shown_at IS NOT NULL AND shown_at <= ?))").run(now - CANDIDATE_RETENTION.ageMs, now - CANDIDATE_SHOWN_GRACE_MS);
      this.db.query(`DELETE FROM candidates WHERE rowid IN (SELECT rowid FROM (SELECT rowid, row_number() OVER (PARTITION BY project ORDER BY CASE WHEN status IN ('pending', 'accepting') AND shown_at IS NULL THEN 2 WHEN status IN ('pending', 'accepting') THEN 1 ELSE 0 END DESC, at DESC, rowid DESC) AS rank FROM candidates) WHERE rank > ?)`).run(CANDIDATE_RETENTION.count);
      this.db.query("DELETE FROM counters WHERE at <= ?").run(now - COUNTER_RETENTION.ageMs);
      this.db.query("DELETE FROM counters WHERE rowid IN (SELECT rowid FROM (SELECT rowid, row_number() OVER (PARTITION BY project ORDER BY at DESC, rowid DESC) AS rank FROM counters) WHERE rank > ?)").run(COUNTER_RETENTION.count);
    }).immediate();
  }
  private decode(row: { id: string; payload: string; at: number; status: CandidateStatus; note_id: string | null }): Candidate {
    const input = JSON.parse(row.payload) as CandidateInput; validate(input);
    if (hash({ schema: "agent-mem.candidate/v1", input }) !== row.id) throw new Error("candidate content hash mismatch");
    return { id: row.id, createdAt: new Date(row.at).toISOString(), status: row.status, input, acceptedNoteId: row.note_id };
  }
  put(rawInput: CandidateInput, verdict: CandidateVerdict): string {
    // `<private>` spans are never stored: dropped before the input is validated, hashed (so the id) or written.
    const input = stripPrivateDeep(rawInput);
    publicOnly(verdict); validate(input);
    const payload = canonical(input), id = candidateInputId(input);
    // Prune, count, insert and prune again are ONE immediate transaction: concurrent proposers (several agents) cannot all pass the count and then let the cap evict an unseen candidate.
    return this.db.transaction((): string => {
      this.prune();
      // AC4: a new candidate never pushes an unshown one out. With the cap's worth waiting the person has to review first, and the refusal says so (a named error an MCP tool can map).
      const waiting = (this.db.query("SELECT COUNT(*) AS n FROM candidates WHERE project = ? AND status IN ('pending', 'accepting') AND shown_at IS NULL").get(input.project) as { n: number }).n;
      const known = this.db.query("SELECT 1 FROM candidates WHERE id = ?").get(id);
      if (!known && waiting >= CANDIDATE_RETENTION.count) throw new CandidateQueueFull(waiting);
      this.db.query("INSERT OR IGNORE INTO candidates (id, project, kind, payload, at, status) VALUES (?, ?, ?, ?, ?, 'pending')").run(id, input.project, input.kind, payload, this.now());
      this.prune();
      return id;
    }).immediate();
  }
  get(id: string, project: string): Candidate | undefined {
    if (!candidateId(id) || !text(project, 400)) throw new Error("invalid candidate identity");
    this.prune();
    const row = this.db.query("SELECT * FROM candidates WHERE id = ? AND project IN (SELECT value FROM json_each(?))").get(id, this.scope(project)) as Parameters<CandidateStore["decode"]>[0] | null;
    return row ? this.decode(row) : undefined;
  }
  list(filter: CandidateFilter): Candidate[] {
    if (!text(filter.project, 400) || filter.status !== undefined && !["pending", "accepting", "accepted", "rejected", "all"].includes(filter.status) || filter.kind !== undefined && !["correction", "fail", "decay", "memory", "promotion"].includes(filter.kind)) throw new Error("invalid candidate filter");
    const limit = filter.limit ?? CANDIDATE_RETENTION.count;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CANDIDATE_RETENTION.count) throw new Error("candidate limit must be 1..500");
    this.prune();
    const where = ["project IN (SELECT value FROM json_each(?))"], bind: (string | number)[] = [this.scope(filter.project)];
    if (filter.status === undefined) where.push("status IN ('pending', 'accepting')"); else if (filter.status !== "all") { where.push("status = ?"); bind.push(filter.status); }
    if (filter.kind) { where.push("kind = ?"); bind.push(filter.kind); }
    return (this.db.query(`SELECT * FROM candidates WHERE ${where.join(" AND ")} ORDER BY at DESC, rowid DESC LIMIT ?`).all(...bind, limit) as Parameters<CandidateStore["decode"]>[0][]).map(row => this.decode(row));
  }
  recordCounter(key: CounterKey, values: CounterValues, verdict: CandidateVerdict): string {
    publicOnly(verdict); const normalized = counterKey(key);
    for (const value of [values.rendered, values.delivered, values.cited]) if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error("counter values must be nonnegative integers or unknown");
    this.prune(); const id = hash({ schema: "agent-mem.counter/v1", key: normalized });
    this.db.query(`INSERT INTO counters (id, project, payload, at, rendered, delivered, cited) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET rendered = coalesce(excluded.rendered, counters.rendered), delivered = coalesce(excluded.delivered, counters.delivered), cited = coalesce(excluded.cited, counters.cited)`)
      .run(id, normalized.project, canonical(normalized), this.now(), values.rendered ?? null, values.delivered ?? null, values.cited ?? null);
    this.prune(); return id;
  }
  counters(project: string, entry?: string): Counter[] {
    if (!text(project, 400) || entry !== undefined && !entryId(entry)) throw new Error("invalid counter filter");
    this.prune();
    const rows = this.db.query("SELECT * FROM counters WHERE project IN (SELECT value FROM json_each(?)) ORDER BY at DESC, rowid DESC").all(this.scope(project)) as { id: string; payload: string; at: number; rendered: number | null; delivered: number | null; cited: number | null }[];
    return rows.map(row => ({ id: row.id, key: JSON.parse(row.payload) as CounterKey, createdAt: new Date(row.at).toISOString(), rendered: row.rendered, delivered: row.delivered, cited: row.cited })).filter(row => !entry || row.key.entryId === entry);
  }
  reject(id: string, context: { project: string; actor: "person" | "agent"; verdict: CandidateVerdict }): void {
    personOnly(context.actor); publicOnly(context.verdict);
    this.db.transaction(() => {
      const candidate = this.get(id, context.project);
      if (!candidate) throw new Error("candidate unavailable");
      if (candidate.status === "accepted" || candidate.status === "accepting") throw new Error("candidate acceptance already started; inspect its ordinary note before any further action");
      this.db.query("UPDATE candidates SET status = 'rejected' WHERE id = ? AND project IN (SELECT value FROM json_each(?)) AND status = 'pending'").run(id, this.scope(context.project));
    }).immediate();
  }
  accept(id: string, context: CandidateAcceptance): CandidateAcceptanceResult {
    personOnly(context.actor); publicOnly(context.verdict);
    if (realPath(context.store.profile.home) !== realPath(this.dir) || typeof context.policy !== "function") throw new Error("candidate acceptance requires its memory store and a current host policy");
    return context.store.withDeferredPromotions(() => this.acceptDeferred(id, context));
  }
  private acceptDeferred(id: string, context: CandidateAcceptance): CandidateAcceptanceResult {
    const candidate = this.get(id, context.project);
    if (!candidate) throw new Error("candidate unavailable");
    if (candidate.status === "accepted") return { candidateId: id, noteId: candidate.acceptedNoteId!, alreadyAccepted: true };
    if (candidate.status !== "pending") throw new Error("candidate is rejected or acceptance was interrupted; no automatic replay");
    const data = candidate.input;
    if (data.kind === "decay") throw new Error("decay candidates are listing-only; no automatic mutation is available");
    if (data.kind === "promotion") return this.acceptPromotion(candidate, data, context);
    const execute = () => {
      const resolve = () => {
        const target = data.kind === "memory" ? undefined : data.target;
        if (!target) return undefined;
        const current = context.store.get(target.id, context.project);
        if (!current || current.id !== target.id || candidateTargetRevision(current) !== target.revision) throw new Error("candidate target revision is stale");
        return current;
      };
      const target = resolve();
      const body = data.kind === "memory" ? data.text : data.kind === "correction" ? `${data.proposedText}\n\nReason: ${data.reason}`
        : `Approach: ${oneLine(data.approach)}\nSymptom: ${oneLine(data.symptom)}\nCause: ${oneLine(data.cause)}\nEvidence: ${data.evidenceRefs.map(oneLine).join(", ")}\nRetry when: ${oneLine(data.retryWhen)}`;
      const note: NoteInput = { op: "note", ...(data.kind === "memory" && data.title ? { title: data.title } : {}), project: data.kind === "correction" ? target!.project : context.project,
        scope: data.kind === "correction" ? target!.scope : "project",
        // A demoted synced target is logically short, but replacing it locally would narrow its reach (X04).
        tier: data.kind === "correction" && target!.local ? "short" : "long",
        kind: data.kind === "fail" ? "fail" : data.noteKind ?? (target?.kind === "contract" || target?.kind === "fail" ? target.kind : "decision"), peer: "person", source: "person", about: [...target?.about ?? []],
        text: data.kind === "correction" ? acceptedCorrectionText(data, id) : `Accepted candidate: ${id}\nTarget revision: ${(data.kind === "memory" ? undefined : data.target)?.revision ?? "none"}\nTarget entry: ${(data.kind === "memory" ? undefined : data.target)?.id ?? "none"}\n\n${body}` };
      if (note.text.length > 4000) throw new Error("accepted candidate text exceeds the v1 note limit");
      if (context.policy(structuredClone(candidate), target && structuredClone(target), structuredClone(note)) !== true) throw new Error("candidate refused by current host policy");
      return context.store.withAcceptedNote(note, append => {
        resolve(); // Recheck under the same mutation lock as the note and supersede appends.
        const started = this.beginAcceptance(id, context.project);
        if (started) return { candidateId: id, noteId: started, alreadyAccepted: true };
        // ponytail: the sidecar receipt and v1 append are not one transaction. An interrupted 'accepting' row refuses
        // automatic replay; add explicit person-audited recovery before offering background acceptance retries.
        const noteId = append();
        if (data.kind === "correction" && !context.store.supersede(target!.id, noteId, "person", context.project)) throw new Error("candidate replacement refused; inspect the accepted note before recovery");
        this.db.query("UPDATE candidates SET status = 'accepted', note_id = ? WHERE id = ? AND project IN (SELECT value FROM json_each(?))").run(noteId, id, this.scope(context.project));
        return { candidateId: id, noteId, alreadyAccepted: false };
      });
    };
    const target = data.kind === "memory" ? undefined : data.target;
    if (!target) return execute();
    const current = context.store.get(target.id, context.project);
    if (!current || current.id !== target.id || candidateTargetRevision(current) !== target.revision) throw new Error("candidate target revision is stale");
    return context.store.withCurrentEntries([target.id], context.project, execute);
  }
  private acceptPromotion(candidate: Candidate, data: Extract<CandidateInput, { kind: "promotion" }>, context: CandidateAcceptance): CandidateAcceptanceResult {
    const resolve = () => {
      const target = context.store.get(data.target.id, context.project);
      if (!target || target.id !== data.target.id || candidateTargetRevision(target) !== data.target.revision || target.tier !== "short" || target.supersededBy) throw Error("candidate target revision is stale");
      const goal = context.store.goalOf(data.goalId, context.project);
      if (!goal || goal.id !== data.goalId || goal.state !== "done" || !goalPromotionLinked(target, goal)) throw Error("promotion requires a current done goal and a linked short note");
      return { target, goal };
    };
    resolve();
    return context.store.withCurrentEntries([data.target.id], context.project, () => {
      const { target, goal } = resolve();
      const note: NoteInput = { op: "note", project: target.project, scope: target.scope, tier: "long", kind: target.kind, peer: target.peer, source: target.source as NoteInput["source"], text: target.text, about: [...target.about],
        ...(target.title ? { title: target.title } : {}), ...(target.task ? { task: target.task } : {}), promotedFrom: target.id };
      if (context.policy(structuredClone(candidate), structuredClone(target), structuredClone(note), structuredClone(goal)) !== true) throw Error("candidate refused by current host policy");
      resolve();
      const replay = this.beginAcceptance(candidate.id, context.project); if (replay) return { candidateId: candidate.id, noteId: replay, alreadyAccepted: true };
      // A thrown append remains accepting: its authored-row outcome needs person-audited recovery.
      const noteId = context.store.promote(target.id, "person", context.project);
      if (noteId === undefined) {
        this.db.query("UPDATE candidates SET status = 'pending' WHERE id = ? AND project IN (SELECT value FROM json_each(?)) AND status = 'accepting'").run(candidate.id, this.scope(context.project));
        throw Error("promotion unavailable or declined; candidate remains pending");
      }
      const promoted = context.store.get(noteId, context.project);
      if (noteId === target.id || !promoted || promoted.id !== noteId || promoted.tier !== "long" || promoted.promotedFrom !== target.id) throw Error("promotion outcome unconfirmed; inspect the accepting candidate");
      this.db.query("UPDATE candidates SET status = 'accepted', note_id = ? WHERE id = ? AND project IN (SELECT value FROM json_each(?))").run(noteId, candidate.id, this.scope(context.project));
      return { candidateId: candidate.id, noteId, alreadyAccepted: false };
    });
  }
  private beginAcceptance(id: string, project: string): string | undefined {
    return this.db.transaction(() => {
      const current = this.get(id, project);
      if (!current) throw Error("candidate unavailable");
      if (current.status === "accepted") return current.acceptedNoteId!;
      if (current.status !== "pending") throw Error("candidate is rejected or acceptance was interrupted; no automatic replay");
      this.db.query("UPDATE candidates SET status = 'accepting' WHERE id = ? AND project IN (SELECT value FROM json_each(?))").run(id, this.scope(project));
      return undefined;
    }).immediate();
  }
}
