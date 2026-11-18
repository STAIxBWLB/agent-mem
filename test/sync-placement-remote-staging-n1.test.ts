import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Source from the 0.29.0 release tree, fixed before this feature; no published package is assumed.
const BASELINE = "57a4ace57bdf5c4fc12996146c76843de4ee21cc";
test("0.29 admission commands preserve staged curated rows beside work", async () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "amem-029-stage-"));
  const archive = Bun.spawnSync(["git", "archive", BASELINE], { stdout: "pipe", stderr: "pipe" });
  expect(archive.exitCode, archive.stderr.toString()).toBe(0);
  const extract = Bun.spawnSync(["tar", "-x", "-C", oldRoot], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
  expect(extract.exitCode, extract.stderr.toString()).toBe(0);
  const moduleAt = (path: string) => pathToFileURL(join(oldRoot, path)).href;
  const fixture = await import(moduleAt("test/fakes/sync-placement-inventory.ts"));
  const storeModule = await import(moduleAt("src/memory/store.ts"));
  const shard = await import(moduleAt("src/memory/shard.ts"));
  const workModule = await import(moduleAt("src/memory/work-lists.ts"));
  const admission = await import(moduleAt("src/memory/sync-placement-realm-admission.ts"));
  const sync = await import(moduleAt("src/memory/sync.ts"));
  const doctor = await import(moduleAt("src/memory/doctor.ts"));
  const target = "example.test/staged-remote/n1", shared = "example.test/staged-remote/shared";
  try {
    const a = await fixture.inventoryFixture(1, [target], true), remote = fixture.bareRemote();
    const source = storeModule.openShardStore({ memoryDir: a.home, project: target, deferPromotions: true });
    try { source.note(fixture.note("staged remote row", target)); } finally { source.close(); }
    const sourceDir = join(shard.shardDir(a.home, target), "log"), name = readdirSync(sourceDir).find((item: string) => item.endsWith(".jsonl"));
    if (!name) throw Error("fixture source row missing");
    const stagedBytes = readFileSync(join(sourceDir, name));
    const user = storeModule.openShardStore({ memoryDir: a.home, user: true, deferPromotions: true });
    try { expect((await sync.syncMemory(user, a.opts(remote))).ok).toBe(true); } finally { user.close(); }
    for (const action of ["apply", "resume", "abandon", "sync", "doctor"] as const) {
      const b = await fixture.inventoryFixture(1, [shared], true);
      const work = new workModule.WorkListStore({ base: b.home, project: target, policy: () => true });
      try { await work.write("existing", { task: "preserved work" }); } finally { work.close(); }
      const projectDir = shard.shardDir(b.home, target), log = join(projectDir, "log");
      mkdirSync(log, { recursive: true, mode: 0o700 }); writeFileSync(join(log, name), stagedBytes, { mode: 0o600 });
      let result: unknown;
      try {
        if (action === "apply" || action === "resume") result = await admission.applyRealmAdmission(b.home, target, { mode: action });
        else if (action === "abandon") result = await admission.applyRealmAdmission(b.home, target, { mode: "abandon", confirm: true });
        else if (action === "sync") {
          const reader = storeModule.openShardStore({ memoryDir: b.home, user: true, deferPromotions: true });
          try { result = await sync.syncMemory(reader, b.opts(remote)); } finally { reader.close(); }
        } else result = await doctor.doctorReport({ home: b.home, homeSource: "fixture", cwd: b.root, project: target, aliases: [], now: Date.now(), env: {},
          openCurated: (base: string) => storeModule.openShardStore({ memoryDir: base, project: target, deferPromotions: true }) });
      } catch { result = "refused"; }
      expect(readFileSync(join(log, name))).toEqual(stagedBytes);
      const workAgain = new workModule.WorkListStore({ base: b.home, project: target, policy: () => true });
      try { expect((await workAgain.read())[0]?.items[0]?.task).toBe("preserved work"); } finally { workAgain.close(); }
      if (action === "apply" && result !== "refused") {
        expect(result).toMatchObject({ state: "admitted" });
        const reader = storeModule.openShardStore({ memoryDir: b.home, project: target, deferPromotions: true });
        try { expect(reader.list({ project: target }).map((row: { text: string }) => row.text)).toContain("staged remote row"); } finally { reader.close(); }
      }
      console.log(`0.29 staged-log probe: ${action} ${result === "refused" ? "refused" : "completed"}`);
    }
  } finally { fixture.closeInventoryFixtures(); rmSync(oldRoot, { recursive: true, force: true }); }
}, 240_000);
