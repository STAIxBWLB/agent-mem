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
  const store = new MemoryStore({ home, deferPromotions: true });
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
