/** Isolated stage-4 fixtures. Marker installation below is fixture-only person activation, not a runtime API. */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, openShardStore, type NoteInput } from "../../src/memory/store.ts";
import { memoryGitSync, realPath } from "../../src/memory/platform.ts";
import { canonicalJSON, hashJSON } from "../../src/memory/generation.ts";
import { migrateShards } from "../../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../../src/memory/public-prune-activation.ts";
import { captureSyncPlacementContext } from "../../src/memory/sync-placement-capture.ts";
import { planPlacementJournal, preparePlacementJournal, readPlacementProjection, type PlacementJournalPort } from "../../src/memory/sync-placement-journal.ts";
import { acquireMutation } from "../../src/memory/mutation.ts";
import { ensurePlacementFence } from "../../src/memory/sync-placement-journal-storage.ts";
import { readPlacementPublication, type PlacementPublicationRead } from "../../src/memory/sync-placement-publication-storage.ts";
import type { PlacementPublicationBundle, PlacementPublicationDecision } from "../../src/memory/sync-placement-publication-plan.ts";
import { PLACEMENT_FORMAT, PLACEMENT_SHARDS_SCHEMA } from "../../src/memory/sync-placement-format.ts";
import type { SyncOptions } from "../../src/memory/sync.ts";

export const INSPECTION_PROJECT = "example.test/placement/inspection";
const json = (value: unknown) => canonicalJSON(value) + "\n";

export function inspectionNote(text: string, project = INSPECTION_PROJECT, scope: "project" | "shared" = "project"): NoteInput {
  return { op: "note", project, scope, tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] };
}
/** Only tests supply argv here; fixture remotes are local bare directories. */
export function inspectionGit(directory: string, ...args: string[]): string {
  const result = memoryGitSync(["-C", directory, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw Error("isolated placement fixture Git command failed");
  return result.stdout.trim();
}
export function createInspectionRemote(root: string, name = "remote.git"): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name) || name === "." || name === "..") throw Error("invalid fixture remote name");
  const directory = join(root, name); mkdirSync(directory, { mode: 0o700 }); inspectionGit(directory, "init", "--bare", "-q"); return directory;
}
/** Inspect every reachable immutable pack, not just the current materialized view. */
export function reachableInspectionRowIds(remote: string): string[] {
  const ids = new Set<string>(), commits = inspectionGit(remote, "rev-list", "--all").split("\n").filter(Boolean);
  for (const commit of commits) for (const file of inspectionGit(remote, "ls-tree", "-r", "--name-only", commit).split("\n")) {
    if (/^rows\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl$/.exec(file)?.[0] !== file) continue;
    for (const line of inspectionGit(remote, "show", `${commit}:${file}`).split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as { id?: unknown };
      if (typeof row.id !== "string" || row.id.length !== 32 || !/^[a-f0-9]+$/.test(row.id)) throw Error("invalid fixture remote row");
      ids.add(row.id);
    }
  }
  return [...ids].sort();
}
export function inspectionPublications(home: string, epochHash: string): PlacementPublicationRead[] {
  const dir = join(home, "sync-placement", "epochs", epochHash);
  return readdirSync(dir).filter(name => /^publication-[a-f0-9]{64}-root\.json$/.exec(name)?.[0] === name).sort()
    .map(name => readPlacementPublication(home, epochHash, name.slice(12, 76)));
}
export function inspectionDecisions(bundle: PlacementPublicationBundle): PlacementPublicationDecision[] {
  return bundle.chunks.filter(chunk => chunk.kind === "decisions").flatMap(chunk => chunk.items as PlacementPublicationDecision[]);
}
/** All owned fixture bytes and metadata except atime, which a legitimate read can change. Never follows symlinks. */
export function inspectionFilesystemSnapshot(root: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const visit = (relative: string): void => {
    const file = join(root, relative), stat = lstatSync(file, { bigint: true });
    const metadata = { mode: String(stat.mode), dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), gid: String(stat.gid),
      nlink: String(stat.nlink), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
    if (stat.isSymbolicLink()) result[relative] = { ...metadata, kind: "symlink", target: readlinkSync(file) };
    else if (stat.isDirectory()) {
      const names = readdirSync(file).sort(); result[relative] = { ...metadata, kind: "directory", names };
      for (const name of names) visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) result[relative] = { ...metadata, kind: "file", bytes: readFileSync(file).toString("base64") };
    else throw Error("unsupported isolated fixture node");
  };
  visit(""); return result;
}

