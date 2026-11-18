import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefCacheFile } from "../src/brief-cache.ts";
import { indexFileName } from "../src/memory/index-file.ts";
import { migrate } from "../src/memory/migrate.ts";
import { realPath } from "../src/memory/platform.ts";
import { captureShardDir } from "../src/memory/shard.ts";
import { machineId, MemoryStore, type NoteInput } from "../src/memory/store.ts";

const roots: string[] = [], project = "curated/stale-fixture", G = "e".repeat(32);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const note = (text: string): NoteInput =>
  ({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", title: "held decision", text, about: [] });

// #466 review (codex-connector P1): reusing the mutating handle made a brief publish from an index the handle could not
// update, so a forgotten note was republished and native SessionStart could serve it for up to 24 h.
for (const kind of ["shared-v1", "generation"] as const) test(`#466 review: a ${kind} home never republishes a brief from an index its handle could not update`, async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-curated-stale-"))); roots.push(root);
  const base = join(root, "memory");
  if (kind === "generation") {
    const seed = new MemoryStore({ memoryDir: base, deferPromotions: true }); seed.close();
    await migrate({ memoryDir: base, generation: G, mode: "apply", authorizedPerson: true, tty: true });
  }
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
  try {
    const id = store.note(note("curated evidence that must not survive a forget"));
    store.prepareCuratedBriefs([project]);
    const file = briefCacheFile({ directory: captureShardDir(store.profile.home, project, machineId(store.profile.home).id), project, section: "curated" });
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("curated evidence that must not survive a forget");

    const lock = new Database(join(store.profile.dir, indexFileName(!!store.profile.foreignPruneFormat)));
    lock.run("BEGIN IMMEDIATE");
    try { store.forget(id, "person", project); } finally { lock.run("COMMIT"); lock.close(); }
    // The forgotten note is gone from the log, the index is behind it, and the publication may not read that index:
    // the invalidated cache stays missing rather than being rewritten with the row the handle could not drop.
    expect(existsSync(file)).toBe(false);

    store.note(note("second decision once the writer released the index"));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("curated evidence that must not survive a forget");
  } finally { store.close(); }
}, 20000);
