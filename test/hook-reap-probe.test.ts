import { expect, test } from "bun:test";
import { observeProbeReapWindow, probeArguments, probeReadiness, reapDistribution } from "../scripts/probe-hook-reap.ts";

test("reap evidence uses nearest-rank percentiles and retains the maximum independently of p99", () => {
  const input = Array.from({ length: 200 }, (_, index) => index + 1).reverse();
  expect(reapDistribution(input)).toEqual({ samples: 200, quantile: "nearest-rank", p50Ms: 100, p95Ms: 190, p99Ms: 198, maxMs: 200 });
  expect(input[0]).toBe(200);
});
test("representative readiness requires an open capture store, completed scan and known numeric RSS", () => {
  const row = { ready: true, phase: "cpu", fixture: "capture-store-scanned", openStore: true, transcriptOffset: 262000,
    rssKB: 48000, rawRssKB: 48000, liveRssMB: 45, workerUptimeMs: 90, rssKnown: true, rssSource: "platform-rusage" };
  expect(probeReadiness(row).liveRssMB).toBe(45);
  expect(probeReadiness({ ...row, phase: "write" }, "write").phase).toBe("write");
  expect(() => probeReadiness(row, "write")).toThrow("footprint is missing or invalid");
  for (const change of [{ openStore: false }, { transcriptOffset: 0 }, { rssKnown: false }, { rssKB: NaN }, { fixture: "bare-bun" }])
    expect(() => probeReadiness({ ...row, ...change })).toThrow("footprint is missing or invalid");
});
test("the unchanged 10 ms promise window distinguishes a late receipt from eventual reaping", async () => {
  expect((await observeProbeReapWindow(Promise.resolve(137))).late).toBe(false);
  const later = new Promise<number>(resolve => setTimeout(() => resolve(137), 50));
  const observed = await observeProbeReapWindow(later);
  expect(observed.boundMs).toBe(10); expect(observed.late).toBe(true); expect(observed.code).toBeUndefined();
  expect(await later).toBe(137);
});
test("fixed probe arms are explicit and cannot be repeated or confused", () => {
  expect(probeArguments([])).toEqual({ series: "idle", phase: "cpu" });
  expect(probeArguments(["--phase=write", "--series=contended"])).toEqual({ series: "contended", phase: "write" });
  for (const args of [["--samples=10"], ["--phase=write", "--phase=cpu"], ["--series=unknown"]])
    expect(() => probeArguments(args)).toThrow("arguments are invalid or repeated");
});
test("missing or invalid probe samples cannot size a reap bound", () => {
  for (const values of [[], [NaN], [Infinity], [-1]]) expect(() => reapDistribution(values)).toThrow("samples are missing or invalid");
});
