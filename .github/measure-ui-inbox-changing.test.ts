/** Nonshipping #268 evidence. The workflow extracts this exact measurement-PR blob into test/ at FIX_HEAD.
 * Spies run only in the separate unchanged-inventory proof, never during the forty timed public snapshots. */
/// <reference lib="dom.asynciterable" />
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedInboxBenchmark, waitForComplete } from "../scripts/measure-ui-inbox.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { entryId, type NoteEntry } from "../src/memory/store.ts";
import { plugin } from "../src/ui/plugin.ts";
import { inboxSources, inboxSourceChange, INBOX_MAX_BYTES, INBOX_MAX_ITEMS } from "../src/ui/inbox.ts";
import type { InboxSnapshot } from "../src/ui/inbox-cache.ts";

const FIX_HEAD = "778d1d18ff32af5a1a5d2ca098fe32a6652a4a63";
const p95 = (values: number[]) => [...values].sort((a,b) => a-b)[Math.ceil(values.length * .95)-1]!;
function plainNote(project: string, machine: string, sample: number): Buffer {
  const body: Omit<NoteEntry, "id"> = { schema: "agent-hub.memory/v1", op: "note", at: new Date(1793491200000+sample).toISOString(), machine,
    project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: `changing-source measurement ${sample}: 공개 plain note`, about: [] };
  return Buffer.from(canonicalJSON({ ...body, id: entryId(body) }) + "\n");
}
function appendOwned(file: string, bytes: Buffer, identity: {dev:number;ino:number}): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd); expect(before.isFile()).toBe(true); expect(before.dev).toBe(identity.dev); expect(before.ino).toBe(identity.ino);
    let at=0; while(at<bytes.length){const count=writeSync(fd,bytes,at,bytes.length-at);if(count<=0)throw Error("owned append failed");at+=count;}
    fsyncSync(fd); const after=fstatSync(fd); expect(after.dev).toBe(identity.dev); expect(after.ino).toBe(identity.ino); expect(after.size).toBe(before.size+bytes.length);
  } finally { closeSync(fd); }
}
function bounded(snapshot: InboxSnapshot): number {
  const bytes=Buffer.byteLength(JSON.stringify(snapshot)); expect(snapshot.items.length).toBeLessThanOrEqual(INBOX_MAX_ITEMS); expect(bytes).toBeLessThanOrEqual(INBOX_MAX_BYTES);
  expect(Number.isSafeInteger(snapshot.more)).toBe(true); expect(snapshot.more).toBeGreaterThanOrEqual(0); return bytes;
}

