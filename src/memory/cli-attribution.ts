import { AsyncLocalStorage } from "node:async_hooks";

/** CLI labels are attribution, never authentication or permission to bypass policy. */
export interface CliAttribution { actor: "person" | "agent"; peer: string; policy?: () => { screenStandalone(value: unknown): boolean } }
const scope = new AsyncLocalStorage<Readonly<CliAttribution>>();

/** Preserve library defaults outside an ordinary CLI invocation, including concurrent calls. */
export function cliAttribution(): Readonly<CliAttribution> | undefined { return scope.getStore(); }
export function withCliAttribution<T>(identity: CliAttribution, work: () => T): T { return scope.run(Object.freeze({ ...identity, peer: identity.actor === "agent" && identity.peer === "person" ? "agent" : identity.peer }), work); }

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
