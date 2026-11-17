import { expect, test } from "bun:test";
import { hashJSON } from "../src/memory/generation.ts";
import { homeIdentityHash, homeIdentityMatches } from "../src/memory/home-identity.ts";

const home = "/tmp/amem-home", before = { dev: 16777231n, ino: 814443715n, uid: 501n };
const pinned = hashJSON([home, String(before.dev), String(before.ino), String(before.uid)]);

test("a reboot-renumbered device keeps the retained home binding (#444)", () => {
  const after = { ...before, dev: 16777232n };
  expect(homeIdentityHash(home, after, pinned)).toBe(pinned);
  expect(homeIdentityMatches(pinned, home, after)).toBe(true);
});

test("a replaced or moved home is still refused", () => {
  expect(homeIdentityMatches(pinned, home, { ...before, dev: 16777232n, ino: 814443716n })).toBe(false);
  expect(homeIdentityMatches(pinned, home, { ...before, uid: 502n })).toBe(false);
  expect(homeIdentityMatches(pinned, "/tmp/other-home", before)).toBe(false);
});

test("without a pinned value the current identity is returned", () => {
  const after = { ...before, dev: 16777232n };
  expect(homeIdentityHash(home, after)).toBe(hashJSON([home, "16777232", String(before.ino), String(before.uid)]));
  expect(homeIdentityHash(home, before, pinned)).toBe(pinned);
});
