import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSyncPolicy, syncOutboundContent, createStandalonePolicy, MemoryStore, entryId } from "../src/index.ts";
import { syncMemory } from "../src/memory/sync.ts";
import * as screens from "../src/memory/sync-screen.ts";
import { migrate } from "../src/memory/migrate.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { openShardStore } from "../src/memory/store.ts";
import { DENY_NAMES, realPath } from "../src/memory/platform.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function temp() { const root = realPath(mkdtempSync(join(tmpdir(), "amem-sync-inspect-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root; }
function fixture() {
  const store = new MemoryStore({ home: temp(), profile: "shared-v1", deferPromotions: true, screen: () => "keep" });
  let closed = false; const close = () => { if (!closed) { store.close(); closed = true; } }; cleanup.push(close);
  return { store, close, home: store.profile.home, own: join(store.dir, "log", `${store.machine.id}.jsonl`) };
}
async function migratedFixture(profile: "generation" | "sharded" = "generation") {
  const f = fixture(), generation = "8".repeat(32); f.close();
  if (profile === "generation") await migrate({ memoryDir: f.home, generation, mode: "apply", authorizedPerson: true, tty: true });
  else await migrateShards({ memoryDir: f.home, generation, mode: "apply", authorizedPerson: true, tty: true });
  const store = profile === "generation" ? new MemoryStore({ memoryDir: f.home, profile: { generation }, deferPromotions: true })
    : openShardStore({ memoryDir: f.home, project: "example.test/team/public", deferPromotions: true });
  cleanup.push(() => store.close());
  return { ...f, store };
}
function appendFixtureRow(store: MemoryStore, index: number, extra: Record<string, unknown> = {}, folder = "log") {
  const body = { schema: "agent-hub.memory/v1", op: "note", at: "2026-11-13T00:00:00.000Z", machine: store.machine.id,
    project: "example.test/team/public", scope: "project", tier: "long", kind: "finding", peer: "fixture", source: "person",
    text: `ordinary bound fixture ${index}`, about: [], ...extra };
  const id = entryId(body as never), file = join(store.dir, folder, `${store.machine.id}.jsonl`);
  appendFileSync(file, JSON.stringify({ ...body, id }) + "\n");
  return { id, file };
}
const note = (store: MemoryStore, text: string, scope: "project" | "shared" = "project") => store.note({ op: "note", project: "example.test/team/public", scope, tier: "long", kind: "finding", peer: "fixture", source: "person", text, about: [] });
function tree(root: string): unknown {
  return readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(item => {
    const file = join(root, item.name), stat = lstatSync(file, { bigint: true });
    if (item.isDirectory()) return [item.name, stat.mode.toString(), stat.mtimeNs.toString(), tree(file)];
    const bytes = readFileSync(file);
    // SQLite read-only SELECTs coordinate through SHM read-mark[0..4], bytes100..119.
    // Keep every other SHM byte, durable DB/WAL byte, file metadata and logical table in the assertion.
    // Format: https://www.sqlite.org/walformat.html#the_wal_index_header
    if (item.name.endsWith("-shm")) bytes.fill(0, 100, 120);
    return [item.name, stat.mode.toString(), stat.mtimeNs.toString(), bytes.toString("base64")];
  });
}
async function actualDeclines(store: MemoryStore, screen?: (row: Record<string, unknown>) => boolean) {
  const real = screens.outboundPolicyEvaluator, declined = new Set<string>();
  const observer = spyOn(screens, "outboundPolicyEvaluator").mockImplementation((home, extra) => {
    const pass = real(home, extra);
    return row => { const accepted = pass(row); if (!accepted.ok) declined.add(row.id as string); return accepted; };
  });
  try { expect((await syncMemory(store, { screen, remote: "https://example.invalid/private.git" })).ok).toBe(false); return [...declined].sort(); }
  finally { observer.mockRestore(); }
}

