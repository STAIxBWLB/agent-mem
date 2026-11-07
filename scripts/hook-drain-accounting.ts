/** Measurement-only conservation proof. No replay, index rebuild, data writes or network. */
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { hookSpoolReplayInternals as hooks } from "../src/hook-spool.ts";
import { normalizeCaptureFields } from "../src/memory/capture-input.ts";

export interface WorkloadRow { event: string; excerpt: string; project?: string; at?: string; agent?: string }
export interface CaptureEvidenceRow extends WorkloadRow {
  at:string;project:string;agent:string;tool:string|null;paths:string[];status:string|null;bytes:number;
  session?:string;subagent?:true;spoolId:string|null;
}
export interface DrainAccounting {
  expectedInvocations: number; databaseRows: number; hookPendingRows: number; capturePendingRows: number;
  unreadableItems: number; duplicateItems: number; unaccountedItems: number; countedRetirements: number;
  accountingComplete: boolean; missingInvocations: number[]; accountedInvocations:number; acknowledgedPendingRows:number; pendingAliases:number;
}
export function workloadInvocation(row: WorkloadRow): number {
  const prefix = row.event === "PostToolUse" || row.event === "PostToolUseFailure" ? "src/public.ts\n" : row.event === "SessionStart" ? "" : undefined;
  if (prefix === undefined || !row.excerpt.startsWith(prefix)) return 0;
  const text = row.excerpt.slice(prefix.length), match = /^budget public result ([1-9][0-9]*)$/.exec(text);
  const id = match && match[0] === text ? Number(match[1]) : 0;
  return Number.isSafeInteger(id) ? id : 0;
}
export function accountWorkload(expected: number, database: readonly number[], hookPending: readonly number[], capturePending: readonly number[], countedRetirements: number): DrainAccounting {
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > 2000 || !Number.isSafeInteger(countedRetirements) || countedRetirements < 0)
    throw Error("workload accounting bounds are invalid; inspect the fixed measurement fixture");
  const db=new Map<number,number>(),pending=new Map<number,number>();let unreadableItems=0;
  const count=(ids:readonly number[],target:Map<number,number>)=>{for(const id of ids){
    if(!Number.isSafeInteger(id)||id<1||id>expected){unreadableItems++;continue;}
    target.set(id,(target.get(id)??0)+1);
  }};
  count(database,db);count([...hookPending,...capturePending],pending);
  const all=new Set([...db.keys(),...pending.keys()]);
  const missingInvocations=Array.from({length:expected},(_,i)=>i+1).filter(id=>!all.has(id));
  const duplicateItems=[...db.values(),...pending.values()].reduce((sum,value)=>sum+Math.max(0,value-1),0);
  const acknowledgedPendingRows=[...pending.keys()].filter(id=>db.has(id)).length;
  return {expectedInvocations:expected,databaseRows:database.length,hookPendingRows:hookPending.length,capturePendingRows:capturePending.length,
    unreadableItems,duplicateItems,unaccountedItems:missingInvocations.length,countedRetirements,
    accountingComplete:unreadableItems===0&&duplicateItems===0&&missingInvocations.length===0&&countedRetirements===0,
    missingInvocations,accountedInvocations:all.size,acknowledgedPendingRows,pendingAliases:0};
}

const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.nlink===b.nlink&&a.uid===b.uid&&a.mode===b.mode&&a.ctimeMs===b.ctimeMs;
function fail():never {throw Error("pending workload evidence is unreadable, changed, unsupported or outside its bound; retain the fixture and inspect hook-drain accounting");}
const privateFile=(s:Stats)=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid?.()&&(s.mode&0o077)===0;
const segment=/^spool-[0-9a-f-]+\.jsonl(?:\.offset-(\d+)(-skip)?)?(?:\.draining-[0-9a-f]+)?$/;
/** ponytail: 512 entries, 8 MiB and 2000 rows bound this fixed fixture's read-only proof.
 * A larger fixture needs a reviewed streamed snapshot; an exhausted bound is always a hard failure. */
/** Same producer field order as CaptureStore's normalized row, with project after at and nonce added last.
 * Fingerprints compare full normalized content; the separate receipt is what the DB's unique spool index acknowledges. */
