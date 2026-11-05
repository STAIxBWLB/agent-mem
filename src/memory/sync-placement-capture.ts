import { types } from "node:util";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, generationDescriptor, hashJSON, validateVaultLinkRow, type BoundProfile } from "./generation.ts";
import { validatePlacementBaseV2, validatePlacementProfile, validatePlacementShards, PLACEMENT_PROFILE_SCHEMA } from "./sync-placement-format.ts";
import { planSyncPlacementActivation, type SyncPlacementActivationContext, type SyncPlacementWriterAttestation } from "./sync-placement-plan.ts";
import { readPublicPruneViewForActivation, PUBLIC_PRUNE_INTENT } from "./public-prune-view.ts";
import { realPath, DENY_NAMES, DENY_SEGMENTS } from "./platform.ts";
import { loadAmemConfig } from "./config.ts";
import { memoryPolicySnapshot } from "./policy.ts";
import { SegmentReader, checkedEntry, completeLines } from "./bridge.ts";
import { readShardLegacySnapshot } from "./shard-bridge.ts";
import { coalesceGenerationSource } from "./generation-index.ts";
import { validatePruneRow, type PruneSourceRow } from "./prune.ts";
import { shardKeyHash, SHARD_SCHEMA } from "./shard.ts";
import { SyncPlacementJournalError, placementKeyId, type PlacementKey } from "./sync-placement-journal-format.ts";
import type { Entry } from "./store.ts";

