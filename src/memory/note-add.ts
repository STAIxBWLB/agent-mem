import { KINDS, type Kind, type MemoryStore, type NoteInput, type Scope, type Tier } from "./store.ts";
import type { StandalonePolicy } from "./policy.ts";

/**
 * F6 (agent-mem#40): person note authoring. `amem note add` writes one curated note the person typed, through the configured policy. The note is authored by the
 * person (`peer: "person"`, `source: "person"`), which is why the command is person-only like every ordinary command (an agent marker is refused before it runs).
 *
 * A `fail` note carries structured fields. Its body uses the same labelled lines an accepted `fail` candidate produces, so a note written here and one accepted
 * from `amem_remember` read alike and `fail` search and the plan guard see one shape.
 */
export const NOTE_MAX_CHARS = 4000, NOTE_TITLE_MAX = 200, FAIL_FIELD_MAX = 1000, FAIL_EVIDENCE_MAX = 16;

export interface FailFields { approach: string; symptom: string; cause: string; evidence: string[]; retryWhen: string }
export interface NoteAddInput { kind: Kind; tier: Tier; scope: Scope; text?: string; title?: string; fail?: Partial<FailFields> }
export interface NoteAddResult { id: string }

const refuse = (message: string): never => { throw new Error(message); };
const clean = (value: string | undefined): string => (value ?? "").replace(/\r\n?/g, "\n").trim();
/** Every character a reader may treat as a line break: LF, CR, VT, FF, NEL and the Unicode line and paragraph separators. A field with any of them could forge a labelled line. */
export const LINE_BREAKS = /[\n\r\v\f\u0085\u2028\u2029]/;
export const oneLine = (value: string): string => value.replace(/\s*[\n\r\v\f\u0085\u2028\u2029]+\s*/g, " ");

/** The labelled body of a `fail` note: the exact lines an accepted fail candidate has, without the "Accepted candidate" provenance header. */
export function failBody(fields: FailFields): string {
  return `Approach: ${oneLine(fields.approach)}\nSymptom: ${oneLine(fields.symptom)}\nCause: ${oneLine(fields.cause)}\nEvidence: ${fields.evidence.map(oneLine).join(", ")}\nRetry when: ${oneLine(fields.retryWhen)}`;
}

/** Validate the structured fields and say which are missing, so the person can fix the command rather than guess. */
function failFields(raw: Partial<FailFields> | undefined): FailFields {
  const missing = ["approach", "symptom", "cause", "retryWhen"].filter(key => !clean(raw?.[key as keyof FailFields] as string | undefined));
  const evidence = (raw?.evidence ?? []).map(clean).filter(Boolean);
  const flags = { approach: "--approach", symptom: "--symptom", cause: "--cause", retryWhen: "--retry-when" } as Record<string, string>;
  if (missing.length || !evidence.length) refuse(`a fail note needs ${[...missing.map(key => flags[key]!), ...(evidence.length ? [] : ["--evidence"])].join(", ")} (approach, symptom, cause, evidence and retry-when are all required, so the next reader knows when the approach is worth retrying)`);
  if (evidence.length > FAIL_EVIDENCE_MAX) refuse(`a fail note takes at most ${FAIL_EVIDENCE_MAX} --evidence values`);
  const out: FailFields = { approach: clean(raw!.approach), symptom: clean(raw!.symptom), cause: clean(raw!.cause), evidence, retryWhen: clean(raw!.retryWhen) };
  for (const [key, value] of Object.entries(out)) for (const item of Array.isArray(value) ? value : [value]) {
    if (item.length > FAIL_FIELD_MAX) refuse(`a fail note's ${key} is over ${FAIL_FIELD_MAX} characters`);
    if (item.includes("\0")) refuse(`a fail note's ${key} holds a NUL byte`);
  }
  return out;
}

