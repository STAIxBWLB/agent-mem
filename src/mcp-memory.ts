import { AsyncLocalStorage } from "node:async_hooks";
import { packEvidence } from "./memory/evidence.ts";
import { randomUUID } from "node:crypto";
import { buildIntentBrief } from "./memory/intent-brief.ts";
import { createIntentBriefSource, recallViewIsLive } from "./memory/recall.ts";
import { createRecallStalenessProbe } from "./memory/recall-staleness.ts";
import { recordMemoryUse } from "./memory/use-telemetry.ts";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { McpHandlers, McpOptions } from "./mcp.ts";
import { CandidateStore, acceptedCorrectionText, candidateTargetRevision, type CandidateInput } from "./memory/candidates.ts";
import { capacityReport } from "./memory/capacity.ts";
import { CaptureStore, type CaptureRow } from "./memory/capture.ts";
import { hashJSON, readSelector } from "./memory/generation.ts";
import { memoryHome } from "./memory/home.ts";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { createStandalonePolicy, type StandalonePolicy, type StandalonePolicyOptions } from "./memory/policy.ts";
import { configuredPolicyOptions } from "./memory/config.ts";
import { memoryProjectKey } from "./memory/project.ts";
import { registerReaderLease } from "./memory/reader-lease.ts";
import { type ReadRef, type ReadWindow, SearchIndex, ScreenedSearchIndex } from "./memory/search-fts.ts";
import { aliasedKeys, readShardedSelection, resolveAlias } from "./memory/shard.ts";
import { projectState } from "./memory/lifecycle.ts";
import { boundRepoRoot, readRepoScope, repoReadPolicy, type RepoView } from "./memory/repo-scope.ts";
import { MemoryStore, openShardStore, type Graph, type View } from "./memory/store.ts";
import { vaultCandidates } from "./memory/vault.ts";
import { WorkListStore, type WorkListFields } from "./memory/work-lists.ts";

