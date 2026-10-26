import { expect, test } from "bun:test";
import { createStandalonePolicy, fold } from "../src/memory/policy.ts";
import { distributions, EXCERPT_BYTES, featureMasks, syntheticRow } from "./fakes/search-profile-fixture.ts";

test("realistic profile marginals survive actual fold at a fixed UTF-8 byte volume", () => {
  const masks = featureMasks(1000);
  const observed = { nonAscii: 0, slashDot: 0, doubleSlash: 0, atMarker: 0, pathHeavy: 0 };
  let hangul = 0, arrows = 0, emDashes = 0, shortest = Infinity, longest = 0;
  for (const [index, mask] of masks.entries()) {
    const row = syntheticRow(index, mask), normalized = fold(row.excerpt);
    expect(Buffer.byteLength(row.excerpt)).toBe(EXCERPT_BYTES);
    expect(Buffer.from(row.excerpt).toString("utf8")).toBe(row.excerpt);
    expect(row.excerpt).toContain("rankneedle");
    expect(row.paths).toHaveLength(mask & 16 ? 3 : 0);
    observed.nonAscii += Number(/[^\p{ASCII}]/u.test(normalized));
    observed.slashDot += Number(normalized.includes("/."));
    observed.doubleSlash += Number(normalized.includes("//"));
    observed.atMarker += Number(normalized.includes("@"));
    observed.pathHeavy += Number(normalized.includes("src/memory/public.ts"));
    hangul += Number(/[가-힣]/.test(normalized));
    arrows += Number(normalized.includes("→")); emDashes += Number(normalized.includes("—"));
    shortest = Math.min(shortest, row.excerpt.length); longest = Math.max(longest, row.excerpt.length);
  }
  expect(observed).toEqual({ nonAscii: 800, slashDot: 30, doubleSlash: 10, atMarker: 30, pathHeavy: 250 });
  expect(hangul).toBeGreaterThan(0); expect(arrows).toBeGreaterThan(0); expect(emDashes).toBeGreaterThan(0);
  expect(shortest).toBeLessThan(longest);
  expect(syntheticRow(0, masks[0]!).excerpt).toContain("rankneedle exactanchor preciseanchor");
  expect(syntheticRow(1, masks[1]!).excerpt).not.toContain("exactanchor");
});

test("feature seeds reproduce the corpus with independently overlapping distributions", () => {
  const count = 1000, masks = featureMasks(count);
  expect(featureMasks(count)).toEqual(masks);
  expect([...masks].every(mask => mask >= 0 && mask < 32)).toBe(true);
  for (let a = 0; a < distributions.length; a++) {
    const first = distributions[a]!;
    expect([...masks].filter(mask => (mask & first.bit) !== 0)).toHaveLength(Math.round(count * first.probability));
    for (let b = a + 1; b < distributions.length; b++) {
      const second = distributions[b]!, expected = count * first.probability * second.probability;
      const overlap = [...masks].filter(mask => (mask & first.bit) !== 0 && (mask & second.bit) !== 0).length;
      // Fixed independent shuffles need not hit fractional expected counts exactly.
      // A five-sigma allowance permits sampling variation without accepting coupled/disjoint common groups.
      const tolerance = Math.max(2, Math.ceil(5 * Math.sqrt(expected * (1 - first.probability) * (1 - second.probability))));
      expect(Math.abs(overlap - expected)).toBeLessThanOrEqual(tolerance);
    }
  }
  expect([...masks].some(mask => (mask & 17) === 17)).toBe(true);
  expect([...masks].some(mask => (mask & 17) === 16)).toBe(true);
  expect(syntheticRow(73, masks[73]!)).toEqual(syntheticRow(73, featureMasks(count)[73]!));
});

test("all 32 representative feature combinations remain public under the real standalone policy", async () => {
  const policy = createStandalonePolicy();
  for (let mask = 0; mask < 32; mask++) {
    const row = syntheticRow(mask, mask);
    expect(Buffer.byteLength(row.excerpt)).toBe(EXCERPT_BYTES);
    expect(await policy.screen({ id: mask + 1, project: "profile-fixture", agent: "fixture", event: "Quiet", ...row })).toBe(true);
  }
});
