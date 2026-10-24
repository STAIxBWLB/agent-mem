import type { MemoryStore, RecallStateOptions, RetainedRecallState, View } from "./store.ts";

export interface RecallOptions extends RecallStateOptions { query?: string; limit?: number }
/** Only public read semantics; mutation and exact-revision callers continue to use Store.get directly. */
export function recallViewIsLive(view: View, now: number): boolean {
  return !view.supersededBy && Number.isFinite(Date.parse(view.at)) && Date.parse(view.at) <= now
    && (view.expiresAt === null || Number.isFinite(Date.parse(view.expiresAt)) && Date.parse(view.expiresAt) > now);
}
export function recallRows(store: MemoryStore, project: string, options: RecallOptions = {}): RetainedRecallState {
  const limit = options.limit ?? 5000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > Number.MAX_SAFE_INTEGER) throw Error("recall limit must be a positive safe integer");
  const state: RetainedRecallState = options.history || options.asOf !== undefined ? store.recallState(project, options)
    : store.withDeferredPromotions(() => ({ at: new Date(store.readNow()).toISOString(), views: store.list({ project, limit: Number.MAX_SAFE_INTEGER }).filter(view => recallViewIsLive(view, store.readNow())), forgotten: [], relations: [], malformed: 0, incomplete: false, notices: [] }));
  const words = options.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const rows = state.views.filter(view => words.every(word => `${view.title ?? ""}\n${view.text}\n${view.about.join(" ")}`.toLowerCase().includes(word)))
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  return { ...state, views: rows.slice(0, limit), incomplete: state.incomplete || rows.length > limit };
}
export interface RecallShown { entry?: View; state?: RetainedRecallState; ids: string[] }
export function recallShow(store: MemoryStore, project: string, rawId: string, options: RecallStateOptions = {}): RecallShown {
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
  return { entry: views.find(view => view.id === matches[0]), ids: [...selected], state: { ...state, views, forgotten: state.forgotten.filter(row => selected.has(row.id)), relations: state.relations.filter(edge => selected.has(edge.from) && selected.has(edge.to)) } };
}

/** Exact-project source for both standalone hosts. Selection is bounded before bodies and never follows foreign shares. */
export function createIntentBriefSource(store: MemoryStore, project: string): { notes(): View[]; truncated(): boolean } {
  let cut = false;
  return {
    notes: () => store.withDeferredPromotions(() => {
      const rows: View[] = []; let after: { position: number; id: string } | undefined, exhausted = false; cut = false;
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = store.readPage({ project, limit: 256, after });
        rows.push(...page.rows.filter(view => view.project === project && recallViewIsLive(view, store.readNow())));
        if (!page.next) { exhausted = true; break; }
        after = page.next;
        if (rows.length > 5000) { cut = true; break; }
      }
      if (!exhausted && !cut && after) { const probe = store.readPage({ project, limit: 1, after }); cut = probe.rows.length > 0 || probe.next !== undefined; }
      return rows.slice(0, 5001);
    }),
    truncated: () => cut,
  };
}
