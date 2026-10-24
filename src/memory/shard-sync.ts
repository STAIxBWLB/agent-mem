import { randomBytes, createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, fsyncDirectory, hashJSON, readProfileJSON } from "./generation.ts";
import { generationSyncLock } from "./generation-sync.ts";
import { acquireMutation } from "./mutation.ts";
import { realPath } from "./platform.ts";
import { reducePruneRows, validatePrunePlan, validatePruneRow, type PrunePlan, type PruneRow, type PruneSnapshot, type PruneSourceRow } from "./prune.ts";
import { assertCuratedShardPaths, isLocalKey, resolveShardProfile } from "./shard.ts";
import { decodeShardPack, encodeShardPacks, SHARD_PACK_MAX_BYTES, ShardSyncFormatError, shardSyncDescriptor, shardSyncLabel, shardSyncRef, type ShardSyncRealm, type ShardSyncRow } from "./shard-sync-format.ts";
import { generationSyncGit, remoteVisibility, type SyncOptions, type SyncResult } from "./sync.ts";
import type { Entry, MemoryStore } from "./store.ts";

const OID = /^[a-f0-9]{40}$/, PACK = /^rows\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl$/;
const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const zero = "0".repeat(40);
type PendingPrune = { plan: PrunePlan; row: PruneRow; line: string; offset: number; prefixHash: string };
type Target = { store: MemoryStore; realm: ShardSyncRealm; rows: Map<string, ShardSyncRow>; fetched: Set<string>; sources: PruneSourceRow[]; pending: PendingPrune[]; generation: string; local?: string; remote?: string; commit?: string };
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
function importPrunePlan(store: MemoryStore, realm: ShardSyncRealm, row: PruneRow): PrunePlan {
  const body: Omit<PrunePlan, "seal"> = { schema: "agent-mem.prune-plan/v1", generation: store.profile.generation!,
    selectorRevision: store.prunePort().selectorRevision(), project: realm.scope === "project" ? realm.key : "user",
    policyRevision: hashJSON({ schema: "agent-mem.shard-sync/v1", realm }), rows: [{ placement: "synced", payload: row }],
    counts: { eligible: row.targets.length, selected: row.targets.length, local: 0, synced: row.targets.length }, hasMore: false };
  return validatePrunePlan({ ...body, seal: hashJSON(body) });
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
      if (plan.seal !== claim.seal || canonicalJSON(plan) !== canonicalJSON(importPrunePlan(store, realm, row))
        || name !== `pending-log-${row.machine}.json` || claim.rowId !== row.id || claim.lineHash !== digest(line)) throw new Error("plan binding");
      regular(join(store.dir, "log", `${row.machine}.jsonl`));
      pending.push({ plan, row, line, offset: claim.offset, prefixHash: claim.prefixHash });
    }
    return pending;
  } catch { return refuse(`${shardSyncLabel(realm)}: pending prune requires its original plan to resume`); }
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
  const pending = pendingPrunes(store, realm), claims = new Map(pending.map(claim => [`${claim.row.machine}.jsonl`, claim]));
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
    const proof = reducePruneRows(prunes.map(row => ({ row, placement: "synced" as const })), snapshot, target.generation);
    if (proof.invalid || proof.pending.length) refuse(`${shardSyncLabel(target.realm)}: prune lacks complete public witnesses`);
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
  for (const pending of target.pending) {
    port.persistPrunePlan(pending.plan); port.appendPrune(pending.row, pending.line, pending.plan.seal); resumed.add(pending.row.id);
  }
  for (const row of target.rows.values()) if (row.op === "prune") {
    if (resumed.has(row.id)) continue;
    // A transport imports an already-authored person row without changing its author or generation.
    // Native durable-plan append confirms fsync even for an already parsed id after a crash.
    const plan = importPrunePlan(target.store, target.realm, row);
    port.persistPrunePlan(plan); port.appendPrune(row, canonicalJSON(row) + "\n", plan.seal);
  }
  port.refresh();
}

