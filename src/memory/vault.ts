import { validVaultPath } from "./generation.ts";
import { createStandalonePolicy, type MemoryPolicy } from "./policy.ts";
import type { MemoryStore, View, VaultEntry } from "./store.ts";
import { label, PLAIN, singleLine, type Style } from "./style.ts";

export interface VaultSelection { project: string; policy: MemoryPolicy; limit?: number }
export type { VaultEntry } from "./store.ts";
export { vaultLinkId, validVaultPath, validateVaultLinkRow, type VaultLinkRow, type VaultLink } from "./generation.ts";
const invalid = (): never => { throw new Error("invalid vault link or unavailable exact entry"); };

function selection(options: VaultSelection): MemoryPolicy {
  if (!options || typeof options.project !== "string" || !options.project.trim() || options.project.length > 400
    || !options.policy || typeof options.policy.screen !== "function" || options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)) throw new Error("invalid startup-bound vault selection");
  return createStandalonePolicy({ host: options.policy });
}
function durable(view: View): boolean {
  if (view.tier !== "long" || view.local || view.expiresAt !== null || view.supersededBy || !["decision", "finding", "contract", "fail"].includes(view.kind)) return false;
  const text = `${view.title ?? ""}\n${view.text}`.normalize("NFKC");
  // ponytail: deterministic suggestions can omit durable lessons phrased as status; a separately measured classifier
  // may improve recall later, but candidate selection never calls a model or imports capture into curated evidence.
  return !/(?:\b(?:task|ticket)\s*#?\d+\b[^\n]*(?:completed|done|in.progress|blocked|checkpoint)|\b(?:review|ci|checks?|pipeline|build)\s*(?::|-)?\s*(?:is\s+)?(?:approved|passed|green|failed|pending|rejected)|\b(?:pr|pull request)\s*#?\d+\b[^\n]*(?:merged|closed|approved|opened|ready)|\b(?:task progress|review verdict|pr status|ci status|working on|progress checkpoint)\b)/i.test(text);
}

/** Policy runs over every startup-project value before durable selection, ordering, limit or returned counts. */
export async function vaultCandidates(store: MemoryStore, options: VaultSelection): Promise<View[]> {
  const policy = selection(options), visible: VaultEntry[] = [];
  for (const entry of store.vaultEntries(options.project)) if (await policy.screen(entry.view)) visible.push(entry);
  const linked = new Set(store.vaultLinks(options.project).map(row => `${row.target}:${row.rowHash}`));
  return visible.filter(entry => durable(entry.view) && !linked.has(`${entry.view.id}:${entry.rowHash}`)).map(entry => entry.view)
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, options.limit ?? 50);
}

/** Human-readable list of screened vault candidates; raw note text is intentionally omitted. */
export function vaultCandidatesText(rows: readonly View[], s: Style = PLAIN): string {
  return [
    `amem vault-candidates: ${rows.length ? s.attention("attention") : s.ok("complete")}`,
    `${label(s, rows.length ? "attention" : "skipped")} candidates: ${rows.length}`,
    ...rows.map(row => {
      const title = singleLine(row.title ?? "(untitled)").slice(0, 120);
      return `  ${label(s, "attention")} ${singleLine(row.project)}: ${row.id}  ${row.kind}  ${title}`;
    }),
    `Next action: ${rows.length ? "open the source repository, then review a candidate with amem show <id> before recording it in your vault" : "none; no screened durable candidates are available"}`,
  ].join("\n");
}

/** Human-readable cross-project list, preserving project grouping and omitting note bodies. */
export function vaultCandidatesAllText(result: {
  crossedProjects: boolean;
  projects: readonly { project: string; candidates: readonly View[] }[];
}, s: Style = PLAIN): string {
  const count = result.projects.reduce((sum, group) => sum + group.candidates.length, 0);
  return [
    `amem vault-candidates: ${count ? s.attention("attention") : s.ok("complete")}${result.crossedProjects ? " (across projects)" : ""}`,
    `${label(s, count ? "attention" : "skipped")} candidates: ${count}`,
    ...result.projects.flatMap(group => group.candidates.map(row => {
      const title = singleLine(row.title ?? "(untitled)").slice(0, 120);
      return `  ${label(s, "attention")} ${singleLine(group.project)}: ${row.id}  ${row.kind}  ${title}`;
    })),
    `Next action: ${count ? (result.crossedProjects ? "open the candidate's source repository, then review it with amem show <id> before recording it in your vault" : "open the source repository, then review a candidate with amem show <id> before recording it in your vault") : "none; no screened durable candidates are available"}`,
  ].join("\n");
}

/** Person-facing hosts authenticate intent before calling; no MCP vault-link tool is provided. */
export async function recordVaultLink(store: MemoryStore, id: string, path: string, options: VaultSelection): Promise<string> {
  const policy = selection(options);
  if (store.profile.kind !== "generation") throw new Error("vault links require a generation profile; shared-v1 is unchanged");
  if (!/^[a-f0-9]{32}$/.test(id) || !validVaultPath(path)) return invalid();
  const entry = store.vaultEntries(options.project).find(row => row.view.id === id);
  if (!entry || !await policy.screen({ entry: entry.view, path }) || !durable(entry.view)) return invalid();
  return store.recordVaultLink(id, path, options.project, entry.rowHash);
}