export interface InspectionFixtureOptions {
  project?: string; generation?: string; patterns?: string[];
  seed?(store: MemoryStore, project: string): Record<string, string>;
}
export async function createPlacementInspectionFixture(options: InspectionFixtureOptions = {}) {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-placement-inspection-"))), home = join(root, "memory"), project = options.project ?? INSPECTION_PROJECT;
  const clock = { now: Date.parse("2026-10-01T12:00:00.000Z") };
  let store: MemoryStore | undefined, closed = false;
  try {
    const original = new MemoryStore({ memoryDir: home, deferPromotions: true, now: () => clock.now, ttlMs: 1000 });
    let ids: Record<string, string>;
    try {
      ids = options.seed?.(original, project) ?? {
        project: original.note(inspectionNote("synthetic allowed project original", project)),
        user: original.note(inspectionNote("synthetic allowed user original", project, "shared")),
        declined: original.note(inspectionNote("NEVER_PUBLIC_INSPECTION", project)),
      };
    } finally { original.close(); }
    const generation = options.generation ?? randomBytes(16).toString("hex");
    const migrated = await migrateShards({ memoryDir: home, generation, mode: "apply", authorizedPerson: true, tty: true });
    if (!migrated.active) throw Error("isolated fixture migration did not activate");
    await activatePublicPruneView({ memoryDir: home, mode: "apply", authorizedPerson: true, tty: true });
    const policy = (patterns: readonly string[]) => writeFileSync(join(home, "amem.config.json"), json({ piiPatterns: [...patterns] }), { mode: 0o600 });
    policy(options.patterns ?? ["NEVER_PUBLIC_"]);
    let policyEpoch = "initial";
    const port: PlacementJournalPort = {
      attest: () => ({ writers: [{ writerId: "1".repeat(64), version: "0.22.0", pin: "2".repeat(64), publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true }),
      policyVersion: () => policyEpoch, authorize: () => true,
    };
    const preview = planPlacementJournal(home, port), { epochHash } = preparePlacementJournal(home, preview, port);
    const oldShards = JSON.parse(readFileSync(join(home, "shards.json"), "utf8")), profile = preview.plan.targetProfile;
    // Fixture-only stand-in for the separately person-authorized activation writer.
    writeFileSync(join(home, "profile.json"), json(profile), { mode: 0o600 });
    writeFileSync(join(home, "shards.json"), json({ ...oldShards, schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(profile), publicationFormat: PLACEMENT_FORMAT, placementHead: epochHash }), { mode: 0o600 });
    const proof = captureSyncPlacementContext(home, port), mutation = acquireMutation(home);
    if (!mutation) throw Error("isolated fixture mutation unavailable");
    try { ensurePlacementFence(home, epochHash, { mutation, assertCurrent: proof.assertCurrent }); } finally { mutation(); }
    store = openShardStore({ memoryDir: home, project, deferPromotions: true, now: () => clock.now, ttlMs: 1000 });
    const remote = createInspectionRemote(root);
    const opts = (url = remote): SyncOptions => ({ remote: url, visibility: async () => "private", placementAttestation: port.attest, policyVersion: port.policyVersion });
    const opened = store;
    return { root, home, store: opened, ids, port, opts, policy, project, epochHash, generation, remote, clock,
      projection: () => readPlacementProjection(home, epochHash), capture: () => captureSyncPlacementContext(home, port),
      publications: () => inspectionPublications(home, epochHash),
      decisions: () => inspectionPublications(home, epochHash).flatMap(read => inspectionDecisions(read.bundle)),
      reachableIds: () => reachableInspectionRowIds(remote), snapshot: () => inspectionFilesystemSnapshot(root),
      changePolicyEpoch(value = "changed") { policyEpoch = value; },
      close() { if (closed) return; opened.close(); rmSync(root, { recursive: true, force: true }); closed = true; },
    };
  } catch (error) { store?.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}
export type PlacementInspectionFixture = Awaited<ReturnType<typeof createPlacementInspectionFixture>>;
