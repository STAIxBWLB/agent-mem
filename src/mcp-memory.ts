import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { McpHandlers } from "./mcp.ts";
import { CandidateStore } from "./memory/candidates.ts";
import { capacityReport } from "./memory/capacity.ts";
import { CaptureStore } from "./memory/capture.ts";
import { readSelector } from "./memory/generation.ts";
import { memoryHome } from "./memory/home.ts";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "./memory/policy.ts";
import { memoryProjectKey } from "./memory/project.ts";
import { registerReaderLease } from "./memory/reader-lease.ts";
import { SearchIndex } from "./memory/search-fts.ts";
import { readShardedSelection, resolveAlias } from "./memory/shard.ts";
import { MemoryStore, openShardStore, type Graph, type View } from "./memory/store.ts";
import { vaultCandidates } from "./memory/vault.ts";
import { WorkListStore, type WorkListFields } from "./memory/work-lists.ts";

// ponytail: 5000 rows per tier per operation; above this ceiling refuse rather than select on an incomplete privacy-filtered corpus. Upgrade to screened streaming pagination.
export const MCP_SCAN_LIMIT = 5000;
export interface MemoryMcpOptions { cwd: string; base?: string; project?: string; policy?: StandalonePolicyOptions }
export interface MemoryMcp { tools: McpHandlers; close(): void }
const unavailable = (): never => { throw new Error("memory operation unavailable"); };
const bound = (args: Record<string, unknown>, keys: string[]) => { if (Object.keys(args).some(key => !keys.includes(key))) unavailable(); };
const limitOf = (args: Record<string, unknown>): number => args.limit === undefined ? 20 : Number.isSafeInteger(args.limit) && Number(args.limit) >= 1 && Number(args.limit) <= 100 ? Number(args.limit) : unavailable();
const textOf = (args: Record<string, unknown>, key: string, optional = false): string | undefined => {
  const value = args[key]; if (value === undefined && optional) return undefined;
  return typeof value === "string" && value.trim() && !value.includes("\0") ? value : unavailable();
};
const sinceOf = (args: Record<string, unknown>): string | undefined => { const since = textOf(args, "since", true); if (since !== undefined && !Number.isFinite(Date.parse(since))) unavailable(); return since; };

