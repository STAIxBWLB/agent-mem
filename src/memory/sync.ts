import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { rebindPublicPruneProfile } from "./generation.ts";
import { memoryGitArgv, memoryGitEnv, processLiveness, processSignature } from "./platform.ts";
import { acquireMutation } from "./mutation.ts";
import type { MemoryStore } from "./store.ts";
import { syncGenerationMemory } from "./generation-sync.ts";
import { outboundScreen, screenOutboundRows, screenOwnSegment, type RowScreen } from "./sync-screen.ts";

/**
 * #258 phase 2: hub memory between a person's machines through a git remote they configure. The memory directory is a
 * git repository that tracks only `log/*.jsonl`; each machine commits only its own segment, so a merge of another
 * machine's history never conflicts. Pull, then push; fail-open: a failure is a result with one reason, never a throw.
 */
export type Visibility = "public" | "private" | "unknown";
export interface SyncResult { ok: boolean; pushed: boolean; entries: number; warning?: string; error?: string;
  pruneApplication?: {transport:"durable"|"unconfirmed";proofComplete:number;projectionActive:number|null;nativeApplied:number|null;held:number;phase:"preflight"|"prepared"|"active"|"complete"};
}

const GITIGNORE = "/*\n!/.gitignore\n!/log/\n/log/*\n!/log/*.jsonl\n";
const STEP_MS = 60_000;

/**
 * Git runs in its own process group when the caller passes a stop signal (see `git` below), so that group no longer receives what the terminal sends to amem's own. Every
 * such group is registered here while it lives, and a process that exits for any reason (a second Ctrl-C, SIGHUP when the terminal closes, SIGQUIT, a throw) signals each one
 * before it goes: a git left at ppid 1 with no deadline would hold `sync.lock`'s repository while the next sync removes its `index.lock`. The exit handler is synchronous and
 * installed once, only when the first group is registered, so a process that never runs a deadline git does not get one. SIGKILL of amem itself cannot be handled by anyone.
 */
const liveGroups = new Set<number>();
let exitHandler = false;
function signalGroups(name: "SIGTERM" | "SIGKILL"): void { for (const pid of liveGroups) { try { process.kill(-pid, name); } catch { /* the group is already gone */ } } }
function register(pid: number): () => void {
  if (!exitHandler) { exitHandler = true; process.on("exit", () => signalGroups("SIGKILL")); }
  liveGroups.add(pid);
  return () => { liveGroups.delete(pid); };
}
/** Test seam: how many deadline-git groups are alive right now, and a way to stop them as the exit handler would. */
export const syncGroupsForTest = { live: () => liveGroups.size, stopAll: () => signalGroups("SIGKILL") };

async function git(dir: string, args: string[], signal?: AbortSignal, ms = STEP_MS): Promise<{ code: number; out: string; err: string }> {
  if (signal?.aborted) return { code: -1, out: "", err: "stopped" };
  // A caller that passes a stop signal (`amem sync --if-due`, a stopping hub) gets git in its own process group, so a stop reaches the transport children git started (ssh, a
  // credential helper): killing only git's pid left them running. The price is that a terminal Ctrl-C no longer reaches git by itself, so such a caller must turn its own
  // interrupt into the signal (`stopSignal` in sync-cadence.ts does). A call with no signal keeps the unchanged spawn.
  const group = signal !== undefined;
  const p = Bun.spawn(memoryGitArgv(["-C", dir, ...args], { credentials: true }), { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: memoryGitEnv(), ...(group ? { detached: true } : {}) });
  const send = (name: "SIGTERM" | "SIGKILL") => { if (group) { try { process.kill(-p.pid, name); return; } catch { /* no group left: fall through to the pid */ } } p.kill(name); };
  const unregister = group ? register(p.pid) : () => {};
  // SIGTERM first, so git removes its lock files; SIGKILL only if it is still there after a grace period.
  let hard: ReturnType<typeof setTimeout> | undefined;
  let signalled = false;
  const kill = () => { signalled = true; send("SIGTERM"); hard ??= setTimeout(() => send("SIGKILL"), 2_000); };
  const timer = setTimeout(kill, ms);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out: out.trim(), err: err.trim() };
  } finally {
    // git is gone, but a transport child in its group that ignored SIGTERM (a credential helper, a proxy) may not be, and the timer that would have killed it is cleared below. Once the
    // group was signalled, SIGKILL whatever is left of it (ESRCH when nothing is) before it is forgotten: it would otherwise live on at ppid 1 holding the repository.
    if (group && signalled) try { process.kill(-p.pid, "SIGKILL"); } catch { /* the group is already gone */ }
    unregister(); clearTimeout(timer); if (hard) clearTimeout(hard); signal?.removeEventListener("abort", kill);
  }
}

