import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, entryId } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { hashJSON } from "../src/memory/generation.ts";
import { legacyHead } from "../src/memory/bridge.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { planPrune, pruneId } from "../src/memory/prune.ts";
import { syncGenerationMemory } from "../src/memory/generation-sync.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";

const dirs: string[] = [], closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const G = "c".repeat(32), ref = `refs/heads/amem/gen/${G}`, privateRemote = { visibility: async () => "private" as const };
function temp() { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-generation-sync-"))); dirs.push(dir); return dir; }
function git(dir: string, ...args: string[]) {
  const run = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`fixture git failed: ${run.stderr}`);
  return run.stdout.trim();
}
function remote() { const dir = temp(); git(dir, "init", "-q", "--bare"); return dir; }
function tracked(dir: string, target: string) { return git(dir, "ls-tree", "-r", "--name-only", target).split("\n").filter(Boolean).sort(); }
async function generation(remoteUrl?: string) {
  const home = temp(), legacy = new MemoryStore({ home, profile: "shared-v1", deferPromotions: true });
  const memoryDir = legacy.dir;
  if (remoteUrl) {
    legacy.note({ op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "legacy input only", about: [] });
    expect((await syncMemory(legacy, { remote: remoteUrl, ...privateRemote })).ok).toBe(true);
  }
  legacy.close();
  await migrate({ memoryDir, generation: G, mode: "apply", authorizedPerson: true, tty: true });
  const store = new MemoryStore({ home, profile: { generation: G }, deferPromotions: true });
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  closes.push(close);
  return { home, memoryDir, store, close };
}
function note(store: MemoryStore, text: string, tier: "short" | "long" = "long") {
  return store.note({ op: "note", project: "agent-hub", scope: "project", tier, kind: "decision", peer: "person", source: "person", text, about: [] });
}

test("generation sync uses an isolated ref/repository and only public own-machine segments", async () => {
  const url = remote(), a = await generation(url), b = await generation(url);
  const legacyMain = git(url, "rev-parse", "refs/heads/main"), rootHead = git(a.memoryDir, "rev-parse", "HEAD");
  note(a.store, "generation decision from a"); note(b.store, "generation decision from b");
  note(a.store, "LOCAL-MARKER-short", "short");
  writeFileSync(join(a.store.dir, "candidates.db"), "LOCAL-MARKER-candidate");
  expect(await syncGenerationMemory(a.store, { remote: url, ...privateRemote })).toMatchObject({ ok: true, pushed: true });
  expect(await syncGenerationMemory(b.store, { remote: url, ...privateRemote })).toMatchObject({ ok: true, pushed: true });
  expect(await syncGenerationMemory(a.store, privateRemote)).toMatchObject({ ok: true, pushed: true });
  expect(b.store.list().map(row => row.text)).toEqual(expect.arrayContaining(["generation decision from a", "generation decision from b"]));
  expect(git(url, "rev-parse", "refs/heads/main")).toBe(legacyMain);
  expect(git(a.memoryDir, "rev-parse", "HEAD")).toBe(rootHead);
  expect(tracked(url, ref)).toEqual([".gitignore", "generation.json", `log/${a.store.machine.id}.jsonl`, `log/${b.store.machine.id}.jsonl`].sort());
  for (const file of tracked(url, ref)) expect(git(url, "show", `${ref}:${file}`)).not.toContain("LOCAL-MARKER");
  expect(git(a.store.dir, "symbolic-ref", "HEAD")).toBe(ref);
  expect(git(a.store.dir, "--git-dir", join(a.store.dir, "bridge.git"), "rev-parse", "--is-bare-repository")).toBe("true");
  expect(legacyHead(a.memoryDir, G)).toBe(legacyMain);
  expect(git(a.store.dir, "for-each-ref", "--format=%(refname)", "refs/amem/")).toBe("");
}, 60_000);

test("public/unknown visibility and cancellation refuse before repository or cache initialization", async () => {
  const url = remote(), { store } = await generation();
  for (const visibility of ["public", "unknown"] as const) {
    expect(await syncGenerationMemory(store, { remote: url, visibility: async () => visibility })).toMatchObject({ ok: false, pushed: false });
    expect(existsSync(join(store.dir, ".git"))).toBe(false);
    expect(existsSync(join(store.dir, "bridge.git"))).toBe(false);
  }
  const controller = new AbortController();
  expect(await syncGenerationMemory(store, { remote: url, signal: controller.signal, visibility: async () => { controller.abort(); return "private"; } })).toMatchObject({ ok: false, error: "stopped" });
  expect(existsSync(join(store.dir, ".git"))).toBe(false);
});

