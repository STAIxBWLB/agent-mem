import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { machineId } from "./machine.ts";
import { captureShardDir, shardDir } from "./shard.ts";
import { CandidateStore, type Candidate } from "./candidates.ts";
import { overlapWords, wordOverlap } from "./consolidation-clusters.ts";
import { aliasedKeys } from "./aliases.ts";
import { WorkListStore } from "./work-lists.ts";

/** #188: ids per tier in a forget receipt; the total keeps counting past this. */
export const FORGET_NEARBY_CAP = 20;
/** The #174 candidate-overlap floor: half of the smaller word set shared. */
const CANDIDATE_OVERLAP = 0.5;
const CAPTURE_PAGE = 256, CAPTURE_PAGES = 8;

export interface ForgetNearbyTier { ids: string[]; total: number; truncated: boolean }
export interface ForgetNearby { capture: ForgetNearbyTier; candidates: ForgetNearbyTier; work: ForgetNearbyTier }

/**
 * Listing only, for the purge procedure (docs/purge.md step 4): same-project machine-local rows that contain or
 * overlap a forgotten note's text. Ids and counts only, never text. Deterministic, no model or vectors:
 * - capture: a read-only scan of the newest 2048 rows of the project's shard, matching the note text's longest line as a
 *   case-insensitive substring of the excerpt (no migration or index build);
 * - candidates: the #174 word-overlap measure (`overlapWords`/`wordOverlap`, >= 0.5) over each candidate's text;
 * - work items: case-insensitive substring of that longest line in the task name or any string field. A task name can
 *   itself hold the leak, so a work item is listed as `work:<list>#<first 12 hex of sha256(task)>`, never by name.
 * Rows the screen refuses are neither listed nor counted. Each tier fails open to an empty result.
 */
export async function forgetNearby(opts: { base: string; project: string; text: string; title?: string | null; screen: (value: unknown) => boolean | Promise<boolean> }): Promise<ForgetNearby> {
  const needle = probe(opts.text), words = overlapWords({ title: opts.title ?? null, text: opts.text });
  const tier = (): ForgetNearbyTier & { add(id: string): void } => {
    const result = { ids: [] as string[], total: 0, truncated: false, add(id: string) { result.total++; if (result.ids.length < FORGET_NEARBY_CAP) result.ids.push(id); else result.truncated = true; } };
    return result;
  };
  const capture = tier(), candidates = tier(), work = tier();
  const captureFile = needle ? join(captureShardDir(opts.base, opts.project, machineId(opts.base).id), "capture.db") : "";
  if (needle && existsSync(captureFile)) {
    try {
      // Listing only: a read-only connection, so a forget never migrates the shard or builds an index as a side effect.
      const db = new Database(captureFile, { readonly: true });
      try {
        db.run("PRAGMA busy_timeout = 200");
        const projects = JSON.stringify([opts.project, ...aliasedKeys(opts.base, opts.project)]);
        // SQLite lower() folds ASCII only; JavaScript's toLowerCase confirms the match for every script.
        const limit = CAPTURE_PAGE * CAPTURE_PAGES, lower = needle.toLowerCase();
        const rows = db.query("SELECT id, at, project, agent, event, tool, paths, status, excerpt FROM rows WHERE project IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT ?").all(projects, limit + 1) as { id: number; at: string; project: string; agent: string; event: string; tool: string | null; paths: string; status: string | null; excerpt: string }[];
        if (rows.length > limit) capture.truncated = true;
        for (const raw of rows.slice(0, limit).reverse()) {
          if (!raw.excerpt.toLowerCase().includes(lower)) continue;
          let paths: unknown = []; try { paths = JSON.parse(raw.paths); } catch { /* malformed paths are screened as empty */ }
          if (await opts.screen({ ...raw, paths })) capture.add(`capture:${raw.id}`);
        }
      } finally { db.close(); }
    } catch { /* unreadable or contended: nothing to list */ }
  }
  if (words.size && existsSync(join(opts.base, "candidates.db"))) {
    try {
      const store = new CandidateStore({ memoryDir: opts.base, reconcile: { canonical: opts.project, aliases: aliasedKeys(opts.base, opts.project) } });
      try {
        for (const row of store.list({ project: opts.project, status: "all" }).sort((a, b) => a.id.localeCompare(b.id))) {
          const text = candidateText(row); if (!text) continue;
          if (wordOverlap(words, overlapWords(text)) >= CANDIDATE_OVERLAP && await opts.screen(row.input)) candidates.add(row.id);
        }
      } finally { store.close(); }
    } catch { /* no candidates database */ }
  }
  if (needle && [opts.project, ...aliasedKeys(opts.base, opts.project)].some(key => existsSync(join(shardDir(opts.base, key), "work", "log")))) {
    try {
      const store = new WorkListStore({ base: opts.base, project: opts.project, aliases: aliasedKeys(opts.base, opts.project), policy: async row => !!await opts.screen(row) });
      try {
        const lower = needle.toLowerCase();
        for (const list of await store.read(undefined, true)) for (const item of list.items) {
          const haystack = [item.task, ...Object.values(item.fields).filter((value): value is string => typeof value === "string")].join("\n").toLowerCase();
          if (haystack.includes(lower)) work.add(`work:${list.list}#${createHash("sha256").update(item.task).digest("hex").slice(0, 12)}`);
        }
      } finally { store.close(); }
    } catch { /* no work lists */ }
  }
  const plain = (t: ForgetNearbyTier) => ({ ids: t.ids, total: t.total, truncated: t.truncated });
  return { capture: plain(capture), candidates: plain(candidates), work: plain(work) };
}

/** The longest non-empty line, trimmed and bounded: the most specific fragment to look for. */
function probe(text: string): string {
  const line = text.split(/\r?\n/).map(part => part.trim()).sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? "";
  return line.length >= 8 ? line.slice(0, 200) : "";
}
function candidateText(row: Candidate): { title: string | null; text: string } | undefined {
  const input = row.input;
  if (input.kind === "memory") return { title: input.title ?? null, text: input.text };
  if (input.kind === "correction") return { title: null, text: input.proposedText };
  if (input.kind === "decay") return { title: null, text: input.reason };
  if (input.kind === "fail") return { title: null, text: [input.approach, input.symptom, input.cause, input.retryWhen].join("\n") };
  if (input.kind === "model-answer" || input.kind === "consolidation") return { title: null, text: input.text };
  return undefined;
}
/** Human receipt lines; ids only. */
export function forgetNearbyText(nearby: ForgetNearby): string[] {
  const line = (label: string, t: ForgetNearbyTier) => t.total ? [`${label}: ${t.total}${t.truncated ? "+" : ""} (${t.ids.join(", ")}${t.total > t.ids.length ? ", ..." : ""})`] : [];
  const lines = [...line("capture rows", nearby.capture), ...line("candidates", nearby.candidates), ...line("work items", nearby.work)];
  return lines.length ? ["Machine-local rows in this project that contain or overlap the forgotten text (not deleted; see docs/purge.md step 4):", ...lines.map(text => `  ${text}`)] : [];
}
