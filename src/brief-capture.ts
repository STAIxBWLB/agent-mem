import type { CaptureRow, CaptureStore } from "./memory/capture.ts";
import { configuredPolicyOptions, loadAmemConfig, repoConfigRoot } from "./memory/config.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "./memory/policy.ts";
import { writeBriefCache, type BriefCacheRow } from "./brief-cache.ts";

/** Bound display values only after complete-row policy; flatten controls before serialization. */
export function displayText(text: string, maximum: number): { text: string; partial: boolean } {
  const flattened = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
  let out = "", bytes = 0;
  for (const character of flattened) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximum) return { text: out, partial: true };
    out += character; bytes += size;
  }
  return { text: out, partial: flattened !== text };
}
export function captureDisplay(row: CaptureRow): { data: unknown; partial: boolean } {
  const excerpt = displayText(row.excerpt, 240), event = displayText(row.event, 64);
  const paths = row.paths.slice(0, 2).map(path => displayText(path, 80));
  return { data: { id: row.id, at: row.at, event: event.text, paths: paths.map(path => path.text), excerpt: excerpt.text },
    partial: excerpt.partial || event.partial || row.paths.length > paths.length || paths.some(path => path.partial) };
}
export interface CaptureBriefOptions { base: string; project: string; cwd: string; builtThrough: number; policy?: StandalonePolicyOptions }
/** Reuse the library's #201 summary query, full-row screen, two-row selection and display. */
export async function buildCaptureBriefCache(store: CaptureStore, options: CaptureBriefOptions): Promise<void> {
  const policy = createStandalonePolicy(configuredPolicyOptions(options.base, options.cwd, options.policy));
  const maximum = Math.min(1200, loadAmemConfig(options.base, repoConfigRoot(options.cwd)).config.briefBytes ?? 1200);
  const summaries = store.readBriefSummaries(), rows: BriefCacheRow[] = [];
  let partial = summaries.partial, remaining = maximum;
  for (const source of summaries.rows) {
    if (source.project !== options.project || source.subagent === true || !await policy.screen(source)) continue;
    if (rows.length >= 2) break;
    const shown = captureDisplay(source);
    if (!await policy.screen(shown.data)) continue;
    const bytes = Buffer.byteLength(JSON.stringify({ section: "capture", evidence: false, data: shown.data })) + 1;
    if (bytes > remaining || bytes > 768 + 1) { partial = true; continue; }
    rows.push({ source, ...shown }); remaining -= bytes; partial ||= shown.partial;
  }
  writeBriefCache({ directory: store.dir, project: options.project, section: "capture" }, {
    schema: "agent-mem.brief-cache/v1", project: options.project, section: "capture", builtThrough: options.builtThrough, partial, rows,
  });
}

/** Cache files are untrusted derived data: require the same project and canonical summary display. */
export function validCachedCapture(row: BriefCacheRow, project: string): boolean {
  const source = row.source as CaptureRow | null;
  if (!source || source.project !== project || source.subagent === true || !["Recap", "Compact"].includes(source.event)
    || !Number.isSafeInteger(source.id) || source.id < 1 || typeof source.at !== "string" || !Number.isFinite(Date.parse(source.at))
    || typeof source.excerpt !== "string" || !Array.isArray(source.paths) || source.paths.some(value => typeof value !== "string")) return false;
  const shown = captureDisplay(source);
  return JSON.stringify(shown.data) === JSON.stringify(row.data) && shown.partial === row.partial;
}