function captureBody(row: Omit<CaptureEvidenceRow,"spoolId">) {
  if(typeof row.at!=="string"||typeof row.project!=="string"||typeof row.agent!=="string"||typeof row.event!=="string"
    ||!Array.isArray(row.paths)||row.paths.some(value=>typeof value!=="string")||typeof row.excerpt!=="string")fail();
  const shaped=normalizeCaptureFields({at:row.at,agent:row.agent,event:row.event,paths:row.paths,excerpt:row.excerpt,
    ...(row.tool===null?{}:{tool:row.tool}),...(row.status===null?{}:{status:row.status}),...(row.session===undefined?{}:{session:row.session}),...(row.subagent?{subagent:true}:{})});
  for(const [key,value] of Object.entries(shaped))if(JSON.stringify((row as unknown as Record<string,unknown>)[key])!==JSON.stringify(value))fail();
  if(Object.keys(row).some(key=>["session","subagent"].includes(key)&&!(key in shaped)))fail();
  const {at,agent,event,tool,paths,status,excerpt,bytes,session,subagent}=shaped;
  return {at,project:row.project,agent,event,tool,paths,status,excerpt,bytes,...(session?{session}:{}),...(subagent?{subagent:true as const}:{})};
}
/** Read one bounded SQLite snapshot, including the receipt column omitted by CaptureStore.rows().
 * SQLite may update SHM read marks; the connection cannot replay, heal a hot journal or write row/schema data. */
