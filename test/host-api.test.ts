import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as root from "../src/index.ts";
import * as platform from "../src/memory/platform.ts";
import { rootValues, rootTypes, platformValues, platformTypes } from "./fixtures/host-api-v1/surface.ts";

import { fingerprint } from "./fixtures/host-api-v1/fingerprint.ts";

function compare(actual: Record<string, unknown>, expected: Record<string, unknown>, area: string): void {
  expect(Object.keys(actual).sort(), `${area}: exports changed; review the v1 contract or raise the supported API version`).toEqual(Object.keys(expected).sort());
  for (const name of Object.keys(expected)) {
    if (name === "__dependencies") {
      const have = actual[name] as Record<string, unknown>, want = expected[name] as Record<string, unknown>;
      expect(Object.keys(have).sort(), `${area}: referenced types changed; review the v1 contract`).toEqual(Object.keys(want).sort());
      for (const key of Object.keys(want)) expect(have[key], `${area}: ${key} changed; review compatibility or raise the API version`).toEqual(want[key]);
    } else expect(actual[name], `${area}: ${name} changed; review compatibility or raise the API version`).toEqual(expected[name]);
  }
}

test("host API version range and v1 export signatures remain compatible", () => {
  expect(root.HOST_API_VERSION).toBe(platform.HOST_API_VERSION);
  expect(root.HOST_API_MIN).toBe(platform.HOST_API_MIN);
  expect(Number.isSafeInteger(root.HOST_API_VERSION)).toBe(true);
  expect(Number.isSafeInteger(root.HOST_API_MIN)).toBe(true);
  expect(root.HOST_API_MIN).toBeGreaterThan(0);
  expect(root.HOST_API_VERSION).toBeGreaterThanOrEqual(root.HOST_API_MIN);
  expect(root.HOST_API_VERSION).toBe(1); // A new API version also needs its own frozen fixture.
  for (const name of rootValues) expect(name in root, `root ${name}`).toBe(true);
  for (const name of platformValues) expect(name in platform, `platform ${name}`).toBe(true);
  const expected = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/host-api-v1/signatures.json"), "utf8"));
  compare(fingerprint(join(import.meta.dir, "../src/index.ts"), rootValues, rootTypes), expected.root, "root");
  compare(fingerprint(join(import.meta.dir, "../src/memory/platform.ts"), platformValues, platformTypes), expected.platform, "platform");
}, 30_000);

test("a removed host export is reported with its name", () => {
  expect(() => fingerprint(join(import.meta.dir, "../src/index.ts"), ["host_export_removed_for_test"], []))
    .toThrow("host API export removed: host_export_removed_for_test");
}, 30_000);
