import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore } from "../src/memory/candidates.ts";
import { proposeModelConsolidations, type ModelConsolidationGuard, type ModelConsolidationOptions } from "../src/memory/consolidation-model.ts";
import { packEvidence } from "../src/memory/evidence.ts";
import { buildIntentBrief } from "../src/memory/intent-brief.ts";
import { createIntentBriefSource } from "../src/memory/recall.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { realPath } from "../src/memory/platform.ts";
import { MemoryStore, type NoteInput, type View } from "../src/memory/store.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-consolidation-model-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.parse("2026-10-25T00:00:00.000Z"), valid = true;
  const project = "project", store = new MemoryStore({ memoryDir: root, now: () => now, deferPromotions: true, screen: () => "promote" }), candidates = new CandidateStore({ memoryDir: root, now: () => now }); cleanup.push(() => store.close(), () => candidates.close());
  const note = (text: string, extra: Partial<NoteInput> = {}): View => { now++; const id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text, about: ["path:public.ts"], ...extra }); return store.get(id)!; };
  const guard: ModelConsolidationGuard = { project, actor: "person", policy: createStandalonePolicy(), check: () => { if (!valid) throw Error("private changed context detail"); } };
  const bytes = () => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(row => row.isFile() && row.name.endsWith(".jsonl")).map(row => { const file = join(row.parentPath, row.name); return [file, readFileSync(file, "utf8")]; }));
  return { root, project, store, candidates, note, guard, bytes, invalidate: () => { valid = false; }, advance: (days: number) => { now += days * 86400_000; } };
}
const model = (run: ModelConsolidationOptions["run"]): ModelConsolidationOptions => ({ enabled: true, run });
function pending(f: ReturnType<typeof fixture>) { return f.candidates.list({ project: f.project, status: "all" }); }
test("default disabled performs no home, guard, quota or callback work; explicit agent/bad model never calls", async () => {
  let work = 0;
  const inaccessible = new Proxy({}, { get() { work++; throw Error("must not read"); } });
  const disabled = await proposeModelConsolidations(inaccessible as MemoryStore, inaccessible as CandidateStore, [], undefined, inaccessible as ModelConsolidationGuard); expect(disabled).toMatchObject({ state: "disabled", calls: 0, ids: [] }); expect(work).toBe(0);
  const f = fixture(), row = f.note("public model source"); let calls = 0, reserves = 0; const reserve = f.candidates.reserveConsolidationModel.bind(f.candidates); f.candidates.reserveConsolidationModel = bytes => { reserves++; return reserve(bytes); };
  await expect(proposeModelConsolidations(f.store, f.candidates, [row], model(async () => { calls++; return null; }), { ...f.guard, actor: "agent" })).rejects.toThrow("person");
  for (const invalid of [{ enabled: false, run: async () => { calls++; return null; } }, { enabled: true }]) expect((await proposeModelConsolidations(f.store, f.candidates, [row], invalid as ModelConsolidationOptions, f.guard)).state).toBe("unknown");
  expect(calls).toBe(0); expect(reserves).toBe(0);
});
test("enabled model uses at most two batches of eight whole source quotes and writes only unacceptably marked candidates", async () => {
  const f = fixture(), rows = Array.from({ length: 17 }, (_, i) => f.note(`public source ${i}`)), before = f.bytes(), inputs: number[] = [];
  const result = await proposeModelConsolidations(f.store, f.candidates, rows, model(async (input, signal) => { expect(signal.aborted).toBe(false); expect(input.project).toBe(f.project); expect(input.notes.length).toBeLessThanOrEqual(8); expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(8192); inputs.push(input.notes.length); expect(input.notes.every(row => row.revision.length === 64 && rows.some(original => original.id === row.id && original.text === row.text))).toBe(true); return { text: "INJECTED_MODEL_SUMMARY_MARKER" }; }), f.guard);
  expect(result).toMatchObject({ state: "known", calls: 2, truncated: true }); expect(result.ids).toHaveLength(2); expect(inputs).toEqual([8, 8]); expect(f.bytes()).toEqual(before);
  for (const id of result.ids) { const candidate = f.candidates.get(id, f.project)!; expect(candidate).toMatchObject({ status: "pending", input: { kind: "model-answer", marker: "model-answer", text: "Model answer:\nINJECTED_MODEL_SUMMARY_MARKER" } }); expect(() => f.candidates.accept(id, { project: f.project, actor: "person", verdict: "public", store: f.store, policy: () => true })).toThrow("amem note add"); }
  expect(f.bytes()).toEqual(before);
  expect(packEvidence(f.store.list({ project: f.project }), { project: f.project, question: "public source" }).bundle.entries.every(row => !row.text.includes("INJECTED_MODEL_SUMMARY_MARKER"))).toBe(true);
  const brief = await buildIntentBrief(createIntentBriefSource(f.store, f.project), { project: f.project, cwd: f.root, repo: "fixture", intent: "public", paths: ["public.ts"], policy: () => createStandalonePolicy(), policyVersion: () => "immutable" }); expect(brief.text).not.toContain("INJECTED_MODEL_SUMMARY_MARKER");
  const candidate = f.candidates.get(result.ids[0]!, f.project)!; expect(packEvidence([{ ...rows[0]!, text: candidate.input.kind === "model-answer" ? candidate.input.text : "wrong" }], { project: f.project, question: "summary" }).ids).toEqual([]);
});
test("whole quote input byte limit splits batches or counts oversized sources without clipping them", async () => {
  const f = fixture(), rows = [f.note("a".repeat(4000)), f.note("b".repeat(4000)), f.note("한".repeat(3000))]; let calls = 0;
  const result = await proposeModelConsolidations(f.store, f.candidates, rows, model(async input => { calls++; expect(input.notes).toHaveLength(1); expect(input.notes[0]!.text).toHaveLength(4000); expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(8192); return null; }), f.guard);
  expect(calls).toBe(2); expect(result).toMatchObject({ calls: 2, nonAnswers: 2, oversized: 1, truncated: true, ids: [] }); expect(pending(f)).toEqual([]);
});
test("daily persisted quota reserves nonanswers and failures before callback and resets only on a later UTC day", async () => {
  const f = fixture(), row = f.note("public source"); let calls = 0;
  for (const output of [null, { text: " \n " }, "error", "error"] as const) {
    const result = await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => { calls++; if (output === "error") throw Error("private provider exception"); return output; }), f.guard);
    expect(result.calls).toBe(1); expect(result.ids).toEqual([]); expect(JSON.stringify(result)).not.toContain("private provider exception");
  }
  expect(pending(f)).toEqual([]); expect((await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => { calls++; return null; }), f.guard)).limited).toBe(true); expect(calls).toBe(4);
  f.advance(1); expect((await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => { calls++; return null; }), f.guard)).calls).toBe(1); expect(calls).toBe(5);
  f.advance(-1); expect((await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => { calls++; return null; }), f.guard)).limited).toBe(true); expect(calls).toBe(5);
});
test("oversized model bytes/marked characters refuse while the exact output byte boundary can be a candidate", async () => {
  for (const text of ["한".repeat(2000), "a".repeat(3000), " ".repeat(5000)]) { const f = fixture(), row = f.note("public source"), result = await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => ({ text })), f.guard); expect(result.oversized).toBe(1); expect(result.ids).toEqual([]); expect(pending(f)).toEqual([]); }
  const f = fixture(), row = f.note("public source"), text = "한".repeat(1365) + "a"; expect(Buffer.byteLength(text)).toBe(4096);
  const result = await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => ({ text })), f.guard); expect(result.ids).toHaveLength(1);
});
test("local, foreign, unknown placement and wrong-home inputs refuse before model reservation", async () => {
  for (const variant of ["local", "mixed", "foreign", "unknown", "home"] as const) {
    const f = fixture(), row = f.note("public source", variant === "local" ? { tier: "short" } : variant === "foreign" ? { project: "foreign" } : {}); let calls = 0, reserved = 0;
    const reserve = f.candidates.reserveConsolidationModel.bind(f.candidates); f.candidates.reserveConsolidationModel = bytes => { reserved++; return reserve(bytes); };
    if (variant === "unknown") f.store.entryPlacements = () => new Map();
    const other = variant === "home" ? new CandidateStore({ memoryDir: join(f.root, "other") }) : undefined;
    try { const selected = variant === "mixed" ? [row, f.note("local mixed source", { tier: "short" })] : [row]; const result = await proposeModelConsolidations(f.store, other ?? f.candidates, selected, model(async () => { calls++; return { text: "must not run" }; }), f.guard); expect(result.state).toBe("unknown"); expect(result.ids).toEqual([]); expect(calls).toBe(0); expect(reserved).toBe(0); } finally { other?.close(); }
  }
});
test("source revision changes while the model awaits prevent any candidate write", async () => {
  const f = fixture(), row = f.note("public source"), result = await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => { await Promise.resolve(); f.store.forget(row.id, "person", f.project); return { text: "stale answer" }; }), f.guard);
  expect(result).toMatchObject({ state: "unknown", calls: 1, ids: [] }); expect(pending(f)).toEqual([]);
});
test("output and candidate are screened once; late host guard changes refuse the pending result", async () => {
  const f = fixture(), row = f.note("public source"); let screens = 0;
  f.guard.policy = createStandalonePolicy({ host: { screen: async value => { if (!("output" in (value as object))) return true; screens++; expect(value).toMatchObject({ project: f.project, output: { text: "public summary" }, candidate: { kind: "model-answer", marker: "model-answer" } }); await Promise.resolve(); f.invalidate(); return true; } } });
  const result = await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => ({ text: "public summary" })), f.guard); expect(screens).toBe(1); expect(result.state).toBe("unknown"); expect(result.ids).toEqual([]); expect(pending(f)).toEqual([]);
});
test("output policy denial and output getters never save model content", async () => {
  const f = fixture(), row = f.note("public source"); f.guard.policy = createStandalonePolicy({ piiPatterns: ["WITHHELD_OUTPUT"] });
  expect((await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => ({ text: "WITHHELD_OUTPUT" })), f.guard)).ids).toEqual([]);
  let getters = 0; const output = Object.defineProperty({}, "text", { enumerable: true, get() { getters++; return "hidden"; } }) as { text: string };
  expect((await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => output), f.guard)).ids).toEqual([]); expect(getters).toBe(0); expect(pending(f)).toEqual([]);
});
test("the exported helper screens complete source batches before quota or provider work", async () => {
  const f = fixture(), row = f.note("WITHHELD_SOURCE"), reserve = f.candidates.reserveConsolidationModel.bind(f.candidates); let calls = 0, reservations = 0;
  f.guard.policy = createStandalonePolicy({ piiPatterns: ["WITHHELD_SOURCE"] });
  f.candidates.reserveConsolidationModel = bytes => { reservations++; return reserve(bytes); };
  const result = await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => { calls++; return { text: "public summary" }; }), f.guard);
  expect(result.ids).toEqual([]); expect(result.rejected).toBe(1); expect(calls).toBe(0); expect(reservations).toBe(0); expect(pending(f)).toEqual([]);
});
test("timeout aborts cooperatively and an uncooperative late resolution is never saved", async () => {
  const f = fixture(), row = f.note("public source"); let resolve!: (value: { text: string }) => void, signal: AbortSignal | undefined;
  const late = new Promise<{ text: string }>(done => { resolve = done; }), original = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => original(args[0], args[1] === 10_000 ? 1 : args[1], ...args.slice(2))) as typeof setTimeout;
  try {
    const result = await proposeModelConsolidations(f.store, f.candidates, [row], model(async (_input, current) => { signal = current; return late; }), f.guard);
    expect(result).toMatchObject({ state: "unknown", timedOut: true, calls: 1, ids: [] }); expect(signal?.aborted).toBe(true); resolve({ text: "too late" }); await Promise.resolve(); await Promise.resolve(); expect(pending(f)).toEqual([]);
  } finally { globalThis.setTimeout = original; }
});
test("a later callback failure preserves already queued model candidate ids without private errors", async () => {
  const f = fixture(), rows = Array.from({ length: 9 }, (_, i) => f.note(`source ${i}`)); let calls = 0;
  const result = await proposeModelConsolidations(f.store, f.candidates, rows, model(async () => { if (++calls === 2) throw Error("PRIVATE_PROVIDER_DETAIL"); return { text: "first summary" }; }), f.guard);
  expect(result).toMatchObject({ state: "unknown", calls: 2 }); expect(result.ids).toHaveLength(1); expect(f.candidates.get(result.ids[0]!, f.project)?.status).toBe("pending"); expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_DETAIL");
});

