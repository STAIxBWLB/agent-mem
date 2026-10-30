import { assertPublisherBoundary, ensurePublisherBoundary, publisherPruneLineages } from "./prune-publisher-lineage.ts";
import { verifyPublicPruneWitness, type PublicPruneWitnessV1 } from "./public-prune-witness.ts";
import { readPublicPruneView, type PublicPruneViewV1 } from "./public-prune-view.ts";
import { advancePublicPruneView } from "./public-prune-advance.ts";
import { collectPublicPruneGitGraph } from "./shard-sync-graph.ts";
import { PublicPruneInputError, PUBLIC_PRUNE_REPLAY_MAX_BYTES, PUBLIC_PRUNE_MAX_SETS, preparePublicPruneInputBatch, persistPublicPruneInputBatch, readPublicPruneInputDescriptor, reducePublicPruneInputs, type PublicPruneInputBatch, type PublicPruneInputV1 } from "./public-prune-inputs.ts";
import { randomBytes, createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, fsyncDirectory, hashJSON, readProfileJSON, readSelector, rebindPublicPruneProfile } from "./generation.ts";
import { generationSyncLock } from "./generation-sync.ts";
import { acquireMutation, assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { realPath } from "./platform.ts";
import { reducePruneRows, validatePrunePlan, validatePruneRow, type PrunePlan, type PruneRow, type PruneSnapshot, type PruneSourceRow } from "./prune.ts";
import { assertCuratedShardPaths, isLocalKey, resolveShardProfile } from "./shard.ts";
import { decodeShardPack, encodeShardPacks, decodeShardDescriptor, decodeShardManifest, encodeShardManifest, isShardManifestPath, SHARD_PACK_MAX_BYTES, ShardSyncFormatError, shardSyncDescriptor, shardSyncLabel, shardSyncRef, type ShardSyncRealm, type ShardSyncRow } from "./shard-sync-format.ts";
import { generationSyncGit, generationSyncGitBytes, remoteVisibility, shardSyncBinding, shardSyncSourceBinding, type SyncOptions, type SyncResult } from "./sync.ts";
import type { Entry, MemoryStore } from "./store.ts";

const OID = /^[a-f0-9]{40}$/, PACK = /^rows\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl$/;
const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const zero = "0".repeat(40);
// The descriptor is at most 64 KiB and an original prune at most 16 KiB; keep receipt parsing bounded.
const HOLD_MAX_BYTES = 128 * 1024;
export const PENDING_SELECTOR_LIMIT = 64;
type PendingPrune = { plan: PrunePlan; row: PruneRow; line: string; offset: number; prefixHash: string; selectorCheck?: () => void; unclaimed?: true };
type HoldSource = { ref: string; commit: string; pack: string; blob: string };
type HoldReceipt = { schema: "agent-mem.prune-hold/v1"; remote: string; realm: ShardSyncRealm; receivingGeneration: string; row: PruneRow; payloadHash: string; source: HoldSource };
type Hold = { file: string; bytes: Buffer };
type SyncPhase = "published" | "hold-written" | "hold-installed" | "inputs-installed" | "view-committed" | "imported";
type SyncManifest = { path: string; bytes: Buffer; value: unknown; row: PruneRow; eligible: boolean; commit: string; blob: string };
type Target = { store: MemoryStore; realm: ShardSyncRealm; rows: Map<string, ShardSyncRow>; fetched: Set<string>; sources: PruneSourceRow[]; pending: PendingPrune[]; origins: Map<string, HoldSource>; holds: Hold[]; generation: string; manifests: Map<string,SyncManifest>; eligible: Set<string>; mutation?: MutationHandle; batch?: PublicPruneInputBatch; registered: PublicPruneInputV1[]; selectorChecks?: (()=>void)[]; local?: string; remote?: string; commit?: string };
class SyncRefusal extends Error {}
function refuse(reason: string): never { throw new SyncRefusal(reason); }
function directory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("shard sync requires independent private directories");
}
function regular(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse("shard sync refuses non-regular transport files");
}
function mergeRows(into: Map<string, ShardSyncRow>, rows: readonly ShardSyncRow[], realm: ShardSyncRealm): void {
  for (const row of rows) {
    const old = into.get(row.id);
    if (old && canonicalJSON(old) !== canonicalJSON(row)) refuse(`${shardSyncLabel(realm)}: conflicting original row`);
    into.set(row.id, row);
  }
}
function importPrunePlan(store: MemoryStore, realm: ShardSyncRealm, row: PruneRow, selectorRevision = store.prunePort().selectorRevision()): PrunePlan {
  const body: Omit<PrunePlan, "seal"> = { schema: "agent-mem.prune-plan/v1", generation: store.profile.generation!,
    selectorRevision, project: realm.scope === "project" ? realm.key : "user",
    policyRevision: hashJSON({ schema: "agent-mem.shard-sync/v1", realm }), rows: [{ placement: "synced", payload: row }],
    counts: { eligible: row.targets.length, selected: row.targets.length, local: 0, synced: row.targets.length }, hasMore: false };
  return validatePrunePlan({ ...body, seal: hashJSON(body) });
}
/** A retained selector is owned recovery evidence, not authorization or input membership. */
function selectorEvidence(folder: string, file: string, prefix?: Buffer | true): { value: unknown; bytes: Buffer; check: () => void } {
  privateHoldPath(folder,true); privateHoldPath(file,false);
  const parent=lstatSync(folder), before=lstatSync(file);
  if(parent.uid!==process.getuid?.()||before.uid!==parent.uid||before.size<(prefix?0:1)||before.size>4096)refuse("prior selector unavailable");
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const opened=fstatSync(fd), same=(stat:typeof opened)=>stat.dev===before.dev&&stat.ino===before.ino&&stat.size===before.size&&stat.mtimeMs===before.mtimeMs&&stat.ctimeMs===before.ctimeMs&&stat.uid===before.uid&&stat.nlink===1&&(stat.mode&0o077)===0&&stat.isFile();
    if(!same(opened))refuse("prior selector changed");
    const bytes=Buffer.alloc(before.size+1);let count=0;
    while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,count);if(!n)break;count+=n;}
    const check=()=>{privateHoldPath(folder,true);privateHoldPath(file,false);const current=lstatSync(folder);if(current.dev!==parent.dev||current.ino!==parent.ino||current.uid!==parent.uid||!same(lstatSync(file)))refuse("prior selector changed");};
    if(count!==before.size||!same(fstatSync(fd)))refuse("prior selector changed");check();
    const data=bytes.subarray(0,count);
    if(prefix){if(prefix!==true&&(data.length>prefix.length||!data.equals(prefix.subarray(0,data.length))))refuse("prior selector staging changed");return{value:undefined,bytes:data,check};}
    const text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(data),value:unknown=JSON.parse(text);
    if(canonicalJSON(value)+"\n"!==text)refuse("prior selector unavailable");return{value,bytes:data,check};
  } finally {closeSync(fd);}
}
function pendingSelector(store:MemoryStore,plan:PrunePlan,required=false):(()=>void)|undefined {
  if(!required&&plan.selectorRevision===store.profile.selectorRevision)return undefined;
  if(!store.profile.foreignPruneFormat)refuse("pending selector unavailable");
  const history=join(store.dir,"prune-plans","selector-history"),file=join(history,plan.seal+".json"),evidence=selectorEvidence(history,file),prior=evidence.value as Record<string,unknown>|undefined;
  if(!prior||Object.keys(prior).length!==5||prior.schema!=="agent-mem.profile/v2"||prior.kind!=="generation"||prior.generation!==store.profile.generation
    ||prior.foreignPruneFormat!==store.profile.foreignPruneFormat||typeof prior.pruneInputSetHash!=="string"||!/^[a-f0-9]{64}$/.test(prior.pruneInputSetHash)||hashJSON(prior)!==plan.selectorRevision)refuse("pending selector binding unavailable");
  const bound={...store.profile,selectorRevision:plan.selectorRevision,pruneInputSetHash:prior.pruneInputSetHash};
  const check=()=>{evidence.check();const probe={...bound};rebindPublicPruneProfile(probe);if(probe.selectorRevision!==store.profile.selectorRevision)refuse("pending selector ancestry unavailable");};check();return check;
}
/** Recognize only the exact persisted transport shape; this reads metadata and never resumes an append. */
function pendingPrunes(store: MemoryStore, realm: ShardSyncRealm): PendingPrune[] {
  const dir = join(store.dir, "prune-plans"), pending: PendingPrune[] = [];
  if (!existsSync(dir)) return pending;
  directory(dir);
  try {
    for (const name of readdirSync(dir).sort()) {
      if (!name.startsWith("pending-log-")) continue;
      if (!/^pending-log-[a-f0-9]{16}\.json$/.test(name)) throw new Error("claim name");
      const claimFile = join(dir, name); regular(claimFile);
      const claim = readProfileJSON(claimFile, 4096) as { schema?: unknown; seal?: unknown; rowId?: unknown; lineHash?: unknown; offset?: unknown; prefixHash?: unknown } | undefined;
      if (!claim || typeof claim !== "object" || Array.isArray(claim) || Object.keys(claim).length !== 6
        || claim.schema !== "agent-mem.prune-append/v1" || typeof claim.seal !== "string" || !/^[a-f0-9]{64}$/.test(claim.seal)
        || typeof claim.offset !== "number" || !Number.isSafeInteger(claim.offset) || claim.offset < 0
        || typeof claim.prefixHash !== "string" || !/^[a-f0-9]{64}$/.test(claim.prefixHash)) throw new Error("claim shape");
      const planFile = join(dir, `${claim.seal}.json`); regular(planFile);
      const plan = validatePrunePlan(readProfileJSON(planFile));
      if (plan.rows.length !== 1) throw new Error("plan shape");
      const row = plan.rows[0]!.payload, line = canonicalJSON(row) + "\n";
      const selectorCheck=pendingSelector(store,plan);
      if (plan.seal !== claim.seal || canonicalJSON(plan) !== canonicalJSON(importPrunePlan(store, realm, row, plan.selectorRevision))
        || name !== `pending-log-${row.machine}.json` || claim.rowId !== row.id || claim.lineHash !== digest(line)) throw new Error("plan binding");
      regular(join(store.dir, "log", `${row.machine}.jsonl`));
      pending.push({ plan, row, line, offset: claim.offset, prefixHash: claim.prefixHash, ...(selectorCheck?{selectorCheck}:{}) });
    }
    const history=join(dir,"selector-history");
    if(store.profile.foreignPruneFormat&&existsSync(history)){
      privateHoldPath(history,true);const seals=new Set<string>();
      for(const name of readdirSync(history)){const match=/^([a-f0-9]{64})\.json(\.pending)?$/.exec(name);if(!match||match[0]!==name)throw new Error("selector copy name");seals.add(match[1]!);if(seals.size>PENDING_SELECTOR_LIMIT)throw new PublicPruneInputError("resource");}
      const claimed=new Set(pending.map(item=>item.plan.seal)),durable=new Set(store.prunePort().snapshot().durablePruneIds);
      for(const seal of seals){
        if(claimed.has(seal)||!existsSync(join(history,seal+".json")))continue;
        const plan=validatePrunePlan(readProfileJSON(join(dir,seal+".json"))),row=plan.rows[0]?.payload;
        if(plan.seal!==seal||plan.rows.length!==1||!row||canonicalJSON(plan)!==canonicalJSON(importPrunePlan(store,realm,row,plan.selectorRevision)))throw new Error("selector plan binding");
        if(durable.has(row.id))continue;
        // A durable selector copy also journals the interval before append creates its native claim.
        const selectorCheck=pendingSelector(store,plan,true);
        pending.push({plan,row,line:canonicalJSON(row)+"\n",offset:0,prefixHash:digest(""),unclaimed:true,selectorCheck});
      }
    }
    return pending;
  } catch(error) { if(error instanceof PublicPruneInputError)throw error;return refuse(`${shardSyncLabel(realm)}: pending prune requires its original plan to resume`); }
}
/** Private copies are addressed by their exact pending transport plan, never used as current selectors. */
function selectorRetention(target: Target, advancing: boolean, install = false, reserveNative = false): void {
  assertMutationHandle(target.mutation!,target.store.dir);
  if(!target.store.profile.foreignPruneFormat)return;
  const plans=join(target.store.dir,"prune-plans"),folder=join(plans,"selector-history"),exists=lstatSync(folder,{throwIfNoEntry:false});
  const records=new Map<string,{file?:string;stage?:string}>();
  if(exists){
    privateHoldPath(folder,true);if(exists.uid!==process.getuid?.())refuse("selector recovery owner changed");
    for(const name of readdirSync(folder)){
      const match=/^([a-f0-9]{64})\.json(\.pending)?$/.exec(name);if(!match||match[0]!==name)refuse("selector recovery artifact unavailable");
      const entry=records.get(match[1]!)??{};entry[match[2]?"stage":"file"]=join(folder,name);records.set(match[1]!,entry);
      if(records.size>PENDING_SELECTOR_LIMIT)throw new PublicPruneInputError("resource");
    }
  }
  const pending=new Map(target.pending.map(item=>[item.plan.seal,item])),keep=new Map<string,Buffer>(),remove:string[]=[],checks:(()=>void)[]=[];
  let durable:Set<string>|undefined;
  const validate=(plan:PrunePlan,value:unknown)=>{
    const row=plan.rows[0]?.payload,prior=value as Record<string,unknown>|undefined;
    if(plan.rows.length!==1||!row||plan.generation!==target.generation||row.generation!==target.generation
      ||canonicalJSON(plan)!==canonicalJSON(importPrunePlan(target.store,target.realm,row,plan.selectorRevision))
      ||!prior||Object.keys(prior).length!==5||prior.schema!=="agent-mem.profile/v2"||prior.kind!=="generation"
      ||prior.generation!==target.generation||prior.foreignPruneFormat!==target.store.profile.foreignPruneFormat
      ||typeof prior.pruneInputSetHash!=="string"||!/^[a-f0-9]{64}$/.test(prior.pruneInputSetHash)||hashJSON(prior)!==plan.selectorRevision)refuse("selector recovery plan binding unavailable");
  };
  for(const [seal,record] of records){
    const active=pending.get(seal),plan=active?.plan??validatePrunePlan(readProfileJSON(join(plans,seal+".json")));
    if(plan.seal!==seal)refuse("selector recovery plan identity changed");
    if(!record.file){
      if(active){if(plan.selectorRevision!==target.store.profile.selectorRevision)refuse("selector recovery evidence missing");continue;}
      const row=plan.rows[0]?.payload,claim=row?readProfileJSON(join(plans,`pending-log-${row.machine}.json`)) as {seal?:unknown}|undefined:undefined;
      if(!row||plan.rows.length!==1||claim?.seal===seal||canonicalJSON(plan)!==canonicalJSON(importPrunePlan(target.store,target.realm,row,plan.selectorRevision)))refuse("selector staging binding unavailable");
      // An incomplete temp precedes both registration and the native claim; it grants no replay authority.
      checks.push(selectorEvidence(folder,record.stage!,true).check);remove.push(record.stage!);continue;
    }
    const evidence=selectorEvidence(folder,record.file);validate(plan,evidence.value);checks.push(evidence.check);
    if(record.stage)checks.push(selectorEvidence(folder,record.stage,evidence.bytes).check);
    if(active){keep.set(seal,evidence.bytes);continue;}
    // Claim disappearance alone is not completion. Prove the original plan's exact native row is durable.
    durable??=new Set(target.store.prunePort().snapshot().durablePruneIds);
    const row=plan.rows[0]!.payload,claim=readProfileJSON(join(plans,`pending-log-${row.machine}.json`)) as {seal?:unknown}|undefined;
    if(!durable.has(row.id)||canonicalJSON(target.rows.get(row.id))!==canonicalJSON(row)||claim?.seal===seal)refuse("selector recovery completion unavailable");
    remove.push(record.file,...(record.stage?[record.stage]:[]));
  }
  for(const item of target.pending){
    const seal=item.plan.seal;if(keep.has(seal)||!advancing&&!records.has(seal))continue;
    if(item.plan.selectorRevision!==target.store.profile.selectorRevision)refuse("prior pending selector unavailable");
    const selector=readSelector(target.store.profile.home).selector;validate(item.plan,selector);
    const bytes=Buffer.from(canonicalJSON(selector)+"\n"),stage=records.get(seal)?.stage;
    if(stage)checks.push(selectorEvidence(folder,stage,bytes).check);keep.set(seal,bytes);
  }
  if(Math.max(keep.size,reserveNative?1:0)>PENDING_SELECTOR_LIMIT)throw new PublicPruneInputError("resource");
  const inventory=()=>{
    const before=lstatSync(folder,{throwIfNoEntry:false}),names=before?readdirSync(folder).sort().join("\n"):undefined;
    return()=>{const now=lstatSync(folder,{throwIfNoEntry:false});if(!before){if(now)refuse("selector recovery inventory changed");return;}
      privateHoldPath(folder,true);if(!now||now.dev!==before.dev||now.ino!==before.ino||now.uid!==before.uid||readdirSync(folder).sort().join("\n")!==names)refuse("selector recovery inventory changed");};
  };
  for(const check of checks)check();assertMutationHandle(target.mutation!,target.store.dir);
  if(!install){target.selectorChecks=[...checks,inventory()];return;}
  for(const file of remove){unlinkSync(file);fsyncDirectory(folder);}
  if(keep.size&&!exists){mkdirSync(folder,{mode:0o700});fsyncDirectory(plans);}
  const retained:(()=>void)[]=[];
  for(const [seal,bytes] of keep){
    const file=join(folder,seal+".json"),stage=file+".pending";
    if(!lstatSync(file,{throwIfNoEntry:false})){
      const staged=lstatSync(stage,{throwIfNoEntry:false});if(staged)selectorEvidence(folder,stage,bytes).check();
      const fd=openSync(stage,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
      try{
        const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>bytes.length)refuse("selector recovery staging unavailable");
        const prefix=readFileSync(fd);if(!prefix.equals(bytes.subarray(0,prefix.length)))refuse("selector recovery staging changed");
        let offset=prefix.length;while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset,offset);if(count<1)refuse("selector recovery write unavailable");offset+=count;}fsyncSync(fd);
        const named=lstatSync(stage);if(named.dev!==stat.dev||named.ino!==stat.ino||named.nlink!==1||named.size!==bytes.length)refuse("selector recovery staging changed");
      }finally{closeSync(fd);}
      if(lstatSync(file,{throwIfNoEntry:false}))refuse("selector recovery copy changed");renameSync(stage,file);fsyncDirectory(folder);
    }else if(lstatSync(stage,{throwIfNoEntry:false})){selectorEvidence(folder,stage,bytes).check();unlinkSync(stage);fsyncDirectory(folder);}
    const evidence=selectorEvidence(folder,file);if(!evidence.bytes.equals(bytes))refuse("selector recovery copy changed");retained.push(evidence.check);
  }
  target.selectorChecks=[...retained,inventory()];assertMutationHandle(target.mutation!,target.store.dir);
}
/** Stream complete authored lines without a permanent file-size/history ceiling. */
function* lines(file: string, claim?: PendingPrune): Generator<string> {
  regular(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd), chunk = Buffer.alloc(64 * 1024), prefixHash = createHash("sha256"), exact = claim ? Buffer.from(claim.line) : undefined;
    if (claim && (before.size < claim.offset || before.size > claim.offset + exact!.length)) refuse("shard sync pending append length mismatch");
    let pending = Buffer.alloc(0), offset = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, offset); if (!n) break;
      const prefix = claim ? Math.min(n, Math.max(0, claim.offset - offset)) : n;
      if (claim) {
        prefixHash.update(chunk.subarray(0, prefix));
        const start = offset + prefix - claim.offset;
        if (prefix < n && !chunk.subarray(prefix, n).equals(exact!.subarray(start, start + n - prefix))) refuse("shard sync pending append bytes mismatch");
      }
      offset += n;
      // Only the complete prefix is authored input. The pending canonical row must be fetched and proved before replay.
      pending = Buffer.concat([pending, chunk.subarray(0, prefix)]);
      let boundary: number;
      while ((boundary = pending.indexOf(10)) >= 0) {
        if (boundary + 1 > SHARD_PACK_MAX_BYTES) refuse("shard sync authored row exceeds wire pack bound");
        const line = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, boundary));
        pending = pending.subarray(boundary + 1); if (line.trim()) yield line;
      }
      if (pending.length > SHARD_PACK_MAX_BYTES) refuse("shard sync authored row exceeds wire pack bound");
    }
    const after = fstatSync(fd), named = lstatSync(file);
    if (claim && prefixHash.digest("hex") !== claim.prefixHash) refuse("shard sync pending append prefix mismatch");
    if (pending.length || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || named.dev !== before.dev || named.ino !== before.ino || offset !== before.size) refuse("shard sync authored segment changed or has an incomplete tail");
  } finally { closeSync(fd); }
}
function sourceRows(store: MemoryStore, realm: ShardSyncRealm): { rows: ShardSyncRow[]; sources: PruneSourceRow[]; pending: PendingPrune[] } {
  const pending = pendingPrunes(store, realm), claims = new Map(pending.filter(claim=>!claim.unclaimed).map(claim => [`${claim.row.machine}.jsonl`, claim]));
  const snapshot = store.prunePort().snapshot();
  const pruned = new Set(snapshot.pruned ?? []);
  // Placement decides transport; the verified snapshot retains separate prune provenance.
  // A local tombstone must prevent the first publication of an unwitnessed original.
  const rows: ShardSyncRow[] = snapshot.rows.filter(source => source.placement === "synced" && (source.publicWitness || !pruned.has(source.row.id))).map(source => source.row);
  const folder = join(store.dir, "log"); directory(folder);
  for (const name of readdirSync(folder).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(name)) refuse(`${shardSyncLabel(realm)}: invalid authored segment name`);
    for (const line of lines(join(folder, name), claims.get(name))) {
      const value = JSON.parse(line) as { schema?: unknown; op?: unknown };
      if (value.schema === "agent-mem.prune/v1") {
        const row = validatePruneRow(value, store.profile.generation, "synced");
        if (name !== `${row.machine}.jsonl`) refuse(`${shardSyncLabel(realm)}: prune author segment mismatch`);
        rows.push(row);
      }
    }
  }
  // Round-trip public originals through the wire validator before touching remote refs or imported rows.
  for (const [path, bytes] of encodeShardPacks(rows)) decodeShardPack(path, bytes, realm, store.profile.generation!);
  return { rows, sources: [...snapshot.rows], pending };
}
function provePrunes(targets: readonly Target[]): void {
  for (const target of targets) {
    for (const pending of target.pending) {
      const fetched = target.rows.get(pending.row.id);
      if (!target.fetched.has(pending.row.id) || !fetched || canonicalJSON(fetched) + "\n" !== pending.line) refuse(`${shardSyncLabel(target.realm)}: pending prune has no exact fetched transport row`);
    }
    // Each physical shard's reducer must be able to prove its own tombstones after restart.
    // A witness present only in another selected realm does not make this realm replayable.
    const sources = new Map<string, PruneSourceRow>();
    for (const source of target.sources) {
      const old = sources.get(source.row.id);
      if (old && canonicalJSON(old.row) !== canonicalJSON(source.row)) refuse(`${shardSyncLabel(target.realm)}: conflicting witness row`);
      if (!old || source.placement === "synced" && source.publicWitness) sources.set(source.row.id, source);
    }
    // Only verified fetched occurrences add public proof. Locally selected exports do not.
    for (const row of target.rows.values()) if (row.op !== "prune" && target.fetched.has(row.id)) {
      const old = sources.get(row.id);
      if (old && canonicalJSON(old.row) !== canonicalJSON(row)) refuse(`${shardSyncLabel(target.realm)}: conflicting witness row`);
      sources.set(row.id, { row, placement: "synced", publicWitness: true });
    }
    const snapshot: PruneSnapshot = { rows: [...sources.values()], expiries: [] };
    const prunes = [...target.rows.values()].filter((row): row is PruneRow => row.op === "prune");
    for (const generation of new Set(prunes.map(row => row.generation))) {
      const proof = reducePruneRows(prunes.filter(row => row.generation === generation).map(row => ({ row, placement: "synced" as const })), snapshot, generation);
      if (proof.invalid || proof.pending.length) refuse(`${shardSyncLabel(target.realm)}: prune lacks complete public witnesses`);
    }
  }
}
function installPack(store: MemoryStore, bytes: Buffer): void {
  const dir = join(store.dir, "log"), file = join(dir, `sync-${digest(bytes)}.jsonl`);
  directory(dir);
  if (existsSync(file)) { regular(file); if (!readFileSync(file).equals(bytes)) refuse("shard sync immutable import conflict"); return; }
  const temporary = join(dir, `.sync-${randomBytes(16).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let written = 0; while (written < bytes.length) { const n = writeSync(fd, bytes, written, bytes.length - written); if (n <= 0) refuse("shard sync import write unavailable"); written += n; }
    fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; regular(file); if (!readFileSync(file).equals(bytes)) refuse("shard sync immutable import conflict"); }
    fsyncDirectory(dir);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
}
function importRows(target: Target): void {
  const port = target.store.prunePort(), before = port.snapshot();
  const known = new Set(before.rows.filter(source => source.placement === "synced" && source.publicWitness).map(source => source.row.id));
  const ordinary = [...target.rows.values()].filter((row): row is Entry => row.op !== "prune" && target.fetched.has(row.id) && !known.has(row.id));
  for (const bytes of encodeShardPacks(ordinary).values()) installPack(target.store, bytes);
  port.refresh();
  const resumed = new Set<string>();
  // The caller has proved all selected refs and atomically published them. Resume originals before other rows of their author.
  for (const pending of [...target.pending]) {
    port.persistPrunePlan(pending.plan);
    if(target.store.profile.foreignPruneFormat)selectorRetention(target,true,true);
    port.appendPrune(pending.row,pending.line,pending.plan.seal);resumed.add(pending.row.id);
    target.pending=target.pending.filter(item=>item.plan.seal!==pending.plan.seal);target.selectorChecks=[];
    if(target.store.profile.foreignPruneFormat)selectorRetention(target,false,true);
  }
  for (const row of target.rows.values()) if (row.op === "prune" && row.generation === target.generation) {
    if (resumed.has(row.id)) continue;
    // A transport imports an already-authored person row without changing its author or generation.
    // Native durable-plan append confirms fsync even for an already parsed id after a crash.
    const plan = importPrunePlan(target.store,target.realm,row),line=canonicalJSON(row)+"\n";
    port.persistPrunePlan(plan);
    if(target.store.profile.foreignPruneFormat&&!before.durablePruneIds?.includes(row.id)){
      target.pending.push({plan,row,line,offset:0,prefixHash:digest(""),unclaimed:true});
      selectorRetention(target,true,true);
    }
    port.appendPrune(row,line,plan.seal);
    target.pending=target.pending.filter(item=>item.plan.seal!==plan.seal);target.selectorChecks=[];
    if(target.store.profile.foreignPruneFormat)selectorRetention(target,false,true);
  }
  port.refresh();
}

/** Receipts are private, immutable transport metadata, outside every native generation reducer.
 * ponytail: foreign targets remain visible; an explicit cross-generation apply protocol must
 * re-prove witnesses and establish a compatible reader floor before lifting this hold ceiling. */
const hasHoldPath = (file: string): boolean => lstatSync(file, { throwIfNoEntry: false }) !== undefined;
function privateHoldPath(file: string, folder: boolean): void {
  if (folder) directory(file); else regular(file);
  if (lstatSync(file).mode & 0o077) refuse("shard sync prune holds require private permissions");
}
function checkPendingHold(file: string, bytes: Buffer): void {
  privateHoldPath(file, false);
  if (lstatSync(file).size > bytes.length || !readFileSync(file).equals(bytes.subarray(0, lstatSync(file).size))) refuse("shard sync partial prune hold conflicts with verified receipt");
}
function installHold(root: string, hold: Hold, phase?: (phase: SyncPhase) => void): void {
  const parts = hold.file.slice(root.length + 1).split("/"), name = parts.pop()!;
  let folder = root;
  for (const part of parts) {
    const parent = folder; folder = join(folder, part);
    if (!hasHoldPath(folder)) mkdirSync(folder, { mode: 0o700 });
    privateHoldPath(folder, true); fsyncDirectory(parent);
  }
  const file = join(folder, name), pending = file + ".pending";
  if (hasHoldPath(file)) {
    privateHoldPath(file, false);
    if (!readFileSync(file).equals(hold.bytes)) refuse("shard sync immutable prune hold conflict");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
    fsyncDirectory(folder); return;
  }
  if (hasHoldPath(pending)) checkPendingHold(pending, hold.bytes);
  const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    // Interrupted private staging bytes may be completed; committed receipts are never rewritten.
    let offset = 0; while (offset < hold.bytes.length) { const n = writeSync(fd, hold.bytes, offset, hold.bytes.length - offset, offset); if (n <= 0) refuse("shard sync prune hold write unavailable"); offset += n; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  phase?.("hold-written");
  // The transport mutation lock serializes this create-once rename. Unlike hard-link installation,
  // a crash cannot leave a committed receipt with a second link that later fails validation.
  if (hasHoldPath(file)) refuse("shard sync prune hold changed concurrently");
  renameSync(pending, file); fsyncDirectory(folder); phase?.("hold-installed");
}
function holdWarning(targets: readonly Target[], root: string): string | undefined {
  const warnings: string[] = [];
  for (const target of targets) if (target.holds.length) {
    const rows = [...target.rows.values()].filter((row): row is PruneRow => row.op === "prune" && row.generation !== target.generation && !target.eligible.has(row.id));
    const ids = [...new Set(rows.flatMap(row => row.targets.map(item => item.id)))].sort(), shown = ids.slice(0, 10);
    const location = target.holds[0]!.file.slice(root.length + 1).split("/").slice(0, -2).join("/");
    warnings.push(`${shardSyncLabel(target.realm)}: ${rows.length} foreign-generation prune(s) held, not applied; targets ${shown.join(",")}${ids.length > shown.length ? ` (+${ids.length - shown.length} more)` : ""} may remain visible; receipts shard-sync/${location}; bring this machine to the origin generation, or prune the entry here as the person`);
  }
  return warnings.length ? warnings.join("; ") : undefined;
}

type ProveHoldSource = (target: Target, receipt: HoldReceipt) => Promise<void>;
async function prepareHold(root: string, url: string, target: Target, row: PruneRow, proveSource: ProveHoldSource): Promise<Hold> {
  const source = target.origins.get(row.id);
  if (!source || !target.remote || !target.fetched.has(row.id)) refuse(`${shardSyncLabel(target.realm)}: foreign prune has no fetched provenance`);
  const receipt: HoldReceipt = { schema: "agent-mem.prune-hold/v1", remote: digest(url), realm: target.realm,
    receivingGeneration: target.generation, row, payloadHash: hashJSON(row), source };
  const folders = ["prune-holds", receipt.remote, digest(shardSyncRef(target.realm)), target.generation, row.generation];
  let folder = root;
  for (const name of folders) { folder = join(folder, name); if (hasHoldPath(folder)) privateHoldPath(folder, true); }
  const file = join(folder, `${row.id}-${receipt.payloadHash}.json`);
  let selected = receipt;
  if (hasHoldPath(file)) {
    privateHoldPath(file, false);
    const value = readProfileJSON(file, HOLD_MAX_BYTES) as HoldReceipt | undefined;
    if (!value || !value.source || Object.keys(value.source).length !== 4 || !OID.test(value.source.commit)
      || !OID.test(value.source.blob) || !PACK.test(value.source.pack)
      || canonicalJSON({ ...value, source }) !== canonicalJSON(receipt)) refuse(`${shardSyncLabel(target.realm)}: invalid prune hold receipt`);
    // A receipt is evidence of a hold, never application authority. Recheck its original
    // immutable source against this invocation's fully audited selected remote history.
    await proveSource(target, value);
    selected = value;
  }
  const bytes = Buffer.from(canonicalJSON(selected) + "\n");
  if (bytes.length > HOLD_MAX_BYTES) refuse("shard sync prune hold exceeds metadata bound");
  if (hasHoldPath(file) && !readFileSync(file).equals(bytes)) refuse("shard sync prune hold is not canonical");
  if (hasHoldPath(file + ".pending")) checkPendingHold(file + ".pending", bytes);
  return { file, bytes };
}
async function prepareHolds(targets: readonly Target[], root: string, url: string, proveSource: ProveHoldSource): Promise<void> {
  for (const target of targets) {
    target.holds = [];
    for (const row of target.rows.values()) if (row.op === "prune" && row.generation !== target.generation) {
      const hold = await prepareHold(root, url, target, row, proveSource);
      if (!target.eligible.has(row.id)) target.holds.push(hold);
    }
  }
}
function mergePackOrigins(into: Map<string, HoldSource>, byRealm: Map<string, Map<string, HoldSource>>, rows: readonly ShardSyncRow[], source: HoldSource): void {
  const first = byRealm.get(source.ref) ?? new Map<string, HoldSource>(); byRealm.set(source.ref, first);
  // Oldest-first history keeps a receipt's source stable across tip advancement and partial-write retry.
  for (const row of rows) {
    if (!first.has(row.id)) first.set(row.id, source);
    if (!into.has(row.id)) into.set(row.id, first.get(row.id)!);
  }
}

/** Sync only borrowed canonical project/user targets. Internal error/phase observers are test-only, never CLI/SyncOptions ports. */
export async function syncShardedMemory(store: MemoryStore, opts: SyncOptions = {}, testOnlyUnexpectedError?: (error: unknown) => void, testOnlyPhase?: (phase: SyncPhase) => void): Promise<SyncResult> {
  let pushed = false, releaseTransport: (() => void) | undefined, releaseSync: (() => void) | undefined;
  const releases: (() => void)[] = [], transient: string[] = [], temporary: string[] = [];
  const v2 = store.profile.foreignPruneFormat === "agent-mem.public-prune-witness/v1";
  let expectedRevision = store.profile.selectorRevision;
  let expectedBinding: string | undefined, expectedSources: string | undefined, expectedPolicy: string | undefined;
  const application: NonNullable<SyncResult["pruneApplication"]> = { transport:"unconfirmed", proofComplete:0, projectionActive:null, nativeApplied:null, held:0, phase:"preflight" };
  const fail = (error: string): SyncResult => ({ ok: false, pushed, entries: 0, error, ...(v2 ? {pruneApplication:{...application,transport:pushed?"durable":"unconfirmed"}} : {}) });
  let root = "", cache = "", targets: Target[] = [], homeMutation:MutationHandle|undefined;
  let boundView:PublicPruneViewV1|undefined;
  const check = () => {
    if (opts.signal?.aborted) refuse("stopped");
    if (expectedBinding !== undefined && (shardSyncBinding(store) !== expectedBinding || shardSyncSourceBinding(store) !== expectedSources || opts.policyVersion?.() !== expectedPolicy)) refuse("shard sync binding or policy changed");
    if(homeMutation)assertMutationHandle(homeMutation,store.profile.home);
    for (const target of targets) {
      if (target.mutation) assertMutationHandle(target.mutation,target.store.dir);
      for(const pending of target.pending)pending.selectorCheck?.();
      for(const check of target.selectorChecks??[])check();
      const profile = target.store.profile;
      const current = resolveShardProfile(profile.home, target.realm.scope === "user" ? { user: true } : { project: target.realm.key });
      if (current.dir !== profile.dir || current.generation !== target.generation || current.selectorRevision !== expectedRevision) refuse(`${shardSyncLabel(target.realm)}: selected profile changed`);
    }
  };
  // Git's auto-maintenance may outlive fetch and remove maintenance.lock during the strict cache walk.
  // ponytail: cache objects retain their full history; any future compaction must hold this transport's mutation/sync locks.
  const gitArgs = (args: string[]) => ["--no-replace-objects", "--git-dir", cache, "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args];
  const git = async (args: string[], signal = opts.signal) => generationSyncGit(root, gitArgs(args), signal);
  const required = async (args: string[], reason: string): Promise<string> => {
    check(); const result = await git(args); check();
    if (result.code !== 0) refuse(reason);
    return result.out;
  };
  try {
    if (opts.signal?.aborted) return fail("stopped");
    if (!store.profile.sharded || store.profile.kind !== "generation") return fail("shard sync requires a selected curated shard");
    expectedBinding = shardSyncBinding(store); expectedSources = shardSyncSourceBinding(store); expectedPolicy = opts.policyVersion?.();
    const borrowed = store.openedSyncTargets();
    targets = borrowed.map(opened => {
      const profile = opened.profile;
      if (!profile.sharded || profile.kind !== "generation" || !profile.generation || !profile.shardUser && !profile.shardKey) refuse("shard sync target identity unavailable");
      return { store: opened, realm: profile.shardUser ? { scope: "user" as const } : { scope: "project" as const, key: profile.shardKey! }, rows: new Map<string, ShardSyncRow>(), fetched: new Set<string>(), sources: [], pending: [], origins: new Map<string, HoldSource>(), holds: [], generation: profile.generation, manifests:new Map(),eligible:new Set(),registered:[] };
    });
    if (!targets.length || targets.length > 2 || targets.some(target => target.store.profile.home !== store.profile.home)
      || new Set(targets.map(target => shardSyncRef(target.realm))).size !== targets.length
      || targets.filter(target => target.realm.scope === "project").some(target => target.realm.scope === "project" && target.realm.key !== store.profile.shardKey)
      || !targets.some(target => target.store === store)) refuse("shard sync selected targets unavailable");
    for (const target of targets) if (target.realm.scope === "project" && isLocalKey(target.realm.key) && opts.remote === undefined) refuse(`${shardSyncLabel(target.realm)}: local project key requires explicit remote opt-in for this invocation`);
    check();
    root = join(store.profile.home, "shard-sync"); cache = join(root, "objects.git");
    if (existsSync(root)) directory(root);
    const independent = async (): Promise<boolean> => {
      if (!existsSync(cache)) return false;
      directory(cache);
      // Reject indirection throughout the owned cache, not only its top-level directory.
      const folders = [cache];
      while (folders.length) {
        const folder = folders.pop()!;
        for (const name of readdirSync(folder)) {
          const file = join(folder, name), stat = lstatSync(file);
          if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) refuse("shard sync cache contains filesystem indirection");
          if (stat.isDirectory()) folders.push(file);
        }
      }
      if (existsSync(join(cache, "commondir")) || existsSync(join(cache, "objects", "info", "alternates")) || existsSync(join(cache, "shallow")) || existsSync(join(cache, "info", "grafts"))) refuse("shard sync cache must be an independent complete bare repository");
      if (await required(["rev-parse", "--is-bare-repository"], "shard sync cache identity unavailable") !== "true") refuse("shard sync cache must be bare");
      const worktree = await git(["config", "--get", "core.worktree"]);
      if (worktree.code !== 1) refuse("shard sync cache worktree routing refused");
      return true;
    };
    const existing = existsSync(root) ? await independent() : false;
    if (!opts.remote && !existing) return fail("no shard sync remote configured");
    const url = opts.remote ?? await required(["remote", "get-url", "origin"], "no shard sync remote configured");
    if (!url || url.length > 4096 || url.startsWith("-") || /[\r\n\0]/.test(url)) return fail("shard sync remote is invalid");
    if (await (opts.visibility ?? remoteVisibility)(url) !== "private") return fail("shard sync requires positively verified private remote visibility");
    check();
    if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 }); directory(root);
    releaseTransport = acquireMutation(root); if (!releaseTransport) return fail("another shard sync mutation is running");
    releaseSync = generationSyncLock(root); if (!releaseSync) return fail("another shard sync is running or its owner is unknown");
    if (!existing) {
      // No worktree or index from the legacy home is ever inherited by this private cache.
      await required(["init", "--bare", "--template=", "--object-format=sha1", "-q", cache], "shard sync cache initialization failed");
    }
    await independent();
    const oldURL = await git(["remote", "get-url", "origin"]);
    if (opts.remote) await required(oldURL.code === 0 ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url], "shard sync remote configuration failed");
    const fetchURLs = (await required(["remote", "get-url", "--all", "origin"], "shard sync fetch destination unavailable")).split("\n");
    const pushURLs = (await required(["remote", "get-url", "--push", "--all", "origin"], "shard sync push destination unavailable")).split("\n");
    if (fetchURLs.length !== 1 || fetchURLs[0] !== url || pushURLs.length !== 1 || pushURLs[0] !== url) refuse("shard sync refuses differing or multiple remote destinations");
    homeMutation = v2 ? acquireMutation(store.profile.home) : undefined;
    if (v2 && !homeMutation) refuse("another home selection mutation is running");
    if (homeMutation) releases.push(homeMutation);
    // Cooperating source writers stay excluded across remote reads and final imports. No nested withMutation calls.
    for (const target of [...targets].sort((a, b) => a.store.dir < b.store.dir ? -1 : 1)) {
      const release = acquireMutation(target.store.dir); if (!release) refuse(`${shardSyncLabel(target.realm)}: another source mutation is running`); releases.push(release); target.mutation=release;
      if (v2) ensurePublisherBoundary(target.store.profile,release);
    }
    const blobCache = new Map<string, Buffer>(), decoded = new Map<string, ShardSyncRow[]>();
    const blob = async (object: string, path: string): Promise<Buffer> => {
      const maximum = path === "shard.json" || isShardManifestPath(path) ? 64 * 1024 : SHARD_PACK_MAX_BYTES, prior = blobCache.get(object);
      if (prior) { if (prior.length > maximum) refuse("shard sync blob exceeds its bound"); return prior; }
      const size = Number(await required(["cat-file", "-s", object], "shard sync blob size unavailable"));
      if (!Number.isSafeInteger(size) || size < 1 || size > maximum) refuse("shard sync blob exceeds its bound");
      check(); const result = await generationSyncGitBytes(root,gitArgs(["cat-file","blob",object]),opts.signal,undefined,maximum); check();
      if(result.code!==0)refuse("shard sync blob unavailable"); const bytes=Buffer.from(result.out);
      if (bytes.length !== size || bytes.at(-1) !== 10) refuse("shard sync requires complete newline-terminated public blobs");
      const identity = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (identity !== object) refuse("shard sync public blob identity mismatch");
      blobCache.set(object, bytes); return bytes;
    };
    type History = { rows: Map<string, ShardSyncRow>; files: Map<string, Buffer>; origins: Map<string, HoldSource>; version:"v1"|"v2"; manifests:Map<string,SyncManifest> };
    // Keep only requested tips. Per-commit full row maps would make append-only history quadratic in memory.
    const histories = new Map<string, History>(), audited = new Set<string>();
    const firstOrigins = new Map<string, Map<string, HoldSource>>();
    const manifestOrigins = new Map<string,{commit:string;blob:string}>();
    const treeState = async (commit: string, target: Target): Promise<History> => {
      const entries=(await required(["ls-tree","-r","-z",commit],"shard sync tree unavailable")).split("\0").filter(Boolean);
      const rows=new Map<string,ShardSyncRow>(),files=new Map<string,Buffer>(),origins=new Map<string,HoldSource>(),objects=new Map<string,string>(),manifests=new Map<string,SyncManifest>();
      for(const entry of entries){
        const match=/^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
        if(!match||match[0]!==entry||match[2]!=="shard.json"&&!PACK.test(match[2]!)&&!isShardManifestPath(match[2]!))refuse(`${shardSyncLabel(target.realm)}: forbidden historical tree entry`);
        const path=match[2]!,oid=match[1]!,bytes=await blob(oid,path);files.set(path,bytes);objects.set(path,oid);
      }
      const descriptor=files.get("shard.json");if(!descriptor)refuse(`${shardSyncLabel(target.realm)}: historical descriptor missing`);
      const version=decodeShardDescriptor(descriptor,target.realm);
      if(version==="v2"&&!v2)refuse("remote shard requires the explicitly activated public prune view");
      for(const [path,bytes] of files)if(PACK.test(path)){
        const oid=objects.get(path)!,key=`${shardSyncRef(target.realm)}:${oid}`;let pack=decoded.get(key);
        if(!pack){pack=decodeShardPack(path,bytes,target.realm,target.generation);decoded.set(key,pack);}
        else if(!path.endsWith(`/${digest(bytes)}.jsonl`)||pack.some(row=>path!==`rows/${digest(row.machine)}/${digest(bytes)}.jsonl`))refuse("immutable pack path changed");
        mergeRows(rows,pack,target.realm);mergePackOrigins(origins,firstOrigins,pack,{ref:shardSyncRef(target.realm),commit,pack:path,blob:oid});
      }
      for(const [path,bytes] of files)if(isShardManifestPath(path)){
        if(version!=="v2")refuse("a v1 tree cannot contain prune manifests");
        const value=decodeShardManifest(path,bytes),candidate=value as {prune?:unknown;pruneOccurrence?:{pack:string;blob:string};witnesses?:{pack:string;blob:string}[]};
        const row=validatePruneRow(candidate.prune,undefined,"synced");
        if(canonicalJSON(rows.get(row.id))!==canonicalJSON(row))refuse("manifest original prune is missing or conflicts");
        if(!candidate.pruneOccurrence||!Array.isArray(candidate.witnesses))refuse("manifest references unavailable");
        const selected=new Map<string,{pack:string;blob:string;bytes:Buffer}>();
        for(const ref of [candidate.pruneOccurrence,...candidate.witnesses]){
          if(!ref||typeof ref.pack!=="string"||objects.get(ref.pack)!==ref.blob||!files.has(ref.pack))refuse("manifest complete pack is unavailable");
          selected.set(ref.pack,{pack:ref.pack,blob:ref.blob,bytes:files.get(ref.pack)!});
        }
        const proof=verifyPublicPruneWitness(value,{realm:target.realm,packs:[...selected.values()]});
        if(proof.status==="invalid")refuse("manifest lacks complete original public proof");
        const identity=`${shardSyncRef(target.realm)}:${path}`,origin=manifestOrigins.get(identity)??{commit,blob:objects.get(path)!};manifestOrigins.set(identity,origin);
        manifests.set(path,{path,bytes,value,row,eligible:proof.status==="verified",...origin});
      }
      return{rows,files,origins,version,manifests};
    };
    const history = async (tip: string, target: Target): Promise<History> => {
      const key = `${shardSyncRef(target.realm)}:${tip}`, cached = histories.get(key); if (cached) return cached;
      const commits = (await required(["rev-list", "--topo-order", "--reverse", "--parents", tip], "shard sync history unavailable")).split("\n").filter(Boolean);
      let latest: History | undefined;
      // ponytail: complete selected history still costs time and selected pack memory per invocation.
      // Upgrade: a validated immutable commit/blob digest cache, never an arbitrary lifetime refusal cliff.
      for (const line of commits) {
        const [commit, ...parents] = line.split(" ");
        if (!commit || !OID.test(commit) || parents.some(parent => !OID.test(parent))) refuse("shard sync history identity invalid");
        const identity = `${shardSyncRef(target.realm)}:${commit}`;
        if (audited.has(identity)) { if (commit === tip) latest = await treeState(commit, target); continue; }
        const current = await treeState(commit, target);
        for (const parent of parents) {
          if (!audited.has(`${shardSyncRef(target.realm)}:${parent}`)) refuse(`${shardSyncLabel(target.realm)}: historical parent unavailable`);
          const previous = histories.get(`${shardSyncRef(target.realm)}:${parent}`) ?? await treeState(parent, target);
          if(previous.version==="v2"&&current.version!=="v2")refuse("shard history cannot downgrade from v2");
          if(previous.version==="v2")for(const [path,bytes] of previous.files)if(path!=="shard.json"&&!current.files.get(path)?.equals(bytes))refuse("immutable v2 history artifact removed or changed");
          for (const row of previous.rows.values()) if (canonicalJSON(current.rows.get(row.id)) !== canonicalJSON(row)) refuse(`${shardSyncLabel(target.realm)}: historical original row removed or replaced`);
        }
        audited.add(identity); if (commit === tip) latest = current;
      }
      if (!latest) refuse("shard sync history unavailable");
      histories.set(key, latest); return latest;
    };
    const fetchTargets = async (): Promise<void> => {
      for (const target of targets) {
        const ref = shardSyncRef(target.realm);
        const symbolic = await git(["symbolic-ref", "--quiet", ref]); check();
        if (symbolic.code !== 1) refuse(`${shardSyncLabel(target.realm)}: selected cache ref must be direct`);
        const local = await git(["rev-parse", "--verify", "--quiet", ref]);
        if (local.code === 0) { if (!OID.test(local.out)) refuse("shard sync cached ref invalid"); target.local = local.out; await history(local.out, target); }
        else if (local.code !== 1) refuse("shard sync cached ref unavailable");
        const advertised = await git(["ls-remote", "--symref", "--exit-code", "--refs", "origin", ref]); check();
        if (advertised.code === 2) { if (target.local) refuse(`${shardSyncLabel(target.realm)}: previously synced remote ref disappeared`); target.remote = undefined; continue; }
        const fields = advertised.out.split("\t");
        if (advertised.code !== 0 || fields.length !== 2 || !OID.test(fields[0]!) || fields[1] !== ref) refuse(`${shardSyncLabel(target.realm)}: remote ref lookup unavailable`);
        const incoming = `refs/amem/shard-incoming/${randomBytes(16).toString("hex")}`; transient.push(incoming);
        await required(["fetch", "-q", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "origin", `${ref}:${incoming}`], "shard sync fetch failed");
        await independent();
        const tip = await required(["rev-parse", "--verify", incoming], "shard sync incoming ref unavailable");
        if (!OID.test(tip)) refuse("shard sync incoming ref invalid");
        if (target.local) await required(["merge-base", "--is-ancestor", target.local, tip], `${shardSyncLabel(target.realm)}: remote history is not fast-forward`);
        const remote = await history(tip, target); target.remote = tip;
        mergeRows(target.rows, Array.from(remote.rows.values()), target.realm);
        target.manifests=new Map(remote.manifests);target.eligible=new Set([...remote.manifests.values()].filter(item=>item.eligible).map(item=>item.row.id));
        for (const row of remote.rows.values()) { target.fetched.add(row.id); target.origins.set(row.id, remote.origins.get(row.id)!); }
      }
    };
    const localTargets = () => {
      check();
      for (const target of targets) {
        const source = sourceRows(target.store, target.realm); target.sources = source.sources; target.pending = source.pending;
        mergeRows(target.rows, source.rows, target.realm);
      }
    };
    const writeBlob = async (bytes: Buffer): Promise<string> => {
      const file = join(root, `.blob-${randomBytes(16).toString("hex")}`); temporary.push(file);
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (n <= 0) refuse("shard sync blob write unavailable"); offset += n; } fsyncSync(fd); } finally { closeSync(fd); }
      return required(["hash-object", "-w", "--no-filters", "--", file], "shard sync blob creation failed");
    };
    const buildTargets = async () => {
      for (const target of targets) {
        const remote = target.remote ? await history(target.remote, target) : undefined;
        const files = new Map(remote?.files);
        files.set("shard.json", Buffer.from(shardSyncDescriptor(target.realm,v2?"v2":"v1")));
        // Retain immutable packs and append only new ids; repacking every prefix would duplicate the entire history at each sync.
        const additions = [...target.rows.values()].filter(row => !remote?.rows.has(row.id));
        for (const [path, bytes] of encodeShardPacks(additions)) {
          const old = files.get(path); if (old && !old.equals(bytes)) refuse(`${shardSyncLabel(target.realm)}: immutable pack conflict`); files.set(path, bytes);
        }
        if(v2){
          assertPublisherBoundary(target.store.profile,target.mutation!);
          const occurrences=new Map<string,{pack:string;blob:string}>();
          for(const [path,bytes] of files)if(PACK.test(path))for(const row of decodeShardPack(path,bytes,target.realm,target.generation))if(!occurrences.has(row.id))occurrences.set(row.id,{pack:path,blob:createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")});
          const manifested=new Set([...target.manifests.values()].map(item=>item.row.id));
          const candidates=[...target.rows.values()].filter((row):row is PruneRow=>row.op==="prune"&&row.generation===target.generation&&!target.fetched.has(row.id)&&!manifested.has(row.id));
          const lineages=publisherPruneLineages(target.store.profile,target.mutation!,candidates);
          for(const row of candidates){
            const lineage=lineages.get(row.id);if(!lineage)continue;
            const own=occurrences.get(row.id);if(!own)refuse("original prune occurrence unavailable");
            const needed=new Map<string,string>();for(const entry of row.targets)for(const ref of [entry,entry.basis])needed.set(ref.id,ref.rowHash);
            const witnesses=[...needed].sort(([a],[b])=>a<b?-1:1).map(([id,rowHash])=>{const location=occurrences.get(id);if(!location)refuse("public witness occurrence unavailable");return{...location,id,rowHash};});
            const manifest:PublicPruneWitnessV1={schema:"agent-mem.public-prune-witness/v1",realm:target.realm,prune:row,lineage,pruneOccurrence:own,witnesses};
            const encoded=encodeShardManifest(manifest);const packs=new Map([own,...witnesses].map(ref=>[ref.pack,{pack:ref.pack,blob:ref.blob,bytes:files.get(ref.pack)!}]));
            if(verifyPublicPruneWitness(manifest,{realm:target.realm,packs:[...packs.values()]}).status!=="verified")refuse("publisher manifest proof unavailable");files.set(encoded.path,encoded.bytes);
          }
        }
        await required(["read-tree", "--empty"], "shard sync private index unavailable");
        for (const [path, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : 1)) {
          const object = await writeBlob(bytes);
          if (!OID.test(object)) refuse("shard sync blob identity invalid");
          await required(["update-index", "--add", "--cacheinfo", `100644,${object},${path}`], "shard sync private tree staging failed");
        }
        const tree = await required(["write-tree"], "shard sync private tree unavailable");
        if (target.remote && await required(["rev-parse", `${target.remote}^{tree}`], "shard sync remote tree unavailable") === tree) { target.commit = target.remote; continue; }
        const who = ["-c", "user.name=agent-mem", "-c", "user.email=agent-mem@sync.invalid"];
        target.commit = await required([...who, "commit-tree", tree, ...(target.remote ? ["-p", target.remote] : []), "-m", "memory: shard append"], "shard sync commit failed");
        if (!OID.test(target.commit)) refuse("shard sync commit identity invalid");
        await history(target.commit, target);
      }
    };
    const proveHoldSource: ProveHoldSource = async (target, value) => {
      await required(["merge-base", "--is-ancestor", value.source.commit, target.remote!], "shard sync prune hold source is not remote history");
      const original = await history(value.source.commit, target), bytes = original.files.get(value.source.pack);
      if (!bytes || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== value.source.blob
        || !decodeShardPack(value.source.pack, bytes, target.realm, target.generation).some(item => canonicalJSON(item) === canonicalJSON(value.row))
        || value.source.ref !== shardSyncRef(target.realm)) refuse(`${shardSyncLabel(target.realm)}: prune hold source mismatch`);
    };
    const loadExistingApplications = async () => {
      if(!v2)return;
      const selected=readSelector(store.profile.home).selector;if(selected?.schema!=="agent-mem.profile/v2")refuse("selected v2 profile unavailable");
      boundView=readPublicPruneView(store.profile.home,selected.pruneInputSetHash,store.profile.generation!);
      for(const target of targets){
        target.registered=[];const key=target.realm.scope==="user"?"user":`project:${target.realm.key}`,set=boundView.realms[key];if(!set)continue;
        const projection=reducePublicPruneInputs({dir:target.store.dir,realm:target.realm,receivingGeneration:target.generation,inputSetHash:set});
        for(const hash of projection.inputs){
          const descriptor=readPublicPruneInputDescriptor({dir:target.store.dir,hash});
          if(!target.remote||descriptor.source.remoteHash!==digest(url))refuse("registered prune source history disappeared or its remote binding changed");
          await required(["merge-base","--is-ancestor",descriptor.source.commit,target.remote],"registered prune source is missing from replacement history");
          const original=await history(descriptor.source.commit,target),manifest=original.manifests.get(descriptor.source.manifestPath);
          if(!manifest||!manifest.eligible||manifest.blob!==descriptor.source.manifestBlob||descriptor.source.ref!==shardSyncRef(target.realm)||digest(canonicalJSON(manifest.value))!==descriptor.witnessHash)refuse("registered prune anchor no longer has exact audited evidence");
          target.registered.push(descriptor);
        }
      }
    };
    const objectCache=new Map<string,{type:"commit"|"tree"|"blob";body:Uint8Array}>(), graphObjects=new Map<string,Uint8Array>();
    // ponytail: one sync retains at most the 256 MiB replay budget across selected realms; segmented acquisition is the upgrade.
    let objectBytes=0;
    const readObject=async(oid:string)=>{
      const prior=objectCache.get(oid);if(prior)return prior;
      if(OID.exec(oid)?.[0]!==oid)refuse("Git object identity invalid");
      const type=await required(["cat-file","-t",oid],"Git object type unavailable");
      if(type!=="commit"&&type!=="tree"&&type!=="blob")refuse("Git object type refused");
      const size=Number(await required(["cat-file","-s",oid],"Git object size unavailable")),limit=type==="commit"?65536:SHARD_PACK_MAX_BYTES;
      if(!Number.isSafeInteger(size)||size<0||size>limit)refuse("Git object exceeds complete evidence bound");
      const encodedSize=Buffer.byteLength(`${type} ${size}`)+1+size;
      if(objectBytes+encodedSize>PUBLIC_PRUNE_REPLAY_MAX_BYTES)throw new PublicPruneInputError("resource");
      check();const result=await generationSyncGitBytes(root,gitArgs(["cat-file",type,oid]),opts.signal,undefined,limit);check();
      if(result.code!==0||result.out.length!==size)refuse("Git object bytes unavailable");
      const value:{type:"commit"|"tree"|"blob";body:Uint8Array}={type:type as "commit"|"tree"|"blob",body:result.out};objectBytes+=encodedSize;objectCache.set(oid,value);return value;
    };
    const prepareApplications = async () => {
      if(!v2)return;application.proofComplete=0;application.held=0;
      for(const target of targets){
        const current=await history(target.commit!,target);target.manifests=new Map(current.manifests);
        target.eligible=new Set([...current.manifests.values()].filter(item=>item.eligible).map(item=>item.row.id));
        application.proofComplete+=target.eligible.size;
        const key=target.realm.scope==="user"?"user":`project:${target.realm.key}`,initial=boundView!.realms[key]??null;
        const inputs=[];
        for(const record of [...current.manifests.values()].sort((a,b)=>a.path<b.path?-1:1)){
          if(!record.eligible||record.row.generation===target.generation)continue;
          const witnessHash=digest(canonicalJSON(record.value));
          if(target.registered.some(item=>item.witnessHash===witnessHash))continue;
          if(inputs.length>=PUBLIC_PRUNE_MAX_SETS)throw new PublicPruneInputError("resource");
          const acquired=await collectPublicPruneGitGraph({commit:record.commit,manifestPath:record.path,manifestBlob:record.blob,realm:target.realm,readObject});
          // Share exact raw objects before accumulating inputs; repeated manifests cannot multiply graph memory.
          const objects=acquired.map(item=>{
            const prior=graphObjects.get(item.oid);if(prior&&!Buffer.from(prior).equals(item.bytes))refuse("conflicting Git graph bytes");
            const bytes=prior??item.bytes;graphObjects.set(item.oid,bytes);
            const cached=objectCache.get(item.oid)!;objectCache.set(item.oid,{type:cached.type,body:bytes.subarray(bytes.indexOf(0)+1)});return{oid:item.oid,bytes};
          });
          inputs.push({witnessHash,source:{remoteHash:digest(url),ref:shardSyncRef(target.realm),commit:record.commit,manifestPath:record.path,manifestBlob:record.blob},objects});
        }
        target.batch=undefined;
        if(inputs.length){
          const binding={realm:target.realm,receivingGeneration:target.generation,selectorRevision:expectedRevision,inputSetHash:initial};
          target.batch=preparePublicPruneInputBatch({dir:target.store.dir,binding,current:()=>{check();return{...binding,selectorRevision:expectedRevision};},inputs},target.mutation!);
        }
      }
      await prepareHolds(targets,root,url,proveHoldSource);application.held=targets.reduce((n,item)=>n+item.holds.length,0);application.phase="prepared";
    };
    const installApplications = async () => {
      if(!v2)return;
      const realms={...boundView!.realms};
      for(const target of targets)if(target.batch){
        const installed=persistPublicPruneInputBatch(target.batch,{mutation:target.mutation!,observe:()=>check()});
        realms[target.realm.scope==="user"?"user":`project:${target.realm.key}`]=installed.inputSetHash;testOnlyPhase?.("inputs-installed");
      }
      const view:PublicPruneViewV1={...boundView!,realms};
      const changed=canonicalJSON(view)!==canonicalJSON(boundView);
      if(changed){
        for(const target of targets)selectorRetention(target,true,true);
        const result=await advancePublicPruneView({memoryDir:store.profile.home,view,expectedRevision,mutations:[homeMutation!,...targets.map(item=>item.mutation!)]});
        expectedRevision=result.revision;boundView=view;
        // The same open handles validate/rebind; no close/reopen or authority flag is used.
        for(const target of targets)target.store.refresh();
        if(shardSyncSourceBinding(store)!==expectedSources||opts.policyVersion?.()!==expectedPolicy)refuse("source binding or policy changed during view commit");
        expectedBinding=shardSyncBinding(store);
        testOnlyPhase?.("view-committed");
      }
      application.projectionActive=targets.reduce((n,target)=>n+[...target.eligible].filter(id=>(target.rows.get(id) as PruneRow).generation!==target.generation).length,0);application.phase="active";check();
    };
    localTargets(); await fetchTargets(); localTargets(); provePrunes(targets); await loadExistingApplications(); await prepareHolds(targets, root, url, proveHoldSource); check();
    // Every selected realm, including its complete remote history/prunes, is preflighted before the first append or publication.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) { await fetchTargets(); localTargets(); provePrunes(targets); await loadExistingApplications(); await prepareHolds(targets, root, url, proveHoldSource); check(); }
      await buildTargets(); await prepareApplications(); check();
      if(v2)for(const target of targets){
        const durable=new Set(target.store.prunePort().snapshot().durablePruneIds),reserve=[...target.rows.values()].some(row=>row.op==="prune"&&row.generation===target.generation&&!durable.has(row.id));
        // Existing pending plans complete before fresh native rows, so only one serial new-plan slot is reserved.
        selectorRetention(target,targets.some(item=>!!item.batch),false,reserve);
      }
      if(v2)for(const target of targets)assertPublisherBoundary(target.store.profile,target.mutation!);
      const sent = await git(["push", "--atomic", "--no-follow-tags", "-q", "origin", ...targets.map(target => `${target.commit!}:${shardSyncRef(target.realm)}`)]);
      if (sent.code === 0) pushed = true;
      check();
      if (sent.code === 0) {
        pushed = true;
        // No local append before a successful atomic publication: a raced foreign prune can still refuse the entire retry safely.
        localTargets(); provePrunes(targets); check(); testOnlyPhase?.("published");
        // No selected ordinary/native imports can precede durable receipts for every foreign prune.
        for (const target of targets) for (const hold of target.holds) installHold(root, hold, testOnlyPhase);
        check();
        await installApplications();
        for (const target of targets) {
          assertCuratedShardPaths(target.store.profile.home, target.realm.scope === "user" ? { user: true } : { project: target.realm.key });
          importRows(target);
          target.pending=[];target.selectorChecks=[];
          if(v2)selectorRetention(target,false,true);
          testOnlyPhase?.("imported");
        }
        for (const target of targets) await required(["update-ref", "--no-deref", shardSyncRef(target.realm), target.commit!, target.local ?? zero], "shard sync cached ref changed concurrently");
        const warning = holdWarning(targets, root);
        if(v2){application.nativeApplied=targets.reduce((n,target)=>n+[...target.rows.values()].filter(row=>row.op==="prune"&&row.generation===target.generation).length,0);application.phase="complete";application.transport="durable";}
        return { ok: true, pushed, entries: targets.reduce((n, target) => n + [...target.rows.values()].filter(row => row.op === "note").length, 0),
          ...(warning ? { warning } : {}), ...(v2?{pruneApplication:application}:{}) };
      }
      if (opts.signal?.aborted) return fail("stopped");
    }
    return fail("shard sync selected-ref push failed");
  } catch (error) {
    if (error instanceof PublicPruneInputError || error instanceof ShardSyncFormatError || error instanceof SyncRefusal) return fail(error.message);
    try { testOnlyUnexpectedError?.(error); } catch { /* A test observer cannot change the neutral result. */ }
    return fail("shard sync unavailable");
  } finally {
    for (const ref of transient) { try { await generationSyncGit(root, gitArgs(["update-ref", "--no-deref", "-d", ref]), undefined); } catch { /* private orphaned refs remain non-public */ } }
    for (const file of temporary) { try { rmSync(file, { force: true }); } catch { /* private diagnostic bytes never enter a public tree */ } }
    for (const release of releases.reverse()) { try { release(); } catch { /* fail-open cleanup */ } }
    try { releaseSync?.(); } catch { /* private lock cleanup */ }
    try { releaseTransport?.(); } catch { /* private lock cleanup */ }
  }
}
