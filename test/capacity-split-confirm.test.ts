import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CaptureStore, readCaptureConfigFile } from "../src/memory/capture.ts";
import { PREVIEW_MAX_AGE_MS, applySplit, previewSplit } from "../src/memory/capacity-split.ts";
import { shardMachineDir } from "../src/memory/shard.ts";
import { machineId } from "../src/memory/store.ts";

// #15 T5 review (split-confirm-writes-unpreviewed-values): --confirm writes the values the person saw, not a fresh computation.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const A = "github.com/o/a", B = "github.com/o/b", HOUR = 3600_000;
function world() {
  const dir = mkdtempSync(join(tmpdir(), "amem-split-confirm-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  // Capacity reads df through PATH. Fix free space at 512 GiB: the 0.0001 share
  // has 52 whole MiB, 0.05 has 26214, and the tiny share still cannot fund two shards.
  const bin = join(dir, "bin"); mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(bin, "df"), `#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != "-k" ]; then
  exit 2
fi
printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' 'fixture-disk 1073741824 536870912 536870912 50% /'
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = previousPath === undefined ? bin : `${bin}:${previousPath}`;
  cleanup.push(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  const base = join(dir, "memory");
  for (const project of [A, B]) { const store = new CaptureStore({ home: dir, project }); store.append({ project, agent: "kimi", event: "PostToolUse", excerpt: `row ${"x".repeat(2000)}`, at: new Date().toISOString() }); store.close(); }
  const configOf = (key: string) => join(shardMachineDir(base, key, machineId(base).id), "config.json");
  return { dir, base, configOf };
}

test("confirm writes exactly the previewed values, even when the readings behind a recomputation have moved", () => {
  const w = world();
  const t0 = Date.now();
  const first = previewSplit(w.base, { diskShare: 0.05, now: () => t0 });
  // a recomputation with another disk share would give other caps: prove the readings differ, so the test can tell the two apart
  const fresh = previewSplit(w.base, { diskShare: 0.0001, now: () => t0 });
  expect(fresh.split.map(row => row.target.capMb)).not.toEqual(first.split.map(row => row.target.capMb));
  // The preview on disk is the one the person saw, so it is the one `seen` comes from: free disk space moves between calls (a full suite writes files), and an
  // earlier preview's caps may differ by a megabyte from the last one's. What the contract promises is that confirm writes the ON-DISK preview, not a recomputation.
  const preview = previewSplit(w.base, { diskShare: 0.05, now: () => t0 });
  const seen = Object.fromEntries(preview.split.map(row => [row.key, row.target]));
  const result = applySplit(w.base, { diskShare: 0.0001, now: () => t0 + 1000 });
  for (const key of [A, B]) {
    expect(readCaptureConfigFile(w.configOf(key))).toEqual(seen[key]!);
    expect(result.written.find(row => row.key === key)).toMatchObject({ cap_mb: seen[key]!.capMb, retention_days: seen[key]!.retentionDays });
  }
});

test("a preview older than an hour is refused with nothing written, and a fresh one is not", () => {
  const w = world(); const t0 = Date.now();
  previewSplit(w.base, { now: () => t0 });
  expect(() => applySplit(w.base, { now: () => t0 + PREVIEW_MAX_AGE_MS + 1 })).toThrow(/out of date/);
  expect(existsSync(w.configOf(A))).toBe(false); expect(existsSync(w.configOf(B))).toBe(false);
  expect(() => applySplit(w.base, { now: () => t0 + PREVIEW_MAX_AGE_MS - 1 })).not.toThrow();
  expect(() => applySplit(w.base, { now: () => t0 })).toThrow(/preview first/);   // a preview is spent once it is applied
});

test("a preview dated in the future is refused too, so a clock step back cannot keep one alive", () => {
  const w = world(); const t0 = Date.now();
  previewSplit(w.base, { now: () => t0 + 10 * HOUR });
  expect(() => applySplit(w.base, { now: () => t0 })).toThrow(/out of date/);
});

test("a shard that only another machine has is left out and named, never written through another machine's directory", () => {
  const w = world();
  const mine = shardMachineDir(w.base, B, machineId(w.base).id), foreign = join(dirname(mine), "other-machine-id");
  cpSync(mine, foreign, { recursive: true }); rmSync(mine, { recursive: true, force: true });
  expect(basename(foreign)).not.toBe(machineId(w.base).id);
  const preview = previewSplit(w.base);
  expect(preview.split.map(row => row.key)).toEqual([A]); expect(preview.skipped).toEqual([B]);
  applySplit(w.base);
  expect(existsSync(join(foreign, "config.json"))).toBe(false);
  expect(existsSync(w.configOf(A))).toBe(true);
});

test("preview and confirm both refuse when the budget cannot give each shard its 1 MB, and write no config", () => {
  const w = world();
  expect(() => previewSplit(w.base, { diskShare: 0.000000001 })).toThrow(/fewer than the 2 shards/);
  expect(existsSync(join(w.base, "capacity-split.preview.json"))).toBe(false);
  expect(existsSync(w.configOf(A))).toBe(false);
  previewSplit(w.base, { diskShare: 0.05 });                                      // a valid preview exists, then the readings collapse
  expect(() => applySplit(w.base, { diskShare: 0.000000001 })).toThrow(/fewer than the 2 shards/);
  expect(existsSync(w.configOf(A))).toBe(false); expect(existsSync(w.configOf(B))).toBe(false);
});