/** All identities are resolved once. Per-call arguments cannot change projects, homes, profiles or policy. */
export function createMemoryMcp(options: MemoryMcpOptions): MemoryMcp {
  const cwd = realPath(options.cwd), base = canonicalPath(options.base ?? memoryHome());
  const requested = options.project ?? memoryProjectKey(cwd), project = resolveAlias(base, requested);
  const policy = createStandalonePolicy(options.policy), release = registerReaderLease(base);
  const closers: (() => void)[] = [release]; let closed = false;
  const close = () => { if (closed) return; closed = true; let failure: unknown; for (const closer of closers.reverse()) { try { closer(); } catch (error) { failure ??= error; } } if (failure) throw failure; };
  try {
    const selection = readSelector(base).revision;
    const sharded = !!lstatSync(join(base, "shards.json"), { throwIfNoEntry: false });
    const shardSelection = sharded ? JSON.stringify(readShardedSelection(base)) : undefined;
    const store = sharded ? openShardStore({ memoryDir: base, project, deferPromotions: true }) : new MemoryStore({ memoryDir: base, deferPromotions: true });
    closers.push(() => store.close());
    const capture = new CaptureStore({ memoryDir: base, project }); closers.push(() => capture.close());
    const candidates = new CandidateStore({ memoryDir: base }); closers.push(() => candidates.close());
    const work = new WorkListStore({ base, project, policy: async row => { const permitted = await policy.screen(row); guard(); return permitted; } }); closers.push(() => work.close());
    const guard = () => {
      if (closed) unavailable();
      release.verify();
      if (resolveAlias(base, requested) !== project || readSelector(base).revision !== selection) unavailable();
      const split = !!lstatSync(join(base, "shards.json"), { throwIfNoEntry: false });
      if (split !== sharded || split && JSON.stringify(readShardedSelection(base)) !== shardSelection) unavailable();
    };
    const screen = async <T>(rows: T[]): Promise<T[]> => {
      if (rows.length > MCP_SCAN_LIMIT) unavailable();
      const publicRows: T[] = []; for (const row of rows) if (await policy.screen(row)) publicRows.push(row); return publicRows;
    };
    const curated = async (superseded = false) => {
      guard();
      // list() includes shared rows: remove other projects before screening or selection.
      const rows = store.list({ project, includeSuperseded: superseded, limit: MCP_SCAN_LIMIT + 1 });
      if (rows.length > MCP_SCAN_LIMIT) unavailable();
      return screen(rows.filter(row => row.project === project));
    };
    const captures = async () => screen(capture.rows({ project, limit: MCP_SCAN_LIMIT + 1 }));
    const find = (rows: View[], id: string): View | null => { const found = rows.filter(row => row.id === id || row.id.startsWith(id.replace(/^mem:/, ""))); return found.length === 1 ? found[0]! : null; };
    const tools: McpHandlers = {
      async amem_search(args) {
        bound(args, ["query", "limit", "since", "includeCapture"]); const query = textOf(args, "query")!, limit = limitOf(args), since = sinceOf(args);
        if (args.includeCapture !== undefined && typeof args.includeCapture !== "boolean") unavailable();
        if (!await policy.screen({ query })) unavailable();
        const notes = await curated(), recalls = args.includeCapture === false ? [] : await captures();
        const hits = [...notes.map(view => ({ source: "curated" as const, evidence: true, view, ref: view.id, at: view.at, tier: view.tier, body: `${view.title ?? ""}\n${view.text}\n${view.about.join(" ")}` })),
          ...recalls.map(row => ({ source: "capture" as const, evidence: false, capture: row, ref: `capture:${row.id}`, at: row.at, tier: "capture", body: `${row.excerpt}\n${row.paths.join(" ")}\n${row.event}` }))].filter(hit => !since || Date.parse(hit.at) >= Date.parse(since));
        const index = new SearchIndex(":memory:");
        try {
          index.resync(() => hits.map(hit => ({ id: hit.ref, at: hit.at, project, tier: hit.tier, scope: "project", body: hit.body })));
          if (index.available && index.needsResync(hits.length)) unavailable();
          const ranks = new Map(index.query(query, MCP_SCAN_LIMIT * 2, project).map(row => [row.ref, row.rank]));
          const words = query.toLowerCase().split(/\s+/).filter(Boolean);
          const selected = hits.flatMap(hit => {
            const rank = ranks.get(hit.ref);
            if (index.available ? rank === undefined : !words.every(word => hit.body.toLowerCase().includes(word))) return [];
            const weight = hit.tier === "long" ? 1 : hit.tier === "capture" ? 0.5 : 0.9;
            const score = -(rank ?? -1) * weight / (1 + Math.max(0, Date.now() - Date.parse(hit.at)) / (30 * 86400_000));
            return [{ source: hit.source, evidence: hit.evidence, ...(hit.source === "curated" ? { view: hit.view } : { capture: hit.capture }), score }];
          }).sort((a, b) => b.score - a.score).slice(0, limit);
          guard(); return { engine: index.available ? "fts5" : "substring", hits: selected };
        } finally { index.close(); }
      },
      async amem_show(args) {
        bound(args, ["id"]); guard(); const id = textOf(args, "id")!;
        if (/^capture:[1-9][0-9]*$/.test(id)) { const row = (await captures()).find(row => `capture:${row.id}` === id); guard(); return row ? { source: "capture", evidence: false, capture: row } : null; }
        const result = find(await curated(true), id); guard(); return result;
      },
      async amem_timeline(args) {
        bound(args, ["id", "since", "limit"]); const rows = await curated(true), recalls = await captures(), id = textOf(args, "id", true), since = sinceOf(args), limit = limitOf(args);
        const entries = [...rows.map(row => ({ at: row.at, value: row as unknown })), ...recalls.map(row => ({ at: row.at, value: { source: "capture", evidence: false, capture: row } as unknown }))];
        let selected = entries.filter(row => !since || Date.parse(row.at) >= Date.parse(since));
        if (id) {
          const anchor = id.startsWith("capture:") ? recalls.find(row => `capture:${row.id}` === id) : find(rows, id);
          if (!anchor) return []; selected = selected.sort((a, b) => Math.abs(Date.parse(a.at) - Date.parse(anchor.at)) - Math.abs(Date.parse(b.at) - Date.parse(anchor.at)));
        } else selected.sort((a, b) => b.at.localeCompare(a.at));
        guard(); return selected.slice(0, limit).map(row => row.value);
      },
      async amem_graph(args) {
        bound(args, ["start", "hops", "limit"]); const start = textOf(args, "start")!, cap = limitOf(args), hops = args.hops ?? 1;
        if (hops !== 1 && hops !== 2) unavailable();
        const rows = await curated(true); const result = screenedGraph(rows, start, Number(hops), cap); guard(); return result;
      },
      async amem_work_state_read(args) {
        bound(args, ["list", "includeClosed"]); guard();
        if (args.includeClosed !== undefined && typeof args.includeClosed !== "boolean") unavailable();
        // Reduce complete views before policy: individually public appends can compose into private state.
        const result = await work.read(textOf(args, "list", true), true);
        const permitted: typeof result = [];
        for (const view of result) if (await policy.screen(view)) permitted.push(view);
        guard();
        return args.includeClosed === true ? permitted : permitted.filter(view => !view.closed).map(view => ({ ...view, items: view.items.filter(item => item.fields.status !== "done" && item.fields.status !== "dropped") }));
      },
      async amem_work_state_write(args) { bound(args, ["list", "fields"]); guard(); const result = await work.write(textOf(args, "list")!, args.fields as WorkListFields); guard(); return result; },
      async amem_remember(args) {
        bound(args, ["text", "title", "kind"]); guard();
        const kind = args.kind ?? "finding"; if (!["decision", "finding", "contract", "fail"].includes(String(kind))) unavailable();
        const input = { project, kind: "memory" as const, text: textOf(args, "text")!, ...(args.title === undefined ? {} : { title: textOf(args, "title")! }), noteKind: kind as "decision" | "finding" | "contract" | "fail" };
        if (!await policy.screen(input)) unavailable(); guard(); return { id: candidates.put(input, "public") };
      },
      async amem_vault_candidates(args) { bound(args, ["limit"]); guard(); const result = await vaultCandidates(store, { project, policy, limit: limitOf(args) }); guard(); return result; },
      async amem_capacity(args) { bound(args, []); guard(); const report = capacityReport({ memoryDir: base }); if (!await policy.screen(report)) unavailable(); guard(); return report; },
    };
    return { tools, close };
  } catch (error) { close(); throw error; }
}

