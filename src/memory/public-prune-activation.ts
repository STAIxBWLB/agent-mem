/** Explicit person-only, forward-only v2 activation. No read/capture path calls this API.
 * Checkpoints are fault seams after intent, shard marker, selector and intent removal.
 * A caller resumes an interrupted operation from its immutable direct-profile journal. */
import { createHash } from "node:crypto";
import { indexFileName } from "./index-file.ts";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJSON, fsyncDirectory, hashJSON, readSelector, withProfileLock, writeProfileJSON, type BoundProfile } from "./generation.ts";
import { readShardDescriptor, resolveShardProfile, shardDir, shardKeyHash, userShardDir, SHARDED_V2_FIELDS } from "./shard.ts";
import { acquireMutation } from "./mutation.ts";
import { assertNoLiveReaders } from "./reader-lease.ts";
import { aliasLogPath } from "./aliases.ts";
import { realPath } from "./platform.ts";
import { buildPublicPruneIndex } from "./store.ts";
import { reducePublicPruneInputs } from "./public-prune-inputs.ts";
import { PUBLIC_PRUNE_INTENT, publicPruneViewHash, readPublicPruneViewForActivation, validatePublicPruneView, type PublicPruneViewV1 } from "./public-prune-view.ts";

export type PublicPruneActivationStage = "after-intent" | "after-shards" | "after-profile" | "after-remove";
export interface PublicPruneActivationOptions {
  memoryDir: string; mode: "dry-run" | "apply" | "resume"; authorizedPerson: boolean; tty: boolean;
  view?: PublicPruneViewV1; checkpoint?: (stage: PublicPruneActivationStage) => void | Promise<void>;
}
export interface PublicPruneActivationResult { mode: PublicPruneActivationOptions["mode"]; generation: string; active: boolean; alreadyActive?: boolean; realms: number; viewHash: string; maskBuildCheck: "deferred" | "verified" }
interface Realm { key: string; profile: BoundProfile; metadata: string; sourceHash: string; native: string[] }
interface Intent {
  schema: "agent-mem.public-prune-activation/v1"; home: string; generation: string; aliases: string;
  previousProfile: string; previousShards: string; finalProfile: string; finalShards: string; finalProfileHash: string; finalShardsHash: string;
  view: PublicPruneViewV1; realms: Realm[];
}
// ponytail: one complete 1 MiB journal; a larger installation needs a versioned segmented intent.
const MAX = 1024 * 1024;
const fail = (): never => { throw new Error("public prune activation unavailable; inspect or resume the pending activation"); };
function guard(ok: unknown): asserts ok { if (!ok) fail(); }
const hex = (v: unknown, n: number): v is string => typeof v === "string" && v.length === n && /^[a-f0-9]+$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Reflect.ownKeys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
function owned(path: string, directory = false, links = 1) {
  const stat = lstatSync(path); guard(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === links)
    && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0); return stat;
}
function raw(path: string, optional = false, links = 1): string {
  if (optional && !lstatSync(path, { throwIfNoEntry: false })) return "absent";
  const stat = owned(path, false, links); guard((optional || stat.size > 0) && stat.size <= MAX);
  const bytes = readFileSync(path); guard(bytes.length === stat.size); const next = owned(path, false, links);
  guard(next.dev === stat.dev && next.ino === stat.ino && next.mtimeMs === stat.mtimeMs);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
function readProfileBytes(home: string): string {
  const file = join(home, "profile.json"); if (!lstatSync(file, { throwIfNoEntry: false })) return "absent";
  const text = raw(file); guard(text !== "absent"); return text;
}
const optionalBytes = (file: string) => lstatSync(file, {throwIfNoEntry:false}) ? {exists:true,bytes:raw(file)} : {exists:false};
const aliases = (home: string) => { const stat = owned(home, true); return hashJSON({ aliases: optionalBytes(aliasLogPath(home)), machine: raw(join(home, "machine.json")), dev: stat.dev, ino: stat.ino }); };
function metadata(profile: BoundProfile): string {
  const stat = owned(profile.dir, true);
  return hashJSON({ dev: stat.dev, ino: stat.ino, files: ["project.json", "generation.json", "generation-seal.json", "migration-sources.json", "machine.json"].map(name => [name, name === "project.json" ? optionalBytes(join(profile.dir, name)) : {exists:true,bytes:raw(join(profile.dir, name))}]) });
}
function enumerate(home: string): { key: string; profile: BoundProfile }[] {
  const result: { key: string; profile: BoundProfile }[] = [], projects = join(home, "projects");
  if (lstatSync(projects, { throwIfNoEntry: false })) {
    owned(projects, true); const names = readdirSync(projects).sort(); guard(names.length <= 1024);
    for (const hash of names) {
      guard(hex(hash, 16)); const dir = join(projects, hash); owned(dir, true);
      if (!lstatSync(join(dir, "generation.json"), { throwIfNoEntry: false })) continue;
      const descriptor = readShardDescriptor(home, hash); guard(descriptor && shardKeyHash(descriptor.key) === hash);
      result.push({ key: `project:${descriptor.key}`, profile: resolveShardProfile(home, { project: descriptor.key }) });
    }
  }
  if (lstatSync(join(userShardDir(home), "generation.json"), { throwIfNoEntry: false })) result.push({ key: "user", profile: resolveShardProfile(home, { user: true }) });
  guard(result.length > 0); return result.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
function realmBinding(home: string, realms: Realm[]): void {
  const expected = new Set(realms.map(realm => realm.profile.dir)), found = new Set<string>(), projects = join(home, "projects");
  if (lstatSync(projects, { throwIfNoEntry: false })) for (const name of readdirSync(projects)) {
    guard(hex(name, 16)); const dir = join(projects, name);
    if (lstatSync(join(dir, "generation.json"), { throwIfNoEntry: false })) { owned(dir, true); found.add(dir); }
  }
  const user = userShardDir(home); if (lstatSync(join(user, "generation.json"), { throwIfNoEntry: false })) { owned(user, true); found.add(user); }
  guard(found.size === expected.size && [...expected].every(dir => found.has(dir)));
  for (const realm of realms) guard(metadata(realm.profile) === realm.metadata);
}
/** Atomic create-once publication, recovering only this exact complete staging pair. */
function immutable(file: string, text: string): void {
  const base = dirname(file); if (!lstatSync(base, { throwIfNoEntry: false })) { mkdirSync(base, { mode: 0o700 }); fsyncDirectory(dirname(base)); } owned(base, true);
  const bytes = Buffer.from(text), temp = file + ".pending-" + createHash("sha256").update(bytes).digest("hex");
  if (lstatSync(file, { throwIfNoEntry: false })) {
    const stat = lstatSync(file);
    if (stat.nlink === 2) {
      const pending = owned(temp, false, 2); owned(file, false, 2); guard(stat.dev === pending.dev && stat.ino === pending.ino && stat.size === bytes.length);
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd); guard(opened.dev === stat.dev && opened.ino === stat.ino && opened.nlink === 2 && readFileSync(fd).equals(bytes));
        for (const name of [file, temp]) { const named = owned(name, false, 2); guard(named.dev === opened.dev && named.ino === opened.ino && named.size === opened.size && named.mtimeMs === opened.mtimeMs); }
        unlinkSync(temp); fsyncDirectory(base);
      } finally { closeSync(fd); }
    }
    guard(raw(file) === text); return;
  }
  if (lstatSync(temp, { throwIfNoEntry: false })) {
    owned(temp); // Staging is not membership; discard an incomplete crash-left prefix under the profile fence.
    if (!readFileSync(temp).equals(bytes)) { unlinkSync(temp); fsyncDirectory(base); }
  }
  if (!lstatSync(temp, { throwIfNoEntry: false })) {
    const fd = openSync(temp, "wx", 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  } else { const fd = openSync(temp, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
  linkSync(temp, file); fsyncDirectory(base); unlinkSync(temp); fsyncDirectory(base);
}
function syncIndex(profile: BoundProfile): void {
  const file = join(profile.dir, indexFileName(true)); owned(file); const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); } fsyncDirectory(profile.dir);
}
function nextProfile(realm: Realm, intent: Intent): BoundProfile {
  return { ...realm.profile, selectorRevision: hashJSON(JSON.parse(intent.finalProfile)), foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: publicPruneViewHash(intent.view) };
}
/** Existing membership must remain in the new checked cumulative chain, not merely its mask. */
function validateAdvance(intent: Intent): void {
  const previous = intent.previousProfile === "absent" ? undefined : JSON.parse(intent.previousProfile);
  const old = previous?.schema === "agent-mem.profile/v2"
    ? readPublicPruneViewForActivation(intent.home, previous.pruneInputSetHash, intent.generation)
    : { realms: {} as Record<string, string> };
  guard(Object.keys(old.realms).every(key => Object.hasOwn(intent.view.realms, key)));
  for (const [key, set] of Object.entries(intent.view.realms)) {
    const realm = intent.realms.find(item => item.key === key); guard(realm);
    const proof = reducePublicPruneInputs({ dir: realm.profile.dir, realm: key === "user" ? { scope: "user" } : { scope: "project", key: key.slice(8) }, receivingGeneration: intent.generation, inputSetHash: set });
    const ancestor = old.realms[key]; guard(ancestor === undefined || proof.commitments.includes(ancestor));
  }
}
function verify(intent: Intent, profileBytes: string, shardBytes: string): void {
  guard(aliases(intent.home) === intent.aliases && readProfileBytes(intent.home) === profileBytes && raw(join(intent.home, "shards.json")) === shardBytes);
  realmBinding(intent.home, intent.realms);
  validateAdvance(intent);
  for (const realm of intent.realms) {
    const old = buildPublicPruneIndex(realm.profile), next = buildPublicPruneIndex(nextProfile(realm, intent));
    guard(old.sourceHash === realm.sourceHash && next.sourceHash === realm.sourceHash && realm.native.every(id => old.targets.includes(id) && next.targets.includes(id)));
  }
}
function checkedIntent(value: unknown, home: string): Intent {
  guard(object(value) && exact(value, ["schema", "home", "generation", "aliases", "previousProfile", "previousShards", "finalProfile", "finalShards", "finalProfileHash", "finalShardsHash", "view", "realms"]));
  guard(value.schema === "agent-mem.public-prune-activation/v1" && value.home === home && hex(value.generation, 32) && hex(value.aliases, 64));
  for (const key of ["previousProfile", "previousShards", "finalProfile", "finalShards"]) guard(typeof value[key] === "string" && Buffer.byteLength(value[key] as string) <= MAX);
  const view = validatePublicPruneView(value.view); guard(view.receivingGeneration === value.generation && Array.isArray(value.realms) && value.realms.length > 0 && value.realms.length <= 1025);
  const final = JSON.parse(value.finalProfile as string), shards = JSON.parse(value.finalShards as string);
  const shardFields = new Set<string>(SHARDED_V2_FIELDS);
  guard(object(shards) && Object.keys(shards).every(key => shardFields.has(key)));
  guard(hex(value.finalProfileHash, 64) && hex(value.finalShardsHash, 64) && hashJSON(final) === value.finalProfileHash && hashJSON(shards) === value.finalShardsHash);
  guard(canonicalJSON(final) + "\n" === value.finalProfile && canonicalJSON(shards) + "\n" === value.finalShards
    && object(final) && exact(final, ["schema", "kind", "generation", "foreignPruneFormat", "pruneInputSetHash"])
    && final.schema === "agent-mem.profile/v2" && final.generation === value.generation && final.kind === "generation" && final.foreignPruneFormat === "agent-mem.public-prune-witness/v1" && final.pruneInputSetHash === publicPruneViewHash(view)
    && shards.schema === "agent-mem.shards/v2" && shards.phase === "active" && shards.generation === value.generation && shards.selectorRevision === hashJSON(final));
  const previousProfile = value.previousProfile === "absent" ? undefined : JSON.parse(value.previousProfile as string), previousShards = JSON.parse(value.previousShards as string);
  guard(previousProfile === undefined || object(previousProfile)
    && (previousProfile.schema === "agent-mem.profile/v1" && ["shared-v1", "generation"].includes(String(previousProfile.kind))
      && (previousProfile.kind === "generation" ? hex(previousProfile.generation, 32) : previousProfile.generation === undefined)
      || previousProfile.schema === "agent-mem.profile/v2" && previousProfile.kind === "generation" && previousProfile.generation === value.generation));
  const { schema: _schema, selectorRevision: _revision, ...before } = previousShards;
  const { schema: _nextSchema, selectorRevision: _nextRevision, ...after } = shards; guard(canonicalJSON(before) === canonicalJSON(after));
  let previous = "";
  for (const item of value.realms) {
    guard(object(item) && exact(item, ["key", "profile", "metadata", "sourceHash", "native"]) && typeof item.key === "string" && item.key > previous && hex(item.metadata, 64) && hex(item.sourceHash, 64)); previous = item.key;
    guard(object(item.profile)); const profile = item.profile;
    guard(Object.keys(profile).every(key => ["kind", "home", "dir", "generation", "selectorRevision", "legacyHome", "legacyMainHome", "sharded", "shardKey", "shardUser", "foreignPruneFormat", "pruneInputSetHash"].includes(key)));
    const key = item.key === "user" ? undefined : item.key.startsWith("project:") ? item.key.slice(8) : fail();
    const dir = key === undefined ? userShardDir(home) : shardDir(home, key);
    guard(profile.kind === "generation" && profile.home === home && profile.dir === dir && profile.generation === value.generation && profile.sharded === true
      && profile.selectorRevision === (previousProfile === undefined ? "absent" : hashJSON(previousProfile))
      && profile.legacyHome === join(dir, "legacy") && (profile.legacyMainHome === undefined || profile.legacyMainHome === join(dir, "legacy-main"))
      && (key === undefined ? profile.shardUser === true && profile.shardKey === undefined : profile.shardKey === key && profile.shardUser === undefined));
    guard(Array.isArray(item.native) && item.native.every(id => hex(id, 32)) && new Set(item.native).size === item.native.length);
  }
  guard(Object.keys(view.realms).every(key => (value.realms as Realm[]).some(realm => realm.key === key)));
  guard(Buffer.byteLength(canonicalJSON(value)) <= MAX); return { ...value, view } as unknown as Intent;
}
/** Dry-run reads proof only and defers native/v2 mask building. Apply/resume never roll markers backward. */
export async function activatePublicPruneView(options: PublicPruneActivationOptions): Promise<PublicPruneActivationResult> {
  const advanced = lstatSync(join(options.memoryDir,PUBLIC_PRUNE_INTENT),{throwIfNoEntry:false});
  if (options.mode === "resume" && advanced?.isFile()) {
    const value=JSON.parse(raw(join(options.memoryDir,PUBLIC_PRUNE_INTENT),false,advanced.nlink));
    if (value?.schema === "agent-mem.public-prune-advance/v1") {
      guard(options.authorizedPerson === true && options.tty === true);
      const {resumePublicPruneAdvance}=await import("./public-prune-advance.ts");
      const result=await resumePublicPruneAdvance(options.memoryDir,options.checkpoint);
      return {mode:options.mode,generation:value.generation,active:true,realms:Object.keys(value.view.realms).length,viewHash:result.viewHash,maskBuildCheck:"verified"};
    }
  }

  guard(options.authorizedPerson === true && options.tty === true && ["dry-run", "apply", "resume"].includes(options.mode));
  const home = realPath(options.memoryDir); owned(home, true); const rootStat = lstatSync(home), intentFile = join(home, PUBLIC_PRUNE_INTENT);
  const pending = lstatSync(intentFile, { throwIfNoEntry: false });
  let intent: Intent;
  if (pending) {
    guard(options.mode === "resume"); const text = raw(intentFile, false, pending.nlink);
    if (pending.nlink === 2) {
      const temp = intentFile + ".pending-" + createHash("sha256").update(text).digest("hex"), pair = owned(temp, false, 2);
      guard(pair.dev === pending.dev && pair.ino === pending.ino);
    } else guard(pending.nlink === 1);
    intent = checkedIntent(JSON.parse(text), home); guard(text === canonicalJSON(intent) + "\n");
    guard(options.view === undefined || canonicalJSON(validatePublicPruneView(options.view)) === canonicalJSON(intent.view));
  }
  else {
    const selection = readSelector(home), previousProfile = readProfileBytes(home), previousShards = raw(join(home, "shards.json")), old = JSON.parse(previousShards);
    guard(old.phase === "active" && hex(old.generation, 32));
    const generation = old.generation, view = validatePublicPruneView(options.view ?? (selection.selector?.schema === "agent-mem.profile/v2"
      ? readPublicPruneViewForActivation(home, selection.selector.pruneInputSetHash, generation)
      : { schema: "agent-mem.public-prune-view/v1", receivingGeneration: generation, realms: {} })); guard(view.receivingGeneration === generation);
    const final = { schema: "agent-mem.profile/v2", kind: "generation", generation, foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: publicPruneViewHash(view) };
    const finalShards = { ...old, schema: "agent-mem.shards/v2", selectorRevision: hashJSON(final) };
    const realms = enumerate(home).map(realm => ({ ...realm, metadata: metadata(realm.profile), sourceHash: "0".repeat(64), native: [] as string[] }));
    intent = checkedIntent({ schema: "agent-mem.public-prune-activation/v1", home, generation, aliases: aliases(home), previousProfile, previousShards,
      finalProfile: canonicalJSON(final) + "\n", finalShards: canonicalJSON(finalShards) + "\n", finalProfileHash: hashJSON(final), finalShardsHash: hashJSON(finalShards), view,
      realms }, home);
  }
  validateAdvance(intent);
  if (options.mode === "dry-run") {
    guard(readProfileBytes(home) === intent.previousProfile && raw(join(home, "shards.json")) === intent.previousShards && aliases(home) === intent.aliases);
    realmBinding(home, intent.realms);
    return { mode: options.mode, generation: intent.generation, active: intent.previousProfile === intent.finalProfile && intent.previousShards === intent.finalShards, realms: intent.realms.length, viewHash: publicPruneViewHash(intent.view), maskBuildCheck: "deferred" };
  }
  if (!pending && intent.previousProfile !== "absent" && JSON.parse(intent.previousProfile).schema === "agent-mem.profile/v2") {
    // Only the first reader-floor transition quiesces. Later views preserve native masks and grow foreign masks in place.
    const alreadyActive = intent.previousProfile === intent.finalProfile && intent.previousShards === intent.finalShards;
    if (!alreadyActive) {
      const { advancePublicPruneView } = await import("./public-prune-advance.ts");
      await advancePublicPruneView({ memoryDir: home, view: intent.view, expectedRevision: hashJSON(JSON.parse(intent.previousProfile)), checkpoint: options.checkpoint });
    }
    return { mode: options.mode, generation: intent.generation, active: true, ...(alreadyActive ? {alreadyActive:true} : {}), realms: intent.realms.length, viewHash: publicPruneViewHash(intent.view), maskBuildCheck: "verified" };
  }
  return withProfileLock(home, async () => {
    const releases: (() => void)[] = [];
    try {
      guard(lstatSync(home).dev === rootStat.dev && lstatSync(home).ino === rootStat.ino);
      const dirs = [...new Set([home, ...intent.realms.map(realm => realm.profile.dir)])].sort();
      for (const dir of dirs) { assertNoLiveReaders(dir, {includeShards:true}); const release = acquireMutation(dir); guard(release); releases.push(release); }
      validateAdvance(intent);
      if (pending) immutable(intentFile, canonicalJSON(intent) + "\n");
      if (!pending) {
        guard(readProfileBytes(home) === intent.previousProfile && raw(join(home, "shards.json")) === intent.previousShards && aliases(home) === intent.aliases);
        realmBinding(home, intent.realms);
        intent = checkedIntent({ ...intent, realms: intent.realms.map(realm => {
          const built = buildPublicPruneIndex(realm.profile); return { ...realm, sourceHash: built.sourceHash, native: [...built.targets].sort() };
        }) }, home);
      }
      const viewHash = publicPruneViewHash(intent.view);
      immutable(join(home, "public-prune-input-sets", viewHash + ".json"), canonicalJSON(intent.view) + "\n");
      readPublicPruneViewForActivation(home, viewHash, intent.generation);
      let profile = readProfileBytes(home), shards = raw(join(home, "shards.json"));
      guard((profile === intent.previousProfile || profile === intent.finalProfile) && (shards === intent.previousShards || shards === intent.finalShards));
      guard(profile !== intent.finalProfile || shards === intent.finalShards);
      verify(intent, profile, shards); for (const realm of intent.realms) syncIndex(nextProfile(realm, intent));
      if (!pending && profile === intent.finalProfile && shards === intent.finalShards) return { mode: options.mode, generation: intent.generation, active: true, alreadyActive: true, realms: intent.realms.length, viewHash, maskBuildCheck: "verified" };
      immutable(intentFile, canonicalJSON(intent) + "\n");
      await options.checkpoint?.("after-intent"); verify(intent, profile, shards);
      if (shards !== intent.finalShards) { writeProfileJSON(join(home, "shards.json"), JSON.parse(intent.finalShards)); shards = intent.finalShards; }
      await options.checkpoint?.("after-shards"); verify(intent, profile, shards);
      if (profile !== intent.finalProfile) { writeProfileJSON(join(home, "profile.json"), JSON.parse(intent.finalProfile)); profile = intent.finalProfile; }
      await options.checkpoint?.("after-profile"); verify(intent, profile, shards);
      guard(raw(intentFile) === canonicalJSON(intent) + "\n"); unlinkSync(intentFile); fsyncDirectory(home);
      await options.checkpoint?.("after-remove"); verify(intent, profile, shards);
      return { mode: options.mode, generation: intent.generation, active: true, realms: intent.realms.length, viewHash, maskBuildCheck: "verified" };
    } finally { for (const release of releases.reverse()) release(); }
  });
}
