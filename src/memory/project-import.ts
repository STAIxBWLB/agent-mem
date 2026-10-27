import { createHash } from "node:crypto";
import { constants, createReadStream, fstatSync, openSync } from "node:fs";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { legacyEntries } from "./bridge.ts";
import { stripPrivateDeep, stripPrivateSpans } from "./private-spans.ts";
import { EXPORT_SCHEMA } from "./project-export.ts";
import { aliasedKeys } from "./shard.ts";
import { looksSecret, type MemoryStore, type NoteInput } from "./store.ts";

export const PROJECT_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const PROJECT_IMPORT_MAX_LINE_BYTES = 64 * 1024;
export const PROJECT_IMPORT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const NOTE_KEYS = new Set(["schema", "id", "at", "machine", "op", "project", "scope", "tier", "kind", "peer", "title", "text", "task", "about", "supersedes", "promotedFrom", "source", "expires"]);
const OPERATIONS_WARNING = "Supersede, demote, settle and forget operations are not exported; re-import restores authored note rows only.";

type ImportedNote = { id: string; at: string; machine: string; note: NoteInput };
type Provenance = { source: Record<string, number>; peer: Record<string, number>; scope: Record<string, number>; machine: Record<string, number> };
export interface ProjectImportResult {
  applied: boolean;
  project: string;
  read: number;
  added: number;
  wouldAdd: number;
  skipped: { invalid: number; policy: number; other: number };
  provenance: Provenance;
  warnings: string[];
}

function importedNote(value: unknown, projects: readonly string[]): ImportedNote | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).every(key => NOTE_KEYS.has(key))) return undefined;
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const [row] = legacyEntries([{ source: "legacy-local", path: "log/project-import.jsonl", bytes, offset: bytes.length,
      hash: createHash("sha256").update(bytes).digest("hex"), local: false, tailBytes: 0 }], { strict: true });
    if (row?.op !== "note" || !projects.includes(row.project)) return undefined;
    const { id, at, machine, ...rest } = row;
    const note = Object.fromEntries(Object.entries(rest).filter(([key]) => key !== "schema")) as NoteInput;
    return { id, at, machine, note };
  } catch { return undefined; }
}

