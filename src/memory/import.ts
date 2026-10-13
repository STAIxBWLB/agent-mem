import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KINDS, looksSecret, type Kind, type MemoryStore } from "./store.ts";

/** The claude-mem store is another program's: opened read-only, never written, its locks waited on briefly. */
export const CLAUDE_MEM_BUSY_TIMEOUT_MS = 3000;
/** Titles `ahub ask --remember` gives a model's answer (ask.ts ASK_NOTE_TITLE): never imported as a finding. */
const MODEL_ANSWER = "ahub ask (model answer)";

export interface ImportResult { read: number; added: number; skipped: { model: number; pii: number; secret: number; project: number } }

/**
 * #258 phase 3: copy the hub's own notes from claude-mem (observations whose metadata names a `peer`: `hub_remember`
 * and the hub's task notes) into long-term hub memory as `source: claude-mem` under the hub memory key `project`, for
 * the projects in `chain` (claude-mem files them under the repository's basename). Model answers, PII-pattern text and secret-looking text are skipped.
 * Idempotent: an observation always maps to the same entry.
 */
export function importClaudeMem(store: MemoryStore, opts: { project: string; chain: string[]; isPii: (text: string) => boolean; nodes?: (text: string) => string[]; db?: string; limit?: number }): ImportResult {
  const file = opts.db ?? join(homedir(), ".claude-mem", "claude-mem.db");
  if (!existsSync(file)) throw new Error(`no claude-mem store at ${file}`);
  const db = new Database(file, { readonly: true });
  db.run(`PRAGMA busy_timeout = ${CLAUDE_MEM_BUSY_TIMEOUT_MS}`);
  const result: ImportResult = { read: 0, added: 0, skipped: { model: 0, pii: 0, secret: 0, project: 0 } };
  try {
    const rows = db.query("SELECT id, project, title, text, narrative, created_at_epoch, metadata FROM observations WHERE metadata LIKE '%\"peer\"%' ORDER BY id LIMIT ?")
      .all(opts.limit ?? 10_000) as { id: number; project: string | null; title: string | null; text: string | null; narrative: string | null; created_at_epoch: number | null; metadata: string | null }[];
    // The hub files its claude-mem notes under the repository's own name (the chain's last); the names above it are other
    // projects (a superproject) whose notes and privacy policy are not this one's. ponytail: claude-mem keys projects by
    // basename, so two unrelated repositories with one name still share it.
    const project = opts.project, names = new Set(opts.chain.slice(-1));
    for (const r of rows) {
      result.read++;
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(r.metadata ?? "{}"); } catch { continue; }
      if (typeof meta.peer !== "string" || !meta.peer) continue;
      if (!r.project || !names.has(r.project)) { result.skipped.project++; continue; }
      const title = r.title ?? "", text = (r.text ?? r.narrative ?? "").trim();
      if (!text) continue;
      if (meta.source === "ahub ask" || title.startsWith(MODEL_ANSWER)) { result.skipped.model++; continue; }
      if (opts.isPii(`${title}\n${text}`)) { result.skipped.pii++; continue; }
      if (looksSecret(`${title}\n${text}`)) { result.skipped.secret++; continue; }
      const kind: Kind = KINDS.includes(meta.kind as Kind) ? meta.kind as Kind : "finding";
      const at = new Date(r.created_at_epoch ?? 0).toISOString();
      const { added } = store.importNote({ op: "note", project, scope: "project", tier: "long", kind, peer: meta.peer.slice(0, 32), ...(title ? { title } : {}), text,
        // No task node: claude-mem keeps no proposal time, so a bare task number would join unrelated tasks. The text's
        // own paths and symbols place the note in the graph.
        about: opts.nodes?.(`${title}\n${text}`) ?? [], source: "claude-mem" }, at);
      if (added) result.added++;
    }
  } finally { db.close(); }
  store.refresh();
  return result;
}
