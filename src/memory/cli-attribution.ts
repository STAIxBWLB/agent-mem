import { AsyncLocalStorage } from "node:async_hooks";

/** CLI labels are attribution, never authentication or permission to bypass policy. */
export interface CliAttribution { actor: "person" | "agent"; peer: string; policy?: () => { screenStandalone(value: unknown): boolean } }
const scope = new AsyncLocalStorage<Readonly<CliAttribution>>();

/** Preserve library defaults outside an ordinary CLI invocation, including concurrent calls. */
export function cliAttribution(): Readonly<CliAttribution> | undefined { return scope.getStore(); }
/**
 * Run `work` with `identity` in the attribution scope (root API, #431 / agent-hub#1522). Only library code that reads the scope is
 * attributed: `rawMemoryCommand` promote, demote, forget, supersede, confirm and reject, every `rawGoalCommand` write and the
 * `MemoryStore.dedupe` replacement record `identity.actor` as the operation actor (default `user`); notes written by `CandidateStore.accept`
 * record `identity.peer` as their peer (default: the accept call's actor). Other writes, including a direct `MemoryStore.note`, are not
 * attributed and keep what their caller passes. An agent scope also refuses withheld targets in those commands and screens
 * `assertCliPolicy` values with `identity.policy`. Attribution only: it never authenticates, grants access or bypasses a screen.
 * docs/contracts.md (Attribution scope) is the full list. It refuses before running `work` when it has no agent identity (no usable peer).
 */
export function withCliAttribution<T>(identity: CliAttribution, work: () => T): T {
  if (!identity || (identity.actor !== "person" && identity.actor !== "agent")) throw new Error("memory attribution needs actor person or agent");
  const remedy = "Fix or unset AGENTHUB_PEER_ID, or pass a nonblank session peer id of at most 120 characters without control characters";
  if (typeof identity.peer !== "string" || !identity.peer.trim()) throw new Error(`memory attribution peer is missing or blank; nothing was run. ${remedy}`);
  if (identity.peer.length > 120) throw new Error(`memory attribution peer exceeds 120 characters; nothing was run. ${remedy}`);
  if (/[\p{Cc}]/u.test(identity.peer)) throw new Error(`memory attribution peer contains a control character; nothing was run. ${remedy}`);
  return scope.run(Object.freeze({ ...identity, peer: identity.actor === "agent" && identity.peer === "person" ? "agent" : identity.peer }), work);
}

/** Display metadata derived from the existing peer field; never a claim of authentication. */
export const noteDisplayActor = (peer: string): "person" | "agent" => peer === "person" ? "person" : "agent";

/** Internal CLI-only guard: library callers outside a CLI scope retain their existing contract. */
export function assertCliPolicy(value: unknown): void {
  const identity = scope.getStore();
  if (identity?.actor !== "agent") return;
  try {
    const plain: unknown = JSON.parse(JSON.stringify(value));
    if (identity.policy?.().screenStandalone(plain) === true) return;
  } catch { /* Withhold the complete value, including configuration errors. */ }
  throw Error("Memory operation unavailable or refused; no partial result is shown.");
}
