import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { SyncPlacementJournalError } from "../src/memory/sync-placement-journal-format.ts";
import { captureInspectionPendingPrunes } from "../src/memory/sync-placement-inspection-pending.ts";
import { validatePrunePlan } from "../src/memory/prune.ts";
import { publicPruneGraph } from "./fixtures/public-prune-graph.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(existing = false) {
  const root = mkdtempSync(join(tmpdir(), "amem-inspection-pending-")); chmodSync(root, 0o700); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "selected"), dir = join(target, "prune-plans"); mkdirSync(target, { mode: 0o700 });
  if (existing) mkdirSync(dir, { mode: 0o700 }); return { root, target, dir };
}
function snapshot(root: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const visit = (file: string) => {
    const stat = lstatSync(file, { bigint: true });
    result[file.slice(root.length)] = [String(stat.dev), String(stat.ino), String(stat.uid), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs),
      stat.isFile() ? readFileSync(file).toString("base64") : stat.isSymbolicLink() ? readlinkSync(file) : null];
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name));
  }; visit(root); return result;
}
function code(work: () => unknown): string {
  try { work(); } catch (error) { expect(error).toBeInstanceOf(SyncPlacementJournalError); return (error as SyncPlacementJournalError).code; }
  throw Error("expected namespace refusal");
}
function savedPlan(dir: string): string {
  const graph = publicPruneGraph(), body = { schema: "agent-mem.prune-plan/v1", generation: graph.manifest.prune.generation, selectorRevision: "a".repeat(64), project: "user",
    policyRevision: "synthetic-inspection", rows: [{ placement: "synced", payload: graph.manifest.prune }], counts: { eligible: 1, selected: 1, local: 0, synced: 1 }, hasMore: false };
  const plan = validatePrunePlan({ ...body, seal: hashJSON(body) }), file = join(dir, `${plan.seal}.json`);
  writeFileSync(file, canonicalJSON(plan) + "\n", { mode: 0o600 }); return file;
}

test("missing prune-plans is passively bound without creating it", () => {
  const f = fixture(), before = snapshot(f.root), check = captureInspectionPendingPrunes(f.target);
  check(); check(); expect(snapshot(f.root)).toEqual(before);
  mkdirSync(f.dir, { mode: 0o700 }); const changed = snapshot(f.root);
  expect(code(check)).toBe("changed"); expect(snapshot(f.root)).toEqual(changed);
});

test("normal saved sealed plans and selector-history directory remain readable without body reads or writes", () => {
  const f = fixture(true); savedPlan(f.dir); mkdirSync(join(f.dir, "selector-history"), { mode: 0o700 });
  const before = snapshot(f.root), read = spyOn(fs, "readFileSync").mockImplementation((() => { throw Error("namespace inspection must not read a plan body"); }) as typeof fs.readFileSync);
  try { const check = captureInspectionPendingPrunes(f.target); check(); expect(read).not.toHaveBeenCalled(); }
  finally { read.mockRestore(); }
  expect(snapshot(f.root)).toEqual(before);
});

for (const namespace of ["local", "log"] as const) for (const contents of ["", '{"schema":', '{"schema":"agent-mem.prune-append/v1"}\n'])
  test(`all ${namespace} pending claim contents are retained and refused`, () => {
    const f = fixture(true); writeFileSync(join(f.dir, `pending-${namespace}-${"b".repeat(16)}.json`), contents, { mode: 0o600 });
    const before = snapshot(f.root); expect(code(() => captureInspectionPendingPrunes(f.target))).toBe("pending"); expect(snapshot(f.root)).toEqual(before);
  });

test("unsafe pending claim is refused without following its symlink or healing it", () => {
  const f = fixture(true), external = join(f.root, "private-owned-evidence.json"); writeFileSync(external, "private fixture bytes", { mode: 0o600 });
  symlinkSync(external, join(f.dir, `pending-log-${"c".repeat(16)}.json`)); const before = snapshot(f.root);
  expect(code(() => captureInspectionPendingPrunes(f.target))).toBe("pending"); expect(snapshot(f.root)).toEqual(before);
});

test("symlinked prune-plans directory is refused without traversal or mutation", () => {
  const f = fixture(), actual = join(f.root, "other-plans"); mkdirSync(actual, { mode: 0o700 }); savedPlan(actual); symlinkSync(actual, f.dir);
  const before = snapshot(f.root); expect(code(() => captureInspectionPendingPrunes(f.target))).toBe("corrupt"); expect(snapshot(f.root)).toEqual(before);
});

for (const change of ["pending", "saved-body", "replace-directory", "mode"] as const) test("final passive check refuses namespace change: " + change, () => {
  const f = fixture(true), file = savedPlan(f.dir), check = captureInspectionPendingPrunes(f.target);
  if (change === "pending") writeFileSync(join(f.dir, `pending-local-${"d".repeat(16)}.json`), "{torn", { mode: 0o600 });
  else if (change === "saved-body") writeFileSync(file, "{changed", { mode: 0o600 });
  else if (change === "replace-directory") { renameSync(f.dir, join(f.root, "retained-original-plans")); mkdirSync(f.dir, { mode: 0o700 }); }
  else chmodSync(f.dir, 0o755);
  const before = snapshot(f.root); expect(code(check)).toBe("changed"); expect(snapshot(f.root)).toEqual(before);
});

for (const bound of ["rows", "bytes"] as const) test("streaming namespace scan enforces metadata " + bound + " bound before collecting beyond it", () => {
  const f = fixture(true), file = join(f.dir, "saved.json"); writeFileSync(file, "{}\n", { mode: 0o600 });
  const actualOpen = fs.opendirSync, actualStat = fs.lstatSync, stat = lstatSync(file, { bigint: true });
  let emitted = 0, childStats = 0, closed = false;
  const name = bound === "rows" ? "saved.json" : "s".repeat(1024);
  // Synthetic iterator/metadata only: no twenty-thousand-file fixture or large physical directory is created.
  const open = spyOn(fs, "opendirSync").mockImplementation(((...args: Parameters<typeof actualOpen>) => {
    if (args[0] !== f.dir) return Reflect.apply(actualOpen, fs, args);
    return { readSync() { emitted++; return { name }; }, closeSync() { closed = true; } } as unknown as fs.Dir;
  }) as typeof actualOpen);
  const stats = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof actualStat>) => {
    if (typeof args[0] === "string" && args[0].startsWith(f.dir + "/")) { childStats++; return stat; }
    return Reflect.apply(actualStat, fs, args);
  }) as typeof actualStat);
  try {
    expect(code(() => captureInspectionPendingPrunes(f.target))).toBe("bound"); expect(closed).toBe(true);
    if (bound === "rows") { expect(emitted).toBe(20001); expect(childStats).toBe(20000); }
    else expect(emitted).toBeLessThan(20000);
  } finally { stats.mockRestore(); open.mockRestore(); }
});
