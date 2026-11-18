import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIntentBrief, type IntentBriefOptions, type IntentBriefSource } from "../src/memory/intent-brief.ts";
import { planGuardNodes, planNodesIntersect } from "../src/memory/plan-guard.ts";
import { createStandalonePolicy, memoryPolicySnapshot } from "../src/memory/policy.ts";
import { createIntentBriefSource } from "../src/memory/recall.ts";
import { looksSecret } from "../src/memory/screen.ts";
import { MemoryStore } from "../src/memory/store.ts";

/** #316 step 1: where the intent brief's time goes on a fixture of the hub's own size. */
const ROWS = 2400, RUNS = 3, NOW = Date.parse("2026-11-19T00:00:00.000Z");
const root = mkdtempSync(join(tmpdir(), "amem-316-")), project = "agent-mem";
const named = "src/memory/writer.ts";

/** A hub-like per-row callback: a full JSON render, a secret scan and a private-path match, all synchronous inside the await. */
let screenCalls = 0;
const hubLikeScreen = async (value: unknown): Promise<boolean> => {
  screenCalls++;
  const text = JSON.stringify(value);
  if (text.length > 64 * 1024) return false;
  return !looksSecret(text) && !/(?:^|\W)(?:\/Users\/|\/home\/)[^"\\\s]{8,}/.test(text);
};
const trivialScreen = async (): Promise<boolean> => true;

const options = (screen: (value: unknown) => Promise<boolean>): IntentBriefOptions => ({
  project,
  cwd: "/unopened/repo",
  repo: "yj.lee/agent-mem",
  intent: "repair the writer lease boundary",
  paths: [named],
  maxBytes: 2048,
  policy: () => createStandalonePolicy({ host: { screen } }),
  policyVersion: () => "fixture-v1",
  now: () => NOW,
});

const summary = (ms: readonly number[]) => {
  const sorted = [...ms].sort((a, b) => a - b);
  return { min: sorted[0]!, median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
};
const time = async (label: string, run: () => Promise<unknown> | unknown) => {
  const ms: number[] = [];
  for (let index = 0; index < RUNS; index++) {
    const start = performance.now();
    await run();
    ms.push(Math.round((performance.now() - start) * 10) / 10);
  }
  return { label, runs: ms, ...summary(ms) };
};

try {
  const store = new MemoryStore({ home: root, deferPromotions: true, now: () => NOW });
  const writes: number[] = [];
  // A realistic share of the shard is about the task's own node: 40 rows, plus the near rows that share an issue or symbol with them.
  for (let index = 0; index < ROWS; index++) {
    const kind = index % 5 < 2 ? "fail" : index % 5 < 4 ? "decision" : "contract";
    const about = index % 60 === 0 ? [`path:${named}`, `symbol:Writer.run@${named}`] : [`path:src/memory/module${index % 90}.ts`];
    const start = performance.now();
    store.note({
      op: "note", project, scope: "project", tier: "long", kind, peer: "person", source: "person",
      ...(index % 3 === 0 ? { title: `writer boundary ${index}` } : {}),
      text: `writer lease boundary observation ${index}: the write path holds the curated lock across the publish step and the reader waits for the refreshed index before it answers. measured ${index % 400} ms at ${index % 24} rows.`,
      about,
    });
    writes.push(performance.now() - start);
  }

  // A: the snapshot fold alone (entry/op fold plus up to 5000 bodies).
  const snapshot = await time("A_intentSnapshot", () => store.intentSnapshot(project));
  const cached = store.intentSnapshot(project).rows;
  const cachedSource: IntentBriefSource = { notes: () => cached };

  // B: ranking, formatting and output over already-folded rows, with no per-row policy cost.
  const trivial = await time("B_brief_cached_trivial_screen", () => buildIntentBrief(cachedSource, options(trivialScreen)));

  // C: the same cached rows behind the hub-like per-row screen.
  screenCalls = 0;
  const screened = await time("C_brief_cached_hub_screen", () => buildIntentBrief(cachedSource, options(hubLikeScreen)));
  const screensPerRun = screenCalls / RUNS;

  // D: the live source (snapshot + preferences read + guards) behind the hub-like screen.
  screenCalls = 0;
  const live = await time("D_brief_live_source_hub_screen", () => buildIntentBrief(createIntentBriefSource(store, project), options(hubLikeScreen)));

  // E: the per-row screen alone, over the same rows, for the callback's own unit cost.
  const bare = await time("E_bare_screen_loop", async () => {
    const policy = createStandalonePolicy({ host: { screen: hubLikeScreen } });
    for (const view of cached) if (!await policy.screen(view)) throw Error("fixture row screened out");
    return cached.length;
  });

  // F1-F4: the loop's own per-row parts, over the same views, so the split does not rest on subtracting runs.
  const plain = await time("F1_await_only", async () => {
    for (const view of cached) { if (!view.id) throw Error("fixture row lacks an id"); await Promise.resolve(); }
    return cached.length;
  });
  const cloneOnly = await time("F2_memoryPolicySnapshot", () => {
    for (const view of cached) if (!memoryPolicySnapshot(view)) throw Error("fixture row did not snapshot");
    return cached.length;
  });
  const policyOnly = await time("F3_policy_screen", async () => {
    const policy = createStandalonePolicy({ host: { screen: hubLikeScreen } });
    for (const view of cached) if (!await policy.screen(view)) throw Error("fixture row screened out");
    return cached.length;
  });
  const screenBodyOnly = await time("F4_screen_body", async () => {
    for (const view of cached) if (!await hubLikeScreen(view)) throw Error("fixture row screened out");
    return cached.length;
  });

  // F5: what a relevance prefilter costs, and how many rows it would leave to screen.
  const context = { project, cwd: "/unopened/repo", repo: "yj.lee/agent-mem" };
  const nodes = planGuardNodes({ paths: [named], symbols: [] }, context);
  let narrowed = 0;
  const narrow = await time("F5_relevance_prefilter", () => {
    let kept = 0;
    for (const view of cached) if (view.about.some(about => nodes.some(node => planNodesIntersect(node, about)))) kept++;
    narrowed = kept;
    return kept;
  });

  const trivialBrief = await buildIntentBrief(cachedSource, options(trivialScreen));
  const screenedBrief = await buildIntentBrief(cachedSource, options(hubLikeScreen));
  store.close();
  console.log(JSON.stringify({
    fixture: "temp home, one project, 2400 long-term fail/decision/contract rows; 40 about the task's own path and symbol, the rest about other modules",
    rows: cached.length,
    planNodes: nodes,
    rowsAboutTheTask: narrowed,
    fixtureWriteMs: summary(writes),
    results: [snapshot, trivial, screened, live, bare, plain, cloneOnly, policyOnly, screenBodyOnly, narrow],
    perRowUs: { hubLikeScreen: Math.round((bare.median * 1000) / cached.length * 10) / 10, prefilter: Math.round((narrow.median * 1000) / cached.length * 10) / 10 },
    brief: { items: screenedBrief.items.length, bytes: screenedBrief.bytes, truncated: screenedBrief.truncated, state: screenedBrief.state, screensPerRun },
    trivialBrief: { items: trivialBrief.items.length, bytes: trivialBrief.bytes, truncated: trivialBrief.truncated, state: trivialBrief.state },
    screenChangedSelection: trivialBrief.items.map(view => view.id).join() !== screenedBrief.items.map(view => view.id).join(),
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
