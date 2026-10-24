import type { MemoryStore, RecallStateOptions, RetainedRecallState, Graph, View } from "./store.ts";

export interface RecallOptions extends RecallStateOptions { query?: string; limit?: number }
/** Only public read semantics; mutation and exact-revision callers continue to use Store.get directly. */
export function recallViewIsLive(view: View, now: number): boolean {
  return !view.supersededBy && Number.isFinite(Date.parse(view.at))
    && (view.expiresAt === null || Number.isFinite(Date.parse(view.expiresAt)) && Date.parse(view.expiresAt) > now);
}
const PROMOTION_NOTICE = "promotion time unknown: tier before promotion cannot be recovered";
/** Narrow promotion uncertainty to emitted rows while retaining independent source diagnostics. */
export function recallForViews(state: RetainedRecallState, views: View[]): RetainedRecallState {
  const notices = state.notices.filter(notice => notice !== PROMOTION_NOTICE || views.some(view => view.promotedFrom));
  return { ...state, views, notices, incomplete: state.sourceIncomplete === true || state.malformed > 0 || notices.length > 0 };
}
function personRecall(options: RecallStateOptions): void {
  if ((options.history || options.asOf !== undefined) && options.person !== true) throw Error("historical recall requires authenticated person intent from the host");
}
export function recallRows(store: MemoryStore, project: string, options: RecallOptions = {}): RetainedRecallState {
  personRecall(options);
  const limit = options.limit ?? 5000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > Number.MAX_SAFE_INTEGER) throw Error("recall limit must be a positive safe integer");
  const state: RetainedRecallState = options.history || options.asOf !== undefined ? store.recallState(project, options)
    : store.withDeferredPromotions(() => ({ at: new Date(store.readNow()).toISOString(), views: store.list({ project, limit: Number.MAX_SAFE_INTEGER }).filter(view => recallViewIsLive(view, store.readNow())), forgotten: [], relations: [], malformed: 0, incomplete: false, notices: [] }));
  const words = options.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const rows = state.views.filter(view => words.every(word => `${view.title ?? ""}\n${view.text}\n${view.about.join(" ")}`.toLowerCase().includes(word)))
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const selected = recallForViews(state, rows.slice(0, limit));
  return { ...selected, incomplete: selected.incomplete || rows.length > limit };
}
export interface RecallShown { entry?: View; state?: RetainedRecallState; ids: string[] }
export function recallShow(store: MemoryStore, project: string, rawId: string, options: RecallStateOptions = {}): RecallShown {
  personRecall(options);
  const id = rawId.replace(/^mem:/, "");
  if (!/^[a-f0-9]{6,32}$/.test(id)) return { ids: [] };
  if (!options.history && options.asOf === undefined) {
    const view = store.withDeferredPromotions(() => store.get(id, project));
    return view && recallViewIsLive(view, store.readNow()) ? { entry: view, ids: [view.id] } : { ids: [] };
  }
  const state = store.recallState(project, options), known = [...new Set([...state.views.map(view => view.id), ...state.forgotten.map(row => row.id)])];
  const matches = known.includes(id) ? [id] : known.filter(value => value.startsWith(id));
  if (matches.length !== 1) return { ids: [] };
  const selected = new Set(matches), queue = [...matches], knownIds = new Set(known);
  if (options.history) for (let index = 0; index < queue.length && queue.length <= 64; index++) {
    for (const edge of state.relations) for (const next of edge.from === queue[index] ? [edge.to] : edge.to === queue[index] ? [edge.from] : []) {
      if (knownIds.has(next) && !selected.has(next)) { selected.add(next); queue.push(next); }
    }
  }
  if (queue.length > 64) throw Error("recall history chain exceeds 64 retained entries");
  const views = state.views.filter(view => selected.has(view.id));
  return { entry: views.find(view => view.id === matches[0]), ids: [...selected], state: { ...recallForViews(state, views), forgotten: state.forgotten.filter(row => selected.has(row.id)), relations: state.relations.filter(edge => selected.has(edge.from) && selected.has(edge.to)) } };
}

/** Public graph over live recall rows; retained history requires host-authenticated person intent. */
export function recallGraph(store: MemoryStore, project: string, start: string, hops = 1, options: RecallOptions = {}, readable: (rows: View[]) => View[] = rows => rows): Graph {
  personRecall(options);
  const rows = readable(recallRows(store, project, { ...options, limit: Number.MAX_SAFE_INTEGER }).views);
  let node = start;
  if (!start.includes(":") || start.startsWith("mem:")) {
    const id = start.replace(/^mem:/, ""), exact = rows.find(view => view.id === id), matches = exact ? [exact] : id.length >= 6 ? rows.filter(view => view.id.startsWith(id)) : [];
    if (matches.length !== 1) return { nodes: [], edges: [] };
    node = `mem:${matches[0]!.id}`;
  }
  return store.withDeferredPromotions(() => store.graph(project, node, hops, 200, rows));
}

/** One prepared snapshot; its revision guard rejects changes after asynchronous host policy work. */
export function createIntentBriefSource(store: MemoryStore, project: string): { notes(): View[]; assertCurrent(): void; truncated(): boolean } {
  let snapshot: ReturnType<MemoryStore["intentSnapshot"]> | undefined;
  return {
    notes: () => { snapshot ??= store.intentSnapshot(project); return snapshot.rows; },
    assertCurrent: () => { if (!snapshot) throw Error("intent snapshot has not been prepared"); snapshot.assertCurrent(); },
    truncated: () => snapshot?.truncated ?? false,
  };
}
