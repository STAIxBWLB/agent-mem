/** CLI/host adapter. Expected locators are never returned as fresh writer facts. */
import { types } from "node:util";
import { fileURLToPath } from "node:url";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { canonicalJSON } from "./memory/generation.ts";
import { readSetupWriterRoots, SETUP_TARGETS, setupReceiptRemedy, SetupWriterRootsError, type SetupTarget } from "./setup-writer-roots.ts";
import { placementMarkerState } from "./memory/sync-placement-guard.ts";
import { measureSyncPlacementWriters, extractSyncPlacementWriterFailure, type SyncPlacementWriterFailureDetail, type SyncPlacementWriterMeasurement } from "./memory/sync-placement-writers.ts";
import { readEffectiveSyncPlacementWriters } from "./memory/sync-placement-effective-writers.ts";
import { PlacementHomeFloorError, requirePlacementHomeFloor } from "./memory/sync-placement-prerequisites.ts";
import { FormatFloorError } from "./memory/formats.ts";
import type { PlacementCapturePort } from "./memory/sync-placement-capture.ts";
import { SharedWriterRevisionError } from "./memory/sync-placement-writer-revision-format.ts";

export type PlacementWriterRootCategory = "running CLI" | "host package" | "setup receipt" | "declared writer" | "active locator" | "home floor" | "writer renewal";
export type PlacementWriterContextPhase = "initial" | "active";
const failureDetails:Record<SyncPlacementWriterFailureDetail,string>={
  "below-minimum":"release is below 0.21.0", "wrong-package":"package is not @staix/agent-mem", "writable-runtime":"runtime code is group- or world-writable", unreadable:"runtime files are unreadable or missing",
  "invalid-version":"package version is not a supported plain release", "invalid-inventory":"root inventory is invalid or duplicated", "unsafe-runtime":"runtime files have unsafe types or symlinks",
  "missing-runtime":"required bin/amem.js or src/index.ts is missing",bound:"inventory exceeds a supported bound",changed:"install changed during measurement",
};
function writerContextMessage(category:PlacementWriterRootCategory,causeClass:"missing"|"changed"|"unavailable",phase:PlacementWriterContextPhase,detail?:SyncPlacementWriterFailureDetail,renewalState?:"pending"|"staging"|"checkpoint-pending",setupTarget?:SetupTarget):string {
  // #551 AC1: the shared revision text names neither this category nor its cause class, so both are printed here and the
  // shared text (which carries its own remedy) follows. The checkpoint message is still reproduced verbatim, never replaced.
  if(category==="writer renewal")return `Sync placement ${phase==="initial"?"initial ":""}writer proof is ${causeClass} (writer renewal category); ${new SharedWriterRevisionError(renewalState==="staging"?"staging":renewalState==="checkpoint-pending"?"checkpoint-pending":"pending").message}`;
  if(category==="active locator") return `Sync placement initial root locator is ${causeClass} (active locator category); inspect sync-placement-writer-roots.json and the matching activation metadata with a compatible recovery release, then run amem migrate --sync-placement --dry-run.`;
  if(category==="home floor") return `Sync placement reader-floor proof is ${causeClass} (home floor category); inspect formats.json and use a reader compatible with its recorded floor, then run amem migrate --sync-placement --dry-run.`;
  const cause=detail?`; ${failureDetails[detail]}`:"";
  // #520: a receipt whose recorded install root is gone names its target and remedy, never the recorded path. #551 keeps that
  // sentence - its cause marker, its remedy and its next step - behind the fixed category and cause class, so both surfaces
  // print one sentence and neither loses the established remedy.
  const receipt=category==="setup receipt"&&setupTarget?setupReceiptRemedy(setupTarget):undefined;
  if(phase==="initial")return `Sync placement initial writer proof is ${causeClass} (${category} category${cause}); ${receipt??(category==="setup receipt"?"upgrade or repair the managed amem install and its host exact pin, then rerun amem setup <target> --apply":"upgrade or repair the amem install and its host exact pin")}. Declare the complete writer roots and rerun amem migrate --sync-placement --dry-run.`;
  if(receipt)return `Sync placement writer proof is ${causeClass} (${category} category${cause}); Placement sync refused [cause: setup_receipt_missing_install]: ${receipt}; then rerun the sync.`;
  return `Sync placement writer proof is ${causeClass} (${category} category${cause}); restore the inventoried install, or renew it: if needed, preview amem formats raise home 0.22.0 and add --confirm after the exact command is approved; then run amem migrate --sync-placement --dry-run with the complete --writer-root inventory, and run --apply after the exact apply command is approved.`;
}
export class PlacementWriterContextError extends Error {
  constructor(readonly category: PlacementWriterRootCategory, readonly causeClass: "missing" | "changed" | "unavailable",readonly phase:PlacementWriterContextPhase="active",readonly detail?:SyncPlacementWriterFailureDetail,readonly renewalState?:"pending"|"staging"|"checkpoint-pending",readonly setupTarget?:SetupTarget) {
    super(writerContextMessage(category,causeClass,phase,detail,renewalState,setupTarget)); this.name = "PlacementWriterContextError";
  }
}
/**
 * #520: a later sync failure carries its placement refusal as fixed own data, never only as the message text a marked
 * session masks, so the target and remedy survive the wrapper that adds the underlying transport error.
 */
