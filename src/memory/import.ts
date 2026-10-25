import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { realPath } from "./platform.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { KINDS, looksSecret, type Kind, type MemoryStore } from "./store.ts";
import { aliasedKeys, resolveAlias } from "./shard.ts";
import { WorkListStore, type WorkListFields, type WorkListPolicy } from "./work-lists.ts";
import { CaptureStore, type CaptureInput } from "./capture.ts";
import { CAPTURE_MAX_EXCERPT } from "./capture-input.ts";
import { configuredPolicyOptions } from "./config.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "./policy.ts";
import { stripPrivateSpans } from "./private-spans.ts";

/** The claude-mem store is another program's: opened read-only, never written, its locks waited on briefly. */
export const CLAUDE_MEM_BUSY_TIMEOUT_MS = 3000;
/** Titles `ahub ask --remember` gives a model's answer (ask.ts ASK_NOTE_TITLE): never imported as a finding. */
const MODEL_ANSWER = "ahub ask (model answer)";

export interface ImportResult { read: number; added: number; skipped: { model: number; pii: number; secret: number }; more: boolean; cursor: number }
export interface WorkStateImportResult { read: number; added: number; skipped: { invalid: number; policy: number }; more: boolean; cursor: number }
export interface CaptureImportResult { read: number; added: number; spooled: number; skipped: number; more: boolean }

type ClaudeMemCaptureRow = { id: number; created_at_epoch: number; origin_device_id: string | null; origin_local_id: string | null } & Record<string, any>;
const CLAUDE_MEM_CAPTURE_KINDS = [
  { table: "observations", event: "observation", columns: "id, title, text, narrative, created_at_epoch" },
  { table: "session_summaries", event: "summary", columns: "id, request, investigated, learned, completed, next_steps, notes, created_at_epoch" },
] as const;
type ClaudeMemCaptureKind = typeof CLAUDE_MEM_CAPTURE_KINDS[number];
interface ClaudeMemCaptureContext {
  db: Database; store: CaptureStore; policy: ReturnType<typeof createStandalonePolicy>;
  aliases: string[]; project: string; sourceMachine: string; cutoff: number; limit: number;
}

function claudeMemCaptureText(row: ClaudeMemCaptureRow, kind: ClaudeMemCaptureKind): string {
  if (kind.table === "observations") return stripPrivateSpans([row.title, row.text ?? row.narrative].filter(value => typeof value === "string" && value.trim()).join("\n")).trim();
  const fields = [["Request", row.request], ["Investigated", row.investigated], ["Learned", row.learned], ["Completed", row.completed], ["Next steps", row.next_steps], ["Notes", row.notes]];
  return stripPrivateSpans(fields.filter(([, value]) => typeof value === "string" && value.trim()).map(([label, value]) => `${label}: ${value}`).join("\n")).trim();
}

async function appendClaudeMemCapture(row: ClaudeMemCaptureRow, kind: ClaudeMemCaptureKind, context: ClaudeMemCaptureContext): Promise<"added" | "spooled" | "skipped"> {
  const text = claudeMemCaptureText(row, kind);
  if (!text || !Number.isFinite(row.created_at_epoch)) return "skipped";
  let at: string;
  try { at = new Date(row.created_at_epoch).toISOString(); } catch { return "skipped"; }
  const input: CaptureInput = { project: context.project, agent: "claude-mem", event: kind.event, excerpt: text, at };
  if (!await context.policy.screen(input)) return "skipped";
  input.excerpt = text.slice(0, CAPTURE_MAX_EXCERPT);
  const synced = typeof row.origin_device_id === "string" && !!row.origin_device_id && typeof row.origin_local_id === "string" && !!row.origin_local_id;
  const receipt = createHash("sha256").update(JSON.stringify(["claude-mem", kind.table, synced ? row.origin_device_id : context.sourceMachine, synced ? row.origin_local_id : String(row.id)])).digest("hex");
  const appended = context.store.append(input, { receipt });
  return "spooled" in appended ? "spooled" : appended.already ? "skipped" : "added";
}

