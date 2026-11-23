/**
 * Application-specific text helpers for person-facing CLI output (#125).
 * Color is decoration only: every caller also prints a textual label, so plain output carries the same facts.
 * JSON output never passes through this module.
 */
import { MARKERS, SECTION_MARKER, SGR_RESET, cellWidth, markerCell, paint, type MarkerName } from "@staix/cli-output";

export interface Style {
  readonly color: boolean;
  readonly ascii: boolean;
  ok(text: string): string;
  attention(text: string): string;
  error(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

export function section(s: Style, name: string): string {
  return paint([{ role: "section", text: `${s.ascii ? SECTION_MARKER.ascii : SECTION_MARKER.glyph} ${name}` }], s.color);
}

/** Wrap report prose at a stream's requested width; a pipe without COLUMNS remains unwrapped. */
// ponytail: this renderer receives already-painted strings; migrate producers to structured spans under #590.
export function wrapReport(text: string, width: number | undefined): string {
  if (!Number.isSafeInteger(width) || width === undefined || width < 20) return text;
  const ansi = new RegExp(`${SGR_RESET[0]}\\[[0-9;]*m`, "g");
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
      for (const part of word.match(new RegExp(`${SGR_RESET[0]}\\[[0-9;]*m|.`, "gu")) ?? []) {
        if (measure(row + part) > width) { result.push(row); row = continuation; }
        row += part;
      }
    }
    if (row.trim()) result.push(row);
    return result;
  }).join("\n");
}

export function style(color: boolean, ascii = true): Style {
  return { color, ascii, ok: text => paint([{ role: "success", text }], color), attention: text => paint([{ role: "warning", text }], color),
    error: text => paint([{ role: "error", text }], color), dim: text => paint([{ role: "hint", text }], color), bold: text => paint([{ role: "value", text }], color) };
}
export const PLAIN: Style = style(false);

/** Data stays on one human-output row and cannot inject terminal or bidirectional controls. */
export const singleLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");

/** Status label, padded so the columns line up; the word is always present. */
export function label(s: Style, state: "ok" | "attention" | "skipped" | "unavailable" | "error"): string {
  const word = { ok: "OK", attention: "ATTENTION", skipped: "SKIPPED", unavailable: "UNAVAILABLE", error: "ERROR" }[state].padEnd(11);
  const marker: MarkerName = state === "ok" ? "ok" : state === "attention" ? "warn" : state === "skipped" ? "absent" : state === "unavailable" ? "unknown" : "fail";
  const text = `${markerCell(marker, s.ascii)} ${word}`;
  return `  ${paint([{ role: MARKERS[marker].role, text }], s.color)}`;
}

/** "key value" pairs, leaving out zero, empty and null values; returns "" when nothing material is left. */
export function facts(values: Record<string, unknown>): string {
  return Object.entries(values).filter(([, value]) => value !== 0 && value !== null && value !== undefined && value !== false && value !== ""
    && !(Array.isArray(value) && value.length === 0) && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0))
    .map(([key, value]) => `${key} ${typeof value === "object" ? Array.isArray(value) ? value.join(", ") : JSON.stringify(value) : String(value)}`).join(", ");
}