export function placementSyncFailure(refusal: PlacementWriterContextError, failure: unknown): Error {
  const error = new Error(`${refusal.message} ${(failure as Error).message}`);
  Object.defineProperty(error, "placementRefusal", { value: refusal }); return error;
}
/**
 * #520: the fixed-data text a marked session gets when a placement refusal comes from an applied setup receipt whose
 * recorded amem install no longer exists. Fields are read as own properties and validated against closed sets, so a
 * caught message, a recorded path or a forged target never reaches the text; every other failure returns undefined and
 * keeps the generic masked refusal. #551 AC1: the sentence is the shared one, so it carries the fixed category and cause
 * class in front of #520's marker, remedy and next step.
 */
export function markedSetupReceiptRefusal(error: unknown): string | undefined {
  const receipt = setupReceiptRefusal(error);
  return receipt === undefined ? undefined : writerContextMessage("setup receipt","unavailable",receipt.phase,receipt.detail,undefined,receipt.target);
}
function setupReceiptRefusal(error: unknown): { target: SetupTarget; phase: PlacementWriterContextPhase; detail?: SyncPlacementWriterFailureDetail } | undefined {
  if (!error || typeof error !== "object" || types.isProxy(error)) return undefined;
  const carried: unknown = Object.getOwnPropertyDescriptor(error, "placementRefusal")?.value;
  const refusal: unknown = carried && typeof carried === "object" && !types.isProxy(carried) ? carried : error;
  if (refusal === null || typeof refusal !== "object") return undefined;
  const fields = Object.getOwnPropertyDescriptors(refusal), target: unknown = fields.setupTarget?.value, detail: unknown = fields.detail?.value;
  if (fields.category?.value !== "setup receipt" || fields.causeClass?.value !== "unavailable") return undefined;
  if (typeof target !== "string" || !(SETUP_TARGETS as readonly string[]).includes(target)) return undefined;
  return { target: target as SetupTarget, phase: fields.phase?.value === "initial" ? "initial" : "active",
    ...(typeof detail === "string" && Object.hasOwn(failureDetails, detail) ? { detail: detail as SyncPlacementWriterFailureDetail } : {}) };
}
const WRITER_ROOT_CATEGORIES=["running CLI","host package","setup receipt","declared writer","active locator","home floor","writer renewal"] as const satisfies readonly PlacementWriterRootCategory[];
const WRITER_CAUSE_CLASSES=["missing","changed","unavailable"] as const;
/**
 * #551 AC1: the refusal as fixed own data for a person-facing surface. A real PlacementWriterContextError - or the one a
 * later sync failure carries as `placementRefusal` - is rebuilt from its own validated fields, so a tampered message, a
 * forged category or a recorded path never reaches the text; anything else returns undefined and keeps its own handling.
 * A proxy is refused before any instanceof, prototype or property inspection, including a proxy carried as
 * `placementRefusal`, so a throwing trap can never run here.
 * Module-internal: the two surfaces reach it through `placementWriterRefusalText` and `placementWriterVerification` only.
 */