/** Build only from screened project rows; even an absent starting node does not leak its label. */
function screenedGraph(rows: View[], start: string, hops: number, cap: number): Graph {
  const nodes = new Map<string, Graph["nodes"][number]>(), edges: Graph["edges"] = [];
  const views = new Map(rows.map(row => [`mem:${row.id}`, row]));
  for (const [id, row] of views) {
    nodes.set(id, { id, type: "memory", label: (row.title ?? row.text).slice(0, 60), kind: row.kind, tier: row.tier });
    for (const [other, rel] of [...row.about.map(node => [node, row.kind === "fail" ? "rules_out" : "about"] as const), [`peer:${row.peer}`, "by"], [`machine:${row.machine}`, "by"], [`project:${row.project}`, "in"]]) {
      nodes.set(other!, { id: other!, type: other!.split(":")[0]!, label: other!.slice(other!.indexOf(":") + 1) }); edges.push({ from: id, to: other!, rel: rel! });
    }
    for (const old of row.supersedes) if (views.has(`mem:${old}`)) edges.push({ from: id, to: `mem:${old}`, rel: "supersedes" });
  }
  if (!nodes.has(start)) return { nodes: [], edges: [] };
  const selected = new Set([start]); let frontier = [start];
  for (let hop = 0; hop < hops; hop++) { const next: string[] = []; for (const id of frontier) for (const edge of edges) { const other = edge.from === id ? edge.to : edge.to === id ? edge.from : undefined; if (other && !selected.has(other) && selected.size < cap) { selected.add(other); next.push(other); } } frontier = next; }
  return { nodes: [...selected].map(id => nodes.get(id)!), edges: edges.filter(edge => selected.has(edge.from) && selected.has(edge.to)) };
}
