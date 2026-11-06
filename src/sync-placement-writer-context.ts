/** CLI adapter only. Expected locators are never returned as fresh writer facts. */
import { types } from "node:util";
import { realPath } from "./memory/platform.ts";
import { canonicalJSON } from "./memory/generation.ts";
import { readSetupWriterRoots } from "./setup.ts";
import { measureSyncPlacementWriters, extractSyncPlacementWriterFailure, type SyncPlacementWriterFailureDetail, type SyncPlacementWriterMeasurement } from "./memory/sync-placement-writers.ts";
import { readEffectiveSyncPlacementWriters } from "./memory/sync-placement-effective-writers.ts";
import { requirePlacementHomeFloor } from "./memory/sync-placement-prerequisites.ts";
import type { PlacementCapturePort } from "./memory/sync-placement-capture.ts";
import { SharedWriterRevisionError } from "./memory/sync-placement-writer-revision-format.ts";

export type PlacementWriterRootCategory = "running CLI" | "setup receipt" | "declared writer" | "active locator" | "home floor" | "writer renewal";
export type PlacementWriterContextPhase = "initial" | "active";
const failureDetails:Record<SyncPlacementWriterFailureDetail,string>={
  "below-minimum":"release is below 0.21.0", "wrong-package":"package is not @staix/agent-mem", "writable-runtime":"runtime code is group- or world-writable", unreadable:"runtime files are unreadable or missing",
  "invalid-version":"package version is not a supported plain release", "invalid-inventory":"root inventory is invalid or duplicated", "unsafe-runtime":"runtime files have unsafe types or symlinks",
  "missing-runtime":"required bin/amem.js or src/index.ts is missing",bound:"inventory exceeds a supported bound",changed:"install changed during measurement",
};
function writerContextMessage(category:PlacementWriterRootCategory,causeClass:"missing"|"changed"|"unavailable",phase:PlacementWriterContextPhase,detail?:SyncPlacementWriterFailureDetail,renewalState?:"pending"|"staging"):string {
  if(category==="writer renewal")return new SharedWriterRevisionError(renewalState==="staging"?"staging":"pending").message;
  if(category==="active locator") return `Sync placement initial root locator is ${causeClass} (active locator category); have the person inspect sync-placement-writer-roots.json and the matching activation metadata with a compatible recovery release, then run amem migrate --sync-placement --dry-run.`;
  if(category==="home floor") return `Sync placement reader-floor proof is ${causeClass} (home floor category); have the person inspect formats.json and use a reader compatible with its recorded floor, then run amem migrate --sync-placement --dry-run.`;
  const cause=detail?`; ${failureDetails[detail]}`:"";
  if(phase==="initial")return `Sync placement initial writer proof is ${causeClass} (${category} category${cause}); ${category==="setup receipt"?"upgrade or repair the managed amem install and its host exact pin, then rerun amem setup <target> --apply":"upgrade or repair the amem install and its host exact pin"}. Declare the complete writer roots and rerun amem migrate --sync-placement --dry-run.`;
  return `Sync placement writer proof is ${causeClass} (${category} category${cause}); restore the inventoried install, or have the person run amem migrate --sync-placement --dry-run and --apply with the complete --writer-root inventory after installing the required 0.22.0 home floor.`;
}
export class PlacementWriterContextError extends Error {
  constructor(readonly category: PlacementWriterRootCategory, readonly causeClass: "missing" | "changed" | "unavailable",readonly phase:PlacementWriterContextPhase="active",readonly detail?:SyncPlacementWriterFailureDetail,readonly renewalState?:"pending"|"staging") {
    super(writerContextMessage(category,causeClass,phase,detail,renewalState)); this.name = "PlacementWriterContextError";
  }
}
function safeRefusal(error: unknown, category: PlacementWriterRootCategory,phase:PlacementWriterContextPhase="active"): PlacementWriterContextError {
  if(error&&typeof error==="object"&&!types.isProxy(error)&&error instanceof SharedWriterRevisionError){const code=Object.getOwnPropertyDescriptor(error,"code")?.value;if(code==="pending"||code==="staging")return new PlacementWriterContextError("writer renewal","unavailable",phase,undefined,code);}
  if (error && typeof error === "object" && !types.isProxy(error) && error instanceof PlacementWriterContextError) {
    const fields=Object.getOwnPropertyDescriptors(error),root=fields.category,cause=fields.causeClass,detail=fields.detail;
    const category:unknown=root&&"value"in root?root.value:undefined,causeClass:unknown=cause&&"value"in cause?cause.value:undefined;
    if (typeof category==="string" && ["running CLI","setup receipt","declared writer","active locator","home floor","writer renewal"].includes(category)
      && typeof causeClass==="string" && ["missing","changed","unavailable"].includes(causeClass)) {
      const ownDetail=detail&&"value"in detail&&typeof detail.value==="string"&&Object.hasOwn(failureDetails,detail.value)?detail.value as SyncPlacementWriterFailureDetail:undefined;
      const state=fields.renewalState?.value;
      return new PlacementWriterContextError(category as PlacementWriterRootCategory,causeClass as PlacementWriterContextError["causeClass"],phase,ownDetail,state==="staging"||state==="pending"?state:undefined);
    }
  }
  return new PlacementWriterContextError(category,"unavailable",phase);
}
const fail = (category: PlacementWriterRootCategory, cause: PlacementWriterContextError["causeClass"],phase:PlacementWriterContextPhase="active",detail?:SyncPlacementWriterFailureDetail): never => { throw new PlacementWriterContextError(category,cause,phase,detail); };
function required(home: string, ownRoot: string,phase:PlacementWriterContextPhase="active") {
  let own: string, receipt: string[];
  try { own = realPath(ownRoot); } catch { return fail("running CLI","unavailable",phase,"unreadable"); }
  try { receipt = readSetupWriterRoots(home); } catch { return fail("setup receipt","unavailable",phase,"unreadable"); }
  return { own, receipt, roots: [...new Set([own,...receipt])].sort() };
}
function rootCategory(root:string|undefined,needed:ReturnType<typeof required>):PlacementWriterRootCategory {
  if(root===needed.own)return "running CLI";return root&&needed.receipt.includes(root)?"setup receipt":"declared writer";
}
function measurementRefusal(error:unknown,roots:readonly string[],needed:ReturnType<typeof required>,phase:PlacementWriterContextPhase):PlacementWriterContextError {
  const detail=extractSyncPlacementWriterFailure(error);let root:string|undefined;
  if(detail?.rootIndex!==undefined){try{root=realPath(roots[detail.rootIndex]!);}catch{/* Missing noncanonical declared path is still unavailable, never fresh evidence. */}}
  return new PlacementWriterContextError(rootCategory(root,needed),detail?.code==="changed"?"changed":"unavailable",phase,detail?.detail??"unreadable");
}
function measureComplete(home: string, roots: readonly string[], ownRoot: string,phase:PlacementWriterContextPhase="active"): SyncPlacementWriterMeasurement {
  const before = required(home,ownRoot,phase);let result: SyncPlacementWriterMeasurement;
  try { result = measureSyncPlacementWriters(roots); } catch(error) { throw measurementRefusal(error,roots,before,phase); }
  if (!result.roots.some(row => row.root === before.own)) fail("running CLI","missing",phase);
  if (before.receipt.some(root => !result.roots.some(row => row.root === root))) fail("setup receipt","missing",phase);
  const after = required(home,ownRoot,phase);
  if (after.own !== before.own) fail("running CLI","changed",phase,"changed");
  if (canonicalJSON(after.receipt) !== canonicalJSON(before.receipt)) fail("setup receipt","changed",phase,"changed");
  return result;
}
export interface PlacementWriterContext {
  measurement: SyncPlacementWriterMeasurement;
  attest: PlacementCapturePort["attest"];
  lastRefusal?: PlacementWriterContextError;
}
/** Preview creates no quiescence claim. The coordinator invokes attest only while its live apply fences are held. */
export function initialPlacementWriterContext(home: string, roots: readonly string[], ownRoot: string): PlacementWriterContext {
  const selected = roots.length ? [...roots] : required(home,ownRoot,"initial").roots;
  const measurement = measureComplete(home,selected,ownRoot,"initial"), canonical = measurement.roots.map(row=>row.root);
  const floor = requirePlacementHomeFloor(home);
  const context: PlacementWriterContext = { measurement, attest: () => {
    try {
      if (requirePlacementHomeFloor(home) !== floor) return fail("home floor","changed","initial");
      const current = measureComplete(home,canonical,ownRoot,"initial");
      if (canonicalJSON(current.writers) !== canonicalJSON(measurement.writers)) {
        const changed=current.roots.find(row=>!measurement.writers.some(old=>old.writerId===row.writerId&&old.version===row.version&&old.pin===row.pin));
        return fail(rootCategory(changed?.root,required(home,ownRoot,"initial")),"changed","initial","changed");
      }
      return { writers: current.writers, legacySyncQuiesced: true };
    } catch (error) { context.lastRefusal = safeRefusal(error,"declared writer","initial"); throw context.lastRefusal; }
  } }; return context;
}
/** Active callbacks re-read the bound locator AND measure every package anew. No activation or renewal occurs. */
export function activePlacementWriterContext(home: string, ownRoot: string): PlacementWriterContext {
  const read = () => {
    requirePlacementHomeFloor(home);
    const effective=readEffectiveSyncPlacementWriters(home);
    const roots=effective.roots;if(!roots)return fail("active locator","unavailable");
    const needed = required(home,ownRoot);
    if(!roots.includes(needed.own))return fail("running CLI","missing");
    if(needed.receipt.some(root=>!roots.includes(root)))return fail("setup receipt","missing");
    const measurement = measureComplete(home,roots,ownRoot);
    if (canonicalJSON(measurement.writers) !== canonicalJSON(effective.writers)) {
      const changed=measurement.roots.find(row=>!effective.writers.some(old=>old.writerId===row.writerId&&old.version===row.version&&old.pin===row.pin));
      return fail(rootCategory(changed?.root,needed),"changed","active","changed");
    }
    effective.assertCurrent();
    return measurement;
  };
  const measurement = read(), context: PlacementWriterContext = { measurement, attest: () => {
    try { return { writers: read().writers, legacySyncQuiesced: true }; }
    catch (error) { context.lastRefusal = safeRefusal(error,"active locator"); throw context.lastRefusal; }
  } }; return context;
}

/** Person preview only: incomplete measurements remain explicit and never become an attestation. */
export function previewActivePlacementWriters(home: string, ownRoot: string, requested: readonly string[] = []) {
  const effective=readEffectiveSyncPlacementWriters(home),mapped=effective.roots;if(!mapped)return fail("active locator","unavailable");
  const selected = requested.length ? [...requested] : mapped;
  const expected = effective.writers;
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
