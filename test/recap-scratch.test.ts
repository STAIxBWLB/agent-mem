import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { appendAlias } from "../src/memory/shard.ts";
import { withBriefSnapshot } from "../src/memory/doctor.ts";
import { openCuratedForRead } from "../src/memory/curated-read.ts";
import { sessionStartBrief } from "../src/session-brief.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
for (const mode of ["shared", "generation", "split"] as const) test(`${mode}: scratch brief equals normal replay, search refuses and no search file is written`, async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-recap-scratch-")); roots.push(root);
  const base = join(root, "memory"), project = "recap-project", alias = "old-recap-project";
  mkdirSync(base, { mode: 0o700 });
  writeFileSync(join(base, "formats.json"), JSON.stringify([{ surface: "curated", minReader: "0.25.0", since: "2026-11-11" }]) + "\n", { mode: 0o600 });
  const initial = new MemoryStore({ memoryDir: base, deferPromotions: true });
  const note = (text: string, key = project, kind: "decision" | "preference" = "decision") => initial.note({ op: "note", project: key, scope: "project", tier: "long", kind, peer: "person", source: "person", text, about: [] });
  const old = note("superseded old"), replacement = note("replacement"), forgotten = note("forgotten secret"), denied = note("secret@example.com"), pref = note("fixture preference", project, "preference");
  note("alias evidence", alias); initial.supersede(old, replacement, "person", project); initial.forget(forgotten, "person", project); initial.close();
  appendAlias(base, { alias, key: project, actor: "person", machine: "a".repeat(16) });
  if (mode === "generation") await migrate({ memoryDir: base, generation: "e".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  if (mode === "split") await migrateShards({ memoryDir: base, mode: "apply", authorizedPerson: true, tty: true });
  await withBriefSnapshot(base, project, async inputs => {
    const scratch = inputs.curated!; expect(scratch).toBeDefined();
    const scratchHome = scratch.profile.home;
    const searchFiles = () => readdirSync(scratchHome, { recursive: true }).map(String).filter(name => /(^|\/)search(?:-[^/]*)?\.db(?:-wal|-shm)?$/.test(name));
    expect(searchFiles()).toEqual([]);
    expect(() => scratch.search("replacement")).toThrow("search unavailable for a Recap scratch store");
    expect(() => scratch.list({ q: "replacement" })).toThrow("search unavailable for a Recap scratch store");
    expect(() => scratch.readPage({ project, limit: 10, query: "replacement" })).toThrow("search unavailable for a Recap scratch store");
    scratch.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "incremental scratch note", about: [] });
    scratch.refresh(); expect(searchFiles()).toEqual([]);
    const normal = openCuratedForRead(scratchHome, project)!;
    try {
      const options = { cwd: root, base, project, repository: false as const, maxTokens: 4000, policy: { denyPaths: ["hidden"] } };
      const actual = await sessionStartBrief({ ...options, measureOnly: inputs });
      const expected = await sessionStartBrief({ ...options, measureOnly: { ...inputs, curated: normal } });
      expect(actual).toEqual(expected); expect(actual.context).toContain("fixture preference"); expect(actual.context).toContain("replacement"); expect(actual.context).toContain("alias evidence");
      expect(actual.context).not.toContain("secret@example.com");
      expect(actual.context).not.toContain("forgotten secret"); expect(actual.context).not.toContain("superseded old");
    } finally { normal.close(); }
  });
});