/** Host authentication/compatibility facts are re-read at every effect boundary, never inferred from a session marker. */
export interface PlacementCapturePort {
  attest(): { writers: readonly SyncPlacementWriterAttestation[]; legacySyncQuiesced: true };
  /** Required when a caller adds a policy callback; must change whenever its policy changes. */
  policyVersion?(): string;
}
export interface PlacementSourceRow { key: PlacementKey; row: Entry; sourcePlacement: "local" | "synced"; intrinsicLocal: boolean }
export interface PlacementCapture {
  home: string; context: SyncPlacementActivationContext; activeHead?: string;
  markerHash: string; fingerprint: string; directories: string[]; rows: Map<string, PlacementSourceRow>;
  assertCurrent(): void;
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
function capture(homeInput: string, port: PlacementCapturePort): Omit<PlacementCapture, "assertCurrent"> {
  // All host callouts precede filesystem capture: a callback cannot alter input after its final proof.
  const attestation = memoryPolicySnapshot(port.attest()), policyVersion = port.policyVersion?.();
  if (!attestation) fail();
  if (port.policyVersion && typeof policyVersion !== "string") fail();
  const home = realPath(homeInput), root = ownedDirectory(home);
  let metadataObjects = 0, metadataBytes = 0;
  const facts: unknown[] = [];
  const directoryFact = (dir: string) => {
    const stat = ownedDirectory(dir); facts.push([dir, "directory", String(stat.dev), String(stat.ino), String(stat.uid)]);
  };
  const bytes = (file: string, optional = false): Buffer | undefined => {
    const before = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!before) { if (!optional) fail(); facts.push([file, null]); return undefined; }
    if (++metadataObjects > 256 || before.size > 262144n || metadataBytes + Number(before.size) > 8 * 1024 * 1024) fail("bound");
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== root.uid || (before.mode & 0o022n) !== 0n) fail();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true }); if (!same(before, opened)) fail();
      const out = Buffer.alloc(Number(opened.size)); let at = 0;
      while (at < out.length) { const count = readSync(fd, out, at, out.length - at, at); if (!count) fail(); at += count; }
      const after = lstatSync(file, { bigint: true }); if (!same(opened, fstatSync(fd, { bigint: true })) || !same(opened, after)) fail();
      metadataBytes += out.length; facts.push([file, stamp(opened), digest(out)]); return out;
    } finally { closeSync(fd); }
  };
  const json = (file: string, optional = false): any => {
    const input = bytes(file, optional); if (!input) return undefined;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
  };
  const rawProfile = json(join(home, "profile.json")), rawShards = json(join(home, "shards.json"));
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
  for (const name of ["profile.lock", PUBLIC_PRUNE_INTENT]) if (lstatSync(join(home, name), { throwIfNoEntry: false })) fail();
  const reader = new SegmentReader(16 * 1024 * 1024, { maxSourceBytes: 8 * 1024 * 1024, maxRows: 20000 });
  const rows = new Map<string, PlacementSourceRow>(), directories = [home];
  const realms: SyncPlacementActivationContext["realms"][number][] = [];
  const listing = (dir: string, optional = false): string[] => {
    const s = lstatSync(dir, { throwIfNoEntry: false });
    if (!s) { if (!optional) fail(); facts.push([dir, null]); return []; }
    directoryFact(dir); const iterator = opendirSync(dir), names: string[] = [];
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
    }
    const segments = readShardLegacySnapshot(profile, { reader });
    for (const folder of ["log", "local"]) {
      directoryFact(join(dir, folder));
      for (const name of reader.listFiles(join(dir, folder))) {
        if (!name.endsWith(".jsonl") || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(name)) fail();
        segments.push({ ...reader.read(join(dir, folder, name), undefined, true), source: "generation", path: `${folder}/${name}`, local: folder === "local" });
      }
    }
    const presence = new Map<string, PruneSourceRow>();
    for (const segment of segments) {
      const file = join(segment.source === "generation" ? dir : segment.source === "legacy-main" ? profile.legacyMainHome! : profile.legacyHome!, segment.path);
      const fileStat = lstatSync(file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1 || fileStat.uid !== process.getuid?.() || (fileStat.mode & 0o022) !== 0) fail();
      if (segment.tailBytes) fail();
      facts.push([dir, segment.source, segment.path, segment.offset, segment.hash, segment.stamp]);
      for (const line of completeLines(segment.bytes)) {
        if (!line.length) continue;
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (segment.source === "generation" && parsed?.op === "prune") {
          const row = validatePruneRow(parsed, profile.generation, segment.local ? "local" : "synced");
          if (segment.path !== `${segment.local ? "local" : "log"}/${row.machine}.jsonl`) fail();
          continue;
        }
        if (segment.source === "generation" && parsed?.op === "vault_link") {
          const row = validateVaultLinkRow(parsed, profile.generation, segment.local ? "local" : "synced");
          if (segment.path !== `local/${row.machine}.jsonl`) fail();
          continue;
        }
        const entry = checkedEntry(parsed);
        presence.set(entry.id, coalesceGenerationSource(presence.get(entry.id), entry, segment));
      }
    }
    for (const source of presence.values()) {
      const key = { realm: identity, id: source.row.id, rowHash: hashJSON(source.row) };
      rows.set(placementKeyId(key), { key, row: source.row, sourcePlacement: source.placement,
        intrinsicLocal: source.row.op === "settle" || source.row.op === "note" && source.row.tier === "short" });
    }
    const bindingHash = hashJSON(facts.slice(beforeFacts));
    realms.push({ ...identity, bindingHash });
  };
  realm(join(home, "user"), { scope: "user" });
  for (const name of listing(join(home, "projects"), true)) {
    if (!/^[a-f0-9]{16}$/.test(name)) fail();
    const dir = join(home, "projects", name), project = json(join(dir, "project.json"));
    if (typeof project?.key !== "string" || shardKeyHash(project.key) !== name) fail();
    // Capture scaffolds are not curated realms, but their identity still binds this inventory.
    if (!lstatSync(join(dir, "generation.json"), { throwIfNoEntry: false })) continue;
    realm(dir, { scope: "project", keyHash: digest(project.key) }, project.key);
  }
  const defaults = memoryPolicySnapshot({ names: DENY_NAMES, segments: DENY_SEGMENTS }); if (!defaults) fail();
  const context: SyncPlacementActivationContext = { ...base, homeHash: hashJSON([home, String(root.dev), String(root.ino), String(root.uid)]), sourceHash: hashJSON(facts),
    aliasesHash: digest(aliases ?? Buffer.alloc(0)), policyHash: hashJSON({ config: loadAmemConfig(home).config, defaults, policyVersion }), realms,
    writers: attestation.writers, legacySyncQuiesced: attestation.legacySyncQuiesced };
  // Reuse the closed stage-1 context validator, including writer/version/realm bounds.
  const validated = planSyncPlacementActivation(context, "0".repeat(64));
  context.writers = validated.writers; context.realms = validated.realms;
  return { home, context, ...(activeHead ? { activeHead } : {}), markerHash, fingerprint: hashJSON({ context, markerHash }), directories: directories.sort(), rows };
}
export function captureSyncPlacementContext(home: string, port: PlacementCapturePort): PlacementCapture {
  try {
    const before = capture(home, port);
    return { ...before, assertCurrent: () => { try { if (capture(home, port).fingerprint !== before.fingerprint) fail(); } catch { fail(); } } };
  } catch (error) { if (error && typeof error === "object" && !types.isProxy(error) && error instanceof SyncPlacementJournalError) throw error; return fail(); }
}