async function importClaudeMemCaptureTable(kind: ClaudeMemCaptureKind, context: ClaudeMemCaptureContext, initial: number, onCursor: (cursor: number) => void): Promise<CaptureImportResult> {
  const result: CaptureImportResult = { read: 0, added: 0, spooled: 0, skipped: 0, more: false };
  const columns = new Set((context.db.query(`PRAGMA table_info(${kind.table})`).all() as { name: string }[]).map(row => row.name));
  const origin = columns.has("origin_device_id") && columns.has("origin_local_id"), where = `project IN (${context.aliases.map(() => "?").join(",")})`;
  const max = context.db.query(`SELECT MAX(id) AS id FROM ${kind.table} WHERE ${where}`).get(...context.aliases) as { id: number | null };
  let cursor = (max.id ?? 0) < initial ? 0 : initial; onCursor(cursor);
  const rows = context.db.query(`SELECT ${kind.columns}${origin ? ", origin_device_id, origin_local_id" : ", NULL AS origin_device_id, NULL AS origin_local_id"} FROM ${kind.table} WHERE ${where} AND created_at_epoch >= ? AND id > ? ORDER BY id LIMIT ?`)
    .all(...context.aliases, context.cutoff, cursor, context.limit) as ClaudeMemCaptureRow[];
  result.read = rows.length; result.more = rows.length === context.limit;
  for (const row of rows) {
    result[await appendClaudeMemCapture(row, kind, context)]++;
    cursor = row.id; onCursor(cursor);
  }
  return result;
}

/** Import only reviewed aliases into machine-local capture. ponytail: --limit is per source table; a merged cursor could add one combined ceiling. */
export async function importClaudeMemCapture(opts: { base: string; project: string; cwd: string; days: number; db?: string; limit?: number; restart?: boolean; now?: number; policy?: StandalonePolicyOptions; log?: (line: string) => void }): Promise<CaptureImportResult> {
  const file = opts.db ?? join(homedir(), ".claude-mem", "claude-mem.db"), limit = opts.limit ?? 10_000;
  if (!existsSync(file)) throw new Error(`no claude-mem store at ${file}`);
  if (!Number.isSafeInteger(opts.days) || opts.days <= 0) throw new Error("--capture-days takes a positive integer");
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("--limit takes a positive integer");
  const now = opts.now ?? Date.now(); if (!Number.isFinite(now)) throw new Error("capture import clock unavailable");
  const project = resolveAlias(opts.base, opts.project), aliases = aliasedKeys(opts.base, project);
  const result: CaptureImportResult = { read: 0, added: 0, spooled: 0, skipped: 0, more: false };
  if (!aliases.length) return result;
  const db = new Database(file, { readonly: true });
  let store: CaptureStore | undefined, state: string | undefined;
  const progress = new Map<string, number>();
  try {
    db.run(`PRAGMA busy_timeout = ${CLAUDE_MEM_BUSY_TIMEOUT_MS}`);
    const available = CLAUDE_MEM_CAPTURE_KINDS.filter(kind => db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(kind.table));
    if (!available.length) return result;
    store = new CaptureStore({ memoryDir: opts.base, project, cwd: opts.cwd, now: () => now });
    state = join(store.dir, "import-state.json");
    const context: ClaudeMemCaptureContext = { db, store, aliases, project, limit,
      sourceMachine: createHash("sha256").update(realPath(file)).digest("hex"), cutoff: Math.max(0, now - opts.days * 86_400_000),
      policy: createStandalonePolicy(configuredPolicyOptions(opts.base, opts.cwd, opts.policy)) };
    const cursors = readCursors(state);
    for (const kind of available) {
      const key = createHash("sha256").update(JSON.stringify([context.sourceMachine, aliases, project, kind.table])).digest("hex");
      progress.set(key, opts.restart ? 0 : cursors[key] ?? 0);
      const imported = await importClaudeMemCaptureTable(kind, context, progress.get(key)!, cursor => progress.set(key, cursor));
      for (const field of ["read", "added", "spooled", "skipped"] as const) result[field] += imported[field];
      result.more ||= imported.more;
    }
  } finally {
    db.close();
    if (state) for (const [key, cursor] of progress) writeCursor(state, key, cursor, opts.log ?? console.error);
    store?.close();
  }
  return result;
}

