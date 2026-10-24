import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { hashJSON } from "./generation.ts";
import { candidateTargetRevision, type CandidateTarget, type Counter } from "./candidates.ts";
import { MemoryStore, type View } from "./store.ts";

export const DECAY_DEFAULT_DAYS = 90, DECAY_PREVIEW_LIMIT = 64, DECAY_SCAN_LIMIT = 5000;
export interface DecayEntry { target: CandidateTarget; view: View }
export interface DecayPlan {
  project: string; profile: string; days: number; at: string; cutoff: string;
  entries: DecayEntry[]; withheld: number; citedExemptions: number | null; truncated: boolean;
  /** Missing/zero observations do not prove the note was never cited. */
  citationHistory: "unknown";
}
export interface DecayOptions {
  now?: () => number; days?: number; ids?: readonly string[]; aliases?: readonly string[]; counters?: () => readonly Counter[] | undefined;
  screen?: (view: View) => boolean; assertCurrent?: () => void;
}
function idsOf(ids: readonly string[]): string[] {
  const normalized = ids.map(id => id.replace(/^mem:/, ""));
  if (normalized.length > DECAY_PREVIEW_LIMIT || new Set(normalized).size !== normalized.length || normalized.some(id => !/^[a-f0-9]{32}$/.test(id))) throw Error("name up to 64 distinct exact entry ids");
  return normalized;
}
/** Advisory telemetry without opening/pruning the candidate writer. Unavailable is unknown, never zero. */
export function readDecayCounters(base: string, projects: readonly string[]): Counter[] | undefined {
  const file = join(base, "candidates.db");
  let db: Database | undefined;
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return undefined;
    db = new Database(file, { readonly: true }); db.run("PRAGMA busy_timeout = 0");
    const rows = db.query("SELECT id,payload,at,rendered,delivered,cited FROM counters WHERE project IN (SELECT value FROM json_each(?)) AND cited > 0 ORDER BY at DESC").all(JSON.stringify(projects)) as { id: string; payload: string; at: number; rendered: number | null; delivered: number | null; cited: number | null }[];
    return rows.map(row => ({ id: row.id, key: JSON.parse(row.payload), createdAt: new Date(row.at).toISOString(), rendered: row.rendered, delivered: row.delivered, cited: row.cited }));
  } catch { return undefined; }
  finally { try { db?.close(); } catch { /* An unavailable telemetry close cannot authorize a mutation. */ } }
}
function citedIds(project: string, aliases: readonly string[], counters: readonly Counter[] | undefined, cutoff: number, now: number): Set<string> {
  const ids = new Set<string>();
  for (const row of counters ?? []) {
    if (!row?.key || ![project, ...aliases].includes(row.key.project) || !Number.isSafeInteger(row.cited) || !(row.cited! > 0)) continue;
    const at = Date.parse(row.createdAt);
    if (Number.isFinite(at) && at >= cutoff && at <= now) ids.add(row.key.entryId);
  }
  return ids;
}
/** Age/goal selection is independent of telemetry; positive recent citations may only exempt entries. */
export function decayPreview(store: MemoryStore, project: string, options: DecayOptions = {}): DecayPlan {
  options.assertCurrent?.();
  if (!project.trim() || store.profile.sharded && !store.profile.shardUser && store.profile.shardKey !== project) throw Error("decay project does not match the bound store");
  const now = (options.now ?? Date.now)(), days = options.days ?? DECAY_DEFAULT_DAYS, cutoff = now - days * 86400_000;
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isFinite(now) || !Number.isFinite(cutoff) || Math.abs(cutoff) > 8_640_000_000_000_000) throw Error("decay days are outside the supported range");
  const requested = options.ids === undefined ? undefined : idsOf(options.ids);
  return store.withDeferredPromotions(() => {
    const goals = store.goals(project).filter(goal => ["open", "active", "blocked"].includes(goal.state));
    const tasks = new Set(goals.flatMap(goal => goal.links.map(link => link.task))), goalNodes = new Set(goals.map(goal => `goal:${goal.id}`));
    let counters: readonly Counter[] | undefined;
    try { counters = options.counters?.(); } catch { /* Telemetry is advisory; an unreadable snapshot is unknown. */ }
    const cited = citedIds(project, options.aliases ?? [], counters, cutoff, now);
    // ponytail: list materializes the existing core corpus before slicing; a scoped pager is the upgrade for large homes.
    const rows = requested ? requested.map(id => store.get(id, project)) : store.list({ project, tier: "long", limit: DECAY_SCAN_LIMIT + 1 });
    if (rows.length > DECAY_SCAN_LIMIT) throw Error("decay preview scan bound exceeded; name exact ids to narrow it");
    const entries: DecayEntry[] = []; let withheld = 0, citedExemptions = 0;
    for (let index = 0; index < rows.length; index++) {
      const view = rows[index];
      const eligible = view && (!requested || view.id === requested[index]) && view.project === project && view.tier === "long" && !view.supersededBy && Number.isFinite(Date.parse(view.at)) && Date.parse(view.at) < cutoff
        && !(view.task && tasks.has(view.task)) && !view.about.some(node => goalNodes.has(node) || node.startsWith("task:") && tasks.has(node.slice(5)));
      if (!eligible) { if (requested) throw Error("requested entry is not eligible for decay"); continue; }
      if (cited.has(view.id)) { citedExemptions++; if (requested) throw Error("requested entry has a recent recorded citation"); continue; }
      if (options.screen && !options.screen(structuredClone(view))) { withheld++; if (requested) throw Error("requested entry is withheld by current policy"); continue; }
      entries.push({ target: { id: view.id, revision: candidateTargetRevision(view) }, view: structuredClone(view) });
    }
    options.assertCurrent?.();
    return { project, profile: hashJSON(store.profile), days, at: new Date(now).toISOString(), cutoff: new Date(cutoff).toISOString(), entries: entries.slice(0, DECAY_PREVIEW_LIMIT), withheld, citedExemptions: counters === undefined ? null : citedExemptions, truncated: entries.length > DECAY_PREVIEW_LIMIT, citationHistory: "unknown" };
  });
}
export interface DecayApplyOptions extends Omit<DecayOptions, "days"> {
  actor: "person" | "agent"; confirmed?: boolean; forget?: boolean;
}
/** The host shows this exact plan; every selected revision/eligibility is rechecked before any append. */
export function applyDecay(store: MemoryStore, plan: DecayPlan, options: DecayApplyOptions): { action: "demote" | "forget"; ids: string[] } {
  if (options.actor !== "person") throw Error("decay apply requires person authority");
  options.assertCurrent?.();
  const ids = options.ids === undefined ? plan.entries.map(entry => entry.target.id) : idsOf(options.ids);
  if ((options.ids === undefined || options.forget) && options.confirmed !== true) throw Error("decay bulk/forget apply requires explicit person confirmation");
  if (hashJSON(store.profile) !== plan.profile || ids.some(id => !plan.entries.some(entry => entry.target.id === id))) throw Error("decay preview binding changed or target was not previewed");
  const action = options.forget ? "forget" : "demote";
  if (!ids.length) return { action, ids };
  return store.withCurrentEntries(ids, plan.project, current => {
    const fresh = decayPreview(store, plan.project, { ...options, days: plan.days, ids });
    for (const view of current) {
      const expected = plan.entries.find(entry => entry.target.id === view.id)?.target.revision;
      if (!expected || candidateTargetRevision(view) !== expected || !fresh.entries.some(entry => entry.target.id === view.id && entry.target.revision === expected)) throw Error("decay target changed since preview");
    }
    options.assertCurrent?.();
    // All target checks precede all effects. A later filesystem failure can still leave an append-only partial result.
    for (const id of ids) { if (options.forget) store.forget(id, "person", plan.project); else store.demote(id, "person", plan.project); }
    return { action, ids };
  });
}
