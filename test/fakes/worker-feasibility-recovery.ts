import { createHash } from "node:crypto";
import { constants, existsSync, lstatSync, openSync, closeSync, readSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { processGroupIdAsync, processGroupLiveness } from "../../src/memory/platform.ts";
import type { hookFixture } from "./hooks-fixture.ts";
export type FeasibilityState = "cold" | "warm" | "wal-recovery" | "partial-recovery";

export async function observeOwnedGone(pids: readonly number[], windowEndMs: number) {
  const sample = () => [...new Set(pids)].map(pid => {
    if(!Number.isSafeInteger(pid)||pid<=0)return {pid,pidGone:false,groupGone:false};
    let pidGone = false;
    try { process.kill(pid,0); } catch(error) { pidGone = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    return { pid, pidGone, groupGone: processGroupLiveness(pid) === "gone" };
  });
  let rows=sample();
  while(rows.some(row=>!row.pidGone||!row.groupGone)&&Date.now()<windowEndMs){await Bun.sleep(Math.min(20,Math.max(1,windowEndMs-Date.now())));rows=sample();}
  return { gone: rows.every(row=>row.pidGone&&row.groupGone), rows };
}
function ownedFile(file:string,root:string) {
  if(!resolve(file).startsWith(resolve(root)+sep))throw Error("Recovery path is outside the owned fixture; retain this sample and inspect its preparation");
  const stat=lstatSync(file,{throwIfNoEntry:false});
  if(stat&&(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||stat.nlink!==1))throw Error("Recovery file ownership is unavailable; retain the fixture and stop this schedule");
  return stat;
}
function fileFact(file:string,root:string) {
  const stat=ownedFile(file,root);if(!stat)return {exists:false,size:0,sha256:null};
  if(stat.size>32*1024*1024)throw Error("Recovery fixture exceeds its byte bound; retain this sample and inspect preparation");
  return {exists:true,size:stat.size,sha256:createHash("sha256").update(readFileSync(file)).digest("hex")};
}
export async function prepareWorkerFeasibilityRecovery(f:ReturnType<typeof hookFixture>,state:FeasibilityState,out:string) {
  const {CaptureStore}=await import("../../src/memory/capture.ts");
  const locator=new CaptureStore({memoryDir:f.base,project:f.project,cwd:f.cwd});const dir=locator.dir;locator.close();
  const database=join(dir,"capture.db");
  if(state==="cold"||state==="partial-recovery")for(const suffix of ["","-wal","-shm"]){const file=database+suffix;if(ownedFile(file,f.root))unlinkSync(file);}
  if(state==="cold"||state==="warm")return {safe:true,evidence:{stateCode:state==="cold"?1:2,databaseExists:existsSync(database),legacyGlobalMigrationProfiled:false},captureDir:dir};
  const ready=join(out,"preparation-ready.json"),options={base:f.base,cwd:f.cwd,project:f.project,ready,state};
  const child=Bun.spawn([process.execPath,"--smol",import.meta.path,"--prepare",JSON.stringify(options)],{cwd:f.cwd,env:f.env,detached:true,stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  let exited=false;const exit=child.exited.then(code=>{exited=true;return code;});
  const end=Date.now()+3000;
  while(!existsSync(ready)&&!exited&&Date.now()<end)await Bun.sleep(10);
  let receipt:Record<string,unknown>|undefined;
  if(existsSync(ready)&&ownedFile(ready,out)!.size<=16384)try{receipt=JSON.parse(readFileSync(ready,"utf8"));}catch{/* Missing readiness remains unavailable. */}
  const group=await processGroupIdAsync(child.pid);
  if(!receipt||receipt.pid!==child.pid||group!==child.pid||exited){
    // Direct live child handle is ours; never signal a group whose identity was not verified.
    if(!exited)child.kill("SIGKILL");
    await Promise.race([exit,Bun.sleep(2000)]);
    if(exited)writeFileSync(join(out,"preparation.stderr.log"),await new Response(child.stderr).text(),{mode:0o600});
    return {safe:false,evidence:{stateCode:state==="wal-recovery"?3:4,prepPid:child.pid,prepGroup:group??null,ready:false,legacyGlobalMigrationProfiled:false},captureDir:dir};
  }
  process.kill(-child.pid,"SIGKILL");
  const prepExitWindowEnd=Date.now()+2000;
  const code=await Promise.race([exit,Bun.sleep(2000).then(()=>null)]);
  const gone=await observeOwnedGone([child.pid],prepExitWindowEnd);
  if(exited)writeFileSync(join(out,"preparation.stderr.log"),await new Response(child.stderr).text(),{mode:0o600});
  if(code===null||!gone.gone||child.signalCode!=="SIGKILL")return {safe:false,evidence:{stateCode:state==="wal-recovery"?3:4,prepPid:child.pid,prepGroup:group??null,ready:true,prepReaped:code!==null,prepGone:gone.gone,prepSigkill:child.signalCode==="SIGKILL",legacyGlobalMigrationProfiled:false},captureDir:dir};
  // No SQLite open/recovery here: validate raw WAL header and segment metadata only.
  const wal=database+"-wal",walFact=fileFact(wal,f.root),dbFact=fileFact(database,f.root),shmBefore=fileFact(database+"-shm",f.root);
  let walHeaderValid=false;
  if(walFact.exists&&walFact.size>32){const fd=openSync(wal,constants.O_RDONLY|constants.O_NOFOLLOW);try{const head=Buffer.alloc(32);walHeaderValid=readSync(fd,head,0,32,0)===32&&[0x377f0682,0x377f0683].includes(head.readUInt32BE(0));}finally{closeSync(fd);}}
  const spool=join(dir,"spool");const segments=existsSync(spool)?readdirSync(spool).filter(name=>/^spool-[0-9a-f-]+\.jsonl(?:\.offset-\d+(?:-skip)?)?(?:\.draining-[0-9a-f]+)?$/.test(name)):[];
  const spoolRegular=segments.every(name=>!!ownedFile(join(spool,name),f.root));
  // After positive child exit/gone only, remove SHM to require native WAL-index reconstruction; never touch WAL/DB.
  if(ownedFile(database+"-shm",f.root))unlinkSync(database+"-shm");
  const safe=walHeaderValid&&spoolRegular&&(state==="wal-recovery"?segments.length===32&&receipt.spooled===32:receipt.rowsTable===1&&receipt.briefIndex===0&&receipt.ftsTable===0);
  return {safe,evidence:{stateCode:state==="wal-recovery"?3:4,prepPid:child.pid,prepGroup:group??null,ready:true,prepReaped:true,prepGone:true,prepSigkill:true,walHeaderValid,wal:walFact,database:dbFact,shmBefore,shmRemoved:shmBefore.exists,spoolSegments:segments.length,spoolRegular,rowsTable:receipt.rowsTable,briefIndex:receipt.briefIndex,ftsTable:receipt.ftsTable,journalWal:receipt.journalWal,synchronous:receipt.synchronous,legacyGlobalMigrationProfiled:false},captureDir:dir};
}

async function prepareChild(raw:string) {
  const o=JSON.parse(raw) as {base:string;cwd:string;project:string;ready:string;state:FeasibilityState};
  if(!["wal-recovery","partial-recovery"].includes(o.state))throw Error("Recovery child mode is invalid; retain its fixture and inspect the driver");
  const snapshot=(db:import("bun:sqlite").Database,spooled:number)=>({pid:process.pid,spooled,rowsTable:Number(!!db.query("SELECT name FROM sqlite_master WHERE name='rows'").get()),briefIndex:Number(!!db.query("SELECT name FROM sqlite_master WHERE name='rows_brief_summaries_v1'").get()),ftsTable:Number(!!db.query("SELECT name FROM sqlite_master WHERE name='mcp_fts'").get()),journalWal:Object.values(db.query("PRAGMA journal_mode").get() as object)[0]==="wal",synchronous:Number(Object.values(db.query("PRAGMA synchronous").get() as object)[0])});
  if(o.state==="partial-recovery"){
    (globalThis as unknown as Record<string,unknown>).__workerFeasibilityPause=(db:import("bun:sqlite").Database)=>{Object.defineProperty(globalThis,"__workerFeasibilityPinnedDb",{value:db});writeFileSync(o.ready,JSON.stringify(snapshot(db,0))+"\n",{flag:"wx",mode:0o600});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
    Bun.plugin({name:"owned-partial-capture-constructor",setup(builder){builder.onLoad({filter:/[/]memory[/]capture\.ts$/},({path})=>{
      const source=readFileSync(path,"utf8"),anchor="      this.ensureBriefSummaryIndex(true);";
      if(source.split(anchor).length!==2)throw Error("Partial constructor anchor changed; retain the fixture and update the preparation control");
      return {loader:"ts",contents:source.replace(anchor,"      (globalThis as any).__workerFeasibilityPause(db);"+anchor)};
    });}});
  }
  const {CaptureStore}=await import("../../src/memory/capture.ts");
  const store=new CaptureStore({memoryDir:o.base,project:o.project,cwd:o.cwd,busyTimeoutMs:0});Object.defineProperty(globalThis,"__workerFeasibilityPinnedStore",{value:store});
  store.append({project:o.project,agent:"fixture",event:"Recap",excerpt:"owned recovery preparation"});
  const {Database}=await import("bun:sqlite"),db=(store as unknown as {db:import("bun:sqlite").Database}).db;
  const holder=new Database(join(store.dir,"capture.db"));holder.run("BEGIN IMMEDIATE");let spooled=0;
  try{for(let i=0;i<32;i++){const result=store.append({project:o.project,agent:"fixture",event:"Recap",excerpt:"owned pending preparation "+i});if("spooled"in result&&result.spooled)spooled++;}}finally{holder.run("ROLLBACK");holder.close();}
  if(spooled!==32)throw Error("Recovery preparation did not retain32production-spooled records; retain the fixture and stop");
  writeFileSync(o.ready,JSON.stringify(snapshot(db,spooled))+"\n",{flag:"wx",mode:0o600});
  await new Promise(()=>{setInterval(()=>{},1000);});
}
if(import.meta.main){if(process.argv.length!==4||process.argv[2]!=="--prepare")throw Error("Recovery child arguments are invalid; invoke only through the owned sample driver");await prepareChild(process.argv[3]!);}