export function readWorkloadDatabase(captureDir:string):CaptureEvidenceRow[] {
  const file=join(captureDir,"capture.db"),fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let db:Database|undefined;
  try {
    const before=fstatSync(fd);if(!privateFile(before))fail();db=new Database(file,{readonly:true});db.run("PRAGMA busy_timeout=2000");
    const rows=db.transaction(()=>{
      const count=db!.query("SELECT COUNT(*) AS n FROM (SELECT 1 FROM rows LIMIT 2001)").get() as {n:number};if(count.n>2000)fail();
      const size=db!.query("SELECT COALESCE(SUM(length(CAST(at AS BLOB))+length(CAST(project AS BLOB))+length(CAST(agent AS BLOB))+length(CAST(event AS BLOB))+length(CAST(paths AS BLOB))+length(CAST(excerpt AS BLOB))+length(COALESCE(tool,''))+length(COALESCE(status,''))+length(COALESCE(spool_id,''))+length(COALESCE(session,''))),0) AS n FROM rows").get() as {n:number};if(size.n>8*1024*1024)fail();
      return db!.query("SELECT at,project,agent,event,tool,paths,status,excerpt,bytes,spool_id,session,subagent FROM rows ORDER BY id LIMIT 2001").all() as {at:string;project:string;agent:string;event:string;tool:string|null;paths:string;status:string|null;excerpt:string;bytes:number;spool_id:string|null;session:string|null;subagent:number|null}[];
    }).deferred();
    if(!same(before,lstatSync(file))||!same(before,fstatSync(fd)))fail();
    return rows.map(row=>{if(row.spool_id!==null&&!/^[a-f0-9]{64}$/.test(row.spool_id)||row.subagent!==null&&row.subagent!==0&&row.subagent!==1)fail();
      const result={at:row.at,project:row.project,agent:row.agent,event:row.event,tool:row.tool,paths:JSON.parse(row.paths) as string[],status:row.status,excerpt:row.excerpt,bytes:row.bytes,spoolId:row.spool_id,
        ...(row.session===null?{}:{session:row.session}),...(row.subagent===1?{subagent:true as const}:{})};captureBody(result);return result;});
  } catch {return fail();}finally{db?.close();closeSync(fd);}
}
interface InspectionOptions { expected:number;workload:ReadonlyMap<number,WorkloadRow>;baselineRows:number;database:readonly CaptureEvidenceRow[];base:string;captureDir:string;cwd:string;project:string;scope:string;countedRetirements:number }
export type WorkloadInspection = DrainAccounting & { pendingRecords: {id:number;at:string}[] };
export function inspectWorkloadAccounting(options:InspectionOptions):WorkloadInspection {
  try {return inspect(options);}catch {return fail();}
}
function inspect(options:InspectionOptions):WorkloadInspection {
  const database:number[]=[],hookPending:number[]=[],capturePending:number[]=[],pendingRecords:{id:number;at:string}[]=[];
  const dbIdentities=new Map<number,{fingerprint:string;receipt:string|null}[]>();
  const candidates:{id:number;at:string;kind:"hook"|"capture";key:string;claim:boolean;fingerprint:string;receipt:string}[]=[];
  let entries=0,bytes=0,lines=0;const dirs:{dir:string;stamp:Stats;names:string[]}[]=[],missingDirs:string[]=[],files:{file:string;stamp:Stats}[]=[];
  const inventory=(dir:string)=>{
    const stamp=lstatSync(dir,{throwIfNoEntry:false});if(!stamp){missingDirs.push(dir);return [];}
    if(!stamp.isDirectory()||stamp.isSymbolicLink()||stamp.uid!==process.getuid?.())fail();
    const scan=opendirSync(dir),names:string[]=[];
    try {for(let row=scan.readSync();row;row=scan.readSync()){if(++entries>512)fail();names.push(row.name);}}finally{scan.close();}
    names.sort();dirs.push({dir,stamp,names});return names;
  };
  const charge=(size:number,limit:number)=>{if(!Number.isSafeInteger(size)||size<0||size>limit||(bytes+=size)>8*1024*1024)fail();};
  const read=(file:string,limit:number)=>{
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {const before=fstatSync(fd);if(!privateFile(before))fail();charge(before.size,limit);
      files.push({file,stamp:before});const data=Buffer.alloc(before.size);if(readSync(fd,data,0,data.length,0)!==data.length||!same(before,fstatSync(fd))||!same(before,lstatSync(file)))fail();return data;
    }finally{closeSync(fd);}
  };
  const identify=(row:WorkloadRow)=>{const id=workloadInvocation(row),expected=options.workload.get(id);
    if(!id||id>options.expected||!expected||row.event!==expected.event||row.excerpt!==expected.excerpt||row.agent!==expected.agent)fail();return id;};
  if(options.database.length>2000||options.workload.size!==options.expected||!Number.isSafeInteger(options.baselineRows)||options.baselineRows<0)fail();
  for(let id=1;id<=options.expected;id++)if(!options.workload.has(id))fail();
  let baselineRows=0;
  for(const row of options.database){if(row.project!==options.project)fail();const id=workloadInvocation(row);if(id){database.push(identify(row));const body=captureBody(row);const identities=dbIdentities.get(id)??[];
    identities.push({fingerprint:hash(JSON.stringify(body)),receipt:row.spoolId});dbIdentities.set(id,identities);}else {if(row.excerpt.includes("budget public result"))fail();baselineRows++;}}
  if(baselineRows!==options.baselineRows)fail();
  const scope=options.scope;if(!/^[a-f0-9]{64}$/.test(scope))fail();
  for(const dir of [join(options.base,"hook-spool"),join(options.base,"hook-spool",".capacity")])for(const name of inventory(dir)){
    if([".capacity",".writing",".maintenance",".quarantine"].includes(name))continue;
    const match=hooks.namePattern.exec(name);if(!match)fail();
    const file=hooks.openOwned(join(dir,name));
    try {
      if(!privateFile(file.initial))fail();files.push({file:file.file,stamp:file.initial});charge(file.initial.size,hooks.RECORD_BYTES);
      const decoded=hooks.decoded(file);if(!decoded||decoded.unknown||!hooks.owns(file)||!same(file.initial,lstatSync(file.file)))fail();
      const row=decoded.value;
      if(row.cwd!==options.cwd||hash(row.cwd)!==match![2]||row.scope!==scope||row.scope!==match![3]||row.nonce!==match![4])fail();
      const id=identify(row.capture),body=captureBody({...row.capture,project:options.project});
      candidates.push({id,at:body.at,kind:"hook",key:`hook:${dir}:${match![1]}`,claim:name.includes(".draining-"),
        fingerprint:hash(JSON.stringify(body)),receipt:hash(JSON.stringify({...body,nonce:hash(decoded.bytes)}))});if(++lines>2000)fail();
    }finally{closeSync(file.fd);}
  }
  const captureFiles=inventory(join(options.captureDir,"spool")).filter(name=>name!==".writing");
  for(const name of captureFiles){
    const match=segment.exec(name);if(!match||match[2])fail();
    const data=read(join(options.captureDir,"spool",name),256*1024),offset=Number(match![1]??0);
    if(!data.length||!Number.isSafeInteger(offset)||offset>data.length||offset>0&&data[offset-1]!==10)fail();
    let start=offset,parsed=0;
    while(start<data.length){const lineOffset=start,end=data.indexOf(10,start),stop=end<0?data.length:end;const line=data.subarray(start,stop);start=stop+(end<0?0:1);
      if(!line.length)continue;if(++lines>2000)fail();
      const text=line.toString("utf8");if(!Buffer.from(text,"utf8").equals(line))fail();
      const row=JSON.parse(text) as Record<string,unknown>;
      if(!row||typeof row!=="object"||Array.isArray(row)||row.project!==options.project||typeof row.nonce!=="string"||!/^(?:[a-f0-9]{24}|[a-f0-9]{64})$/.test(row.nonce))fail();
      const shaped=normalizeCaptureFields(row as unknown as Parameters<typeof normalizeCaptureFields>[0]);
      const expected={...shaped,project:options.project,nonce:row.nonce};
      if(Object.keys(row).length!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>JSON.stringify(row[key])!==JSON.stringify(value)))fail();
      const id=identify(row as unknown as WorkloadRow);parsed++;
      const body=captureBody(row as unknown as CaptureEvidenceRow);
      candidates.push({id,at:body.at,kind:"capture",key:`capture:${options.captureDir}:${name.split(".offset-")[0]!.split(".draining-")[0]}:${lineOffset}`,
        claim:name.includes(".draining-"),fingerprint:hash(JSON.stringify(body)),receipt:hash(line)});
    }
    if(!parsed&&offset<data.length)fail();
  }
  for(const snapshot of files)if(!same(snapshot.stamp,lstatSync(snapshot.file)))fail();
  for(const dir of missingDirs)if(lstatSync(dir,{throwIfNoEntry:false}))fail();
  for(const name of ["spool.jsonl","spool.jsonl.draining"])if(lstatSync(join(options.captureDir,name),{throwIfNoEntry:false}))fail();
  for(const snapshot of dirs){
    const now=lstatSync(snapshot.dir);if(!same(snapshot.stamp,now))fail();
    const scan=opendirSync(snapshot.dir),names:string[]=[];try{for(let row=scan.readSync();row;row=scan.readSync()){if(names.length>=512)fail();names.push(row.name);}}finally{scan.close();}
    if(JSON.stringify(names.sort())!==JSON.stringify(snapshot.names))fail();
  }
  let pendingAliases=0,identityConflicts=0;
  const publications=new Map<string,typeof candidates>();
  for(const candidate of candidates){const group=publications.get(candidate.key)??[];group.push(candidate);publications.set(candidate.key,group);}
  for(const group of publications.values()){
    const first=group[0]!;
    const alias=group.length===2&&group[0]!.claim!==group[1]!.claim&&group.every(row=>row.id===first.id&&row.fingerprint===first.fingerprint&&row.receipt===first.receipt);
    const logical=group.length===1||alias?[first]:group;
    if(alias)pendingAliases++;
    for(const row of logical){(row.kind==="hook"?hookPending:capturePending).push(row.id);pendingRecords.push({id:row.id,at:row.at});
      const db=dbIdentities.get(row.id);
      if(db?.length===1&&(db[0]!.fingerprint!==row.fingerprint||db[0]!.receipt!==row.receipt))identityConflicts++;
    }
  }
  const proof=accountWorkload(options.expected,database,hookPending,capturePending,options.countedRetirements);
  return {...proof,duplicateItems:proof.duplicateItems+identityConflicts,accountingComplete:proof.accountingComplete&&identityConflicts===0,pendingAliases,pendingRecords};
}
