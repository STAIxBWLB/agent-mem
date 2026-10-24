import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { McpHandlers } from "./mcp.ts";
import { CandidateStore, candidateTargetRevision, type CandidateInput } from "./memory/candidates.ts";
import { capacityReport } from "./memory/capacity.ts";
import { CaptureStore } from "./memory/capture.ts";
import { readSelector } from "./memory/generation.ts";
import { memoryHome } from "./memory/home.ts";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "./memory/policy.ts";
import { configuredPolicyOptions } from "./memory/config.ts";
import { memoryProjectKey } from "./memory/project.ts";
import { registerReaderLease } from "./memory/reader-lease.ts";
import { type ReadRef, type ReadWindow, SearchIndex } from "./memory/search-fts.ts";
import { aliasedKeys, readShardedSelection, resolveAlias } from "./memory/shard.ts";
import { projectState } from "./memory/lifecycle.ts";
import { boundRepoRoot, readRepoScope, repoReadPolicy, type RepoView } from "./memory/repo-scope.ts";
import { MemoryStore, openShardStore, type Graph, type View } from "./memory/store.ts";
import { vaultCandidates } from "./memory/vault.ts";
import { WorkListStore, type WorkListFields } from "./memory/work-lists.ts";

// Graph retains its complete-corpus ceiling; search/timeline/show page matching bodies instead.
export const MCP_SCAN_LIMIT = 5000;
// ponytail: rank the newest 5000 permitted matching candidates per tier; use since to narrow or upgrade to a policy-bound persistent index for global ranking.
const SEARCH_CANDIDATES = 5000;
const READ_PAGE = 256;
export interface MemoryMcpOptions { cwd: string; base?: string; project?: string; policy?: StandalonePolicyOptions }
export interface MemoryMcp { tools: McpHandlers; close(): void }
const unavailable = (): never => { throw new Error("memory operation unavailable"); };
const bound = (args: Record<string, unknown>, keys: string[]) => { if (Object.keys(args).some(key => !keys.includes(key))) unavailable(); };
const limitOf = (args: Record<string, unknown>): number => args.limit === undefined ? 20 : Number.isSafeInteger(args.limit) && Number(args.limit) >= 1 && Number(args.limit) <= 100 ? Number(args.limit) : unavailable();
const textOf = (args: Record<string, unknown>, key: string, optional = false): string | undefined => {
  const value = args[key]; if (value === undefined && optional) return undefined;
  return typeof value === "string" && value.trim() && !value.includes("\0") ? value : unavailable();
};
const sinceOf = (args: Record<string, unknown>): string | undefined => { const since = textOf(args, "since", true); if (since !== undefined && !Number.isFinite(Date.parse(since))) unavailable(); return since === undefined ? undefined : new Date(since).toISOString(); };

