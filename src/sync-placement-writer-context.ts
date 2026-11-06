/** CLI adapter only. Expected locators are never returned as fresh writer facts. */
import { types } from "node:util";
import { realPath } from "./memory/platform.ts";
import { canonicalJSON } from "./memory/generation.ts";
import { readSetupWriterRoots } from "./setup.ts";
import { measureSyncPlacementWriters, type SyncPlacementWriterMeasurement } from "./memory/sync-placement-writers.ts";
import { readSyncPlacementWriterRoots } from "./memory/sync-placement-writer-roots.ts";
import { readActivePlacementBinding } from "./memory/sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "./memory/sync-placement-guard.ts";
import { requirePlacementHomeFloor } from "./memory/sync-placement-prerequisites.ts";
import type { PlacementCapturePort } from "./memory/sync-placement-capture.ts";

export type PlacementWriterRootCategory = "running CLI" | "setup receipt" | "declared writer" | "active locator" | "home floor";
export class PlacementWriterContextError extends Error {
  constructor(readonly category: PlacementWriterRootCategory, readonly causeClass: "missing" | "changed" | "unavailable") {
    super(`Sync placement writer proof is ${causeClass} (${category} category); restore the inventoried install, or renew the writer inventory with an amem release that supports renewal. Review initial inputs with amem migrate --sync-placement --dry-run --writer-root <install-root>.`);
    this.name = "PlacementWriterContextError";
  }
}
function safeRefusal(error: unknown, category: PlacementWriterRootCategory): PlacementWriterContextError {
  if (error && typeof error === "object" && !types.isProxy(error) && error instanceof PlacementWriterContextError) {
    const root = Object.getOwnPropertyDescriptor(error,"category"), cause = Object.getOwnPropertyDescriptor(error,"causeClass");
    if (root && "value" in root && ["running CLI","setup receipt","declared writer","active locator","home floor"].includes(root.value)
      && cause && "value" in cause && ["missing","changed","unavailable"].includes(cause.value)) return new PlacementWriterContextError(root.value,cause.value);
  }
  return new PlacementWriterContextError(category,"unavailable");
}
const fail = (category: PlacementWriterRootCategory, cause: PlacementWriterContextError["causeClass"]): never => { throw new PlacementWriterContextError(category,cause); };
function required(home: string, ownRoot: string) {
  let own: string, receipt: string[];
  try { own = realPath(ownRoot); } catch { return fail("running CLI","unavailable"); }
  try { receipt = readSetupWriterRoots(home); } catch { return fail("setup receipt","unavailable"); }
  return { own, receipt, roots: [...new Set([own,...receipt])].sort() };
}
function measureComplete(home: string, roots: readonly string[], ownRoot: string): SyncPlacementWriterMeasurement {
  const before = required(home,ownRoot);
  let result: SyncPlacementWriterMeasurement;
  try { result = measureSyncPlacementWriters(roots); } catch { return fail("declared writer","unavailable"); }
  if (!result.roots.some(row => row.root === before.own)) fail("running CLI","missing");
  if (before.receipt.some(root => !result.roots.some(row => row.root === root))) fail("setup receipt","missing");
  const after = required(home,ownRoot);
  if (after.own !== before.own) fail("running CLI","changed");
  if (canonicalJSON(after.receipt) !== canonicalJSON(before.receipt)) fail("setup receipt","changed");
  return result;
}
export interface PlacementWriterContext {
  measurement: SyncPlacementWriterMeasurement;
  attest: PlacementCapturePort["attest"];
  lastRefusal?: PlacementWriterContextError;
}
/** Preview creates no quiescence claim. The coordinator invokes attest only while its live apply fences are held. */
export function initialPlacementWriterContext(home: string, roots: readonly string[], ownRoot: string): PlacementWriterContext {
  const selected = roots.length ? [...roots] : required(home,ownRoot).roots;
  const measurement = measureComplete(home,selected,ownRoot), canonical = measurement.roots.map(row=>row.root);
  const floor = requirePlacementHomeFloor(home);
  const context: PlacementWriterContext = { measurement, attest: () => {
    try {
      if (requirePlacementHomeFloor(home) !== floor) return fail("home floor","changed");
      const current = measureComplete(home,canonical,ownRoot);
      if (canonicalJSON(current.writers) !== canonicalJSON(measurement.writers)) return fail("declared writer","changed");
      return { writers: current.writers, legacySyncQuiesced: true };
    } catch (error) { context.lastRefusal = safeRefusal(error,"declared writer"); throw context.lastRefusal; }
  } }; return context;
}
/** Active callbacks re-read the bound locator AND measure every package anew. No activation or renewal occurs. */
export function activePlacementWriterContext(home: string, ownRoot: string): PlacementWriterContext {
  const read = () => {
    requirePlacementHomeFloor(home);
    const markers = readPlacementRuntimeMarkers(home), binding = readActivePlacementBinding(home,markers.profile,markers.shards);
    if (!binding) return fail("active locator","unavailable");
    let roots: string[]; try { roots = readSyncPlacementWriterRoots(home); } catch { return fail("active locator","unavailable"); }
    const needed = required(home,ownRoot);
    if(!roots.includes(needed.own))return fail("running CLI","missing");
    if(needed.receipt.some(root=>!roots.includes(root)))return fail("setup receipt","missing");
    const measurement = measureComplete(home,roots,ownRoot);
    if (canonicalJSON(measurement.writers) !== canonicalJSON(binding.activation.writers)) return fail("declared writer","changed");
    return measurement;
  };
  const measurement = read(), context: PlacementWriterContext = { measurement, attest: () => {
    try { return { writers: read().writers, legacySyncQuiesced: true }; }
    catch (error) { context.lastRefusal = safeRefusal(error,"active locator"); throw context.lastRefusal; }
  } }; return context;
}

