import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { createInspectionRemote } from "./fakes/sync-placement-inspection.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { entryId, openShardStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { activePlacementWriterContext } from "../src/sync-placement-writer-context.ts";
import { confirmPlacementCheckpoint, previewPlacementCheckpoint } from "../src/memory/sync-placement-checkpoint-person.ts";
import { renewSyncPlacementWriters } from "../src/memory/sync-placement-writer-renewal.ts";
import { releasePlacementStorageCaches } from "../src/memory/sync-placement-journal-storage.ts";
import { SYNC_SCREEN_MAX_BYTES } from "../src/memory/sync-screen.ts";
import { PlacementHistoryBoundError } from "../src/memory/sync-placement-inspection-evidence.ts";
import { runCli } from "../src/cli.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); releasePlacementStorageCaches(); });

/** Synthetic rows only, built inside the test home from a real template row; never a live home or remote. */
function rows(template: Omit<Parameters<typeof entryId>[0], "text">, label: string, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    const payload = Array.from({ length: 58 }, (_, j) => createHash("sha256").update(`${label} ${i} ${j}`).digest("hex")).join(" ");
    const body = { ...template, text: `${label} ${i} ${payload}` } as Parameters<typeof entryId>[0];
    out += JSON.stringify({ ...body, id: entryId(body) }) + "\n";
  }
  return out;
}
// AC2: retained packs past the 8 MiB sync-screen envelope no longer block the checkpoint; it confirms and the renewal applies.
// An opt-in volume proof (about 100 s, 10 MiB of synthetic rows in an isolated home), gated like the #470-scale fixture.
// On the pre-#567 inspection code it refuses with shard history bound at the preview.
test.skipIf(process.env.AMEM_CHECKPOINT_LARGE !== "1")("#567: a window whose retained packs exceed 8 MiB previews, confirms its checkpoint, then renews", async () => {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  await activateSyncPlacement(f.options("apply"));
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "home", minReader: "0.30.0", since: "2026-11-19" }]) + "\n", { mode: 0o600 });
  const remote = createInspectionRemote(f.root), attest = () => activePlacementWriterContext(f.base, activationOwnRoot).attest();
  const sync = async () => {
    const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
    try { return await syncMemory(store, { remote, visibility: async () => "private", placementAttestation: attest }); } finally { store.close(); }
  };
  // Three publications of about 3.3 MiB each into the shard store's own segment: every sync stays inside the 8 MiB
  // publish-side screen, while the retained window's packs together pass 8 MiB.
  const segment = () => {
    const writer = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
    try {
      writer.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "synthetic large window seed", about: [] });
      return join(writer.dir, "log", `${writer.machine.id}.jsonl`);
    } finally { writer.close(); }
  };
  const log = segment();
  const { id: _id, ...template } = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!);
  for (const label of ["batch-a", "batch-b", "batch-c"]) {
    appendFileSync(log, rows(template, label, 900));
    const result = await sync(); expect(result.ok).toBe(true);
  }
  expect(readFileSync(log).length).toBeGreaterThan(SYNC_SCREEN_MAX_BYTES);

  const opts = { writerRoots: [activationOwnRoot], ownRoot: activationOwnRoot };
  // A pending row makes the preview build the prospective plan, which inspects every retained publication's history.
  const pending = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
  try { pending.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "pending row after the large window", about: [] }); } finally { pending.close(); }
  const preview = await previewPlacementCheckpoint(f.base, opts);
  expect(preview.headroom.prospectivePlan.state).toBe("cache-only");
  expect(await confirmPlacementCheckpoint(f.base, preview, opts)).toMatchObject({ window: 1, renewed: true });
  const renewal = await renewSyncPlacementWriters(f.options("dry-run")) as { writers: Record<string, unknown> };
  expect(renewal.writers.missingCategories).toEqual([]);
  expect(renewal.writers).not.toHaveProperty("refusalCategory");
  expect(await renewSyncPlacementWriters(f.options("apply"))).toBeDefined();
  expect((await sync()).ok).toBe(true);
}, 900_000);

test("#567: the checkpoint CLI reports a retained-history refusal by cause class with counts in --json and text", async () => {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  await activateSyncPlacement(f.options("apply"));
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "home", minReader: "0.30.0", since: "2026-11-19" }]) + "\n", { mode: 0o600 });
  const remote = createInspectionRemote(f.root), attest = () => activePlacementWriterContext(f.base, activationOwnRoot).attest();
  const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
  try { expect((await syncMemory(store, { remote, visibility: async () => "private", placementAttestation: attest })).ok).toBe(true); } finally { store.close(); }
  const store2 = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
  try { store2.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "pending checkpoint row", about: [] }); } finally { store2.close(); }
  // Fault injection only: the inspection port reports a retained-history bound with counts.
  const proto = (await import("../src/memory/sync-placement-inspection-evidence.ts")).PlacementInspectionObjects.prototype as unknown as { object: (...args: unknown[]) => Buffer };
  const original = proto.object;
  proto.object = function (this: unknown, ...args: unknown[]) { if (args[1] === "blob") throw new PlacementHistoryBoundError("graph-bytes", 83886080, 90000000); return original.apply(this, args); };
  cleanup.push(() => { proto.object = original; });
  const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  cleanup.push(() => { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; });
  let code = 0;
  const json = JSON.parse(await runCli(["migrate", "--sync-placement", "--checkpoint", "--writer-root", activationOwnRoot, "--json"], { onExitCode: value => { code = value; } }));
  expect(code).toBe(1);
  expect(json).toMatchObject({ ok: false, refusal: { category: "shard history", cause: "bound", kind: "graph-bytes", limit: 83886080, observed: 90000000 } });
  expect(json.nextStep).toContain("multi-plan checkpoint");
  const human = await runCli(["migrate", "--sync-placement", "--checkpoint", "--writer-root", activationOwnRoot]).then(() => "", error => (error as Error).message);
  expect(human).toContain("shard history bound (graph-bytes: 90000000 over the limit of 83886080)");
  expect(human).toContain("do not abandon");
}, 240_000);
