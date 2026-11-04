import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, createStandalonePolicy, entryId, inspectSyncPolicy, syncOutboundContent } from "../src/index.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { openShardStore } from "../src/memory/store.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";

const PROJECT = "example.test/operation-content/project", MARKER = "private-operation-codename", TASK = `example.test/${MARKER}/board#42@1000`;
const SETTLE_TASK = `${PROJECT}#${MARKER}@1000`;
const G = "9".repeat(32), privately = { visibility: async () => "private" as const };
type Profile = "shared-v1" | "generation" | "sharded" | "sharded-v2";
const closes: (() => void)[] = [], dirs: string[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); for (const dir of dirs.splice(0).reverse()) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-op-content-"))); dirs.push(dir); return dir; }
function keep(store: MemoryStore) { let closed = false; const close = () => { if (!closed) { store.close(); closed = true; } }; closes.push(close); return { store, close }; }
function git(dir: string, ...args: string[]): string {
  const result = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw Error(`operation-content fixture Git failed: ${result.stderr}`);
  return result.stdout.trim();
}
function remote(): string { const dir = temp(); git(dir, "init", "-q", "--bare"); return dir; }
function rows(file: string): Record<string, unknown>[] { return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; }
function ownRows(store: MemoryStore): Record<string, unknown>[] { return store.openedSyncTargets().flatMap(target => rows(join(target.dir, "log", `${target.machine.id}.jsonl`))); }
function publicNote(store: MemoryStore, text = "ordinary permitted row"): string {
  return store.note({ op: "note", project: PROJECT, scope: "project", tier: "long", kind: "finding", peer: "fixture", source: "person", text, about: [] });
}
async function converted(profile: Profile, existing?: ReturnType<typeof keep>) {
  const legacy = existing ?? keep(new MemoryStore({ home: temp(), profile: "shared-v1", deferPromotions: true, screen: () => "keep" }));
  if (!existing) publicNote(legacy.store);
  const home = legacy.store.profile.home;
  if (profile === "shared-v1") return { ...legacy, home };
  legacy.close();
  if (profile === "generation") {
    await migrate({ memoryDir: home, generation: G, mode: "apply", authorizedPerson: true, tty: true });
    return { ...keep(new MemoryStore({ memoryDir: home, profile: { generation: G }, deferPromotions: true })), home };
  }
  await migrateShards({ memoryDir: home, generation: G, mode: "apply", authorizedPerson: true, tty: true });
  if (profile === "sharded-v2") await activatePublicPruneView({ memoryDir: home, mode: "apply", authorizedPerson: true, tty: true });
  return { ...keep(openShardStore({ memoryDir: home, project: PROJECT, deferPromotions: true })), home };
}
function goalLink(store: MemoryStore, scope: "project" | "shared"): string {
  const goal = store.goal({ project: PROJECT, scope, title: "ordinary permitted goal", milestones: [], dependsOn: [], actor: "person" });
  store.goalLink(goal, TASK, "person");
  const authored = ownRows(store).find(row => row.op === "goal_link" && row.target === goal && row.by === TASK);
  expect(authored).toBeDefined(); return authored!.id as string;
}
function noPublication(url: string): void {
  expect(git(url, "for-each-ref", "--format=%(refname)")).toBe("");
  // A refused policy preflight must not send even unreachable private blobs to this fresh fake remote.
  expect(git(url, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)")).toBe("");
}
function blobs(url: string): string[] {
  return git(url, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)").split("\n")
    .filter(line => line.endsWith(" blob")).map(line => git(url, "cat-file", "blob", line.split(" ")[0]!));
}
async function expectDecline(store: MemoryStore, home: string, id: string, url: string): Promise<void> {
  writeFileSync(join(home, "amem.config.json"), JSON.stringify({ piiPatterns: [MARKER] }));
  const inspection = inspectSyncPolicy(store);
  expect(inspection.complete).toBe(true);
  if (!inspection.complete) throw Error("operation-content inspection incomplete");
  expect(inspection.declined).toEqual([{ id, categories: ["personal-data"] }]);
  expect(inspection.counts.byCategory["personal-data"]).toBe(1);
  expect(JSON.stringify(inspection)).not.toContain(MARKER); expect(JSON.stringify(inspection)).not.toContain(TASK);
  const result = await syncMemory(store, { remote: url, ...privately });
  expect(result).toMatchObject({ ok: false, pushed: false });
  expect(result.error).toContain("configured privacy policy declines"); noPublication(url);
}

const linkCases: { name: string; profile: Profile; scope: "project" | "shared"; bridge: boolean }[] = [
  { name: "shared-v1 native", profile: "shared-v1", scope: "project", bridge: false },
  { name: "generation native", profile: "generation", scope: "project", bridge: false },
  { name: "generation legacy bridge", profile: "generation", scope: "project", bridge: true },
  { name: "sharded native project", profile: "sharded", scope: "project", bridge: false },
  { name: "sharded native user overlay", profile: "sharded", scope: "shared", bridge: false },
  { name: "sharded legacy project bridge", profile: "sharded", scope: "project", bridge: true },
  { name: "sharded-v2 native project", profile: "sharded-v2", scope: "project", bridge: false },
  { name: "sharded-v2 native user overlay", profile: "sharded-v2", scope: "shared", bridge: false },
  { name: "sharded-v2 legacy user bridge", profile: "sharded-v2", scope: "shared", bridge: true },
];
for (const sample of linkCases) test(`contentful goal_link.by refuses actual sync and root inspection: ${sample.name}`, async () => {
  const url = remote(); let id: string, opened: Awaited<ReturnType<typeof converted>>;
  if (sample.bridge) {
    const legacy = keep(new MemoryStore({ home: temp(), profile: "shared-v1", deferPromotions: true, screen: () => "keep" }));
    publicNote(legacy.store); id = goalLink(legacy.store, sample.scope); opened = await converted(sample.profile, legacy);
  } else { opened = await converted(sample.profile); id = goalLink(opened.store, sample.scope); }
  await expectDecline(opened.store, opened.home, id, url);
});

test("defensive shared-v1 physical own segment screens a misplaced canonical local settle.target", async () => {
  const f = await converted("shared-v1"), url = remote();
  f.store.settle(SETTLE_TASK, "person");
  const local = rows(join(f.store.dir, "local", `${f.store.machine.id}.jsonl`)).find(row => row.op === "settle" && row.target === SETTLE_TASK);
  expect(local).toBeDefined();
  // The public writer correctly used local/. Copy its unchanged canonical row to exercise the raw-log defensive boundary only.
  appendFileSync(join(f.store.dir, "log", `${f.store.machine.id}.jsonl`), JSON.stringify(local) + "\n");
  await expectDecline(f.store, f.home, local!.id as string, url);
});

for (const profile of ["shared-v1", "generation", "sharded", "sharded-v2"] as const) test("legitimate local settle stays local and does not falsely block allowed publication: " + profile, async () => {
  const f = await converted(profile), url = remote();
  publicNote(f.store, "public settlement exclusion sentinel"); f.store.settle(SETTLE_TASK, "person");
  writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: [MARKER] }));
  expect(f.store.openedSyncTargets().some(target => rows(join(target.dir, "local", `${target.machine.id}.jsonl`)).some(row => row.op === "settle" && row.target === SETTLE_TASK))).toBe(true);
  const inspection = inspectSyncPolicy(f.store);
  expect(inspection.complete).toBe(true); if (inspection.complete) expect(inspection.declined).toEqual([]);
  expect(await syncMemory(f.store, { remote: url, ...privately })).toMatchObject({ ok: true, pushed: true });
  const published = blobs(url);
  expect(published.some(blob => blob.includes("public settlement exclusion sentinel"))).toBe(true);
  for (const blob of published) {
    expect(blob).not.toContain(MARKER);
    for (const line of blob.split("\n")) { try { expect((JSON.parse(line) as { op?: unknown }).op).not.toBe("settle"); } catch (error) { if (line.startsWith("{")) throw error; } }
  }
});