export { git as syncGit };

/** Shared hardening for text history queries and bounded binary object reads. */
function spawnGenerationGit(dir: string, args: string[], group: boolean) {
  // The shell receives only positional arguments; its umask is child-local.
  return Bun.spawn(["/bin/sh", "-c", 'umask 077; exec "$@"', "amem-git", ...memoryGitArgv(["-C", dir, ...args], { credentials: true })], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: memoryGitEnv(process.env, { repositoryIsolation: true }), ...(group ? { detached: true } : {}) });
}

/** Generation-only process isolation; shared-v1 above retains its pre-P9 spawn and environment contract. */
export async function generationSyncGit(dir: string, args: string[], signal?: AbortSignal, ms = STEP_MS): Promise<{ code: number; out: string; err: string }> {
  if (signal?.aborted) return { code: -1, out: "", err: "stopped" };
  // A fixed child-only umask keeps Git-created metadata private without changing the daemon's process umask.
  // Args are positional shell parameters, never interpolated or evaluated as shell code.
  const group = signal !== undefined;   // see `git` above: own process group when the caller has a deadline
  const p = spawnGenerationGit(dir, args, group);
  const send = (name: "SIGTERM" | "SIGKILL") => { if (group) { try { process.kill(-p.pid, name); return; } catch { /* no group left: fall through to the pid */ } } p.kill(name); };
  const unregister = group ? register(p.pid) : () => {};
  // SIGTERM first, so git removes its lock files; SIGKILL only if it is still there after a grace period.
  let hard: ReturnType<typeof setTimeout> | undefined;
  let signalled = false;
  const kill = () => { signalled = true; send("SIGTERM"); hard ??= setTimeout(() => send("SIGKILL"), 2_000); };
  const timer = setTimeout(kill, ms);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out: out.trim(), err: err.trim() };
  } finally {
    // git is gone, but a transport child in its group that ignored SIGTERM (a credential helper, a proxy) may not be, and the timer that would have killed it is cleared below. Once the
    // group was signalled, SIGKILL whatever is left of it (ESRCH when nothing is) before it is forgotten: it would otherwise live on at ppid 1 holding the repository.
    if (group && signalled) try { process.kill(-p.pid, "SIGKILL"); } catch { /* the group is already gone */ }
    unregister(); clearTimeout(timer); if (hard) clearTimeout(hard); signal?.removeEventListener("abort", kill);
  }
}


