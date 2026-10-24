import { types } from "node:util";
import { candidateTargetRevision, type CandidateInput, type CandidateStore } from "./candidates.ts";
import { memoryPolicySnapshot, type StandalonePolicy } from "./policy.ts";
import { realPath } from "./platform.ts";
import { recallViewIsLive } from "./recall.ts";
import type { MemoryStore, View } from "./store.ts";

export interface ModelConsolidationNote extends View { revision: string }
export interface ModelConsolidationInput { project: string; notes: ModelConsolidationNote[] }
export interface ModelConsolidationOptions {
  enabled: true;
  run: (input: ModelConsolidationInput, signal: AbortSignal) => Promise<{ text: string } | null>;
}
export interface ModelConsolidationGuard { project: string; actor: "person" | "agent"; check(): void; policy: StandalonePolicy }
export interface ModelConsolidationReport {
  state: "disabled" | "known" | "unknown"; ids: string[]; calls: number; nonAnswers: number; rejected: number; oversized: number;
  limited: boolean; timedOut: boolean; truncated: boolean;
}
const TIMEOUT_MS = 10_000, MAX_INPUT_BYTES = 8192, MAX_OUTPUT_BYTES = 4096, PREFIX = "Model answer:\n";
async function invoke(model: ModelConsolidationOptions, input: ModelConsolidationInput, before: () => void): Promise<{ state: "value"; value: unknown } | { state: "timeout" } | { state: "error" }> {
  const controller = new AbortController(), deadline = performance.now() + TIMEOUT_MS; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<{ state: "timeout" }>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ state: "timeout" }); }, TIMEOUT_MS); });
    const result = await Promise.race([Promise.resolve().then(() => { before(); return model.run(structuredClone(input), controller.signal); }).then(value => ({ state: "value" as const, value }), () => ({ state: "error" as const })), timeout]);
    if (performance.now() >= deadline) { controller.abort(); return { state: "timeout" }; }
    return result;
  } finally { if (timer) clearTimeout(timer); }
  // ponytail: an injected host callback must honor AbortSignal to stop its own work. The library cannot
  // terminate arbitrary host work, but the expired race has no late candidate-writing continuation.
}
/** Already-screened public rows only; guard.check retains the caller's current policy/source binding.
 * Optional injected callback only, never a built-in provider, automatic pass or curated writer. */
export async function proposeModelConsolidations(store: MemoryStore, candidates: CandidateStore, rows: readonly View[], model: ModelConsolidationOptions | undefined, guard: ModelConsolidationGuard): Promise<ModelConsolidationReport> {
  const report: ModelConsolidationReport = { state: model === undefined ? "disabled" : "known", ids: [], calls: 0, nonAnswers: 0, rejected: 0, oversized: 0, limited: false, timedOut: false, truncated: false };
  if (model === undefined) return report;
  if (guard.actor !== "person") throw Error("model consolidation requires person intent");
  try {
    if (!model || model.enabled !== true || typeof model.run !== "function" || !guard.project.trim() || guard.project.length > 400) throw Error("model consolidation unavailable");
    guard.check();
    if (realPath(candidates.dir) !== realPath(store.profile.home)) throw Error("model consolidation home mismatch");
    if (types.isProxy(rows) || !Array.isArray(rows) || rows.length > 256) throw Error("model consolidation source bound exceeded");
    const project = guard.project, sourceCurrent = store.beginRecallRead(), sources: ModelConsolidationNote[] = [], seen = new Set<string>();
    const check = (batch: readonly ModelConsolidationNote[]) => {
      guard.check(); sourceCurrent();
      if (guard.actor !== "person" || guard.project !== project) throw Error("model consolidation context changed");
      const placements = batch.length ? store.entryPlacements(batch.map(row => row.id), project) : new Map<string, "local" | "synced">();
      store.withDeferredPromotions(() => {
        for (const row of batch) {
          const current = store.get(row.id, project);
          if (!current || current.id !== row.id || current.project !== project || !recallViewIsLive(current, store.readNow()) || candidateTargetRevision(current) !== row.revision || placements.get(row.id) !== "synced") throw Error("model consolidation sources changed");
        }
      });
      guard.check(); sourceCurrent();
    };
    for (let index = 0; index < rows.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
      if (!descriptor || !("value" in descriptor)) throw Error("model consolidation source unavailable");
      const row = memoryPolicySnapshot(descriptor.value as View);
      if (!row || !/^[a-f0-9]{32}$/.test(row.id) || row.project !== project || !recallViewIsLive(row, store.readNow()) || row.peer === "amem-model" || row.text.startsWith("Model answer:")) throw Error("model consolidation source unavailable");
      if (seen.has(row.id)) continue; seen.add(row.id); sources.push({ ...row, revision: candidateTargetRevision(row) });
    }
    check(sources);
    const batches: ModelConsolidationNote[][] = []; let pending: ModelConsolidationNote[] = [];
    for (const row of sources) {
      if (Buffer.byteLength(JSON.stringify({ project, notes: [row] })) > MAX_INPUT_BYTES) { report.oversized++; report.truncated = true; continue; }
      if (pending.length === 8 || Buffer.byteLength(JSON.stringify({ project, notes: [...pending, row] })) > MAX_INPUT_BYTES) { batches.push(pending); pending = []; }
      pending.push(row);
    }
    if (pending.length) batches.push(pending);
    report.truncated ||= batches.length > 2;
    for (const batch of batches.slice(0, 2)) {
      check(batch);
      const input: ModelConsolidationInput = { project, notes: batch }, inputBytes = Buffer.byteLength(JSON.stringify(input));
      // Exported callers must not be able to forward an unscreened row merely by claiming it was screened.
      const inputPermitted = await guard.policy.screen(input); check(batch);
      if (!inputPermitted) { report.rejected++; continue; }
      if (!candidates.reserveConsolidationModel(inputBytes)) { report.limited = true; report.truncated = true; break; }
      report.calls++;
      const result = await invoke(model, input, () => check(batch)); check(batch);
      if (result.state === "timeout") { report.state = "unknown"; report.timedOut = true; break; }
      if (result.state === "error") { report.state = "unknown"; report.rejected++; break; }
      const value = memoryPolicySnapshot(result.value);
      if (value === null) { report.nonAnswers++; continue; }
      if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") { report.rejected++; continue; }
      if (Buffer.byteLength(value.text) > MAX_OUTPUT_BYTES) { report.oversized++; continue; }
      const body = value.text.trim(); if (!body) { report.nonAnswers++; continue; }
      const text = PREFIX + body;
      if (text.length > 3000) { report.oversized++; continue; }
      const candidate: Extract<CandidateInput, { kind: "model-answer" }> = { project, kind: "model-answer", marker: "model-answer", targets: batch.map(row => ({ id: row.id, revision: row.revision })), text };
      guard.check();
      const permitted = await guard.policy.screen({ project, output: value, candidate }); check(batch);
      if (!permitted) { report.rejected++; continue; }
      report.ids.push(candidates.put(candidate, "public"));
    }
    return report;
  } catch { report.state = "unknown"; report.rejected++; return report; }
}
