import { types } from "node:util";
import { canonicalJSON } from "./generation.ts";
import {
  SyncPlacementJournalError, PLACEMENT_JOURNAL_MAX_RECORDS, placementEpochHash, placementKeyId,
  validatePlacementEpoch, validatePlacementKey, validatePlacementRecord,
  type PlacementEpoch, type PlacementKey, type PlacementRecord, type PlacementHoldReason,
  type PlacementAmbiguousOutcome, type PlacementCommittedOutcome,
} from "./sync-placement-journal-format.ts";

export type PlacementAttemptState = (PlacementAmbiguousOutcome & { status: "ambiguous" }) | (PlacementCommittedOutcome & { status: "committed" });
export interface PlacementProjectedState {
  key: PlacementKey; sourcePlacement: "local" | "synced"; held: boolean; reasons: PlacementHoldReason[];
  exposure: "unknown" | "published"; attempts: PlacementAttemptState[];
}
const copy = (value: PlacementProjectedState): PlacementProjectedState => ({ ...value, key: validatePlacementKey(value.key), reasons: [...value.reasons], attempts: value.attempts.map(attempt => ({ ...attempt })) });
const identity = (key: PlacementKey) => canonicalJSON([key.realm, key.id]);
/** Data projection only. Journal fields and committed-outcome syntax are not person or remote-proof credentials. */
export class PlacementProjection {
  readonly #epochHash: string;
  #sequence = 0;
  #headHash: string;
  readonly #states = new Map<string, PlacementProjectedState>();
  readonly #rowHashes = new Map<string, string>();
  readonly #requests = new Map<string, PlacementRecord>();
  constructor(epoch: PlacementEpoch) { this.#epochHash = placementEpochHash(validatePlacementEpoch(epoch)); this.#headHash = this.#epochHash; }
  get epochHash(): string { return this.#epochHash; }
  get sequence(): number { return this.#sequence; }
  get headHash(): string { return this.#headHash; }
  request(requestId: string): PlacementRecord | undefined { const record = this.#requests.get(requestId); return record ? validatePlacementRecord(record) : undefined; }
  get(key: PlacementKey): PlacementProjectedState | undefined {
    const normalized = validatePlacementKey(key), priorHash = this.#rowHashes.get(identity(normalized));
    if (priorHash !== undefined && priorHash !== normalized.rowHash) throw new SyncPlacementJournalError("conflict");
    const state = this.#states.get(placementKeyId(normalized)); return state ? copy(state) : undefined;
  }
  states(): PlacementProjectedState[] { return [...this.#states].sort(([a], [b]) => a.localeCompare(b)).map(([, state]) => copy(state)); }
  apply(value: unknown): void {
    const record = validatePlacementRecord(value);
    if (record.epochHash !== this.#epochHash) throw new SyncPlacementJournalError("corrupt");
    if (this.#requests.has(record.requestId)) throw new SyncPlacementJournalError("conflict");
    if (record.sequence !== this.#sequence + 1 || record.previousHash !== this.#headHash) throw new SyncPlacementJournalError("corrupt");
    const id = placementKeyId(record.key), rowIdentity = identity(record.key), oldHash = this.#rowHashes.get(rowIdentity);
    if (oldHash !== undefined && oldHash !== record.key.rowHash) throw new SyncPlacementJournalError("conflict");
    const prior = this.#states.get(id), next: PlacementProjectedState = prior ? copy(prior) : {
      key: record.key, sourcePlacement: record.sourcePlacement, held: false, reasons: [], exposure: "unknown", attempts: [],
    };
    next.sourcePlacement = record.sourcePlacement;
    if (record.kind === "hold") next.reasons = [...new Set([...next.reasons, record.reason])].sort();
    else if (record.kind === "release") next.reasons = [];
    else {
      const outcome = record.outcome, at = next.attempts.findIndex(attempt => attempt.attemptHash === outcome.attemptHash), known = next.attempts[at];
      if (known && (known.remoteHash !== outcome.remoteHash || known.refHash !== outcome.refHash)) throw new SyncPlacementJournalError("conflict");
      if (record.kind === "publication-committed") {
        if (known?.status === "committed" && (known.commit !== record.outcome.commit || known.proofHash !== record.outcome.proofHash)) throw new SyncPlacementJournalError("conflict");
        const committed: PlacementAttemptState = { ...record.outcome, status: "committed" };
        if (at < 0) next.attempts.push(committed); else next.attempts[at] = committed;
        next.exposure = "published";
      } else if (known?.status !== "committed") {
        const ambiguous: PlacementAttemptState = { ...record.outcome, status: "ambiguous" };
        if (at < 0) next.attempts.push(ambiguous); else next.attempts[at] = ambiguous;
      }
      next.attempts.sort((a, b) => a.attemptHash.localeCompare(b.attemptHash));
    }
    next.held = next.reasons.length > 0;
    // All format/chain/request/source/outcome checks precede mutation: a rejected record never advances the frontier.
    this.#states.set(id, next); this.#rowHashes.set(rowIdentity, record.key.rowHash); this.#requests.set(record.requestId, record);
    this.#sequence = record.sequence; this.#headHash = record.seal;
  }
}
export function rebuildPlacementProjection(epoch: PlacementEpoch, records: readonly unknown[]): PlacementProjection {
  if (types.isProxy(records) || !Array.isArray(records) || Object.getPrototypeOf(records) !== Array.prototype || Object.getOwnPropertySymbols(records).length || records.length > PLACEMENT_JOURNAL_MAX_RECORDS) throw new SyncPlacementJournalError("bound");
  if (Object.getOwnPropertyNames(records).length !== records.length + 1) throw new SyncPlacementJournalError("invalid");
  const result = new PlacementProjection(epoch);
  for (let index = 0; index < records.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(records, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new SyncPlacementJournalError("invalid");
    result.apply(descriptor.value);
  }
  return result;
}
