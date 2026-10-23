import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memoryGitEnv, memoryGitSync, realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";

const drops: string[]=[];
afterEach(()=>{for(const root of drops.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=realPath(mkdtempSync(join(tmpdir(),"amem-hook-project-strict-")));drops.push(root);return root;}
function git(cwd:string,args:string[]){const result=memoryGitSync(["-C",cwd,...args],{encoding:"utf8",env:memoryGitEnv(process.env,{repositoryIsolation:true})});expect(result.status,result.stderr).toBe(0);}
function strict(cwd:string){return memoryProjectKey(cwd,{repositoryIsolation:true,strictGitErrors:true} as Parameters<typeof memoryProjectKey>[1]);}

test("strict hook identity refuses unsupported repository formats instead of rebinding to a local key",()=>{
  const root=fixture(),repo=join(root,"repo");mkdirSync(repo);git(repo,["init","-q"]);git(repo,["remote","add","origin","https://github.com/fixture/original"]);
  expect(strict(repo)).toBe("github.com/fixture/original");
  appendFileSync(join(repo,".git","config"),"\n[core]\nrepositoryformatversion = 999\n");
  expect(()=>strict(repo)).toThrow("Git project identity unavailable");
  expect(memoryProjectKey(repo,{repositoryIsolation:true})).toMatch(/@[0-9a-f]{8}$/);
});

test("strict hook identity refuses fatal global config errors only when a physical Git marker exists",()=>{
  const root=fixture(),repo=join(root,"repo"),plain=join(root,"plain"),bad=join(root,"bad-global");mkdirSync(repo);mkdirSync(plain);git(repo,["init","-q"]);
  writeFileSync(bad,"[broken section\n");const previous=process.env.GIT_CONFIG_GLOBAL;
  try{process.env.GIT_CONFIG_GLOBAL=bad;
    expect(()=>strict(repo)).toThrow("Git project identity unavailable");
    expect(strict(plain)).toBe(memoryProjectKey(plain,{repositoryIsolation:true}));
  }finally{if(previous===undefined)delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=previous;}
});

test("strict identity retains supported remote, no-remote, nested and bare project keys",()=>{
  const root=fixture(),repo=join(root,"repo"),nested=join(repo,"src","deep"),plain=join(root,"plain"),bare=join(root,"bare.git");mkdirSync(nested,{recursive:true});mkdirSync(plain);mkdirSync(bare);git(repo,["init","-q"]);git(bare,["init","-q","--bare"]);
  const local=memoryProjectKey(repo,{repositoryIsolation:true});expect(strict(repo)).toBe(local);expect(strict(nested)).toBe(local);
  expect(strict(plain)).toBe(memoryProjectKey(plain,{repositoryIsolation:true}));expect(strict(bare)).toBe(memoryProjectKey(bare,{repositoryIsolation:true}));
  git(repo,["remote","add","origin","git@github.com:Fixture/Native.git"]);expect(strict(nested)).toBe("github.com/fixture/native");
  appendFileSync(join(bare,"config"),"\n[core]\nrepositoryformatversion = 999\n");expect(()=>strict(bare)).toThrow("Git project identity unavailable");
});
