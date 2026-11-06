import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireMutation } from "../src/memory/mutation.ts";
import { abandonPlacementActivation, PlacementActivationAbandonError } from "../src/memory/sync-placement-abandon.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { readPlacementActivationIntent } from "../src/memory/sync-placement-activation-storage.ts";
import { placementEpochHash } from "../src/memory/sync-placement-journal-format.ts";
import { placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { inspectionFilesystemSnapshot } from "./fakes/sync-placement-inspection.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function pending() {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  const options = f.options("apply"); options.checkpoint = phase => { if (phase === "after-root-map") throw Error("isolated precommit interruption"); };
  await expect(activateSyncPlacement(options)).rejects.toThrow();
  const intent = readPlacementActivationIntent(f.base)!; expect(intent).toBeDefined();
  return { ...f, intent, epochDir: join(f.base, "sync-placement", "epochs", placementEpochHash(intent.epoch)), locator: join(f.base, "sync-placement-writer-roots.json"), intentFile: join(f.base, "sync-placement-activation.json") };
}
type Fixture = Awaited<ReturnType<typeof pending>>;
function abandon(f: Fixture, assertCurrent = () => {}) {
  const mutation = acquireMutation(f.base); if (!mutation) throw Error("isolated fixture mutation unavailable");
  try { abandonPlacementActivation(f.base, f.intent, { mutation, assertCurrent }); } finally { mutation(); }
}
function refusesWithoutEffects(f: Fixture, message?: string) {
  const mutation = acquireMutation(f.base); if (!mutation) throw Error("isolated fixture mutation unavailable");
  try {
    const before = inspectionFilesystemSnapshot(f.base);
    const operation = () => abandonPlacementActivation(f.base, f.intent, { mutation, assertCurrent() {} });
    if (message) expect(operation).toThrow(message); else expect(operation).toThrow(PlacementActivationAbandonError);
    expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  } finally { mutation(); }
}
function companion(file: string) { return file + ".pending-" + createHash("sha256").update(readFileSync(file)).digest("hex"); }

test("precommit cleanup removes only frozen metadata, preserves old bytes and unrelated epochs", async () => {
  const f = await pending(), old = ["profile.json", "shards.json", "formats.json", "amem.config.json"].map(name => [name, readFileSync(join(f.base, name))] as const);
  const other = join(f.base, "sync-placement", "epochs", "f".repeat(64)); mkdirSync(other, { mode: 0o700 }); writeFileSync(join(other, "unrelated"), "retained", { mode: 0o600 });
  abandon(f);
  for (const file of [f.locator, f.intentFile, f.epochDir]) expect(existsSync(file)).toBe(false);
  for (const [name, value] of old) expect(readFileSync(join(f.base, name))).toEqual(value);
  expect(readFileSync(join(other, "unrelated"), "utf8")).toBe("retained");
});

test("exact known temporary prefixes and zero-byte epoch writes can be abandoned", async () => {
  const f = await pending(), temp = companion(f.locator), text = readFileSync(f.locator);
  unlinkSync(f.locator); writeFileSync(temp, text.subarray(0, 13), { mode: 0o600 });
  writeFileSync(join(f.epochDir, "epoch.json"), "", { mode: 0o600 });
  const activation = join(f.epochDir, "activation.json"); writeFileSync(activation, readFileSync(activation).subarray(0, 19), { mode: 0o600 });
  abandon(f); expect(existsSync(temp)).toBe(false); expect(existsSync(f.intentFile)).toBe(false);
});

test("only exact same-inode full-byte immutable companions are removable", async () => {
  const f = await pending(), locatorTemp = companion(f.locator), intentTemp = companion(f.intentFile);
  linkSync(f.locator, locatorTemp); linkSync(f.intentFile, intentTemp);
  abandon(f); for (const file of [f.locator, locatorTemp, f.intentFile, intentTemp]) expect(existsSync(file)).toBe(false);
});

for (const kind of ["unknown", "hardlink", "symlink", "wrong-prefix"] as const) test("unsafe precommit metadata is preserved: " + kind, async () => {
  const f = await pending();
  if (kind === "unknown") writeFileSync(join(f.epochDir, "records-00000.jsonl"), "", { mode: 0o600 });
  if (kind === "hardlink") linkSync(f.locator, join(f.base, "unrelated-hardlink"));
  if (kind === "symlink") { unlinkSync(join(f.epochDir, "epoch.json")); symlinkSync(f.locator, join(f.epochDir, "epoch.json")); }
  if (kind === "wrong-prefix") writeFileSync(join(f.epochDir, "epoch.json"), "not the frozen epoch", { mode: 0o600 });
  refusesWithoutEffects(f);
});

for (const kind of ["fence", "marker"] as const) test("forward-only evidence prevents cleanup: " + kind, async () => {
  const f = await pending();
  if (kind === "fence") writeFileSync(join(f.base, "sync-placement", "active.json"), "partial", { mode: 0o600 });
  else writeFileSync(join(f.base, "profile.json"), f.intent.previousProfile + " ", { mode: 0o600 });
  refusesWithoutEffects(f, "forward --resume");
});

test("an interrupted cleanup keeps the intent and retries missing members without rewriting", async () => {
  const f = await pending(); let interrupted = false;
  expect(() => abandon(f, () => { if (!existsSync(f.locator)) { interrupted = true; throw Error("isolated cleanup interruption"); } })).toThrow(PlacementActivationAbandonError);
  expect(interrupted).toBe(true); expect(existsSync(f.intentFile)).toBe(true); expect(existsSync(f.epochDir)).toBe(true);
  abandon(f); expect(existsSync(f.intentFile)).toBe(false); expect(existsSync(f.epochDir)).toBe(false);
});

test("a remaining metadata inode substituted during proof is preserved", async () => {
  const f = await pending(), file = join(f.epochDir, "activation.json"); let substituted = false;
  expect(() => abandon(f, () => {
    if (!existsSync(f.locator) && !substituted) { const original = readFileSync(file); unlinkSync(file); writeFileSync(file, original, { mode: 0o600 }); substituted = true; }
  })).toThrow(PlacementActivationAbandonError);
  expect(substituted).toBe(true); expect(existsSync(file)).toBe(true); expect(existsSync(f.intentFile)).toBe(true);
});


test("retry fsyncs the epochs parent even when the prior owner already removed the epoch", async () => {
  const f = await pending(), epochs = join(f.base, "sync-placement", "epochs"), target = fs.statSync(epochs, { bigint: true });
  const original = fs.fsyncSync; let failed = false, retrySynced = false;
  const sync = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.dev === target.dev && stat.ino === target.ino && !existsSync(f.epochDir)) {
      if (!failed) { failed = true; throw Error("isolated post-rmdir fsync interruption"); }
      retrySynced = true;
    }
    return original(fd);
  });
  try {
    expect(() => abandon(f)).toThrow(PlacementActivationAbandonError);
    expect(failed).toBe(true); expect(existsSync(f.epochDir)).toBe(false); expect(existsSync(f.intentFile)).toBe(true);
    abandon(f); expect(retrySynced).toBe(true); expect(existsSync(f.intentFile)).toBe(false);
  } finally { sync.mockRestore(); }
});
