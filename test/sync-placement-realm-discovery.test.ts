import { expect, test } from "bun:test";
import { remoteOnlyPlacementRealms } from "../src/memory/sync-placement-realm-discovery.ts";
import type { SyncPlacementRealmBinding } from "../src/memory/sync-placement-plan.ts";

const ref = (hash: string) => `${"a".repeat(40)}\trefs/heads/amem/p/${hash}\n`;
const inventory: SyncPlacementRealmBinding[] = [
  { scope: "user", bindingHash: "b".repeat(64) },
  { scope: "project", keyHash: "1".repeat(64), bindingHash: "c".repeat(64) },
];

test("remote-only listing returns sorted scope and hashes, excluding the effective inventory", () => {
  const listed = remoteOnlyPlacementRealms(Buffer.from(ref("3".repeat(16)) + ref("1".repeat(16)) + ref("2".repeat(16))), inventory);
  expect(listed).toEqual([{ scope: "project", keyHash: "2".repeat(16) }, { scope: "project", keyHash: "3".repeat(16) }]);
  expect(remoteOnlyPlacementRealms(Buffer.alloc(0), inventory)).toEqual([]);
});

test("remote-only listing refuses malformed, duplicate, truncated, oversized and ambiguous inventories", () => {
  for (const raw of [ref("1".repeat(16)) + ref("1".repeat(16)), ref("x".repeat(16)), ref("1".repeat(16)).trimEnd(), "private project name\n", "a".repeat(256 * 1024 + 1)])
    expect(() => remoteOnlyPlacementRealms(Buffer.from(raw), inventory)).toThrow();
  expect(() => remoteOnlyPlacementRealms(Buffer.from([255]), inventory)).toThrow();
  const collision = [...inventory, { scope: "project" as const, keyHash: "1".repeat(16) + "2".repeat(48), bindingHash: "d".repeat(64) }];
  expect(() => remoteOnlyPlacementRealms(Buffer.alloc(0), collision)).toThrow();
});
