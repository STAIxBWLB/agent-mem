import { AsyncLocalStorage } from "node:async_hooks";

/** CLI labels are attribution, never authentication or permission to bypass policy. */
export interface CliAttribution { actor: "person" | "agent"; peer: string; policy?: () => { screenStandalone(value: unknown): boolean } }
const scope = new AsyncLocalStorage<Readonly<CliAttribution>>();

/** Preserve library defaults outside an ordinary CLI invocation, including concurrent calls. */
export function cliAttribution(): Readonly<CliAttribution> | undefined { return scope.getStore(); }
/**
 * Run `work` with `identity` as the attribution of every memory write it makes (root API, #431 / agent-hub#1522). Writes inside the scope
 * record `identity.peer` as the note's peer and `identity.actor` as each operation's actor; outside it they keep the library default (the
 * person). Attribution only: it never authenticates, grants access or bypasses a policy screen. An agent scope applies the given `policy`
 * to each target it reads or changes, and refuses before running `work` when it has no agent identity (no peer).
 */
export function withCliAttribution<T>(identity: CliAttribution, work: () => T): T {
  if (!identity || (identity.actor !== "person" && identity.actor !== "agent")) throw new Error("memory attribution needs actor person or agent");
  if (typeof identity.peer !== "string" || !identity.peer.trim() || identity.peer.length > 120 || /[\p{Cc}]/u.test(identity.peer)) throw new Error("memory attribution has no agent identity; nothing was run");
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
