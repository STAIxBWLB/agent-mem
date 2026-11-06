import type { PlacementPublicationSource } from "./sync-placement-publication-plan.ts";
import { validatePlacementKey, type PlacementRealm } from "./sync-placement-journal-format.ts";
import { types } from "node:util";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, generationDescriptor, hashJSON, validateVaultLinkRow, type BoundProfile, type VaultLinkRow } from "./generation.ts";
import { validatePlacementBaseV2, validatePlacementProfile, validatePlacementShards, PLACEMENT_PROFILE_SCHEMA } from "./sync-placement-format.ts";
import { planSyncPlacementActivation, type SyncPlacementActivationContext, type SyncPlacementWriterAttestation } from "./sync-placement-plan.ts";
import { readPublicPruneViewForActivation, PUBLIC_PRUNE_INTENT } from "./public-prune-view.ts";
import { realPath, DENY_NAMES, DENY_SEGMENTS } from "./platform.ts";
import { loadAmemConfig } from "./config.ts";
import { memoryPolicySnapshot } from "./policy.ts";
import { SegmentReader, SegmentReadBudgetError, checkedEntry, completeLines } from "./bridge.ts";
import { readShardLegacySnapshot } from "./shard-bridge.ts";
import { coalesceGenerationSource } from "./generation-index.ts";
import { validatePruneRow, type PruneSourceRow, type PruneRow } from "./prune.ts";
import { shardKeyHash, SHARD_SCHEMA } from "./shard.ts";
import { SyncPlacementJournalError, placementKeyId, type PlacementKey } from "./sync-placement-journal-format.ts";
import type { Entry } from "./store.ts";
import { assertPlacementRuntime } from "./sync-placement-guard.ts";
import { activationSourceMarkers, type PlacementActivationCaptureProof } from "./sync-placement-activation-proof.ts";
import { readEffectiveSyncPlacementWriters, writerBoundPlacementContextHash, writerInventoryEvidence, type EffectiveSyncPlacementWriters } from "./sync-placement-effective-writers.ts";
import { SharedWriterRevisionError } from "./sync-placement-writer-revision-format.ts";

/** Host authentication/compatibility facts are re-read at every effect boundary, never inferred from a session marker. */
export interface PlacementCapturePort {
  attest(): { writers: readonly SyncPlacementWriterAttestation[]; legacySyncQuiesced: true };
  /** Required when a caller adds a policy callback; must change whenever its policy changes. */
  policyVersion?(): string;
}
/** Internal actual-transport proof, admitted only after the native pending plan and fetched original were validated. */
export interface PlacementPendingSource { realm: PlacementRealm; pathHash: string; offset: number; prefixHash: string; line: string }
export interface PlacementSourceRow { key: PlacementKey; row: Entry; sourcePlacement: "local" | "synced"; intrinsicLocal: boolean }
export interface PlacementSpecialSourceRow { key: PlacementKey; row: PruneRow | VaultLinkRow; sourcePlacement: "local" | "synced"; intrinsicLocal: boolean }
export interface PlacementCapture {
  home: string; context: SyncPlacementActivationContext; activeHead?: string;
  markerHash: string; fingerprint: string; directories: string[]; prefixes: PlacementPublicationSource[]; rows: Map<string, PlacementSourceRow>;
  /** Diagnostic inventory only; these rows never enter the ordinary transport/capture row map implicitly. */
  specialRows: Map<string, PlacementSpecialSourceRow>;
  sourceRowsByRealm: Map<string, readonly PruneSourceRow[]>;
  writerInventory?:EffectiveSyncPlacementWriters;
  assertCurrent(): void;
  /** Under live writer fences, inode/ctime/size checks protect the already-hashed prefixes across callbacks without reparsing rows. */
  assertUnchanged(): void;
}
export function placementCaptureContextHash(capture:Pick<PlacementCapture,"context"|"writerInventory">):string{return writerBoundPlacementContextHash(capture.context,capture.writerInventory);}
export interface PlacementActivationMarkerSnapshot {
  profileText: string; shardsText: string; profileStamp: [string,string,string,string,string]; shardsStamp: [string,string,string,string,string];
}
/** Source facts only: no writer attestation, quiescence claim or effect authority. */
export interface PlacementSourcePreview {
  home: string; base: Omit<SyncPlacementActivationContext, "writers" | "legacySyncQuiesced">;
  activeHead?: string; markerHash: string; markers: PlacementActivationMarkerSnapshot; directories: string[]; prefixes: PlacementPublicationSource[];
  rows: Map<string, PlacementSourceRow>; specialRows: Map<string, PlacementSpecialSourceRow>;
  sourceRowsByRealm: Map<string, readonly PruneSourceRow[]>; assertSourcesUnchanged(): void;
}
function fail(code: "changed" | "invalid" | "bound" = "changed"): never { throw new SyncPlacementJournalError(code); }
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);
const same = (a: BigIntStats, b: BigIntStats) => canonicalJSON(stamp(a)) === canonicalJSON(stamp(b));
function ownedDirectory(dir: string): BigIntStats {
  const s = lstatSync(dir, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== BigInt(process.getuid!()) || (s.mode & 0o022n) !== 0n) fail();
  return s;
}
/** ponytail: capture is capped at 256 metadata objects and 8 MiB/20000 source rows across all realms.
 * Larger homes need a reviewed chunked activation proof; no input is silently omitted at this ceiling. */
