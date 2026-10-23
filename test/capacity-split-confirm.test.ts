import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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
  const base = join(dir, "memory");
  for (const project of [A, B]) { const store = new CaptureStore({ home: dir, project }); store.append({ project, agent: "kimi", event: "PostToolUse", excerpt: `row ${"x".repeat(2000)}`, at: new Date().toISOString() }); store.close(); }
  const configOf = (key: string) => join(shardMachineDir(base, key, machineId(base).id), "config.json");
  return { dir, base, configOf };
}

test("confirm writes exactly the previewed values, even when the readings behind a recomputation have moved", () => {
  const w = world();
  const t0 = Date.now();
  const preview = previewSplit(w.base, { diskShare: 0.05, now: () => t0 });
  const seen = Object.fromEntries(preview.split.map(row => [row.key, row.target]));
  // a recomputation with another disk share would give other caps: prove the readings differ, so the test can tell the two apart
  const fresh = previewSplit(w.base, { diskShare: 0.0000001, now: () => t0 });
  expect(fresh.split.map(row => row.target.capMb)).not.toEqual(preview.split.map(row => row.target.capMb));
  previewSplit(w.base, { diskShare: 0.05, now: () => t0 });                       // the preview on disk is the one the person saw
  const result = applySplit(w.base, { diskShare: 0.0000001, now: () => t0 + 1000 });
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
