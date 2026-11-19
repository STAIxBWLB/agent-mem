/**
 * #326: the memory correctness audit. Whether a stored note is still right cannot be measured by ranking, so this samples curated notes, records where each
 * note's own anchors stand today, and leaves two empty judge columns for a person (or an agent in another session) to fill. `score` then turns those labels
 * into content-free counts and Cohen's kappa.
 *
 * amem makes no model and no network call here: `git log` over the anchors is the only outside read, and it is read-only. Judging happens outside amem, so a
 * judgement never depends on a model this package vendors or on a key it would have to hold.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import {
  AUDIT_AGE_BUCKETS, AUDIT_ANCHOR_STATUSES, AUDIT_KINDS, AUDIT_LABELS, AUDIT_RUBRIC, AUDIT_SCHEMA, MAX_AUDIT_ANCHORS, MAX_AUDIT_NOTES, MAX_AUDIT_SHEET_BYTES,
  auditAge, cohenKappa, foldAnchorStatus, type AuditAgeBucket, type AuditAnchorStatus, type AuditLabel,
} from "./eval.ts";
import { memoryGitEnv, memoryGitSync, realPath } from "./platform.ts";
import type { MemoryStore, View } from "./store.ts";

export interface AuditAnchor { path: string; status: Exclude<AuditAnchorStatus, "none"> }
export interface AuditNote {
  id: string; kind: string; at: string; age: AuditAgeBucket;
  /** The spec's per-note verdict over every path anchor this note names; `none` when it names none. */
  anchor: AuditAnchorStatus; anchors: AuditAnchor[];
  title?: string; text: string;
  /** Empty until a judge fills it; the sheet's only free cells, and only ever a closed label. */
  judge_a: "" | AuditLabel; judge_b: "" | AuditLabel;
}
export interface AuditSheet {
  schema: typeof AUDIT_SCHEMA; project: string; seed: string;
  /**
   * The instant the age buckets were measured at - `--as-of` when it was given, this run's clock otherwise - recorded so the same store, seed and as-of draw the
   * same sample instead of reaching the wall clock silently.
   */
  asOf: string;
  /** The git work tree the anchors were checked in; anchors are repository-relative, so the sheet is only re-scoreable, never re-checkable, elsewhere. */
  root: string; frame: number; drawn: number;
  /** True when the store's listing bound cut the frame, so `frame` is a floor rather than the project's live note count. */
  truncated: boolean;
  /** Frame members the configured policy refused, so they never entered the sheet: a count, because the sheet stays free of what was withheld. */
  withheld: number;
  rubric: Record<AuditLabel, string>;
  notes: AuditNote[];
}
export interface AuditSampleOptions {
  store: MemoryStore; project: string; n: number; seed: string; root: string;
  /** The instant the age buckets are measured at; the CLI passes `--as-of` or its own clock, and the sheet records whichever it was. */
  asOf?: number;
  /** Screens one frame member before it can enter the sheet; `false` withholds it. The CLI passes the configured standalone policy. */
  screen?: (note: { kind: string; at: string; text: string; title?: string; about: readonly string[] }) => boolean;
}

/** One frame member before the draw: the view plus the bucket the sheet will name. */
interface Candidate { view: View; age: AuditAgeBucket }

/**
 * The bound on the one listing the frame is read from. A project with more live notes than this has its frame cut, and the sheet says `truncated` rather than
 * reporting the bound as if it were the whole frame.
 * ponytail: one bounded listing instead of a windowed walk; upgrade to a cursor over the store's ordering when a frame this size is real.
 */
const AUDIT_LIST_CAP = MAX_AUDIT_NOTES * 100;

