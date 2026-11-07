import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, linkSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { hookCaptureScope, stageHookCapture } from "../src/hook-spool.ts";
import { normalizeCaptureFields } from "../src/memory/capture-input.ts";
import { accountWorkload, inspectWorkloadAccounting, workloadInvocation } from "../scripts/hook-drain-accounting.ts";

const row=(id:number)=>({agent:"claude",event:"PostToolUse",excerpt:`src/public.ts\nbudget public result ${id}`,tool:"Read",paths:["src/public.ts"]});
async function fixture(total:number,dbIds:number[],hookIds:number[],captureIds:number[]) {
  const f=hookFixture();await f.seed();const store=new CaptureStore({memoryDir:f.base,project:f.project,busyTimeoutMs:0});const captureDir=store.dir;
  for(const id of dbIds)store.append({...row(id),project:f.project});
  const previous=process.env.HOME;let scope:string|undefined;
  try {process.env.HOME=f.env.HOME;scope=hookCaptureScope(f.cwd,f.base);
    for(const id of hookIds)await stageHookCapture("PostToolUse",{tool_name:"Read",tool_input:{file_path:"src/public.ts"},tool_response:`budget public result ${id}`},{cwd:f.cwd,base:f.base});
  }finally{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;}
  const holder=new Database(join(captureDir,"capture.db"));
  try{holder.run("BEGIN IMMEDIATE");for(const id of captureIds)expect(store.append({...row(id),project:f.project})).toEqual({spooled:true});}
  finally{holder.run("ROLLBACK");holder.close();}
  const database=store.rows({limit:2000});store.close();expect(scope).toBeDefined();
  const options={expected:total,workload:new Map(Array.from({length:total},(_,i)=>[i+1,row(i+1)])),baselineRows:1,database,base:f.base,captureDir,cwd:f.cwd,project:f.project,scope:scope!,countedRetirements:0};
  return {f,options,inspect:()=>inspectWorkloadAccounting(options),spool:join(captureDir,"spool"),hooks:join(f.base,"hook-spool")};
}

test("exactly-once accounting rejects loss, every duplicate representation and retirements",()=>{
  expect(accountWorkload(3,[1],[2],[3],0).accountingComplete).toBe(true);
  for(const proof of [accountWorkload(3,[1],[2],[],0),accountWorkload(3,[1,1],[2],[3],0),accountWorkload(3,[1],[1,2],[3],0),
    accountWorkload(3,[1],[2],[2,3],0),accountWorkload(3,[1],[2],[3],1),accountWorkload(3,[1],[2],[4],0)])expect(proof.accountingComplete).toBe(false);
  expect(workloadInvocation({event:"PostToolUse",excerpt:"src/public.ts\nbudget public result 1\n"})).toBe(0);
});

test("55 accepted invocations are proved across actual DB, hook and multi-row capture publications without replay",async()=>{
  const state=await fixture(55,Array.from({length:40},(_,i)=>i+1),Array.from({length:11},(_,i)=>i+41),[52,53,54,55]);
  try {
    const names=readdirSync(state.spool).filter(name=>name.startsWith("spool-"));const bytes=names.map(name=>readFileSync(join(state.spool,name)));
    for(const name of names)rmSync(join(state.spool,name));const file=join(state.spool,"spool-abcd.jsonl.draining-abcd");writeFileSync(file,Buffer.concat(bytes),{mode:0o600});
    const db=join(state.options.captureDir,"capture.db"),before=readFileSync(db),stamp=statSync(db).mtimeMs,pending=readFileSync(file);
    expect(state.inspect()).toMatchObject({accountingComplete:true,databaseRows:40,hookPendingRows:11,capturePendingRows:4,duplicateItems:0,unaccountedItems:0});
    expect(readFileSync(db)).toEqual(before);expect(statSync(db).mtimeMs).toBe(stamp);expect(readFileSync(file)).toEqual(pending);
  }finally{state.f.close();}
});

