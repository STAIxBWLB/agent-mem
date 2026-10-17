import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryGitSync } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { appendAlias, aliasLogPath, isLocalKey, listAliases, readShardDescriptor, resolveAlias, shardKeyHash } from "../src/memory/shard.ts";
import { runCli, PERSON_ONLY } from "../src/cli.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "amem-shard-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function git(dir: string, args: string[]): void {
  const r = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
}
function repo(path: string, origin?: string): string {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q"]);
  git(path, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  if (origin) git(path, ["remote", "add", "origin", origin]);
  return path;
}

test("a worktree, a same-remote submodule and the main checkout resolve to one project key (#15 AC2)", () => {
  const dir = home();
  const main = repo(join(dir, "main"), "git@github.com:Owner/Repo.git");
  const worktree = join(dir, "main-worktree");
  git(main, ["worktree", "add", "-q", "--detach", worktree]);
  // A submodule of the same repository carries the same origin URL in its own .git/config.
  const submodule = repo(join(dir, "parent", "modules", "main"), "https://github.com/Owner/Repo.git");
  const key = memoryProjectKey(main);
  expect(key).toBe("github.com/owner/repo");
  expect(memoryProjectKey(worktree)).toBe(key);
  expect(memoryProjectKey(submodule)).toBe(key);
  expect(isLocalKey(key)).toBe(false);
});

test("two unrelated same-named repositories without a remote stay apart and are flagged local", () => {
  const dir = home();
  const a = repo(join(dir, "one", "agent-hub"));
  const b = repo(join(dir, "two", "agent-hub"));
  const keyA = memoryProjectKey(a), keyB = memoryProjectKey(b);
  expect(keyA).not.toBe(keyB);
  expect(isLocalKey(keyA)).toBe(true);
  expect(isLocalKey(keyB)).toBe(true);
  const storeA = new CaptureStore({ home: dir, project: keyA });
  cleanup.push(() => storeA.close());
  const storeB = new CaptureStore({ home: dir, project: keyB });
  cleanup.push(() => storeB.close());
  expect(storeA.dir).not.toBe(storeB.dir);
  expect(readShardDescriptor(join(dir, "memory"), shardKeyHash(keyA))).toMatchObject({ key: keyA, local: true });
});

test("an alias op maps a renamed or imported key onto the canonical one, append-only, never automatic", () => {
  const dir = home(), base = join(dir, "memory");
  // No op, no merge: two keys keep their own shards even when one name suggests the other.
  expect(resolveAlias(base, "agent-hub")).toBe("agent-hub");
  const first = appendAlias(base, { alias: "agent-hub", key: "github.com/owner/agent-hub", actor: "person", machine: "m1", at: "2026-10-17T00:00:00.000Z" });
  const second = appendAlias(base, { alias: "work/dev/agent-hub", key: "github.com/owner/agent-hub", actor: "person", machine: "m1", at: "2026-10-17T00:01:00.000Z" });
  expect(resolveAlias(base, "agent-hub")).toBe("github.com/owner/agent-hub");
  expect(resolveAlias(base, "work/dev/agent-hub")).toBe("github.com/owner/agent-hub");
  expect(resolveAlias(base, "github.com/owner/agent-hub")).toBe("github.com/owner/agent-hub"); // canonical resolves to itself
  // Append-only: both ops stay in the log; the latest one for an alias wins.
  expect(listAliases(base)).toHaveLength(2);
  appendAlias(base, { alias: "agent-hub", key: "github.com/owner/renamed", actor: "person", machine: "m1", at: "2026-10-17T00:02:00.000Z" });
  expect(listAliases(base)).toHaveLength(3);
  expect(resolveAlias(base, "agent-hub")).toBe("github.com/owner/renamed");
  expect(() => appendAlias(base, { alias: "x", key: "agent-hub", actor: "person", machine: "m1" })).toThrow("another alias"); // aliases never chain
  expect(() => appendAlias(base, { alias: "same", key: "same", actor: "person", machine: "m1" })).toThrow("itself");
  expect(readFileSync(aliasLogPath(base), "utf8")).toContain(JSON.stringify(first.alias));
  expect(second.schema).toBe("agent-hub.memory.shard/v1");
  // A capture store opened under an alias writes into the canonical shard.
  const aliased = new CaptureStore({ home: dir, project: "work/dev/agent-hub" });
  cleanup.push(() => aliased.close());
  expect(aliased.key).toBe("github.com/owner/agent-hub");
  expect(aliased.dir).toContain(shardKeyHash("github.com/owner/agent-hub"));
  const canonical = new CaptureStore({ home: dir, project: "github.com/owner/agent-hub" });
  cleanup.push(() => canonical.close());
  expect(aliased.dir).toBe(canonical.dir);
});

test("amem alias add/list is person-only and add needs a terminal", async () => {
  const dir = home();
  process.env.AMEM_HOME = join(dir, "memory");
  cleanup.push(() => { delete process.env.AMEM_HOME; });
  const context = { cwd: dir, env: {}, stdinTTY: true };
  await expect(runCli(["alias", "add", "old-key", "new-key"], { ...context, env: { AGENTHUB_PEER_ID: "kimi" } })).rejects.toThrow(PERSON_ONLY);
  await expect(runCli(["alias", "add", "old-key", "new-key"], { ...context, stdinTTY: false })).rejects.toThrow("terminal on stdin");
  expect(listAliases(join(dir, "memory"))).toHaveLength(0);
  expect(await runCli(["alias", "add", "old-key", "new-key"], context)).toBe("alias old-key -> new-key");
  expect(await runCli(["alias"], context)).toContain("old-key -> new-key");
  const ops = JSON.parse(await runCli(["alias", "list", "--json"], context)) as { alias: string; key: string }[];
  expect(ops).toEqual([expect.objectContaining({ alias: "old-key", key: "new-key" })]);
});
