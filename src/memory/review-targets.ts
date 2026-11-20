import type { View } from "./store.ts";
import type { MemoryUseSummary } from "./use-telemetry.ts";
import type { Counter } from "./candidates.ts";
import { summarizeMemoryUse } from "./use-telemetry.ts";
import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";

export type ReviewReason = "stale" | "rendered" | "volatile";
export interface ReviewTarget { id: string; reason: ReviewReason; ageDays: number; counts: MemoryUseSummary }
export interface ReviewTargetOptions {
  now: number; recheckDays: number; limit: number;
  stale: (view: View) => boolean | undefined;
  use: (view: View) => MemoryUseSummary;
  /** False when a retained decided candidate was created inside the window. */
  eligibleForRecheck: (view: View, cutoff: number) => boolean;
}

export const REVIEW_DEFAULTS = { recheck_days: 30, unused_rendered: 20, unused_days: 30 } as const;
export interface ReviewSnapshot { counters: Counter[]; decided: { at: number; targets: string[] }[] }
/** Read the sidecar without opening the writer, pruning, or altering the schema. */
export function readReviewSnapshot(home: string, projects: readonly string[]): ReviewSnapshot {
  const file = join(home, "candidates.db"), stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { counters: [], decided: [] };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error("review history unavailable: candidate database is not a private regular file; inspect the memory home before retrying");
  const db = new Database(file, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 0");
    const scope = JSON.stringify(projects);
    const counters = (db.query("SELECT id,payload,at,rendered,delivered,cited FROM counters WHERE project IN (SELECT value FROM json_each(?)) ORDER BY id").all(scope) as { id: string; payload: string; at: number; rendered: number | null; delivered: number | null; cited: number | null }[])
      .map(row => ({ id: row.id, key: JSON.parse(row.payload), createdAt: new Date(row.at).toISOString(), rendered: row.rendered, delivered: row.delivered, cited: row.cited }));
    const decided = (db.query("SELECT at,payload FROM candidates WHERE project IN (SELECT value FROM json_each(?)) AND status IN ('accepted','rejected') ORDER BY at,id").all(scope) as { at: number; payload: string }[]).map(row => {
      const input = JSON.parse(row.payload) as { target?: { id?: string }; targets?: { id?: string }[] };
      return { at: row.at, targets: [input.target?.id, ...(input.targets ?? []).map(target => target.id)].filter((id): id is string => typeof id === "string") };
    });
    return { counters, decided };
  } finally { db.close(); }
}

export function reviewUse(snapshot: ReviewSnapshot, project: readonly string[], id: string, since = -Infinity): MemoryUseSummary {
  return summarizeMemoryUse(snapshot.counters.filter(row => project.includes(row.key.project) && row.key.entryId === id && Date.parse(row.createdAt) >= since));
}

/** ponytail: candidate creation time approximates decision time; add a decision timestamp if over-listing proves material. */
export function noRecentReview(snapshot: ReviewSnapshot, id: string, cutoff: number): boolean {
  return !snapshot.decided.some(row => row.at >= cutoff && row.targets.includes(id));
}

/** Pure selection over a caller-supplied snapshot. The caller supplies policy-screened views and read-only telemetry. */
export function reviewTargets(views: readonly View[], options: ReviewTargetOptions): ReviewTarget[] {
  const { now, recheckDays, limit } = options;
  if (!Number.isFinite(now) || !Number.isSafeInteger(recheckDays) || recheckDays < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw Error("invalid review target window or limit; use a positive recheck window and a limit from 1 to 500");
  const cutoff = now - recheckDays * 86400_000;
  const rows: ReviewTarget[] = [];
  for (const view of views) {
    const at = Date.parse(view.at);
    if (!Number.isFinite(at) || at > now || view.supersededBy) continue;
    const counts = options.use(view), ageDays = Math.floor((now - at) / 86400_000);
    const reason: ReviewReason | undefined = options.stale(view) === true ? "stale"
      : counts.rendered !== null && counts.rendered > 0 && options.eligibleForRecheck(view, cutoff) ? "rendered"
      : (view.kind === "decision" || view.kind === "contract") && at < cutoff ? "volatile" : undefined;
    if (reason) rows.push({ id: view.id, reason, ageDays, counts });
  }
  const rank: Record<ReviewReason, number> = { stale: 0, rendered: 1, volatile: 2 };
  return rows.sort((a, b) => rank[a.reason] - rank[b.reason]
    || (a.reason === "rendered" ? (b.counts.rendered ?? 0) - (a.counts.rendered ?? 0) : b.ageDays - a.ageDays)
    || a.id.localeCompare(b.id)).slice(0, limit);
}
