import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SHARD_SCHEMA, resolveAlias } from "./aliases.ts";
import { readShardDescriptor, shardKeyHash } from "./shard.ts";

/**
 * #15 T5 / D3: the per-project lifecycle. `archive`, `unarchive` and `forget` are append-only ops in `lifecycle.jsonl` of the memory home, in the same
 * local, never-synced form as `aliases.jsonl` (no shared-v1 segment sees a new op kind). Nothing rewrites a line and nothing deletes a shard: the op
 * is the whole effect, and every reader consults it. The latest op wins, except that `forgotten` is terminal.
 *
 * - archived: the shard stays on disk, but a writable capture store, recall and the brief refuse it, and the catalog lists it as archived.
 * - forgotten: the project is out of recall and the default listing for good. Its bytes are not erased here (that is what `amem project export`
 *   and a person's own file deletion are for); the op is the record that the person asked for it.
 */

export type LifecycleState = "active" | "archived" | "forgotten";
export type LifecycleKind = "archive" | "unarchive" | "forget";
export interface LifecycleOp { schema: typeof SHARD_SCHEMA; op: LifecycleKind; at: string; machine: string; key: string; actor: string }

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const KINDS: readonly string[] = ["archive", "unarchive", "forget"];

export function lifecyclePath(base: string): string {
  return join(base, "lifecycle.jsonl");
}

/** Every well-formed op in file order; a malformed or unknown line is skipped, never fatal. A log above the byte bound is refused (it cannot be read whole), never read in part: a half-read log could show a forgotten project as active. */
export function listLifecycle(base: string): LifecycleOp[] {
  let text = "";
  try {
    const file = lifecyclePath(base);
    if (statSync(file).size > MAX_LOG_BYTES) throw new Error("lifecycle log is larger than its read bound");
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ops: LifecycleOp[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const op = JSON.parse(line) as LifecycleOp;
      if (op?.schema === SHARD_SCHEMA && KINDS.includes(op.op) && typeof op.key === "string" && op.key && typeof op.at === "string") ops.push(op);
    } catch { /* a malformed line is skipped */ }
  }
  return ops;
}

/** The state of the canonical key of `key`. Terminal: after one `forget`, no later line moves it back. */
export function projectState(base: string, key: string): LifecycleState {
  const canonical = resolveAlias(base, key);
  let state: LifecycleState = "active";
  for (const op of listLifecycle(base)) {
    if (op.key !== canonical) continue;
    if (state === "forgotten") break;
    state = op.op === "forget" ? "forgotten" : op.op === "archive" ? "archived" : "active";
  }
  return state;
}

/** Every project key with a non-active state, for the catalog: one pass over the log. */
export function lifecycleStates(base: string): Map<string, LifecycleState> {
  const states = new Map<string, LifecycleState>();
  for (const op of listLifecycle(base)) {
    const current = states.get(op.key) ?? "active";
    if (current === "forgotten") continue;
    states.set(op.key, op.op === "forget" ? "forgotten" : op.op === "archive" ? "archived" : "active");
  }
  return states;
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
