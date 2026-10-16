import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legacyEntries, legacyHead, readLegacySnapshot } from "./bridge.ts";
import { canonicalJSON, generationDescriptor, generationDir, readProfileJSON, validateGeneration } from "./generation.ts";
import { acquireMutation } from "./mutation.ts";
import { processLiveness, processSignature, realPath } from "./platform.ts";
import { validatePruneRow, pruneRowHash, type PruneRow } from "./prune.ts";
import { remoteVisibility, syncGit, type SyncOptions, type SyncResult } from "./sync.ts";
import type { MemoryStore } from "./store.ts";
import { createHash } from "node:crypto";

const IGNORE = "/*\n!/.gitignore\n!/generation.json\n!/log/\n/log/*\n!/log/*.jsonl\n";
const zero = "0".repeat(40), oid = (value: string) => /^[a-f0-9]{40}$/.test(value);
const segment = (path: string) => /^log\/[a-f0-9]{16}\.jsonl$/.test(path);
const fail = (reason: string): never => { throw new Error(reason); };
function regular(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("generation sync refuses non-regular public files");
  return true;
}
function ownRepository(dir: string): boolean {
  const path = join(dir, ".git");
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || existsSync(join(path, "commondir")) || existsSync(join(path, "objects", "info", "alternates"))) fail("generation sync requires its separate repository");
  return true;
}
function lockSync(dir: string): (() => void) | undefined {
  const signature = processSignature(process.pid);
  if (!signature) return undefined;
  const file = join(dir, "sync.lock"), value = canonicalJSON({ pid: process.pid, signature, token: randomBytes(16).toString("hex") });
  // The generation mutation transaction is already held, serializing stale-lock reclamation across callers.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try { fd = openSync(file, "wx", 0o600); }
    catch {
      try {
        if (!regular(file)) continue;
        const prior = readFileSync(file, "utf8"), owner = JSON.parse(prior) as { pid?: unknown; signature?: unknown };
        if (typeof owner.signature !== "string" || !owner.signature || processLiveness(owner.pid, owner.signature) !== "gone" || readFileSync(file, "utf8") !== prior) return undefined;
        rmSync(file); continue;
      } catch { return undefined; }
    }
    try { writeFileSync(fd, value); } finally { closeSync(fd); }
    return () => { if (regular(file) && readFileSync(file, "utf8") === value) rmSync(file); };
  }
  return undefined;
}

function validatePublic(bytes: string, generation: string, path: string, checkPrune?: (row: PruneRow) => void): void {
  if (!bytes) return;
  const legacy: string[] = [];
  for (const line of bytes.split("\n").filter(Boolean)) {
    let value: unknown; try { value = JSON.parse(line); } catch { return fail("generation public segment has malformed rows"); }
    const row = value as { schema?: unknown; op?: unknown; tier?: unknown };
    if (row.schema === "agent-mem.prune/v1") {
      const prune = validatePruneRow(value, generation, "synced");
      if (path !== `log/${prune.machine}.jsonl`) fail("generation prune author does not match its segment");
      checkPrune?.(prune);
    }
    else {
      if (row.op === "settle" || row.op === "note" && row.tier !== "long") fail("generation public segment contains local-only rows");
      legacy.push(line);
    }
  }
  const body = Buffer.from(legacy.join("\n") + (legacy.length ? "\n" : ""));
  legacyEntries([{ source: "legacy-main", path, bytes: body, offset: body.length, hash: createHash("sha256").update(body).digest("hex"), local: false, tailBytes: 0 }]);
}