test("acknowledged capture prefixes are not pending, but their suffix must be parseable and on a line boundary",async()=>{
  const state=await fixture(2,[1],[],[2]);
  try {
    const original=readdirSync(state.spool).find(name=>name.startsWith("spool-"))!,tail=readFileSync(join(state.spool,original));rmSync(join(state.spool,original));
    const prior=state.options.database.find(value=>workloadInvocation(value)===1)!;
    const prefix=Buffer.from(JSON.stringify({...normalizeCaptureFields({...row(1),at:prior.at}),project:state.f.project,nonce:"a".repeat(24)})+"\n");
    const file=join(state.spool,`spool-abcd.jsonl.offset-${prefix.length}.draining-abcd`);writeFileSync(file,Buffer.concat([prefix,tail]),{mode:0o600});
    expect(state.inspect()).toMatchObject({accountingComplete:true,databaseRows:1,capturePendingRows:1});
    renameSync(file,join(state.spool,"spool-abcd.jsonl.offset-1"));expect(()=>state.inspect()).toThrow("pending workload evidence");
  }finally{state.f.close();}
});

test("unreadable, unsafe, unknown, wrong-bound or duplicate pending input never becomes positive evidence",async()=>{
  for(const mutate of [
    (s:Awaited<ReturnType<typeof fixture>>)=>writeFileSync(join(s.spool,"spool-bad.jsonl"),"{",{mode:0o600}),
    (s:Awaited<ReturnType<typeof fixture>>)=>writeFileSync(join(s.spool,"spool-bad.jsonl"),"",{mode:0o600}),
    (s:Awaited<ReturnType<typeof fixture>>)=>{const name=readdirSync(s.spool).find(name=>name.startsWith("spool-"))!;symlinkSync(join(s.spool,name),join(s.spool,"spool-bad.jsonl"));},
    (s:Awaited<ReturnType<typeof fixture>>)=>{const name=readdirSync(s.spool).find(name=>name.startsWith("spool-"))!;chmodSync(join(s.spool,name),0o644);},
    (s:Awaited<ReturnType<typeof fixture>>)=>{const name=readdirSync(s.spool).find(name=>name.startsWith("spool-"))!;truncateSync(join(s.spool,name),256*1024+1);},
    (s:Awaited<ReturnType<typeof fixture>>)=>{const name=readdirSync(s.spool).find(name=>name.startsWith("spool-"))!;renameSync(join(s.spool,name),join(s.spool,"spool-abcd.jsonl.offset-0-skip"));},
    (s:Awaited<ReturnType<typeof fixture>>)=>{const name=readdirSync(s.hooks).find(name=>name.startsWith("hook-"))!;const file=join(s.hooks,name),value=JSON.parse(readFileSync(file,"utf8"));value.schema="unknown";writeFileSync(file,JSON.stringify(value));},
    (s:Awaited<ReturnType<typeof fixture>>)=>{s.options.scope="0".repeat(64);},
    (s:Awaited<ReturnType<typeof fixture>>)=>{s.options.workload.set(2,{...row(2),agent:"jcode"});},
  ]) {const state=await fixture(2,[],[1],[2]);try{mutate(state);expect(()=>state.inspect()).toThrow("pending workload evidence");}finally{state.f.close();}}
  const duplicate=await fixture(2,[1],[1],[2]);try{expect(duplicate.inspect().accountingComplete).toBe(false);expect(duplicate.inspect().duplicateItems).toBe(1);}finally{duplicate.f.close();}
});


test("capture pending accepts complete EOF JSON but rejects a torn multi-row tail and hardlinks",async()=>{
  const state=await fixture(1,[],[],[1]);
  try {
    const name=readdirSync(state.spool).find(name=>name.startsWith("spool-"))!,file=join(state.spool,name),data=readFileSync(file);
    writeFileSync(file,data.subarray(0,data.length-1));expect(state.inspect().accountingComplete).toBe(true);
    writeFileSync(file,Buffer.concat([data,Buffer.from("{\n")]));expect(()=>state.inspect()).toThrow("pending workload evidence");
    writeFileSync(file,data);linkSync(file,join(state.spool,"spool-abcd.jsonl"));expect(()=>state.inspect()).toThrow("pending workload evidence");
  }finally{state.f.close();}
});
test("an incomplete directory inventory is never a positive proof",async()=>{
  const state=await fixture(1,[1],[],[]);
  try {
    for(let index=0;index<513;index++)writeFileSync(join(state.spool,`spool-${index.toString(16)}.jsonl`),"{}",{mode:0o600});
    expect(()=>state.inspect()).toThrow("pending workload evidence");
  }finally{state.f.close();}
});