const fail = (message: string): never => { throw new Error(`invalid audit sheet: ${message}`); };
const object = (value: unknown, what: string): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : fail(`${what} must be an object`);
function exact(row: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(row)) if (!allowed.includes(key)) fail(`${what} has an unknown key "${key.slice(0, 40)}": the score is content-free, so a free-text field is refused rather than read`);
}
const string = (value: unknown, what: string, max: number): string => typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : fail(`${what} must be a string of at most ${max} characters without control characters`);
const oneOf = <T extends string>(value: unknown, vocabulary: readonly T[], what: string): T => vocabulary.includes(value as T) ? value as T : fail(`${what} must be one of ${vocabulary.join(", ")}`);
const seedValue = (value: unknown): string => typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : fail("seed must be 1 to 64 letters, digits, '.', '_' or '-', the alphabet `sample` draws with");
/** A canonical UTC instant - the one clock value a sheet and its score carry - so a hand-edited sheet cannot park free text in it. */
const stamp = (value: unknown): string => {
  const at = typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) && new Date(at).toISOString() === value ? value as string : fail("asOf must be a canonical UTC instant such as 2026-02-01T00:00:00.000Z, the one the age buckets were measured at");
};
const bool = (value: unknown, what: string): boolean => typeof value === "boolean" ? value : fail(`${what} must be true or false`);

/** SHA-256 of the seed with a stratum and its ordinal, so one seed gives one order on every machine and runtime (no `Math.random`, no clock). */
function seededOrder(seed: string, key: string, size: number): number[] {
  let state = 0;
  for (const byte of createHash("sha256").update(`${seed}\n${key}`).digest()) state = (state * 257 + byte) % 0x1_0000_0000;
  const at = Array.from({ length: size }, (_, index) => index);
  for (let i = size - 1; i > 0; i--) {
    state = (state * 1_664_525 + 1_013_904_223) % 0x1_0000_0000;
    const j = state % (i + 1);
    [at[i], at[j]] = [at[j]!, at[i]!];
  }
  return at;
}

/**
 * Stratified draw by kind and age bucket. Every non-empty cell is represented before any cell gets a second note, then the remainder goes to the cells with
 * the most members left to offer, and ties break on the stratum name - so the same frame, `n` and seed always give the same notes in the same order.
 */