test("validated id, enum, UTC and suggested-relation operands introduce no actual sync declines", async () => {
  const f = await converted("shared-v1"), url = remote(), first = publicNote(f.store, "first public metadata sentinel"), second = publicNote(f.store, "second public metadata sentinel");
  const goal = f.store.goal({ project: PROJECT, scope: "project", title: "ordinary public goal", milestones: [], dependsOn: [], actor: "person" });
  const at = new Date().toISOString(), expiry = "2099-01-01T00:00:00.000Z", base = { schema: "agent-hub.memory/v1", at, machine: f.store.machine.id, actor: "person" };
  const bodies = [
    { ...base, op: "forget", target: first },
    { ...base, op: "supersede", target: first, by: second },
    { ...base, op: "demote", target: second, by: expiry },
    { ...base, op: "goal_state", target: goal, by: "done" },
    { ...base, op: "lease", target: goal, by: expiry },
    { ...base, op: "lease_force", target: goal, by: expiry },
    { ...base, op: "suggest", target: first, by: `same_topic:${second}` },
  ];
  for (const body of bodies) {
    const id = entryId(body as never); appendFileSync(join(f.store.dir, "log", `${f.store.machine.id}.jsonl`), JSON.stringify({ ...body, id }) + "\n");
    expect(syncOutboundContent({ ...body, id })).toEqual({});
  }
  writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: [first, second, goal, at, expiry, "done", "same_topic"] }));
  const inspection = inspectSyncPolicy(f.store);
  expect(inspection.complete).toBe(true); if (inspection.complete) expect(inspection.declined).toEqual([]);
  expect(await syncMemory(f.store, { remote: url, ...privately })).toMatchObject({ ok: true, pushed: true });
});

