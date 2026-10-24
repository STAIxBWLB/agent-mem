import { createHash } from "node:crypto";
import { constants, createReadStream, fstatSync, openSync } from "node:fs";
import { createInterface } from "node:readline";
import { legacyEntries } from "./bridge.ts";
import { EXPORT_SCHEMA } from "./project-export.ts";
import { aliasedKeys } from "./shard.ts";
import { looksSecret, type MemoryStore, type NoteInput } from "./store.ts";

export const PROJECT_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const PROJECT_IMPORT_MAX_LINE_BYTES = 64 * 1024;
export interface ProjectImportResult {
  project: string;
  read: number;
  added: number;
  skipped: { invalid: number; policy: number; other: number };
}

function importedNote(value: unknown, projects: readonly string[]): { id: string; at: string; machine: string; note: NoteInput } | undefined {
  try {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const [row] = legacyEntries([{ source: "legacy-local", path: "log/project-import.jsonl", bytes, offset: bytes.length,
      hash: createHash("sha256").update(bytes).digest("hex"), local: false, tailBytes: 0 }], { strict: true });
    if (row?.op !== "note" || !projects.includes(row.project)) return undefined;
    const { id, at, machine, ...rest } = row;
    const note = Object.fromEntries(Object.entries(rest).filter(([key]) => key !== "schema")) as NoteInput;
    return { id, at, machine, note };
  } catch { return undefined; }
}

/** Re-import only curated notes from the streaming JSONL export. Capture, goals and work lists remain export-only in this format. */
export async function importProject(store: MemoryStore, opts: { from: string; project: string; policy: (note: NoteInput) => boolean | Promise<boolean> }): Promise<ProjectImportResult> {
  const fd = openSync(opts.from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stream = createReadStream(opts.from, { fd, encoding: "utf8" });
  const result: ProjectImportResult = { project: opts.project, read: 0, added: 0, skipped: { invalid: 0, policy: 0, other: 0 } };
  let header = false, bytes = 0;
  let aliases: string[] = [];
  const seen = new Set<string>();
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
        if (!imported) { result.skipped.invalid++; continue; }
        if (seen.has(imported.id)) continue;
        if (looksSecret(JSON.stringify(imported.note)) || !await opts.policy(imported.note)) { result.skipped.policy++; continue; }
        const written = store.importNote(imported.note, imported.at, { machine: imported.machine });
        if (written.id !== imported.id) throw new Error("project import entry identity changed");
        seen.add(imported.id);
        if (written.added) result.added++;
      }
    } finally { lines.close(); }
    if (!header) throw new Error("project import has no header");
    store.refresh();
    return result;
  } finally { stream.destroy(); }
}