/** Exact Git object bytes. Bounds apply only here, never to full text history audits. */
export async function generationSyncGitBytes(dir: string, args: string[], signal?: AbortSignal, ms = STEP_MS, maxBytes = 2 * 1024 * 1024): Promise<{ code: number; out: Uint8Array; err: string }> {
  const empty = () => new Uint8Array(0);
  if (signal?.aborted) return { code: -1, out: empty(), err: "stopped" };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isFinite(ms) || ms <= 0) return { code: -1, out: empty(), err: "invalid git output bound or deadline" };
  // A bound or deadline can stop this call even without a caller signal, so always own its group.
  const p = spawnGenerationGit(dir, args, true), unregister = register(p.pid);
  const send = (name: "SIGTERM" | "SIGKILL") => {
    try { process.kill(-p.pid, name); } catch { try { p.kill(name); } catch { /* already exited */ } }
  };
  let hard: ReturnType<typeof setTimeout> | undefined, stopped = false, overflow = false;
  const kill = () => { stopped = true; send("SIGTERM"); hard ??= setTimeout(() => send("SIGKILL"), 2_000); };
  const timer = setTimeout(kill, ms);
  signal?.addEventListener("abort", kill, { once: true });
  // Drain both pipes concurrently, including after overflow. Waiting on exit before draining
  // deadlocks a full pipe; cancelling a reader can leave inherited child pipes unaccounted for.
  const collect = async (stream: ReadableStream<Uint8Array>, limit: number, refuse: boolean): Promise<Buffer> => {
    const reader = stream.getReader(), chunks: Buffer[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        const bytes = part.value, remaining = limit - size;
        if (refuse && bytes.byteLength > remaining) { overflow = true; chunks.length = 0; kill(); }
        if (!refuse || !overflow) {
          const keep = Math.min(remaining, bytes.byteLength);
          if (keep) { chunks.push(Buffer.from(bytes.subarray(0, keep))); size += keep; }
        }
      }
      return Buffer.concat(chunks);
    } finally { reader.releaseLock(); }
  };
  const operations = [p.exited, collect(p.stdout, maxBytes, true), collect(p.stderr, 65_536, false)] as const;
  try {
    const [code, out, err] = await Promise.all(operations);
    return overflow ? { code: -1, out: empty(), err: "git output exceeds byte bound" }
      : stopped ? { code: -1, out: empty(), err: "stopped" } : { code, out, err: err.toString("utf8").trim() };
  } catch {
    kill(); await Promise.allSettled(operations);
    return { code: -1, out: empty(), err: "git output unavailable" };
  } finally {
    // Reap descendants even if Git exited first while they retained its pipe handles.
    if (stopped) send("SIGKILL");
    unregister(); clearTimeout(timer); if (hard) clearTimeout(hard); signal?.removeEventListener("abort", kill);
  }
}


/**
 * The `owner/repo` of a remote URL whose host is EXACTLY `github.com` (case-insensitive) over `https://`, `ssh://git@github.com/` or the scp form
 * `[git@]github.com:`; anything else is undefined, so it is `unknown` and never asked. An unanchored match let `https://notgithub.com/acme/notes`,
 * `git@evil-github.com:acme/notes` and `https://git.example.org/mirror/github.com/acme/notes` resolve to `acme/notes` (task #121 review round 1; published 0.6.0
 * has the unanchored form). `http://` and `git://` are not verifiable as private transports and an explicit port is not github.com's, so both are unknown.
 */