function draw(candidates: readonly Candidate[], n: number, seed: string): Candidate[] {
  const cells = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.view.kind}\n${candidate.age}`;
    const list = cells.get(key); if (list) list.push(candidate); else cells.set(key, [candidate]);
  }
  // The cells are drawn in seeded order too, so a different seed reaches different strata instead of always the lexicographically first ones.
  const names = [...cells.keys()].sort(), keys = seededOrder(seed, "cells", names.length).map(index => names[index]!);
  const size = (key: string) => cells.get(key)!.length, total = Math.min(n, candidates.length);
  const quota = new Map(keys.map(key => [key, 0]));
  let left = total;
  for (const key of keys) { if (left <= 0) break; quota.set(key, 1); left--; }
  while (left > 0) {
    const roomy = keys.filter(key => quota.get(key)! < size(key)).sort((a, b) => (size(b) - quota.get(b)!) - (size(a) - quota.get(a)!) || a.localeCompare(b));
    const next = roomy[0];
    if (next === undefined) break;
    quota.set(next, quota.get(next)! + 1); left--;
  }
  const drawn: Candidate[] = [];
  for (const key of keys) {
    const list = [...cells.get(key)!].sort((a, b) => a.view.id.localeCompare(b.view.id)), order = seededOrder(seed, key, list.length);
    for (const index of order.slice(0, quota.get(key)!)) drawn.push(list[index]!);
  }
  return drawn;
}

/** The path anchors a note names, deduplicated, bounded, and never outside the work tree (a `..` segment is dropped rather than read). */
export function auditAnchorPaths(view: View): string[] {
  const paths = new Set<string>();
  for (const node of view.about) {
    if (!node.startsWith("path:") || paths.size >= MAX_AUDIT_ANCHORS) continue;
    const path = node.slice(5).replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.split("/").includes("..")) continue;
    paths.add(path);
  }
  return [...paths];
}

/** The statuses an anchor path can have: every one but `none`, which describes a note rather than a path. */
const PATH_STATUSES = AUDIT_ANCHOR_STATUSES.filter((status): status is Exclude<AuditAnchorStatus, "none"> => status !== "none");

/**
 * Where one anchor stands today. A path that is gone is `missing`; one with a commit touching it since the note was written is `changed since note time`;
 * anything else is `present`. Two shapes are `unavailable` instead, because claiming `present` would say "no commit touched it" about a check that never ran:
 * a path that resolves outside the work tree (a symlink inside the repository can point anywhere, and the audit reads only this repository), and a history
 * read that fails or times out. The read itself runs through the hardened runner: read-only diagnostics, no lazy fetch.
 */
function anchorStatus(root: string, at: string, path: string): AuditAnchor["status"] {
  const full = join(root, path);
  if (!existsSync(full)) return "missing";
  let real: string;
  try { real = realPath(full); } catch { return "unavailable"; }
  if (real !== root && !real.startsWith(`${root}${sep}`)) return "unavailable";
  const log = memoryGitSync(["-C", root, "log", "-n", "1", "--format=%H", "--since", at, "--", path], {
    encoding: "utf8", env: memoryGitEnv(process.env, { readOnlyDiagnostic: true }), timeout: 8_000, maxBuffer: 64 * 1024,
  });
  if (log.error !== undefined || log.status !== 0) return "unavailable";
  return log.stdout.trim() === "" ? "present" : "changed";
}

/** The git work tree a cwd belongs to, or a refusal naming the next step: anchors are repository-relative, so an audit needs the tree they name. */
export function auditRoot(cwd: string): string {
  const top = memoryGitSync(["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: memoryGitEnv(process.env, { readOnlyDiagnostic: true }), timeout: 8_000, maxBuffer: 64 * 1024 });
  const root = top.status === 0 ? top.stdout.trim() : "";
  if (!root) throw new Error(`the audit checks note anchors against a git work tree, and ${cwd} is not inside one; run it from the project the notes describe`);
  return realPath(root);
}

/**
 * The instant `--as-of` names, normalized to one canonical UTC stamp: a date alone is midnight UTC of that day, and anything else must already be canonical.
 * A future instant is refused, because it would measure ages that have not happened and quietly drop notes out of every bucket.
 */
export function auditAsOf(value: string, present: number): number {
  const iso = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) ? `${value}T00:00:00.000Z` : value, at = Date.parse(iso);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== iso) {
    throw new Error(`--as-of must be a canonical UTC date or timestamp (2026-01-31 or 2026-01-31T00:00:00.000Z), and "${value.slice(0, 40)}" is not; it is the instant the notes' ages are measured at, and the sheet records it so the same seed draws the same sample again`);
  }
  if (at > present) throw new Error(`--as-of ${iso} is in the future, and the audit measures how old the notes are at that instant; pass today or an earlier date`);
  return at;
}

