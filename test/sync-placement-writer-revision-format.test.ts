import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { syncPlacementWriterId } from "../src/memory/sync-placement-writers.ts";
import { PLACEMENT_FORMAT } from "../src/memory/sync-placement-format.ts";
import {
  WRITER_REVISION_MAX_BYTES, WRITER_COMMIT_MAX_BYTES, WRITER_RENEWAL_INTENT_MAX_BYTES, WRITER_REVISION_LIMIT,
  WRITER_COMMIT_LOG, WRITER_RENEWAL_INTENT_FILE, WRITER_REVISION_SCHEMA, WRITER_RENEWAL_INTENT_SCHEMA,
  SharedWriterRevisionError, writerRevisionFile, writerHistoryFileLimit, writerInventoryGenesis,
  createWriterRevision, validateWriterRevision, writerRevisionWriters, createWriterCommit, validateWriterCommit,
  createWriterRenewalIntent, validateWriterRenewalIntent, type WriterRevisionBody, type WriterRevision,
} from "../src/memory/sync-placement-writer-revision-format.ts";

const H=(n:number)=>n.toString(16).padStart(64,"0"),EMPTY=createHash("sha256").update("").digest("hex");
function root(value="/fixture/install",version="0.22.0"){return {root:value,writerId:syncPlacementWriterId(value),version,pin:H(5)};}
function body():WriterRevisionBody{return {schema:WRITER_REVISION_SCHEMA,epochHash:H(1),generation:"2".repeat(32),homeHash:H(3),activationHash:H(4),initialLocatorHash:H(6),
  sequence:1,previousHash:writerInventoryGenesis(H(1),H(4)),journal:{sequence:0,headHash:H(1)},roots:[root()],requestId:H(7)};}
function renewal(revision=createWriterRevision(body())){return {schema:WRITER_RENEWAL_INTENT_SCHEMA,home:"/fixture/memory",revision,commit:createWriterCommit(revision),previousLogBytes:0,previousLogHash:EMPTY};}
function refused(work:()=>unknown,code?:string){let failure:unknown;try{work();}catch(error){failure=error;}expect(failure).toBeInstanceOf(SharedWriterRevisionError);
  const error=failure as SharedWriterRevisionError;if(code)expect(error.code).toBe(code);expect(error.message).not.toContain("PRIVATE_CODEC_CANARY");return error;}

test("revision, commit and intent are detached closed canonical data with independently bound seals",()=>{
  const source=body(),rev=createWriterRevision(source),ack=createWriterCommit(rev),intent=createWriterRenewalIntent(renewal(rev));
  expect(validateWriterRevision(JSON.parse(canonicalJSON(rev)))).toEqual(rev);expect(validateWriterCommit(ack)).toEqual(ack);expect(validateWriterRenewalIntent(intent)).toEqual(intent);
  const {seal:revisionSeal,...revisionBody}=rev,{seal:commitSeal,...commitBody}=ack,{seal:intentSeal,...intentBody}=intent;
  expect(revisionSeal).toBe(hashJSON(revisionBody));expect(commitSeal).toBe(hashJSON(commitBody));expect(intentSeal).toBe(hashJSON(intentBody));
  expect(ack).toMatchObject({epochHash:rev.epochHash,sequence:1,previousHash:rev.previousHash,revisionHash:rev.seal});
  expect(writerRevisionWriters(rev)).toEqual([{writerId:rev.roots[0]!.writerId,version:"0.22.0",pin:H(5),publicationFormat:PLACEMENT_FORMAT,compatible:true}]);
  source.roots[0]!.root="/mutated";source.journal.sequence=3;expect(rev.roots[0]!.root).toBe("/fixture/install");expect(rev.journal.sequence).toBe(0);
  const copy=validateWriterRevision(rev);copy.roots[0]!.pin=H(100);expect(rev.roots[0]!.pin).toBe(H(5));
});

