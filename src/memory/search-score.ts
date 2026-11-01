/** One fixed score recipe for numeric library ranking and native screened SQL. */
export interface ScoreFactors {
  rawBm25Rank: number | null;
  tierFactor: number | null;
  recencyFactor: number | null;
  finalScore: number | null;
  matchMode: "fts5" | "substring";
}
export interface SearchScoreDetails extends ScoreFactors { source: "curated" | "capture" | "repo" }

type ScoreExpr = { op: "rank" | "tier" | "age" } | { op: "constant"; value: number }
  | { op: "negative" | "reciprocal"; value: ScoreExpr }
  | { op: "add" | "multiply" | "max"; left: ScoreExpr; right: ScoreExpr };
const MONTH_DAYS = 30;
const TIER_WEIGHTS: Readonly<Record<string, number>> = { long: 1, capture: 0.5 };
const DEFAULT_TIER_WEIGHT = 0.9;
// ponytail: fixed 1.25x ceiling for conversational capture, not a learned relevance model.
// Raise it only with fresh S/M no-loss and private-capture evidence; curated tier factors stay unchanged.
export const CAPTURE_CONVERSATION_WEIGHT = 1.25;
const CONVERSATIONAL_CAPTURE_EVENTS = ["Stop", "UserPromptSubmit", "Title", "Recap", "Compact"] as const;
export function captureEventWeight(event: string): number {
  return (CONVERSATIONAL_CAPTURE_EVENTS as readonly string[]).includes(event) ? CAPTURE_CONVERSATION_WEIGHT : 1;
}
/** Only fixed internal SQL identifiers are supplied by callers; event values remain stored data. */
export function captureEventWeightSql(eventColumn: string): string {
  return `(CASE WHEN ${eventColumn} IN (${CONVERSATIONAL_CAPTURE_EVENTS.map(event => `'${event}'`).join(", ")}) THEN ${CAPTURE_CONVERSATION_WEIGHT} ELSE 1.0 END)`;
}
const TIER_FACTOR: ScoreExpr = { op: "tier" };
const DENOMINATOR: ScoreExpr = { op: "add", left: { op: "constant", value: 1 }, right: { op: "max", left: { op: "constant", value: 0 }, right: { op: "age" } } };
const RECENCY_FACTOR: ScoreExpr = { op: "reciprocal", value: DENOMINATOR };
const SCORE: ScoreExpr = { op: "multiply", left: { op: "multiply", left: { op: "negative", value: { op: "rank" } }, right: TIER_FACTOR }, right: RECENCY_FACTOR };
// ponytail: this represents only the fixed rank/tier/age recipe, not arbitrary expressions;
// extend its operations with numeric/SQL parity tests when the ranking contract changes.
function numeric(expr: ScoreExpr, rank: number, tier: string, at: string, now: number): number {
  switch (expr.op) {
    case "rank": return rank;
    case "tier": return Object.hasOwn(TIER_WEIGHTS, tier) ? TIER_WEIGHTS[tier]! : DEFAULT_TIER_WEIGHT;
    case "age": return (now - Date.parse(at)) / (MONTH_DAYS * 24 * 3600_000);
    case "constant": return expr.value;
    case "negative": return -numeric(expr.value, rank, tier, at, now);
    case "reciprocal": return 1 / numeric(expr.value, rank, tier, at, now);
    case "add": return numeric(expr.left, rank, tier, at, now) + numeric(expr.right, rank, tier, at, now);
    case "multiply": return numeric(expr.left, rank, tier, at, now) * numeric(expr.right, rank, tier, at, now);
    case "max": return Math.max(numeric(expr.left, rank, tier, at, now), numeric(expr.right, rank, tier, at, now));
  }
}
const real = (value: number): string => Number.isInteger(value) ? `${value}.0` : String(value);
function sql(expr: ScoreExpr, rank: string): string {
  const get = (part: ScoreExpr): string => sql(part, rank);
  switch (expr.op) {
    case "rank": return rank;
    case "tier": return `CASE tier ${Object.entries(TIER_WEIGHTS).map(([name, value]) => `WHEN '${name}' THEN ${real(value)}`).join(" ")} ELSE ${real(DEFAULT_TIER_WEIGHT)} END`;
    case "age": return `((julianday(?) - julianday(at)) / ${real(MONTH_DAYS)})`;
    case "constant": return real(expr.value);
    case "negative": return `(-(${get(expr.value)}))`;
    case "reciprocal": return `(1.0 / ${get(expr.value)})`;
    case "add": return `(${get(expr.left)} + ${get(expr.right)})`;
    // Preserve the existing SQL quotient's floating-point order; numeric ranking
    // retains its original reciprocal product. Both interpret the same recipe.
    case "multiply": return expr.right.op === "reciprocal" ? `(${get(expr.left)} / ${get(expr.right.value)})` : `(${get(expr.left)} * ${get(expr.right)})`;
    case "max": return `max(${get(expr.left)}, ${get(expr.right)})`;
  }
}
export function rankedScore(rank: number, tier: string, at: string, now: number): number {
  return numeric(SCORE, rank, tier, at, now);
}
export function captureWeightedScore(rank: number, event: string, at: string, now: number): number {
  return rankedScore(rank, "capture", at, now) * captureEventWeight(event);
}
/** SQL uses fixed internal identifiers and bound clock values, never interpolated row/query input. */
export function rankedScoreSql(rank = "bm25(docs)"): string { return sql(SCORE, rank); }
export function rankedScoreSqlDetails(rank = "bm25(docs)", useFts = true): { rawBm25Rank: string; tierFactor: string; recencyFactor: string } {
  return { rawBm25Rank: useFts ? rank : "NULL", tierFactor: sql(TIER_FACTOR, rank), recencyFactor: sql(RECENCY_FACTOR, rank) };
}
export function rankedScoreDetails(source: SearchScoreDetails["source"], rank: number, tier: string, at: string, now: number, finalScore: number): SearchScoreDetails {
  return { source, rawBm25Rank: rank, tierFactor: numeric(TIER_FACTOR, rank, tier, at, now), recencyFactor: numeric(RECENCY_FACTOR, rank, tier, at, now), finalScore, matchMode: "fts5" };
}
export function unrankedScoreDetails(source: SearchScoreDetails["source"], finalScore: number | null): SearchScoreDetails {
  return { source, rawBm25Rank: null, tierFactor: null, recencyFactor: null, finalScore, matchMode: "substring" };
}
