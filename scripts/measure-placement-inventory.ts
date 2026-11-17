/**
 * #450 AC4: time and memory of one whole-inventory placement sync on a synthetic home with the user realm plus 22 project
 * realms (23 realms, matching the observed machine), against a local bare remote. Diagnostic only: it changes no budget.
 * Runs the first sync (all realms committed) and a second no-change sync; prints wall time and the process's peak RSS.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { captureSyncPlacementContext } from "../src/memory/sync-placement-capture.ts";
import { planPlacementJournal, preparePlacementJournal, type PlacementJournalPort } from "../src/memory/sync-placement-journal.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { ensurePlacementFence } from "../src/memory/sync-placement-journal-storage.ts";
import { PLACEMENT_FORMAT, PLACEMENT_SHARDS_SCHEMA } from "../src/memory/sync-placement-format.ts";
import { syncMemory } from "../src/memory/sync.ts";

const PROJECTS = Number(process.env.AMEM_MEASURE_PROJECTS ?? 22), NOTES = Number(process.env.AMEM_MEASURE_NOTES ?? 20);
const json = (value: unknown) => canonicalJSON(value) + "\n";
const peakMB = () => process.resourceUsage().maxRSS / 1024;   // maxRSS is KiB on every platform
const root = realPath(mkdtempSync(join(tmpdir(), "amem-measure-inventory-"))), home = join(root, "memory"), remote = join(root, "remote.git");
try {
  if (memoryGitSync(["init", "--bare", "-q", remote], { encoding: "utf8" }).status !== 0) throw Error("bare remote init failed");
  const projects = Array.from({ length: PROJECTS }, (_, index) => `example.test/measure/inventory-${String(index).padStart(2, "0")}`);
  const note = (text: string, project: string, scope: "project" | "shared" = "project"): NoteInput => ({ op: "note", project, scope, tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] });
  const seed = new MemoryStore({ memoryDir: home, deferPromotions: true });
  try {
    for (let index = 0; index < NOTES; index++) seed.note(note(`shared measure fact ${index} ${"x".repeat(200)}`, projects[0]!, "shared"));
    for (const project of projects) for (let index = 0; index < NOTES; index++) seed.note(note(`measure note ${index} for ${project} ${"y".repeat(200)}`, project));
  } finally { seed.close(); }
  await migrateShards({ memoryDir: home, generation: "c".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  await activatePublicPruneView({ memoryDir: home, mode: "apply", authorizedPerson: true, tty: true });
  const port: PlacementJournalPort = { attest: () => ({ writers: [{ writerId: "1".repeat(64), version: "0.22.0", pin: "2".repeat(64), publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true }),
    policyVersion: () => "measure", authorize: () => true };
  const preview = planPlacementJournal(home, port), { epochHash } = preparePlacementJournal(home, preview, port);
  const oldShards = JSON.parse(readFileSync(join(home, "shards.json"), "utf8")), profile = preview.plan.targetProfile;
  writeFileSync(join(home, "profile.json"), json(profile), { mode: 0o600 });
  writeFileSync(join(home, "shards.json"), json({ ...oldShards, schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(profile), publicationFormat: PLACEMENT_FORMAT, placementHead: epochHash }), { mode: 0o600 });
  const proof = captureSyncPlacementContext(home, port), mutation = acquireMutation(home); if (!mutation) throw Error("home mutation unavailable");
  try { ensurePlacementFence(home, epochHash, { mutation, assertCurrent: proof.assertCurrent }); } finally { mutation(); }
  const opts = { remote, visibility: async () => "private" as const, placementAttestation: port.attest, policyVersion: port.policyVersion };
  const run = async (label: string) => {
    const store = openShardStore({ memoryDir: home, user: true, deferPromotions: true });
    try {
      const started = performance.now(), result = await syncMemory(store, opts), wallMs = performance.now() - started;
      if (!result.ok) throw Error(`${label} sync failed: ${result.error}`);
      const outcomes: Record<string, number> = {};
      for (const item of result.placementRealms ?? []) outcomes[item.outcome] = (outcomes[item.outcome] ?? 0) + 1;
      console.log(JSON.stringify({ diagnostic: "placement-inventory", run: label, realms: (result.placementRealms ?? []).length, publications: Math.max(0, ...(result.placementRealms ?? []).map(item => item.publication ?? 0)),
        notesPerRealm: NOTES, wallMs: Math.round(wallMs), peakRssMB: Math.round(peakMB() * 10) / 10, outcomes }));
    } finally { store.close(); }
  };
  await run("first");
  await run("no-change");
  console.log(JSON.stringify({ diagnostic: "placement-inventory-home", digest: createHash("sha256").update(home).digest("hex").slice(0, 8) }));
} finally { rmSync(root, { recursive: true, force: true }); }
