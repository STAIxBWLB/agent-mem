import { createStandalonePolicy, type StandalonePolicyOptions } from "./memory/policy.ts";
import { configuredPolicyOptions } from "./memory/config.ts";
import type { MemoryStore, View } from "./memory/store.ts";
import { displayText } from "./brief-capture.ts";
import { BRIEF_CACHE_BYTES, writeBriefCache, type BriefCacheRow } from "./brief-cache.ts";
import { PREFERENCE_SLOT } from "./memory/preference-brief.ts";

const PAGE_ROWS = 32, MAX_PAGES = 4, SECTION_RECORDS = 4, RECORD_BYTES = 768, MAX_AGE = 24 * 60 * 60 * 1000;

/** Canonical curated display shared by the library brief and snapshot writer. */
export function noteDisplay(view: View): { data: unknown; partial: boolean } {
  const body = displayText(view.text, 240), title = view.title === null ? undefined : displayText(view.title, 96);
  return { data: { id: view.id, at: view.at, kind: view.kind, ...(title ? { title: title.text } : {}), text: body.text },
    partial: body.partial || title?.partial === true };
}

export function validCachedCurated(row: BriefCacheRow, project: string, now = Date.now()): boolean {
  const source = row.source as View | null;
  if (!source || source.project !== project || typeof source.id !== "string" || !/^[a-f0-9]{32}$/.test(source.id)
    || typeof source.at !== "string" || !Number.isFinite(Date.parse(source.at)) || typeof source.text !== "string"
    || !(source.title === null || typeof source.title === "string") || typeof source.kind !== "string"
    || source.supersededBy !== null || (source.expiresAt !== null && (!Number.isFinite(Date.parse(source.expiresAt)) || Date.parse(source.expiresAt) <= now))) return false;
  const shown = noteDisplay(source);
  return JSON.stringify(shown.data) === JSON.stringify(row.data) && shown.partial === row.partial;
}

/**
 * #370: the preference slot's rows are this project's own plus any preference shared with every project, so a shared row written under
 * another project is valid here. Liveness, supersession, expiry and the canonical display are the curated rule, reused as-is.
 */
export function validCachedPreference(row: BriefCacheRow, project: string, now = Date.now()): boolean {
  const source = row.source as View | null;
  if (!source || source.kind !== "preference" || (source.project !== project && source.scope !== "shared")) return false;
  return validCachedCurated({ ...row, source: { ...source, project } }, project, now);
}

export function curatedCacheFresh(cache: { curated?: { builtAt: number; binding: string; expiresAt: number | null } }, binding: string, now: number): boolean {
  return briefCacheFresh(cache.curated, binding, now);
}

/** Both prebuilt stamps age the same way: at most 24 hours, and never past a named expiry of a row they carry. */
export function briefCacheFresh(metadata: { builtAt: number; binding: string; expiresAt: number | null } | undefined, binding: string, now: number): boolean {
  return !!metadata && metadata.binding === binding && Number.isFinite(metadata.builtAt) && metadata.builtAt <= now
    && now - metadata.builtAt < MAX_AGE && (metadata.expiresAt === null || Number.isFinite(metadata.expiresAt) && metadata.expiresAt > now);
}

/**
 * #370: the SessionStart preference slot's sidecar, written by the same off-hook preparation as the curated cache and read by the native
 * hook without opening a store. Its own file name, so a released reader neither parses it (it only opens `brief-curated.json`) nor
 * invalidates it; a missed invalidation from such a reader ages out at the same 24-hour bound as the curated cache.
 */
