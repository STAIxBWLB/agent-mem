import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * F7 (agent-mem#40): pending-review visibility. This leaf imports only `bun:sqlite` and node built-ins, so the SessionStart hook can read it without loading the
 * candidate store (no create, no prune, no schema change on that path).
 *
 * AC4, "no candidate expires without having been shown": a candidate's age expiry (30 days from creation) only deletes it once it was SHOWN, and not before a grace period after
 * it was first shown, or once the person decided it (accepted or rejected). Only `amem review walk` stamps `shown_at`, after it has written the candidate to the terminal. The
 * brief line and `amem review list` print no candidate content, and the SessionStart hook cannot know the context was read, so none of them stamps: the brief line informs, it does
 * not count as showing. An unshown pending candidate stays however old it is. The 500-per-project count cap keeps unshown pending rows first, then shown pending rows (owed their
 * grace), then decided ones, so it only reaches an unshown candidate when 500 of them wait.
 */
export const CANDIDATE_AGE_MS = 30 * 86400_000;
/** After a candidate is first shown it stays at least this long, so the person has a real chance to act on what the brief said. */
export const CANDIDATE_SHOWN_GRACE_MS = 7 * 86400_000;
/** A candidate this close to expiry is flagged in `amem status`. */
export const CANDIDATE_DUE_MS = 7 * 86400_000;
const DAY_MS = 86400_000;

export interface PendingSummary {
  /** Candidates waiting for the person (status pending or an interrupted accepting). */
  count: number;
  /** Whole days until the soonest of them can expire, counting an unshown one as shown now (so at least the grace period). 0 when it may go today. Null with nothing pending. */
  oldestExpiresInDays: number | null;
  /** How many are within CANDIDATE_DUE_MS of their 30-day age expiry (an unshown one is protected beyond it, shown or not it is flagged so the person acts). */
  dueWithin7Days: number;
  /** How many were never shown. */
  unshown: number;
}
export const EMPTY_PENDING: PendingSummary = { count: 0, oldestExpiresInDays: null, dueWithin7Days: 0, unshown: 0 };

/**
 * Open the sidecar read-only. A WAL database whose `-wal` and `-shm` files are gone (a truncating checkpoint, a copy) cannot be opened read-only, so the fallback is an immutable
 * open: it writes nothing and creates nothing, at the price of not seeing a write another process has not checkpointed yet, which a count line can live with. Undefined when
 * neither opens (a missing or unreadable file).
 */
function openReadOnly(file: string): Database | undefined {
  // A construction that succeeds can still fail at its first read (no -wal or -shm to attach to), so each form is proven with a real query before it is returned.
  const forms: (() => Database)[] = [
    () => new Database(file, { readonly: true }),
    () => new Database(`file:${encodeURI(file).replace(/\?/g, "%3F").replace(/#/g, "%23")}?immutable=1`, { readonly: true } as ConstructorParameters<typeof Database>[1]),
  ];
  for (const open of forms) {
    let db: Database | undefined;
    try { db = open(); db.query("SELECT 1 FROM sqlite_master LIMIT 1").get(); return db; }
    catch { try { db?.close(); } catch { /* nothing to close */ } }
  }
  return undefined;
}

/** The first-shown column, added in place: an old database gets it when a `CandidateStore` opens, a reader treats its absence as "never shown". */
export function hasShownColumn(db: Database): boolean {
  return (db.query("PRAGMA table_info(candidates)").all() as { name: string }[]).some(column => column.name === "shown_at");
}

/** The instant a pending candidate becomes deletable: the later of its age expiry and the end of its grace period (counted from `now` while it is unshown). */
export function expiresAt(createdAt: number, shownAt: number | null, now: number): number {
  return Math.max(createdAt + CANDIDATE_AGE_MS, (shownAt ?? now) + CANDIDATE_SHOWN_GRACE_MS);
}

/**
 * Read-only summary of the pending candidates of one project (with its aliases), or of every project when `projects` is undefined. Never throws. No file means nothing is
 * pending (`EMPTY_PENDING`); a file that exists but cannot be read gives `null`, so `amem status` can say "unavailable" instead of a false zero.
 */
export function pendingSummary(base: string, projects: readonly string[] | undefined, now: number): PendingSummary;
export function pendingSummary(base: string, projects: readonly string[] | undefined, now: number, strict: true): PendingSummary | null;
export function pendingSummary(base: string, projects: readonly string[] | undefined, now: number, strict?: true): PendingSummary | null {
  const file = join(base, "candidates.db");
  if (!existsSync(file)) return EMPTY_PENDING;
  const unreadable = strict ? null : EMPTY_PENDING;
  let db: Database | undefined;
  try {
    db = openReadOnly(file);
    if (!db) return unreadable;
    db.run("PRAGMA busy_timeout = 0");
    const shown = hasShownColumn(db);
    const where = projects === undefined ? "" : " AND project IN (SELECT value FROM json_each(?))";
    const rows = db.query(`SELECT at, ${shown ? "shown_at" : "NULL AS shown_at"} FROM candidates WHERE status IN ('pending', 'accepting')${where}`)
      .all(...(projects === undefined ? [] : [JSON.stringify(projects)])) as { at: number; shown_at: number | null }[];
    if (!rows.length) return EMPTY_PENDING;
    let soonest = Infinity, due = 0, unshown = 0;
    for (const row of rows) {
      const at = expiresAt(row.at, row.shown_at, now);
      soonest = Math.min(soonest, at);
      if (row.at + CANDIDATE_AGE_MS - now <= CANDIDATE_DUE_MS) due++;   // by age: an unshown row is protected past it, but the person should hear it is old
      if (row.shown_at === null) unshown++;
    }
    return { count: rows.length, oldestExpiresInDays: Math.max(0, Math.ceil((soonest - now) / DAY_MS)), dueWithin7Days: due, unshown };
  } catch { return unreadable; }   // fail open: a locked or unreadable sidecar costs the brief this line, never the brief
  finally { try { db?.close(); } catch { /* nothing to close */ } }
}

/** The one brief line. Numbers only, so it can carry no private text. */
export function pendingLine(summary: PendingSummary): string | undefined {
  if (!summary.count || summary.oldestExpiresInDays === null) return undefined;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(summary.count, "candidate")} pending, oldest expires in ${plural(summary.oldestExpiresInDays, "day")}`;
}

/**
 * Stamp the first time candidates were shown (`shown_at` stays at its first value). Best effort and zero-wait: on a locked, absent or pre-column database it stamps
 * nothing, which only keeps candidates longer. Returns how many rows it stamped.
 */
export function markShown(base: string, projects: readonly string[], now: number, ids?: readonly string[]): number {
  const file = join(base, "candidates.db");
  if (!existsSync(file) || !projects.length) return 0;
  let db: Database | undefined;
  try {
    db = new Database(file);
    db.run("PRAGMA busy_timeout = 0");
    if (!hasShownColumn(db)) return 0;
    const filter = ids === undefined ? "" : " AND id IN (SELECT value FROM json_each(?))";
    return db.query(`UPDATE candidates SET shown_at = ? WHERE shown_at IS NULL AND status IN ('pending', 'accepting') AND project IN (SELECT value FROM json_each(?))${filter}`)
      .run(now, JSON.stringify(projects), ...(ids === undefined ? [] : [JSON.stringify(ids)])).changes;
  } catch { return 0; }
  finally { try { db?.close(); } catch { /* nothing to close */ } }
}
