import { captureSearch } from "./search-fts.ts";
import { readCaptureConfig, type CaptureRow } from "./capture.ts";
import { walkShards } from "./catalog.ts";
import { openCuratedForRead } from "./curated-read.ts";
import { lifecycleStates } from "./lifecycle.ts";
import type { MemoryPolicy } from "./policy.ts";
import type { SearchHit, View } from "./store.ts";
import { vaultCandidates } from "./vault.ts";

/**
 * #15 T5 / D4 and D8: the two reads that deliberately cross project boundaries, each one project at a time.
 *
 * - `searchAllProjects` (`amem search --all-projects`): one ordinary project-scoped search per active project, merged by score. Every hit names its project and
 *   the reply says `crossedProjects: true` with the projects it read, so a caller can never mistake it for a single-project answer. An archived project is
 *   read only with `includeArchived`; a forgotten one never. It writes nothing under the home.
 * - `vaultCandidatesAll` (`amem vault-candidates --all-projects | --project <key>`): the existing durable-candidate selection (`vaultCandidates`), under the
 *   caller's policy, run per project and grouped by project. amem lists; it never writes the vault or a vault link (D8).
 *
 * Both are person reads at the CLI: agents reach memory through MCP, which stays bound to one project and has no all-projects argument (D4).
 */

export interface CrossHit extends SearchHit { project: string }
export interface CrossSearchResult { crossedProjects: true; projects: string[]; hits: CrossHit[]; engine: "fts5" | "substring" }

function readableProjects(base: string, opts: { includeArchived?: boolean }): { key: string; machineDirs: string[] }[] {
  const states = lifecycleStates(base);
  return walkShards(base).filter(shard => { const state = states.get(shard.key) ?? "active"; return state === "active" || state === "archived" && opts.includeArchived === true; });
}

export function searchAllProjects(base: string, query: string, opts: { limit?: number; includeArchived?: boolean; includeCapture?: boolean; now?: () => number } = {}): CrossSearchResult {
  const limit = opts.limit ?? 50;
  if (!query.trim()) throw new Error("usage: amem search --all-projects <words>");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit takes a number from 1 to 500");
  const now = (opts.now ?? Date.now)(), hits: CrossHit[] = [], projects: string[] = [];
  let engine: "fts5" | "substring" = "fts5";
  for (const shard of readableProjects(base, opts)) {
    projects.push(shard.key);
    const store = openCuratedForRead(base, shard.key);
    try {
      if (store) {
        const found = store.search(query, { project: shard.key, includeCapture: false, limit });
        if (found.engine === "substring") engine = "substring";
        for (const hit of found.hits) if (hit.view && hit.view.project === shard.key) hits.push({ ...hit, project: shard.key });
      }
    } finally { store?.close(); }
    if (opts.includeCapture !== false) {
      for (const dir of shard.machineDirs) {
        const days = readCaptureConfig(dir, base).retentionDays, cutoff = new Date(now - days * 24 * 3600_000);
        for (const { row, rank } of captureSearch(dir, query, Math.max(limit * 4, 32), Number.isFinite(cutoff.getTime()) ? cutoff.toISOString() : undefined)) {
          hits.push({ source: "capture", score: -rank * 0.5, capture: row as CaptureRow, project: shard.key });
        }
      }
    }
  }
  const ref = (h: CrossHit): string => `${h.project}:${h.view?.id ?? String(h.capture?.id ?? 0).padStart(12, "0")}`;
  hits.sort((a, b) => b.score - a.score || ref(a).localeCompare(ref(b)));
  return { crossedProjects: true, projects: projects.sort(), hits: hits.slice(0, limit), engine };
}

export interface VaultCandidatesAll { crossedProjects: boolean; projects: { project: string; candidates: View[] }[] }

export async function vaultCandidatesAll(base: string, opts: { policy: MemoryPolicy; project?: string; limit?: number; includeArchived?: boolean }): Promise<VaultCandidatesAll> {
  const shards = readableProjects(base, opts).filter(shard => opts.project === undefined || shard.key === opts.project);
  if (opts.project !== undefined && !shards.length) throw new Error(`no readable project shard for ${opts.project}`);
  const projects: { project: string; candidates: View[] }[] = [];
  for (const shard of shards.sort((a, b) => a.key.localeCompare(b.key))) {
    const store = openCuratedForRead(base, shard.key);
    if (!store) continue;
    try {
      const candidates = await vaultCandidates(store, { project: shard.key, policy: opts.policy, ...(opts.limit !== undefined ? { limit: opts.limit } : {}) });
      if (candidates.length) projects.push({ project: shard.key, candidates });
    } finally { store.close(); }
  }
  return { crossedProjects: opts.project === undefined, projects };
}