for (const field of ["target", "by"] as const) test("undeclared operation field remains content despite its operand-like name: " + field, async () => {
  const f = await converted("shared-v1"), url = remote();
  const original = ownRows(f.store).find(row => row.op === "note")!;
  const { id: _id, ...body } = original, extended = { ...body, [field]: MARKER }, id = entryId(extended as never);
  appendFileSync(join(f.store.dir, "log", `${f.store.machine.id}.jsonl`), JSON.stringify({ ...extended, id }) + "\n");
  expect(syncOutboundContent({ ...extended, id })[field]).toBe(MARKER);
  await expectDecline(f.store, f.home, id, url);
});

test("unknown or malformed operands stay content and root projection reports the same category", () => {
  const policy = createStandalonePolicy({ piiPatterns: [MARKER] });
  for (const row of [
    { op: "future_operation", target: MARKER, by: MARKER },
    { op: "forget", target: MARKER },
    { op: "lease", target: "a".repeat(32), by: MARKER },
    { op: "suggest", target: "a".repeat(32), by: `unreviewed_relation:${MARKER}` },
    { op: "goal_link", target: "a".repeat(32), by: TASK },
    { op: "settle", target: TASK, by: "2099-01-01T00:00:00.000Z" },
  ]) expect(policy.inspectStandalone(syncOutboundContent(row))).toEqual({ ok: false, category: "personal-data" });
  const id = "a".repeat(32), fixed = createStandalonePolicy({ piiPatterns: [id, "same_topic"] });
  expect(fixed.inspectStandalone(syncOutboundContent({ op: "suggest", target: id, by: `same_topic:${id}` }))).toEqual({ ok: true });
  expect(fixed.inspectStandalone(syncOutboundContent({ op: "note", target: id }))).toEqual({ ok: false, category: "personal-data" });
});
