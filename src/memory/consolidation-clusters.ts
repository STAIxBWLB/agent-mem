import { SearchIndex } from "./search-fts.ts";
import { recallViewIsLive } from "./recall.ts";
import type { View } from "./store.ts";

export type ConsolidationAction = "merge" | "supersession" | "recurring-fix";
export interface ConsolidationCluster { action: ConsolidationAction; sources: View[]; reason: string }
export const CONSOLIDATION_SOURCE_LIMIT = 256, CONSOLIDATION_PROPOSAL_LIMIT = 32;
const words = (row: View) => new Set((`${row.title ?? ""} ${row.text}`.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter(word => !["the", "and", "for", "with", "from", "this", "that", "approach", "symptom", "cause", "evidence", "retry", "when"].includes(word)).slice(0, 128));
const paths = (row: View) => row.about.filter(node => node.startsWith("path:"));
const sharedPath = (a: View, b: View) => paths(a).some(node => paths(b).includes(node));
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter(word => b.has(word)).length / Math.max(1, Math.min(a.size, b.size));

/** Bounded deterministic proposals over already-screened rows. Never mutates a note or runs a model. */
export function consolidationClusters(input: readonly View[], project: string, now: number): { clusters: ConsolidationCluster[]; truncated: boolean; engine: "fts5" | "substring" } {
  if (!project.trim() || !Number.isFinite(now)) throw Error("consolidation context unavailable");
  const eligible = input.filter(row => row.project === project && recallViewIsLive(row, now))
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const rows = [...new Map(eligible.map(row => [row.id, row])).values()].slice(0, CONSOLIDATION_SOURCE_LIMIT);
  const index = new SearchIndex(":memory:"), clusters: ConsolidationCluster[] = [], seen = new Set<string>();
  let truncated = eligible.length > rows.length;
  const add = (action: ConsolidationAction, sources: View[], reason: string) => {
    const key = `${action}:${sources.map(row => row.id).sort().join(":")}`;
    if (seen.has(key)) return; seen.add(key);
    if (clusters.length === CONSOLIDATION_PROPOSAL_LIMIT) { truncated = true; return; }
    clusters.push({ action, sources, reason });
  };
  try {
    index.resync(() => rows.map(row => ({ id: row.id, at: row.at, project, tier: row.tier, scope: row.scope, body: `${row.title ?? ""}\n${row.text}` })));
    if (index.available && index.needsResync(rows.length)) throw Error("consolidation index unavailable");
    const terms = new Map(rows.map(row => [row.id, words(row)]));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!, candidates = index.available ? new Set(index.query([...terms.get(row.id)!].slice(0, 32).join(" "), rows.length, project).map(hit => hit.ref)) : undefined;
      for (const peer of rows.slice(i + 1)) {
        if (row.kind !== peer.kind) continue;
        const lexical = overlap(terms.get(row.id)!, terms.get(peer.id)!);
        if (row.text === peer.text) add("supersession", [row, peer], "Identical text; review one replacement for both originals.");
        else if ((!candidates || candidates.has(peer.id)) && lexical >= 0.5 && sharedPath(row, peer)) add("merge", [row, peer], "Shared path and overlapping indexed terms; no equivalence is assumed.");
      }
      // A retained supersession chain is context, never a reason to resurrect an old body.
      if (row.supersedes.length >= 2) add("merge", [row], "Current head already replaces multiple originals; review a chain summary.");
    }
    const failRows = rows.filter(row => row.kind === "fail"), decisions = rows.filter(row => row.kind === "decision" || row.kind === "contract");
    for (let i = 0; i < failRows.length; i++) for (const peer of failRows.slice(i + 1)) {
      const fail = failRows[i]!;
      if (!sharedPath(fail, peer) || overlap(terms.get(fail.id)!, terms.get(peer.id)!) < 0.5) continue;
      const fix = decisions.find(row => sharedPath(row, fail) && overlap(terms.get(row.id)!, terms.get(fail.id)!) >= 0.25);
      if (fix) add("recurring-fix", [fail, peer, fix], "Repeated fail notes and a related decision on the same path; review whether the decision addresses the failures.");
    }
    return { clusters, truncated, engine: index.available ? "fts5" : "substring" };
  } finally { index.close(); }
}
