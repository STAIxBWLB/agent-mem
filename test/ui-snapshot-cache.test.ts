import { expect, test } from "bun:test";
import { SnapshotCache } from "../src/ui/snapshot-cache.ts";

test("unchanged polls and concurrent viewers reuse one revision-bound computation", async () => {
  let revision = "a", calls = 0;
  const cache = new SnapshotCache(() => revision);
  const read = async () => { calls++; await Promise.resolve(); return { data: { rows: [revision] }, until: Infinity }; };
  const replies = await Promise.all(Array.from({ length: 10 }, () => cache.snapshot("recap/A", 0, read)));
  expect(calls).toBe(1);
  expect(replies.every(reply => reply.cursor === replies[0]!.cursor)).toBe(true);
  const cursor = Number(replies[0]!.cursor);
  expect(await cache.snapshot("recap/A", cursor, read)).toEqual({ changed: false, cursor });
  (replies[0]!.rows as string[]).push("caller mutation");
  expect((await cache.snapshot("recap/A", 0, read)).rows).toEqual(["a"]);
  revision = "b";
  const changed = await cache.snapshot("recap/A", cursor, read);
  expect(changed.rows).toEqual(["b"]); expect(changed.cursor).not.toBe(cursor); expect(calls).toBe(2);
  const differentQuery = await cache.snapshot("recap/B", Number(changed.cursor), read);
  expect(differentQuery.changed).not.toBe(false);
  expect(differentQuery.cursor).not.toBe(changed.cursor);
});

test("expiry changes a cursor even without a source write", async () => {
  let now = 1, calls = 0;
  const cache = new SnapshotCache(() => "source", () => now);
  const read = async () => ({ data: { value: ++calls }, until: now + 10 });
  const first = await cache.snapshot("work", 0, read);
  now = 11;
  const expired = await cache.snapshot("work", Number(first.cursor), read);
  expect(expired.value).toBe(2); expect(expired.cursor).not.toBe(first.cursor);
});

test("a clock rollback revalidates instead of retaining a later projection forever", async () => {
  let now = 20, calls = 0;
  const cache = new SnapshotCache(() => "source", () => now);
  const read = async () => ({ data: { at: now, calls: ++calls }, until: Infinity });
  const first = await cache.snapshot("recap", 0, read);
  now = 10;
  const rolledBack = await cache.snapshot("recap", Number(first.cursor), read);
  expect(rolledBack.at).toBe(10); expect(rolledBack.calls).toBe(2);
  expect(first.at).toBe(20);
});

test("a write or action during a read prevents publication of its old screened body", async () => {
  for (const change of ["source", "action", "close"] as const) {
    let revision = "before", release!: () => void;
    const cache = new SnapshotCache(() => revision), paused = new Promise<void>(resolve => { release = resolve; });
    const flight = cache.snapshot("recap", 0, async () => { await paused; return { data: { text: "old body" }, until: Infinity }; });
    if (change === "source") revision = "after";
    else if (change === "action") cache.invalidate();
    else cache.close();
    release();
    await expect(flight).rejects.toThrow("inputs changed");
    if (change === "close") await expect(cache.snapshot("recap", 0, async () => ({ data: {}, until: Infinity }))).rejects.toThrow("closed");
    else expect(await cache.snapshot("recap", 0, async () => ({ data: { text: "new body" }, until: Infinity }))).toMatchObject({ text: "new body" });
  }
});

test("errors and already-expired computations are never memoized", async () => {
  const cache = new SnapshotCache(() => "source", () => 1);
  await expect(cache.snapshot("recap", 0, async () => ({ data: { error: "refusal" }, until: Infinity }))).rejects.toThrow("unavailable");
  for (const until of [0, 1, Number.NaN])
    await expect(cache.snapshot("recap", 0, async () => ({ data: {}, until }))).rejects.toThrow("inputs changed");
  expect((await cache.snapshot("recap", 0, async () => ({ data: { recovered: true }, until: Infinity })))).toMatchObject({ recovered: true });
});