test("fixed-head realistic changing-source snapshots stay bounded and unchanged inventories read no tails", async () => {
  const root=mkdtempSync(join(tmpdir(),"amem-inbox-changing-")), previousAmem=process.env.AMEM_HOME, previousAgent=process.env.AGENTHUB_HOME;
  const report:Record<string,unknown>={diagnostic:"ui-inbox-changing-source",productHead:FIX_HEAD,measurementHead:process.env.MEASURE_HEAD??null,
    fixture:{projects:20,candidatesPerProject:100,curatedPerProject:1000,capturesPerProject:500},timingLimitMs:1000,samples:[],pass:false};
  let provider:Awaited<ReturnType<typeof plugin.open>>|undefined, failure:unknown, cleanupFailed=false;
  try {
    const seededAt=performance.now(),fixture=seedInboxBenchmark(root,{projects:20,candidates:100,curated:1000,captures:500});
    report.seedMs=performance.now()-seededAt;report.counts={projects:fixture.projects.length,candidates:fixture.candidateRows,curated:fixture.curatedRows,captures:fixture.captureRows};
    expect(report.counts).toEqual({projects:20,candidates:2000,curated:20060,captures:10000});
    process.env.AMEM_HOME=fixture.base;process.env.AGENTHUB_HOME=fixture.family;
    const openAt=performance.now();provider=await plugin.open({home:fixture.family,log:()=>{}});report.openMs=performance.now()-openAt;
    const snapshot=async()=>await provider!.snapshot({panel:"inbox",after:0}) as unknown as InboxSnapshot;
    const readyAt=performance.now(), initial=await waitForComplete(snapshot);report.initialTimeToCompleteMs=performance.now()-readyAt;
    expect(initial.complete).toBe(true);expect(initial.items).toHaveLength(50);expect(initial.more).toBeGreaterThan(0);bounded(initial);
    const screened=initial.items.filter(item=>item.group==="candidate").map(item=>({id:item.id,title:item.title,at:item.at}));expect(screened.length).toBeGreaterThan(0);
    const frame=inboxSources(fixture.base,["log","local"]);
    // Positive spy control uses another owned fake home, leaving the realistic fixture and its counts untouched.
    const control=join(root,"spy-control");mkdirSync(join(control,"log"),{recursive:true,mode:0o700});
    const controlFile=join(control,"log","author.jsonl");writeFileSync(controlFile,plainNote("control","a".repeat(16),0),{mode:0o600});
    const controlFrame=inboxSources(control,["log"]),controlStat=lstatSync(controlFile);appendOwned(controlFile,plainNote("control","a".repeat(16),1),controlStat);
    const opened=spyOn(fs,"openSync"),read=spyOn(fs,"readSync");
    try {
      expect(inboxSourceChange(control,controlFrame)).toMatchObject({changed:true,hard:false});expect(opened.mock.calls.length).toBeGreaterThan(0);expect(read.mock.calls.length).toBeGreaterThan(0);
      opened.mockClear();read.mockClear();const unchanged=inboxSourceChange(fixture.base,frame);
      expect(unchanged).toMatchObject({changed:false,hard:false});expect(opened).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
      report.unchangedInventory={paths:frame.paths.length,changed:false,openSyncCalls:opened.mock.calls.length,readSyncCalls:read.mock.calls.length,positiveTailControlVerified:true};
    } finally { opened.mockRestore();read.mockRestore(); }
    const machine=JSON.parse(readFileSync(join(fixture.base,"machine.json"),"utf8")) as {id:string};
    const file=join(fixture.base,"log",`${machine.id}.jsonl`),identity=lstatSync(file),timings:number[]=[],samples:Record<string,unknown>[]=[];
    report.samples=samples;
    for(let sample=0;sample<40;sample++){
      // Canonical write, fsync, inode checks and note construction are deliberately OUTSIDE the response timer.
      appendOwned(file,plainNote(fixture.projects[0]!,machine.id,sample+100),identity);
      const at=performance.now(), value=await snapshot(),wallMs=performance.now()-at;
      const bytes=Buffer.byteLength(JSON.stringify(value));
      timings.push(wallMs);samples.push({sample:sample+1,wallMs,bytes,items:value.items.length,more:value.more,complete:value.complete,refreshing:value.refreshing});
      bounded(value);expect(value.complete).toBe(false);expect(value.refreshing).toBe(true);
      expect(value.items.filter(item=>item.group==="candidate").map(item=>({id:item.id,title:item.title,at:item.at}))).toEqual(screened);
    }
    report.samples=samples;report.changingSource={count:timings.length,notesAppended:40,expectedCuratedAfter:20100,p95Ms:p95(timings),maxMs:Math.max(...timings),maxBytes:Math.max(...samples.map(value=>value.bytes as number)),sameInode:true,uninstrumented:true};
    const completeAt=performance.now(),complete=await waitForComplete(snapshot);report.finalTimeToCompleteMs=performance.now()-completeAt;
    expect(complete.complete).toBe(true);bounded(complete);expect(complete.items.filter(item=>item.group==="candidate").map(item=>({id:item.id,title:item.title,at:item.at}))).toEqual(screened);
    report.eventualCompletion={complete:true,items:complete.items.length,more:complete.more};
    expect(p95(timings)).toBeLessThan(1000);report.pass=true;
  } catch(error) { failure=error;report.error=error instanceof Error?error.message:"measurement unavailable"; }
  finally {
    try { await provider?.close(); } catch { cleanupFailed=true;report.pass=false;report.cleanup="owned inbox cleanup unavailable"; }
    if(previousAmem===undefined)delete process.env.AMEM_HOME;else process.env.AMEM_HOME=previousAmem;
    if(previousAgent===undefined)delete process.env.AGENTHUB_HOME;else process.env.AGENTHUB_HOME=previousAgent;
    if(!cleanupFailed)try{rmSync(root,{recursive:true,force:true});}catch{cleanupFailed=true;report.pass=false;report.cleanup="owned fixture cleanup unavailable";}
    if(cleanupFailed)report.retainedFixture=root;
    writeFileSync(join(process.cwd(),"ui-inbox-changing.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report));
  }
  if(failure)throw failure;if(cleanupFailed)throw Error("changing-source measurement cleanup failed");
},300000);