/**
 * Import only the source project names explicitly mapped by the person's D2 alias table. A basename or even
 * an exact canonical-key match is not permission to adopt another program's project. Source receipts preserve
 * synced device/id identity across database copies; unsynced rows are scoped to the source's real path.
 */
export async function importClaudeMemWorkState(opts: { base: string; project: string; policy: WorkListPolicy; db?: string; limit?: number; restart?: boolean; log?: (line: string) => void }): Promise<WorkStateImportResult> {
  const file = opts.db ?? join(homedir(), ".claude-mem", "claude-mem.db");
  if (!existsSync(file)) throw new Error(`no claude-mem store at ${file}`);
  const limit = opts.limit ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("--limit takes a positive integer");
  const project = resolveAlias(opts.base, opts.project);
  const aliases = aliasedKeys(opts.base, project);
  const result: WorkStateImportResult = { read: 0, added: 0, skipped: { invalid: 0, policy: 0 }, more: false, cursor: 0 };
  if (!aliases.length) return result;
  const db = new Database(file, { readonly: true });
  let store: WorkListStore | undefined;
  let state: string | undefined, key = "", cursor = 0;
  try {
    db.run(`PRAGMA busy_timeout = ${CLAUDE_MEM_BUSY_TIMEOUT_MS}`);
    if (!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_state_entries'").get()) return result;
    const columns = new Set((db.query("PRAGMA table_info(work_state_entries)").all() as { name: string }[]).map(row => row.name));
    const origin = columns.has("origin_device_id") && columns.has("origin_local_id");
    const sourceMachine = createHash("sha256").update(realPath(file)).digest("hex");
    store = new WorkListStore({ base: opts.base, project, policy: opts.policy });
    state = join(store.dir, "import-state.json");
    key = createHash("sha256").update(JSON.stringify([sourceMachine, aliases, project])).digest("hex");
    cursor = opts.restart ? 0 : readCursors(state)[key] ?? 0;
    const where = `project IN (${aliases.map(() => "?").join(",")})`;
    const max = db.query(`SELECT MAX(id) AS id FROM work_state_entries WHERE ${where}`).get(...aliases) as { id: number | null };
    if ((max.id ?? 0) < cursor) cursor = 0;
    const rows = db.query(`SELECT id, list_name, fields, created_at_epoch${origin ? ", origin_device_id, origin_local_id" : ", NULL AS origin_device_id, NULL AS origin_local_id"} FROM work_state_entries WHERE ${where} AND id > ? ORDER BY id LIMIT ?`)
      .all(...aliases, cursor, limit) as { id: number; list_name: string; fields: string; created_at_epoch: number; origin_device_id: string | null; origin_local_id: string | null }[];
    result.read = rows.length; result.more = rows.length === limit;
    for (const row of rows) {
      try {
        let fields: WorkListFields;
        try { fields = JSON.parse(row.fields) as WorkListFields; } catch { result.skipped.invalid++; cursor = row.id; continue; }
        const synced = typeof row.origin_device_id === "string" && !!row.origin_device_id && typeof row.origin_local_id === "string" && !!row.origin_local_id;
        const written = await store.write(row.list_name, fields, { source: "claude-mem/work_state", id: synced ? row.origin_local_id! : String(row.id), machine: synced ? row.origin_device_id! : sourceMachine, at: row.created_at_epoch });
        if (!written.already) result.added++;
      } catch (error) {
        if (error instanceof Error && error.message === "invalid work-list input") result.skipped.invalid++;
        else if (error instanceof Error && error.message === "work-list privacy policy refused the write") result.skipped.policy++;
        else throw error; // Do not advance a receipt conflict or a failed append.
      }
      cursor = row.id;
    }
  } finally {
    db.close();
    result.cursor = cursor;
    if (state) writeCursor(state, key, cursor, opts.log ?? console.error);
    store?.close();
  }
  return result;
}

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
