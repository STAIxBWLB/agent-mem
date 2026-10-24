import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliContext } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { pendingSummary } from "../src/memory/candidate-pending.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore, MEMORY_SCHEMA, entryId, openShardStore, type NoteEntry, type View } from "../src/memory/store.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
type Mode = "legacy" | "generation" | "shards";
const structuredFail = { kind: "fail", approach: "hold one bounded lease", symptom: "the second writer stalls", cause: "the lease spans unrelated work", evidenceRefs: ["test:bounded-lease"], retryWhen: "the contention regression passes" };
async function fixture(mode: Mode = "legacy", secondTarget = false) {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-candidate-decay-cli-"))), base = join(root, "memory"), project = memoryProjectKey(root);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const initial = new MemoryStore({ memoryDir: base, now: () => Date.now() - 120 * 86400_000, deferPromotions: true });
  const target = initial.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", text: "original public writer boundary", peer: "original-peer", source: "person", task: `${project}#99@1`, about: [] });
  const second = secondTarget ? initial.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", text: "another old public boundary", peer: "person", source: "person", about: [] }) : undefined; initial.close();
  if (mode === "generation") await migrate({ memoryDir: base, generation: "d".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  if (mode === "shards") await migrateShards({ memoryDir: base, mode: "apply", authorizedPerson: true, tty: true });
  const open = () => mode === "shards" ? openShardStore({ memoryDir: base, project, deferPromotions: true }) : new MemoryStore({ memoryDir: base, deferPromotions: true });
  const use = <T>(work: (store: MemoryStore) => T): T => { const store = open(); try { return work(store); } finally { store.close(); } };
  const candidates = <T>(work: (store: CandidateStore) => T): T => { const store = new CandidateStore({ memoryDir: base }); try { return work(store); } finally { store.close(); } };
  const bytes = () => Object.fromEntries(readdirSync(base, { recursive: true, withFileTypes: true }).filter(row => row.isFile() && row.name.endsWith(".jsonl")).map(row => { const file = join(row.parentPath, row.name); return [file.slice(base.length), readFileSync(file, "utf8")]; }));
  const cli = async (args: string[], extra: Partial<CliContext> = {}) => {
    const previousHome = process.env.HOME, previousBase = process.env.AMEM_HOME; process.env.HOME = root; process.env.AMEM_HOME = base;
    try { return await runCli(args, { cwd: root, env: {}, stdinTTY: true, ...extra }); }
    finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; if (previousBase === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previousBase; }
  };
  const propose = async () => { const mcp = createMemoryMcp({ cwd: root, base, project }); try { const fail = (await mcp.tools.amem_remember(structuredFail) as { id: string }).id; const correction = (await mcp.tools.amem_correct({ id: target, proposedText: "use a bounded writer lease", reason: "the public regression establishes the boundary", kind: "contract" }) as { id: string }).id; return { fail, correction }; } finally { mcp.close(); } };
  return { root, base, project, target, second, open, use, candidates, bytes, cli, propose };
}
function canonicalPromotion(view: View): string {
  const body: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note", at: view.at, machine: view.machine, project: view.project, scope: view.scope, tier: "long", kind: view.kind, peer: view.peer, text: view.text, about: [...view.about], promotedFrom: view.id, source: view.source as NoteEntry["source"], ...(view.title ? { title: view.title } : {}), ...(view.task ? { task: view.task } : {}) };
  return entryId(body);
}
for (const mode of ["legacy", "generation", "shards"] as const) {
  test(`${mode}: MCP fail/correction remain pending until person CLI accepts into the bound profile`, async () => {
    const f = await fixture(mode), before = f.bytes(), ids = await f.propose(); expect(f.bytes()).toEqual(before);
    const listed = JSON.parse(await f.cli(["review", "list", "--json"])) as Array<{ id: string; status: string }>;
    expect(listed.map(row => row.id).sort()).toEqual(Object.values(ids).sort()); expect(listed.every(row => row.status === "pending")).toBe(true);
    const fail = JSON.parse(await f.cli(["review", "accept", ids.fail, "--json"])), correction = JSON.parse(await f.cli(["review", "accept", ids.correction, "--json"]));
    f.use(store => { expect(store.get(fail.noteId, f.project)).toMatchObject({ kind: "fail", tier: "long", source: "person", peer: "person" }); expect(store.get(fail.noteId, f.project)?.text).toContain(structuredFail.retryWhen); expect(store.get(correction.noteId, f.project)).toMatchObject({ kind: "contract", project: f.project }); expect(store.get(correction.noteId, f.project)?.text).toContain("use a bounded writer lease"); expect(store.get(correction.noteId, f.project)?.text).toContain("Target revision:"); expect(store.get(f.target, f.project)?.supersededBy).toBe(correction.noteId); const dump = store.dump(); store.rebuild(); expect(store.dump()).toBe(dump); });
    const accepted = f.bytes(); expect(JSON.parse(await f.cli(["review", "accept", ids.correction, "--json"]))).toMatchObject({ noteId: correction.noteId, alreadyAccepted: true }); expect(f.bytes()).toEqual(accepted);
  });
  test(`${mode}: goal done offers pending promotion, SessionStart does not mark shown, person walk preserves canonical attribution`, async () => {
    const f = await fixture(mode); let goal = "", note = "";
    const original = f.use(store => { goal = store.goal({ project: f.project, scope: "project", title: "ship public boundary", milestones: [], dependsOn: [], actor: "person" }); const task = `${f.project}#8@10`; store.goalLink(goal, task, "person"); note = store.note({ op: "note", project: f.project, scope: "project", tier: "short", kind: "decision", peer: "native-author", source: "person", text: "actual linked short note body", task, about: [] }); return store.get(note, f.project)!; });
    const before = f.bytes(), report = JSON.parse(await f.cli(["goal", "done", goal, "--json"])); expect(report.promotion.offered).toBe(1); const id = report.promotion.ids[0];
    expect(f.use(store => store.get(note, f.project)?.tier)).toBe("short"); expect(f.candidates(store => store.get(id, f.project)?.status)).toBe("pending");
    expect(Object.values(f.bytes()).join("\n").split('"op":"note"').length).toBe(Object.values(before).join("\n").split('"op":"note"').length);
    const brief = await sessionStartBrief({ cwd: f.root, base: f.base, project: f.project, maxTokens: 1200 }); expect(brief.context).toContain("1 candidate"); expect(pendingSummary(f.base, [f.project], Date.now())).toMatchObject({ count: 1, unshown: 1 });
    expect(JSON.parse(await f.cli(["goal", "done", goal, "--json"])).promotion).toMatchObject({ offered: 0, alreadyOffered: 1 });
    const printed: string[] = []; expect(await f.cli(["review", "walk", "--kind", "promotion"], { write: line => printed.push(line), prompt: () => "a" })).toContain("accepted 1"); expect(printed.join("\n")).toContain(original.text);
    const expected = canonicalPromotion(original); expect(f.candidates(store => store.get(id, f.project))).toMatchObject({ status: "accepted", acceptedNoteId: expected });
    f.use(store => expect(store.get(expected, f.project)).toMatchObject({ promotedFrom: note, peer: original.peer, source: original.source, at: original.at, machine: original.machine, tier: "long" }));
    expect(JSON.parse(await f.cli(["goal", "done", goal, "--json"])).promotion.offered).toBe(0); expect(f.candidates(store => store.list({ project: f.project, status: "all" }))).toHaveLength(1);
  });
}
test("candidate acceptance refuses agents, nonTTY, stale target and current privacy without curated effects", async () => {
  const f = await fixture(), ids = await f.propose(), before = f.bytes();
  await expect(f.cli(["review", "accept", ids.fail], { env: { CLAUDECODE: "" } })).rejects.toThrow("person");
  await expect(f.cli(["review", "accept", ids.fail], { stdinTTY: false })).rejects.toThrow(); expect(f.bytes()).toEqual(before);
  f.use(store => store.demote(f.target, "person", f.project)); const changed = f.bytes(); await expect(f.cli(["review", "accept", ids.correction])).rejects.toThrow(); expect(f.bytes()).toEqual(changed);
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: [structuredFail.cause] }));
  await expect(f.cli(["review", "accept", ids.fail])).rejects.toThrow("privacy"); expect(f.bytes()).toEqual(changed);
  expect(f.candidates(store => store.get(ids.fail, f.project)?.status)).toBe("pending"); expect(f.candidates(store => store.get(ids.correction, f.project)?.status)).toBe("pending");
});
test("rejected MCP proposal identity remains rejected on repeat and does not author notes", async () => {
  const f = await fixture(), ids = await f.propose(), before = f.bytes(); await f.cli(["review", "reject", ids.fail]); const repeated = await f.propose(); expect(repeated).toEqual(ids); expect(f.candidates(store => store.get(ids.fail, f.project)?.status)).toBe("rejected"); expect(f.candidates(store => store.get(ids.correction, f.project)?.status)).toBe("pending"); expect(f.bytes()).toEqual(before);
});
test("decay defaults to a read-only revision preview, then named subset demotes only after printed preview and yes", async () => {
  const f = await fixture("legacy", true), before = f.bytes(), preview = JSON.parse(await f.cli(["decay", "--json"])); expect(preview.entries.map((row: any) => row.target.id).sort()).toEqual([f.target, f.second].sort()); expect(preview.citationHistory).toBe("unknown"); expect(f.bytes()).toEqual(before);
  const printed: string[] = [], questions: string[] = [];
  const applied = JSON.parse(await f.cli(["decay", `mem:${f.target}`, "--apply", "--json"], { write: text => printed.push(text), prompt: question => { questions.push(question); expect(printed.join("\n")).toContain(preview.entries.find((row: any) => row.target.id === f.target).target.revision); expect(f.bytes()).toEqual(before); return "yes"; } }));
  expect(applied).toEqual({ action: "demote", ids: [f.target] }); expect(questions).toHaveLength(1); expect(f.use(store => store.get(f.target, f.project)?.tier)).toBe("short"); expect(f.use(store => store.get(f.second!, f.project)?.tier)).toBe("long");
});
test("bulk decay requires confirmation and forget explicitly names FORGET before removing exact entries", async () => {
  const f = await fixture(), before = f.bytes(); let question = "";
  expect(await f.cli(["decay", "--apply"], { write: () => {}, prompt: q => { question = q; return "no"; } })).toContain("cancelled"); expect(question).toContain("demote"); expect(f.bytes()).toEqual(before);
  const forgotten = JSON.parse(await f.cli(["decay", "--apply", "--forget", "--json"], { write: () => {}, prompt: q => { expect(q).toContain("FORGET"); expect(q).toContain("permanently"); return "yes"; } })); expect(forgotten).toEqual({ action: "forget", ids: [f.target] }); expect(f.use(store => store.get(f.target, f.project))).toBeUndefined();
});
test("decay apply refuses redirected output, nonTTY, agent and cancellation without target writes", async () => {
  const f = await fixture(), before = f.bytes(); let prompts = 0;
  for (const extra of [{ stdinTTY: false, write: () => {} }, { stdoutTTY: false }, { env: { CODEX_THREAD_ID: "" }, write: () => {} }]) await expect(f.cli(["decay", "--apply"], { ...extra, prompt: () => { prompts++; return "yes"; } })).rejects.toThrow();
  expect(prompts).toBe(0); expect(f.bytes()).toEqual(before);
  expect(await f.cli(["decay", "--apply"], { write: () => {}, prompt: () => null })).toContain("cancelled"); expect(f.bytes()).toEqual(before);
});
for (const drift of ["target", "goal", "citation", "policy"] as const) test(`decay ${drift} drift during confirmation refuses the complete batch before effects`, async () => {
  const f = await fixture("legacy", true); let changed: ReturnType<typeof f.bytes> | undefined;
  await expect(f.cli(["decay", "--apply"], { write: () => {}, prompt: () => {
    if (drift === "target") f.use(store => store.demote(f.target, "person", f.project));
    if (drift === "goal") f.use(store => { const goal = store.goal({ project: f.project, scope: "project", title: "new protection", milestones: [], dependsOn: [], actor: "person" }); store.goalLink(goal, `${f.project}#99@1`, "person"); });
    if (drift === "citation") f.candidates(store => store.recordCounter({ project: f.project, entryId: f.target, deliveryId: "confirmed-citation" }, { cited: 1 }, "public"));
    if (drift === "policy") writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["original public writer boundary"] }));
    changed = f.bytes(); return "yes";
  } })).rejects.toThrow(); expect(f.bytes()).toEqual(changed!);
  expect(f.use(store => store.get(f.second!, f.project)?.tier)).toBe("long");
  if (drift !== "target") expect(f.use(store => store.get(f.target, f.project)?.tier)).toBe("long");
});