test("wrong HEAD and private historical trees are rejected even after the private file was deleted", async () => {
  const url = remote(), { store } = await generation(); note(store, "ordinary public generation note");
  expect((await syncGenerationMemory(store, { remote: url, ...privateRemote })).ok).toBe(true);
  const safeHead = git(url, "rev-parse", ref);
  git(store.dir, "symbolic-ref", "HEAD", "refs/heads/main");
  expect(await syncGenerationMemory(store, privateRemote)).toMatchObject({ ok: false, error: expect.stringContaining("HEAD") });
  git(store.dir, "symbolic-ref", "HEAD", ref);
  const privateFile = join(store.dir, "private-receipt.txt"); writeFileSync(privateFile, "LOCAL-MARKER-history");
  git(store.dir, "add", "-f", "--", "private-receipt.txt");
  const who = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];
  git(store.dir, ...who, "commit", "-q", "-m", "fixture private historical tree");
  git(store.dir, "rm", "-q", "--", "private-receipt.txt"); git(store.dir, ...who, "commit", "-q", "-m", "fixture removed private head file");
  expect(await syncGenerationMemory(store, privateRemote)).toMatchObject({ ok: false, error: expect.stringContaining("forbidden") });
  expect(git(url, "rev-parse", ref)).toBe(safeHead);
}, 30_000);