/** Draw the sample and describe it. Nothing is written here: the caller chooses the private path. */
export function auditSample(opts: AuditSampleOptions): AuditSheet {
  if (!Number.isInteger(opts.n) || opts.n < 1 || opts.n > MAX_AUDIT_NOTES) throw new Error(`the audit draws 1 to ${MAX_AUDIT_NOTES} notes, not ${opts.n}`);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(opts.seed)) throw new Error("the audit seed is 1 to 64 letters, digits, '.', '_' or '-', so the same seed and store draw the same sample");
  const asOf = opts.asOf ?? Date.now(), kinds = new Set<string>(AUDIT_KINDS), candidates: Candidate[] = [];
  const listed = opts.store.list({ project: opts.project, limit: AUDIT_LIST_CAP });
  let withheld = 0;
  for (const view of listed) {
    if (!kinds.has(view.kind)) continue;
    const age = auditAge(view.at, asOf);
    if (age === undefined) continue;
    // The policy runs before anything is written: a note it refuses is not copied into the sheet, and the sheet only reports how many were withheld.
    if (opts.screen && !opts.screen({ kind: view.kind, at: view.at, text: view.text, ...(view.title === null ? {} : { title: view.title }), about: view.about })) { withheld++; continue; }
    candidates.push({ view, age });
  }
  const drawn = draw(candidates, opts.n, opts.seed);
  // A sheet with no notes cannot be judged and its own parser refuses it, so an empty frame is a refusal with the cause and the next step, not a file.
  if (!drawn.length) throw new Error(withheld
    ? `the audit drew no notes: the configured policy withheld all ${withheld} candidate note(s), so nothing could be sampled; adjust the policy or sample from the project that holds the notes`
    : `the audit drew no notes: ${opts.project} has no live decision, finding, contract or fail note in the frame this work tree covers; record curated notes and sample again`);
  const notes = drawn.map(({ view, age }): AuditNote => {
    const anchors = auditAnchorPaths(view).map(path => ({ path, status: anchorStatus(opts.root, view.at, path) }));
    return {
      id: view.id, kind: view.kind, at: view.at, age, anchor: foldAnchorStatus(anchors.map(anchor => anchor.status)), anchors,
      ...(view.title === null ? {} : { title: view.title }), text: view.text, judge_a: "", judge_b: "",
    };
  });
  return {
    schema: AUDIT_SCHEMA, project: opts.project, seed: opts.seed, asOf: new Date(asOf).toISOString(), root: opts.root,
    frame: candidates.length, drawn: notes.length, truncated: listed.length >= AUDIT_LIST_CAP, withheld, rubric: { ...AUDIT_RUBRIC }, notes,
  };
}

/** The sheet's own file: pretty JSON, because a person fills `judge_a` and `judge_b` in it by hand. Never overwritten (flag `wx`), always 0600. */
export function writeAuditSheet(path: string, sheet: AuditSheet): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file = join(realPath(dirname(path)), basename(path));
  try {
    writeFileSync(file, JSON.stringify(sheet, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`an audit sheet is never overwritten and ${file} exists; keep it and pass \`--out <another path>\`, or sample again with a new --seed`);
  }
  return file;
}

/** A bounded read of an untrusted file: a regular file within the sheet bound, with the size and the bytes read bound together. */
export function readAuditSheet(path: string): AuditSheet {
  const tooBig = () => new Error(`invalid audit sheet: ${path} is not a regular file within ${MAX_AUDIT_SHEET_BYTES} bytes; score the sheet \`amem eval audit sample\` wrote instead of a directory or a larger file`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_AUDIT_SHEET_BYTES) throw tooBig();
    const buffer = Buffer.alloc(MAX_AUDIT_SHEET_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(fd);
    if (length > MAX_AUDIT_SHEET_BYTES || after.size !== before.size || length !== before.size) throw tooBig();
    bytes = buffer.subarray(0, length);
  } finally { closeSync(fd); }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`invalid audit sheet: ${path} is not valid JSON; re-open the sheet \`amem eval audit sample\` wrote, fill only judge_a and judge_b, and save it whole`); }
  return parseAuditSheet(raw);
}

/**
 * Strict parse of a filled sheet. Unknown keys are refused rather than ignored: the sheet holds note text, and a key the score does not know is exactly how
 * free text would reach the content-free output. A judge cell holds one of the four labels or stays empty, a kind is one of the audit's four, the as-of instant
 * is a canonical UTC stamp, and the seed is the alphabet `sample` accepts - every value the score copies or turns into a bucket name is a closed set, not a
 * string from the file.
 */