function placementWriterRefusal(error: unknown): PlacementWriterContextError | undefined {
  if (!error || typeof error !== "object" || types.isProxy(error)) return undefined;
  const carried: unknown = Object.getOwnPropertyDescriptor(error, "placementRefusal")?.value;
  const candidate: unknown = carried !== null && typeof carried === "object" && !types.isProxy(carried) && carried instanceof PlacementWriterContextError ? carried : error;
  if (!(candidate instanceof PlacementWriterContextError)) return undefined;
  const fields = Object.getOwnPropertyDescriptors(candidate), category = fields.category?.value, causeClass = fields.causeClass?.value;
  if (typeof category !== "string" || !(WRITER_ROOT_CATEGORIES as readonly string[]).includes(category)) return undefined;
  if (typeof causeClass !== "string" || !(WRITER_CAUSE_CLASSES as readonly string[]).includes(causeClass)) return undefined;
  const detail = fields.detail?.value, state = fields.renewalState?.value, target = fields.setupTarget?.value;
  return new PlacementWriterContextError(category as PlacementWriterRootCategory, causeClass as PlacementWriterContextError["causeClass"],
    fields.phase?.value === "initial" ? "initial" : "active",
    typeof detail === "string" && Object.hasOwn(failureDetails, detail) ? detail as SyncPlacementWriterFailureDetail : undefined,
    state === "staging" || state === "pending" || state === "checkpoint-pending" ? state : undefined,
    typeof target === "string" && (SETUP_TARGETS as readonly string[]).includes(target) ? target as SetupTarget : undefined);
}
/** #551: no category is claimed here, because the state could not be read far enough to name one. */
const PLACEMENT_WRITER_UNVERIFIED_TEXT = "Placement writer verification could not establish a category: the retained writer inventory or its history could not be read far enough to name one; inspect the home with a compatible release, then run amem migrate --sync-placement --dry-run.";
/** An inventory state that could not be proven: never reported as a missing root, and never given an invented category. */
class UnprovenWriterInventory extends Error { constructor(){ super(PLACEMENT_WRITER_UNVERIFIED_TEXT); this.name="UnprovenWriterInventory"; } }
/** A shared writer-history code outside the three renewal states: `safeRefusal` would otherwise assert the locator category for it. */
function unprovenWriterHistory(error: unknown): boolean {
  if (!error || typeof error !== "object" || types.isProxy(error) || !(error instanceof SharedWriterRevisionError)) return false;
  const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
  return code !== "pending" && code !== "staging" && code !== "checkpoint-pending";
}
/**
 * #551 AC1: the fixed text `amem sync` and `amem doctor` report, one sentence per category, rebuilt rather than echoed.
 * #520's receipt case rides inside that same sentence - its cause marker, its target's remedy and its next step - so a
 * marked and an unmarked run print one text instead of two, and its shape-only entry point stays the fallback for a
 * refusal built by another copy of this module.
 */
export function placementWriterRefusalText(error: unknown): string | undefined {
  if (!types.isProxy(error) && error instanceof UnprovenWriterInventory) return PLACEMENT_WRITER_UNVERIFIED_TEXT;
  return placementWriterRefusal(error)?.message ?? markedSetupReceiptRefusal(error);
}
/**
 * #551: the writer verification a sync on this home would perform, as data. `missing` is reported only after the inventory
 * was read and compared, so an unreadable one never claims a root is absent; an unproven state asserts no category at all.
 */
