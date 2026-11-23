/**
 * Application-specific text helpers for person-facing CLI output (#125).
 * Color is decoration only: every caller also prints a textual label, so plain output carries the same facts.
 * JSON output never passes through this module.
 */
import { MARKERS, SECTION_MARKER, SGR_RESET, cellWidth, markerCell, paint, Report, type MarkerName } from "@staix/cli-output";

import type { View } from "./store.ts";

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

/** #590 C2: a past or future ISO time relative to `now` ("just now", "5 min ago", "3 h ago", "2 d ago", "in 4 d"); `--json` keeps the exact value. */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown time";
  const delta = now - at, abs = Math.abs(delta), minute = 60_000, hour = 60 * minute, day = 24 * hour;
  if (abs < minute) return "just now";
  const amount = abs < hour ? `${Math.floor(abs / minute)} min` : abs < day ? `${Math.floor(abs / hour)} h` : `${Math.floor(abs / day)} d`;
  return delta >= 0 ? `${amount} ago` : `in ${amount}`;
}

/** #590 C3: a byte count in binary units ("812 B", "5.7 KiB", "2.0 MiB"). */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** #590 C1: `identicalGroups` -> `identical groups`, `cap_mb` -> `cap mb`; human rows never print a raw key. */
export const wordedKey = (key: string): string => key.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/** #590 C1: worded "label value" pairs without JSON; zero, empty and null values are left out, as in `facts`. */
export function wordedFacts(values: Record<string, unknown>): string {
  return Object.entries(values).filter(([, value]) => value !== 0 && value !== null && value !== undefined && value !== false && value !== ""
    && !(Array.isArray(value) && value.length === 0) && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0))
    .map(([key, value]) => `${wordedKey(key)} ${typeof value === "object" && !Array.isArray(value) ? wordedFacts(value as Record<string, unknown>) : Array.isArray(value) ? value.join(", ") : value === true ? "yes" : String(value)}`).join(", ");
}

/** "key value" pairs, leaving out zero, empty and null values; returns "" when nothing material is left. */
export function facts(values: Record<string, unknown>): string {
  return Object.entries(values).filter(([, value]) => value !== 0 && value !== null && value !== undefined && value !== false && value !== ""
    && !(Array.isArray(value) && value.length === 0) && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0))
    .map(([key, value]) => `${key} ${typeof value === "object" ? Array.isArray(value) ? value.join(", ") : JSON.stringify(value) : String(value)}`).join(", ");
}

export const CLI_MEMORY_RENDER = Symbol("cli-memory-render");
export interface HumanMemoryRow { id: string; kind: string; at: string; text: string; project?: string; tier?: string; peer?: string; scope?: string; flags?: readonly string[] }
export interface HumanMemoryRender { columns?: number; style?: Style; now?: number; actor?: "person" | "agent" }
type HumanRender = HumanMemoryRender;
function clipCells(value: string, limit: number): string {
  const text = singleLine(value).replace(/\s+/g, " ").trim();
  if (cellWidth(text) <= limit) return text;
  let out = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (cellWidth(out + segment + "...") > limit) break;
    out += segment;
  }
  return out.trimEnd() + "...";
}