export function parseAuditSheet(raw: unknown): AuditSheet {
  const root = object(raw, "the sheet");
  exact(root, ["schema", "project", "seed", "asOf", "root", "frame", "drawn", "truncated", "withheld", "rubric", "notes"], "the sheet");
  if (root.schema !== AUDIT_SCHEMA) fail(`schema must be "${AUDIT_SCHEMA}"`);
  if (!Array.isArray(root.notes) || !root.notes.length || root.notes.length > MAX_AUDIT_NOTES) fail(`notes must hold 1 to ${MAX_AUDIT_NOTES} items, and \`amem eval audit sample\` writes a sheet of at least one note`);
  const notes = (root.notes as unknown[]).map((item, index): AuditNote => {
    const row = object(item, `notes[${index}]`), what = `notes[${index}]`;
    exact(row, ["id", "kind", "at", "age", "anchor", "anchors", "title", "text", "judge_a", "judge_b"], what);
    const id = typeof row.id === "string" && /^[0-9a-f]{32}$/.test(row.id) ? row.id : fail(`${what}.id must be a 32-character lowercase hex entry id`);
    const judge = (cell: unknown, name: string): "" | AuditLabel => cell === "" ? "" : oneOf(cell, AUDIT_LABELS, `${what}.${name}`);
    if (!Array.isArray(row.anchors) || row.anchors.length > MAX_AUDIT_ANCHORS) fail(`${what}.anchors must hold at most ${MAX_AUDIT_ANCHORS} items`);
    const anchors = (row.anchors as unknown[]).map((anchor, at): AuditAnchor => {
      const entry = object(anchor, `${what}.anchors[${at}]`);
      exact(entry, ["path", "status"], `${what}.anchors[${at}]`);
      return { path: string(entry.path, `${what}.anchors[${at}].path`, 400), status: oneOf(entry.status, PATH_STATUSES, `${what}.anchors[${at}].status`) };
    });
    return {
      id, kind: oneOf(row.kind, AUDIT_KINDS, `${what}.kind`), at: string(row.at, `${what}.at`, 40), age: oneOf(row.age, AUDIT_AGE_BUCKETS, `${what}.age`),
      anchor: oneOf(row.anchor, AUDIT_ANCHOR_STATUSES, `${what}.anchor`), anchors,
      ...(row.title === undefined ? {} : { title: string(row.title, `${what}.title`, 200) }),
      text: string(row.text, `${what}.text`, 4_000), judge_a: judge(row.judge_a, "judge_a"), judge_b: judge(row.judge_b, "judge_b"),
    };
  });
  const rubric = object(root.rubric, "the sheet's rubric");
  return {
    schema: AUDIT_SCHEMA, project: string(root.project, "project", 200), seed: seedValue(root.seed),
    asOf: stamp(root.asOf), root: string(root.root, "root", 1_000),
    frame: typeof root.frame === "number" && Number.isInteger(root.frame) && root.frame >= 0 ? root.frame : fail("frame must be a non-negative integer"),
    drawn: typeof root.drawn === "number" && Number.isInteger(root.drawn) && root.drawn >= 0 ? root.drawn : fail("drawn must be a non-negative integer"),
    truncated: bool(root.truncated, "truncated"),
    withheld: typeof root.withheld === "number" && Number.isInteger(root.withheld) && root.withheld >= 0 ? root.withheld : fail("withheld must be a non-negative integer"),
    rubric: Object.fromEntries(AUDIT_LABELS.map(label => [label, string(rubric[label] ?? AUDIT_RUBRIC[label], `rubric.${label}`, 400)])) as Record<AuditLabel, string>,
    notes,
  };
}

/** One non-zero cell of the joint cross-tab: a label against a kind, an age bucket and an anchor status together. */
export interface AuditCell { kind: string; age: AuditAgeBucket; anchor: AuditAnchorStatus; label: AuditLabel; count: number }

