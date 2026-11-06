import { expect, test } from "bun:test";
import { reapDistribution } from "../scripts/probe-hook-reap.ts";

test("reap evidence uses nearest-rank percentiles and retains the maximum independently of p99", () => {
  const input = Array.from({ length: 200 }, (_, index) => index + 1).reverse();
  expect(reapDistribution(input)).toEqual({ samples: 200, quantile: "nearest-rank", p50Ms: 100, p95Ms: 190, p99Ms: 198, maxMs: 200 });
  expect(input[0]).toBe(200);
});
test("missing or invalid probe samples cannot size a reap bound", () => {
  for (const values of [[], [NaN], [Infinity], [-1]]) expect(() => reapDistribution(values)).toThrow("samples are missing or invalid");
});