for (const profile of ["shared-v1", "generation", "sharded", "sharded-v2"] as const) test("public inspection matches actual sync declines without mutating " + profile, async () => {
  const f = fixture(), bad = note(f.store, "private inspection phrase"), good = note(f.store, "ordinary public finding"), user = note(f.store, "private user inspection phrase", "shared");
  f.store.forget(bad, "person");
  let store = f.store;
  if (profile !== "shared-v1") {
    f.close();
    if (profile === "generation") {
      await migrate({ memoryDir: f.home, generation: "4".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
      store = new MemoryStore({ memoryDir: f.home, profile: { generation: "4".repeat(32) }, deferPromotions: true });
    } else {
      await migrateShards({ memoryDir: f.home, generation: "5".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
      if (profile === "sharded-v2") await activatePublicPruneView({ memoryDir: f.home, mode: "apply", authorizedPerson: true, tty: true });
      store = openShardStore({ memoryDir: f.home, project: "example.test/team/public", deferPromotions: true });
    }
    cleanup.push(() => store.close());
  }
  writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["private inspection phrase", "private user inspection phrase"] }));
  const beforeDerived = store.openedSyncTargets().map(target => target.derivedTables());
  const before = tree(f.home);
  const fetchGuard = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw Error("inspection attempted network"); }, { preconnect: fetch.preconnect }));
  const spawnGuard = spyOn(Bun, "spawn").mockImplementation(() => { throw Error("inspection attempted a child"); });
  const syncGuard = spyOn(Bun, "spawnSync").mockImplementation(() => { throw Error("inspection attempted a child"); });
  let result: ReturnType<typeof inspectSyncPolicy>;
  try { result = inspectSyncPolicy(store); }
  finally { fetchGuard.mockRestore(); spawnGuard.mockRestore(); syncGuard.mockRestore(); }
  expect(result.complete).toBe(true);
  if (!result.complete) throw Error("inspection incomplete");
  expect(result.declined.map(row => row.id)).toEqual([bad, user].sort());
  expect(result.declined.flatMap(row => row.categories)).toEqual(["personal-data", "personal-data"]);
  expect(result.declined.some(row => row.id === good)).toBe(false);
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("inspection phrase"); expect(JSON.stringify(result)).not.toContain(f.home);
  expect(store.openedSyncTargets().map(target => target.derivedTables())).toEqual(beforeDerived);
  expect(tree(f.home)).toEqual(before);
  expect(await actualDeclines(store)).toEqual(result.declined.map(row => row.id));
});

for (const profile of ["generation", "sharded"] as const) test(`${profile} inspection explains a completed sync refusal above 8 MiB and below the outbound row cap`, async () => {
  const f = await migratedFixture(profile), { id, file } = appendFixtureRow(f.store, 0, { future: "x".repeat(9 * 1024 * 1024) });
  expect(lstatSync(file).size).toBeGreaterThan(8 * 1024 * 1024);
  let visibilityChecks = 0;
  const actual = await syncMemory(f.store, { remote: "https://example.invalid/private.git", screen: () => false,
    visibility: async () => { visibilityChecks++; return "private"; } });
  expect(actual).toMatchObject({ ok: false, error: expect.stringContaining("declines 1") });
  expect(visibilityChecks).toBe(0);
  const result = inspectSyncPolicy(f.store, { screen: () => false });
  expect(result.complete).toBe(true);
  if (result.complete) expect(result.declined.map(row => row.id)).toEqual([id]);
});

test("generation inspection does not confuse duplicated physical rows with canonical outbound rows", async () => {
  const f = await migratedFixture(), { id, file } = appendFixtureRow(f.store, 0);
  const row = readFileSync(file, "utf8"); writeFileSync(file, row.repeat(20_001));
  const actual = await syncMemory(f.store, { remote: "https://example.invalid/private.git", screen: () => false });
  expect(actual).toMatchObject({ ok: false, error: expect.stringContaining("declines 1") });
  expect(inspectSyncPolicy(f.store, { screen: () => false })).toMatchObject({ complete: true, counts: { scanned: 1, declined: 1 }, declined: [{ id }] });
});

test("canonical outbound row admission is per target rather than global across project and user", async () => {
  const f = await migratedFixture("sharded"), targets = f.store.openedSyncTargets();
  expect(targets).toHaveLength(2);
  for (const target of targets) {
    const lines: string[] = [];
    for (let index = 0; index < 10_001; index++) {
      const body = { schema: "agent-hub.memory/v1", op: "note", at: "2026-11-13T00:00:00.000Z", machine: target.machine.id,
        project: target.profile.shardUser ? "example.test/team/user" : "example.test/team/public", scope: target.profile.shardUser ? "shared" : "project",
        tier: "long", kind: "finding", peer: "fixture", source: "person", text: `canonical bound fixture ${index}`, about: [] };
      lines.push(JSON.stringify({ ...body, id: entryId(body as never) }));
    }
    appendFileSync(join(target.dir, "log", `${target.machine.id}.jsonl`), lines.join("\n") + "\n");
  }
  const actual = await syncMemory(f.store, { remote: "https://example.invalid/private.git", screen: () => false });
  expect(actual).toMatchObject({ ok: false, error: expect.stringContaining("declines 10001") });
  const result = inspectSyncPolicy(f.store, { screen: () => false });
  expect(result).toMatchObject({ complete: true, counts: { scanned: 20_002, declined: 20_002 } });
});

