import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_PRUNE_INTENT, waitForPublicPruneWriter } from "../src/memory/public-prune-view.ts";
import { writeProfileJSON } from "../src/memory/generation.ts";
import { realPath } from "../src/memory/platform.ts";

// #225: a cooperating writer that finishes unlinks its intent and then its lock. If that lands between the reader's
// open and fstat, the reader must observe a normal disappearance and re-resolve the path, not refuse.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const GENERATION = "7".repeat(32);
function home() {
  const dir = realPath(fs.mkdtempSync(join(tmpdir(), "amem-prune-unlink-"))); fs.chmodSync(dir, 0o700);
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeProfileJSON(join(dir, "profile.json"), { schema: "agent-mem.profile/v2", kind: "generation", generation: GENERATION, foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: "a".repeat(64) });
  const intent = join(dir, PUBLIC_PRUNE_INTENT), lock = join(dir, "profile.lock");
  writeProfileJSON(intent, { schema: "agent-mem.public-prune-advance/v1", home: dir, generation: GENERATION });
  writeProfileJSON(lock, { pid: process.pid, signature: "a".repeat(64), token: "b".repeat(32) });
  return { dir, intent, lock };
}
/** Run `after` once, right after the reader opens `target`, i.e. between its open and its fstat. */
function onOpen(target: string, after: () => void) {
  const original = fs.openSync; let fired = false;
  const spy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof original>) => {
    const fd = Reflect.apply(original, fs, args);
    if (!fired && args[0] === target) { fired = true; after(); }
    return fd;
  }) as typeof original);
  return { restore: () => spy.mockRestore(), fired: () => fired };
}

for (const which of ["intent", "lock"] as const) test(`a writer finishing between the reader's open and fstat of the ${which} is a normal disappearance`, () => {
  const h = home(), hook = onOpen(which === "intent" ? h.intent : h.lock, () => { fs.unlinkSync(h.intent); fs.unlinkSync(h.lock); });
  const started = Date.now();
  try { expect(() => waitForPublicPruneWriter(h.dir)).not.toThrow(); } finally { hook.restore(); }
  expect(hook.fired()).toBe(true);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("bytes read through an unlinked fd are never returned: the path is re-resolved and a replacement is judged afresh", () => {
  const h = home();
  // The writer replaces the intent with malformed bytes after the reader opened the old one. Trusting the old fd would
  // accept the valid old intent; re-resolving must see the replacement and refuse it.
  const hook = onOpen(h.intent, () => { fs.unlinkSync(h.intent); fs.writeFileSync(h.intent, "{\"schema\":\"not-an-intent\"}", { mode: 0o600 }); });
  let clock = 0;
  const date = spyOn(Date, "now").mockImplementation(() => clock), sleep = spyOn(Bun, "sleepSync").mockImplementation(ms => { clock += Number(ms); });
  try { expect(() => waitForPublicPruneWriter(h.dir, 50)).toThrow("public prune view unavailable"); }
  finally { hook.restore(); date.mockRestore(); sleep.mockRestore(); }
  expect(hook.fired()).toBe(true);
  expect(clock).toBe(5);                               // one bounded loop step, then refused on the replacement's content, not by the deadline
});

test("only a zero link count is a disappearance: an extra link, a foreign mode or a symlink still refuses", () => {
  for (const damage of ["extra-link", "mode", "symlink"] as const) {
    const h = home();
    // Malformed intent content forces the parsed path; the lock stays owned so an nlink-2 intent is not the staging case.
    fs.writeFileSync(h.intent, JSON.stringify({ schema: "agent-mem.public-prune-advance/v1", home: h.dir, generation: GENERATION }), { mode: 0o600 });
    if (damage === "extra-link") { fs.unlinkSync(h.lock); fs.linkSync(h.intent, h.intent + ".second"); }
    if (damage === "mode") fs.chmodSync(h.intent, 0o644);
    if (damage === "symlink") { fs.renameSync(h.intent, h.intent + ".target"); fs.symlinkSync(h.intent + ".target", h.intent); }
    expect(() => waitForPublicPruneWriter(h.dir, Date.now() + 50), damage).toThrow("public prune view unavailable");
  }
});

test("a disappearance never renews the original deadline", () => {
  const h = home();
  // The intent is replaced (unlinked while open) on every read and never resolves: the loop must still stop at the deadline.
  const original = fs.openSync;
  const spy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof original>) => {
    const fd = Reflect.apply(original, fs, args);
    if (args[0] === h.intent) { fs.unlinkSync(h.intent); writeProfileJSON(h.intent, { schema: "agent-mem.public-prune-advance/v1", home: h.dir, generation: GENERATION }); }
    return fd;
  }) as typeof original);
  let clock = 1000, slept = 0;
  const date = spyOn(Date, "now").mockImplementation(() => clock), sleep = spyOn(Bun, "sleepSync").mockImplementation(ms => { clock += Number(ms); slept += Number(ms); });
  try { expect(() => waitForPublicPruneWriter(h.dir, 1030)).toThrow("public prune view unavailable"); }
  finally { spy.mockRestore(); date.mockRestore(); sleep.mockRestore(); }
  expect(slept).toBe(30); expect(clock).toBe(1030);
});
