import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryGitSync, withGitTimeout } from "../src/memory/platform.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const bin = mkdtempSync(join(tmpdir(), "amem-git-timeout-"));
  cleanup.push(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nBun.sleepSync(100); process.stdout.write("fixture git\\n");\n`, { mode: 0o700 });
  return (timeout?: number) => memoryGitSync(["version"], { encoding: "utf8", env: { HOME: bin, PATH: bin }, ...(timeout === undefined ? {} : { timeout }) });
}
function latch() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

test("Git timeouts survive awaits without leaking to unrelated or overlapping host calls", async () => {
  const git = fixture(), first = latch(), second = latch();
  const short = withGitTimeout(10, async () => { await first.wait; return git(); });
  const long = withGitTimeout(2000, async () => { await second.wait; return git(); });
  // These calls overlap both contexts but were not created within either callback.
  expect(git().status).toBe(0);
  first.release(); expect((await short).error).toBeDefined();
  expect(git().status).toBe(0);
  second.release(); expect((await long).status).toBe(0);
  expect(git().status).toBe(0);
}, 10_000);

test("nested timeout rejection restores its parent context and per-call overrides remain authoritative", async () => {
  const git = fixture();
  await withGitTimeout(2000, async () => {
    await expect(withGitTimeout(10, async () => {
      await Promise.resolve();
      expect(git().error).toBeDefined();
      expect(git(2000).status).toBe(0);
      throw new Error("fixture rejection");
    })).rejects.toThrow("fixture rejection");
    expect(git().status).toBe(0);
  });
  expect(git().status).toBe(0);
}, 10_000);
