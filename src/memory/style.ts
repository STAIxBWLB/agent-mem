/**
 * A tiny, dependency-free text style for person-facing CLI output (#125).
 * Color is decoration only: every caller also prints a textual label, so plain output carries the same facts.
 * JSON output never passes through this module.
 */
export interface Style {
  readonly color: boolean;
  readonly ascii: boolean;
  ok(text: string): string;
  attention(text: string): string;
  error(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

/** Portable CLI output standard v1 vocabulary. */
export type Role = "header" | "section" | "key" | "value" | "success" | "warning" | "error" | "hint" | "accent";
const ESC = String.fromCharCode(27);
export const SGR_RESET = `${ESC}[0m`;
export const ROLE_SGR: Readonly<Record<Role, string>> = Object.freeze({
  header: `${ESC}[1;34m`, section: `${ESC}[1;35m`, key: `${ESC}[34m`, value: "",
  success: `${ESC}[1;32m`, warning: `${ESC}[1;33m`, error: `${ESC}[1;31m`,
  hint: `${ESC}[90m`, accent: `${ESC}[36m`,
});
export const MARKER_NAMES = ["ok", "fail", "warn", "absent", "unknown", "pending", "active", "next"] as const;
export type MarkerName = (typeof MARKER_NAMES)[number];
export const MARKERS: Readonly<Record<MarkerName, { glyph: string; ascii: string; role: Role }>> = Object.freeze({
  ok: { glyph: "✓", ascii: "ok", role: "success" }, fail: { glyph: "✗", ascii: "x", role: "error" },
  warn: { glyph: "⚠", ascii: "!", role: "warning" }, absent: { glyph: "-", ascii: "-", role: "hint" },
  unknown: { glyph: "?", ascii: "?", role: "hint" }, pending: { glyph: "~", ascii: "~", role: "hint" },
  active: { glyph: "*", ascii: "*", role: "success" }, next: { glyph: "→", ascii: "->", role: "accent" },
});
export const SECTION_MARKER = { glyph: "▸", ascii: ">" } as const;
export const MARKER_COLUMN = 2;
export const cellWidth = (text: string): number => Bun.stringWidth(text, { ambiguousIsNarrow: true });
export function markerCell(name: MarkerName, ascii: boolean): string {
  const text = ascii ? MARKERS[name].ascii : MARKERS[name].glyph;
  return text + " ".repeat(Math.max(0, MARKER_COLUMN - cellWidth(text)));
}
export interface ColorEnv { isTTY: boolean; TERM?: string; NO_COLOR?: string; FORCE_COLOR?: string; CLICOLOR?: string; CLICOLOR_FORCE?: string }
export function streamEnv(isTTY: boolean, env: Readonly<Record<string, string | undefined>> = process.env): ColorEnv {
  return { isTTY, TERM: env.TERM, NO_COLOR: env.NO_COLOR, FORCE_COLOR: env.FORCE_COLOR, CLICOLOR: env.CLICOLOR, CLICOLOR_FORCE: env.CLICOLOR_FORCE };
}
export function resolveColor(flag: string | undefined, env: ColorEnv): boolean | Error {
  if (flag === "always") return true;
  if (flag === "never") return false;
  if (flag !== undefined && flag !== "auto") return new Error("usage: amem <command> [--color=auto|always|never]");
  if (env.NO_COLOR) return false;
  if ((env.FORCE_COLOR && env.FORCE_COLOR !== "0") || (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== "0")) return true;
  if (env.FORCE_COLOR === "0" || env.CLICOLOR === "0") return false;
  return env.isTTY && env.TERM !== "dumb";
}
export function asciiMarkers(env: Readonly<Record<string, string | undefined>> = process.env, flag = false): boolean {
  return flag || !/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "");
}
export function paint(role: Role, text: string, color: boolean): string {
  return color && ROLE_SGR[role] ? `${ROLE_SGR[role]}${text}${SGR_RESET}` : text;
}
export function section(s: Style, name: string): string {
  return paint("section", `${s.ascii ? SECTION_MARKER.ascii : SECTION_MARKER.glyph} ${name}`, s.color);
}

/** Wrap report prose at a stream's requested width; a pipe without COLUMNS remains unwrapped. */
export function wrapReport(text: string, width: number | undefined): string {
  if (!Number.isSafeInteger(width) || width === undefined || width < 20) return text;
  const ansi = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
  const measure = (value: string) => cellWidth(value.replace(ansi, ""));
  return text.split("\n").flatMap(line => {
    if (measure(line) <= width) return [line];
    const indent = line.match(/^ */)?.[0] ?? "", continuation = "    ";
    const words = line.slice(indent.length).match(/\S+|\s+/g) ?? [];
    const result: string[] = [];
    let row = indent;
    let spacing = "";
    for (const word of words) {
      if (/^\s+$/.test(word)) { spacing = word; continue; }
      if (measure(row + spacing + word) > width && row.trim()) { result.push(row); row = continuation; spacing = ""; }
      if (measure(row + spacing + word) <= width) { row += spacing + word; spacing = ""; continue; }
      row += spacing; spacing = "";
      // Long unbroken values are continued without truncation; --json retains their exact bytes.
      for (const part of word.match(new RegExp(`${ESC}\\[[0-9;]*m|.`, "gu")) ?? []) {
        if (measure(row + part) > width) { result.push(row); row = continuation; }
        row += part;
      }
    }
    if (row.trim()) result.push(row);
    return result;
  }).join("\n");
}

/** Default color decision for one stream, following the shared precedence table. */
export function colorEnabled(env: Readonly<Record<string, string | undefined>>, isTTY: boolean | undefined): boolean {
  return resolveColor("auto", streamEnv(isTTY === true, env)) === true;
}

export function style(color: boolean, ascii = true): Style {
  return { color, ascii, ok: text => paint("success", text, color), attention: text => paint("warning", text, color),
    error: text => paint("error", text, color), dim: text => paint("hint", text, color), bold: text => paint("value", text, color) };
}
export const PLAIN: Style = style(false);

/** Data stays on one human-output row and cannot inject terminal or bidirectional controls. */
export const singleLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");

/** Status label, padded so the columns line up; the word is always present. */
export function label(s: Style, state: "ok" | "attention" | "skipped" | "unavailable" | "error"): string {
  const word = { ok: "OK", attention: "ATTENTION", skipped: "SKIPPED", unavailable: "UNAVAILABLE", error: "ERROR" }[state].padEnd(11);
  const marker: MarkerName = state === "ok" ? "ok" : state === "attention" ? "warn" : state === "skipped" ? "absent" : state === "unavailable" ? "unknown" : "fail";
  const text = `${markerCell(marker, s.ascii)} ${word}`;
  return `  ${paint(MARKERS[marker].role, text, s.color)}`;
}

/** "key value" pairs, leaving out zero, empty and null values; returns "" when nothing material is left. */
export function facts(values: Record<string, unknown>): string {
  return Object.entries(values).filter(([, value]) => value !== 0 && value !== null && value !== undefined && value !== false && value !== ""
    && !(Array.isArray(value) && value.length === 0) && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0))
    .map(([key, value]) => `${key} ${typeof value === "object" ? Array.isArray(value) ? value.join(", ") : JSON.stringify(value) : String(value)}`).join(", ");
}
