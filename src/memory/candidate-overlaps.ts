import type { Candidate } from "./candidates.ts";
import { overlapWords, wordOverlap } from "./consolidation-clusters.ts";
import { memoryPolicySnapshot, type StandalonePolicy } from "./policy.ts";
import { stripPrivateDeep } from "./private-spans.ts";
import { recallViewIsLive } from "./recall.ts";
import { resolveAlias } from "./shard.ts";
import type { MemoryStore, View } from "./store.ts";

export interface CandidateOverlap { id: string; title: string | null; score: number }
interface OverlapOptions {
  project: string;
  policy: () => StandalonePolicy;
  policyVersion: () => string;
  assertCurrent?: () => void;
}

/** Ephemeral review hints only. Screen complete rows before scoring; retain at most three, never a refused-row count. */
export async function candidateOverlaps(candidate: Pick<Candidate, "status" | "input">, store: MemoryStore, options: OverlapOptions): Promise<CandidateOverlap[]> {
  if (candidate.status !== "pending" || resolveAlias(store.profile.home, candidate.input.project) !== options.project) return [];
  const input = stripPrivateDeep(candidate.input), revision = options.policyVersion(), policy = options.policy(), sourceCurrent = store.beginRecallRead();
  const check = () => {
    options.assertCurrent?.(); sourceCurrent();
    if (options.policyVersion() !== revision) throw Error("overlap policy changed");
  };
  check();
  let proposed: Pick<View, "title" | "text">;
  if (input.kind === "promotion") {
    const target = store.get(input.target.id, options.project);
    if (!target || target.project !== options.project || !recallViewIsLive(target, store.readNow()) || !await policy.screen(target)) { check(); return []; }
    check(); proposed = target;
  } else {
    proposed = { title: input.kind === "memory" ? input.title ?? null : null,
      text: input.kind === "correction" ? input.proposedText : input.kind === "decay" ? input.reason
        : input.kind === "fail" ? [input.approach, input.symptom, input.cause, ...input.evidenceRefs, input.retryWhen].join("\n") : input.text };
  }
  const terms = overlapWords(proposed), selected: { row: View; score: number }[] = [];
  let after: Parameters<MemoryStore["readPage"]>[0]["after"];
  for (;;) {
    check();
    const page = store.withDeferredPromotions(() => store.readPage({ project: options.project, limit: 128, after }));
    for (const value of page.rows) {
      const row = memoryPolicySnapshot(value);
      if (!row || row.project !== options.project || !recallViewIsLive(row, store.readNow())) continue;
      const allowed = await policy.screen(row); check();
      if (!allowed || !recallViewIsLive(row, store.readNow())) continue;
      const score = proposed.text === row.text ? 1 : wordOverlap(terms, overlapWords(row));
      if (score <= 0) continue;
      selected.push({ row, score });
      selected.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
      if (selected.length > 3) selected.pop();
    }
    if (!page.next) break;
    after = page.next;
  }
  check();
  return selected.filter(({ row }) => recallViewIsLive(row, store.readNow())).map(({ row, score }) => ({ id: row.id, title: row.title, score }));
}