test("a generation above the canonical row limit reports the same named row bound as sync", async () => {
  const f = await migratedFixture(), lines: string[] = [];
  for (let index = 0; index < 20_001; index++) {
    const body = { schema: "agent-hub.memory/v1", op: "note", at: "2026-11-13T00:00:00.000Z", machine: f.store.machine.id,
      project: "example.test/team/public", scope: "project", tier: "long", kind: "finding", peer: "fixture", source: "person", text: `canonical row ${index}`, about: [] };
    lines.push(JSON.stringify({ ...body, id: entryId(body as never) }));
  }
  appendFileSync(join(f.store.dir, "log", `${f.store.machine.id}.jsonl`), lines.join("\n") + "\n");
  const actual = await syncMemory(f.store, { remote: "https://example.invalid/private.git", screen: () => false });
  expect(actual).toMatchObject({ ok: false, error: expect.stringContaining("more than 20000") });
  const result = inspectSyncPolicy(f.store);
  expect(result).toMatchObject({ complete: false, reason: "input-bound", bound: { kind: "rows", limit: 20_000, observed: 20_001, nextStep: expect.any(String) } });
  expect(result).not.toHaveProperty("declined"); expect(result).not.toHaveProperty("fingerprint");
});

test("full declined set beyond eight IDs and stable sorted fingerprint are not truncated", () => {
  const f = fixture(), ids = Array.from({ length: 12 }, (_, index) => note(f.store, `private-word row ${index}`));
  writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["private-word"] }));
  const first = inspectSyncPolicy(f.store), second = inspectSyncPolicy(f.store);
  expect(first).toEqual(second); expect(first.complete).toBe(true);
  if (!first.complete) throw Error("incomplete");
  expect(first.declined.map(row => row.id)).toEqual(ids.sort()); expect(first.counts.declined).toBe(12);
  writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["private-word", "irrelevant private policy literal"] }));
  const sameSet = inspectSyncPolicy(f.store); expect(sameSet.complete).toBe(true);
  if (sameSet.complete) expect(sameSet.fingerprint).toBe(first.fingerprint);
  writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["private-word row 0"] }));
  const narrowed = inspectSyncPolicy(f.store); expect(narrowed.complete).toBe(true);
  if (narrowed.complete) expect(narrowed.fingerprint).not.toBe(first.fingerprint);
});

test("canonical root projection includes future fields and non-note content, excludes only generated top-level fields", async () => {
  const f = fixture(); note(f.store, "ordinary row");
  const goal = f.store.goal({ project: "example.test/team/public", scope: "project", title: "ordinary goal", milestones: ["ordinary milestone"], dependsOn: [], actor: "person" });
  const original = readFileSync(f.own, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>).find(row => row.id === goal)!;
  const { id: _id, ...body } = original;
  const extended = { ...body, title: "private-new-title", future: { text: "private-new-field" } };
  const id = entryId(extended as never);
  appendFileSync(f.own, JSON.stringify({ ...extended, id }) + "\n");
  writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["private-new"] }));
  const result = inspectSyncPolicy(f.store);
  expect(result.complete).toBe(true); if (result.complete) expect(result.declined.map(row => row.id)).toEqual([id]);
  expect(await actualDeclines(f.store)).toEqual([id]);
  const projected = syncOutboundContent({ id, op: "note", actor: "generated-secret", text: "ordinary", future: { unknown: "private-new-field" } });
  expect(projected).toEqual({ text: "ordinary", future: { unknown: "private-new-field" } });
  expect(createStandalonePolicy({ piiPatterns: ["private-new"] }).screenStandalone(projected)).toBe(false);
  let getterCalls = 0;
  expect(() => syncOutboundContent({ get future() { getterCalls++; return "bad"; } })).toThrow("outbound row unavailable"); expect(getterCalls).toBe(0);
});

test("host narrowing cannot override machine policy and host failures contain no exception data", () => {
  const f = fixture(), machine = note(f.store, "machine-private"), host = note(f.store, "host-private");
  writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["machine-private"] }));
  const result = inspectSyncPolicy(f.store, { screen: row => row.text !== "host-private" });
  expect(result.complete).toBe(true);
  if (result.complete) expect(result.declined).toEqual([ { id: machine, categories: ["personal-data" as const] }, { id: host, categories: ["host" as const] } ].sort((a,b) => a.id.localeCompare(b.id)));
  expect(inspectSyncPolicy(f.store, { screen: () => { throw Error("private error literal /hidden/path"); } })).toEqual({ complete: false, reason: "policy-unavailable" });
});

