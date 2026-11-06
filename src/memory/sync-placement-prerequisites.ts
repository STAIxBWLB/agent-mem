/** Activation preflight only. Never migrates, opens an index, raises a floor or creates a home. */
import { lstatSync } from "node:fs";
import { realPath } from "./platform.ts";
import { hashJSON } from "./generation.ts";
import { assertFormatFloor, readFormatFloors } from "./formats.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { readActivePlacementBinding, type ActivePlacementBinding } from "./sync-placement-active.ts";
import { PLACEMENT_PROFILE_SCHEMA, validatePlacementBaseV2, type PlacementBaseV2 } from "./sync-placement-format.ts";

export const PLACEMENT_ACTIVATION_MIN_READER = "0.21.0";
const preview = "amem migrate --sync-placement --dry-run";
function requireHomeFloor(home: string,minReader:string): string {
  assertFormatFloor(home, "curated"); assertFormatFloor(home, "sync");
  const floors = readFormatFloors(home), minimum = minReader.split(".").map(Number);
  const adequate = floors?.some(row => {
    if (row.surface !== "home" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(row.minReader)) return false;
    const parts = row.minReader.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (parts[i] !== minimum[i]) return parts[i]! > minimum[i]!;
    return true;
  });
  if (!adequate) throw Error(`Sync placement requires a person-authored home floor of ${minReader} or later in formats.json; have the person append that record, then rerun ${preview}.`);
  return hashJSON(floors);
}
export function requirePlacementHomeFloor(home:string):string{return requireHomeFloor(home,PLACEMENT_ACTIVATION_MIN_READER);}
export function requireWriterRenewalHomeFloor(home:string):string{return requireHomeFloor(home,"0.22.0");}
export interface PlacementActivationPrerequisites { home: string; floorHash: string; base?: PlacementBaseV2; active?: ActivePlacementBinding }
export function requirePlacementActivationPrerequisites(input: string): PlacementActivationPrerequisites {
  let home: string;
  try { home = realPath(input); const stat = lstatSync(home); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw Error(); }
  catch { throw Error("Sync placement memory home is unavailable or unsafe; select an existing private memory home and rerun amem migrate --sync-placement --dry-run."); }
  assertFormatFloor(home, "curated"); assertFormatFloor(home, "sync");
  const markers = readPlacementRuntimeMarkers(home);
  const shards = markers.shards as { schema?: string; phase?: string } | undefined;
  const profile = markers.profile as { schema?: string } | undefined;
  if (!shards || shards.schema === "agent-mem.shards/v1" && shards.phase !== "active") {
    throw Error("Sync placement requires an active shard home; run amem migrate --shards --dry-run and complete that person-reviewed migration first.");
  }
  if (shards.schema === "agent-mem.shards/v1") {
    throw Error("Sync placement requires the v2 public-prune view; run amem migrate --public-prune-view --dry-run and complete that person-reviewed migration first.");
  }
  if (profile?.schema === PLACEMENT_PROFILE_SCHEMA) {
    const active = readActivePlacementBinding(home, markers.profile, markers.shards);
    if (!active) throw Error("Sync placement activation is incomplete; inspect retained evidence and run amem migrate --sync-placement --resume.");
    return { home, floorHash: requirePlacementHomeFloor(home), active };
  }
  let base: PlacementBaseV2;
  try { base = validatePlacementBaseV2(markers.profile, markers.shards); }
  catch { throw Error("Sync placement base metadata is invalid or unsupported; inspect the active shard/public-prune metadata before rerunning amem migrate --sync-placement --dry-run."); }
  return { home, floorHash: requirePlacementHomeFloor(home), base };
}