export interface AuditScore {
  schema: "amem.audit.score/v1";
  /** A SHA-256 prefix of the sheet's project key, never the key: a key can be derived from a local checkout path, and the score is the part meant to be shared. */
  project: string;
  /** The instant the age buckets were measured at, so a shared coefficient travels with the buckets that produced it. */
  asOf: string;
  frame: number; drawn: number; truncated: boolean; withheld: number;
  labelled: number; unlabelled: number;
  byLabel: Record<AuditLabel, number>;
  /** The spec's joint cross-tab (label x kind x age bucket x anchor status) as its non-zero cells, sorted; the marginals below cannot rebuild it. */
  cells: AuditCell[];
  byKind: Record<string, Partial<Record<AuditLabel, number>>>;
  byAge: Record<string, Partial<Record<AuditLabel, number>>>;
  byAnchor: Record<string, Partial<Record<AuditLabel, number>>>;
  agreement: { pairs: number; agreed: number; kappa: number | null };
}

/** So two scores name the same project without carrying a key, which can be built from the person's own checkout path. */
function projectDigest(project: string): string {
  return `sha256:${createHash("sha256").update(project).digest("hex").slice(0, 16)}`;
}

/**
 * The score is content-free because no note field is copied into it: the project becomes a digest, the clock becomes the canonical stamp the sheet recorded,
 * and every other string it emits is a schema or field literal or a member of the four closed vocabularies. The seed is not in the score at all, so no note
 * text - not even a three-character text no substring scan could tell from an ordinary word - can collide with one. This check makes the rest true for a sheet
 * handed in directly rather than through the strict parse: a kind, age bucket or anchor status outside its vocabulary would become a key in `byKind`, `byAge`,
 * `byAnchor` or `cells`, and a judge cell outside the four labels would become a key in the tallies, so all of them refuse the score instead. Note text, title
 * and anchor paths are never read by the score at all.
 */
function assertClosedInputs(sheet: AuditSheet): void {
  stamp(sheet.asOf);
  for (const note of sheet.notes) {
    if (!AUDIT_KINDS.includes(note.kind) || !AUDIT_AGE_BUCKETS.includes(note.age) || !AUDIT_ANCHOR_STATUSES.includes(note.anchor)) {
      throw new Error("the audit score would carry a kind, age bucket or anchor status outside its closed vocabulary; it is refused, because the score is content-free by contract");
    }
    for (const judge of [note.judge_a, note.judge_b]) {
      if (judge !== "" && !AUDIT_LABELS.includes(judge)) {
        throw new Error("the audit score would carry a judge cell outside the four labels; it is refused, because the score is content-free by contract");
      }
    }
  }
}

