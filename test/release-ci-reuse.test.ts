import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { proveRelease, frozenTag, githubReader } from "../scripts/release-ci-reuse.mjs";

const commit="a".repeat(40),tree="b".repeat(40),other="c".repeat(40),tagObject="d".repeat(40),repository="acme/memory";
const input={repository,commit};
const run=(extra:Record<string,unknown>={})=>({id:42,workflow_id:9,path:".github/workflows/check.yml",repository:{full_name:repository},head_repository:{full_name:repository},head_branch:"main",event:"push",head_sha:other,status:"completed",conclusion:"success",run_attempt:1,...extra});
const jobs=()=>["check (ubuntu-latest)","check (macos-latest)"].map((name,index)=>({id:index+1,run_id:42,name,status:"completed",conclusion:"success"}));
function fixture(options:{runs?:ReturnType<typeof run>[];jobRows?:ReturnType<typeof jobs>;otherTree?:string;active?:boolean;never?:boolean;offMain?:boolean;moveTag?:boolean;rerun?:boolean}={}){
  let time=0,slept=0,tagReads=0,runReads=0;const paths:string[]=[];
  const api=async(path:string):Promise<unknown>=>{
    paths.push(path);
    if(path.startsWith("git/commits/")){const sha=path.slice("git/commits/".length);return{sha,tree:{sha:sha===other?options.otherTree??tree:tree}};}
    if(path==="git/ref/heads/main")return{object:{type:"commit",sha:other}};
    if(path.startsWith("compare/"))return{base_commit:{sha:commit},merge_base_commit:{sha:options.offMain?other:commit},status:options.offMain?"diverged":"ahead"};
    if(path.startsWith("git/ref/tags/")){tagReads++;return{object:{type:"tag",sha:options.moveTag&&tagReads>1?other:tagObject}};}
    if(path.startsWith("git/tags/"))return{sha:tagObject,object:{type:"commit",sha:commit}};
    if(path==="actions/workflows/check.yml")return{id:9,path:".github/workflows/check.yml"};
    const current=options.active&&(options.never||slept===0)?run({status:"in_progress",conclusion:null}):run();
    if(path.startsWith("actions/workflows/check.yml/runs?")){const rows=options.runs??[current];return{total_count:rows.length,workflow_runs:rows};}
    if(path==="actions/runs/42"){runReads++;return options.rerun&&runReads>1?run({run_attempt:2}):(options.runs?.[0]??current);}
    if(path.startsWith("actions/runs/42/jobs?")){const rows=options.jobRows??jobs();return{total_count:rows.length,jobs:rows};}
    throw Error("unexpected test route "+path);
  };
  return{api,paths,clock:{now:()=>time,sleep:async(ms:number)=>{time+=ms;slept++;},waitMs:100,pollMs:10},sleepCount:()=>slept};
}
test("release reuses a successful main check for an identical whole tree, even at a different commit",async()=>{
  const f=fixture(),proof=await proveRelease(f.api,input,f.clock);
  expect(proof).toMatchObject({commit,tree,runId:42,runCommit:other,runAttempt:1});expect(f.sleepCount()).toBe(0);
  expect(f.paths.filter(path=>path===`git/commits/${other}`)).toHaveLength(1);
});
test("matching active check is awaited under one fixed deadline",async()=>{
  const f=fixture({active:true});expect((await proveRelease(f.api,input,f.clock)).runId).toBe(42);expect(f.sleepCount()).toBe(1);
  const stuck=fixture({active:true,never:true});await expect(proveRelease(stuck.api,input,stuck.clock)).rejects.toThrow("wait deadline");
});
test("different tree, missing/failed/ambiguous OS gate and foreign run never become release proof",async()=>{
  const candidates=[fixture({runs:[]}),fixture({otherTree:other}),fixture({jobRows:jobs().slice(0,1)}),
    fixture({jobRows:[...jobs(),{...jobs()[0]!,id:3}]}),fixture({jobRows:jobs().map(job=>({...job,conclusion:"failure"}))}),
    ...[{head_repository:{full_name:"fork/memory"}},{repository:{full_name:"fork/memory"}},{event:"pull_request"},{head_branch:"feature"},{workflow_id:10},{conclusion:"failure"}].map(extra=>fixture({runs:[run(extra)]}))];
  for(const f of candidates)await expect(proveRelease(f.api,input,f.clock)).rejects.toThrow("Push the release tree to main, or dispatch check on the tag commit");
});
test("unknown/malformed/truncated job evidence and API errors fail closed with a remedy",async()=>{
  for(const broken of ["actions/workflows/check.yml","actions/runs/42/jobs?","git/commits/"]){
    const f=fixture();const api=async(path:string)=>path.startsWith(broken)?{total_count:101,jobs:[]}:f.api(path);
    await expect(proveRelease(api,input,f.clock)).rejects.toThrow("retry the release");
  }
  const f=fixture();await expect(proveRelease(async()=>{throw Error("PRIVATE_PROVIDER_ERROR");},input,f.clock)).rejects.toThrow("GitHub CI evidence could not be read");
  await expect(proveRelease(f.api,input,{...f.clock,waitMs:0})).rejects.toThrow("deadline");
});
test("rerun during job inspection or a moving tag is refused",async()=>{
  const changed=fixture({rerun:true});await expect(proveRelease(changed.api,input,changed.clock)).rejects.toThrow("rerun or changed");
  const moved=fixture({moveTag:true});await expect(proveRelease(moved.api,{...input,tag:"v1.0.0"},moved.clock)).rejects.toThrow("tag object moved");
  const f=fixture();await expect(frozenTag(f.api,"v1.0.0",commit,other)).rejects.toThrow("tag object moved");
});
test("annotated tag and exact tag-dispatched check still require main ancestry and both OS gates",async()=>{
  const tagged=run({head_sha:commit,head_branch:"v1.0.0",event:"workflow_dispatch"}),f=fixture({runs:[tagged]});
  expect(await proveRelease(f.api,{...input,tag:"v1.0.0"},f.clock)).toMatchObject({tagObject,commit,runId:42});
  const off=fixture({offMain:true});await expect(proveRelease(off.api,input,off.clock)).rejects.toThrow("not on main");
  const wrong=fixture({runs:[run({head_sha:other,head_branch:"v1.0.0",event:"workflow_dispatch"})]});
  await expect(proveRelease(wrong.api,{...input,tag:"v1.0.0"},wrong.clock)).rejects.toThrow("No successful identical-tree");
});
test("read adapter has fixed GitHub origin, refuses large/error/malformed bodies and does not echo credentials",async()=>{
  const fetcher=async(url:unknown,init?:RequestInit)=>{expect(String(url)).toBe("https://api.github.com/repos/acme/memory/git/ref/heads/main");expect(init?.headers).toMatchObject({authorization:"Bearer TEST_ONLY_TOKEN"});return new Response('{"ok":true}');};
  expect(await githubReader(repository,"TEST_ONLY_TOKEN",{fetcher:fetcher as typeof fetch})("git/ref/heads/main")).toEqual({ok:true});
  for(const response of [new Response("PRIVATE_PROVIDER_ERROR",{status:403}),new Response("{broken"),new Response("x".repeat(2*1024*1024+1))]){
    const read=githubReader(repository,"TEST_ONLY_TOKEN",{fetcher:(async()=>response) as typeof fetch});
    await expect(read("git/ref/heads/main")).rejects.toThrow("retry the release");
  }
  expect(()=>githubReader("../memory","TEST_ONLY_TOKEN")).toThrow("read access");
});
test("workflow dispatch cannot reach publication and release checkouts are pinned",()=>{
  const root=join(import.meta.dir,".."),workflow=readFileSync(join(root,".github/workflows/release.yml"),"utf8");
  expect(workflow).not.toContain("--shard=");expect(workflow).toContain("workflow_dispatch:");expect(workflow).toContain("cancel-in-progress: false");
  for(const name of ["gate","publish","release-notes"]){const block=workflow.split(`  ${name}:`)[1]!.split(/\n  [a-z][a-z-]*:/)[0]!;expect(block).toContain("if: github.event_name == 'push'");}
  expect(workflow).toContain("ref: ${{ needs.reuse.outputs.commit }}");expect(workflow).toContain("--verify-tag-only");
  expect(workflow).toContain("npm pack --dry-run");expect(workflow).toContain("id-token: write");
  const check=readFileSync(join(root,".github/workflows/check.yml"),"utf8");expect(check).not.toContain("fetch-depth: 0");expect(check).toContain("--depth=1 origin 6d557ad");
});
