import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as setup from "../src/setup.ts";
import { realPath } from "../src/memory/platform.ts";
import { initialPlacementWriterContext, PlacementWriterContextError, type PlacementWriterRootCategory } from "../src/sync-placement-writer-context.ts";

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
  return{home,own,managed,declared,roots:[own,managed,declared]};
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

test("active diagnostics keep restore-or-renew and locator recovery never invents a backup",()=>{
  for(const category of ["running CLI","setup receipt","declared writer"] as PlacementWriterRootCategory[]){
    const error=new PlacementWriterContextError(category,"changed");expect(error.message).toContain("restore the inventoried install");expect(error.message).toContain("amem migrate --sync-placement --dry-run");
  }
  const locator=new PlacementWriterContextError("active locator","unavailable");
  expect(locator.message).toContain("inspect sync-placement-writer-roots.json");expect(locator.message).toContain("compatible recovery release");expect(locator.message).not.toContain("backup");
});
