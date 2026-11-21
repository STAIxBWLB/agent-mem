import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRecallStalenessProbe } from "../src/memory/recall-staleness.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("a branch-only path and a refreshed timestamp name the observed hint rather than a proven content change", () => {
  const cwd = mkdtempSync(join(tmpdir(), "amem-stale-reason-")); roots.push(cwd);
  const at = new Date(Date.now() - 600_000).toISOString(), path = join(cwd, "same.ts");
  writeFileSync(path, "unchanged synthetic content\n"); utimesSync(path, new Date(), new Date());
  const probe = createRecallStalenessProbe({ cwd, rootConfirmed: true });
  const missing = { at, about: ["path:branch-only.ts"] }, timestamp = { at, about: ["path:same.ts"] };
  expect(probe(missing)).toBe(true); expect(probe.reason(missing)).toBe("missing_in_checkout");
  expect(probe(timestamp)).toBe(true); expect(probe.reason(timestamp)).toBe("mtime_newer_than_note");
});

test("reason shares the metadata budget and cached evidence remains subject to policy", () => {
  const cwd = mkdtempSync(join(tmpdir(), "amem-stale-budget-")); roots.push(cwd);
  let reads = 0, allowed = true;
  const probe = createRecallStalenessProbe({ cwd, rootConfirmed: true, maxProbes: 2, allowedPath: () => allowed,
    probe: () => { reads++; return { isSymbolicLink: () => false, isDirectory: () => true, mtimeMs: 2 }; } });
  const view = { at: new Date(1).toISOString(), about: ["path:src/a.ts"] };
  expect(probe(view)).toBe(true); expect(probe.reason(view)).toBe("mtime_newer_than_note"); expect(reads).toBe(2);
  expect(probe.reason({ ...view, about: ["path:another.ts"] })).toBeUndefined(); expect(reads).toBe(2);
  allowed = false; expect(probe(view)).toBeUndefined(); expect(probe.reason(view)).toBeUndefined(); expect(reads).toBe(2);
});

test("an unknown or denied path suppresses an otherwise stale hint and its reason", () => {
  const cwd = mkdtempSync(join(tmpdir(), "amem-stale-unknown-")); roots.push(cwd);
  const probe = createRecallStalenessProbe({ cwd, rootConfirmed: true, allowedPath: path => path !== "blocked.ts",
    probe: path => { if (path.endsWith("missing.ts")) throw Object.assign(Error("absent"), { code: "ENOENT" }); return { isSymbolicLink: () => false, isDirectory: () => false, mtimeMs: 2 }; } });
  for (const about of [["path:missing.ts", "path:blocked.ts"], ["path:changed.ts", "path:blocked.ts"]]) {
    const view = { at: new Date(1).toISOString(), about };
    expect(probe(view)).toBeUndefined(); expect(probe.reason(view)).toBeUndefined();
  }
});

test("reason and boolean share the hard 32-component ceiling even when the caller requests more", () => {
  const cwd = mkdtempSync(join(tmpdir(), "amem-stale-maximum-")); roots.push(cwd);
  let reads = 0;
  const probe = createRecallStalenessProbe({ cwd, maxProbes: 100, rootConfirmed: true,
    probe: () => { reads++; return { isSymbolicLink: () => false, isDirectory: () => true, mtimeMs: 2 }; } });
  const view = { at: new Date(1).toISOString(), about: [`path:${Array.from({ length: 40 }, (_, index) => `part${index}`).join("/")}`] };
  expect(probe.reason(view)).toBeUndefined(); expect(probe(view)).toBeUndefined(); expect(reads).toBe(32);
});
