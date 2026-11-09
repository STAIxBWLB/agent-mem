import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBriefCache } from "../src/brief-cache.ts";
import { readCuratedBriefCache } from "../src/brief-curated-native.ts";
import { captureShardDir } from "../src/memory/shard.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "amem-curated-read-")); roots.push(base);
  const project = "read-fixture", now = Date.now(), machine = "a".repeat(16), profile = "selected";
  writeFileSync(join(base, "machine.json"), JSON.stringify({ id: machine }));
  const directory = captureShardDir(base, project, machine); mkdirSync(directory, { recursive: true, mode: 0o700 });
  // This unit exercises the generic floor reader with this installed release, not the product's admission minimum.
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  const options = { base, project, profile, supportingRelease: version, deferredReason: "curated refresh deferred", now };
  const admit = (surface: string) => writeFileSync(join(base, "formats.json"), JSON.stringify([{ surface, minReader: version, since: "fixture" }]));
  const publish = (builtAt = now, binding = profile, expiresAt: number | null = null) => writeBriefCache({ directory, project, section: "curated" }, {
    schema: "agent-mem.brief-cache/v1", project, section: "curated", builtThrough: now, partial: false, rows: [], curated: { builtAt, binding, expiresAt },
  });
  return { base, directory, now, options, admit, publish };
}
for (const surface of ["home", "curated"]) test(`${surface} floor admission never refreshes missing or stale caches`, () => {
  const f = fixture();
  expect(readCuratedBriefCache(f.options).reason).toBe("curated refresh deferred");
  f.admit(surface);
  expect(readCuratedBriefCache(f.options).reason).toBe("curated cache missing");
  f.publish(); expect(readCuratedBriefCache(f.options).cache?.rows).toEqual([]);
  const file = join(f.directory, "brief-curated.json"), bytes = readFileSync(file);
  expect(readCuratedBriefCache({ ...f.options, profile: "different" }).reason).toBe("curated cache stale");
  expect(readCuratedBriefCache({ ...f.options, now: f.now + 24 * 3600_000 }).reason).toBe("curated cache stale");
  expect(readFileSync(file)).toEqual(bytes);
  f.publish(f.now, "selected", f.now + 1);
  expect(readCuratedBriefCache({ ...f.options, now: f.now + 1 }).reason).toBe("curated cache stale");
  chmodSync(file, 0o644); expect(readCuratedBriefCache(f.options).reason).toBe("curated cache stale");
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface, minReader: "99.0.0", since: "fixture" }]));
  expect(readCuratedBriefCache(f.options).reason).toBe("floor: upgrade amem");
  writeFileSync(join(f.base, "formats.json"), "invalid");
  expect(readCuratedBriefCache(f.options).reason).toBe("floor: amem doctor");
});