const tally = (rows: readonly AuditNote[], key: (note: AuditNote) => string): Record<string, Partial<Record<AuditLabel, number>>> => {
  const out: Record<string, Partial<Record<AuditLabel, number>>> = {};
  for (const note of rows) {
    if (note.judge_a === "") continue;
    const bucket = out[key(note)] ??= {};
    bucket[note.judge_a] = (bucket[note.judge_a] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

/**
 * Counts by label against kind, age bucket and anchor status - separately and jointly - plus Cohen's kappa over the notes both judges labelled. The result is
 * content-free by the check above and by construction: the project key is replaced by a digest, and no note field is read into the output.
 */
export function auditScore(sheet: AuditSheet): AuditScore {
  assertClosedInputs(sheet);
  const labelled = sheet.notes.filter(note => note.judge_a !== "");
  const pairs = sheet.notes.filter(note => note.judge_a !== "" && note.judge_b !== "").map(note => [note.judge_a, note.judge_b] as const);
  const joint = new Map<string, AuditCell>();
  for (const note of labelled) {
    const label = note.judge_a as AuditLabel, key = `${note.kind}\u0000${note.age}\u0000${note.anchor}\u0000${label}`, cell = joint.get(key);
    if (cell) cell.count++;
    else joint.set(key, { kind: note.kind, age: note.age, anchor: note.anchor, label, count: 1 });
  }
  const score: AuditScore = {
    schema: "amem.audit.score/v1", project: projectDigest(sheet.project), asOf: sheet.asOf, frame: sheet.frame, drawn: sheet.drawn,
    truncated: sheet.truncated, withheld: sheet.withheld, labelled: labelled.length, unlabelled: sheet.notes.length - labelled.length,
    byLabel: Object.fromEntries(AUDIT_LABELS.map(label => [label, labelled.filter(note => note.judge_a === label).length])) as Record<AuditLabel, number>,
    cells: [...joint.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, cell]) => cell),
    byKind: tally(sheet.notes, note => note.kind), byAge: tally(sheet.notes, note => note.age), byAnchor: tally(sheet.notes, note => note.anchor),
    agreement: { pairs: pairs.length, agreed: pairs.filter(([a, b]) => a === b).length, kappa: cohenKappa(pairs, AUDIT_LABELS) },
  };
  return score;
}

/** Human text for `amem eval audit sample`: where the sheet is, and what filling it costs. Content-free, like the score. */
export function auditSheetText(sheet: AuditSheet, file: string): string {
  const cells = new Set(sheet.notes.map(note => `${note.kind}/${note.age}`));
  const frame = `${sheet.frame}${sheet.truncated ? "+ (the store listing hit its cap, so the frame is a floor)" : ""}`;
  return [
    `audit sample: ${sheet.drawn} of ${frame} ${sheet.project} notes, seed "${sheet.seed}" as of ${sheet.asOf}, ${cells.size} kind/age cells, anchors checked in ${sheet.root}${sheet.withheld ? `, ${sheet.withheld} withheld by the configured policy` : ""}`,
    `sheet: ${file} (0600, local only; never synced and never committed)`,
    `fill judge_a and judge_b with ${AUDIT_LABELS.join(", ")} (rubric in the sheet header), then run \`amem eval audit score ${file}\``,
  ].join("\n");
}

/** Human text for `amem eval audit score`; the JSON is the machine form. */
export function auditScoreText(score: AuditScore): string {
  const row = (label: string, counts: Partial<Record<AuditLabel, number>>) => `${label.padEnd(10)} ${AUDIT_LABELS.map(name => String(counts[name] ?? 0).padStart(4)).join(" ")}`;
  const frame = `${score.frame}${score.truncated ? "+ (the store listing hit its cap, so the frame is a floor)" : ""}`;
  const withheld = score.withheld ? `, ${score.withheld} withheld by the configured policy` : "";
  const head = `audit score: project ${score.project}, ${score.drawn} of ${frame} notes as of ${score.asOf}, ${score.labelled} labelled, ${score.unlabelled} not${withheld}`;
  // The joint cells are printed as one line per kind/age/anchor stratum, so a reader sees which label fills each intersection instead of three marginals.
  const strata = new Map<string, Partial<Record<AuditLabel, number>>>();
  for (const cell of score.cells) {
    const key = `${cell.kind}/${cell.age}/${cell.anchor}`, counts = strata.get(key) ?? {};
    counts[cell.label] = cell.count;
    strata.set(key, counts);
  }
  return [
    head,
    `${"".padEnd(10)} ${AUDIT_LABELS.map(name => name.slice(0, 4).padStart(4)).join(" ")}`,
    row("all", score.byLabel),
    ...Object.entries(score.byKind).map(([kind, counts]) => row(`kind ${kind}`, counts)),
    ...Object.entries(score.byAge).map(([age, counts]) => row(`age ${age}`, counts)),
    ...Object.entries(score.byAnchor).map(([anchor, counts]) => row(`anchor ${anchor}`, counts)),
    ...strata.entries().map(([key, counts]) => row(`cross ${key}`, counts)),
    `kappa ${score.agreement.kappa === null ? "n/a (needs both judge columns, and more than one label between them)" : score.agreement.kappa.toFixed(3)} over ${score.agreement.pairs} doubly labelled note(s)`,
  ].join("\n");
}
