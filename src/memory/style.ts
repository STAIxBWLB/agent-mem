/**
 * A tiny, dependency-free text style for person-facing CLI output (#125).
 * Color is decoration only: every caller also prints a textual label, so plain output carries the same facts.
 * JSON output never passes through this module.
 */
export interface Style {
  readonly color: boolean;
  ok(text: string): string;
  attention(text: string): string;
  error(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

/** Color only for an interactive stdout, and never with NO_COLOR (any value, per no-color.org) or TERM=dumb. */
export function colorEnabled(env: Readonly<Record<string, string | undefined>>, isTTY: boolean | undefined): boolean {
  return isTTY === true && env.NO_COLOR === undefined && env.TERM !== "dumb";
}

const wrap = (on: boolean, open: number, close: number) => (text: string) => on ? `\x1b[${open}m${text}\x1b[${close}m` : text;
export function style(color: boolean): Style {
  return { color, ok: wrap(color, 32, 39), attention: wrap(color, 33, 39), error: wrap(color, 31, 39), dim: wrap(color, 2, 22), bold: wrap(color, 1, 22) };
}
export const PLAIN: Style = style(false);

/** Data stays on one human-output row and cannot inject terminal or bidirectional controls. */
export const singleLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");

/** Status label, padded so the columns line up; the word is always present. */
export function label(s: Style, state: "ok" | "attention" | "skipped" | "unavailable" | "error"): string {
  const word = { ok: "OK", attention: "ATTENTION", skipped: "SKIPPED", unavailable: "UNAVAILABLE", error: "ERROR" }[state].padEnd(11);
  return state === "ok" ? s.ok(word) : state === "attention" ? s.attention(word) : state === "skipped" ? s.dim(word) : s.error(word);
}

/** "key value" pairs, leaving out zero, empty and null values; returns "" when nothing material is left. */
export function facts(values: Record<string, unknown>): string {
  return Object.entries(values).filter(([, value]) => value !== 0 && value !== null && value !== undefined && value !== false && value !== ""
    && !(Array.isArray(value) && value.length === 0) && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0))
    .map(([key, value]) => `${key} ${typeof value === "object" ? Array.isArray(value) ? value.join(", ") : JSON.stringify(value) : String(value)}`).join(", ");
}
