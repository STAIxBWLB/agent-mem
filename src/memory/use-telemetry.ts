import type { CandidateStore, Counter, CounterKey, CounterValues } from "./candidates.ts";

export type MemoryUsePort = Pick<CandidateStore, "recordCounter" | "counters">;
export interface MemoryUseContext { allowed?: () => boolean; assertCurrent?: () => void; aliases?: readonly string[] }
export interface MemoryUseSummary { state: "known" | "unknown"; records: number | null; rendered: number | null; delivered: number | null; cited: number | null }
const unknown = (): MemoryUseSummary => ({ state: "unknown", records: null, rendered: null, delivered: null, cited: null });
const entry = (id: string): string => { const normalized = id.replace(/^mem:/, ""); if (!/^[a-f0-9]{32}$/.test(normalized)) throw Error("invalid memory use entry"); return normalized; };
const projectKey = (project: string): string => { if (typeof project !== "string" || !project.trim() || project.length > 400 || project.includes("\0")) throw Error("invalid memory use project"); return project; };
function guard(context: MemoryUseContext): void { if (context.allowed?.() === false) throw Error("memory use unavailable"); context.assertCurrent?.(); }
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
/** Counts are explicit per-delivery totals, never increments or inferred delivery/citation events. */
export function recordMemoryUse(port: MemoryUsePort, key: CounterKey, values: CounterValues, context: MemoryUseContext = {}): boolean {
  try {
    guard(context);
    const normalized = { ...key, project: projectKey(key.project), entryId: entry(key.entryId) };
    if (typeof key.deliveryId !== "string" || !key.deliveryId.trim() || key.deliveryId.length > 200 || key.deliveryId.includes("\0")) return false;
    for (const metric of [values.rendered, values.delivered, values.cited]) if (metric !== undefined && metric !== null && !count(metric)) return false;
    guard(context); port.recordCounter(normalized, { ...values }, "public"); guard(context); return true;
  } catch { return false; }
}
/** Unknown individual metrics stay unknown across the complete matching delivery set. */
export function readMemoryUse(port: MemoryUsePort, project: string, id: string, context: MemoryUseContext = {}): MemoryUseSummary {
  try {
    guard(context); const normalized = entry(id), projects = [...new Set([projectKey(project), ...(context.aliases ?? []).map(projectKey)])];
    const rows = new Map<string, Counter>();
    for (const scope of projects) {
      guard(context); const found = port.counters(scope, normalized); guard(context);
      if (!Array.isArray(found)) return unknown();
      for (const row of found) {
        if (!row?.key || !projects.includes(row.key.project) || row.key.entryId !== normalized) continue;
        if (typeof row.id !== "string" || !row.id) return unknown();
        const prior = rows.get(row.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(row)) return unknown();
        rows.set(row.id, row);
      }
    }
    const metric = (name: keyof CounterValues): number | null => {
      if (!rows.size) return null;
      let total = 0;
      for (const row of rows.values()) { const value = row[name]; if (!count(value) || !Number.isSafeInteger(total + value)) return null; total += value; }
      return total;
    };
    const result: MemoryUseSummary = { state: "known", records: rows.size, rendered: metric("rendered"), delivered: metric("delivered"), cited: metric("cited") };
    guard(context); return result;
  } catch { return unknown(); }
}
/** Creating callbacks does nothing. Each explicit callback merges only its named metric using the same delivery key. */
export function memoryUseCallbacks(port: MemoryUsePort, key: CounterKey, context: MemoryUseContext = {}): { rendered: (count?: number) => boolean; delivered: (count?: number) => boolean; cited: (count?: number) => boolean } {
  const bound = { ...key };
  return { rendered: (value = 1) => recordMemoryUse(port, bound, { rendered: value }, context), delivered: (value = 1) => recordMemoryUse(port, bound, { delivered: value }, context), cited: (value = 1) => recordMemoryUse(port, bound, { cited: value }, context) };
}
