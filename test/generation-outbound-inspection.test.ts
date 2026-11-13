import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { indexFileName } from "../src/memory/index-file.ts";
import { inspectSyncPolicy } from "../src/memory/sync-policy-inspection.ts";
import { appendFileSync, closeSync, constants, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, entryId, type Entry } from "../src/memory/store.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { migrate } from "../src/memory/migrate.ts";
import { SegmentReader, SegmentReadBudgetError } from "../src/memory/bridge.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const prune = JSON.parse(readFileSync(new URL("./fixtures/generation-prune.json", import.meta.url), "utf8")).prune as Record<string, unknown>;
const G = String(prune.generation), NOW = Date.parse("2030-01-01T00:00:00.000Z");
const limits = { maxBytes: 8 * 1024 * 1024, maxRows: 20_000 };
const note = (text: string) => ({ op: "note" as const, project: "agent-hub", scope: "project" as const, tier: "long" as const, kind: "finding" as const, peer: "person", source: "person" as const, text, about: [] });
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amem-generation-outbound-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const old = new MemoryStore({ home, now: () => NOW, deferPromotions: true });
  const legacy = old.note(note("outbound legacy public")), forgotten = old.note(note("outbound forgotten original"));
  old.forget(forgotten, "person");
  const memory = old.dir; old.close();
  await migrate({ memoryDir: memory, mode: "apply", generation: G, authorizedPerson: true, tty: true, now: () => NOW });
  const store = new MemoryStore({ home, now: () => NOW, deferPromotions: true });
  cleanup.push(() => store.close());
  const own = store.note(note("outbound own public"));
  store.note({ ...note("outbound private short"), tier: "short" });
  return { home, memory, store, legacy, forgotten, own, file: join(store.dir, "log", `${store.machine.id}.jsonl`) };
}
function rawRows(store: MemoryStore): Entry[] {
  return ["log", "local"].flatMap(folder => readdirSync(join(store.dir, folder)).filter(name => name.endsWith(".jsonl")).flatMap(name => readFileSync(join(store.dir, folder, name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Entry)));
}
function errorCode(work: () => unknown): string | undefined {
  try { work(); } catch (error) { expect((error as Error).message).toBe("outbound generation input unavailable"); return (error as { code?: string }).code; }
  throw Error("expected inspection to refuse");
}

test("generation outbound inspection preserves canonical raw forgotten/unknown content without refreshing derived state", async () => {
  const f = await fixture(), own = rawRows(f.store).find(row => row.id === f.own)!;
  f.store.recordVaultLink(f.own, "notes/outbound-inspection.md", "agent-hub", hashJSON(own));
  const expected = f.store.prunePort().snapshot().rows.filter(row => row.placement === "synced" && (row.own || row.legacy)).map(row => row.row.id);
  const legacy = rawRows(f.store).find(row => row.id === f.legacy)
    ?? JSON.parse(readFileSync(join(f.memory, "log", readdirSync(join(f.memory, "log"))[0]!), "utf8").split("\n").find(line => line.includes(f.legacy))!) as Entry;
  const { id: _id, ...body } = own;
  const extended = { ...body, unknownContent: { nested: ["synthetic canary outside known fields"] } };
  const unknown = { ...extended, id: entryId(extended as unknown as Omit<Entry, "id">) };
  appendFileSync(f.file, canonicalJSON(unknown) + "\n" + canonicalJSON(legacy) + "\n");
  appendFileSync(join(f.store.dir, "local", `${String(prune.machine)}.jsonl`), canonicalJSON(prune) + "\n");
  const before = f.store.derivedTables(), visited: Record<string, unknown>[] = [];
  const recheck = f.store.inspectOutboundRows(row => { visited.push(row); if (row.id === f.own) row.text = "visitor mutation is isolated"; }, limits);
  recheck();
  expect(visited.map(row => row.id).sort()).toEqual([...expected, unknown.id].sort());
  expect(visited.some(row => row.id === f.forgotten && row.text === "outbound forgotten original")).toBe(true);
  expect(visited.find(row => row.id === unknown.id)?.unknownContent).toEqual(extended.unknownContent);
  expect(visited.some(row => row.op === "prune" || row.op === "vault_link" || row.text === "outbound private short")).toBe(false);
  expect(f.store.derivedTables()).toEqual(before);
});

test("generation outbound recheck detects a callback append and cannot complete from stale derived rows", async () => {
  const f = await fixture(); let added = false;
  const recheck = f.store.inspectOutboundRows(() => { if (!added) { added = true; f.store.note(note("callback appended outbound body")); } }, limits);
  expect(added).toBe(true); expect(errorCode(recheck)).toBe("input-unavailable");
});

test("final outbound checks detect earlier target changes caused by a later target's visitor", async () => {
  const first = await fixture(), later = await fixture();
  const checkFirst = first.store.inspectOutboundRows(() => {}, limits); let changed = false;
  const checkLater = later.store.inspectOutboundRows(() => { if (!changed) { changed = true; first.store.note(note("later visitor changed earlier input")); } }, limits);
  checkLater(); expect(errorCode(checkFirst)).toBe("input-unavailable");
});

test("generation outbound final check preserves source identity even for a same-byte replacement", async () => {
  const f = await fixture(), recheck = f.store.inspectOutboundRows(() => {}, limits), bytes = readFileSync(f.file);
  renameSync(f.file, f.file + ".saved"); writeFileSync(f.file, bytes, { mode: 0o600, flag: "wx" });
  expect(errorCode(recheck)).toBe("input-unavailable");
});

for (const tail of ["{malformed}\n", "{unfinished"]) test("outbound malformed/torn input is not reported as an empty complete inspection: " + tail.trim(), async () => {
  const f = await fixture(); appendFileSync(f.file, tail); let visited = 0;
  expect(errorCode(() => f.store.inspectOutboundRows(() => visited++, limits))).toBe("input-unavailable");
  expect(visited).toBe(0);
});

test("outbound canonical row budget refuses before exposing a coalesced subset", async () => {
  const f = await fixture(); let visited = 0;
  expect(errorCode(() => f.store.inspectOutboundRows(() => visited++, { ...limits, maxRows: 1 }))).toBe("input-bound");
  expect(visited).toBe(0);
});

test("explicitly bounded SegmentReader retains its8MiB allocation and16MiB verification contract", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-source-read-bound-")), file = join(root, "source.jsonl");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(file, ""); truncateSync(file, limits.maxBytes + 1);
  const refused = new SegmentReader(2 * limits.maxBytes, { maxSourceBytes: limits.maxBytes, maxRows: limits.maxRows });
  expect(() => refused.read(file, undefined, true)).toThrow(SegmentReadBudgetError);
  expect(refused.metrics().bytesRead).toBe(0);
  truncateSync(file, limits.maxBytes);
  const fd = openSync(file, constants.O_WRONLY); try { writeSync(fd, Buffer.from("\n"), 0, 1, limits.maxBytes - 1); } finally { closeSync(fd); }
  const bounded = new SegmentReader(2 * limits.maxBytes, { maxSourceBytes: limits.maxBytes, maxRows: 1 });
  expect(bounded.read(file, undefined, true).bytes.length).toBe(limits.maxBytes);
  expect(bounded.metrics().bytesRead).toBe(2 * limits.maxBytes);
  expect(bounded.inspectionMetrics()).toEqual({ sourceBytes: limits.maxBytes, rows: 1 });
  expect(() => bounded.read(file, undefined, true)).toThrow(SegmentReadBudgetError);
});


test("checkpoint metadata is capped before its result array grows beyond the source inventory guard", async () => {
  const f = await fixture(), db = new Database(join(f.store.dir, indexFileName(!!f.store.profile.foreignPruneFormat)));
  try {
    const insert = db.query("INSERT OR REPLACE INTO generation_segments (source,path,offset,hash,commit_id,stamp) VALUES ('legacy-local',?,0,?,NULL,NULL)");
    db.transaction(() => { for (let index = 0; index < 20_001; index++) insert.run(`log/metadata-${index}.jsonl`, "0".repeat(64)); })();
    const before = db.query("SELECT count(*) AS n FROM generation_segments").get();
    expect(inspectSyncPolicy(f.store)).toMatchObject({ complete: false, reason: "input-bound", bound: {
      kind: "source-files", limit: 20_000, observed: 20_001, nextStep: expect.any(String),
    } });
    expect(db.query("SELECT count(*) AS n FROM generation_segments").get()).toEqual(before);
  } finally { db.close(); }
});