test("close waits for an invalidated in-flight projection to release its resources", async () => {
  const cache = new SnapshotCache(() => "source"); let release!: () => void, finished = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const flight = cache.snapshot("recap", 0, async () => { await blocked; finished = true; return { data: {}, until: Infinity }; });
  cache.invalidate();
  let closed = false;
  const closing = cache.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  release(); await expect(flight).rejects.toThrow("inputs changed"); await closing;
  expect(finished).toBe(true); expect(closed).toBe(true);
});

test("the bounded selection cache evicts an old result and never shares its cursor across keys", async () => {
  const cache = new SnapshotCache(() => "source"); let calls = 0;
  const read = async () => ({ data: { value: ++calls }, until: Infinity });
  for (let n = 0; n < 17; n++) await cache.snapshot(String(n), 0, read);
  await cache.snapshot("0", 0, read);
  expect(calls).toBe(18);
});

test("unavailable revisions discard old entries and independently return full fresh replies until recovery", async () => {
  let unavailable = false, reads = 0;
  const cache = new SnapshotCache(() => { if (unavailable) throw Error("revision unavailable"); return "source"; });
  const read = async () => ({ data: { value: ++reads }, until: Infinity });
  const old = await cache.snapshot("recap", 0, read);
  unavailable = true;
  const replies = await Promise.all(Array.from({ length: 10 }, () => cache.snapshot("recap", Number(old.cursor), read)));
  expect(reads).toBe(11);
  expect(new Set(replies.map(reply => reply.cursor)).size).toBe(10);
  for (const reply of replies) {
    expect(Number.isSafeInteger(reply.cursor)).toBe(true); expect(reply.cursor).not.toBe(old.cursor);
    expect(Number(reply.cursor)).toBeGreaterThan(0);
    expect(reply.changed).toBeUndefined(); expect(typeof reply.value).toBe("number");
  }
  expect((Reflect.get(cache, "entries") as Map<string, unknown>).size).toBe(0);
  expect((Reflect.get(cache, "flights") as Map<string, unknown>).size).toBe(0);
  unavailable = false;
  const recovered = await cache.snapshot("recap", Number(replies[0]!.cursor), read);
  expect(recovered.value).toBe(12);
  expect(await cache.snapshot("recap", Number(recovered.cursor), read)).toEqual({ changed: false, cursor: recovered.cursor });
  expect(reads).toBe(12);
});

test("explicit fresh reads never consult a revision or reuse a flight even if that revision recovers", async () => {
  let probes = 0, reads = 0;
  const cache = new SnapshotCache(() => { probes++; return "source"; });
  const read = async () => ({ data: { value: ++reads, changed: false, rows: ["screened"] }, until: Infinity });
  const replies = await Promise.all([cache.fresh(read), cache.fresh(read)]);
  expect(probes).toBe(0); expect(reads).toBe(2); expect(replies[0]!.cursor).not.toBe(replies[1]!.cursor);
  expect(replies.every(reply => reply.changed === undefined)).toBe(true);
  (replies[0]!.rows as string[]).push("caller mutation"); expect(replies[1]!.rows).toEqual(["screened"]);
  expect((Reflect.get(cache, "entries") as Map<string, unknown>).size).toBe(0);
  expect((Reflect.get(cache, "flights") as Map<string, unknown>).size).toBe(0);
  const recovered = await cache.snapshot("recap", Number(replies[0]!.cursor), async () => ({ data: { value: ++reads }, until: Infinity }));
  expect(recovered.value).toBe(3); expect(probes).toBe(3);
});

for (const failedProbe of [2, 3]) test(`revision failure at probe ${failedProbe} discards its unverifiable body and rereads fresh`, async () => {
  let probes = 0, reads = 0;
  const cache = new SnapshotCache(() => { if (++probes === failedProbe) throw Error("revision failed"); return "source"; });
  const read = async () => ({ data: { value: ++reads }, until: Infinity });
  const reply = await cache.snapshot("recap", 0, read);
  expect(reply.value).toBe(2); expect(reply.changed).toBeUndefined(); expect(probes).toBe(failedProbe);
  expect((Reflect.get(cache, "entries") as Map<string, unknown>).size).toBe(0);
  expect((Reflect.get(cache, "flights") as Map<string, unknown>).size).toBe(0);
  const recovered = await cache.snapshot("recap", Number(reply.cursor), read);
  expect(recovered.value).toBe(3);
  expect(await cache.snapshot("recap", Number(recovered.cursor), read)).toEqual({ changed: false, cursor: recovered.cursor });
});