/** All identities are resolved once. Per-call arguments cannot change projects, homes, profiles or policy. */
export function createMemoryMcp(options: MemoryMcpOptions): MemoryMcp {
  const cwd = realPath(options.cwd), base = canonicalPath(options.base ?? memoryHome());
  const requested = options.project ?? memoryProjectKey(cwd), project = resolveAlias(base, requested);
  // #15 T5: an archived or forgotten project has no MCP server: the person took it out of recall.
  if (projectState(base, project) !== "active") unavailable();
  // F4: the person's configured policy (machine file, plus this repository's narrowing file) screens every MCP answer; a host passes a stricter one through `options.policy`.
  const policy = createStandalonePolicy(configuredPolicyOptions(base, cwd, options.policy)), release = registerReaderLease(base);
  const closers: (() => void)[] = [release]; let closed = false;
  const close = () => { if (closed) return; closed = true; let failure: unknown; for (const closer of closers.reverse()) { try { closer(); } catch (error) { failure ??= error; } } if (failure) throw failure; };
  try {
    const selection = readSelector(base).revision;
    const sharded = !!lstatSync(join(base, "shards.json"), { throwIfNoEntry: false });
    const shardSelection = sharded ? JSON.stringify(readShardedSelection(base)) : undefined;
    // #27: the project filter covers the canonical key and every key aliased to it; the keys are fixed with the project, so a later alias change fails the guard below.
    const aliases = aliasedKeys(base, project), reconcile = aliases.length ? { canonical: project, aliases } : undefined;
    const store = sharded ? openShardStore({ memoryDir: base, project, deferPromotions: true, ...(reconcile ? { reconcile } : {}) }) : new MemoryStore({ memoryDir: base, deferPromotions: true, ...(reconcile ? { reconcile } : {}) });
    closers.push(() => store.close());
    const capture = new CaptureStore({ memoryDir: base, project, cwd }); closers.push(() => capture.close());
    // #15 T4: the bound repository's `.amem/log.jsonl`, only when that repository's own key IS this project (AC3). The root is fixed at start like the project; the file is read per call.
    const repoRoot = boundRepoRoot(cwd, base, project);
    const repoRows = async (): Promise<RepoView[]> => {
      const scoped = repoRoot ? repoReadPolicy(repoRoot, configuredPolicyOptions(base, cwd, options.policy)) : undefined;
      if (!scoped || "reason" in scoped) return [];
      const read = await readRepoScope(repoRoot, scoped.policy); guard();
      return read.state === "ok" ? read.views : [];
    };
    const candidates = new CandidateStore({ memoryDir: base, ...(reconcile ? { reconcile } : {}) }); closers.push(() => candidates.close());
    const work = new WorkListStore({ base, project, aliases, policy: async row => { const permitted = await policy.screen(row); guard(); return permitted; } }); closers.push(() => work.close());
    const guard = () => {
      if (closed) unavailable();
      release.verify();
      if (resolveAlias(base, requested) !== project || aliasedKeys(base, project).join("\n") !== aliases.join("\n") || readSelector(base).revision !== selection || projectState(base, project) !== "active") unavailable();
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
    const readPermitted = async <T>(read: (window: ReadWindow) => { rows: T[]; next?: ReadRef; engine?: "fts5" | "substring" },
      options: Omit<ReadWindow, "project" | "limit" | "after">, cap: number, matches: (row: T, engine?: "fts5" | "substring") => boolean = () => true): Promise<T[]> => {
      const result: T[] = []; let after: ReadWindow["after"];
      while (result.length < cap) {
        guard();
        const page = read({ ...options, project, limit: READ_PAGE, after });
        for (const row of page.rows) if (await policy.screen(row) && matches(row, page.engine)) {
          result.push(row); if (result.length === cap) break;
        }
        guard();
        if (!page.next) break;
        after = { position: page.next.position, id: page.next.id };
      }
      return result;
    };
    const anchorAt = async (id: string): Promise<string | undefined> => {
      if (/^capture:[1-9][0-9]*$/.test(id)) {
        return (await readPermitted(window => capture.readPage(window), { id: id.slice(8) }, 1))[0]?.at;
      }
      const rows = await readPermitted(window => store.readPage({ ...window, includeSuperseded: true }), { prefix: id.replace(/^mem:/, "") }, 2);
      return rows.length === 1 ? rows[0]!.at : undefined;
    };
    const correctionTarget = (id: string): View => {
      guard();
      const current = store.get(id, project);
      // Shared entries retain their source project/scope through the existing correction acceptance contract.
      if (!current || current.id !== id || current.supersededBy || current.project !== project && current.scope !== "shared") unavailable();
      return current;
    };
    const propose = async (input: CandidateInput, target?: View): Promise<{ id: string }> => {
      const revision = target && candidateTargetRevision(target);
      const currentPolicy = () => createStandalonePolicy(configuredPolicyOptions(base, cwd, options.policy));
      const check = () => { guard(); if (target && candidateTargetRevision(correctionTarget(target.id)) !== revision) unavailable(); };
      const complete = target ? { ...input, targetView: target } : input;
      check();
      if (!await currentPolicy().screen(complete)) unavailable();
      check();
      // Config can tighten while the host screen awaits. Its synchronous check fences the final append.
      if (!currentPolicy().screenStandalone(complete)) unavailable();
      check();
      return { id: candidates.put(input, "public") };
    };
    const tools: McpHandlers = {
      async amem_search(args) {
        bound(args, ["query", "limit", "since", "includeCapture"]); const query = textOf(args, "query")!, limit = limitOf(args), since = sinceOf(args);
        if (args.includeCapture !== undefined && typeof args.includeCapture !== "boolean") unavailable();
        if (!await policy.screen({ query })) unavailable();
        const index = new SearchIndex(":memory:");
        try {
          const words = query.toLowerCase().split(/\s+/).filter(Boolean);
          const captureState: { engine?: "fts5" | "substring" } = {};
          const recalls = args.includeCapture === false ? [] : await readPermitted(window => {
            const page = capture.readPage({ ...window, query, ...(captureState.engine === "substring" ? { match: "substring" as const } : {}) });
            captureState.engine ??= page.engine;
            return page;
          }, { since }, SEARCH_CANDIDATES,
            (row, engine) => index.available && engine === "fts5" || words.every(word => `${row.excerpt}\n${row.paths.join(" ")}\n${row.event}`.toLowerCase().includes(word)));
          const useFts = index.available && captureState.engine !== "substring";
          const notes = await readPermitted(window => store.readPage({ ...window, ...(useFts ? { query } : {}) }), { since }, SEARCH_CANDIDATES,
            view => useFts || words.every(word => `${view.title ?? ""}\n${view.text}\n${view.about.join(" ")}`.toLowerCase().includes(word)));
          const repoNotes = (await repoRows()).filter(view => (!since || Date.parse(view.at) >= Date.parse(since)) && (useFts || words.every(word => `${view.title ?? ""}\n${view.text}\n${view.about.join(" ")}`.toLowerCase().includes(word))));
          const hits = [...notes.map(view => ({ source: "curated" as const, evidence: true, view, ref: view.id, at: view.at, tier: view.tier, body: `${view.title ?? ""}\n${view.text}\n${view.about.join(" ")}` })),
            ...repoNotes.map(view => ({ source: "repo" as const, evidence: false, view, ref: `repo:${view.id}`, at: view.at, tier: "long", body: `${view.title ?? ""}\n${view.text}\n${view.about.join(" ")}` })),
            ...recalls.map(row => ({ source: "capture" as const, evidence: false, capture: row, ref: `capture:${row.id}`, at: row.at, tier: "capture", body: `${row.excerpt}\n${row.paths.join(" ")}\n${row.event}` }))].filter(hit => !since || Date.parse(hit.at) >= Date.parse(since));
          if (useFts) {
            index.resync(() => hits.map(hit => ({ id: hit.ref, at: hit.at, project, tier: hit.tier, scope: "project", body: hit.body })));
            if (index.needsResync(hits.length)) unavailable();
          }
          const ranks = new Map((useFts ? index.query(query, MCP_SCAN_LIMIT * 2, project) : []).map(row => [row.ref, row.rank]));
          const selected = hits.flatMap(hit => {
            const rank = ranks.get(hit.ref);
            if (useFts ? rank === undefined : !words.every(word => hit.body.toLowerCase().includes(word))) return [];
            const weight = hit.tier === "long" ? 1 : hit.tier === "capture" ? 0.5 : 0.9;
            const score = -(rank ?? -1) * weight / (1 + Math.max(0, Date.now() - Date.parse(hit.at)) / (30 * 86400_000));
            return [{ source: hit.source, evidence: hit.evidence, ...(hit.source === "capture" ? { capture: hit.capture } : { view: hit.view }), score }];
          }).sort((a, b) => b.score - a.score).slice(0, limit);
          guard(); return { engine: useFts ? "fts5" : "substring", hits: selected };
        } finally { index.close(); }
      },
      async amem_show(args) {
        bound(args, ["id"]); guard(); const id = textOf(args, "id")!;
        if (/^repo:[a-f0-9]{32}$/.test(id)) { const row = (await repoRows()).find(view => `repo:${view.id}` === id); guard(); return row ? { source: "repo", evidence: false, view: row } : null; }
        if (/^capture:[1-9][0-9]*$/.test(id)) {
          const row = (await readPermitted(window => capture.readPage(window), { id: id.slice(8) }, 1))[0];
          guard(); return row ? { source: "capture", evidence: false, capture: row } : null;
        }
        const rows = await readPermitted(window => store.readPage({ ...window, includeSuperseded: true }), { prefix: id.replace(/^mem:/, "") }, 2);
        guard(); return rows.length === 1 ? rows[0]! : null;
      },
      async amem_timeline(args) {
        bound(args, ["id", "since", "limit"]);
        const id = textOf(args, "id", true), since = sinceOf(args), limit = limitOf(args);
        guard();
        const anchor = id ? await anchorAt(id) : undefined;
        if (id && !anchor) { guard(); return []; }
        const rows = await readPermitted(window => store.readPage({ ...window, includeSuperseded: true }), { since, anchor }, limit);
        const recalls = await readPermitted(window => capture.readPage(window), { since, anchor }, limit);
        const entries = [...rows.map(row => ({ at: row.at, ref: row.id, value: row as unknown })),
          ...recalls.map(row => ({ at: row.at, ref: `capture:${row.id}`, value: { source: "capture", evidence: false, capture: row } as unknown }))];
        entries.sort((a, b) => (anchor ? Math.abs(Date.parse(a.at) - Date.parse(anchor)) - Math.abs(Date.parse(b.at) - Date.parse(anchor)) : Date.parse(b.at) - Date.parse(a.at)) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
        guard(); return entries.slice(0, limit).map(row => row.value);
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
        const structured = ["approach", "symptom", "cause", "evidenceRefs", "retryWhen"];
        bound(args, ["text", "title", "kind", ...structured]); guard();
        const kind = args.kind ?? "finding";
        if (typeof kind !== "string" || !["decision", "finding", "contract", "fail"].includes(kind)) unavailable();
        if (structured.some(key => args[key] !== undefined)) {
          if (kind !== "fail" || args.text !== undefined || args.title !== undefined || !Array.isArray(args.evidenceRefs) || args.evidenceRefs.length < 1 || args.evidenceRefs.length > 16) unavailable();
          const evidenceRefs = args.evidenceRefs.map(value => typeof value === "string" && value.trim() && value.length <= 400 && !value.includes("\0") ? value : unavailable());
          return propose({ project, kind: "fail", approach: textOf(args, "approach")!, symptom: textOf(args, "symptom")!, cause: textOf(args, "cause")!, evidenceRefs, retryWhen: textOf(args, "retryWhen")! });
        }
        return propose({ project, kind: "memory", text: textOf(args, "text")!, ...(args.title === undefined ? {} : { title: textOf(args, "title")! }), noteKind: kind as "decision" | "finding" | "contract" | "fail" });
      },
      async amem_correct(args) {
        bound(args, ["id", "proposedText", "reason", "kind"]); guard();
        const id = textOf(args, "id")!.replace(/^mem:/, "");
        if (!/^[a-f0-9]{32}$/.test(id) || args.kind !== undefined && (typeof args.kind !== "string" || !["decision", "contract", "fail"].includes(args.kind))) unavailable();
        const target = correctionTarget(id);
        const input: CandidateInput = { project, kind: "correction", target: { id, revision: candidateTargetRevision(target) }, proposedText: textOf(args, "proposedText")!, reason: textOf(args, "reason")!,
          ...(args.kind === undefined ? {} : { noteKind: args.kind as "decision" | "contract" | "fail" }) };
        return propose(input, target);
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
