import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CandidateStore, candidateInputId, candidateTargetRevision, goalPromotionLinked, type CandidateInput } from "./candidates.ts";
import { readSelector } from "./generation.ts";
import { projectState } from "./lifecycle.ts";
import { realPath } from "./platform.ts";
import type { StandalonePolicy } from "./policy.ts";
import { aliasedKeys, readShardedSelection, resolveAlias } from "./shard.ts";
import { MemoryStore, type GoalView } from "./store.ts";

export const GOAL_PROMOTION_SCAN_LIMIT = 5000, GOAL_PROMOTION_LIMIT = 64;
export interface GoalPromotionOptions {
  /** Recreated before/after awaits so a changed built-in configuration is never a cached public verdict. */
  policy(): StandalonePolicy;
  assertCurrent?(): void;
  limit?: number;
}
/** ids contains only newly created proposals; known states are counted without disclosure or replay. */
export interface GoalPromotionReport { ids: string[]; offered: number; alreadyOffered: number; withheld: number; truncated: boolean }
const goalRevision = (goal: GoalView) => JSON.stringify([goal.id, goal.project, goal.scope, goal.title, goal.milestones, goal.dependsOn, goal.state, goal.links]);
/** Offer only machine-local metadata proposals. Goal state is set by the person caller, never by this helper. */
export async function offerGoalPromotions(store: MemoryStore, candidates: CandidateStore, project: string, goalId: string, options: GoalPromotionOptions): Promise<GoalPromotionReport> {
  goalId = goalId.replace(/^goal:/, "");
  const limit = options.limit ?? GOAL_PROMOTION_LIMIT;
  if (!/^[a-f0-9]{32}$/.test(goalId) || !project.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > GOAL_PROMOTION_LIMIT) throw Error("goal promotion requires an exact goal id and a bounded limit");
  const base = realPath(store.profile.home);
  if (realPath(candidates.dir) !== base) throw Error("goal promotion sidecar does not match its store");
  project = resolveAlias(base, project);
  const selector = readSelector(base).revision, aliases = aliasedKeys(base, project).join("\n");
  if (selector !== store.profile.selectorRevision) throw Error("goal promotion store selector changed");
  const split = !!lstatSync(join(base, "shards.json"), { throwIfNoEntry: false }), shards = split ? JSON.stringify(readShardedSelection(base)) : undefined;
  const read = <T>(work: () => T) => store.withDeferredPromotions(work);
  const guard = () => {
    options.assertCurrent?.();
    const currentSplit = !!lstatSync(join(base, "shards.json"), { throwIfNoEntry: false });
    if (readSelector(base).revision !== selector || resolveAlias(base, project) !== project || aliasedKeys(base, project).join("\n") !== aliases || projectState(base, project) !== "active" || currentSplit !== split || split && JSON.stringify(readShardedSelection(base)) !== shards) throw Error("goal promotion binding changed");
  };
  const goal = read(() => store.goalOf(goalId, project));
  if (!goal || goal.id !== goalId || goal.state !== "done") throw Error("goal promotion requires a current done goal");
  const revision = goalRevision(goal), currentGoal = () => {
    guard(); const value = read(() => store.goalOf(goalId, project));
    if (!value || value.id !== goalId || value.state !== "done" || goalRevision(value) !== revision) throw Error("goal changed during promotion offering");
    return value;
  };
  const result: GoalPromotionReport = { ids: [], offered: 0, alreadyOffered: 0, withheld: 0, truncated: false };
  guard();
  const goalAllowed = await options.policy().screen(goal); currentGoal();
  if (!goalAllowed || !options.policy().screenStandalone(goal)) { result.withheld++; return result; }
  // ponytail: list() retains full-corpus materialization; this bounds selected candidates/async policy work only.
  // Upgrade: scope-aware pages including foreign-source shared rows (readPage is exact-project only).
  const rows = read(() => store.list({ project, tier: "short", limit: GOAL_PROMOTION_SCAN_LIMIT + 1 }));
  result.truncated = rows.length > GOAL_PROMOTION_SCAN_LIMIT;
  let selected = 0;
  for (const row of rows.slice(0, GOAL_PROMOTION_SCAN_LIMIT)) {
    if (row.tier !== "short" || row.supersededBy || row.project !== project && row.scope !== "shared" || !goalPromotionLinked(row, goal)) continue;
    const input: CandidateInput = { project, kind: "promotion", goalId, target: { id: row.id, revision: candidateTargetRevision(row) } };
    currentGoal();
    const id = candidateInputId(input);
    if (candidates.get(id, project)) { result.alreadyOffered++; continue; }
    if (selected++ >= limit) { result.truncated = true; break; }
    const complete = { ...input, targetView: row, goalView: goal };
    currentGoal(); const permitted = await options.policy().screen(complete); const freshGoal = currentGoal();
    const fresh = read(() => store.get(row.id, project));
    if (!permitted || !fresh || fresh.id !== row.id || candidateTargetRevision(fresh) !== input.target.revision || fresh.tier !== "short" || fresh.supersededBy || !goalPromotionLinked(fresh, freshGoal)
      || !options.policy().screenStandalone({ ...input, targetView: fresh, goalView: freshGoal })) { result.withheld++; continue; }
    guard();
    if (candidates.get(id, project)) { result.alreadyOffered++; continue; }
    candidates.put(input, "public"); result.offered++; result.ids.push(id);
  }
  guard(); return result;
}