export function buildPreferenceBriefCache(store: Pick<MemoryStore, "readPreferences" | "withDeferredPromotions">,
  options: { base: string; project: string; directory: string; binding: string; cwd?: string; now?: () => number; policy?: StandalonePolicyOptions }): void {
  if (options.policy?.host) throw new Error("prebuilt preference brief requires synchronous standalone policy; remove host policy or use the async session brief");
  const now = (options.now ?? Date.now)(), policy = createStandalonePolicy(configuredPolicyOptions(options.base, options.cwd, options.policy));
  const rows: BriefCacheRow[] = [], expires: number[] = [];
  let partial = false, bytes = Buffer.byteLength(JSON.stringify({ schema: "agent-mem.brief-cache/v1", project: options.project, section: "preferences", builtThrough: 1, partial: false, rows: [], preferences: { builtAt: now, binding: options.binding, expiresAt: null } })) + 1;
  store.withDeferredPromotions(() => {
    // Newest first with no paging: the slot must not hide an old preference behind newer notes of other kinds.
    const page = store.readPreferences(options.project, PREFERENCE_SLOT);
    partial ||= page.truncated;
    for (const source of page.rows) {
      if (!policy.screenStandalone(source)) continue;
      const shown = noteDisplay(source);
      if (!policy.screenStandalone(shown.data)) continue;
      const row = { source, data: shown.data, partial: shown.partial }, rowBytes = Buffer.byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0);
      const displayBytes = Buffer.byteLength(JSON.stringify({ section: "curated", evidence: true, data: shown.data })); // the brief emits these as curated evidence lines
      if (displayBytes > RECORD_BYTES || bytes + rowBytes > BRIEF_CACHE_BYTES) { partial = true; continue; }
      rows.push(row); bytes += rowBytes; partial ||= shown.partial;
      if (source.expiresAt !== null) expires.push(Date.parse(source.expiresAt));
    }
  });
  const expiresAt = expires.length ? Math.min(...expires) : null;
  writeBriefCache({ directory: options.directory, project: options.project, section: "preferences" }, {
    schema: "agent-mem.brief-cache/v1", project: options.project, section: "preferences", builtThrough: Math.max(1, now), partial, rows,
    preferences: { builtAt: now, binding: options.binding, expiresAt },
  });
}

export function buildCuratedBriefCache(store: Pick<MemoryStore, "readPage" | "withDeferredPromotions">,
  options: { base: string; project: string; directory: string; binding: string; cwd?: string; now?: () => number; policy?: StandalonePolicyOptions }): void {
  if (options.policy?.host) throw new Error("prebuilt curated brief requires synchronous standalone policy; remove host policy or use the async session brief");
  const now = (options.now ?? Date.now)(), policy = createStandalonePolicy(configuredPolicyOptions(options.base, options.cwd, options.policy));
  const rows: BriefCacheRow[] = [], expires: number[] = [];
  let partial = false, after: { position: number; id: string } | undefined, complete = false;
  let bytes = Buffer.byteLength(JSON.stringify({ schema: "agent-mem.brief-cache/v1", project: options.project, section: "curated", builtThrough: 1, partial: false, rows: [], curated: { builtAt: now, binding: options.binding, expiresAt: null } })) + 1;
  store.withDeferredPromotions(() => {
    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      const page = store.readPage({ project: options.project, limit: PAGE_ROWS, after });
      for (const source of page.rows) {
        if (source.project !== options.project) { partial = true; continue; }
        if (source.supersededBy || source.expiresAt !== null && Date.parse(source.expiresAt) <= now) continue;
        // #370: a preference is emitted by its own slot, so it never spends one of this section's rows (or its byte budget).
        if (source.kind === "preference") continue;
        if (!policy.screenStandalone(source)) continue;
        if (rows.length >= SECTION_RECORDS) { partial = true; complete = true; break; }
        const shown = noteDisplay(source);
        if (!policy.screenStandalone(shown.data)) continue;
        const row = { source, data: shown.data, partial: shown.partial }, rowBytes = Buffer.byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0);
        const displayBytes = Buffer.byteLength(JSON.stringify({ section: "curated", evidence: true, data: shown.data }));
        if (displayBytes > RECORD_BYTES || bytes + rowBytes > BRIEF_CACHE_BYTES) { partial = true; continue; }
        rows.push(row); bytes += rowBytes; partial ||= shown.partial;
        if (source.expiresAt !== null) expires.push(Date.parse(source.expiresAt));
      }
      if (complete || !page.next) { complete = true; break; }
      after = { position: page.next.position, id: page.next.id };
    }
    if (!complete) partial = true;
  });
  const expiresAt = expires.length ? Math.min(...expires) : null;
  writeBriefCache({ directory: options.directory, project: options.project, section: "curated" }, {
    schema: "agent-mem.brief-cache/v1", project: options.project, section: "curated", builtThrough: Math.max(1, now), partial, rows,
    curated: { builtAt: now, binding: options.binding, expiresAt },
  });
}
