import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, machineId } from "../src/memory/store.ts";
import { captureShardDir } from "../src/memory/shard.ts";
import { readBriefCache } from "../src/brief-cache.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amem-curated-write-")); roots.push(home);
  const store = new MemoryStore({ home, deferPromotions: true, screen: () => "promote" });
  const base = join(home, "memory"), project = "curated-write";
  const cache = () => readBriefCache({ directory: captureShardDir(base, project, machineId(base).id), project, section: "curated" });
  return { home, store, base, project, cache };
}
test("note and imported note prepare a screened curated cache without rewriting authority", () => {
  const f = fixture();
  try {
    f.store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text: "first public decision", about: [] });
    expect(f.cache()?.rows.map(row => (row.data as { text: string }).text)).toEqual(["first public decision"]);
    const at = "2026-11-10T00:00:00.000Z";
    f.store.importNote({ op: "note", project: f.project, scope: "project", tier: "long", kind: "contract", peer: "fixture", source: "person", text: "import public contract", about: [] }, at);
    expect(f.cache()?.rows).toHaveLength(2);
  } finally { f.store.close(); }
});
test("forget and supersede never leave removed rows in the published cache", () => {
  const f = fixture();
  try {
    const add = (text: string) => f.store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text, about: [] });
    const first = add("old public decision"), second = add("new public decision");
    f.store.supersede(first, second, "fixture", f.project);
    expect(f.cache()?.rows.map(row => (row.data as { text: string }).text)).toEqual(["new public decision"]);
    f.store.forget(second, "fixture", f.project);
    expect(f.cache()?.rows.map(row => (row.data as { text: string }).text)).toEqual(["old public decision"]);
  } finally { f.store.close(); }
});

test("promotion, demotion and settlement publish the current library projection", () => {
  const f = fixture();
  const display = () => f.cache()!.rows.map(row => row.data);
  const projection = () => f.store.readPage({ project: f.project, limit: 32 }).rows.filter(row => row.project === f.project).slice(0, 4)
    .map(({ id, at, kind, text, title }) => ({ id, at, kind, ...(title ? { title } : {}), text }));
  try {
    const first = f.store.note({ op: "note", project: f.project, scope: "project", tier: "short", kind: "decision", peer: "fixture", source: "person", text: "public task decision", task: `${f.project}#1`, about: [] });
    expect(display()).toEqual(projection());
    expect(f.store.promote(first, "fixture", f.project)).toBeDefined();
    expect(display()).toEqual(projection());
    const long = f.store.readPage({ project: f.project, limit: 32 }).rows[0]!;
    f.store.demote(long.id, "fixture", f.project);
    expect(display()).toEqual(projection());
    expect(f.cache()!.curated!.expiresAt).not.toBeNull();
    f.store.note({ op: "note", project: f.project, scope: "project", tier: "short", kind: "finding", peer: "fixture", source: "person", text: "another public task observation", task: `${f.project}#2`, about: [] });
    f.store.settle(`${f.project}#2`, "fixture");
    expect(display()).toEqual(projection());
  } finally { f.store.close(); }
});

test("review acceptance invalidates inside its outer writer fence and publishes only after release", () => {
  const f = fixture();
  const note = (text: string) => ({ op: "note" as const, project: f.project, scope: "project" as const, tier: "long" as const,
    kind: "decision" as const, peer: "fixture", source: "person" as const, text, about: [] });
  try {
    f.store.note(note("old accepted note"));
    expect(f.cache()?.rows).toHaveLength(1);
    f.store.withAcceptedNote(note("new accepted note"), append => {
      append();
      expect(f.cache()).toBeUndefined();
    });
    expect(f.cache()?.rows).toHaveLength(2);
    expect(() => f.store.withAcceptedNote(note("durable callback failure note"), append => {
      append(); expect(f.cache()).toBeUndefined(); throw Error("fixture failure after durable append");
    })).toThrow("fixture failure after durable append");
    expect(f.cache()?.rows.map(row => (row.data as { text: string }).text)).toContain("durable callback failure note");
  } finally { f.store.close(); }
});

test("a project mutation rebuilds only its touched cache after home-wide invalidation", () => {
  const f = fixture(), other = "curated-write-quiet-peer";
  const add = (project: string, text: string) => f.store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text, about: [] });
  const peerCache = () => readBriefCache({ directory: captureShardDir(f.base, other, machineId(f.base).id), project: other, section: "curated" });
  try {
    add(f.project, "project P baseline"); add(other, "project Q baseline");
    f.store.prepareCuratedBriefs([f.project, other]);
    expect(f.cache()?.rows).toHaveLength(1); expect(peerCache()?.rows).toHaveLength(1);

    add(f.project, "project P changed");
    const projectRows = f.cache()?.rows.map(row => (row.data as { text: string }).text) ?? [];
    expect(projectRows).toHaveLength(2);
    expect(projectRows).toEqual(expect.arrayContaining(["project P baseline", "project P changed"]));
    expect(peerCache()).toBeUndefined();
  } finally { f.store.close(); }
});