test("a private-span-only model nonanswer cannot leave a marker-only candidate", async () => {
  const f = fixture(), row = f.note("public source"), result = await proposeModelConsolidations(f.store, f.candidates, [row], model(async () => ({ text: "<private>not retainable</private>" })), f.guard);
  expect(result.calls).toBe(1); expect(result.ids).toEqual([]); expect(result.rejected).toBe(1); expect(pending(f)).toEqual([]);
});
test("queue failure after a prior model put keeps its candidate id in the neutral report", async () => {
  const f = fixture(), rows = Array.from({ length: 9 }, (_, i) => f.note(`source ${i}`)), put = f.candidates.put.bind(f.candidates); let calls = 0;
  f.candidates.put = (...args) => { if (++calls === 2) throw Error("PRIVATE_QUEUE_DETAIL"); return put(...args); };
  const result = await proposeModelConsolidations(f.store, f.candidates, rows, model(async () => ({ text: "bounded answer" })), f.guard);
  expect(result.state).toBe("unknown"); expect(result.ids).toHaveLength(1); expect(f.candidates.get(result.ids[0]!, f.project)?.status).toBe("pending"); expect(JSON.stringify(result)).not.toContain("PRIVATE_QUEUE_DETAIL");
});
test("elapsed watchdog refuses a callback that resolves only after its deadline before the timer dispatches", async () => {
  const f = fixture(), row = f.note("public source"), original = performance.now; let ticks = 0, signal: AbortSignal | undefined;
  performance.now = () => ticks++ === 0 ? 0 : 10_001;
  try { const result = await proposeModelConsolidations(f.store, f.candidates, [row], model(async (_input, current) => { signal = current; return { text: "returned beyond deadline" }; }), f.guard); expect(result.timedOut).toBe(true); expect(signal?.aborted).toBe(true); expect(result.ids).toEqual([]); expect(pending(f)).toEqual([]); }
  finally { performance.now = original; }
});