/** Person preview only: incomplete measurements remain explicit and never become an attestation. */
export function previewActivePlacementWriters(home: string, ownRoot: string, requested: readonly string[] = []) {
  const markers = readPlacementRuntimeMarkers(home), active = readActivePlacementBinding(home,markers.profile,markers.shards);
  if (!active) return fail("active locator","unavailable");
  const mapped = readSyncPlacementWriterRoots(home), selected = requested.length ? [...requested] : mapped;
  const expected = active.activation.writers;
  let measurement: SyncPlacementWriterMeasurement;
  try { measurement = measureSyncPlacementWriters(selected); }
  catch { return { complete:false, matches:false, roots:[] as SyncPlacementWriterMeasurement["roots"], expected, missingCategories:["declared writer"] as PlacementWriterRootCategory[], differences:expected.map(row=>({writerId:row.writerId,state:"unverified" as const})),refusalCategory:"declared writer" as PlacementWriterRootCategory }; }
  const needed = required(home,ownRoot), missingCategories: PlacementWriterRootCategory[] = [];
  if (!measurement.roots.some(row=>row.root===needed.own)) missingCategories.push("running CLI");
  if (needed.receipt.some(root=>!measurement.roots.some(row=>row.root===root))) missingCategories.push("setup receipt");
  const differences = expected.map(row=>{
    const actual = measurement.writers.find(value=>value.writerId===row.writerId);
    return {writerId:row.writerId,state:!actual?"missing":canonicalJSON(row)===canonicalJSON(actual)?"unchanged":"changed"};
  });
  for (const row of measurement.writers) if (!expected.some(value=>value.writerId===row.writerId)) differences.push({writerId:row.writerId,state:"added"});
  const matches=missingCategories.length===0&&differences.every(row=>row.state==="unchanged");
  const changed=measurement.roots.find(row=>{const old=expected.find(value=>value.writerId===row.writerId);return !old||old.pin!==row.pin||old.version!==row.version;});
  const refusalCategory:PlacementWriterRootCategory=missingCategories[0]??(changed?.root===needed.own?"running CLI":changed&&needed.receipt.includes(changed.root)?"setup receipt":"declared writer");
  return {complete:true,matches,roots:measurement.roots,expected,missingCategories,differences,refusalCategory};
}
