import { types } from "node:util";

export type InspectionBoundKind = "bytes" | "rows" | "source-files" | "metadata-bytes" | "row-bytes" | "retained-identities";
export interface InspectionBound { kind: InspectionBoundKind; limit: number; observed: number }
export interface InspectionBoundReceipt extends InspectionBound { nextStep: string }
export class InspectionBoundError extends Error {
  readonly code = "input-bound";
  constructor(readonly bound: InspectionBound) { super("inspection memory or row bound exceeded"); }
}
const kinds = new Set<string>(["bytes", "rows", "source-files", "metadata-bytes", "row-bytes", "retained-identities"]);
/** Only allowlisted own data properties cross an incomplete receipt; caller exceptions are untrusted. */
export function inspectionBoundReceipt(error: unknown): InspectionBoundReceipt | undefined {
  try {
    if (!error || typeof error !== "object" || types.isProxy(error)) return undefined;
    const value = (object: object, key: string) => Object.getOwnPropertyDescriptor(object, key)?.value;
    const raw = value(error, "bound"), structured = raw && typeof raw === "object" && !types.isProxy(raw);
    const kind = structured ? value(raw, "kind") : raw;
    const limit = value(structured ? raw : error, "limit"), observed = value(structured ? raw : error, "observed");
    if (typeof kind !== "string" || !kinds.has(kind) || !Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(observed) || observed < 0) return undefined;
    const nextStep = kind === "row-bytes"
      ? "Retain the source row and request a larger-row streaming protocol or a person-reviewed generation migration before retrying."
      : kind === "metadata-bytes" || kind === "source-files" || kind === "retained-identities"
        ? "Retain the inputs and use a person-reviewed shard or generation migration to reduce this target's retained history, then reopen and inspect again."
        : "Use a person-reviewed shard or placement migration to reduce this target's input, then reopen and inspect again.";
    return { kind: kind as InspectionBoundKind, limit, observed, nextStep };
  } catch { return undefined; }
}
