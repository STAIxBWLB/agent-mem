import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository=resolve(import.meta.dir,".."),modules=join(repository,"node_modules");
const compiler=join(modules,"typescript","bin","tsc"),hostTypes="bun-types-host-1-4-2",hostWrapper=join("@types","bun-host-1-4-2");
/** Compiler subprocess only: importing the public package is a generated typecheck, never runtime evaluation. */
function compileHost(install:string){
  const alias=JSON.parse(readFileSync(join(modules,hostTypes,"package.json"),"utf8")) as {name?:string;version?:string};
  expect(alias.name).toBe("bun-types");expect(alias.version).toBe("1.4.2");
  const wrapper=JSON.parse(readFileSync(join(modules,hostWrapper,"package.json"),"utf8")) as {name?:string;version?:string};
  expect(wrapper.name).toBe("@types/bun");expect(wrapper.version).toBe("1.4.2");
  const root=mkdtempSync(join(tmpdir(),"amem-strict-host-"));
  try{
    const project=join(root,"host"),home=join(root,"home"),temp=join(root,"tmp");
    mkdirSync(join(project,"node_modules","@staix"),{recursive:true,mode:0o700});mkdirSync(home,{mode:0o700});mkdirSync(temp,{mode:0o700});
    const localModules=join(project,"node_modules"),localTypes=join(localModules,"@types");mkdirSync(localTypes,{mode:0o700});
    symlinkSync(install,join(project,"node_modules","@staix","agent-mem"),"dir");
    symlinkSync(join(modules,hostTypes),join(localModules,"bun-types"),"dir");
    symlinkSync(join(modules,hostWrapper),join(localTypes,"bun"),"dir");
    symlinkSync(join(modules,"@types","node"),join(localTypes,"node"),"dir");
    if(existsSync(join(modules,"undici-types")))symlinkSync(join(modules,"undici-types"),join(localModules,"undici-types"),"dir");
    writeFileSync(join(project,"package.json"),JSON.stringify({name:"isolated-amem-strict-host",private:true,type:"module"})+"\n",{mode:0o600});
    writeFileSync(join(project,"entry.ts"),`import * as memory from "@staix/agent-mem";
export const publicStore = memory.MemoryStore;
// Witness the actual object-call overload, not the last signature of a possibly merged overloaded function.
function objectWriter() { return Bun.TOML.stringify({ setup_value: 1 }); }
const tomlCanBeUndefined: ReturnType<typeof objectWriter> = undefined;
void tomlCanBeUndefined;
`,{mode:0o600});
    writeFileSync(join(project,"tsconfig.json"),JSON.stringify({compilerOptions:{
      target:"ESNext",module:"Preserve",moduleResolution:"bundler",lib:["ESNext"],strict:true,noUncheckedIndexedAccess:true,noEmit:true,
      allowImportingTsExtensions:true,resolveJsonModule:true,skipLibCheck:true,
      // Fixture isolation only: dependencies resolve at the fake installed host, not the repo's newer dev types.
      preserveSymlinks:true,types:["bun"],typeRoots:[localTypes],
    },files:["entry.ts"]},null,2)+"\n",{mode:0o600});
    // No inherited Bun/Node preload, personal configuration or memory home enters the compiler process.
    const result=Bun.spawnSync([process.execPath,compiler,"--project",join(project,"tsconfig.json"),"--pretty","false","--locale","en"],{
      cwd:project,env:{PATH:process.env.PATH??"",HOME:home,AMEM_HOME:join(home,"memory"),AGENTHUB_HOME:join(home,"hub"),TMPDIR:temp,LANG:"C",LC_ALL:"C"},
      stdout:"pipe",stderr:"pipe",timeout:45_000,maxBuffer:256*1024,
    });
    return{exitCode:result.exitCode,signalCode:result.signalCode,output:result.stdout.toString()+result.stderr.toString()};
  }finally{rmSync(root,{recursive:true,force:true});}
}

test("published0.22.0 reproduces exactly the two setup TOML errors in an independent strict Bun1.4.2 host",()=>{
  const install=join(modules,"@staix","agent-mem-v0220"),pkg=JSON.parse(readFileSync(join(install,"package.json"),"utf8")) as {name?:string;version?:string};
  expect(pkg.name).toBe("@staix/agent-mem");expect(pkg.version).toBe("0.22.0");
  const result=compileHost(install);expect(result.signalCode,result.output).toBeFalsy();expect(result.exitCode,result.output).not.toBe(0);
  const codes=[...result.output.matchAll(/error TS(\d+):/g)].map(match=>match[1]);expect(codes,result.output).toEqual(["2322","2322"]);
  const lines=[...result.output.matchAll(/setup-toml\.ts\((\d+),\d+\): error TS2322:/g)].map(match=>Number(match[1])).sort((a,b)=>a-b);
  expect(lines,result.output).toEqual([40,258]);
  expect(result.output).toContain("Type 'string | undefined' is not assignable to type 'string'.");
  expect(result.output).not.toMatch(/entry\.ts\(\d+,\d+\): error/);
},60_000);

test("current shipped TypeScript compiles through the public package import in an independent strict Bun1.4.2 host",()=>{
  const result=compileHost(repository);expect(result.signalCode,result.output).toBeFalsy();expect(result.exitCode,result.output).toBe(0);
  expect(result.output).toBe("");
},60_000);