export function placementWriterVerification(home: string, ownRoot: string):
  { writers: number; refusal?: undefined; unverified?: undefined }
  | { writers?: undefined; refusal: PlacementWriterContextError; unverified?: undefined }
  | { writers?: undefined; refusal?: undefined; unverified: string } {
  // #551: a marker this home cannot prove proves no category either, so it is unverified before any measurement is attempted.
  if (placementMarkerState(home) === "unverified") return { unverified: PLACEMENT_WRITER_UNVERIFIED_TEXT };
  try { return { writers: activePlacementWriterContext(home, ownRoot).measurement.writers.length }; }
  catch (error) {
    if (!types.isProxy(error) && error instanceof UnprovenWriterInventory) return { unverified: PLACEMENT_WRITER_UNVERIFIED_TEXT };
    const refusal = placementWriterRefusal(error);
    return refusal ? { refusal } : { unverified: PLACEMENT_WRITER_UNVERIFIED_TEXT };
  }
}
function safeRefusal(error: unknown, category: PlacementWriterRootCategory,phase:PlacementWriterContextPhase="active"): PlacementWriterContextError {
  if (error && typeof error === "object" && !types.isProxy(error) && (error instanceof PlacementHomeFloorError || error instanceof FormatFloorError)) return new PlacementWriterContextError("home floor","unavailable",phase);
  if(error&&typeof error==="object"&&!types.isProxy(error)&&error instanceof SharedWriterRevisionError){const code=Object.getOwnPropertyDescriptor(error,"code")?.value;if(code==="pending"||code==="staging"||code==="checkpoint-pending")return new PlacementWriterContextError("writer renewal","unavailable",phase,undefined,code);}
  if (error && typeof error === "object" && !types.isProxy(error) && error instanceof PlacementWriterContextError) {
    const fields=Object.getOwnPropertyDescriptors(error),root=fields.category,cause=fields.causeClass,detail=fields.detail;
    const category:unknown=root&&"value"in root?root.value:undefined,causeClass:unknown=cause&&"value"in cause?cause.value:undefined;
    if (typeof category==="string" && (WRITER_ROOT_CATEGORIES as readonly string[]).includes(category)
      && typeof causeClass==="string" && (WRITER_CAUSE_CLASSES as readonly string[]).includes(causeClass)) {
      const ownDetail=detail&&"value"in detail&&typeof detail.value==="string"&&Object.hasOwn(failureDetails,detail.value)?detail.value as SyncPlacementWriterFailureDetail:undefined;
      const state=fields.renewalState?.value,target=fields.setupTarget?.value;
      return new PlacementWriterContextError(category as PlacementWriterRootCategory,causeClass as PlacementWriterContextError["causeClass"],phase,ownDetail,state==="staging"||state==="pending"||state==="checkpoint-pending"?state:undefined,
        typeof target==="string"&&(SETUP_TARGETS as readonly string[]).includes(target)?target as SetupTarget:undefined);
    }
  }
  return new PlacementWriterContextError(category,"unavailable",phase);
}
const fail = (category: PlacementWriterRootCategory, cause: PlacementWriterContextError["causeClass"],phase:PlacementWriterContextPhase="active",detail?:SyncPlacementWriterFailureDetail,setupTarget?:SetupTarget): never => { throw new PlacementWriterContextError(category,cause,phase,detail,undefined,setupTarget); };
function required(home: string, ownRoot: string,phase:PlacementWriterContextPhase="active") {
  let own: string, receipt: string[];
  try { own = realPath(ownRoot); } catch { return fail("running CLI","unavailable",phase,"unreadable"); }
  try { receipt = readSetupWriterRoots(home); }
  catch (error) {
    // #520: only a receipt naming a removed install carries its target; every other inventory refusal stays anonymous.
    return fail("setup receipt","unavailable",phase,"unreadable",error instanceof SetupWriterRootsError?error.target:undefined);
  }
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
    try { requirePlacementHomeFloor(home); } catch (error) { throw safeRefusal(error,"home floor"); }
    let effective: ReturnType<typeof readEffectiveSyncPlacementWriters>;
    try { effective=readEffectiveSyncPlacementWriters(home); }
    // #551: an unreadable writer history proves no category, so it is never reported as a missing or unreadable locator.
    catch (error) { if (unprovenWriterHistory(error)) throw new UnprovenWriterInventory(); throw safeRefusal(error,"active locator"); }
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

/**
 * Host sync port bound to this executing installation, never a caller-selected root.
 * Legacy sync ignores the lazy port. Each invoked v3 check re-reads all expected
 * inventory and measures every root again; the cached context is not fresh proof.
 */
export function createPlacementAttestation(home: string): PlacementCapturePort["attest"] {
  const base = canonicalPath(home), ownRoot = fileURLToPath(new URL("..", import.meta.url));
  let context: PlacementWriterContext | undefined;
  return () => {
    try {
      context ??= activePlacementWriterContext(base, ownRoot);
      return context.attest();
    } catch (error) {
      const refusal = safeRefusal(error, "active locator");
      if (refusal.category === "running CLI") throw new PlacementWriterContextError("host package", refusal.causeClass, refusal.phase, refusal.detail, refusal.renewalState);
      throw refusal;
    }
  };
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
  const changedCategory:PlacementWriterRootCategory|undefined=changed?(changed.root===needed.own?"running CLI":needed.receipt.includes(changed.root)?"setup receipt":"declared writer"):undefined;
  // #567 AC4: a complete inventory with no missing category is not a refusal; the first changed root's category is
  // informational `changedCategory`. `refusalCategory` keeps its meaning and appears only when a category is missing.
  return {complete:true,matches,roots:measurement.roots,expected,missingCategories,differences,
    ...(missingCategories[0]?{refusalCategory:missingCategories[0]}:{}),...(changedCategory?{changedCategory}:{})};
}
