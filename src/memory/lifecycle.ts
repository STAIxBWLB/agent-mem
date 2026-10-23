import { appendFileSync, mkdirSync } from "node:fs";
import { SHARD_SCHEMA, effectiveAliases, resolveAlias } from "./aliases.ts";
import { lifecyclePath, lifecycleStates, listLifecycle, type LifecycleKind, type LifecycleOp, type LifecycleState } from "./lifecycle-log.ts";
import { readShardDescriptor, shardKeyHash } from "./shard.ts";

export { lifecyclePath, lifecycleStates, listLifecycle, type LifecycleKind, type LifecycleOp, type LifecycleState };
const KINDS: readonly string[] = ["archive", "unarchive", "forget"];

/**
 * #15 T5 / D3: the per-project lifecycle. `archive`, `unarchive` and `forget` are append-only ops in `lifecycle.jsonl` of the memory home, in the same
 * local, never-synced form as `aliases.jsonl` (no shared-v1 segment sees a new op kind). Nothing rewrites a line and nothing deletes a shard: the op
 * is the whole effect, and every reader consults it. The latest op wins, except that `forgotten` is terminal.
 *
 * - archived: the shard stays on disk, but a writable capture store, recall and the brief refuse it, and the catalog lists it as archived.
 * - forgotten: the project is out of recall and the default listing for good. Its bytes are not erased here (that is what `amem project export`
 *   and a person's own file deletion are for); the op is the record that the person asked for it.
 */

const SEVERITY: Record<LifecycleState, number> = { active: 0, archived: 1, forgotten: 2 };
const worse = (a: LifecycleState, b: LifecycleState): LifecycleState => SEVERITY[a] >= SEVERITY[b] ? a : b;

/**
 * The state of `key`, alias-aware in both directions: the worse of the key's own state and its canonical key's. An op is recorded on the canonical key, so
 * an alias to an archived or forgotten project is that state, and a key forgotten before it became an alias of an active project stays forgotten (its own
 * op is not erased by a later alias line). Terminal: after one `forget`, no later line moves a key back.
 */
export function projectState(base: string, key: string): LifecycleState {
  return lifecycleResolver(base)(key);
}

/** One pass over both logs, then a lookup per key for a walk of many shards: `state(key)` is exactly `projectState(base, key)`. */
export function lifecycleResolver(base: string): (key: string) => LifecycleState {
  const states = lifecycleStates(base), aliases = effectiveAliases(base);
  return key => worse(states.get(key) ?? "active", states.get(aliases.get(key) ?? key) ?? "active");
}

/** Refuses a project the person archived or forgot; the one check every writable capture open, recall and brief shares. */
export function assertProjectActive(base: string, key: string): void {
  const state = projectState(base, key);
  if (state !== "active") throw new Error(`project ${resolveAlias(base, key)} is ${state}: ${state === "archived" ? "amem project unarchive brings it back" : "it is out of recall for good"}`);
}

/**
 * One person-authorized op. The key resolves through the alias table to the one canonical project, and the transition is checked first so a typo or a
 * repeat never records an op that means nothing: archive needs an active project, unarchive an archived one, and nothing follows a forget.
 */
export function appendLifecycle(base: string, input: { op: LifecycleKind; key: string; actor: string; machine: string; at?: string }): LifecycleOp {
  if (!KINDS.includes(input.op)) throw new Error("unknown lifecycle op");
  const requested = input.key.trim();
  if (!requested || requested.length > 1000) throw new Error("a lifecycle op needs one project key");
  const key = resolveAlias(base, requested);
  if (!readShardDescriptor(base, shardKeyHash(key))) throw new Error(`no project shard for ${key}`);
  const state = projectState(base, key);
  if (state === "forgotten") throw new Error(`project ${key} is forgotten: nothing follows a forget`);
  if (input.op === "archive" && state === "archived") throw new Error(`project ${key} is already archived`);
  if (input.op === "unarchive" && state !== "archived") throw new Error(`project ${key} is not archived`);
  const op: LifecycleOp = { schema: SHARD_SCHEMA, op: input.op, at: input.at ?? new Date().toISOString(), machine: input.machine, key, actor: input.actor };
  mkdirSync(base, { recursive: true, mode: 0o700 });
  appendFileSync(lifecyclePath(base), JSON.stringify(op) + "\n", { mode: 0o600 });
  return op;
}