function sourcePreview(homeInput: string, selected?: readonly PlacementRealm[], pending: readonly PlacementPendingSource[] = [], policyVersion?: string, ownerProof?: PlacementActivationCaptureProof): PlacementSourcePreview {
  let selection: PlacementRealm[] | undefined;
  if (selected !== undefined) {
    if (!Array.isArray(selected) || types.isProxy(selected) || selected.length > 256) fail("bound");
    const copied = memoryPolicySnapshot(selected); if (!copied) fail();
    selection = copied.map(realm => validatePlacementKey({ realm, id: "0".repeat(32), rowHash: "0".repeat(64) }).realm);
    if (!selection.length || new Set(selection.map(realm => canonicalJSON(realm))).size !== selection.length) fail();
  }
  const home = realPath(homeInput), root = ownedDirectory(home);
  let metadataObjects = 0, metadataBytes = 0;
  const facts: unknown[] = [], sourceChecks: (() => void)[] = [];
  const pendingByPath = new Map(pending.map(item => [canonicalJSON(item.realm)+":"+item.pathHash,item]));
  if (pendingByPath.size !== pending.length) fail();
  const directoryFact = (dir: string) => {
    const stat = ownedDirectory(dir); facts.push([dir, "directory", String(stat.dev), String(stat.ino), String(stat.uid)]);
    sourceChecks.push(() => { const now=ownedDirectory(dir); if(now.dev!==stat.dev||now.ino!==stat.ino) fail(); });
  };
  const bytes = (file: string, optional = false): Buffer | undefined => {
    const before = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!before) { if (!optional) fail(); facts.push([file, null]); sourceChecks.push(() => { if(lstatSync(file,{throwIfNoEntry:false})) fail(); }); return undefined; }
    if (++metadataObjects > 256 || before.size > 262144n || metadataBytes + Number(before.size) > 8 * 1024 * 1024) fail("bound");
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== root.uid || (before.mode & 0o022n) !== 0n) fail();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true }); if (!same(before, opened)) fail();
      const out = Buffer.alloc(Number(opened.size)); let at = 0;
      while (at < out.length) { const count = readSync(fd, out, at, out.length - at, at); if (!count) fail(); at += count; }
      const after = lstatSync(file, { bigint: true }); if (!same(opened, fstatSync(fd, { bigint: true })) || !same(opened, after)) fail();
      metadataBytes += out.length; facts.push([file, stamp(opened), digest(out)]);
      sourceChecks.push(() => { const now=lstatSync(file,{bigint:true}); if(!now.isFile()||now.isSymbolicLink()||now.nlink!==1n||!same(opened,now)) fail(); }); return out;
    } finally { closeSync(fd); }
  };
  const json = (file: string, optional = false): any => {
    const input = bytes(file, optional); if (!input) return undefined;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
  };
  const markerStart = facts.length;
  const profileBytes = bytes(join(home, "profile.json"))!, shardsBytes = bytes(join(home, "shards.json"))!;
  const actualMarkers: PlacementActivationMarkerSnapshot = { profileText: profileBytes.toString("utf8"), shardsText: shardsBytes.toString("utf8"),
    profileStamp: [...(facts[markerStart] as [string,PlacementActivationMarkerSnapshot["profileStamp"],string])[1]], shardsStamp: [...(facts[markerStart+1] as [string,PlacementActivationMarkerSnapshot["shardsStamp"],string])[1]] };
  const markers = ownerProof ? activationSourceMarkers(ownerProof,home,actualMarkers) : actualMarkers;
  if (ownerProof) {
    facts[markerStart] = [join(home,"profile.json"),markers.profileStamp,digest(Buffer.from(markers.profileText))];
    facts[markerStart+1] = [join(home,"shards.json"),markers.shardsStamp,digest(Buffer.from(markers.shardsText))];
  }
  const decodeMarker = (text: string): unknown => JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.from(text)));
  const rawProfile = decodeMarker(markers.profileText) as { schema?: string }, rawShards = decodeMarker(markers.shardsText);
  let activeHead: string | undefined;
  let base: ReturnType<typeof validatePlacementBaseV2>;
  if (rawProfile?.schema === PLACEMENT_PROFILE_SCHEMA) {
    const profile = validatePlacementProfile(rawProfile), shards = validatePlacementShards(rawShards, profile);
    activeHead = profile.placementHead;
    const { publicationFormat: _pf, placementHead: _ph, ...p } = profile;
    const profile2 = { ...p, schema: "agent-mem.profile/v2" };
    const { publicationFormat: _sf, placementHead: _sh, ...s } = shards;
    base = validatePlacementBaseV2(profile2, { ...s, schema: "agent-mem.shards/v2", selectorRevision: hashJSON(profile2) });
  } else base = validatePlacementBaseV2(rawProfile, rawShards);
  const markerHash = hashJSON({ profile: rawProfile, shards: rawShards });
  bytes(join(home, "public-prune-input-sets", `${base.profile.pruneInputSetHash}.json`));
  readPublicPruneViewForActivation(home, base.profile.pruneInputSetHash, base.profile.generation);
  const aliases = bytes(join(home, "aliases.jsonl"), true);
  bytes(join(home, "amem.config.json"), true);
  const machine = json(join(home, "machine.json"));
  if (machine?.id !== base.shards.machine.id) fail();
  // An in-flight migration/prune is never accepted as a stable placement source.
  for (const name of ["profile.lock", PUBLIC_PRUNE_INTENT]) {
    if (name === "profile.lock" && ownerProof) continue; // The module-private proof validated this exact live owner and sealed intent.
    if (lstatSync(join(home,name),{throwIfNoEntry:false})) fail();
  }
  const reader = new SegmentReader(16 * 1024 * 1024, { maxSourceBytes: 8 * 1024 * 1024, maxRows: 20000 });
  const rows = new Map<string, PlacementSourceRow>(), specialRows = new Map<string, PlacementSpecialSourceRow>(), sourceRowsByRealm = new Map<string, readonly PruneSourceRow[]>();
  const directories = [home], prefixes: PlacementPublicationSource[] = [];
  const realms: SyncPlacementActivationContext["realms"][number][] = [];
  const listing = (dir: string, optional = false): string[] => {
    const s = lstatSync(dir, { throwIfNoEntry: false });
    if (!s) { if (!optional) fail(); facts.push([dir, null]); sourceChecks.push(() => {if(lstatSync(dir,{throwIfNoEntry:false}))fail();}); return []; }
    directoryFact(dir); const listStamp = lstatSync(dir,{bigint:true});
    sourceChecks.push(() => { if(!same(listStamp,lstatSync(dir,{bigint:true}))) fail(); });
    const iterator = opendirSync(dir), names: string[] = [];
    try { for (;;) { const item = iterator.readSync(); if (!item) break; if (names.length >= 256) fail("bound"); names.push(item.name); } }
    finally { iterator.closeSync(); }
    names.sort(); facts.push([dir, names]); return names;
  };
  const realm = (dir: string, identity: PlacementKey["realm"], project?: string) => {
    directories.push(dir);
    const beforeFacts = facts.length; directoryFact(dir);
    if (project !== undefined) {
      const descriptor = json(join(dir, "project.json"));
      if (descriptor?.schema !== SHARD_SCHEMA || descriptor.key !== project || typeof descriptor.local !== "boolean") fail();
    }
    const descriptor = json(join(dir, "generation.json")), sources = json(join(dir, "migration-sources.json")), seal = json(join(dir, "generation-seal.json"));
    if (canonicalJSON(descriptor) !== canonicalJSON(generationDescriptor(base.profile.generation)) || !Array.isArray(sources?.sources)
      || sources.schema !== "agent-mem.migration-sources/v1" || seal?.schema !== "agent-mem.generation-seal/v1"
      || seal.generation !== base.profile.generation || seal.descriptorHash !== hashJSON(descriptor)
      || seal.sourceDigest !== hashJSON({ sources: sources.sources, legacyCommit: sources.legacyCommit })
      || json(join(dir, "machine.json"))?.id !== machine.id) fail();
    const hasMain = !!lstatSync(join(dir, "legacy-main"), { throwIfNoEntry: false });
    const profile: BoundProfile = { kind: "generation", home, dir, generation: base.profile.generation, selectorRevision: hashJSON(base.profile),
      sharded: true, legacyHome: join(dir, "legacy"), ...(hasMain ? { legacyMainHome: join(dir, "legacy-main") } : {}) };
    for (const root of [profile.legacyHome!, ...(hasMain ? [profile.legacyMainHome!] : [])]) {
      directoryFact(root); bytes(join(root, "machine.json"), true);
      for(const folder of ["log","local"]) {
        const file=join(root,folder), s=lstatSync(file,{bigint:true,throwIfNoEntry:false});
        sourceChecks.push(() => { const now=lstatSync(file,{bigint:true,throwIfNoEntry:false}); if(s ? !now||!same(s,now) : now!==undefined) fail(); });
      }
    }
    const segments = readShardLegacySnapshot(profile, { reader });
    for (const folder of ["log", "local"]) {
      directoryFact(join(dir, folder));
      const folderPath=join(dir,folder), folderStamp=lstatSync(folderPath,{bigint:true});
      sourceChecks.push(() => { if(!same(folderStamp,lstatSync(folderPath,{bigint:true}))) fail(); });
      if(folder === "local") bytes(join(dir,folder,`publisher-boundary-${machine.id}.json`),true);
      for (const name of reader.listFiles(join(dir, folder))) {
        if (!name.endsWith(".jsonl")) continue;
        if ( !/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(name)) fail();
        segments.push({ ...reader.read(join(dir, folder, name), undefined, true), source: "generation", path: `${folder}/${name}`, local: folder === "local" });
      }
    }
    const presence = new Map<string, PruneSourceRow>();
    const special = new Map<string, PlacementSpecialSourceRow>();
    const retainSpecial = (row: PruneRow | VaultLinkRow, local: boolean) => {
      const key = { realm: identity, id: row.id, rowHash: hashJSON(row) }, prior = special.get(row.id);
      if (prior && (prior.key.rowHash !== key.rowHash || prior.sourcePlacement !== (local ? "local" : "synced"))) fail();
      special.set(row.id, { key, row, sourcePlacement: local ? "local" : "synced", intrinsicLocal: row.op === "vault_link" });
    };
    for (const segment of segments) {
      const file = join(segment.source === "generation" ? dir : segment.source === "legacy-main" ? profile.legacyMainHome! : profile.legacyHome!, segment.path);
      const fileStat = lstatSync(file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1 || fileStat.uid !== process.getuid?.() || (fileStat.mode & 0o022) !== 0) fail();
      let sourceHash = segment.hash, sourceLength = segment.offset;
      if (segment.tailBytes) {
        const proof = pendingByPath.get(canonicalJSON(identity)+":"+digest(segment.path));
        if (segment.source !== "generation" || !proof || proof.offset !== segment.offset || proof.prefixHash !== segment.hash
          || segment.tailBytes >= Buffer.byteLength(proof.line) || segment.tailBytes > 16384) fail();
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = fstatSync(fd, { bigint: true });
          if (canonicalJSON(stamp(opened)) !== segment.stamp) fail();
          const tail = Buffer.alloc(segment.tailBytes); let at = 0;
          while (at < tail.length) { const n = readSync(fd, tail, at, tail.length-at, segment.offset+at); if (!n) fail(); at+=n; }
          if (!tail.equals(Buffer.from(proof.line).subarray(0,tail.length)) || !same(opened,fstatSync(fd,{bigint:true})) || !same(opened,lstatSync(file,{bigint:true}))) fail();
          sourceHash = createHash("sha256").update(segment.bytes).update(tail).digest("hex"); sourceLength += tail.length;
        } finally { closeSync(fd); }
      }
      facts.push([dir, segment.source, segment.path, sourceLength, sourceHash, segment.stamp]);
      const fileStamp=lstatSync(file,{bigint:true});
      if(canonicalJSON(stamp(fileStamp))!==segment.stamp) fail();
      sourceChecks.push(() => { const now=lstatSync(file,{bigint:true}); if(now.isSymbolicLink()||!now.isFile()||now.nlink!==1n||!same(fileStamp,now)) fail(); });
      if (!segment.stamp || !["generation", "legacy-local", "legacy-main"].includes(segment.source)) fail();
      const physical: unknown = JSON.parse(segment.stamp);
      if (!Array.isArray(physical) || physical.length !== 5 || !physical.every(value => typeof value === "string" && /^[0-9]+$/.test(value))) fail();
      prefixes.push({ realm: identity, source: segment.source as PlacementPublicationSource["source"], pathHash: digest(segment.path),
        dev: physical[0] as string, ino: physical[1] as string, byteLength: sourceLength, hash: sourceHash,
        mtimeNs: physical[3] as string, ctimeNs: physical[4] as string });
      for (const line of completeLines(segment.bytes)) {
        if (!line.length) continue;
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (segment.source === "generation" && parsed?.op === "prune") {
          const row = validatePruneRow(parsed, profile.generation, segment.local ? "local" : "synced");
          if (segment.path !== `${segment.local ? "local" : "log"}/${row.machine}.jsonl`) fail();
          retainSpecial(row, segment.local);
          continue;
        }
        if (segment.source === "generation" && parsed?.op === "vault_link") {
          const row = validateVaultLinkRow(parsed, profile.generation, segment.local ? "local" : "synced");
          if (segment.path !== `local/${row.machine}.jsonl`) fail();
          retainSpecial(row, true);
          continue;
        }
        const entry = checkedEntry(parsed);
        presence.set(entry.id, coalesceGenerationSource(presence.get(entry.id), entry, segment));
      }
    }
    for (const source of special.values()) {
      if (presence.has(source.key.id)) fail();
      specialRows.set(placementKeyId(source.key), source);
    }
    sourceRowsByRealm.set(canonicalJSON(identity), [...presence.values()]);
    for (const source of presence.values()) {
      const key = { realm: identity, id: source.row.id, rowHash: hashJSON(source.row) };
      rows.set(placementKeyId(key), { key, row: source.row, sourcePlacement: source.placement,
        intrinsicLocal: source.row.op === "settle" || source.row.op === "note" && source.row.tier === "short" });
    }
    const bindingHash = hashJSON(facts.slice(beforeFacts));
    realms.push({ ...identity, bindingHash });
  };
  if (!selection || selection.some(item => item.scope === "user")) realm(join(home, "user"), { scope: "user" });
  for (const name of listing(join(home, "projects"), true)) {
    if (!/^[a-f0-9]{16}$/.test(name)) fail();
    if (selection && !selection.some(item => item.scope === "project" && item.keyHash.slice(0,16) === name)) continue;
    const dir = join(home, "projects", name), project = json(join(dir, "project.json"));
    if (typeof project?.key !== "string" || shardKeyHash(project.key) !== name) fail();
    // Capture scaffolds are not curated realms, but their identity still binds this inventory.
    if (!lstatSync(join(dir, "generation.json"), { throwIfNoEntry: false })) continue;
    const keyHash = digest(project.key);
    if (selection && !selection.some(item => item.scope === "project" && item.keyHash === keyHash)) fail();
    realm(dir, { scope: "project", keyHash }, project.key);
  }
  if (selection && realms.length !== selection.length) fail();
  const defaults = memoryPolicySnapshot({ names: DENY_NAMES, segments: DENY_SEGMENTS }); if (!defaults) fail();
  const configuration = loadAmemConfig(home).config;
  const contextBase: PlacementSourcePreview["base"] = { ...base,
    homeHash: hashJSON([home, String(root.dev), String(root.ino), String(root.uid)]), sourceHash: hashJSON(facts),
    aliasesHash: digest(aliases ?? Buffer.alloc(0)), policyHash: hashJSON({ config: configuration, defaults, policyVersion }), realms };
  // ponytail: passive checks rely on native inode/size/ctime identity for the hashed prefixes.
  // Immutable descriptor-bound source blocks are the upgrade path for hostile same-user raw writers.
  const assertSourcesUnchanged = () => {
    try {
      const currentDefaults = memoryPolicySnapshot({ names: DENY_NAMES, segments: DENY_SEGMENTS });
      if (!currentDefaults || hashJSON({ config: configuration, defaults: currentDefaults, policyVersion }) !== contextBase.policyHash) fail();
      const now = ownedDirectory(home); if (now.dev !== root.dev || now.ino !== root.ino) fail();
      for (const check of sourceChecks) check();
      if (ownerProof) activationSourceMarkers(ownerProof,home,actualMarkers);
    } catch { fail(); }
  };
  return { home, base: contextBase, assertSourcesUnchanged, ...(activeHead ? { activeHead } : {}), markerHash, markers,
    directories: directories.sort(), prefixes, rows, specialRows, sourceRowsByRealm };
}
/** Read-only preview shares the source collector, without fabricating a quiescence attestation. */
export function previewSyncPlacementSources(home: string): PlacementSourcePreview {
  try { assertPlacementRuntime(home); const preview = sourcePreview(home); preview.assertSourcesUnchanged(); return preview; }
  catch (error) {
    if (error && typeof error === "object" && !types.isProxy(error)) {
      if (error instanceof SyncPlacementJournalError) throw error;
      if (error instanceof SegmentReadBudgetError) return fail("bound");
    }
    return fail();
  }
}
function capture(home: string, port: PlacementCapturePort, selected?: readonly PlacementRealm[], pending: readonly PlacementPendingSource[] = [], ownerProof?: PlacementActivationCaptureProof): Omit<PlacementCapture, "assertCurrent"> {
  // All host callouts precede filesystem capture, including the final passive proof.
  const attestation = memoryPolicySnapshot(port.attest()), policyVersion = port.policyVersion?.();
  if (!attestation || port.policyVersion && typeof policyVersion !== "string") fail();
  const source = sourcePreview(home, selected, pending, policyVersion, ownerProof);
  const context: SyncPlacementActivationContext = { ...source.base, writers: attestation.writers, legacySyncQuiesced: attestation.legacySyncQuiesced };
  const validated = planSyncPlacementActivation(context, "0".repeat(64));
  context.writers = validated.writers; context.realms = validated.realms;
  const writerInventory=source.activeHead&&writerInventoryEvidence(source.home,source.activeHead)?readEffectiveSyncPlacementWriters(source.home):undefined;
  if(writerInventory&&canonicalJSON(context.writers)!==canonicalJSON(writerInventory.writers))fail();
  const assertUnchanged = () => {
    try {
      const currentAttestation = memoryPolicySnapshot(port.attest()), currentVersion = port.policyVersion?.();
      if (!currentAttestation) fail();
      const checked = planSyncPlacementActivation({ ...context, writers: currentAttestation.writers, legacySyncQuiesced: currentAttestation.legacySyncQuiesced }, "0".repeat(64));
      if (canonicalJSON(checked.writers) !== canonicalJSON(context.writers) || currentVersion !== policyVersion) fail();
      writerInventory?.assertCurrent();
      if(source.activeHead&&!writerInventory&&writerInventoryEvidence(source.home,source.activeHead))fail();
      source.assertSourcesUnchanged();
    } catch { fail(); }
  };
  return { home: source.home, context, assertUnchanged, ...(source.activeHead ? { activeHead: source.activeHead } : {}),
    ...(writerInventory?{writerInventory}:{}),markerHash: source.markerHash, fingerprint: hashJSON({ context, markerHash: source.markerHash,...(writerInventory?.revisionSequence?{writerRevisionHash:writerInventory.revisionHash}:{}) }), directories: source.directories,
    prefixes: source.prefixes, rows: source.rows, specialRows: source.specialRows, sourceRowsByRealm: source.sourceRowsByRealm };
}