for (const suffix of ['{"id":', JSON.stringify({ id: "b".repeat(32), text: "torn private row" }), 'null\n', '[]\n']) test("malformed or incomplete input never reports complete empty: " + suffix.length, () => {
  const f = fixture(); note(f.store, "public"); appendFileSync(f.own, suffix);
  const result = inspectSyncPolicy(f.store); expect(result.complete).toBe(false); expect("fingerprint" in result).toBe(false); expect("declined" in result).toBe(false);
});

test("8 MiB source bound is checked before body read and no partial declined set is returned", () => {
  const f = fixture(); note(f.store, "private-word"); truncateSync(f.own, 8 * 1024 * 1024 + 1);
  expect(inspectSyncPolicy(f.store)).toMatchObject({ complete: false, reason: "input-bound", bound: {
    kind: "bytes", limit: 8 * 1024 * 1024, observed: 8 * 1024 * 1024 + 1, nextStep: expect.any(String),
  } });
});

test("20000-row bound refuses before parsing the next row or constructing a complete set", () => {
  const f = fixture();
  note(f.store, "ordinary");
  const row = readFileSync(f.own, "utf8");
  writeFileSync(f.own, row.repeat(20_001));
  expect(inspectSyncPolicy(f.store)).toMatchObject({ complete: false, reason: "input-bound", bound: {
    kind: "rows", limit: 20_000, observed: 20_001, nextStep: expect.any(String),
  } });
});

test("host-side input or policy drift makes the entire inspection incomplete", () => {
  const f = fixture(); note(f.store, "ordinary");
  const first = JSON.parse(readFileSync(f.own, "utf8").trim()) as Record<string, unknown>;
  const { id: _id, ...body } = first;
  const later = { ...body, text: "later" };
  const changed = inspectSyncPolicy(f.store, { screen: () => { appendFileSync(f.own, JSON.stringify({ ...later, id: entryId(later as never) }) + "\n"); return true; } });
  expect(changed).toEqual({ complete: false, reason: "input-changed" });
  const policyChange = inspectSyncPolicy(f.store, { screen: () => { writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["private-new"] })); return true; } });
  expect(policyChange.complete).toBe(false);
  let version = "1";
  expect(inspectSyncPolicy(f.store, { policyVersion: () => version, screen: () => { version = "2"; return true; } })).toEqual({ complete: false, reason: "policy-unavailable" });
});


test("mutable canonical default policy drift cannot certify a complete set", () => {
  const f = fixture(); note(f.store, "ordinary canaryfile.txt");
  const length = DENY_NAMES.length;
  try {
    const result = inspectSyncPolicy(f.store, { screen: () => { DENY_NAMES.push("^canaryfile.txt$"); return true; } });
    expect(result).toEqual({ complete: false, reason: "policy-unavailable" });
  } finally { DENY_NAMES.length = length; }
});


for (const value of [undefined, null, 1]) test("a provided nonboolean host decision is incomplete: " + String(value), () => {
  const f = fixture(); note(f.store, "ordinary");
  expect(inspectSyncPolicy(f.store, { screen: (() => value) as never })).toEqual({ complete: false, reason: "policy-unavailable" });
});

test("default policy loosen-and-restore across rows cannot hide a declined row", () => {
  const f = fixture(); note(f.store, "ordinary first row"); note(f.store, "a path to .env");
  const before = [...DENY_NAMES]; let calls = 0;
  try {
    const result = inspectSyncPolicy(f.store, { screen: () => {
      if (++calls === 1) DENY_NAMES.splice(0, DENY_NAMES.length);
      else DENY_NAMES.push(...before);
      return true;
    } });
    expect(result).toEqual({ complete: false, reason: "policy-unavailable" });
  } finally { DENY_NAMES.splice(0, DENY_NAMES.length, ...before); }
});

test("a user-overlay callback cannot change an earlier canonical target and certify a complete set", async () => {
  const f = fixture(); note(f.store, "canonical original"); note(f.store, "overlay marker", "shared"); f.close();
  await migrateShards({ memoryDir: f.home, generation: "6".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  const store = openShardStore({ memoryDir: f.home, project: "example.test/team/public", deferPromotions: true }); cleanup.push(() => store.close());
  const authored = note(store, "canonical fresh row"), canonical = store.openedSyncTargets()[0]!;
  const file = join(canonical.dir, "log", `${canonical.machine.id}.jsonl`);
  const original = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>).find(row => row.id === authored)!;
  const { id: _id, ...body } = original, later = { ...body, text: "canonical changed during overlay" };
  let changed = false;
  const result = inspectSyncPolicy(store, { screen: row => {
    if (row.text === "overlay marker") { appendFileSync(file, JSON.stringify({ ...later, id: entryId(later as never) }) + "\n"); changed = true; }
    return true;
  } });
  expect(changed).toBe(true); expect(result.complete).toBe(false); expect("fingerprint" in result).toBe(false);
});