export function githubRepoOf(url: string): string | undefined {
  const text = url.trim();
  if (!text || /[\s\u0000-\u001f\u007f\\]/.test(text) || text.length > 512) return undefined;
  let host: string, path: string;
  const scp = /^(?:([A-Za-z0-9._-]+)@)?([^:/@]+):([^/].*)$/.exec(text); // `[user@]host:path`, never a URL with `://`
  if (!text.includes("://") && scp) {
    if (scp[1] !== undefined && scp[1] !== "git") return undefined;
    host = scp[2]!; path = scp[3]!;
  } else {
    let parsed: URL;
    try { parsed = new URL(text); } catch { return undefined; }
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return undefined;
    if (parsed.port) return undefined;
    if (parsed.search || parsed.hash) return undefined;
    if (parsed.protocol === "ssh:" && parsed.username !== "git") return undefined;
    host = parsed.hostname; path = parsed.pathname.replace(/^\//, "");
  }
  if (host.toLowerCase() !== "github.com") return undefined;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(path);
  return match && match[2] !== "." && match[2] !== ".." ? `${match[1]}/${match[2]}` : undefined;
}

/** GitHub remotes are asked through `gh`, pinned to github.com; any other host, or a `gh` that cannot answer, is unknown. */
export async function remoteVisibility(url: string): Promise<Visibility> {
  const repo = githubRepoOf(url);
  if (!repo) return "unknown";
  try {
    // GH_HOST (and the enterprise token variables) would send `gh repo view` to a different server: pin it, so the answer is about github.com's repository.
    const env: Record<string, string | undefined> = { ...process.env, GH_HOST: "github.com" };
    delete env.GH_ENTERPRISE_TOKEN; delete env.GITHUB_ENTERPRISE_TOKEN;
    const p = Bun.spawn(["gh", "repo", "view", repo, "--json", "visibility", "--jq", ".visibility"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: env as Record<string, string> });
    const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
    const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    clearTimeout(timer);
    const v = out.trim().toLowerCase();
    // ponytail: `internal` (GitHub Enterprise Cloud: visible to the enterprise's members, not the public) counts as private, as `amem sync` always has. A stricter policy would map it to unknown.
    return code === 0 && (v === "private" || v === "internal") ? "private" : code === 0 && v === "public" ? "public" : "unknown";
  } catch { return "unknown"; }
}

/** One sync per machine at a time: hubs of several projects share the store. A lock whose owner is gone is taken over. */
function lock(dir: string): (() => void) | undefined {
  const file = join(dir, "sync.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, `${process.pid} ${processSignature(process.pid) ?? ""}\n`);
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch {
      let owner = "";
      try { owner = readFileSync(file, "utf8").trim(); } catch { continue; }
      const [pid, ...sig] = owner.split(" ");
      if (processLiveness(Number(pid), sig.join(" ") || undefined) !== "gone") return undefined;
      rmSync(file, { force: true });
    }
  }
  return undefined;
}

export interface SyncOptions {
  /** Set (or replace) the remote first: a person's choice. */
  remote?: string;
  visibility?: (url: string) => Promise<Visibility>;
  /** An extra screen over each outbound row's text, on top of the machine's configured policy (the CLI passes the repository-narrowed policy). */
  screen?: RowScreen;
  /** Host-only policy binding stamp, never authorization or a substitute for screening. */
  policyVersion?: () => string;
  /** A stopping hub aborts: the running git step is killed and the sync ends without touching the store. */
  signal?: AbortSignal;
}

/** Metadata-only sharded sync epoch. Hash complete source bytes, never notes or unopened shards. */
export function shardSyncBinding(store: MemoryStore): string { return captureShardSyncBinding(store, true); }
/** Selection bytes may change only after this sync commits; source/policy identity remains pinned across that commit. */
export function shardSyncSourceBinding(store: MemoryStore): string { return captureShardSyncBinding(store, false); }
function captureShardSyncBinding(store: MemoryStore, selection: boolean): string {
  const unavailable = (): never => { throw new Error("sharded sync binding unavailable"); };
  if (!store.profile.sharded) return unavailable();
  const uid = process.getuid?.(); if (uid === undefined) return unavailable();
  const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  const owned = (stat: BigIntStats, directory: boolean, privateMode = true) => {
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
      || stat.uid !== BigInt(uid) || privateMode && (stat.mode & 0o077n) !== 0n) unavailable();
  };
  const home = store.profile.home, digest = createHash("sha256"), directories = new Map<string, BigIntStats>(), checks: (() => void)[] = [];
  const emit = (value: unknown) => { digest.update(JSON.stringify(value) + "\n"); };
  const directory = (dir: string): void => {
    if (directories.has(dir)) return;
    const rel = relative(home, dir); if (rel === ".." || rel.startsWith(".." + sep)) unavailable();
    if (dir !== home) directory(dirname(dir));
    const before = lstatSync(dir, { bigint: true }); owned(before, true); directories.set(dir, before);
    emit(["directory", dir, String(before.dev), String(before.ino)]);
    checks.push(() => { const now = lstatSync(dir, { bigint: true }); owned(now, true); if (!same(before, now)) unavailable(); });
  };
  // Policy config keeps its established file modes inside this already-private owned home. Its complete bytes/inode still bind the epoch.
  const source = (file: string, privateMode = true): void => {
    directory(dirname(file));
    let before: BigIntStats;
    try { before = lstatSync(file, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      emit(["source", file, "absent"]);
      checks.push(() => { if (lstatSync(file, { bigint: true, throwIfNoEntry: false }) !== undefined) unavailable(); }); return;
    }
    owned(before, false, privateMode);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true }); owned(opened, false, privateMode); if (!same(before, opened)) unavailable();
      const content = createHash("sha256"), buffer = Buffer.allocUnsafe(65_536); let bytes = 0n;
      for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break; content.update(buffer.subarray(0, n)); bytes += BigInt(n); }
      const after = fstatSync(fd, { bigint: true }); owned(after, false, privateMode);
      if (bytes !== before.size || !same(before, after) || !same(before, lstatSync(file, { bigint: true }))) unavailable();
      emit(["source", file, "present", String(before.dev), String(before.ino), String(before.size), String(before.mtimeNs), String(before.ctimeNs), content.digest("hex")]);
    } finally { closeSync(fd); }
    checks.push(() => { const now = lstatSync(file, { bigint: true }); owned(now, false, privateMode); if (!same(before, now)) unavailable(); });
  };
  try {
    directory(home);
    for (const name of [...(selection ? ["profile.json", "shards.json"] : []), "aliases.jsonl", "amem.config.json", "machine.json"]) source(join(home, name), name !== "amem.config.json");
    const targets = [...store.openedSyncTargets()].sort((a, b) => a.dir.localeCompare(b.dir));
    for (const target of targets) {
      directory(target.dir);
      emit(["target", target.dir, target.profile.generation ?? null, target.machine.id, target.profile.shardUser ?? false, target.profile.shardKey ?? null]);
      for (const name of ["project.json", "generation.json", "generation-seal.json", "machine.json"]) source(join(target.dir, name));
    }
    for (const check of checks) check();
    return digest.digest("hex");
  } catch { return unavailable(); }
}

