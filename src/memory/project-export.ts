import { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, lstatSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { walkShards } from "./catalog.ts";
import { openCuratedForRead, requireShard } from "./curated-read.ts";
import { projectState } from "./lifecycle.ts";
import { realPath } from "./platform.ts";
import { createStandalonePolicy, type MemoryPolicy } from "./policy.ts";
import { looksSecret } from "./screen.ts";
import { aliasedKeys, shardDir } from "./shard.ts";
import { WorkListStore } from "./work-lists.ts";

/**
 * #15 T5 / D3: `amem project export <key> --to <file>`. One project's capture rows, curated notes, goals and work lists as one portable JSON bundle,
 * written once to a new file with mode 0600. It changes no content file of the home: it opens the capture databases read-only and the curated store only to
 * read, and only derived files (the curated `index.db`, `search.db`, SQLite sidecars) may refresh, as they do for any read. A destination inside the home is refused.
 *
 * The bundle leaves the home, so it is screened like sync and promotion are: a secret-looking value is withheld, and so is anything the host policy (when
 * one is passed) declines. `withheld` counts the capture rows, notes and goals left out; a work list the policy declines is left out silently by its own store.
 * A forgotten project cannot be exported (the person's decision stands); an archived one can. The write streams row by row, so a shard at its cap never has to
 * fit in memory, and a failure removes the partial file it created.
 */

export const EXPORT_SCHEMA = "agent-mem.project-export/v1";
/**
 * ponytail: a seam, not a lock. The destination is checked (for the message) and then claimed with O_EXCL (for the guarantee); a test sets `afterCheck` to create
 * the file in the gap between them, which is the only way to show that O_EXCL, not the check, keeps an export from replacing someone else's file.
 */
export const exportHooks: { afterCheck?: (file: string) => void } = {};
export interface ExportCounts { capture: number; curated: number; goals: number; workLists: number }
export interface ExportResult { file: string; project: string; counts: ExportCounts; withheld: number }
const PAGE = 500;

interface CaptureRowRaw { id: number; at: string; project: string; agent: string; event: string; tool: string | null; paths: string; status: string | null; excerpt: string }

function destination(base: string, to: string): string {
  if (typeof to !== "string" || !to.trim()) throw new Error("export needs --to <file>");
  const file = resolve(to), parent = dirname(file), name = basename(file);
  if (!name || file === parent) throw new Error("--to names a file, not a directory root");
  let parentReal: string;
  try { if (!statSync(parent).isDirectory()) throw new Error(); parentReal = realPath(parent); }
  catch { throw new Error("the destination directory does not exist"); }
  let homeReal = base;
  try { homeReal = realPath(base); } catch { /* a home that is not there yet holds nothing to collide with */ }
  if (parentReal === homeReal || parentReal.startsWith(homeReal + sep)) throw new Error("the destination is inside the memory home; choose a folder outside it");
  if (lstatSync(file, { throwIfNoEntry: false })) throw new Error("the destination exists; export never overwrites");
  return join(parentReal, name);
}

export async function exportProject(base: string, key: string, opts: { to: string; policy?: MemoryPolicy }): Promise<ExportResult> {
  const project = requireShard(base, key);
  if (projectState(base, project) === "forgotten") throw new Error(`project ${project} is forgotten: it cannot be exported`);
  const file = destination(base, opts.to), policy = opts.policy ?? createStandalonePolicy();
  exportHooks.afterCheck?.(file);
  const allowed = async (value: unknown): Promise<boolean> => !looksSecret(JSON.stringify(value)) && await policy.screen(value);
  const counts: ExportCounts = { capture: 0, curated: 0, goals: 0, workLists: 0 };
  let withheld = 0;
  let fd: number;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error("the destination exists; export never overwrites"); }
  const out = (text: string) => { writeSync(fd, text); };
  const stores: { close(): void }[] = [];
  try {
    out(`{"schema":${JSON.stringify(EXPORT_SCHEMA)},"project":${JSON.stringify(project)},"exportedAt":${JSON.stringify(new Date().toISOString())},"capture":[`);
    let first = true;
    const shard = walkShards(base).find(candidate => candidate.key === project);
    for (const dir of shard?.machineDirs ?? []) {
      const dbFile = join(dir, "capture.db");
      if (!existsSync(dbFile)) continue;
      const db = new Database(dbFile, { readonly: true });
      try {
        db.run("PRAGMA busy_timeout = 3000");
        for (let after = 0; ;) {
          const rows = db.query("SELECT id, at, project, agent, event, tool, paths, status, excerpt FROM rows WHERE id > ? ORDER BY id LIMIT ?").all(after, PAGE) as CaptureRowRaw[];
          for (const r of rows) {
            after = r.id;
            const row = { at: r.at, agent: r.agent, event: r.event, tool: r.tool, paths: JSON.parse(r.paths) as string[], status: r.status, excerpt: r.excerpt };
            if (!await allowed(row)) { withheld++; continue; }
            out(`${first ? "" : ","}${JSON.stringify(row)}`); first = false; counts.capture++;
          }
          if (rows.length < PAGE) break;
        }
      } finally { db.close(); }
    }
    out(`],"curated":[`);
    const store = openCuratedForRead(base, project);
    if (store) stores.push(store);
    // The project's own rows and those of a key aliased to it; another project's shared note is not this project's and stays out of its bundle.
    const keys = new Set([project, ...aliasedKeys(base, project)]);
    first = true;
    for (const view of store?.list({ project, limit: Number.MAX_SAFE_INTEGER, includeSuperseded: true }) ?? []) {
      if (!keys.has(view.project)) continue;
      if (!await allowed(view)) { withheld++; continue; }
      out(`${first ? "" : ","}${JSON.stringify(view)}`); first = false; counts.curated++;
    }
    out(`],"goals":[`);
    first = true;
    for (const goal of store?.goals(project) ?? []) {
      if (!keys.has(goal.project)) continue;
      if (!await allowed(goal)) { withheld++; continue; }
      out(`${first ? "" : ","}${JSON.stringify(goal)}`); first = false; counts.goals++;
    }
    out(`],"workLists":[`);
    first = true;
    // The bundle holds what the project's own reads show: the canonical work log and that of every key aliased to it (the same reconciliation the CLI, MCP and brief use).
    const workKeys = [project, ...aliasedKeys(base, project)];
    if (workKeys.some(key => existsSync(join(shardDir(base, key), "work")))) {
      const work = new WorkListStore({ base, project, policy: allowed, aliases: workKeys.slice(1) });
      stores.push({ close: () => work.close() });
      for (const list of await work.read(undefined, true)) { out(`${first ? "" : ","}${JSON.stringify(list)}`); first = false; counts.workLists++; }
    }
    out(`],"counts":${JSON.stringify(counts)},"withheld":${withheld}}\n`);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(file, { force: true });          // the file is ours: O_EXCL created it, so a partial bundle is removed, never left behind
    throw error;
  } finally {
    for (const store of stores) { try { store.close(); } catch { /* best effort */ } }
  }
  closeSync(fd);
  return { file, project, counts, withheld };
}
