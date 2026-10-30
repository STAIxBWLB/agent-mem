import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { generationSyncGit, generationSyncGitBytes, syncGroupsForTest } from "../src/memory/sync.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function repo(): string {
  const dir = realPath(mkdtempSync(join(tmpdir(), "amem-git-bytes-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  expect(memoryGitSync(["init", "-q", dir], { encoding: "utf8" }).status).toBe(0); return dir;
}
function git(dir: string, args: string[]): string {
  const result = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" });
  expect(result.status).toBe(0); return result.stdout.trim();
}
function blob(dir: string, bytes: Buffer): string {
  writeFileSync(join(dir, "payload"), bytes); return git(dir, ["hash-object", "-w", "--", "payload"]);
}

test("binary Git returns exact blob and raw tree bytes including NUL, non-UTF8 and all trailing LF", async () => {
  const dir = repo(), body = Buffer.from([0, 255, 128, 97, 10, 10, 10]), oid = blob(dir, body);
  const result = await generationSyncGitBytes(dir, ["cat-file", "blob", oid]);
  expect(result.code).toBe(0); expect(Buffer.from(result.out)).toEqual(body);
  git(dir, ["update-index", "--add", "--cacheinfo", "100644", oid, "payload"]);
  const written = await generationSyncGitBytes(dir, ["write-tree"]); expect(written.code).toBe(0);
  const tree = Buffer.from(written.out).toString().trim(), expected = Buffer.concat([Buffer.from("100644 payload"), Buffer.from([0]), Buffer.from(oid, "hex")]);
  const raw = await generationSyncGitBytes(dir, ["cat-file", "tree", tree]);
  expect(raw.code).toBe(0); expect(Buffer.from(raw.out)).toEqual(expected);
  expect(statSync(join(dir, ".git", "objects", tree.slice(0, 2), tree.slice(2))).mode & 0o077).toBe(0);
});

test("binary output allows the exact bound, refuses one byte over without a partial result and keeps text history unbounded", async () => {
  const dir = repo(), bytes = Buffer.from("  complete public history  \n\n"), oid = blob(dir, bytes);
  const exact = await generationSyncGitBytes(dir, ["cat-file", "blob", oid], undefined, 10_000, bytes.length);
  expect(exact.code).toBe(0); expect(Buffer.from(exact.out)).toEqual(bytes);
  const over = await generationSyncGitBytes(dir, ["cat-file", "blob", oid], undefined, 10_000, bytes.length - 1);
  expect(over.code).toBe(-1); expect(over.out.length).toBe(0); expect(over.err).toContain("bound");
  const large = Buffer.from("x".repeat(2 * 1024 * 1024 + 10) + "\n\n"), largeId = blob(dir, large);
  const text = await generationSyncGit(dir, ["cat-file", "blob", largeId]);
  expect(text.code).toBe(0); expect(text.out).toBe(large.toString().trim());
  const rejected = await generationSyncGitBytes(dir, ["cat-file", "blob", largeId], undefined, 10_000, 32);
  expect(rejected.code).toBe(-1); expect(rejected.out.length).toBe(0); expect(syncGroupsForTest.live()).toBe(0);
});

test("binary Git isolates caller repository overrides and disables repository fsmonitor", async () => {
  const dir = repo(), other = repo(), oid = blob(dir, Buffer.from("own\n\n"));
  const marker = join(dir, "fsmonitor-ran"), hook = join(dir, "fsmonitor");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 }); git(dir, ["config", "core.fsmonitor", hook]);
  const old = process.env.GIT_DIR; process.env.GIT_DIR = join(other, ".git");
  try {
    const read = await generationSyncGitBytes(dir, ["cat-file", "blob", oid]); expect(Buffer.from(read.out).toString()).toBe("own\n\n");
    expect((await generationSyncGitBytes(dir, ["status", "--porcelain", "-z"])).code).toBe(0); expect(existsSync(marker)).toBe(false);
  } finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
});