test("subsequent revisions bind the preceding commit head without reusing a row journal event",()=>{
  const first=createWriterRevision(body()),ack=createWriterCommit(first);
  const next=createWriterRevision({...body(),sequence:2,previousHash:ack.seal,requestId:H(8),journal:{sequence:12,headHash:H(12)}});
  const nextIntent=createWriterRenewalIntent({...renewal(next),previousLogBytes:Buffer.byteLength(canonicalJSON(ack)+"\n"),previousLogHash:createHash("sha256").update(canonicalJSON(ack)+"\n").digest("hex")});
  expect(nextIntent.revision.previousHash).toBe(ack.seal);expect(nextIntent.commit.previousHash).toBe(ack.seal);
  expect(nextIntent.revision.epochHash).toBe(first.epochHash);expect(nextIntent.revision.activationHash).toBe(first.activationHash);
  refused(()=>createWriterRevision({...body(),previousHash:H(99)}),"invalid");
});

test("known file names and accepted bounds are exact, future metadata is not silently recognized",()=>{
  expect(WRITER_REVISION_MAX_BYTES).toBe(512*1024);expect(WRITER_COMMIT_MAX_BYTES).toBe(64*1024);expect(WRITER_RENEWAL_INTENT_MAX_BYTES).toBe(1024*1024);
  expect(WRITER_COMMIT_LOG).toBe("writer-revisions.jsonl");expect(WRITER_RENEWAL_INTENT_FILE).toBe("sync-placement-writer-renewal.json");
  expect(writerRevisionFile(1)).toBe("writer-revision-00001.json");expect(writerRevisionFile(64)).toBe("writer-revision-00064.json");
  expect(writerHistoryFileLimit(WRITER_COMMIT_LOG)).toBe(64*1024);expect(writerHistoryFileLimit(writerRevisionFile(1))).toBe(512*1024);
  for(const unknown of ["writer-revision-00000.json","writer-revision-00065.json","writer-revision-1.json","writer-revision-00001.json\n","../writer-revisions.jsonl","writer-renewal.json",WRITER_RENEWAL_INTENT_FILE])expect(writerHistoryFileLimit(unknown)).toBeUndefined();
  refused(()=>writerRevisionFile(0),"invalid");const cap=refused(()=>writerRevisionFile(65),"cap");expect(cap.remaining).toBe(0);expect(cap.message).toContain("separately reviewed archival/checkpoint");
  expect(WRITER_REVISION_LIMIT).toBe(64);
});

test("roots require canonical absolute paths, sorted unique exact IDs, plain minimum release and byte pins",()=>{
  for(const path of ["relative/root","/fixture/install/","/fixture/../install","/fixture//install","/fixture/PRIVATE_CODEC_CANARY"+"x".repeat(4096)])refused(()=>createWriterRevision({...body(),roots:[root(path)]}));
  for(const version of ["0.21.99","0.22.0-rc.1","0.22.0+build","0.22.0\n","00.22.0"])refused(()=>createWriterRevision({...body(),roots:[root("/fixture/a",version)]}),"invalid");
  expect(createWriterRevision({...body(),roots:[root("/fixture/공개", "0.22.1")]}).roots[0]!.version).toBe("0.22.1");
  expect(createWriterRevision({...body(),roots:[root("/fixture/a","1.0.0")]}).roots).toHaveLength(1);
  refused(()=>createWriterRevision({...body(),roots:[root("/fixture/b"),root("/fixture/a")]}),"invalid");
  refused(()=>createWriterRevision({...body(),roots:[root(),root()]}),"invalid");
  refused(()=>createWriterRevision({...body(),roots:[{...root(),writerId:H(999)}]}),"invalid");
  refused(()=>createWriterRevision({...body(),roots:[{...root(),pin:H(1)+"\n"}]}),"invalid");
  refused(()=>createWriterRevision({...body(),roots:Array.from({length:257},(_,i)=>root(`/fixture/${String(i).padStart(3,"0")}`))}),"bound");
});

test("closed shapes and full-width hashes reject unknown fields, future schemas and trailing newlines",()=>{
  const rev=createWriterRevision(body()),ack=createWriterCommit(rev),intent=createWriterRenewalIntent(renewal(rev));
  refused(()=>validateWriterRevision({...rev,unknown:"PRIVATE_CODEC_CANARY"}),"invalid");
  refused(()=>validateWriterRevision({...rev,schema:"agent-mem.sync-placement-writer-revision/v2"}),"invalid");
  refused(()=>validateWriterCommit({...ack,unknown:1}),"invalid");refused(()=>validateWriterRenewalIntent({...intent,unknown:1}),"invalid");
  for(const key of ["epochHash","homeHash","activationHash","initialLocatorHash","previousHash","requestId","seal"] as const)refused(()=>validateWriterRevision({...rev,[key]:rev[key]+"\n"}),"invalid");
  refused(()=>validateWriterRevision({...rev,generation:rev.generation+"\n"}),"invalid");
  refused(()=>validateWriterRevision({...rev,journal:{...rev.journal,extra:1}}),"invalid");
  refused(()=>validateWriterRevision({...rev,roots:[{...rev.roots[0]!,compatible:true}]}),"invalid");
});