export async function syncMemory(store: MemoryStore, opts: SyncOptions = {}): Promise<SyncResult> {
  if (store.profile.sharded) {
    try {
      // Refresh only through the existing proved monotone profile rebind before pinning this attempt.
      for (const target of store.openedSyncTargets()) rebindPublicPruneProfile(target.profile);
      const binding = shardSyncBinding(store), policyVersion = opts.policyVersion?.();
      const assertBinding = () => {
        if (opts.policyVersion?.() !== policyVersion || shardSyncBinding(store) !== binding) throw new Error("binding changed");
      };
      assertBinding();
      const screen = outboundScreen(store.profile.home, opts.screen);
      const pass: RowScreen = row => { assertBinding(); const accepted = screen(row); assertBinding(); if (typeof accepted !== "boolean") throw new Error("invalid screen result"); return accepted; };
      for (const target of store.openedSyncTargets()) {
        const screened = screenOutboundRows(target, pass); assertBinding();
        if (!screened.ok) return { ok: false, pushed: false, entries: 0, error: screened.reason };
      }
      const transport = await import("./shard-sync.ts"); assertBinding();
      return transport.syncShardedMemory(store, opts);
    } catch { return { ok: false, pushed: false, entries: 0, error: "sharded sync binding or policy unavailable or changed" }; }
  }
  // F4: before anything is staged or pushed, this machine's own long-term notes pass the person's configured policy (every profile: single log, generation, shards).
  const pass = outboundScreen(store.profile.home, opts.screen);
  for (const target of store.openedSyncTargets()) {
    const screened = target.profile.kind === "generation" ? screenOutboundRows(target, pass) : screenOwnSegment(target.dir, target.machine.id, pass);
    if (!screened.ok) return { ok: false, pushed: false, entries: 0, error: screened.reason };
  }
  if (store.profile.kind === "generation") return syncGenerationMemory(store, opts);
  const dir = store.dir;
  const fail = (error: string): SyncResult => ({ ok: false, pushed: false, entries: 0, error });
  if (opts.signal?.aborted) return fail("stopped");
  const noRemote = "no sync remote: a person sets one with `amem sync --remote <private git url>`";
  if (!opts.remote && !existsSync(join(dir, ".git"))) return fail(noRemote); // never set up: nothing to do, nothing created
  const release = lock(dir);
  if (!release) return fail("another sync is running on this machine");
  let releaseMutation: (() => void) | undefined;
  try {
    releaseMutation = acquireMutation(dir);
    if (!releaseMutation) return fail("another memory mutation is running on this machine");
    // Holding sync.lock, no other git runs in this repository: what a killed one left behind is stale.
    rmSync(join(dir, ".git", "index.lock"), { force: true });
    if (existsSync(join(dir, ".git", "MERGE_HEAD"))) await git(dir, ["merge", "--abort"]);
    if (!existsSync(join(dir, ".git"))) {
      const init = await git(dir, ["init", "-q"], opts.signal);
      if (init.code !== 0) return fail(`git init failed: ${init.err.slice(0, 200)}`);
      await git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"], opts.signal);
    }
    if (!existsSync(join(dir, ".gitignore")) || readFileSync(join(dir, ".gitignore"), "utf8") !== GITIGNORE) writeFileSync(join(dir, ".gitignore"), GITIGNORE, { mode: 0o600 });
    if (opts.remote) {
      await git(dir, ["remote", "remove", "origin"], opts.signal);
      const add = await git(dir, ["remote", "add", "origin", opts.remote], opts.signal);
      if (add.code !== 0) return fail(`the remote could not be set: ${add.err.slice(0, 200)}`);
    }
    const url = (await git(dir, ["remote", "get-url", "origin"], opts.signal)).out;
    if (opts.signal?.aborted) return fail("stopped");
    if (!url) return fail(noRemote);
    // Long-term entries hold note text: a public remote would publish them.
    const visibility = await (opts.visibility ?? remoteVisibility)(url);
    if (visibility === "public") return fail("the sync remote is public; memory syncs only to a private remote");
    const warning = visibility === "unknown" ? "the sync remote's visibility is unknown; keep it private" : undefined;

    const own = `log/${store.machine.id}.jsonl`;
    const who = ["-c", "user.name=agent-hub", "-c", `user.email=agent-hub@${store.machine.id}.invalid`];
    const staged = await git(dir, ["add", "--", ".gitignore", ...(existsSync(join(dir, own)) ? [own] : [])], opts.signal);
    if (staged.code !== 0) return fail(`git add failed: ${staged.err.slice(0, 200)}`); // never a push that left this machine's entries out
    if ((await git(dir, ["diff", "--cached", "--quiet"], opts.signal)).code === 1) {
      const commit = await git(dir, [...who, "commit", "-q", "--no-verify", "-m", `memory: ${store.machine.label}`], opts.signal);
      if (commit.code !== 0) return fail(`commit failed: ${commit.err.slice(0, 200)}`);
    }
    const pull = async (): Promise<string | undefined> => {
      const fetch = await git(dir, ["fetch", "-q", "origin"], opts.signal);
      if (fetch.code !== 0) return `fetch failed: ${fetch.err.slice(0, 200)}`;
      if ((await git(dir, ["rev-parse", "--verify", "-q", "refs/remotes/origin/main"], opts.signal)).code !== 0) return undefined; // an empty remote
      if ((await git(dir, ["rev-parse", "--verify", "-q", "HEAD"], opts.signal)).code !== 0) {
        const checkout = await git(dir, ["checkout", "-q", "-B", "main", "refs/remotes/origin/main"], opts.signal);
        return checkout.code === 0 ? undefined : `checkout failed: ${checkout.err.slice(0, 200)}`;
      }
      // Each machine writes only its own segment, and every machine starts its own history: unrelated, never conflicting.
      const merge = await git(dir, [...who, "merge", "-q", "--no-edit", "--no-verify", "--allow-unrelated-histories", "refs/remotes/origin/main"], opts.signal);
      if (merge.code !== 0) { await git(dir, ["merge", "--abort"]); return `merge failed: ${merge.err.slice(0, 200)}`; } // cleanup runs even when stopping
      return undefined;
    };
    const pulled = await pull();
    if (pulled) return fail(pulled);
    let pushed = false;
    if ((await git(dir, ["rev-parse", "--verify", "-q", "HEAD"], opts.signal)).code === 0) {
      let push = await git(dir, ["push", "-q", "origin", "HEAD:refs/heads/main"], opts.signal);
      if (push.code !== 0) { // another machine pushed in between: take its history, then push once more
        const again = await pull();
        if (again) return fail(again);
        push = await git(dir, ["push", "-q", "origin", "HEAD:refs/heads/main"], opts.signal);
      }
      if (push.code !== 0) return fail(`push failed: ${push.err.slice(0, 200)}`);
      pushed = true;
    }
    if (opts.signal?.aborted) return fail("stopped");
    return store.withDeferredPromotions(() => {
      store.refresh();
      return { ok: true, pushed, entries: store.counts().long, ...(warning ? { warning } : {}) };
    });
  } catch (e) {
    return fail((e as Error).message.slice(0, 200));
  } finally { try { releaseMutation?.(); } finally { release(); } }
}
