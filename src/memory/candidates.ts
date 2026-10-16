import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { memoryHome } from "./home.ts";
import { realPath } from "./platform.ts";
import { MemoryStore, type NoteInput, type View } from "./store.ts";

export const CANDIDATE_DB_BUSY_TIMEOUT_MS = 3000;
export const CANDIDATE_RETENTION = { count: 500, ageMs: 30 * 86400_000 } as const;
export const COUNTER_RETENTION = { count: 10_000, ageMs: 90 * 86400_000 } as const;
export type CandidateVerdict = "public" | "private" | "pii" | "unknown";
export interface CandidateTarget { id: string; revision: string }
export type CandidateInput = { project: string } & (
  | { kind: "correction"; target: CandidateTarget; proposedText: string; reason: string; noteKind?: "decision" | "contract" | "fail" }
  | { kind: "fail"; target?: CandidateTarget; approach: string; symptom: string; cause: string; evidenceRefs: string[]; retryWhen: string }
  | { kind: "decay"; target: CandidateTarget; reason: string }
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
  policy: (candidate: Candidate, target: View | undefined, note: NoteInput) => boolean;
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
  } else if (input.kind === "decay") {
    if (!validTarget(input.target) || !text(input.reason)) throw new Error("invalid decay candidate");
  } else throw new Error("invalid candidate kind");
  if (Buffer.byteLength(canonical(input), "utf8") > 16_384) throw new Error("candidate payload exceeds 16 KiB");
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
export class CandidateStore {
  readonly dir: string;
  readonly path: string;
  private readonly db: Database;
  private readonly now: () => number;
  constructor(options: { home?: string; now?: () => number } = {}) {
    this.dir = options.home === undefined ? memoryHome() : join(options.home, "memory");
    this.now = options.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 }); chmodSync(this.dir, 0o700);
    this.path = join(this.dir, "candidates.db");
    this.db = new Database(this.path, { create: true });
    this.db.run(`PRAGMA busy_timeout = ${CANDIDATE_DB_BUSY_TIMEOUT_MS}`);
    chmodSync(this.path, 0o600); this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, note_id TEXT)");
    this.db.run("CREATE TABLE IF NOT EXISTS counters (id TEXT PRIMARY KEY, project TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, rendered INTEGER, delivered INTEGER, cited INTEGER)");
    this.prune();
  }
  close(): void { this.db.close(); }
  private prune(): void {
    this.db.transaction(() => {
      for (const [table, retention] of [["candidates", CANDIDATE_RETENTION], ["counters", COUNTER_RETENTION]] as const) {
        this.db.query(`DELETE FROM ${table} WHERE at <= ?`).run(this.now() - retention.ageMs);
        this.db.query(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM (SELECT rowid, row_number() OVER (PARTITION BY project ORDER BY at DESC, rowid DESC) AS rank FROM ${table}) WHERE rank > ?)`).run(retention.count);
      }
    }).immediate();
  }
  private decode(row: { id: string; payload: string; at: number; status: CandidateStatus; note_id: string | null }): Candidate {
    const input = JSON.parse(row.payload) as CandidateInput; validate(input);
    if (hash({ schema: "agent-mem.candidate/v1", input }) !== row.id) throw new Error("candidate content hash mismatch");
    return { id: row.id, createdAt: new Date(row.at).toISOString(), status: row.status, input, acceptedNoteId: row.note_id };
  }
  put(input: CandidateInput, verdict: CandidateVerdict): string {
    publicOnly(verdict); validate(input); this.prune();
    const payload = canonical(input), id = hash({ schema: "agent-mem.candidate/v1", input });
    this.db.query("INSERT OR IGNORE INTO candidates (id, project, kind, payload, at, status) VALUES (?, ?, ?, ?, ?, 'pending')").run(id, input.project, input.kind, payload, this.now());
    this.prune(); return id;
  }
  get(id: string, project: string): Candidate | undefined {
    if (!candidateId(id) || !text(project, 400)) throw new Error("invalid candidate identity");
    this.prune();
    const row = this.db.query("SELECT * FROM candidates WHERE id = ? AND project = ?").get(id, project) as Parameters<CandidateStore["decode"]>[0] | null;
    return row ? this.decode(row) : undefined;
  }
  list(filter: CandidateFilter): Candidate[] {
    if (!text(filter.project, 400) || filter.status !== undefined && !["pending", "accepting", "accepted", "rejected", "all"].includes(filter.status) || filter.kind !== undefined && !["correction", "fail", "decay"].includes(filter.kind)) throw new Error("invalid candidate filter");
    const limit = filter.limit ?? CANDIDATE_RETENTION.count;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CANDIDATE_RETENTION.count) throw new Error("candidate limit must be 1..500");
    this.prune();
    const where = ["project = ?"], bind: (string | number)[] = [filter.project];
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
    const rows = this.db.query("SELECT * FROM counters WHERE project = ? ORDER BY at DESC, rowid DESC").all(project) as { id: string; payload: string; at: number; rendered: number | null; delivered: number | null; cited: number | null }[];
    return rows.map(row => ({ id: row.id, key: JSON.parse(row.payload) as CounterKey, createdAt: new Date(row.at).toISOString(), rendered: row.rendered, delivered: row.delivered, cited: row.cited })).filter(row => !entry || row.key.entryId === entry);
  }
  reject(id: string, context: { project: string; actor: "person" | "agent"; verdict: CandidateVerdict }): void {
    personOnly(context.actor); publicOnly(context.verdict);
    this.db.transaction(() => {
      const candidate = this.get(id, context.project);
      if (!candidate) throw new Error("candidate unavailable");
      if (candidate.status === "accepted" || candidate.status === "accepting") throw new Error("candidate acceptance already started; inspect its ordinary note before any further action");
      this.db.query("UPDATE candidates SET status = 'rejected' WHERE id = ? AND project = ? AND status = 'pending'").run(id, context.project);
    }).immediate();
  }
  accept(id: string, context: CandidateAcceptance): CandidateAcceptanceResult {
    personOnly(context.actor); publicOnly(context.verdict);
    if (realPath(context.store.dir) !== realPath(this.dir) || typeof context.policy !== "function") throw new Error("candidate acceptance requires its memory store and a current host policy");
    return context.store.withDeferredPromotions(() => this.acceptDeferred(id, context));
  }
  private acceptDeferred(id: string, context: CandidateAcceptance): CandidateAcceptanceResult {
    const candidate = this.get(id, context.project);
    if (!candidate) throw new Error("candidate unavailable");
    if (candidate.status === "accepted") return { candidateId: id, noteId: candidate.acceptedNoteId!, alreadyAccepted: true };
    if (candidate.status !== "pending") throw new Error("candidate is rejected or acceptance was interrupted; no automatic replay");
    if (candidate.input.kind === "decay") throw new Error("decay candidates are listing-only; no automatic mutation is available");
    const resolve = () => {
      const target = candidate.input.target;
      if (!target) return undefined;
      const current = context.store.get(target.id, context.project);
      if (!current || current.id !== target.id || candidateTargetRevision(current) !== target.revision) throw new Error("candidate target revision is stale");
      return current;
    };
    const target = resolve(), data = candidate.input;
    const body = data.kind === "correction" ? `${data.proposedText}\n\nReason: ${data.reason}`
      : `Approach: ${data.approach}\nSymptom: ${data.symptom}\nCause: ${data.cause}\nEvidence: ${data.evidenceRefs.join(", ")}\nRetry when: ${data.retryWhen}`;
    const note: NoteInput = { op: "note", project: data.kind === "correction" ? target!.project : context.project,
      scope: data.kind === "correction" ? target!.scope : "project",
      // A demoted synced target is logically short, but replacing it locally would narrow its reach (X04).
      tier: data.kind === "correction" && target!.local ? "short" : "long",
      kind: data.kind === "fail" ? "fail" : data.noteKind ?? (target?.kind === "contract" || target?.kind === "fail" ? target.kind : "decision"), peer: "person", source: "person", about: [...target?.about ?? []],
      text: `Accepted candidate: ${id}\nTarget revision: ${data.target?.revision ?? "none"}\nTarget entry: ${data.target?.id ?? "none"}\n\n${body}` };
    if (note.text.length > 4000) throw new Error("accepted candidate text exceeds the v1 note limit");
    if (context.policy(structuredClone(candidate), target && structuredClone(target), structuredClone(note)) !== true) throw new Error("candidate refused by current host policy");
    return context.store.withAcceptedNote(note, append => {
      resolve(); // Recheck under the same mutation lock as the note and supersede appends.
      const started = this.db.transaction(() => {
        const current = this.get(id, context.project);
        if (!current) throw new Error("candidate unavailable");
        if (current.status === "accepted") return current.acceptedNoteId!;
        if (current.status !== "pending") throw new Error("candidate is rejected or acceptance was interrupted; no automatic replay");
        this.db.query("UPDATE candidates SET status = 'accepting' WHERE id = ? AND project = ?").run(id, context.project);
        return undefined;
      }).immediate();
      if (started) return { candidateId: id, noteId: started, alreadyAccepted: true };
      // ponytail: the sidecar receipt and v1 append are not one transaction. An interrupted 'accepting' row refuses
      // automatic replay; add explicit person-audited recovery before offering background acceptance retries.
      const noteId = append();
      if (data.kind === "correction" && !context.store.supersede(target!.id, noteId, "person", context.project)) throw new Error("candidate replacement refused; inspect the accepted note before recovery");
      this.db.query("UPDATE candidates SET status = 'accepted', note_id = ? WHERE id = ? AND project = ?").run(noteId, id, context.project);
      return { candidateId: id, noteId, alreadyAccepted: false };
    });
  }
}