test("intent binds every commit relation and the first commit log's exact empty prefix",()=>{
  const rev=createWriterRevision(body()),base=renewal(rev);
  for(const change of [{epochHash:H(99)},{sequence:2},{previousHash:H(99)},{revisionHash:H(99)}]){
    const {seal:_old,...oldBody}=base.commit,newBody={...oldBody,...change};
    refused(()=>createWriterRenewalIntent({...base,commit:{...newBody,seal:hashJSON(newBody)}}),"invalid");
  }
  refused(()=>createWriterRenewalIntent({...base,previousLogBytes:1}),"invalid");
  refused(()=>createWriterRenewalIntent({...base,previousLogHash:H(99)}),"invalid");
  refused(()=>createWriterRenewalIntent({...base,previousLogBytes:64*1024+1}),"invalid");
  refused(()=>createWriterRenewalIntent({...base,home:"/fixture/memory/"}),"invalid");
  const intent=createWriterRenewalIntent(base);refused(()=>validateWriterRenewalIntent({...intent,seal:H(99)}),"invalid");
});

test("closed descriptor validation never invokes getters, proxies, toJSON or inherited payload methods",()=>{
  let invoked=0;const input=body();Object.defineProperty(input,"roots",{enumerable:true,get(){invoked++;return [];}});
  refused(()=>createWriterRevision(input),"invalid");
  refused(()=>createWriterRevision(new Proxy(body(),{get(){invoked++;throw Error("not executed");},getPrototypeOf(){invoked++;throw Error("not executed");}})),"invalid");
  const rev=createWriterRevision(body()),array=[root()];Object.defineProperty(array,"0",{enumerable:true,get(){invoked++;return root();}});
  refused(()=>validateWriterRevision({...rev,roots:array}),"invalid");
  refused(()=>createWriterRevision(Object.assign(Object.create({toJSON(){invoked++;return {};}}),body())),"invalid");
  refused(()=>createWriterRevision({...body(),toJSON(){invoked++;return {};}} as WriterRevisionBody),"invalid");expect(invoked).toBe(0);
});

test("large valid revisions bypass policy-payload limits while the dedicated512KiB ceiling remains strict",()=>{
  const roots=(size:number)=>Array.from({length:256},(_,i)=>root(`/fixture/${String(i).padStart(3,"0")}-${"x".repeat(size)}`));
  const rev=createWriterRevision({...body(),roots:roots(1700)}),size=Buffer.byteLength(canonicalJSON(rev)+"\n");
  expect(size).toBeGreaterThan(256*1024);expect(size).toBeLessThanOrEqual(WRITER_REVISION_MAX_BYTES);
  expect(validateWriterRevision(rev)).toEqual(rev);expect(Buffer.byteLength(canonicalJSON(createWriterRenewalIntent(renewal(rev)))+"\n")).toBeLessThanOrEqual(WRITER_RENEWAL_INTENT_MAX_BYTES);
  refused(()=>createWriterRevision({...body(),roots:roots(2200)}),"bound");
});

test("numeric journal/revision limits fail closed without creating a new epoch or evicting history",()=>{
  for(const sequence of [0,-1,1.5,NaN,Infinity])refused(()=>createWriterRevision({...body(),sequence}),"invalid");
  const final=createWriterRevision({...body(),sequence:64,previousHash:H(63),journal:{sequence:20000,headHash:H(20000)}});
  expect(final.sequence).toBe(64);expect(final.epochHash).toBe(body().epochHash);
  refused(()=>createWriterRevision({...body(),sequence:65,previousHash:H(64)}),"cap");
  refused(()=>createWriterRevision({...body(),journal:{sequence:20001,headHash:H(1)}}),"invalid");
  const immutable=canonicalJSON(final);refused(()=>validateWriterRevision({...final,seal:H(88)}),"invalid");expect(canonicalJSON(final)).toBe(immutable);
});
