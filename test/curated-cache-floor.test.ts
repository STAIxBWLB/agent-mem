import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatFloorAtLeast } from "../src/memory/formats.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
for (const surface of ["home", "curated"]) test(`${surface} admission needs a person floor at the supporting release`, () => {
  const root = mkdtempSync(join(tmpdir(), "amem-curated-floor-")); roots.push(root);
  expect(formatFloorAtLeast(root, "curated", "2.3.0")).toBe(false);
  for (const [minReader, expected] of [["2.2.9", false], ["2.3.0", true], ["2.3.1", true]] as const) {
    writeFileSync(join(root, "formats.json"), JSON.stringify([{ surface, minReader, since: "fixture" }]));
    expect(formatFloorAtLeast(root, "curated", "2.3.0")).toBe(expected);
  }
  writeFileSync(join(root, "formats.json"), JSON.stringify([{ surface: "capture", minReader: "9.0.0", since: "fixture" }]));
  expect(formatFloorAtLeast(root, "curated", "2.3.0")).toBe(false);
});
