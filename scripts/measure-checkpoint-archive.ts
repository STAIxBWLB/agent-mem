/** Read-only checkpoint archive measurement; caller supplies an isolated fixture home. */
import { readPlacementJournal } from "../src/memory/sync-placement-journal-storage.ts";
import { resolvePlacementWindow } from "../src/memory/sync-placement-checkpoint-storage.ts";
import { processPeakRssKB } from "../src/memory/metrics.ts";

const [home, epoch] = process.argv.slice(2);
if (!home || !epoch || !/^[a-f0-9]{64}$/.test(epoch)) throw Error("Pass an isolated fixture home and its epoch hash.");
const started = performance.now();
const window = resolvePlacementWindow(home, epoch);
const journal = readPlacementJournal(home, epoch);
const archiveBytes = window.manifests.reduce((total, manifest) => total + manifest.archived.members.reduce((sum, member) => sum + member.size, 0), 0);
const archiveMembers = window.manifests.reduce((total, manifest) => total + manifest.archived.members.length, 0);
const peak = processPeakRssKB();
console.log(JSON.stringify({ windows: window.window, archiveBytes, archiveMembers, records: journal.records.length,
  elapsedMs: Math.round((performance.now() - started) * 100) / 100, peakRssMB: peak === undefined ? null : peak / 1024 }));
