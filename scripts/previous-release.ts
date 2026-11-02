#!/usr/bin/env bun
/**
 * #199 AC6: resolve and unpack the previous published release for the N-1 compatibility job.
 *
 * "Previous release" is the highest published, non-prerelease @staix/agent-mem version that is not newer than this
 * tree's package.json version. On a development tree (package.json still names the last release) that is the
 * release itself; on a release commit (package.json bumped, not yet published) it is the release before. No hand
 * edit is needed per release. The registry is read with a cache-busting request, never `npm view`.
 *
 * Usage: bun scripts/previous-release.ts <dir>   (prints `version<TAB>root` and, under GitHub Actions, exports AMEM_PREV_ROOT)
 * Dev-only: the package keeps zero runtime dependencies; this script uses fetch, tar and node built-ins.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const NAME = "@staix/agent-mem";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parts = (v: string) => SEMVER.exec(v)!.slice(1).map(Number) as [number, number, number];
const compare = (a: string, b: string) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!; return 0; };

/** Pure resolver, exported for tests. */
export function previousRelease(current: string, published: string[]): string | undefined {
  if (!SEMVER.test(current)) throw new Error(`package.json version ${current} is not plain semver`);
  return published.filter(v => SEMVER.test(v) && compare(v, current) <= 0).sort(compare).at(-1);
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("usage: bun scripts/previous-release.ts <dir>");
  const current = (JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;
  const response = await fetch(`https://registry.npmjs.org/${NAME.replace("/", "%2f")}?t=${Date.now()}`, { headers: { accept: "application/json", "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`registry read failed: ${response.status}`);
  const doc = await response.json() as { versions: Record<string, { dist: { tarball: string; integrity?: string } }> };
  const version = previousRelease(current, Object.keys(doc.versions));
  if (!version) throw new Error(`no published ${NAME} release at or below ${current}`);
  const dist = doc.versions[version]!.dist;
  const tarball = await fetch(dist.tarball);
  if (!tarball.ok) throw new Error(`tarball download failed: ${tarball.status}`);
  const bytes = new Uint8Array(await tarball.arrayBuffer());
  if (dist.integrity?.startsWith("sha512-")) {
    const digest = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
    if (`sha512-${digest}` !== dist.integrity) throw new Error(`tarball integrity mismatch for ${version}`);
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `agent-mem-${version}.tgz`);
  writeFileSync(file, bytes);
  const untar = Bun.spawnSync(["tar", "-xzf", file, "-C", dir], { stdout: "inherit", stderr: "inherit" });
  if (untar.exitCode !== 0) throw new Error("tar failed");
  const root = join(dir, "package");
  const unpacked = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  if (unpacked !== version) throw new Error(`unpacked ${unpacked}, expected ${version}`);
  console.log(`${version}\t${root}`);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `AMEM_PREV_ROOT=${root}\nAMEM_PREV_VERSION=${version}\n`);
}
