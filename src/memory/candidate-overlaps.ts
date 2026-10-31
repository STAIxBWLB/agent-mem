import type { Candidate, CandidateInput } from "./candidates.ts";
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

type OverlapCandidate = Pick<Candidate, "status" | "input">;
interface PreparedCandidate {
  proposed: Pick<View, "title" | "text">;
  terms: Set<string>;
  selected: { row: View; score: number }[];
  target?: View;
}

function candidateText(input: CandidateInput, target?: View): Pick<View, "title" | "text"> | undefined {
  if (input.kind === "promotion") return target;
  return { title: input.kind === "memory" ? input.title ?? null : null,
    text: input.kind === "correction" ? input.proposedText : input.kind === "decay" ? input.reason
      : input.kind === "fail" ? [input.approach, input.symptom, input.cause, ...input.evidenceRefs, input.retryWhen].join("\n") : input.text };
}

/** One policy-screened, tokenized note pass for the whole batch. Keep only three winners per candidate, not the corpus. */
export async function candidateOverlapsBatch(candidates: readonly OverlapCandidate[], store: MemoryStore, options: OverlapOptions): Promise<CandidateOverlap[][]> {
  const inputs = candidates.map(candidate => candidate.status === "pending" && resolveAlias(store.profile.home, candidate.input.project) === options.project ? stripPrivateDeep(candidate.input) : undefined);
  if (!inputs.some(Boolean)) return candidates.map(() => []);
  const revision = options.policyVersion(), policy = options.policy(), sourceCurrent = store.beginRecallRead();
  const check = () => {
    options.assertCurrent?.(); sourceCurrent();
    if (options.policyVersion() !== revision) throw Error("overlap policy changed");
  };
  check();
  // Promotion text lives in its target. Screen each distinct target once, reusing that verdict in the note pass.
  const targets = new Map<string, View | undefined>(), targetTerms = new Map<string, Set<string>>();
  for (const input of inputs) {
    if (input?.kind !== "promotion" || targets.has(input.target.id)) continue;
    const target = memoryPolicySnapshot(store.get(input.target.id, options.project));
    const allowed = target && target.project === options.project && recallViewIsLive(target, store.readNow()) && await policy.screen(target);
    check(); targets.set(input.target.id, allowed ? target : undefined);
    if (allowed && target) targetTerms.set(target.id, overlapWords(target));
  }
  const prepared = inputs.map((input): PreparedCandidate | undefined => {
    if (!input) return undefined;
    const target = input.kind === "promotion" ? targets.get(input.target.id) : undefined, proposed = candidateText(input, target);
    return proposed ? { proposed, terms: target ? targetTerms.get(target.id)! : overlapWords(proposed), selected: [], ...(target ? { target } : {}) } : undefined;
  });
  if (!prepared.some(Boolean)) { check(); return candidates.map(() => []); }
  let after: Parameters<MemoryStore["readPage"]>[0]["after"];
  for (;;) {
    check();
    const page = store.withDeferredPromotions(() => store.readPage({ project: options.project, limit: 128, after }));
    for (const value of page.rows) {
      const row = memoryPolicySnapshot(value);
      if (!row || row.project !== options.project || !recallViewIsLive(row, store.readNow())) continue;
      const allowed = targets.has(row.id) ? targets.get(row.id) !== undefined : await policy.screen(row); check();
      if (!allowed || !recallViewIsLive(row, store.readNow())) continue;
      const terms = targetTerms.get(row.id) ?? overlapWords(row);
      for (const candidate of prepared) {
        if (!candidate) continue;
        const score = candidate.proposed.text === row.text ? 1 : wordOverlap(candidate.terms, terms), selected = candidate.selected, last = selected.at(-1);
        if (score <= 0 || selected.length === 3 && last && (score < last.score || score === last.score && row.id.localeCompare(last.row.id) >= 0)) continue;
        selected.push({ row, score });
        selected.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
        if (selected.length > 3) selected.pop();
      }
    }
    if (!page.next) break;
    after = page.next;
  }
  check();
  return prepared.map(candidate => !candidate || candidate.target && !recallViewIsLive(candidate.target, store.readNow()) ? []
    : candidate.selected.filter(({ row }) => recallViewIsLive(row, store.readNow())).map(({ row, score }) => ({ id: row.id, title: row.title, score })));
}

/** Single-candidate callers share the same screening and source/policy fences as JSON list batches. */
export async function candidateOverlaps(candidate: OverlapCandidate, store: MemoryStore, options: OverlapOptions): Promise<CandidateOverlap[]> {
  return (await candidateOverlapsBatch([candidate], store, options))[0]!;
}
