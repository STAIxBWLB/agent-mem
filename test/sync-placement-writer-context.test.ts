import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as setup from "../src/setup.ts";
import { realPath } from "../src/memory/platform.ts";
import { initialPlacementWriterContext, markedSetupReceiptRefusal, placementSyncFailure, placementWriterRefusalText, PlacementWriterContextError, type PlacementWriterRootCategory } from "../src/sync-placement-writer-context.ts";
import { SharedWriterRevisionError } from "../src/memory/sync-placement-writer-revision-format.ts";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function fixture(){
  const root=realPath(mkdtempSync(join(tmpdir(),"amem-writer-context-")));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,"memory");mkdirSync(home,{mode:0o700});
  writeFileSync(join(home,"formats.json"),JSON.stringify([{surface:"home",minReader:"0.21.0",since:"2026-11-06"}]),{mode:0o600});
  const install=(name:string)=>{const dir=join(root,name);mkdirSync(dir,{mode:0o755});for(const part of ["src","bin"])mkdirSync(join(dir,part),{mode:0o755});
    writeFileSync(join(dir,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.21.0"}),{mode:0o644});
    writeFileSync(join(dir,"src/index.ts"),"not executed\n",{mode:0o644});writeFileSync(join(dir,"bin/amem.js"),"not executed\n",{mode:0o755});return dir;};
  const own=install("own"),managed=install("managed"),declared=install("declared");
  // This isolated port tests category mapping; real receipt decoding/completeness has its own fixtures.
  const receipts=spyOn(setup,"readSetupWriterRoots").mockReturnValue([managed]);cleanup.push(()=>receipts.mockRestore());
  return{home,own,managed,declared,roots:[own,managed,declared],receipts};
}
function failure(work:()=>unknown){let caught:unknown;try{work();}catch(error){caught=error;}expect(caught).toBeInstanceOf(PlacementWriterContextError);return caught as PlacementWriterContextError;}

for(const category of ["running CLI","setup receipt","declared writer"] as const)for(const cause of ["below-minimum","wrong-package","writable-runtime","unreadable"] as const)
test(`initial ${category} diagnostic identifies ${cause} and gives an initial-install action`,()=>{
  const f=fixture(),target=category==="running CLI"?f.own:category==="setup receipt"?f.managed:f.declared;
  if(cause==="below-minimum")writeFileSync(join(target,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.20.3"}));
  else if(cause==="wrong-package")writeFileSync(join(target,"package.json"),JSON.stringify({name:"other-package",version:"0.21.0"}));
  else if(cause==="writable-runtime")chmodSync(join(target,"src/index.ts"),0o666);
  else unlinkSync(join(target,"package.json"));
  const error=failure(()=>initialPlacementWriterContext(f.home,f.roots,f.own));
  expect(error.category).toBe(category);expect(error.detail).toBe(cause);expect(error.phase).toBe("initial");
  expect(error.message).toContain(`${category} category`);expect(error.message).toContain("host exact pin");
  if(category==="setup receipt")expect(error.message).toContain("amem setup <target> --apply");
  expect(error.message).not.toContain("restore the inventoried install");expect(error.message).not.toContain("supports renewal");
});

test("initial callback drift retains its root category and initial remedy",()=>{
  const f=fixture(),context=initialPlacementWriterContext(f.home,f.roots,f.own);writeFileSync(join(f.own,"src/index.ts"),"changed bytes\n");
  const error=failure(()=>context.attest());expect(error.category).toBe("running CLI");expect(error.phase).toBe("initial");
  expect(context.lastRefusal).toBe(error);expect(error.message).toContain("upgrade or repair");expect(error.message).not.toContain("supports renewal");
});

test("a setup receipt naming a removed install names its target and both remedies, never the recorded path",()=>{
  const f=fixture();f.receipts.mockImplementation(()=>{throw new setup.SetupWriterRootsError("unavailable","agy");});
  const error=failure(()=>initialPlacementWriterContext(f.home,f.roots,f.own));
  expect(error.category).toBe("setup receipt");expect(error.causeClass).toBe("unavailable");expect(error.phase).toBe("initial");expect(error.setupTarget).toBe("agy");
  expect(error.message).toContain("the agy setup receipt names an amem install that no longer exists");
  expect(error.message).toContain("amem setup agy --apply");expect(error.message).toContain("amem setup agy --undo");
  expect(error.message).not.toContain(f.home);expect(error.message).not.toContain("host exact pin");
});

test("the attest callback keeps the mapped setup target, and an anonymous receipt refusal keeps the old text",()=>{
  const f=fixture(),context=initialPlacementWriterContext(f.home,f.roots,f.own);
  f.receipts.mockImplementation(()=>{throw new setup.SetupWriterRootsError("unavailable","qwen");});
  const error=failure(()=>context.attest());expect(context.lastRefusal).toBe(error);
  expect(error.category).toBe("setup receipt");expect(error.setupTarget).toBe("qwen");expect(error.message).toContain("amem setup qwen --apply");
  f.receipts.mockImplementation(()=>{throw new setup.SetupWriterRootsError("unsupported");});
  const anonymous=failure(()=>initialPlacementWriterContext(f.home,f.roots,f.own));
  expect(anonymous.setupTarget).toBeUndefined();expect(anonymous.message).toContain("amem setup <target> --apply");
});

test("the marked diagnostic reports only a positively identified setup-receipt refusal, as fixed text",()=>{
  const refusal=new PlacementWriterContextError("setup receipt","unavailable","active","unreadable",undefined,"qwen"),text=markedSetupReceiptRefusal(refusal)!;
  expect(text).toContain("[cause: setup_receipt_missing_install]");
  expect(text).toContain("the qwen setup receipt names an amem install that no longer exists");
  expect(text).toContain("amem setup qwen --apply");expect(text).toContain("amem setup qwen --undo");expect(text).toContain("then rerun the sync");
  // A writer that went missing, a changed install, another category and an anonymous receipt keep the generic masked refusal.
  expect(markedSetupReceiptRefusal(new PlacementWriterContextError("setup receipt","missing"))).toBeUndefined();
  expect(markedSetupReceiptRefusal(new PlacementWriterContextError("setup receipt","changed","active","changed",undefined,"qwen"))).toBeUndefined();
  expect(markedSetupReceiptRefusal(new PlacementWriterContextError("declared writer","unavailable","active","unreadable",undefined,"qwen"))).toBeUndefined();
  expect(markedSetupReceiptRefusal(Error("Memory operation unavailable or refused; no partial result is shown."))).toBeUndefined();
  // Only an allowlisted target yields the template; a recorded path or a caught message never becomes text.
  expect(markedSetupReceiptRefusal(Object.assign(Error("qwen setup receipt"),{category:"setup receipt",causeClass:"unavailable",setupTarget:"/private/install"}))).toBeUndefined();
  expect(markedSetupReceiptRefusal(Object.assign(Error("caught message"),{category:"setup receipt",causeClass:"unavailable",setupTarget:"agy"}))).not.toContain("caught message");
});

test("the later sync failure keeps the mapped target through its wrapper, without its inner error text",()=>{
  const f=fixture(),context=initialPlacementWriterContext(f.home,f.roots,f.own);
  f.receipts.mockImplementation(()=>{throw new setup.SetupWriterRootsError("unavailable","pi");});
  const refusal=failure(()=>context.attest()),later=placementSyncFailure(refusal,Error(`transport refused at ${f.home}`));
  expect(later.message).toContain(f.home);   // the person's report keeps the underlying transport detail
  const text=markedSetupReceiptRefusal(later)!;
  expect(text).toContain("amem setup pi --apply");expect(text).not.toContain(f.home);expect(text).not.toContain("transport refused");
  // An early refusal that never reached the wrapper reports the same fixed text.
  expect(text).toBe(markedSetupReceiptRefusal(refusal)!);
});

test("active diagnostics keep restore-or-renew and locator recovery never invents a backup",()=>{
  for(const category of ["running CLI","setup receipt","declared writer"] as PlacementWriterRootCategory[]){
    const error=new PlacementWriterContextError(category,"changed");expect(error.message).toContain("restore the inventoried install");expect(error.message).toContain("amem migrate --sync-placement --dry-run");
  }
  const locator=new PlacementWriterContextError("active locator","unavailable");
  expect(locator.message).toContain("inspect sync-placement-writer-roots.json");expect(locator.message).toContain("compatible recovery release");expect(locator.message).not.toContain("backup");
});

const CATEGORIES=["running CLI","host package","setup receipt","declared writer","active locator","home floor","writer renewal"] as const;
// #551 AC1: every writer-context category names its fixed category, its cause class and a remedy in the same sentence, so a
// marked and an unmarked surface print one sentence instead of the masked line - and no root, row or caught text rides along.
for(const category of CATEGORIES)for(const causeClass of ["missing","changed","unavailable"] as const)
test(`#551 AC1: the ${category}/${causeClass} text states its category, cause class and remedy`,()=>{
  const error=new PlacementWriterContextError(category,causeClass),message=error.message;
  expect(message.startsWith("Sync placement ")).toBe(true);
  // The category phrase closes its own parenthetical, or continues it with a measurement detail after a semicolon.
  expect(message).toContain(`(${category} category`);
  expect(message).toContain(`is ${causeClass}`);
  expect(message).toContain("amem migrate --sync-placement");
  expect(message).not.toContain("/");
  expect(message).not.toContain("Memory operation unavailable or refused");
  // The text a person-facing surface prints is that same sentence, rebuilt rather than echoed.
  expect(placementWriterRefusalText(error)).toBe(message);
});

test("#551 AC1: a measurement detail stays inside the same parenthetical as the category",()=>{
  const message=new PlacementWriterContextError("declared writer","changed","active","changed").message;
  expect(message).toContain("(declared writer category; install changed during measurement)");
  expect(message).toContain("is changed");
});

test("#551 AC1: an initial-phase refusal names its phase and keeps the initial-install remedy",()=>{
  for(const category of ["running CLI","host package","setup receipt","declared writer"] as const){
    const initial=new PlacementWriterContextError(category,"missing","initial");
    expect(initial.message).toContain(`(${category} category)`);expect(initial.message).toContain("Sync placement initial ");
    expect(initial.message).toContain("Declare the complete writer roots");
  }
});

test("#551 AC1: the renewal branch states the category and cause class and reproduces the shared remedy verbatim",()=>{
  for(const state of ["pending","staging","checkpoint-pending"] as const){
    const message=new PlacementWriterContextError("writer renewal","unavailable","active",undefined,state).message;
    expect(message).toContain("(writer renewal category)");
    expect(message).toContain("writer proof is unavailable");
    expect(message).toContain(`; ${new SharedWriterRevisionError(state).message}`);   // the checkpoint and renewal remedies are never replaced
    expect(message).not.toContain("/");
  }
});

test("#551 AC1: the text is rebuilt from fixed own data, so a tampered message or a forged field is never printed",()=>{
  const genuine=new PlacementWriterContextError("declared writer","changed","active","changed"),canonical=genuine.message;
  expect(placementWriterRefusalText(genuine)).toBe(canonical);
  // The sentence is reconstructed from the validated fields, so a replaced message never becomes the text.
  Object.defineProperty(genuine,"message",{value:"caught message naming /private/home and row text"});
  expect(placementWriterRefusalText(genuine)).toBe(canonical);
  expect(placementWriterRefusalText(genuine)).not.toContain("/private/home");
  // A forged category or cause class is out of the closed set, so no text is produced from it.
  for(const [field,value] of [["category","forged category"],["causeClass","gone"]] as const){
    const forged=new PlacementWriterContextError("declared writer","changed");Object.defineProperty(forged,field,{value});
    expect(placementWriterRefusalText(forged)).toBeUndefined();
  }
  // A wrapper's carried refusal is used; its own transport message never is.
  const carried=placementSyncFailure(new PlacementWriterContextError("setup receipt","missing"),Error("transport refused at /private/home"));
  expect(placementWriterRefusalText(carried)).toContain("(setup receipt category)");expect(placementWriterRefusalText(carried)).not.toContain("/private/home");
  // An object that merely resembles a refusal is not one, and a proxy is never read.
  expect(placementWriterRefusalText(Object.assign(Error("looks like a refusal"),{category:"running CLI",causeClass:"missing",phase:"active"}))).toBeUndefined();
  expect(placementWriterRefusalText(new Proxy(new PlacementWriterContextError("running CLI","missing"),{}))).toBeUndefined();
});

test("#551 AC1: every other exception keeps the masked refusal, and #520's receipt text is unchanged",()=>{
  for(const value of [Error("Memory operation unavailable or refused; no partial result is shown."),new Error("transport refused at /private/home"),undefined,null,"refusal",42,{}])
    expect(placementWriterRefusalText(value)).toBeUndefined();
  const receipt=new PlacementWriterContextError("setup receipt","unavailable","active",undefined,undefined,"qwen");
  expect(placementWriterRefusalText(receipt)).toBe(markedSetupReceiptRefusal(receipt)!);   // the existing #520 text wins for this case
  expect(placementWriterRefusalText(receipt)).toContain("[cause: setup_receipt_missing_install]");
  expect(placementWriterRefusalText(new PlacementWriterContextError("setup receipt","missing","active",undefined,undefined,"qwen"))).toContain("(setup receipt category)");
});