function increment(counts: Map<string, number>, value: string | undefined): void {
  const key = value ?? "unspecified";
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function provenance(notes: Iterable<ImportedNote>): Provenance {
  const source = new Map<string, number>(), peer = new Map<string, number>(), scope = new Map<string, number>(), machine = new Map<string, number>();
  for (const { note, machine: origin } of notes) {
    increment(source, note.source);
    increment(peer, note.peer);
    increment(scope, note.scope);
    increment(machine, origin);
  }
  return { source: Object.fromEntries(source), peer: Object.fromEntries(peer), scope: Object.fromEntries(scope), machine: Object.fromEntries(machine) };
}

function relationTargets(imported: ImportedNote): string[] {
  return [imported.note.supersedes, imported.note.promotedFrom].filter((target): target is string => typeof target === "string");
}

function unchangedAfterNormalization(note: NoteInput): boolean {
  return stripPrivateSpans(note.text).slice(0, 4000) === note.text
    && (typeof note.title !== "string" || stripPrivateSpans(note.title).slice(0, 200) === note.title);
}

/** Preview by default; confirm applies only after every row, relationship, identity and policy decision has passed without a curated write. */
export async function importProject(store: MemoryStore, opts: {
  from: string;
  project: string;
  confirm?: boolean;
  allowShared?: boolean;
  policy: (note: NoteInput) => boolean | Promise<boolean>;
}): Promise<ProjectImportResult> {
  const fd = openSync(opts.from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stream = createReadStream(opts.from, { fd, encoding: "utf8" });
  const result: ProjectImportResult = { applied: opts.confirm === true, project: opts.project, read: 0, added: 0, wouldAdd: 0,
    skipped: { invalid: 0, policy: 0, other: 0 }, provenance: { source: {}, peer: {}, scope: {}, machine: {} }, warnings: [OPERATIONS_WARNING] };
  let header = false, bytes = 0;
  let aliases: string[] = [];
  const pending = new Map<string, ImportedNote>(), accepted = new Map<string, ImportedNote>();
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > PROJECT_IMPORT_MAX_BYTES) throw new Error("project import needs a regular JSONL file of at most 64 MiB");
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        bytes += Buffer.byteLength(line, "utf8") + 1;
        if (bytes > PROJECT_IMPORT_MAX_BYTES) throw new Error("project import exceeded 64 MiB while reading");
        if (Buffer.byteLength(line, "utf8") > PROJECT_IMPORT_MAX_LINE_BYTES) { result.skipped.invalid++; continue; }
        if (!line.trim()) continue;
        let row: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          row = parsed as Record<string, unknown>;
        } catch { result.skipped.invalid++; continue; }
        if (row.schema !== EXPORT_SCHEMA || row.project !== opts.project) throw new Error("project import schema or project mismatch");
        if (row.type === "header") {
          if (header) throw new Error("project import has more than one header");
          if (!Array.isArray(row.aliases) || !row.aliases.every(alias => typeof alias === "string")) throw new Error("project import aliases are invalid");
          aliases = [...row.aliases] as string[];
          const available = aliasedKeys(store.profile.home, opts.project);
          if (aliases.some(alias => !available.includes(alias))) throw new Error("project import requires the exported aliases in the target home");
          header = true; continue;
        }
        if (!header) throw new Error("project import needs its header first");
        if (row.type === "counts") continue;
        if (row.type !== "curated") { result.skipped.other++; continue; }
        result.read++;
        const imported = importedNote(row.value, [opts.project, ...aliases]);
        if (!imported || Date.parse(imported.at) > store.readNow() + PROJECT_IMPORT_FUTURE_SKEW_MS
          || imported.note.scope === "shared" && opts.allowShared !== true || !unchangedAfterNormalization(imported.note)) {
          result.skipped.invalid++;
          continue;
        }
        const prior = pending.get(imported.id);
        if (prior) {
          if (!isDeepStrictEqual(prior, imported)) throw new Error("project import has conflicting rows for one entry id");
          continue;
        }
        pending.set(imported.id, imported);
      }
    } finally { lines.close(); }
    if (!header) throw new Error("project import has no header");

    for (const imported of pending.values()) {
      if (relationTargets(imported).some(target => !pending.has(target))) {
        result.skipped.invalid++;
        continue;
      }
      const screened = stripPrivateDeep(imported.note);
      if (looksSecret(JSON.stringify(screened)) || !await opts.policy(screened)) { result.skipped.policy++; continue; }
      accepted.set(imported.id, imported);
    }
    // A policy-refused target cannot authorize its dependents. Propagate removals before any append,
    // regardless of file order, in linear time even when a long relation chain is refused.
    const dependents = new Map<string, string[]>(), refused: string[] = [];
    for (const imported of accepted.values()) for (const target of relationTargets(imported)) {
      const rows = dependents.get(target) ?? [];
      rows.push(imported.id); dependents.set(target, rows);
      if (!accepted.has(target)) refused.push(imported.id);
    }
    for (let at = 0; at < refused.length; at++) {
      const id = refused[at]!;
      if (!accepted.delete(id)) continue;
      result.skipped.invalid++;
      for (const dependent of dependents.get(id) ?? []) refused.push(dependent);
    }
    result.provenance = provenance(accepted.values());
    const existing = new Set(store.portableNotes(opts.project).map(note => note.id));
    result.wouldAdd = [...accepted.keys()].filter(id => !existing.has(id)).length;
    if (opts.confirm === true) {
      store.assertImportable([...accepted.values()].map(imported => imported.note));
      for (const imported of accepted.values()) {
        const written = store.importNote(imported.note, imported.at, { machine: imported.machine, expectedId: imported.id });
        if (written.added) result.added++;
      }
      store.refresh();
    }
    return result;
  } finally { stream.destroy(); }
}
