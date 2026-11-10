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

test("the bounded selection cache evicts an old result and never shares its cursor across keys", async () => {
  const cache = new SnapshotCache(() => "source"); let calls = 0;
  const read = async () => ({ data: { value: ++calls }, until: Infinity });
  for (let n = 0; n < 17; n++) await cache.snapshot(String(n), 0, read);
  await cache.snapshot("0", 0, read);
  expect(calls).toBe(18);
});
