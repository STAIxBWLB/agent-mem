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
import { looksSecret } from "./screen.ts";
const SESSION = /^[a-f0-9]{16}$/, ID = /^[A-Za-z0-9._:@-]{1,120}$/;

/** Ids only: a field that is not a bounded id is refused, so no text, path or secret can enter `origin`. */
export function validOrigin(value: unknown): CandidateOrigin | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("candidate origin must be an object; supply session, peer, at or turn ids");
  const keys = Object.keys(value), raw = value as Record<string, unknown>;
  if (keys.some(key => !["session", "peer", "at", "turn"].includes(key))) throw new Error("candidate origin has an unknown field; use only session, peer, at and turn");
  const out: CandidateOrigin = {};
  if (raw.session !== undefined) { if (typeof raw.session !== "string" || !SESSION.test(raw.session)) throw new Error("candidate origin session must be a 16-character lowercase hex capture session key; pass the capture session key"); out.session = raw.session; }
  if (raw.peer !== undefined) { if (typeof raw.peer !== "string" || !ID.test(raw.peer)) throw new Error("candidate origin peer must be 1 to 120 characters from A-Z, a-z, 0-9, dot, underscore, colon, at sign or hyphen; pass a peer id"); out.peer = raw.peer; }
  if (raw.turn !== undefined) { if (typeof raw.turn !== "string" || !ID.test(raw.turn)) throw new Error("candidate origin turn must be 1 to 120 characters from A-Z, a-z, 0-9, dot, underscore, colon, at sign or hyphen; pass a turn id"); out.turn = raw.turn; }
  if (raw.at !== undefined) {
    if (typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at)) || new Date(raw.at).toISOString() !== raw.at) throw new Error("candidate origin time must be canonical UTC; pass an ISO timestamp with milliseconds and Z");
    out.at = raw.at;
  }
  // AC3: the unchanged secret screen applies to the ids too; an id shaped like a token is refused, never stored.
  if (Object.values(out).some(value => looksSecret(value))) throw new Error("candidate origin refused by the secret screen; remove the secret-like id and pass a safe session or peer id");
  return Object.keys(out).length ? out : undefined;
}

/** #323 AC1: every supplied origin field as an ids-only graph node, so an accepted note keeps the whole origin. */
export function originNodes(origin: CandidateOrigin | undefined): string[] {
  if (!origin) return [];
  return [...(origin.session ? [`session:${origin.session}`] : []), ...(origin.peer ? [`peer:${origin.peer}`] : []),
    ...(origin.at ? [`origin-at:${origin.at}`] : []), ...(origin.turn ? [`turn:${origin.turn}`] : [])];
}

export type OriginRecheck = "available" | "origin expired" | "unavailable" | "unknown";
/**
 * #323 item 4: whether a note's origin session can still be re-checked against capture. Only a confirmed absence from a readable,
 * session-capable store is `origin expired` (never a failed check). An unreadable, missing, unsupported or policy-withheld capture is
 * `unavailable`, so expiry is never claimed and withheld rows are never disclosed; no recorded session is `unavailable` too.
 */
export function originRecheck(origin: CandidateOrigin | undefined, known: boolean, lookup: (session: string) => "present" | "absent" | "unavailable" | "unsupported"): OriginRecheck {
  if (!known) return "unknown";
  if (!origin?.session) return "unavailable";
  let state: ReturnType<typeof lookup>; try { state = lookup(origin.session); } catch { return "unavailable"; }
  return state === "present" ? "available" : state === "absent" ? "origin expired" : "unavailable";
}

/** One line for previews and the note provenance; absent fields read `unavailable`, never a guess. */
export function originLine(origin: CandidateOrigin | undefined, known = true): string {
  if (!known) return "origin: unknown (proposed before origin was recorded)";
  if (!origin) return "origin: unavailable";
  return `origin: session ${origin.session ?? "unavailable"}, peer ${origin.peer ?? "unavailable"}, at ${origin.at ?? "unavailable"}${origin.turn ? `, turn ${origin.turn}` : ""}`;
}