/** Sync only the borrowed canonical project and user targets. It never closes or rebinds those handles. */
export async function syncShardedMemory(store: MemoryStore, opts: SyncOptions = {}): Promise<SyncResult> {
  let pushed = false, releaseTransport: (() => void) | undefined, releaseSync: (() => void) | undefined;
  const releases: (() => void)[] = [], transient: string[] = [], temporary: string[] = [];
  const fail = (error: string): SyncResult => ({ ok: false, pushed, entries: 0, error });
  let root = "", cache = "", targets: Target[] = [];
  const check = () => {
    if (opts.signal?.aborted) refuse("stopped");
    for (const target of targets) {
      const profile = target.store.profile;
      const current = resolveShardProfile(profile.home, target.realm.scope === "user" ? { user: true } : { project: target.realm.key });
      if (current.dir !== profile.dir || current.generation !== target.generation || current.selectorRevision !== profile.selectorRevision) refuse(`${shardSyncLabel(target.realm)}: selected profile changed`);
    }
  };
  const git = async (args: string[], signal = opts.signal) => generationSyncGit(root, ["--no-replace-objects", "--git-dir", cache, ...args], signal);
  const required = async (args: string[], reason: string): Promise<string> => {
    check(); const result = await git(args); check();
    if (result.code !== 0) refuse(reason);
    return result.out;
  };
  try {
    if (opts.signal?.aborted) return fail("stopped");
    if (!store.profile.sharded || store.profile.kind !== "generation") return fail("shard sync requires a selected curated shard");
    const borrowed = store.openedSyncTargets();
    targets = borrowed.map(opened => {
      const profile = opened.profile;
      if (!profile.sharded || profile.kind !== "generation" || !profile.generation || !profile.shardUser && !profile.shardKey) refuse("shard sync target identity unavailable");
      return { store: opened, realm: profile.shardUser ? { scope: "user" as const } : { scope: "project" as const, key: profile.shardKey! }, rows: new Map<string, ShardSyncRow>(), fetched: new Set<string>(), sources: [], pending: [], generation: profile.generation };
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
    // Cooperating source writers stay excluded across remote reads and final imports. No nested withMutation calls.
    for (const target of [...targets].sort((a, b) => a.store.dir < b.store.dir ? -1 : 1)) {
      const release = acquireMutation(target.store.dir); if (!release) refuse(`${shardSyncLabel(target.realm)}: another source mutation is running`); releases.push(release);
    }
    const blobCache = new Map<string, Buffer>(), decoded = new Map<string, ShardSyncRow[]>();
    const blob = async (object: string, path: string): Promise<Buffer> => {
      const maximum = path === "shard.json" ? 64 * 1024 : SHARD_PACK_MAX_BYTES, prior = blobCache.get(object);
      if (prior) { if (prior.length > maximum) refuse("shard sync blob exceeds its bound"); return prior; }
      const size = Number(await required(["cat-file", "-s", object], "shard sync blob size unavailable"));
      if (!Number.isSafeInteger(size) || size < 1 || size > maximum) refuse("shard sync blob exceeds its bound");
      const value = await required(["cat-file", "blob", object], "shard sync blob unavailable"), bytes = Buffer.from(value + "\n");
      if (bytes.length !== size) refuse("shard sync requires complete newline-terminated public blobs");
      const identity = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (identity !== object) refuse("shard sync public blob identity mismatch");
      blobCache.set(object, bytes); return bytes;
    };
    type History = { rows: Map<string, ShardSyncRow>; files: Map<string, Buffer> };
    // Keep only requested tips. Per-commit full row maps would make append-only history quadratic in memory.
    const histories = new Map<string, History>(), audited = new Set<string>();
    const treeState = async (commit: string, target: Target): Promise<History> => {
      const entries = (await required(["ls-tree", "-r", "-z", commit], "shard sync tree unavailable")).split("\0").filter(Boolean);
      const rows = new Map<string, ShardSyncRow>(), files = new Map<string, Buffer>();
      for (const entry of entries) {
        const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
        if (!match || match[2] !== "shard.json" && !PACK.test(match[2]!)) refuse(`${shardSyncLabel(target.realm)}: forbidden historical tree entry`);
        const path = match[2]!, object = match[1]!, bytes = await blob(object, path); files.set(path, bytes);
        if (path === "shard.json") {
          if (bytes.toString() !== shardSyncDescriptor(target.realm)) refuse(`${shardSyncLabel(target.realm)}: historical descriptor mismatch`);
        } else {
          const key = `${shardSyncRef(target.realm)}:${object}`;
          let pack = decoded.get(key);
          if (!pack) { pack = decodeShardPack(path, bytes, target.realm, target.generation); decoded.set(key, pack); }
          else if (!path.endsWith(`/${digest(bytes)}.jsonl`) || pack.some(row => path !== `rows/${digest(row.machine)}/${digest(bytes)}.jsonl`)) refuse(`${shardSyncLabel(target.realm)}: immutable pack path changed`);
          mergeRows(rows, pack, target.realm);
        }
      }
      if (!files.has("shard.json")) refuse(`${shardSyncLabel(target.realm)}: historical descriptor missing`);
      return { rows, files };
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
        for (const row of remote.rows.values()) target.fetched.add(row.id);
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
        files.set("shard.json", Buffer.from(shardSyncDescriptor(target.realm)));
        // Retain immutable packs and append only new ids; repacking every prefix would duplicate the entire history at each sync.
        const additions = [...target.rows.values()].filter(row => !remote?.rows.has(row.id));
        for (const [path, bytes] of encodeShardPacks(additions)) {
          const old = files.get(path); if (old && !old.equals(bytes)) refuse(`${shardSyncLabel(target.realm)}: immutable pack conflict`); files.set(path, bytes);
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
    localTargets(); await fetchTargets(); localTargets(); provePrunes(targets); check();
    // Every selected realm, including its complete remote history/prunes, is preflighted before the first append or publication.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) { await fetchTargets(); localTargets(); provePrunes(targets); check(); }
      await buildTargets(); check();
      const sent = await git(["push", "--atomic", "--no-follow-tags", "-q", "origin", ...targets.map(target => `${target.commit!}:${shardSyncRef(target.realm)}`)]);
      if (sent.code === 0) pushed = true;
      check();
      if (sent.code === 0) {
        pushed = true;
        // No local append before a successful atomic publication: a raced foreign prune can still refuse the entire retry safely.
        localTargets(); provePrunes(targets); check();
        for (const target of targets) {
          assertCuratedShardPaths(target.store.profile.home, target.realm.scope === "user" ? { user: true } : { project: target.realm.key });
          importRows(target);
        }
        for (const target of targets) await required(["update-ref", "--no-deref", shardSyncRef(target.realm), target.commit!, target.local ?? zero], "shard sync cached ref changed concurrently");
        return { ok: true, pushed, entries: targets.reduce((n, target) => n + [...target.rows.values()].filter(row => row.op === "note").length, 0) };
      }
      if (opts.signal?.aborted) return fail("stopped");
    }
    return fail("shard sync selected-ref push failed");
  } catch (error) {
    return fail(error instanceof ShardSyncFormatError || error instanceof SyncRefusal ? error.message : "shard sync unavailable");
  } finally {
    for (const ref of transient) { try { await generationSyncGit(root, ["--no-replace-objects", "--git-dir", cache, "update-ref", "--no-deref", "-d", ref], undefined); } catch { /* private orphaned refs remain non-public */ } }
    for (const file of temporary) { try { rmSync(file, { force: true }); } catch { /* private diagnostic bytes never enter a public tree */ } }
    for (const release of releases.reverse()) { try { release(); } catch { /* fail-open cleanup */ } }
    try { releaseSync?.(); } catch { /* private lock cleanup */ }
    try { releaseTransport?.(); } catch { /* private lock cleanup */ }
  }
}
