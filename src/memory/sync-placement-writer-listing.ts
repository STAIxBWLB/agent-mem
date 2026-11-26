/**
 * #639: a read-only listing of the placement writer inventory and the install roots a renewal must declare. It writes
 * nothing, takes no lock and never searches the filesystem for installs; it only reads the active inventory, the running
 * install and the setup receipts, then suggests the present roots and the #625 saving-preview command built from them.
 */
import { lstatSync } from "node:fs";
import { realPath } from "./platform.ts";
import { installVersion } from "./formats-raise.ts";
import { readEffectiveSyncPlacementWriters } from "./sync-placement-effective-writers.ts";
import { readSetupWriterLaunchers, type SetupTarget } from "../setup-writer-roots.ts";

export const PLACEMENT_WRITERS_LISTING = "amem migrate --sync-placement --writers";
export const PLACEMENT_WRITERS_SCHEMA = "amem.placement-writers/v1";
export const PLACEMENT_WRITERS_NOTE = "Installs bundled inside other tools (agent-hub, vault-mem) appear here only when they are already in the inventory or a setup receipt; add a newly upgraded host bundle with another --writer-root.";

export interface PlacementWriterListing {
  schema: typeof PLACEMENT_WRITERS_SCHEMA;
  inventory: { root: string; version: string | null; state: "present" | "missing" }[];
  running: { root: string; version: string | null; inInventory: boolean };
  receipts: { target: SetupTarget; root: string; state: "present" | "missing" }[];
  suggestedRoots: string[];
  command: string;
  note: string;
}

// ponytail: the same ENOENT/ENOTDIR test as the checkpoint's installAbsent (#634); one shared helper once #448 settles that file.
function absent(root: string): boolean {
  try { lstatSync(root); return false; } catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ENOTDIR"; }
}
/** POSIX single-quote shell quoting: the printed command is pasted into a shell as is. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
export function placementWriterCommand(roots: readonly string[]): string {
  const flags = roots.map(root => `--writer-root ${shellQuote(root)}`).join(" ");
  return `(umask 077; set -C; amem migrate --sync-placement --checkpoint ${flags} --json > checkpoint-plan.json), then amem migrate --sync-placement --checkpoint ${flags} --confirm --plan checkpoint-plan.json`;
}

export function listPlacementWriters(home: string, ownRoot: string): PlacementWriterListing {
  const inventory = (readEffectiveSyncPlacementWriters(home).roots ?? []).map(root => {
    const state = absent(root) ? "missing" as const : "present" as const;
    return { root, version: state === "present" ? installVersion(root) : null, state };
  });
  const own = realPath(ownRoot);
  const running = { root: own, version: installVersion(own), inInventory: inventory.some(row => row.root === own) };
  const receipts = readSetupWriterLaunchers(home);
  const present = new Set<string>([own]);
  for (const row of [...inventory, ...receipts]) if (row.state === "present") present.add(realPath(row.root));
  const suggestedRoots = [...present].sort();
  return { schema: PLACEMENT_WRITERS_SCHEMA, inventory, running, receipts, suggestedRoots, command: placementWriterCommand(suggestedRoots), note: PLACEMENT_WRITERS_NOTE };
}

export function placementWritersText(listing: PlacementWriterListing): string {
  const lines = ["sync placement writer inventory:"];
  for (const row of listing.inventory) lines.push(`  ${row.state} ${row.version ?? "unknown"} ${row.root}`);
  if (!listing.inventory.length) lines.push("  (no inventory roots recorded)");
  lines.push(`running install: ${listing.running.version ?? "unknown"} ${listing.running.root} (${listing.running.inInventory ? "in the inventory" : "not in the inventory"})`);
  lines.push("setup receipts:");
  for (const row of listing.receipts) lines.push(`  ${row.target} ${row.state} ${row.root}`);
  if (!listing.receipts.length) lines.push("  (none)");
  lines.push("roots to declare:");
  for (const root of listing.suggestedRoots) lines.push(`  ${root}`);
  lines.push(`next: ${listing.command}`, `note: ${listing.note}`);
  return lines.join("\n");
}