export function captureSyncPlacementContext(home: string, port: PlacementCapturePort, selected?: readonly PlacementRealm[], pendingInput: readonly PlacementPendingSource[] = []): PlacementCapture {
  try {
    const selection = selected === undefined ? undefined : memoryPolicySnapshot(selected);
    if (selected !== undefined && !selection) fail();
    if (!Array.isArray(pendingInput) || types.isProxy(pendingInput) || pendingInput.length > 20000) fail("bound");
    const pending = pendingInput.map(item => {
      if (!item || typeof item !== "object" || types.isProxy(item)) fail();
      const fields = Object.getOwnPropertyDescriptors(item);
      if (Object.keys(fields).sort().join() !== "line,offset,pathHash,prefixHash,realm" || Object.values(fields).some(field => !("value" in field) || !field.enumerable)) fail();
      const realm = validatePlacementKey({realm:fields.realm!.value,id:"0".repeat(32),rowHash:"0".repeat(64)}).realm;
      const line: unknown = fields.line!.value, offset: unknown = fields.offset!.value, pathHash: unknown = fields.pathHash!.value, prefixHash: unknown = fields.prefixHash!.value;
      if (typeof line !== "string" || Buffer.byteLength(line)>16384 || !line.endsWith("\n") || typeof offset!=="number" || !Number.isSafeInteger(offset) || offset<0
        || typeof pathHash!=="string" || pathHash.length!==64 || !/^[a-f0-9]+$/.test(pathHash) || typeof prefixHash!=="string" || prefixHash.length!==64 || !/^[a-f0-9]+$/.test(prefixHash)) fail();
      return {realm,line,offset,pathHash,prefixHash};
    });
    const before = capture(home, port, selection, pending);
    return { ...before, assertCurrent: () => { try { if (capture(home, port, selection, pending).fingerprint !== before.fingerprint) fail(); } catch { fail(); } } };
  } catch (error) {
    if (error && typeof error === "object" && !types.isProxy(error)) {
      if(error instanceof SharedWriterRevisionError){const code=Object.getOwnPropertyDescriptor(error,"code")?.value;if(code==="staging"||code==="pending")throw new SharedWriterRevisionError(code);}
      if (error instanceof SyncPlacementJournalError) throw error;
      if (error instanceof SegmentReadBudgetError) return fail("bound");
    }
    return fail();
  }
}

/** Internal initial-activation capture only. Tokens require the actual profile owner, live home mutation and exact durable intent. */
export function captureSyncPlacementActivationContext(home: string, port: PlacementCapturePort, proof: PlacementActivationCaptureProof): PlacementCapture {
  try {
    const before = capture(home,port,undefined,[],proof);
    return { ...before, assertCurrent: () => { if (capture(home,port,undefined,[],proof).fingerprint !== before.fingerprint) fail(); } };
  } catch (error) {
    if (error && typeof error === "object" && !types.isProxy(error)) {
      if (error instanceof SyncPlacementJournalError) throw error;
      if (error instanceof SegmentReadBudgetError) return fail("bound");
    }
    return fail();
  }
}