// Graph retains its complete-corpus ceiling; search/timeline/show page matching bodies instead.
export const MCP_SCAN_LIMIT = 5000;
// ponytail: evidence still ranks its newest 5000 permitted candidates; upgrade to the screened search stream if evidence needs global ranking.
const SEARCH_CANDIDATES = 5000;
const READ_PAGE = 256;
type SearchValue = { source: "curated"; evidence: true; view: View } | { source: "repo"; evidence: false; view: RepoView } | { source: "capture"; evidence: false; capture: CaptureRow };
export interface MemoryMcpOptions { cwd: string; base?: string; project?: string; policy?: StandalonePolicyOptions; allowed?: () => boolean; policyVersion?: () => string; assertCurrent?: () => void }
export interface MemoryMcp { tools: McpHandlers; close(): void; onEmitted: NonNullable<McpOptions["onEmitted"]> }
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
  const permitted = () => { try { return options.allowed?.() !== false; } catch { return false; } };
  if (!permitted()) return unavailable();
  const cwd = realPath(options.cwd), base = canonicalPath(options.base ?? memoryHome());
  const requested = options.project ?? memoryProjectKey(cwd), project = resolveAlias(base, requested);
  // #15 T5: an archived or forgotten project has no MCP server: the person took it out of recall.
  if (projectState(base, project) !== "active") unavailable();
  // F4: the person's configured policy (machine file, plus this repository's narrowing file) screens every MCP answer; a host passes a stricter one through `options.policy`.
  const calls = new AsyncLocalStorage<{ policy: StandalonePolicy; revision: string; configured: StandalonePolicyOptions }>();
  const policyOptions = () => configuredPolicyOptions(base, cwd, options.policy);
  const policyKey = (value: StandalonePolicyOptions) => hashJSON({ denyPaths: value.denyPaths ?? [], piiPatterns: value.piiPatterns ?? [], hostRevision: options.policyVersion?.() ?? null });
  const currentPolicy = () => calls.getStore()?.policy ?? createStandalonePolicy(policyOptions());
  const policyRevisionForCall = () => { const revision = policyKey(policyOptions()), active = calls.getStore(); if (active && active.revision !== revision) return unavailable(); return revision; };
  const policy = currentPolicy(), release = registerReaderLease(base);
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
      const scoped = repoRoot ? repoReadPolicy(repoRoot, calls.getStore()?.configured ?? policyOptions()) : undefined;
      if (!scoped || "reason" in scoped) return [];
      const read = await readRepoScope(repoRoot, scoped.policy); guard();
      return read.state === "ok" ? read.views : [];
    };
    const candidates = new CandidateStore({ memoryDir: base, ...(reconcile ? { reconcile } : {}) }); closers.push(() => candidates.close());
    const work = new WorkListStore({ base, project, aliases, policy: async row => { const permitted = await policy.screen(row); guard(); return permitted; } }); closers.push(() => work.close());
    const fullGuard = () => {
      if (!permitted()) unavailable();
      if (closed) unavailable(); options.assertCurrent?.();
      release.verify();
      if (resolveAlias(base, requested) !== project || aliasedKeys(base, project).join("\n") !== aliases.join("\n") || readSelector(base).revision !== selection || projectState(base, project) !== "active") unavailable();
      const split = !!lstatSync(join(base, "shards.json"), { throwIfNoEntry: false });
      if (split !== sharded || split && JSON.stringify(readShardedSelection(base)) !== shardSelection) unavailable();
    };
    const guard = () => { if (!permitted() || closed) return unavailable(); if (!calls.getStore()) fullGuard(); };
    const emitted = new WeakMap<object, { ids: string[]; deliveryId: string }>(), session = randomUUID(); let sequence = 0;
    const observed = <T>(value: T, ids: readonly string[], _rows: readonly unknown[] = []): T => { guard(); if (value && typeof value === "object") emitted.set(value, { ids: [...new Set(ids)].filter(id => /^[a-f0-9]{32}$/.test(id)).slice(0, 256), deliveryId: `mcp:${session}:${++sequence}` }); return value; };
    const onEmitted: MemoryMcp["onEmitted"] = (_tool, _requestId, value) => {
      if (!value || typeof value !== "object") return;
      const receipt = emitted.get(value); emitted.delete(value); if (!receipt?.ids.length) return;
      const { ids, deliveryId } = receipt;
      for (const entryId of ids) recordMemoryUse(candidates, { project, entryId, deliveryId, session }, { rendered: 1 }, { allowed: permitted, assertCurrent: guard });
    };
    const staleRoot = repoRoot ?? cwd, rootConfirmed = repoRoot !== undefined || project.startsWith("local:") && resolveAlias(base, memoryProjectKey(cwd)) === project;
    const stale = () => { policyRevisionForCall(); return createRecallStalenessProbe({ cwd: staleRoot, rootConfirmed, policy: currentPolicy }); };
    const decorate = (view: View, probe: ReturnType<typeof stale>) => ({ ...view, ...(probe(view) === true ? { stale: true } : {}) });
    const screen = async <T>(rows: T[]): Promise<T[]> => {
      if (rows.length > MCP_SCAN_LIMIT) unavailable();
      const publicRows: T[] = []; for (const row of rows) { guard(); if (await currentPolicy().screen(row)) publicRows.push(row); guard(); } return publicRows;
    };
    const curated = async (superseded = false) => {
      guard();
      // list() includes shared rows: remove other projects before screening or selection.
      const rows = store.list({ project, includeSuperseded: superseded, limit: MCP_SCAN_LIMIT + 1 });
      if (rows.length > MCP_SCAN_LIMIT) unavailable();
      return screen(rows.filter(row => row.project === project && recallViewIsLive(row, store.readNow())));
    };
    const permittedRows = async function* <T>(read: (window: ReadWindow) => { rows: T[]; next?: ReadRef; engine?: "fts5" | "substring" },
      options: Omit<ReadWindow, "project" | "limit" | "after">, matches: (row: T, engine?: "fts5" | "substring") => boolean = () => true): AsyncGenerator<T> {
      let after: ReadWindow["after"];
      for (;;) {
        guard();
        const page = read({ ...options, project, limit: READ_PAGE, after });
        for (const row of page.rows) {
          const allowed = await currentPolicy().screen(row); guard();
          if (allowed && matches(row, page.engine)) yield row;
        }
        guard();
        if (!page.next) break;
        after = { position: page.next.position, id: page.next.id };
      }
    };
    const readPermitted = async <T>(read: (window: ReadWindow) => { rows: T[]; next?: ReadRef; engine?: "fts5" | "substring" },
      options: Omit<ReadWindow, "project" | "limit" | "after">, cap: number, matches: (row: T, engine?: "fts5" | "substring") => boolean = () => true): Promise<T[]> => {
      const result: T[] = [];
      for await (const row of permittedRows(read, options, matches)) { result.push(row); if (result.length === cap) break; }
      return result;
    };
    const anchorAt = async (id: string): Promise<string | undefined> => {
      if (/^capture:[1-9][0-9]*$/.test(id)) {
        return (await readPermitted(window => capture.readPage(window), { id: id.slice(8) }, 1))[0]?.at;
      }
      const rows = await readPermitted(window => store.readPage(window), { prefix: id.replace(/^mem:/, "") }, 2, view => recallViewIsLive(view, store.readNow()));
      return rows.length === 1 ? rows[0]!.at : undefined;
    };
    const correctionTarget = (id: string): View => {
      guard();
      const current = store.get(id, project);
      // Proposal visibility matches MCP reads; shared rows from another project are not evidence here.
      if (!current || current.id !== id || current.supersededBy || current.project !== project) return unavailable();
      return current;
    };
    const propose = async (input: CandidateInput, target?: View): Promise<{ id: string }> => {
      if (input.kind === "correction" && acceptedCorrectionText(input).length > 4000) return unavailable();
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
      async amem_evidence(args) {
        bound(args, ["question", "limit", "maxBytes"]); guard();
        const question = textOf(args, "question")!, cap = args.limit ?? 10, maxBytes = args.maxBytes ?? 4096;
        if (question.length > 1000 || !Number.isSafeInteger(cap) || Number(cap) < 1 || Number(cap) > 20 || !Number.isSafeInteger(maxBytes) || Number(maxBytes) < 256 || Number(maxBytes) > 8192) unavailable();
        if (!await currentPolicy().screen({ question })) unavailable(); guard();
        const index = new SearchIndex(":memory:");
        try {
          const words = question.toLowerCase().split(/\s+/).filter(Boolean);
          const notes = await readPermitted(window => store.readPage({ ...window, ...(index.available ? { query: question } : {}) }), {}, SEARCH_CANDIDATES,
            view => view.project === project && recallViewIsLive(view, store.readNow()) && view.peer !== "amem-model" && !view.text.startsWith("Model answer:")
              && (index.available || words.every(word => `${view.title ?? ""}\n${view.text}\n${view.about.join(" ")}`.toLowerCase().includes(word))));
          if (index.available) {
            index.resync(() => notes.map(view => ({ id: view.id, at: view.at, project, tier: view.tier, scope: view.scope, body: `${view.title ?? ""}\n${view.text}\n${view.about.join(" ")}` })));
            if (index.needsResync(notes.length)) unavailable();
          }
          const ranks = new Map((index.available ? index.query(question, SEARCH_CANDIDATES, project) : []).map(row => [row.ref, row.rank]));
          const ranked = notes.flatMap(view => {
            const rank = ranks.get(view.id); if (index.available && rank === undefined) return [];
            const score = -(rank ?? -1) * (view.tier === "long" ? 1 : 0.9) / (1 + Math.max(0, store.readNow() - Date.parse(view.at)) / (30 * 86400_000));
            return [{ view, score }];
          }).sort((a, b) => b.score - a.score || a.view.id.localeCompare(b.view.id)).map(row => row.view);
          const result = packEvidence(ranked, { project, question, limit: Number(cap), maxBytes: Number(maxBytes), now: () => store.readNow() });
          if (notes.length === SEARCH_CANDIDATES) result.bundle.truncated = true;
          guard(); return observed(result.bundle, result.ids);
        } finally { index.close(); }
      },
      async amem_search(args) {
        bound(args, ["query", "limit", "since", "includeCapture"]); const query = textOf(args, "query")!, limit = limitOf(args), since = sinceOf(args);
        if (args.includeCapture !== undefined && typeof args.includeCapture !== "boolean") unavailable();
        if (!await currentPolicy().screen({ query })) unavailable();
        // ponytail: scan all matches into private disposable disk state, keeping one body page in JS.
        // Work scales with matches; a policy-bound cache is the upgrade if this reaches the unchanged watchdog.
        const index = new ScreenedSearchIndex<SearchValue>();
        const releaseIndex = () => index.close(); closers.push(releaseIndex);
        try {
          const words = query.toLowerCase().split(/\s+/).filter(Boolean);
          const captureState: { engine?: "fts5" | "substring" } = {};
          let batch: { body: string; ref: string; tier: string; at: string; value: SearchValue; expiresAt?: string | null }[] = [];
          const append = (value: SearchValue) => {
            const row = value.source === "capture" ? value.capture : value.view;
            batch.push(value.source === "capture"
              ? { value, ref: `capture:${value.capture.id}`, at: row.at, tier: "capture", body: `${value.capture.excerpt}\n${value.capture.paths.join(" ")}\n${value.capture.event}` }
              : { value, ref: value.source === "repo" ? `repo:${value.view.id}` : value.view.id, at: row.at, tier: value.source === "repo" ? "long" : value.view.tier, body: `${value.view.title ?? ""}\n${value.view.text}\n${value.view.about.join(" ")}`, expiresAt: value.source === "curated" ? value.view.expiresAt : null });
            if (batch.length === READ_PAGE) { index.append(batch); batch = []; }
          };
          if (args.includeCapture !== false) {
            for await (const row of permittedRows(window => {
              const page = capture.readPage({ ...window, query, ...(captureState.engine === "substring" ? { match: "substring" as const } : {}) });
              captureState.engine ??= page.engine; return page;
            }, { since, order: "id" }, (row, engine) => index.available && engine === "fts5" || words.every(word => `${row.excerpt}\n${row.paths.join(" ")}\n${row.event}`.toLowerCase().includes(word)))) {
              append({ source: "capture", evidence: false, capture: row });
            }
          }
          const useFts = index.available && captureState.engine !== "substring";
          for await (const view of permittedRows(window => store.readPage({ ...window, ...(useFts ? { query } : {}) }), { since, order: "id" },
            view => recallViewIsLive(view, store.readNow()) && (useFts || words.every(word => `${view.title ?? ""}\n${view.text}\n${view.about.join(" ")}`.toLowerCase().includes(word))))) append({ source: "curated", evidence: true, view });
          const repoNotes = (await repoRows()).filter(view => (!since || Date.parse(view.at) >= Date.parse(since)) && (useFts || words.every(word => `${view.title ?? ""}\n${view.text}\n${view.about.join(" ")}`.toLowerCase().includes(word))));
          for (const view of repoNotes) append({ source: "repo", evidence: false, view });
          if (batch.length) index.append(batch);
          const selected = index.best(query, limit, store.readNow(), useFts).map(({ value, score }) => ({ ...value, score }));
          const probe = stale(), result = { engine: useFts ? "fts5" : "substring", hits: selected.map(hit => hit.source === "curated" && "view" in hit && hit.view ? { ...hit, view: decorate(hit.view as View, probe) } : hit) };
          guard(); return observed(result, selected.flatMap(hit => hit.source === "curated" && "view" in hit && hit.view ? [hit.view.id] : []), selected.map(hit => "view" in hit ? hit.view : hit.capture));
        } finally { const position = closers.indexOf(releaseIndex); if (position >= 0) closers.splice(position, 1); releaseIndex(); }
      },
      async amem_show(args) {
        bound(args, ["id"]); guard(); const id = textOf(args, "id")!;
        if (/^repo:[a-f0-9]{32}$/.test(id)) { const row = (await repoRows()).find(view => `repo:${view.id}` === id); guard(); return row ? { source: "repo", evidence: false, view: row } : null; }
        if (/^capture:[1-9][0-9]*$/.test(id)) {
          const row = (await readPermitted(window => capture.readPage(window), { id: id.slice(8) }, 1))[0];
          guard(); return row ? { source: "capture", evidence: false, capture: row } : null;
        }
        const rows = await readPermitted(window => store.readPage(window), { prefix: id.replace(/^mem:/, "") }, 2);
        const view = rows.length === 1 && recallViewIsLive(rows[0]!, store.readNow()) ? rows[0]! : undefined;
        guard(); return view ? observed(decorate(view, stale()), [view.id], [view]) : null;
      },
      async amem_timeline(args) {
        bound(args, ["id", "since", "limit"]);
        const id = textOf(args, "id", true), since = sinceOf(args), limit = limitOf(args);
        guard();
        const anchor = id ? await anchorAt(id) : undefined;
        if (id && !anchor) { guard(); return []; }
        const rows = await readPermitted(window => store.readPage(window), { since, anchor }, limit, view => recallViewIsLive(view, store.readNow()));
        const recalls = await readPermitted(window => capture.readPage(window), { since, anchor }, limit);
        const entries: { at: string; ref: string; value: unknown; memoryId?: string }[] = [...rows.map(row => ({ at: row.at, ref: row.id, value: row as unknown, memoryId: row.id })),
          ...recalls.map(row => ({ at: row.at, ref: `capture:${row.id}`, value: { source: "capture", evidence: false, capture: row } as unknown }))];
        const currentEntries = entries.filter(row => !row.memoryId || recallViewIsLive(row.value as View, store.readNow()));
        currentEntries.sort((a, b) => (anchor ? Math.abs(Date.parse(a.at) - Date.parse(anchor)) - Math.abs(Date.parse(b.at) - Date.parse(anchor)) : Date.parse(b.at) - Date.parse(a.at)) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
        const selected = currentEntries.slice(0, limit), probe = stale();
        const values = selected.map(row => row.memoryId ? decorate(row.value as View, probe) : row.value);
        guard(); return observed(values, selected.flatMap(row => row.memoryId ? [row.memoryId] : []), selected.map(row => row.value));
      },
      async amem_brief(args) {
        bound(args, ["intent", "paths", "symbols", "maxBytes"]); guard();
        const values = (key: string): string[] => { const value = args[key]; if (value === undefined) return []; if (!Array.isArray(value) || value.length > 150 || value.some(item => typeof item !== "string" || item.length > 512 || item.includes("\0"))) return unavailable(); return value as string[]; };
        const intent = textOf(args, "intent")!, paths = values("paths"), symbols = values("symbols"), maxBytes = args.maxBytes ?? 2048;
        if (intent.length > 1000 || !Number.isSafeInteger(maxBytes) || Number(maxBytes) < 1 || Number(maxBytes) > 8192) return unavailable();
        const result = await buildIntentBrief(createIntentBriefSource(store, project),
          { project, cwd: staleRoot, repo: project, intent, paths, symbols, maxBytes: Number(maxBytes), policy: currentPolicy, policyVersion: policyRevisionForCall, allowed: permitted, assertCurrent: guard, now: () => store.readNow(), stale: stale() });
        guard();
        return observed({ brief: result.text, bytes: result.bytes, truncated: result.truncated, state: result.state }, result.items.map(view => view.id), result.items);
      },
      async amem_graph(args) {
        bound(args, ["start", "hops", "limit"]); const start = textOf(args, "start")!, cap = limitOf(args), hops = args.hops ?? 1;
        if (hops !== 1 && hops !== 2) unavailable();
        const rows = (await curated()).filter(row => recallViewIsLive(row, store.readNow())); const result = screenedGraph(rows, start, Number(hops), cap); guard(); return observed(result, result.nodes.filter(node => node.id.startsWith("mem:")).map(node => node.id.slice(4)), rows.filter(row => result.nodes.some(node => node.id === `mem:${row.id}`)));
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
          if (kind !== "fail" || args.text !== undefined || args.title !== undefined || !Array.isArray(args.evidenceRefs) || args.evidenceRefs.length < 1 || args.evidenceRefs.length > 16) return unavailable();
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
      async amem_vault_candidates(args) { bound(args, ["limit"]); guard(); const result = await vaultCandidates(store, { project, policy: currentPolicy(), limit: limitOf(args) }); guard(); return result; },
      async amem_capacity(args) { bound(args, []); guard(); const report = capacityReport({ memoryDir: base }); if (!await policy.screen(report)) unavailable(); guard(); return report; },
    };
    const exposed = { ...tools };
    const readTools = ["amem_search", "amem_evidence", "amem_show", "amem_timeline", "amem_graph", "amem_brief", "amem_vault_candidates"] as const;
    for (const name of readTools) exposed[name] = async args => {
      fullGuard();
      const configured = policyOptions(), revision = policyKey(configured), snapshot = createStandalonePolicy(configured);
      const sourceCurrent = store.beginRecallRead();
      if (policyKey(policyOptions()) !== revision) return unavailable();
      return calls.run({ policy: snapshot, revision, configured }, async () => {
        const result = await tools[name](args);
        fullGuard(); sourceCurrent();
        if (policyKey(policyOptions()) !== revision) return unavailable();
        return result;
      });
    };
    return { tools: exposed, close, onEmitted };
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
