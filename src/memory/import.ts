import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { realPath } from "../hub/project.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { KINDS, looksSecret, type Kind, type MemoryStore } from "./store.ts";

/** The claude-mem store is another program's: opened read-only, never written, its locks waited on briefly. */
export const CLAUDE_MEM_BUSY_TIMEOUT_MS = 3000;
/** Titles `ahub ask --remember` gives a model's answer (ask.ts ASK_NOTE_TITLE): never imported as a finding. */
const MODEL_ANSWER = "ahub ask (model answer)";

export interface ImportResult { read: number; added: number; skipped: { model: number; pii: number; secret: number }; more: boolean; cursor: number }

/** Machine-local progress is disposable; malformed/unreadable state simply replays the idempotent import. */
function readCursors(file: string): Record<string, number> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, id]) => Number.isSafeInteger(id) && id >= 0));
  } catch { return {}; }
}
function writeCursor(file: string, key: string, cursor: number, log: (line: string) => void): void {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ ...readCursors(file), [key]: cursor }) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch { log("claude-mem import progress could not be saved; the next run may replay handled rows"); }
  finally { try { rmSync(temp, { force: true }); } catch { /* disposable progress */ } }
}

/**
 * #258 phase 3: copy the hub's own notes from claude-mem (observations whose metadata names a `peer`: `hub_remember`
 * and the hub's task notes) into long-term hub memory as `source: claude-mem` under the hub memory key `project`, for
 * the projects in `chain` (claude-mem files them under the repository's basename). Model answers, PII-pattern text and secret-looking text are skipped.
 * Idempotent: an observation always maps to the same entry.
 */
export function importClaudeMem(store: MemoryStore, opts: { project: string; chain: string[]; isPii: (text: string) => boolean; nodes?: (text: string) => string[]; db?: string; limit?: number; restart?: boolean; log?: (line: string) => void }): ImportResult {
  const file = opts.db ?? join(homedir(), ".claude-mem", "claude-mem.db");
  if (!existsSync(file)) throw new Error(`no claude-mem store at ${file}`);
  const limit = opts.limit ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("--limit takes a positive integer");
  const state = join(store.dir, "import-state.json");
  const name = opts.chain.at(-1) ?? "";
  const key = createHash("sha256").update(JSON.stringify([realPath(file), name, opts.project])).digest("hex");
  let cursor = opts.restart ? 0 : readCursors(state)[key] ?? 0;
  const db = new Database(file, { readonly: true });
  db.run(`PRAGMA busy_timeout = ${CLAUDE_MEM_BUSY_TIMEOUT_MS}`);
  const result: ImportResult = { read: 0, added: 0, skipped: { model: 0, pii: 0, secret: 0 }, more: false, cursor };
  try {
    const max = db.query("SELECT MAX(id) AS id FROM observations WHERE project = ? AND metadata LIKE '%\"peer\"%'").get(name) as { id: number | null };
    if ((max.id ?? 0) < cursor) cursor = 0;
    const rows = db.query("SELECT id, project, title, text, narrative, created_at_epoch, metadata FROM observations WHERE project = ? AND id > ? AND metadata LIKE '%\"peer\"%' ORDER BY id LIMIT ?")
      .all(name, cursor, limit) as { id: number; project: string | null; title: string | null; text: string | null; narrative: string | null; created_at_epoch: number | null; metadata: string | null }[];
    // The hub files its claude-mem notes under the repository's own name (the chain's last); the names above it are other
    // projects (a superproject) whose notes and privacy policy are not this one's. ponytail: claude-mem keys projects by
    // basename, so two unrelated repositories with one name still share it.
    const project = opts.project;
    result.read = rows.length;
    result.more = rows.length === limit;
    const handle = (r: typeof rows[number]) => {
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(r.metadata ?? "{}"); } catch { return; }
      if (!meta || typeof meta !== "object" || typeof meta.peer !== "string" || !meta.peer) return;
      const title = r.title ?? "", text = (r.text ?? r.narrative ?? "").trim();
      if (!text) return;
      if (meta.source === "ahub ask" || title.startsWith(MODEL_ANSWER)) { result.skipped.model++; return; }
      if (opts.isPii(`${title}\n${text}`)) { result.skipped.pii++; return; }
      if (looksSecret(`${title}\n${text}`)) { result.skipped.secret++; return; }
      const kind: Kind = KINDS.includes(meta.kind as Kind) ? meta.kind as Kind : "finding";
      const at = new Date(r.created_at_epoch ?? 0).toISOString();
      const { added } = store.importNote({ op: "note", project, scope: "project", tier: "long", kind, peer: meta.peer.slice(0, 32), ...(title ? { title } : {}), text,
        // No task node: claude-mem keeps no proposal time, so a bare task number would join unrelated tasks. The text's
        // own paths and symbols place the note in the graph.
        about: opts.nodes?.(`${title}\n${text}`) ?? [], source: "claude-mem" }, at);
      if (added) result.added++;
    };
    for (const row of rows) {
      handle(row);
      cursor = row.id; // only fully handled rows, including every skip
    }
  } finally {
    db.close();
    result.cursor = cursor;
    writeCursor(state, key, cursor, opts.log ?? console.error);
  }
  store.refresh();
  return result;
}
