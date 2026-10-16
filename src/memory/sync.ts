import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { memoryGitArgv, memoryGitEnv, processLiveness, processSignature } from "./platform.ts";
import type { MemoryStore } from "./store.ts";

/**
 * #258 phase 2: hub memory between a person's machines through a git remote they configure. The memory directory is a
 * git repository that tracks only `log/*.jsonl`; each machine commits only its own segment, so a merge of another
 * machine's history never conflicts. Pull, then push; fail-open: a failure is a result with one reason, never a throw.
 */
export type Visibility = "public" | "private" | "unknown";
export interface SyncResult { ok: boolean; pushed: boolean; entries: number; warning?: string; error?: string }

const GITIGNORE = "/*\n!/.gitignore\n!/log/\n/log/*\n!/log/*.jsonl\n";
const STEP_MS = 60_000;

async function git(dir: string, args: string[], signal?: AbortSignal, ms = STEP_MS): Promise<{ code: number; out: string; err: string }> {
  if (signal?.aborted) return { code: -1, out: "", err: "stopped" };
  const p = Bun.spawn(memoryGitArgv(["-C", dir, ...args], { credentials: true }), { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: memoryGitEnv() });
  // SIGTERM first, so git removes its lock files; SIGKILL only if it is still there after a grace period.
  let hard: ReturnType<typeof setTimeout> | undefined;
  const kill = () => { p.kill("SIGTERM"); hard ??= setTimeout(() => p.kill("SIGKILL"), 2_000); };
  const timer = setTimeout(kill, ms);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out: out.trim(), err: err.trim() };
  } finally { clearTimeout(timer); if (hard) clearTimeout(hard); signal?.removeEventListener("abort", kill); }
}

/** GitHub remotes are asked through `gh`; any other host, or a `gh` that cannot answer, is unknown. */
export async function remoteVisibility(url: string): Promise<Visibility> {
  const repo = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url)?.[1];
  if (!repo) return "unknown";
  try {
    const p = Bun.spawn(["gh", "repo", "view", repo, "--json", "visibility", "--jq", ".visibility"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
    const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    clearTimeout(timer);
    const v = out.trim().toLowerCase();
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
  /** A stopping hub aborts: the running git step is killed and the sync ends without touching the store. */
  signal?: AbortSignal;
}

export async function syncMemory(store: MemoryStore, opts: SyncOptions = {}): Promise<SyncResult> {
  const dir = store.dir;
  const fail = (error: string): SyncResult => ({ ok: false, pushed: false, entries: 0, error });
  if (opts.signal?.aborted) return fail("stopped");
  const noRemote = "no sync remote: a person sets one with ahub memory sync --remote <private git url>";
  if (!opts.remote && !existsSync(join(dir, ".git"))) return fail(noRemote); // never set up: nothing to do, nothing created
  const release = lock(dir);
  if (!release) return fail("another sync is running on this machine");
  try {
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
    if (visibility === "public") return fail("the sync remote is public; hub memory syncs only to a private remote");
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
    store.refresh();
    return { ok: true, pushed, entries: store.counts().long, ...(warning ? { warning } : {}) };
  } catch (e) {
    return fail((e as Error).message.slice(0, 200));
  } finally { release(); }
}