test("revision loss during a shared read gives every waiter a separate fresh computation", async () => {
  let unavailable = false, reads = 0, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const cache = new SnapshotCache(() => { if (unavailable) throw Error("revision lost"); return "source"; });
  const read = async () => { const value = ++reads; await blocked; return { data: { value }, until: Infinity }; };
  const pending = Array.from({ length: 5 }, () => cache.snapshot("recap", 0, read));
  expect(reads).toBe(1); unavailable = true; release();
  const replies = await Promise.all(pending);
  expect(reads).toBe(6); expect(new Set(replies.map(reply => reply.cursor)).size).toBe(5);
  expect(replies.every(reply => Number(reply.value) > 1 && reply.changed === undefined)).toBe(true);
});

test("read errors, policy refusals and successful revision mismatches never become revision fallbacks", async () => {
  for (const unavailable of [false, true]) {
    let probes = 0, reads = 0;
    const cache = new SnapshotCache(() => { probes++; if (unavailable) throw Error("revision failed"); return "source"; });
    const failure = Error("console revision unavailable");
    await expect(cache.snapshot("recap", 0, async () => { reads++; throw failure; })).rejects.toBe(failure);
    expect(reads).toBe(1); expect(probes).toBe(1);
    await expect(cache.snapshot("recap", 0, async () => { reads++; return { data: { error: "policy refusal" }, until: Infinity }; })).rejects.toThrow("snapshot unavailable");
    expect(reads).toBe(2); expect(probes).toBe(2);
  }
  let probes = 0, reads = 0;
  const cache = new SnapshotCache(() => { probes++; if (probes > 2) throw Error("later revision failed"); return probes === 1 ? "before" : "after"; });
  await expect(cache.snapshot("recap", 0, async () => ({ data: { value: ++reads }, until: Infinity }))).rejects.toThrow("inputs changed");
  expect(reads).toBe(1); expect(probes).toBe(2);
});

test("a failed revision probe cannot mask an action, close, expiry or rollback arriving at that boundary", async () => {
  for (const failedProbe of [2, 3]) for (const change of ["action", "close", "expiry", "rollback"] as const) {
    let probes = 0, reads = 0, now = 10, closing: Promise<void> | undefined;
    const cache = new SnapshotCache(() => {
      if (++probes === failedProbe) {
        if (change === "action") cache.invalidate();
        if (change === "close") closing = cache.close();
        if (change === "expiry") now = 20;
        if (change === "rollback") now = 9;
        throw Error("revision failed too");
      }
      return "source";
    }, () => now);
    await expect(cache.snapshot("recap", 0, async () => ({ data: { value: ++reads }, until: 20 }))).rejects.toThrow("inputs changed");
    expect(reads).toBe(1); if (closing) await closing;
  }
});

test("fresh reads retain expiry, rollback, action and close fences and active-read limits", async () => {
  for (const change of ["action", "close", "expiry", "rollback"] as const) {
    let now = 10, release!: () => void, closed = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const cache = new SnapshotCache(() => { throw Error("unavailable"); }, () => now);
    const request = cache.snapshot("recap", 0, async () => { await blocked; return { data: { value: "fresh" }, until: 20 }; });
    let closing: Promise<void> | undefined;
    if (change === "action") cache.invalidate();
    if (change === "close") { closing = cache.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false); }
    if (change === "expiry") now = 20;
    if (change === "rollback") now = 9;
    release(); await expect(request).rejects.toThrow("inputs changed");
    if (closing) { await closing; expect(closed).toBe(true); await expect(cache.fresh(async () => ({ data: {}, until: Infinity }))).rejects.toThrow("closed"); }
  }
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const cache = new SnapshotCache(() => { throw Error("unavailable"); });
  const read = async () => { await blocked; return { data: { ready: true }, until: Infinity }; };
  const requests = Array.from({ length: 16 }, () => cache.fresh(read));
  await expect(cache.fresh(read)).rejects.toThrow("concurrency limit");
  release(); expect((await Promise.all(requests)).every(reply => reply.ready === true)).toBe(true);
  await cache.close();
});
