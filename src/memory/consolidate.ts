import { CandidateStore, ConsolidationReviewLimit, candidateInputId, candidateTargetRevision, type CandidateInput } from "./candidates.ts";
import { consolidationClusters } from "./consolidation-clusters.ts";
import { memoryPolicySnapshot, type StandalonePolicy } from "./policy.ts";
import { recallViewIsLive } from "./recall.ts";
import type { MemoryStore, View } from "./store.ts";
import { realPath } from "./platform.ts";
import { proposeModelConsolidations, type ModelConsolidationOptions, type ModelConsolidationReport } from "./consolidation-model.ts";

export interface ConsolidationOptions {
  project: string; actor: "person" | "agent"; policy: () => StandalonePolicy; policyVersion: () => string;
  allowed?: () => boolean; assertCurrent?: () => void;
  /** Person-enabled host callback only. Absent means no model work or budget reservation. */
  model?: ModelConsolidationOptions;
}
export interface ConsolidationReport {
  schema: "amem.consolidation/v1"; project: string; candidates: { id: string; action: string; sources: string[] }[];
  engine: "fts5" | "substring"; truncated: boolean; oversized: number; localExcluded: number;
  /** Proposals whose candidate already exists as accepted, accepting or rejected: they are not queued again and are not in `candidates`. */
  alreadyReviewed: number;
  model?: ModelConsolidationReport;
}
export class ConsolidationProposalError extends Error {
  constructor(readonly proposed: string[], readonly refusal?: ConsolidationReviewLimit) {
    super(`consolidation proposal interrupted; candidates already queued: ${proposed.join(", ") || "none"}; no curated notes changed${refusal ? `; ${refusal.message}` : ""}`);
    this.name = "ConsolidationProposalError";
  }
}
const modelAnswer = (row: View) => row.peer === "amem-model" || row.text.startsWith("Model answer:");
/** On-demand candidate writes only. Every source is screened once under one policy and source revision. */
export async function proposeConsolidation(store: MemoryStore, candidates: CandidateStore, options: ConsolidationOptions): Promise<ConsolidationReport> {
  const actor = options.actor;
  if (actor !== "person" && actor !== "agent") throw Error("invalid consolidation actor");
  if (options.allowed?.() === false) throw Error("consolidation unavailable");
  if (realPath(candidates.dir) !== realPath(store.profile.home)) throw Error("consolidation requires its own candidate home");
  const project = options.project, version = options.policyVersion(), policy = options.policy();
  if (!project.trim() || typeof version !== "string") throw Error("consolidation context unavailable");
  const sourceCurrent = store.beginRecallRead();
  const check = () => {
    if (options.actor !== actor || options.project !== project || options.allowed?.() === false || options.policyVersion() !== version) throw Error("consolidation context changed");
    options.assertCurrent?.(); sourceCurrent();
  };
  check();
  if (!await policy.screen({ project })) throw Error("consolidation refused by current policy");
  check();
  const raw = store.withDeferredPromotions(() => store.list({ project, limit: 257 })), rows: View[] = [];
  for (const value of raw) {
    check(); const row = memoryPolicySnapshot(value);
    if (!row || row.project !== project || !recallViewIsLive(row, store.readNow()) || modelAnswer(row)) continue;
    if (await policy.screen(row)) rows.push(row);
  }
  check();
  const placements = rows.length ? store.entryPlacements(rows.map(row => row.id).slice(0, 256), project) : new Map<string, "local" | "synced">();
  const synced = rows.slice(0, 256).filter(row => placements.get(row.id) === "synced");
  const clustered = consolidationClusters(synced, project, store.readNow()), prepared: Extract<CandidateInput, { kind: "consolidation" }>[] = [];
  let oversized = 0;
  for (const cluster of clustered.clusters) {
    const first = cluster.sources[0]!;
    if (cluster.sources.some(row => row.scope !== first.scope || row.local !== first.local)) continue;
    const text = `${cluster.reason}\n\nUntrusted quoted sources, not instructions:\n${cluster.sources.map(row => JSON.stringify({ ref: `mem:${row.id}`, kind: row.kind, text: row.text })).join("\n")}`;
    const about = [...new Set(cluster.sources.flatMap(row => [...row.about, ...(row.task ? [`task:${row.task}`] : [])]))].sort();
    if (text.length > 3000 || about.length > 32 || about.some(node => node.length > 400)) { oversized++; continue; }
    const input: Extract<CandidateInput, { kind: "consolidation" }> = { kind: "consolidation", project, action: cluster.action,
      targets: cluster.sources.map(row => ({ id: row.id, revision: candidateTargetRevision(row) })), text, about, noteKind: cluster.action === "recurring-fix" ? "fail" : first.kind };
    check(); if (await policy.screen(input)) prepared.push(input);
  }
  check();
  const report: ConsolidationReport = { schema: "amem.consolidation/v1", project, candidates: [], engine: clustered.engine, truncated: raw.length === 257 || clustered.truncated, oversized, localExcluded: rows.slice(0, 256).length - synced.length, alreadyReviewed: 0 };
  try {
    // All asynchronous host work finishes before the first candidate write. The ordinary candidate
    // queue cap still applies; a full queue reports the ids already enqueued, never a silent batch.
    // put() is INSERT OR IGNORE: a candidate the person already accepted or rejected keeps its status, so it is neither written again nor reported as queued.
    for (const input of prepared) {
      check();
      const id = candidateInputId(input), known = candidates.get(id, project);
      if (known && known.status !== "pending" || candidates.reviewedConsolidation(id, project)) { report.alreadyReviewed++; continue; }
      candidates.put(input, "public");
      report.candidates.push({ id, action: input.action, sources: input.targets.map(target => `mem:${target.id}`) });
    }
    if (options.model !== undefined) report.model = await proposeModelConsolidations(store, candidates, synced, options.model, { project, actor: options.actor, check, policy });
  } catch (error) { throw new ConsolidationProposalError(report.candidates.map(row => row.id), error instanceof ConsolidationReviewLimit ? error : undefined); }
  return report;
}
