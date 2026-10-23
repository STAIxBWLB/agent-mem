import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, openShardStore, type Entry, type NoteInput } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { legacyHead } from "../src/memory/bridge.ts";
import { shardKeyHash } from "../src/memory/shard.ts";
import { decodeShardPack } from "../src/memory/shard-sync-format.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function temp() { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-shard-public-legacy-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function git(cwd: string, ...args: string[]): string {
  const result = memoryGitSync(["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`public-legacy fixture Git failed: ${result.stderr}`);
  return result.stdout.trim();
}
const project = "example.test/public-legacy/project", G1 = "5".repeat(32), G2 = "6".repeat(32);
const privateRemote = { visibility: async () => "private" as const };
function original(scope: "project" | "shared", text: string): NoteInput {
  return { op: "note", project, scope, tier: "long", kind: "finding", peer: "legacy-writer", source: "person", text,
    title: `${scope} original`, task: `${project}#42@1000`, about: ["path:public.ts", "symbol:PublicSymbol"] };
}

test("verified legacy-main public originals survive T2 and stable shard sync to an independent generation with their ids and attribution", async () => {
  const remote = temp(); git(remote, "init", "-q", "--bare");
  const sourceHome = temp(), legacy = new MemoryStore({ home: sourceHome, profile: "shared-v1", deferPromotions: true });
  let legacyClosed = false;
  cleanup.push(() => { if (!legacyClosed) legacy.close(); });
  const ids = [legacy.note(original("project", "publiclegacyproject")), legacy.note(original("shared", "publiclegacyuser"))];
  const memoryDir = legacy.dir, segment = join(memoryDir, "log", `${legacy.machine.id}.jsonl`);
  const originalBytes = readFileSync(segment, "utf8"), originals = originalBytes.trimEnd().split("\n").map(line => JSON.parse(line) as Entry).filter(row => ids.includes(row.id));
  expect(originals).toHaveLength(2);
  // Establish real publication before either migration; no copied directory or forged public-witness flag.
  expect(await syncMemory(legacy, { remote, ...privateRemote })).toMatchObject({ ok: true, pushed: true });
  const main = git(remote, "rev-parse", "refs/heads/main");
  legacy.close(); legacyClosed = true;

  await migrate({ memoryDir, generation: G1, mode: "apply", authorizedPerson: true, tty: true });
  const generation = new MemoryStore({ memoryDir, profile: { generation: G1 }, deferPromotions: true });
  try {
    // Existing generation sync is the only author of its FF/CAS-validated legacy-main bridge receipt.
    expect(await syncMemory(generation, { remote, ...privateRemote })).toMatchObject({ ok: true });
    expect(legacyHead(memoryDir, G1)).toBe(main);
    expect(generation.prunePort().snapshot().rows.filter(row => ids.includes(row.row.id)).every(row => row.publicWitness && row.placement === "synced")).toBe(true);
  } finally { generation.close(); }
  expect(await migrateShards({ memoryDir, generation: G1, mode: "apply", authorizedPerson: true, tty: true })).toMatchObject({ active: true });
  const source = openShardStore({ memoryDir, project, deferPromotions: true }); cleanup.push(() => source.close());
  const witnessed = source.openedSyncTargets().flatMap(target => [...target.prunePort().snapshot().rows]).filter(row => ids.includes(row.row.id));
  expect(witnessed).toHaveLength(2); expect(witnessed.every(row => row.publicWitness && row.placement === "synced")).toBe(true);
  expect(await syncMemory(source, { remote, ...privateRemote })).toMatchObject({ ok: true });

  const projectRef = `refs/heads/amem/p/${shardKeyHash(project)}`, userRef = "refs/heads/amem/u";
  const wire: Entry[] = [];
  for (const [ref, realm] of [[projectRef, { scope: "project", key: project }], [userRef, { scope: "user" }]] as const) {
    const files = git(remote, "ls-tree", "-r", "--name-only", ref).split("\n");
    expect(files).toContain("shard.json");
    for (const file of files.filter(name => name.startsWith("rows/"))) {
      const bytes = Buffer.from(git(remote, "show", `${ref}:${file}`) + "\n");
      for (const row of decodeShardPack(file, bytes, realm, G2)) { expect(row.op).not.toBe("prune"); wire.push(row as Entry); }
    }
  }
  for (const row of originals) expect(wire.find(candidate => candidate.id === row.id)).toEqual(row);

  const receiverHome = temp(), receiverLegacy = new MemoryStore({ home: receiverHome, profile: "shared-v1", deferPromotions: true });
  const receiverMemory = receiverLegacy.dir; receiverLegacy.close();
  expect(await migrateShards({ memoryDir: receiverMemory, generation: G2, mode: "apply", authorizedPerson: true, tty: true })).toMatchObject({ active: true });
  const receiver = openShardStore({ memoryDir: receiverMemory, project, deferPromotions: true }); cleanup.push(() => receiver.close());
  expect(await syncMemory(receiver, { remote, ...privateRemote })).toMatchObject({ ok: true });
  for (const row of originals) {
    const view = receiver.get(row.id, project)!;
    expect(view).toBeDefined();
    expect({ id: view.id, at: view.at, machine: view.machine, peer: view.peer, project: view.project, scope: view.scope, text: view.text, title: view.title, task: view.task, about: view.about })
      .toEqual({ id: row.id, at: row.at, machine: row.machine, peer: "peer" in row ? row.peer : undefined, project, scope: "scope" in row ? row.scope : undefined,
        text: "text" in row ? row.text : undefined, title: "title" in row ? row.title : undefined, task: "task" in row ? row.task : undefined, about: "about" in row ? row.about : undefined });
    expect(receiver.search("text" in row ? row.text : "", { project }).hits.some(hit => hit.view?.id === row.id)).toBe(true);
  }
  const brief = await sessionStartBrief({ cwd: receiverHome, base: receiverMemory, project });
  expect(brief.context).toContain("publiclegacyproject"); expect(brief.context).toContain("publiclegacyuser");
  expect(brief.tokens).toBeLessThanOrEqual(1200);
  expect(readFileSync(segment, "utf8")).toBe(originalBytes);
  expect(git(memoryDir, "rev-parse", "HEAD")).toBe(main);
  expect(git(remote, "rev-parse", "refs/heads/main")).toBe(main);
}, 60_000);
