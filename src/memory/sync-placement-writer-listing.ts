/**
 * #639: a read-only listing of the placement writer inventory and the install roots a renewal must declare. It writes
 * nothing, takes no lock and never searches the filesystem for installs; it only reads the active inventory, the running
 * install, the setup receipts and (#660) library hosts found from the process table or as ahub/vmem on PATH, then suggests
 * the present roots and the saving-preview command built from them.
 */
import { realPath } from "./platform.ts";
import { join } from "node:path";
import { embeddedAmemRoot, installAbsent, installVersion, runningAmemRoots } from "./formats-raise.ts";
import { readEffectiveSyncPlacementWriters } from "./sync-placement-effective-writers.ts";
import { readSetupWriterLaunchers, type SetupTarget } from "../setup-writer-roots.ts";

export const PLACEMENT_WRITERS_LISTING = "amem migrate --sync-placement --writers";
export const PLACEMENT_WRITERS_SCHEMA = "amem.placement-writers/v1";
export const PLACEMENT_WRITERS_NOTE = "Installs bundled inside other tools (agent-hub, vault-mem) appear here when they are in the inventory or a setup receipt, run in a live process, or sit behind ahub or vmem on PATH; add any other host bundle with another --writer-root.";

export interface PlacementWriterListing {
  schema: typeof PLACEMENT_WRITERS_SCHEMA;
  inventory: { root: string; version: string | null; state: "present" | "missing" }[];
  running: { root: string; version: string | null; inInventory: boolean };
  receipts: { target: SetupTarget; root: string; state: "present" | "missing" }[];
  /** #660, additive: amem roots loaded by a live process (`pid`) or behind ahub/vmem on PATH (`host` is the entry script). */
  runningHosts?: { pid?: number; root: string; version: string | null; host?: string }[];
  suggestedRoots: string[];
  command: string;
  note: string;
}

/** POSIX single-quote shell quoting: the printed command is pasted into a shell as is. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
export function placementWriterCommand(roots: readonly string[]): string {
  const flags = roots.map(root => `--writer-root ${shellQuote(root)}`).join(" ");
  return `amem migrate --sync-placement --checkpoint ${flags} --out checkpoint-plan.json, then amem migrate --sync-placement --checkpoint --confirm --plan checkpoint-plan.json`;
}

/** #660 discovery seams: the `pid args` process table, the embedded-package probe and the PATH to resolve ahub/vmem on. */
export interface PlacementWriterDiscovery { table?: () => string; embedded?: (dir: string) => boolean; path?: string }
function discoverHosts(own: string, discovery: PlacementWriterDiscovery): NonNullable<PlacementWriterListing["runningHosts"]> {
  const out: NonNullable<PlacementWriterListing["runningHosts"]> = [], seen = new Set<string>();
  const add = (root: string, extra: { pid?: number; host?: string }) => {
    let canonical: string; try { canonical = realPath(root); } catch { return; }
    if (canonical === own || seen.has(`${canonical}\0${extra.pid ?? ""}`)) return; seen.add(`${canonical}\0${extra.pid ?? ""}`);
    out.push({ ...(extra.pid !== undefined ? { pid: extra.pid } : {}), root: canonical, version: installVersion(canonical), ...(extra.host ? { host: extra.host } : {}) });
  };
  // ponytail: a failed process listing finds no live hosts, and runningAmemRoots splits `ps` args on whitespace, so a script path
  // with a space is missed; the PATH check and an explicit --writer-root still cover them. Upgrade: read argv per pid.
  if (discovery.table) try { for (const row of runningAmemRoots(discovery.table, discovery.embedded)) add(row.root, { pid: row.pid, ...(row.host ? { host: row.host } : {}) }); } catch { /* no live hosts */ }
  for (const dir of (discovery.path ?? "").split(":")) {
    if (!dir.startsWith("/")) continue;
    for (const name of ["ahub", "vmem"]) {
      let script: string; try { script = realPath(join(dir, name)); } catch { continue; }
      const root = embeddedAmemRoot(script, discovery.embedded); if (root) add(root, { host: script });
    }
  }
  return out;
}

export function listPlacementWriters(home: string, ownRoot: string, discovery: PlacementWriterDiscovery = {}): PlacementWriterListing {
  const inventory = (readEffectiveSyncPlacementWriters(home).roots ?? []).map(root => {
    const state = installAbsent(root) ? "missing" as const : "present" as const;
    return { root, version: state === "present" ? installVersion(root) : null, state };
  });
  const own = realPath(ownRoot);
  const running = { root: own, version: installVersion(own), inInventory: inventory.some(row => row.root === own) };
  const receipts = readSetupWriterLaunchers(home), runningHosts = discoverHosts(own, discovery);
  const present = new Set<string>([own]);
  for (const row of [...inventory, ...receipts]) if (row.state === "present") present.add(realPath(row.root));
  for (const row of runningHosts) if (row.version !== null && !installAbsent(row.root)) present.add(row.root);
  const suggestedRoots = [...present].sort();
  return { schema: PLACEMENT_WRITERS_SCHEMA, inventory, running, receipts, runningHosts, suggestedRoots, command: placementWriterCommand(suggestedRoots), note: PLACEMENT_WRITERS_NOTE };
}

export function placementWritersText(listing: PlacementWriterListing): string {
  const lines = ["sync placement writer inventory:"];
  for (const row of listing.inventory) lines.push(`  ${row.state} ${row.version ?? "unknown"} ${row.root}`);
  if (!listing.inventory.length) lines.push("  (no inventory roots recorded)");
  lines.push(`running install: ${listing.running.version ?? "unknown"} ${listing.running.root} (${listing.running.inInventory ? "in the inventory" : "not in the inventory"})`);
  lines.push("setup receipts:");
  for (const row of listing.receipts) lines.push(`  ${row.target} ${row.state} ${row.root}`);
  if (!listing.receipts.length) lines.push("  (none)");
  lines.push("library hosts:");
  for (const row of listing.runningHosts ?? []) lines.push(`  ${row.version ?? "unknown"} ${row.root}${row.pid !== undefined ? ` (pid ${row.pid})` : " (on PATH)"}`);
  if (!listing.runningHosts?.length) lines.push("  (none found)");
  lines.push("roots to declare:");
  for (const root of listing.suggestedRoots) lines.push(`  ${root}`);
  lines.push(`next: ${listing.command}`, `note: ${listing.note}`);
  return lines.join("\n");
}
