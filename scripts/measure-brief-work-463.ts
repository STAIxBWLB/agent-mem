import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJSON, hashJSON } from '../src/memory/generation.ts';
import { machineId } from '../src/memory/machine.ts';
import { shardDir } from '../src/memory/shard.ts';
import { WorkListStore } from '../src/memory/work-lists.ts';
import { workBriefFile } from '../src/brief-work.ts';
import { processSignature } from '../src/memory/platform.ts';
import { createStandalonePolicy } from '../src/memory/policy.ts';
import { sessionStartBrief } from '../src/session-brief.ts';
const root=mkdtempSync(join(tmpdir(),'amem-463-')), base=join(root,'memory'), project='example/project', machine=machineId(base).id;
try {
 const dir=join(shardDir(base,project),'work','log'); mkdirSync(dir,{recursive:true,mode:0o700});
 const rows=Array.from({length:5000},(_,i)=>{const b={schema:'agent-mem.work-list/v1',project,machine,at:1700000000000+i,nonce:(i+1).toString(16).padStart(32,'0'),list:'project-delivery',fields:{task:`task-${String(i%25).padStart(3,'0')}`,status:i%3?'doing':'todo',note:`Review milestone ${i%25} and prepare handoff`},source:{source:'import',id:`work-item-${i}`,machine:'source-machine',at:1700000000000+i}};return {...b,id:hashJSON(b)};});
 writeFileSync(join(dir,`${machine}.jsonl`),rows.map(canonicalJSON).join('\n')+'\n',{mode:0o600});
 const store=new WorkListStore({base,project,policy:()=>true});
 await store.read(undefined,true); await store.publishBrief();
 const file=workBriefFile({base,project,machine}); const baseBytes=statSync(file).size;
 const sizes=[10,25,50,100,500,5000].map(n=>({operations:n,inputBytes:Buffer.byteLength(JSON.stringify(rows.slice(0,n))),estimatedSnapshotBytes:baseBytes+Buffer.byteLength(JSON.stringify(rows.slice(0,n)))+14}));
 const writes=[]; for(let i=0;i<15;i++){const start=performance.now(); await store.write('project-delivery',{task:'task-001',note:`updated checkpoint ${i}`});writes.push(performance.now()-start);}
 const scopedStore=new WorkListStore({base,project,policy:()=>true,briefPolicyOptions:()=>({piiPatterns:['work-item-42']})});
 const scopedWrites=[]; for(let i=0;i<15;i++){const start=performance.now();await scopedStore.write('project-delivery',{task:'task-001',note:`scoped checkpoint ${i}`});scopedWrites.push(performance.now()-start);} scopedStore.close();
 const extraReplay=[]; const narrow=createStandalonePolicy({piiPatterns:['work-item-42']}); for(let i=0;i<15;i++){const start=performance.now(); await store.read(undefined,true,row=>narrow.screenStandalone(row)); extraReplay.push(performance.now()-start);}
 const brief=[]; for(let i=0;i<15;i++){const start=performance.now();const value=await sessionStartBrief({cwd:root,base,project,nativeSession:{signature:processSignature(process.pid)!},timeRemaining:()=>2000}); brief.push({ms:performance.now()-start,coverage:value.coverage.work});}
 store.close(); console.log(JSON.stringify({fixture:'synthetic, 25 rotating items and source.id on every operation',rows:rows.length,logBytes:statSync(join(dir,`${machine}.jsonl`)).size,baseSnapshotBytes:baseBytes,sizes,writesMs:writes,scopedWritesMs:scopedWrites,extraReplayMs:extraReplay,nativeBriefMs:brief},null,2));
} finally {rmSync(root,{recursive:true,force:true});}