for (const stop of ["abort", "deadline"] as const) test(`binary Git ${stop} reaps a transport child retaining its pipes`, async () => {
  const dir = repo(), pidFile = join(dir, "child.pid"), ssh = join(dir, "fake-ssh");
  writeFileSync(ssh, `#!/bin/sh\ntrap '' TERM INT HUP\necho $$ > '${pidFile}'\nwhile :; do sleep 1; done\n`, { mode: 0o700 });
  git(dir, ["remote", "add", "origin", "ssh://example.invalid/private.git"]);
  const old = process.env.GIT_SSH_COMMAND; process.env.GIT_SSH_COMMAND = ssh;
  const controller = new AbortController(); let child = 0;
  const alive = () => { try { process.kill(child, 0); return true; } catch { return false; } };
  try {
    const running = generationSyncGitBytes(dir, ["fetch", "-q", "origin"], stop === "abort" ? controller.signal : undefined, stop === "deadline" ? 1000 : 10_000);
    for (let n = 0; n < 100 && !existsSync(pidFile); n++) await Bun.sleep(20);
    expect(existsSync(pidFile)).toBe(true); child = Number(readFileSync(pidFile, "utf8").trim());
    if (stop === "abort") controller.abort();
    const result = await running; expect(result.code).toBe(-1); expect(result.out.length).toBe(0);
    for (let n = 0; n < 100 && alive(); n++) await Bun.sleep(20);
    expect(alive()).toBe(false); expect(syncGroupsForTest.live()).toBe(0);
  } finally {
    if (child && alive()) process.kill(child, "SIGKILL");
    if (old === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = old;
  }
}, 15_000);

test("already stopped and invalid bounds launch no binary Git group", async () => {
  const controller = new AbortController(); controller.abort();
  expect((await generationSyncGitBytes("/unavailable", [], controller.signal)).err).toBe("stopped");
  for (const limit of [-1, NaN, Infinity, 0.5]) expect((await generationSyncGitBytes("/unavailable", [], undefined, 1000, limit)).code).toBe(-1);
  expect(syncGroupsForTest.live()).toBe(0);
});


test("binary overflow without a caller signal kills its owned pipe-holding descendant", async () => {
  const dir = repo(), script = join(dir, "overflow"), pidFile = join(dir, "overflow.pid");
  writeFileSync(script, `#!/bin/sh\ntrap '' TERM INT HUP\necho $$ > '${pidFile}'\nhead -c 100000 /dev/zero\nwhile :; do sleep 1; done\n`, { mode: 0o700 });
  let child = 0;
  const alive = () => { try { process.kill(child, 0); return true; } catch { return false; } };
  try {
    const result = await generationSyncGitBytes(dir, ["-c", `alias.bound=!sh '${script}'`, "bound"], undefined, 10_000, 16);
    expect(existsSync(pidFile)).toBe(true); child = Number(readFileSync(pidFile, "utf8").trim());
    expect(result.code).toBe(-1); expect(result.err).toContain("bound"); expect(result.out.length).toBe(0);
    for (let n = 0; n < 100 && alive(); n++) await Bun.sleep(20);
    expect(alive()).toBe(false); expect(syncGroupsForTest.live()).toBe(0);
  } finally { if (child && alive()) process.kill(child, "SIGKILL"); }
}, 15_000);

test("binary stderr is drained with a bounded diagnostic while stdout stays exact", async () => {
  const dir = repo();
  const result = await generationSyncGitBytes(dir, ["-c", "alias.diagnostic=!head -c 100000 /dev/zero >&2; printf 'ok\\n\\n'", "diagnostic"], undefined, 10_000, 4);
  expect(result.code).toBe(0); expect(Buffer.from(result.out)).toEqual(Buffer.from("ok\n\n")); expect(Buffer.byteLength(result.err)).toBe(65_536);
});
