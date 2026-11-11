import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRecordLines, type ParsedRecord } from "../hook-record.ts";
import type { CandidateInput, RecordSource, RecordSourceBinding } from "./candidates.ts";
import { CaptureStore, type CaptureRow } from "./capture.ts";
import { captureShardDir } from "./shard.ts";

/**
 * #368: the capture `Record` rows a session already stores become curated candidates here. The window is the brief one, so
 * a proposal never costs more than the SessionStart read already pays: newest first, project-bound, main-session only and
 * index-backed.
 */
export const RECORD_CANDIDATE_WINDOW = 32;
/** One candidate cites at most this many rows; the rest stay in capture for the next run. */
export const RECORD_SOURCE_LIMIT = 8;
const ANCHOR_LIMIT = 32, ANCHOR_MAX = 400, ABOUT_LIMIT = 32, EVIDENCE_LIMIT = 16, TITLE_MAX = 200;

export interface RecordCandidateWindow { rows: readonly CaptureRow[]; partial: boolean }
export type RecordCandidateInput = Extract<CandidateInput, { kind: "fail" | "memory" }>;
/** Exactly the capture content the policy screens before the row becomes a candidate. */
export interface RecordCandidateSource { event: "Record"; paths: string[]; excerpt: string }
export interface RecordProposal { input: RecordCandidateInput; source: RecordCandidateSource }
/** Group keys already in the queue: pending/accepting is queued, accepted/rejected is reviewed. */
export interface RecordQueueIndex { queued: ReadonlySet<string>; reviewed: ReadonlySet<string> }
export interface RecordCandidateCounts {
  /** Rows in the window that parsed as one canonical Record. */
  found: number;
  /** Proposals that merged more than one row. */
  grouped: number;
  alreadyQueued: number; alreadyReviewed: number;
  /** Rows that yielded no canonical Record: malformed, truncated, rewritten or subagent. */
  excluded: number;
  /** The window had more Records than it could show. */
  truncated: boolean;
}
export interface RecordCandidateResult { proposals: RecordProposal[]; counts: RecordCandidateCounts }

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** The stored line's identity, so acceptance can tell an edited row from a pruned one. */
export const recordTextHash = (line: string): string => createHash("sha256").update(`agent-mem.record-text/v1\n${line}`).digest("hex");
/** Kind plus anchors, or kind plus text when the Record carries none, so the same lesson is not queued twice. */
const groupKey = (record: ParsedRecord): string => digest(record.anchors.length
  ? { schema: "agent-mem.record-group/v1", kind: record.kind, anchors: record.anchors }
  : { schema: "agent-mem.record-group/v1", kind: record.kind, text: record.text });

/** One row is one canonical line: a re-parse that drops anything or rewrites the line is not a whole Record. */
function parses(row: CaptureRow): ParsedRecord | undefined {
  if (row.event !== "Record" || row.subagent === true || typeof row.excerpt !== "string" || typeof row.at !== "string"
    || !Number.isFinite(Date.parse(row.at)) || typeof row.session !== "string" || !/^[a-f0-9]{16}$/.test(row.session)) return undefined;
  const turn = parseRecordLines(row.excerpt), record = turn.records[0];
  if (!record || turn.records.length !== 1 || Object.keys(turn.drops).length || record.line !== row.excerpt) return undefined;
  return record.anchors.length <= ANCHOR_LIMIT && record.anchors.every(anchor => anchor.length <= ANCHOR_MAX) ? record : undefined;
}

/** A Record anchor is a repository path, optionally with one `#symbol`; the curated store keeps them as two node kinds. */
function aboutNodes(anchors: readonly string[]): string[] {
  const nodes: string[] = [];
  for (const anchor of anchors) {
    const at = anchor.indexOf("#"), path = at < 0 ? anchor : anchor.slice(0, at), symbol = at < 0 ? "" : anchor.slice(at + 1);
    nodes.push(`path:${path}`);
    if (symbol) nodes.push(`symbol:${symbol}@${path}`);
    if (nodes.length >= ABOUT_LIMIT) break;
  }
  return nodes.slice(0, ABOUT_LIMIT);
}

function fixTitle(text: string): string {
  const room = TITLE_MAX - "fix: ".length, characters = Array.from(text);
  return `fix: ${characters.length <= room ? text : `${characters.slice(0, room - 3).join("")}...`}`;
}

