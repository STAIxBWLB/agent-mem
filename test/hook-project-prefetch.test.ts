import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookCaptureScope } from "../src/hook-spool.ts";
import { resolveHookProjectAsync } from "../src/hook-project.ts";
import { realPath } from "../src/memory/platform.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [], original = { HOME: process.env.HOME, PATH: process.env.PATH };
afterEach(() => {
  for (const key of ["HOME", "PATH"] as const) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function fixture(mode: "paired" | "unused-blocked" | "metadata-failed" | "serial-guard", remote = false) {
  const git = realPath(Bun.which("git")!), f = hookFixture(remote ? "https://example.invalid/prefetch/project.git" : undefined); fixtures.push(f);
  process.env.HOME = f.env.HOME;
  const origin = join(f.root, "origin-entered"), metadata = join(f.root, "metadata-entered"), native = join(f.root, "native-pids"), calls = join(f.root, "calls"), bin = join(f.root, "bin"); mkdirSync(bin);
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in\n*"remote get-url origin")\n printf 'origin\\n' >> ${quote(calls)}; : > ${quote(origin)}\n ${mode === "serial-guard" ? ":" : `while [ ! -f ${quote(metadata)} ]; do /bin/sleep 0.01; done`}\n ;;\n*"rev-parse --path-format=absolute --git-common-dir --git-dir --is-bare-repository --show-toplevel --show-superproject-working-tree")\n printf 'metadata\\n' >> ${quote(calls)}; ${mode === "unused-blocked" ? "" : `: > ${quote(metadata)}`}\n ${mode === "paired" ? `while [ ! -f ${quote(origin)} ]; do /bin/sleep 0.01; done` : mode === "metadata-failed" ? "exit 77" : `/bin/sleep 30 & sleeper=$!; printf '%s %s\\n' "$$" "$sleeper" > ${quote(native)}; : > ${quote(metadata)}; wait` }\n ;;\nesac\nexec ${quote(git)} "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${original.PATH ?? ""}`;
  const scope = hookCaptureScope(f.cwd, f.base); expect(scope).toBeDefined();
  return { ...f, origin, metadata, native, calls, options: { cwd: f.cwd, base: f.base, scope, timeRemaining: () => 3000, prefetch: true } };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };

test("a real cache miss prefetches origin and metadata across an observed mutual barrier, while a cache hit starts none", async () => {
  const f = fixture("paired"), usage = { rssKB: 0, rawRssKB: 0 };
  const spawn = Bun.spawn, children: Bun.Subprocess[] = [];
  Object.assign(Bun, { spawn(argv: readonly string[], options: unknown) {
    const child = Reflect.apply(spawn, Bun, [argv, options]);
    if (argv[0] === "/bin/sh" && argv[3] === "amem-hook-native") children.push(child);
    return child;
  } });
  try {
    await expect(resolveHookProjectAsync(f.options, usage)).resolves.toBe(f.project);
    expect(existsSync(f.origin)).toBe(true); expect(existsSync(f.metadata)).toBe(true);
    expect(readFileSync(f.calls, "utf8").trim().split("\n").sort()).toEqual(["metadata", "origin"]);
    expect(children).toHaveLength(2);
    const rawSum = children.reduce((sum, child) => sum + (child.resourceUsage()?.maxRSS ?? 0) / 1024, 0);
    expect(rawSum).toBeGreaterThan(0); expect(usage.rawRssKB).toBeGreaterThanOrEqual(rawSum);
    await expect(resolveHookProjectAsync(f.options, { rssKB: 0, rawRssKB: 0 })).resolves.toBe(f.project);
    expect(children).toHaveLength(2);
  } finally { Bun.spawn = spawn; }
});

test("origin-only resolution cancels and awaits an unused metadata prefetch with its descendant", async () => {
  const f = fixture("unused-blocked", true);
  await expect(resolveHookProjectAsync(f.options, { rssKB: 0, rawRssKB: 0 })).resolves.toBe("example.invalid/prefetch/project");
  expect(existsSync(f.native)).toBe(true);
  const pids = readFileSync(f.native, "utf8").trim().split(/\s+/).map(Number);
  expect(pids).toHaveLength(2);
  // Group kill precedes the resolver returning. Allow init to reap non-executing zombies,
  // but never accept a surviving child as cleanup success.
  for (let n = 0; n < 100 && pids.some(alive); n++) await Bun.sleep(5);
  expect(pids.some(alive)).toBe(false);
});

test("a failed unused metadata read cannot override a valid native origin", async () => {
  const f = fixture("metadata-failed", true);
  await expect(resolveHookProjectAsync(f.options, { rssKB: 0, rawRssKB: 0 })).resolves.toBe("example.invalid/prefetch/project");
  expect(existsSync(f.metadata)).toBe(true);
});

test("the shared native resolver still rejects a failed metadata read when no usable origin exists", async () => {
  const f = fixture("metadata-failed");
  await expect(resolveHookProjectAsync(f.options, { rssKB: 0, rawRssKB: 0 })).rejects.toThrow("Git project identity unavailable");
});


test("native project resolution defaults to serial reads without speculative metadata", async () => {
  const f = fixture("serial-guard", true);
  const { prefetch: _prefetch, ...options } = f.options;
  await expect(resolveHookProjectAsync(options, { rssKB: 0, rawRssKB: 0 })).resolves.toBe("example.invalid/prefetch/project");
  expect(readFileSync(f.calls, "utf8").trim().split("\n")).toEqual(["origin"]);
  expect(existsSync(f.metadata)).toBe(false);
});