/** Separate generation repository, fixed refs and a one-way legacy cache; failures are bounded result receipts. */
export async function syncGenerationMemory(store: MemoryStore, opts: SyncOptions = {}): Promise<SyncResult> {
  let pushed = false, releaseMutation: (() => void) | undefined, releaseSync: (() => void) | undefined;
  const result = (error: string): SyncResult => ({ ok: false, pushed, entries: 0, error });
  const profile = store.profile, generation = profile.generation, dir = store.dir;
  const transientRefs: { cache?: string; ref: string }[] = [];
  const git = (args: string[], signal = opts.signal) => syncGit(dir, args, signal);
  const required = async (args: string[], reason: string, signal = opts.signal): Promise<string> => {
    const run = await git(args, signal);
    if (run.code !== 0) fail(opts.signal?.aborted ? "stopped" : reason);
    return run.out;
  };
  try {
    if (opts.signal?.aborted) return result("stopped");
    if (profile.kind !== "generation" || !generation || dir !== generationDir(profile.home, generation) || validateGeneration(profile.home, generation) !== dir) return result("generation profile unavailable");
    const repo = ownRepository(dir);
    if (!opts.remote && !repo) return result("no generation sync remote configured");
    const url = opts.remote ?? await required(["remote", "get-url", "origin"], "no generation sync remote configured");
    if (typeof url !== "string" || !url || url.length > 4096 || url.startsWith("-") || /[\r\n\0]/.test(url)) return result("generation sync remote is invalid");
    if (await (opts.visibility ?? remoteVisibility)(url) !== "private") return result("generation sync requires positively verified private remote visibility");
    if (opts.signal?.aborted) return result("stopped");
    releaseMutation = acquireMutation(dir);
    if (!releaseMutation) return result("another generation mutation is running");
    releaseSync = lockSync(dir);
    if (!releaseSync) return result("another generation sync is running or its owner is unknown");
    validateGeneration(profile.home, generation);
    if (readProfileJSON(join(dir, "prune-plans", `pending-log-${store.machine.id}.json`)) !== undefined) fail("generation prune append requires its original plan to resume before sync");
    const ref = `refs/heads/amem/gen/${generation}`, descriptor = canonicalJSON(generationDescriptor(generation)), own = `log/${store.machine.id}.jsonl`;
    const sources = new Map(store.prunePort().snapshot().rows.map(source => [source.row.id, source]));
    const ownPrune = (row: PruneRow): void => {
      for (const target of row.targets) for (const witness of [{ id: target.id, hash: target.rowHash }, { id: target.basis.id, hash: target.basis.rowHash }]) {
        const source = sources.get(witness.id);
        if (!source || source.placement !== "synced" || !source.publicWitness || pruneRowHash(source.row) !== witness.hash) fail("generation own prune lacks verified public witnesses");
      }
    };
    if (!repo) {
      await required(["--git-dir", join(dir, ".git"), "--work-tree", dir, "init", "-q", dir], "generation repository initialization failed");
      await required(["symbolic-ref", "HEAD", ref], "generation branch initialization failed");
    }
    ownRepository(dir);
    if (realPath(await required(["rev-parse", "--show-toplevel"], "generation worktree unavailable")) !== realPath(dir)) fail("generation working tree is routed outside its directory");
    if (await required(["symbolic-ref", "--quiet", "HEAD"], "generation sync refuses detached HEAD") !== ref) fail("generation sync refuses an unexpected HEAD branch");
    rmSync(join(dir, ".git", "index.lock"), { force: true });
    if (existsSync(join(dir, ".git", "MERGE_HEAD"))) await required(["merge", "--abort"], "generation interrupted merge needs inspection", undefined);
    const who = ["-c", "user.name=agent-mem", "-c", `user.email=agent-mem@${store.machine.id}.invalid`];
    const blob = async (commit: string, path: string): Promise<string> => {
      const out = await required(["show", `${commit}:${path}`], "generation history blob unavailable");
      const size = Number(await required(["cat-file", "-s", `${commit}:${path}`], "generation history size unavailable"));
      if (size !== Buffer.byteLength(out) + 1 && !(size === 0 && out === "")) fail("generation history requires complete newline-terminated public files");
      return out;
    };
    // ponytail: audit every reachable tree at sync; cache verified immutable commit digests if measurements justify it.
    const audited = new Set<string>();
    const history = async (tip: string): Promise<void> => {
      const commits = (await required(["rev-list", tip], "generation history unavailable")).split("\n").filter(Boolean);
      for (const commit of commits) {
        if (!oid(commit)) fail("generation history identity is invalid");
        if (audited.has(commit)) continue;
        const entries = (await required(["ls-tree", "-r", "-z", commit], "generation tree unavailable")).split("\0").filter(Boolean);
        const paths: string[] = [];
        for (const entry of entries) {
          const match = /^(100644) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
          if (!match) return fail("generation history contains forbidden files or links");
          if (![".gitignore", "generation.json"].includes(match[3]!) && !segment(match[3]!)) fail("generation history contains forbidden files or links");
          const path = match[3]!; paths.push(path);
          const text = await blob(commit, path);
          if (path === "generation.json") { let value: unknown; try { value = JSON.parse(text); } catch { return fail("generation descriptor is invalid"); } if (canonicalJSON(value) !== descriptor) fail("generation history descriptor mismatch"); }
          else if (path === ".gitignore") { if (text !== IGNORE.trim()) fail("generation ignore contract mismatch"); }
          else validatePublic(text, generation, path, path === own ? ownPrune : undefined);
        }
        if (!paths.includes("generation.json") || !paths.includes(".gitignore")) fail("generation history inherits a non-generation commit");
        audited.add(commit);
      }
    };
    const localHead = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (localHead.code === 0) await history(localHead.out);
    else if (localHead.code !== 1) fail("generation HEAD is unavailable");
    const staged = await required(["diff", "--cached", "--name-only"], "generation index unavailable");
    if (staged.split("\n").filter(Boolean).some(path => ![".gitignore", "generation.json", own].includes(path))) fail("generation index has unrelated staged files");
    regular(join(dir, "generation.json"));
    if (regular(join(dir, own))) {
      const text = readFileSync(join(dir, own), "utf8");
      if (text && !text.endsWith("\n")) fail("generation own segment has an incomplete tail");
      validatePublic(text, generation, own, ownPrune);
    }
    if (existsSync(join(dir, ".gitignore"))) { if (!regular(join(dir, ".gitignore"))) fail("generation ignore unavailable"); }
    writeFileSync(join(dir, ".gitignore"), IGNORE, { mode: 0o600 });
    if (opts.remote) {
      const existing = await git(["remote", "get-url", "origin"]);
      if (existing.code === 0 && existing.out !== url) await required(["remote", "set-url", "origin", url], "generation remote replacement failed");
      if (existing.code !== 0) await required(["remote", "add", "origin", url], "generation remote configuration failed");
    }
    // Bind the actual expanded destinations, including pushurl/insteadOf rules, to the verified private URL.
    // Refuse user configuration that points elsewhere; never silently replace a push URL.
    const fetchURLs = (await required(["remote", "get-url", "--all", "origin"], "generation fetch destination unavailable")).split("\n").filter(Boolean);
    const pushURLs = (await required(["remote", "get-url", "--push", "--all", "origin"], "generation push destination unavailable")).split("\n").filter(Boolean);
    if (fetchURLs.length !== 1 || fetchURLs[0] !== url || pushURLs.length !== 1 || pushURLs[0] !== url) fail("generation sync refuses differing or multiple remote destinations");
    const remoteTip = async (branch: string): Promise<string | undefined> => {
      const listed = await git(["ls-remote", "--exit-code", "--heads", "origin", branch]);
      if (listed.code === 2) return undefined;
      if (listed.code !== 0) return fail(opts.signal?.aborted ? "stopped" : "generation remote lookup failed");
      const match = /^([a-f0-9]{40})\t(.+)$/.exec(listed.out);
      if (!match || match[2] !== branch) return fail("generation remote branch identity mismatch");
      return match[1];
    };
    const pull = async (): Promise<void> => {
      const expected = await remoteTip(ref);
      if (!expected) return;
      const incoming = `refs/amem/incoming/${randomBytes(16).toString("hex")}`;
      transientRefs.push({ ref: incoming });
      await required(["fetch", "-q", "--no-tags", "origin", `${ref}:${incoming}`], "generation fetch failed");
      const tip = await required(["rev-parse", "--verify", incoming], "generation fetched ref unavailable");
      await history(tip);
      // Append-only convergence: a remote must never require rewriting an existing segment prefix.
      const names = (await required(["ls-tree", "-r", "--name-only", tip], "generation incoming tree unavailable")).split("\n").filter(segment);
      for (const path of names) if (regular(join(dir, path))) {
        const local = readFileSync(join(dir, path), "utf8"), remote = await blob(tip, path), complete = remote ? remote + "\n" : "";
        if (!local.startsWith(complete) && !complete.startsWith(local)) fail("generation segment diverged; person inspection required");
      }
      const before = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
      const merged = await git(before.code === 0 ? [...who, "merge", "-q", "--no-edit", "--no-verify", "--allow-unrelated-histories", incoming] : ["merge", "--ff-only", incoming]);
      if (merged.code !== 0) {
        await syncGit(dir, ["merge", "--abort"]); // cleanup deliberately ignores an already-aborted invocation signal
        fail(opts.signal?.aborted ? "stopped" : "generation merge failed");
      }
    };
    // Commit only this machine's append, plus the fixed public metadata. Never stage the bridge or other machines.
    await required(["add", "--", ".gitignore", "generation.json", ...(existsSync(join(dir, own)) ? [own] : [])], "generation staging failed");
    const dirty = await git(["diff", "--cached", "--quiet"]);
    if (dirty.code === 1) await required([...who, "commit", "-q", "--no-verify", "-m", "memory: generation append"], "generation commit failed");
    else if (dirty.code !== 0) fail("generation staged comparison failed");
    await pull();
    // Fetch legacy main into a separate bare cache; publish its fixed read ref only after FF and CAS validation.
    const main = await remoteTip("refs/heads/main"), prior = legacyHead(profile.home, generation);
    if (!main && prior) fail("legacy main disappeared; person inspection required");
    if (main) {
      const cache = join(dir, "bridge.git");
      if (existsSync(cache) && (lstatSync(cache).isSymbolicLink() || !lstatSync(cache).isDirectory())) fail("legacy cache is not a separate directory");
      if (!existsSync(cache)) await required(["init", "-q", "--bare", cache], "legacy cache initialization failed");
      if (existsSync(join(cache, "commondir")) || existsSync(join(cache, "objects", "info", "alternates"))
        || await required(["--git-dir", cache, "rev-parse", "--is-bare-repository"], "legacy cache identity unavailable") !== "true") fail("legacy cache must be an independent bare repository");
      const temp = `refs/amem/legacy-fetch/${randomBytes(16).toString("hex")}`; transientRefs.push({ cache, ref: temp });
      await required(["--git-dir", cache, "fetch", "-q", "--no-tags", "--", url, `refs/heads/main:${temp}`], "legacy cache fetch failed");
      const head = await required(["--git-dir", cache, "rev-parse", "--verify", temp], "legacy cache fetched ref unavailable");
      if (!oid(head)) fail("legacy cache commit identity invalid");
      if (prior) await required(["--git-dir", cache, "merge-base", "--is-ancestor", prior, head], "legacy main history is not fast-forward");
      readLegacySnapshot(profile.home, { generation, commit: head, previousCommit: prior });
      await required(["--git-dir", cache, "update-ref", "refs/remotes/legacy/main", head, prior ?? zero], "legacy cache ref changed concurrently");
    }
    if (opts.signal?.aborted) return result("stopped");
    await history(await required(["rev-parse", "--verify", "HEAD"], "generation final HEAD unavailable"));
    let sent = await git(["push", "-q", "origin", `HEAD:${ref}`]);
    if (sent.code !== 0 && !opts.signal?.aborted) { await pull(); await history(await required(["rev-parse", "--verify", "HEAD"], "generation retry HEAD unavailable")); sent = await git(["push", "-q", "origin", `HEAD:${ref}`]); }
    if (sent.code !== 0) fail(opts.signal?.aborted ? "stopped" : "generation push failed");
    pushed = true;
    return store.withDeferredPromotions(() => { store.refresh(); return { ok: true, pushed, entries: store.counts().long }; });
  } catch (error) {
    const reason = error instanceof Error && /^(generation |legacy |stopped)/.test(error.message) ? error.message.slice(0, 200) : "generation sync unavailable";
    return result(reason);
  } finally {
    for (const transient of transientRefs) { try { await syncGit(dir, [...(transient.cache ? ["--git-dir", transient.cache] : []), "update-ref", "-d", transient.ref]); } catch { /* local refs remain non-public if cleanup itself fails */ } }
    try { releaseSync?.(); } catch { /* cleanup cannot turn an observed sync result into an uncaught error */ }
    try { releaseMutation?.(); } catch { /* closed/broken derived lock is a local recovery concern */ }
  }
}