test("local prune payload and symlinked public segments cannot be published", async () => {
  for (const fault of ["local-prune", "symlink"] as const) {
    const url = remote(), { store } = await generation(), own = join(store.dir, "log", `${store.machine.id}.jsonl`);
    if (fault === "symlink") {
      const secret = join(store.dir, "private.txt"); writeFileSync(secret, "LOCAL-MARKER-link"); symlinkSync(secret, own);
    } else {
      const body = { schema: "agent-mem.prune/v1", op: "prune", generation: G, at: "2026-10-18T00:00:00.000Z", machine: store.machine.id, actor: "person", placement: "local", cutoff: "2026-10-18T00:00:00.000Z", targets: [{ id: "1".repeat(32), rowHash: "2".repeat(64), expiredAt: "2026-10-17T00:00:00.000Z", basis: { kind: "note", id: "1".repeat(32), rowHash: "2".repeat(64) } }] };
      appendFileSync(own, JSON.stringify({ ...body, id: hashJSON(body).slice(0, 32) }) + "\n");
    }
    expect(await syncGenerationMemory(store, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: false });
    expect(memoryGitSync(["-C", url, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" }).status).not.toBe(0);
  }
}, 30_000);

test("legacy main cache accepts late append input and preserves its old ref on non-fast-forward history", async () => {
  const url = remote(), state = await generation(url), { store, memoryDir, home } = state;
  expect((await syncGenerationMemory(store, { remote: url, ...privateRemote })).ok).toBe(true);
  const prior = legacyHead(memoryDir, G)!;
  const oldWriter = new MemoryStore({ home, profile: "shared-v1", deferPromotions: true });
  note(oldWriter, "late independently authored legacy note");
  expect((await syncMemory(oldWriter, privateRemote)).ok).toBe(true); oldWriter.close();
  const late = git(url, "rev-parse", "refs/heads/main"); expect(late).not.toBe(prior);
  expect((await syncGenerationMemory(store, privateRemote)).ok).toBe(true);
  expect(legacyHead(memoryDir, G)).toBe(late);
  expect(store.list().some(row => row.text === "late independently authored legacy note")).toBe(true);
  // A real unrelated legacy history is fetched only into a temporary cache ref and must never replace the good read ref.
  const unrelated = temp(); git(unrelated, "init", "-q"); writeFileSync(join(unrelated, "placeholder"), "fixture"); git(unrelated, "add", "placeholder");
  git(unrelated, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "unrelated legacy root");
  git(unrelated, "push", "-q", "--force", url, "HEAD:refs/heads/main");
  expect(await syncGenerationMemory(store, privateRemote)).toMatchObject({ ok: false, error: expect.stringContaining("fast-forward") });
  expect(legacyHead(memoryDir, G)).toBe(late);
  expect(git(store.dir, "--git-dir", join(store.dir, "bridge.git"), "for-each-ref", "--format=%(refname)", "refs/amem/")).toBe("");
}, 60_000);

test("empty legacy main remains absent until explicitly fetched content exists", async () => {
  const url = remote(), { store, memoryDir } = await generation();
  expect((await syncGenerationMemory(store, { remote: url, ...privateRemote })).ok).toBe(true);
  expect((await syncGenerationMemory(store, privateRemote)).ok).toBe(true);
  expect(legacyHead(memoryDir, G)).toBeUndefined();
  expect(memoryGitSync(["-C", url, "rev-parse", "--verify", "--quiet", "refs/heads/main"], { encoding: "utf8" }).status).not.toBe(0);
});

test("inherited Git routing/index/object environment cannot redirect a generation sync into legacy storage", async () => {
  const url = remote(), state = await generation(url), { store, memoryDir, home } = state;
  note(store, "generation environment isolation note"); state.close();
  const legacyHeadBefore = git(memoryDir, "rev-parse", "HEAD"), legacyIndex = readFileSync(join(memoryDir, ".git", "index"));
  const wrapper = join(home, "environment-sync.ts"), cliStore = join(import.meta.dir, "../src/memory/store.ts"), cliSync = join(import.meta.dir, "../src/memory/generation-sync.ts");
  writeFileSync(wrapper, `Object.assign(process.env, ${JSON.stringify({ GIT_DIR: join(memoryDir, ".git"), GIT_WORK_TREE: memoryDir, GIT_INDEX_FILE: join(memoryDir, ".git", "index"), GIT_OBJECT_DIRECTORY: join(memoryDir, ".git", "objects") })});
const {MemoryStore}=await import(${JSON.stringify(cliStore)});
const {syncGenerationMemory}=await import(${JSON.stringify(cliSync)});
const store=new MemoryStore({home:${JSON.stringify(home)},profile:{generation:${JSON.stringify(G)}},deferPromotions:true});
try{ console.log(JSON.stringify(await syncGenerationMemory(store,{remote:${JSON.stringify(url)},visibility:async()=>"private"}))); }finally{store.close();}
`);
  const child = Bun.spawn([process.execPath, wrapper], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0); expect(JSON.parse(stdout)).toMatchObject({ ok: true, pushed: true });
    expect(git(memoryDir, "rev-parse", "HEAD")).toBe(legacyHeadBefore);
    expect(readFileSync(join(memoryDir, ".git", "index"))).toEqual(legacyIndex);
    expect(tracked(url, ref)).toContain(`log/${store.machine.id}.jsonl`);
  } finally { clearTimeout(timer); }
}, 30_000);

test("a generation ref inheriting legacy history is refused before merge or push", async () => {
  const url = remote(), { store } = await generation(url);
  note(store, "generation-only branch history");
  expect((await syncGenerationMemory(store, { remote: url, ...privateRemote })).ok).toBe(true);
  const local = git(store.dir, "rev-parse", "HEAD"), main = git(url, "rev-parse", "refs/heads/main");
  git(url, "update-ref", ref, main);
  expect(await syncGenerationMemory(store, privateRemote)).toMatchObject({ ok: false, pushed: false, error: expect.stringContaining("generation") });
  expect(git(store.dir, "rev-parse", "HEAD")).toBe(local);
  expect(git(url, "rev-parse", ref)).toBe(main);
});

test("repository core.worktree routing outside G refuses sync before staging", async () => {
  const url = remote(), { store, memoryDir } = await generation(url);
  expect((await syncGenerationMemory(store, { remote: url, ...privateRemote })).ok).toBe(true);
  const before = git(memoryDir, "rev-parse", "HEAD"), index = readFileSync(join(memoryDir, ".git", "index"));
  git(store.dir, "config", "core.worktree", memoryDir);
  expect(await syncGenerationMemory(store, privateRemote)).toMatchObject({ ok: false, pushed: false, error: expect.stringContaining("routed outside") });
  expect(git(memoryDir, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(memoryDir, ".git", "index"))).toEqual(index);
});


test("own rehashed local-to-synced prunes cannot track or push private target or basis identities", async () => {
  for (const fault of ["private-target", "private-basis"] as const) {
    const url = remote(), { store } = await generation();
    let target: string;
    if (fault === "private-target") target = store.note({ op: "note", project: "agent-hub", scope: "project", tier: "short", kind: "finding", peer: "person", source: "person", text: "LOCAL-MARKER-private-prune-target", about: [], expires: new Date(Date.now() - 1000).toISOString() });
    else {
      target = note(store, "ordinary public target with a private local expiry basis");
      const body = { schema: "agent-hub.memory/v1" as const, op: "demote" as const, at: new Date().toISOString(), machine: store.machine.id, target, by: new Date(Date.now() - 1000).toISOString(), actor: "person" };
      appendFileSync(join(store.dir, "local", `${store.machine.id}.jsonl`), JSON.stringify({ ...body, id: entryId(body) }) + "\n");
    }
    const plan = planPrune(store.prunePort(), { cutoff: new Date().toISOString(), targets: [target] }, { project: "agent-hub", actor: "person", authorize: () => true });
    expect(plan.rows).toHaveLength(1); expect(plan.rows[0]!.placement).toBe("local");
    const { id: _original, ...localBody } = plan.rows[0]!.payload;
    const body = { ...localBody, placement: "synced" as const };
    const forged = { ...body, id: pruneId(body) }, own = `log/${store.machine.id}.jsonl`;
    appendFileSync(join(store.dir, own), JSON.stringify(forged) + "\n");
    expect(await syncGenerationMemory(store, { remote: url, ...privateRemote })).toMatchObject({ ok: false, pushed: false, error: expect.stringContaining("public witnesses") });
    expect(git(store.dir, "ls-files")).not.toContain(own);
    expect(memoryGitSync(["-C", url, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" }).status).not.toBe(0);
  }
}, 30_000);

test("private fetch plus a public pushurl refuses without altering push configuration or public refs", async () => {
  const privateURL = remote(), publicURL = remote(), { store } = await generation();
  note(store, "ordinary private-remote generation note");
  expect((await syncGenerationMemory(store, { remote: privateURL, ...privateRemote })).ok).toBe(true);
  git(store.dir, "remote", "set-url", "--push", "origin", publicURL);
  note(store, "this append must not reach the public push URL");
  const privateHead = git(privateURL, "rev-parse", ref);
  const visibility = async (url: string) => url === privateURL ? "private" as const : "public" as const;
  expect(await syncGenerationMemory(store, { remote: privateURL, visibility })).toMatchObject({ ok: false, pushed: false, error: expect.stringContaining("destinations") });
  expect(git(store.dir, "remote", "get-url", "--push", "origin")).toBe(publicURL);
  expect(git(publicURL, "for-each-ref", "--format=%(refname)")).toBe("");
  expect(git(privateURL, "rev-parse", ref)).toBe(privateHead);
}, 30_000);

test("expanded fetch rewrites and multiple push URLs cannot bypass the verified destination", async () => {
  const privateURL = remote(), publicURL = remote(), { store } = await generation();
  note(store, "generation remote rewrite probe");
  expect((await syncGenerationMemory(store, { remote: privateURL, ...privateRemote })).ok).toBe(true);
  const before = git(privateURL, "rev-parse", ref);
  git(store.dir, "config", `url.${publicURL}.insteadOf`, privateURL);
  expect(await syncGenerationMemory(store, { remote: privateURL, visibility: async url => url === privateURL ? "private" : "public" })).toMatchObject({ ok: false, pushed: false, error: expect.stringContaining("destinations") });
  git(store.dir, "config", "--unset-all", `url.${publicURL}.insteadOf`);
  git(store.dir, "remote", "set-url", "--add", "--push", "origin", privateURL);
  git(store.dir, "remote", "set-url", "--add", "--push", "origin", publicURL);
  expect(await syncGenerationMemory(store, privateRemote)).toMatchObject({ ok: false, pushed: false, error: expect.stringContaining("destinations") });
  expect(git(publicURL, "for-each-ref", "--format=%(refname)")).toBe("");
  expect(git(privateURL, "rev-parse", ref)).toBe(before);
}, 30_000);
