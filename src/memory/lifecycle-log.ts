import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The lifecycle log and its pure reading: a leaf with no import beyond `node:fs` and `node:path`, so the alias writer can refuse an alias to or from a forgotten
 * key without loading a store or the shard machinery (the alias leaf is held to that by test/hook-project.test.ts). The ops themselves, their
 * authority and the alias-aware state live in `lifecycle.ts`.
 */
// The same schema string as the alias log (aliases.ts owns it; importing it here would be a cycle).
const SHARD_SCHEMA = "agent-hub.memory.shard/v1";

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

