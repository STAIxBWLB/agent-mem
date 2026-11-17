import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, machineId } from "../src/memory/store.ts";
import { aliasedKeys, appendAlias, captureShardDir } from "../src/memory/shard.ts";
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

test("#424: a project mutation rebuilds its own cache and keeps every other project's prebuilt brief", () => {
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
    expect(peerCache()?.rows.map(row => (row.data as { text: string }).text)).toEqual(["project Q baseline"]);
    // A shared row can reach every project's preference slot, so it still invalidates home-wide.
    f.store.note({ op: "note", project: f.project, scope: "shared", tier: "long", kind: "decision", peer: "fixture", source: "person", text: "shared change", about: [] });
    expect(peerCache()).toBeUndefined();
  } finally { f.store.close(); }
});

test("alias binding drift after cache view open leaves the invalidated cache missing", () => {
  const f = fixture(), alias = "curated-write-late-alias";
  const note = (text: string) => ({ op: "note" as const, project: f.project, scope: "project" as const, tier: "long" as const,
    kind: "decision" as const, peer: "fixture", source: "person" as const, text, about: [] });
  const prototype = MemoryStore.prototype as unknown as {
    withStoreFences: <T>(this: MemoryStore, work: (stores: readonly MemoryStore[]) => T) => T;
  };
  const original = prototype.withStoreFences;
  let injected = false;
  try {
    f.store.note(note("cache view baseline"));
    expect(f.cache()?.rows).toHaveLength(1);
    prototype.withStoreFences = function<T>(this: MemoryStore, work: (stores: readonly MemoryStore[]) => T): T {
      if (this !== f.store && !injected) {
        injected = true;
        appendAlias(f.base, { alias, key: f.project, actor: "person", machine: machineId(f.base).id });
      }
      return original.call(this, work) as T;
    };

    f.store.note(note("must not publish under the new alias binding"));
    expect(injected).toBe(true);
    expect(aliasedKeys(f.base, f.project)).toContain(alias);
    expect(f.cache()).toBeUndefined();
  } finally {
    prototype.withStoreFences = original;
    f.store.close();
  }
});

test("#424: cross-project replacement and forgetting it invalidate the predecessor's cache", () => {
  const f = fixture(), other = "curated-write-replacement";
  const note = (project: string, text: string, supersedes?: string) => ({ op: "note" as const, project, scope: "project" as const,
    tier: "long" as const, kind: "decision" as const, peer: "fixture", source: "person" as const, text, about: [], ...(supersedes ? { supersedes } : {}) });
  try {
    const first = f.store.note(note(f.project, "old project decision"));
    f.store.note(note(other, "other project baseline"));
    f.store.prepareCuratedBriefs([f.project, other]); expect(f.cache()?.rows).toHaveLength(1);
    const replacement = f.store.note(note(other, "cross-project replacement", first));
    expect(f.store.readPage({ project: f.project, limit: 32 }).rows).toHaveLength(0);
    expect(f.cache()).toBeUndefined();
    f.store.prepareCuratedBriefs([f.project]); expect(f.cache()?.rows).toHaveLength(0);
    expect(f.store.forget(replacement, "fixture", other)).toBeDefined();
    expect(f.store.readPage({ project: f.project, limit: 32 }).rows.map(row => row.id)).toContain(first);
    expect(f.cache()).toBeUndefined();
  } finally { f.store.close(); }
});

test("#424: importing a cross-project replacement invalidates the original project's cache", () => {
  const f = fixture(), other = "curated-write-import";
  const note = (project: string, text: string, supersedes?: string) => ({ op: "note" as const, project, scope: "project" as const,
    tier: "long" as const, kind: "decision" as const, peer: "fixture", source: "person" as const, text, about: [], ...(supersedes ? { supersedes } : {}) });
  try {
    const first = f.store.note(note(f.project, "original decision"));
    f.store.prepareCuratedBriefs([f.project]); expect(f.cache()?.rows).toHaveLength(1);
    f.store.importNote(note(other, "imported replacement", first), "2026-11-10T00:00:00.000Z");
    expect(f.cache()).toBeUndefined();
  } finally { f.store.close(); }
});

test("#424: cross-project supersede ops invalidate both the original and replacement caches", () => {
  const f = fixture(), other = "curated-write-op-peer";
  const add = (project: string, text: string) => f.store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text, about: [] });
  try {
    const first = add(f.project, "op original"), replacement = add(other, "op replacement");
    f.store.prepareCuratedBriefs([f.project, other]); expect(f.cache()?.rows).toHaveLength(1);
    expect(f.store.supersede(first, replacement, "fixture")).toBe(true);
    expect(f.cache()?.rows ?? []).toHaveLength(0); expect(f.store.readPage({ project: f.project, limit: 32 }).rows).toHaveLength(0);
    f.store.prepareCuratedBriefs([f.project]); expect(f.cache()?.rows).toHaveLength(0);
    expect(f.store.forget(replacement, "fixture", other)).toBeDefined();
    expect(f.cache()).toBeUndefined(); expect(f.store.readPage({ project: f.project, limit: 32 }).rows.map(row => row.id)).toContain(first);
  } finally { f.store.close(); }
});

test("#424: a changed segment frontier cannot prove safe project-only invalidation", () => {
  const f = fixture(), other = "curated-write-external";
  let writer: MemoryStore | undefined;
  const note = (project: string, text: string) => ({ op: "note" as const, project, scope: "project" as const, tier: "long" as const,
    kind: "decision" as const, peer: "fixture", source: "person" as const, text, about: [] });
  try {
    f.store.note(note(f.project, "cached predecessor")); f.store.prepareCuratedBriefs([f.project]); expect(f.cache()).toBeDefined();
    writer = new MemoryStore({ home: f.home, deferPromotions: true });
    writer.note(note(other, "different writer")); expect(f.cache()).toBeDefined();
    f.store.note(note(other, "stale index frontier")); expect(f.cache()).toBeUndefined();
  } finally { writer?.close(); f.store.close(); }
});