function propose(project: string, key: string, record: ParsedRecord, sources: RecordSource[]): RecordCandidateInput {
  const binding: RecordSourceBinding = { key, anchors: [...record.anchors], sources }, about = aboutNodes(record.anchors);
  if (record.kind === "fail") {
    // The grammar records one symptom/cause group and one retry condition, so the left group is all a row can fill. The
    // approach, cause and retry-when a fail note wants are the reviewer's: `amem review walk` opens them as the labelled
    // template, and the recorded right group stays in the capture row the candidate cites.
    const split = record.text.indexOf(" -> ");
    return { kind: "fail", project, approach: "", symptom: split < 0 ? record.text : record.text.slice(0, split).trim(), cause: "",
      retryWhen: "", evidenceRefs: record.anchors.slice(0, EVIDENCE_LIMIT), ...(about.length ? { about } : {}), record: binding };
  }
  return { kind: "memory", project, text: record.text, noteKind: record.kind === "fix" ? "finding" : record.kind,
    ...(record.kind === "fix" ? { title: fixTitle(record.text) } : {}), ...(about.length ? { about } : {}), record: binding };
}

/**
 * Deterministic proposals over one already-read window; no store, capture read, model or network work. Grouping uses the
 * window's newest-first order, so the candidate quotes the most recent text of its group and cites the rows behind it.
 */
export function recordCandidates(window: RecordCandidateWindow, project: string, index: RecordQueueIndex): RecordCandidateResult {
  if (typeof project !== "string" || !project.trim()) throw new Error("record candidates need a project key");
  const counts: RecordCandidateCounts = { found: 0, grouped: 0, alreadyQueued: 0, alreadyReviewed: 0, excluded: 0, truncated: window.partial === true };
  const groups = new Map<string, { record: ParsedRecord; sources: RecordSource[] }>();
  for (const row of window.rows) {
    const record = row.project === project ? parses(row) : undefined;
    if (!record) { counts.excluded++; continue; }
    counts.found++;
    const key = groupKey(record), source: RecordSource = { session: row.session!, at: row.at, textHash: recordTextHash(record.line) };
    const group = groups.get(key);
    if (group === undefined) { groups.set(key, { record, sources: [source] }); continue; }
    // One turn may emit two Records, so a source is distinguished by its text as well as its session and time.
    if (group.sources.length < RECORD_SOURCE_LIMIT && !group.sources.some(cited => cited.session === source.session && cited.at === source.at && cited.textHash === source.textHash)) group.sources.push(source);
  }
  const proposals: RecordProposal[] = [];
  for (const [key, group] of groups) {
    if (index.reviewed.has(key)) { counts.alreadyReviewed++; continue; }
    if (index.queued.has(key)) { counts.alreadyQueued++; continue; }
    if (group.sources.length > 1) counts.grouped++;
    proposals.push({ input: propose(project, key, group.record, group.sources),
      source: { event: "Record", paths: [...group.record.anchors], excerpt: group.record.line } });
  }
  return { proposals, counts };
}

/**
 * Acceptance-time proof that the rows a candidate quotes are still there and unchanged. A row outside the window reads as
 * missing, which is the same answer as a pruned one: the candidate's reviewer is told to rerun `amem consolidate`.
 */
export function recordSourceCheck(window: () => RecordCandidateWindow): (project: string, binding: RecordSourceBinding) => "present" | "changed" | "missing" {
  return (project, binding) => {
    const turns = new Set<string>(), present = new Set<string>();
    for (const row of window().rows) {
      if (row.project !== project || typeof row.session !== "string" || typeof row.at !== "string") continue;
      const turn = `${row.session}\n${row.at}`;
      turns.add(turn);
      const record = parses(row);
      if (record) present.add(`${turn}\n${recordTextHash(record.line)}`);
    }
    if (binding.sources.every(source => present.has(`${source.session}\n${source.at}\n${source.textHash}`))) return "present";
    // A row at the cited turn that no longer parses, or now holds another Record, was changed rather than pruned.
    return binding.sources.some(source => turns.has(`${source.session}\n${source.at}`)) ? "changed" : "missing";
  };
}

/**
 * The newest `Record` window of one project, or `undefined` when this home has no capture shard to read. Read-only and
 * synchronous, so acceptance can recheck a source row without opening a writable store or authoring capture metadata.
 */
export function recordWindow(base: string, project: string, cwd: string): (() => RecordCandidateWindow) | undefined {
  const machine = (() => { try { return (JSON.parse(readFileSync(join(base, "machine.json"), "utf8")) as { id?: unknown }).id; } catch { return undefined; } })();
  if (typeof machine !== "string" || !/^[a-f0-9]{16}$/.test(machine)) return undefined;
  if (!lstatSync(join(captureShardDir(base, project, machine), "capture.db"), { throwIfNoEntry: false })?.isFile()) return undefined;
  // ponytail: the brief window is the whole Record history `amem consolidate` sees, so the 32 newest Records are the ceiling.
  // A dedicated bounded Record scan over the shard (its own index, its own row budget) is the upgrade when that is too few.
  return () => {
    const store = new CaptureStore({ memoryDir: base, project, cwd, readOnly: true, busyTimeoutMs: 1000, maxReadRows: RECORD_CANDIDATE_WINDOW, recentReadRows: true });
    try { return store.readBriefRecords(RECORD_CANDIDATE_WINDOW); } finally { store.close(); }
  };
}