/** Build the note a command would write, without writing it (the preview and the write share this). */
export function buildNote(input: NoteAddInput, project: string): NoteInput {
  if (!(KINDS as readonly string[]).includes(input.kind)) refuse(`--kind takes ${KINDS.join(", ")}`);
  if (input.tier !== "short" && input.tier !== "long") refuse("--tier takes short or long");
  if (input.scope !== "project" && input.scope !== "shared") refuse("--scope takes project or shared");
  const title = input.title === undefined ? undefined : clean(input.title);
  if (title !== undefined && (!title || title.length > NOTE_TITLE_MAX || title.includes("\0") || LINE_BREAKS.test(title))) refuse(`--title must be one line of 1 to ${NOTE_TITLE_MAX} characters`);
  let text: string;
  if (input.kind === "fail") {
    // The structured fields ARE the body. A free text is refused with them so there is one answer to "what does this fail note say".
    if (clean(input.text)) refuse("a fail note takes --approach, --symptom, --cause, --evidence and --retry-when, not free text");
    text = failBody(failFields(input.fail));
  } else {
    if (input.fail && Object.values(input.fail).some(value => (Array.isArray(value) ? value.length : clean(value as string | undefined)))) refuse("--approach, --symptom, --cause, --evidence and --retry-when belong to --kind fail");
    text = clean(input.text);
    if (!text) refuse("a note needs text: pass it as an argument, `-` for stdin, or run in a terminal to use $EDITOR");
    if (text.includes("\0")) refuse("the note text holds a NUL byte");
  }
  if (text.length > NOTE_MAX_CHARS) refuse(`the note is ${text.length} characters; the limit is ${NOTE_MAX_CHARS}`);
  return { op: "note", project, scope: input.scope, tier: input.tier, kind: input.kind, peer: "person", source: "person", ...(title ? { title } : {}), text, about: [] };
}

/**
 * Write one note. The configured policy screens the whole note (title and text) first and a decline names no text; a long-term note the policy declines would not
 * sync, so it is refused here instead of silently staying local. Nothing is written when anything fails.
 */
export function noteAdd(store: MemoryStore, project: string, input: NoteAddInput, policy: StandalonePolicy): NoteAddResult {
  const note = buildNote(input, project);
  if (!policy.screenStandalone({ ...(note.title ? { title: note.title } : {}), text: note.text, about: note.about })   /* no undefined field: the screen refuses one */) refuse("the note is refused by the configured privacy policy (secrets, personal data, deny paths and the patterns in amem.config.json); edit it or the policy and try again");
  return { id: store.note(note, input.tier === "short") };
}

/** What `$EDITOR` opens for a `fail` note given no field flags: five labelled lines the person fills in. */
export const FAIL_TEMPLATE = "Approach: \nSymptom: \nCause: \nEvidence: \nRetry when: \n";
const LABELS = [["approach", "Approach"], ["symptom", "Symptom"], ["cause", "Cause"], ["evidence", "Evidence"], ["retryWhen", "Retry when"]] as const;
/** Whether any line of `text` starts with one of the five labels (case-insensitive). Text that already carries a label is the person's own structure, so it opens as written. */
export function hasFailLabel(text: string): boolean {
  return text.replace(/\r\n?|\u0085|\u2028|\u2029|\v|\f/g, "\n").split("\n").some(line => LABELS.some(([, label]) => line.toLowerCase().startsWith(`${label.toLowerCase()}:`)));
}
/** Read the labelled template back. A label's value runs to the next label (so it may span lines); evidence splits on commas and newlines. */
export function parseFailTemplate(raw: string): Partial<FailFields> {
  const out: Record<string, string> = {};
  let current: string | undefined;
  for (const line of raw.replace(/\r\n?|\u0085|\u2028|\u2029|\v|\f/g, "\n").split("\n")) {
    const hit = LABELS.find(([, label]) => line.toLowerCase().startsWith(`${label.toLowerCase()}:`));
    if (hit) {
      // A label given twice would silently keep only the last: refuse it, so no text the person typed is dropped without a word.
      if (hit[0] in out) throw new Error(`the template repeats the "${hit[1]}:" label; each of the five labels takes one entry`);
      current = hit[0]; out[current] = line.slice(hit[1].length + 1).trim();
    }
    else if (current) out[current] = `${out[current]}\n${line}`;
  }
  // Trim first, then test: a blank template line is "" after the trim, never a truthy "\n".
  const value = (key: string) => (out[key] ?? "").trim();
  const evidence = value("evidence").split(/[,\n]/).map(item => item.trim()).filter(Boolean);
  return { ...(value("approach") ? { approach: value("approach") } : {}), ...(value("symptom") ? { symptom: value("symptom") } : {}), ...(value("cause") ? { cause: value("cause") } : {}),
    ...(evidence.length ? { evidence } : {}), ...(value("retryWhen") ? { retryWhen: value("retryWhen") } : {}) };
}
