import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_PRUNE_INTENT, assertNoPublicPruneIntent, waitForPublicPruneWriter } from "../src/memory/public-prune-view.ts";
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

// #302: the same release race seen by a path lstat instead of an fstat. A path lstat that resolves an inode whose last
// link the writer already removed reports nlink 0, not ENOENT. Every site below must read that as the same disappearance.
/** Answer the `nth` lstat of `target` with `dying` (that inode's own stat) carrying `overrides`, after `release` runs. */
function zeroLinkAt(target: string, nth: number, dying: fs.Stats, release: () => void, overrides: Partial<fs.Stats> = { nlink: 0 }) {
  const original = fs.lstatSync as unknown as (...args: unknown[]) => fs.Stats | undefined;
  let seen = 0, fired = false;
  const spy = spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== target || ++seen !== nth) return original(...args);
    fired = true; release();
    return Object.assign(Object.create(Object.getPrototypeOf(dying)), dying, overrides) as fs.Stats;
  }) as unknown as typeof fs.lstatSync);
  return { restore: () => spy.mockRestore(), fired: () => fired };
}
/** Every sleep advances a virtual clock, so the reader's repeats are counted instead of waited out. */
function virtualClock() {
  let now = 0;
  const date = spyOn(Date, "now").mockImplementation(() => now), sleep = spyOn(Bun, "sleepSync").mockImplementation(ms => { now += Number(ms); });
  return { slept: () => now, restore: () => { date.mockRestore(); sleep.mockRestore(); } };
}
const release = (h: { intent: string; lock: string }) => () => { fs.unlinkSync(h.intent); fs.unlinkSync(h.lock); };
// The entry check reads the lock only when the intent is absent, so with a published intent the lock's lstats are the
// loop's own (1st) and small(lockFile)'s before-stat (2nd); the intent's are the entry check (1st), the loop's (2nd)
// and small(intentFile)'s before-stat (3rd).

test("a zero-link intent lstat in the wait loop is a disappearance, so the reader returns instead of re-reading a dead path", () => {
  const h = home(), dying = fs.lstatSync(h.intent);
  const hook = zeroLinkAt(h.intent, 2, dying, release(h)), clock = virtualClock();
  try { expect(() => waitForPublicPruneWriter(h.dir)).not.toThrow(); } finally { hook.restore(); clock.restore(); }
  expect(hook.fired()).toBe(true);
  expect(clock.slept()).toBe(0); // gone, exactly like ENOENT: no bounded step re-reads the dead path first
});

test("a zero-link lock lstat in the wait loop is a disappearance, not a lock that changes its shape", () => {
  const h = home(), dying = fs.lstatSync(h.lock);
  const hook = zeroLinkAt(h.lock, 1, dying, release(h)), clock = virtualClock();
  try { expect(() => waitForPublicPruneWriter(h.dir)).not.toThrow(); } finally { hook.restore(); clock.restore(); }
  expect(hook.fired()).toBe(true);
  expect(clock.slept()).toBe(5); // the intent the entry resolved is re-read once and found gone; no refusal
});

test("a zero-link before-stat of the owned lock record is a disappearance, not a damaged lock", () => {
  const h = home(), dying = fs.lstatSync(h.lock);
  const hook = zeroLinkAt(h.lock, 2, dying, release(h)), clock = virtualClock();
  try { expect(() => waitForPublicPruneWriter(h.dir)).not.toThrow(); } finally { hook.restore(); clock.restore(); }
  expect(hook.fired()).toBe(true);
  expect(clock.slept()).toBe(5);
});

test("a zero-link before-stat of the intent is a disappearance, not a damaged intent", () => {
  const h = home(), dying = fs.lstatSync(h.intent);
  const hook = zeroLinkAt(h.intent, 3, dying, release(h)), clock = virtualClock();
  try { expect(() => waitForPublicPruneWriter(h.dir)).not.toThrow(); } finally { hook.restore(); clock.restore(); }
  expect(hook.fired()).toBe(true);
  expect(clock.slept()).toBe(5);
});

test("a zero-link final intent lstat in assertNoPublicPruneIntent is a disappearance, not an unresolved intent", () => {
  const h = home(), dying = fs.lstatSync(h.intent);
  release(h)(); // the writer already finished, so the wait returns at its entry check
  const hook = zeroLinkAt(h.intent, 2, dying, () => {}); // 1st intent lstat is that entry check, 2nd the assertion's own
  try { expect(() => assertNoPublicPruneIntent(h.dir)).not.toThrow(); } finally { hook.restore(); }
  expect(hook.fired()).toBe(true);
});

test("the zero-link rule covers a dying inode only: a second link, a foreign owner, a symlink or a live intent still refuses", () => {
  const refuses = (label: string, run: () => void) => expect(run, label).toThrow("public prune view unavailable");
  { // a second link on the lock: not the create-once phase, which needs a complete owned lock and a two-link intent
    const h = home();
    refuses("lock second link", () => { const hook = zeroLinkAt(h.lock, 1, fs.lstatSync(h.lock), () => {}, { nlink: 2 }); try { waitForPublicPruneWriter(h.dir, Date.now() + 50); } finally { hook.restore(); } });
  }
  { // a two-link intent with no owned writer lock is outside the create-once phase too
    const h = home(); fs.unlinkSync(h.lock);
    refuses("intent second link", () => { const hook = zeroLinkAt(h.intent, 2, fs.lstatSync(h.intent), () => {}, { nlink: 2 }); try { waitForPublicPruneWriter(h.dir, Date.now() + 50); } finally { hook.restore(); } });
  }
  { // the same inode, but not ours
    const h = home(), dying = fs.lstatSync(h.lock);
    refuses("foreign owner", () => { const hook = zeroLinkAt(h.lock, 1, dying, () => {}, { uid: dying.uid + 1000 }); try { waitForPublicPruneWriter(h.dir, Date.now() + 50); } finally { hook.restore(); } });
  }
  { // a symlink is never a disappearance
    const h = home(); fs.renameSync(h.lock, h.lock + ".target"); fs.symlinkSync(h.lock + ".target", h.lock);
    refuses("symlink", () => waitForPublicPruneWriter(h.dir, Date.now() + 50));
  }
  { // small(lockFile)'s before-stat: the new ENOENT must not swallow any other count
    const h = home();
    refuses("before-stat second link", () => { const hook = zeroLinkAt(h.lock, 2, fs.lstatSync(h.lock), () => {}, { nlink: 2 }); try { waitForPublicPruneWriter(h.dir, Date.now() + 50); } finally { hook.restore(); } });
  }
  { // an intent published after the wait returned still blocks the read: the rule is about the inode, not the path name
    const h = home(); release(h)();
    const original = fs.lstatSync as unknown as (...args: unknown[]) => fs.Stats | undefined;
    let seen = 0, published = 0;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
      if (args[0] === h.intent && ++seen === 2) { published = seen; writeProfileJSON(h.intent, { schema: "agent-mem.public-prune-advance/v1", home: h.dir, generation: GENERATION }); }
      return original(...args);
    }) as unknown as typeof fs.lstatSync);
    refuses("live intent", () => { try { assertNoPublicPruneIntent(h.dir); } finally { spy.mockRestore(); } });
    expect(published).toBe(2); // the wait's entry check was 1st, the assertion's own lstat was 2nd
  }
});
