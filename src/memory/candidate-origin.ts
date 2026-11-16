/**
 * #323: where a candidate came from, as ids only. The proposing host supplies them; nothing is inferred from capture.
 * Stored in its own nullable `candidates.origin` column, outside the hashed payload, so a candidate id and every older reader
 * (which selects named columns or ignores unknown ones) are unchanged. A row written before 0.28 has no origin: `unknown`.
 */
export interface CandidateOrigin {
  /** The capture session key: 16 lowercase hex, the same `session` a capture row carries. */
  session?: string;
  /** The proposing agent's peer id. */
  peer?: string;
  /** When the proposal was made, canonical UTC. */
  at?: string;
  /** An opaque host turn id. */
  turn?: string;
}
const SESSION = /^[a-f0-9]{16}$/, ID = /^[A-Za-z0-9._:@-]{1,120}$/;

/** Ids only: a field that is not a bounded id is refused, so no text, path or secret can enter `origin`. */
export function validOrigin(value: unknown): CandidateOrigin | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid candidate origin");
  const keys = Object.keys(value), raw = value as Record<string, unknown>;
  if (keys.some(key => !["session", "peer", "at", "turn"].includes(key))) throw new Error("invalid candidate origin field");
  const out: CandidateOrigin = {};
  if (raw.session !== undefined) { if (typeof raw.session !== "string" || !SESSION.test(raw.session)) throw new Error("candidate origin session must be a 16-hex capture session key"); out.session = raw.session; }
  if (raw.peer !== undefined) { if (typeof raw.peer !== "string" || !ID.test(raw.peer)) throw new Error("candidate origin peer must be an id"); out.peer = raw.peer; }
  if (raw.turn !== undefined) { if (typeof raw.turn !== "string" || !ID.test(raw.turn)) throw new Error("candidate origin turn must be an id"); out.turn = raw.turn; }
  if (raw.at !== undefined) {
    if (typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at)) || new Date(raw.at).toISOString() !== raw.at) throw new Error("candidate origin time must be canonical UTC");
    out.at = raw.at;
  }
  return Object.keys(out).length ? out : undefined;
}

/** One line for previews and the note provenance; absent fields read `unavailable`, never a guess. */
export function originLine(origin: CandidateOrigin | undefined, known = true): string {
  if (!known) return "origin: unknown (proposed before origin was recorded)";
  if (!origin) return "origin: unavailable";
  return `origin: session ${origin.session ?? "unavailable"}, peer ${origin.peer ?? "unavailable"}, at ${origin.at ?? "unavailable"}${origin.turn ? `, turn ${origin.turn}` : ""}`;
}