/** Render only rows already selected and screened by the caller. */
export function memoryTableText(rows: readonly HumanMemoryRow[], title: string, render: HumanRender = {}, context?: string): string {
  const width = Math.max(20, render.columns ?? 80), s = render.style ?? PLAIN, report = new Report(width, s.ascii, { sanitize: singleLine });
  const tier = (row: HumanMemoryRow) => row.tier ? `${row.tier}${row.scope === "shared" ? "*" : ""}` : undefined;
  const details = (row: HumanMemoryRow): string[] => [tier(row), row.peer, ...(row.flags ?? [])].filter((value): value is string => !!value);
  report.header("amem", title); if (context) report.line(context); report.section("Entries", String(rows.length));
  if (!rows.length) report.line("  No entries.");
  else if (width < 65) report.table(["ID", "TEXT"], rows.flatMap(row => [[displayMemoryId(row.id, 12), clipCells(`${row.project ? `${row.project}: ` : ""}${row.text}`, Math.max(3, width - 18))], ...details(row).map(detail => ["", detail])]), 1, { widths: [12, Math.max(3, width - 18)], emptyCell: "blank" });
  else if (rows.some(row => row.project)) {
    const textWidth = Math.max(3, width - 54);
    report.table(["PROJECT", "ID", "KIND", "WHEN", "TEXT"], rows.flatMap(row => [[clipCells(row.project ?? "", 16), displayMemoryId(row.id, 12), clipCells(row.kind, 8), clipCells(relativeTime(row.at, render.now ?? Date.now()), 8), clipCells(row.text, textWidth)], ...details(row).map(detail => ["", "", "", "", detail])]), 4, { widths: [16, 12, 8, 8, textWidth], emptyCell: "blank" });
  }
  else {
    const textWidth = Math.max(3, width - 59);
    report.table(["ID", "KIND", "TIER", "PEER", "WHEN", "TEXT"], rows.flatMap(row => [[displayMemoryId(row.id, 13), clipCells(row.kind, 10), clipCells(tier(row) ?? "-", 6), clipCells(row.peer ?? "-", 8), clipCells(relativeTime(row.at, render.now ?? Date.now()), 10), clipCells(row.text, textWidth)], ...(row.flags ?? []).map(flag => ["", "", "", "", "", flag])]), 5, { widths: [13, 10, 6, 8, 10, textWidth], emptyCell: "blank" });
  }
  if (rows.some(row => row.tier && row.scope === "shared")) report.note("* marks shared scope.");
  if (rows.length) report.note("Full text: amem show <id> or --json.");
  return report.render(s.color).join("\n");
}

function displayMemoryId(id: string, limit: number): string {
  return /^(?:repo:)?[a-f0-9]{16,}$/.test(id) ? id.slice(0, limit) : clipCells(id, limit);
}

export function memoryRecordText(row: HumanMemoryRow, render: HumanRender = {}, fields: readonly (readonly [string, string])[] = []): string {
  const s = render.style ?? PLAIN, report = new Report(render.columns ?? 80, s.ascii, { sanitize: text => text.replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, " ") });
  report.header("amem", "Memory"); report.section("Entry");
  report.kv([["ID", row.id], ["Kind", row.kind], ["When", relativeTime(row.at, render.now ?? Date.now())], ...fields]);
  report.section("Text"); report.line(row.text);
  return report.render(s.color).join("\n");
}

export function memoryScoresText(rows: readonly { id: string; details: Record<string, unknown> }[], render: HumanRender = {}): string {
  if (!rows.length) return "";
  const s = render.style ?? PLAIN, report = new Report(render.columns ?? 80, s.ascii, { sanitize: singleLine });
  report.section("Scores");
  report.kv(rows.map(row => [displayMemoryId(row.id, 16), Object.entries(row.details).map(([key, value]) => `${wordedKey(key)} ${value === null || value === undefined ? "-" : String(value)}`).join(", ")]));
  return report.render(s.color).join("\n");
}

export function memoryDetailText(view: View, render: HumanRender = {}): string {
  const s = render.style ?? PLAIN, report = new Report(render.columns ?? 80, s.ascii, { sanitize: text => text.replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, " ") });
  const stale = view as View & { stale?: boolean; staleReason?: string };
  report.header("amem", "Memory"); report.section("Entry");
  report.kv([["ID", view.id], ["Kind", view.kind], ["Tier", view.tier], ["When", relativeTime(view.at, render.now ?? Date.now())], ["Peer", view.peer], ["Scope", view.scope], ["Project", view.project], ["Machine", view.machine], ...(render.actor ? [["Actor", render.actor] as [string, string]] : []), ...(stale.stale ? [["Stale", stale.staleReason?.replace(/_/g, " ") ?? "yes"] as [string, string]] : []), ...(view.task ? [["Task", view.task] as [string, string]] : []), ...(view.expiresAt ? [["Expires", relativeTime(view.expiresAt, render.now ?? Date.now())] as [string, string]] : []), ...(view.promotedFrom ? [["Promoted from", view.promotedFrom] as [string, string]] : []), ...(view.supersededBy ? [["Superseded by", view.supersededBy] as [string, string]] : []), ...(view.about.length ? [["About", view.about.join(", ")] as [string, string]] : [])]);
  report.section("Text"); if (view.title) report.line(view.title); report.line(view.text);
  return report.render(s.color).join("\n");
}
