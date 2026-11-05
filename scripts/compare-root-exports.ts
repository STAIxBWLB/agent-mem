/** One-off #268 runtime export proof. Not a permanent gate against future intentional API additions.
 * Archives only src/ and package.json at the fixed reviewed base, with no dependencies, network or real-home access. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export const ROOT_EXPORT_BASE = "27dd80ca6b3f36e5d4ea6511e9e139b686076589";
function baseArgument(args: readonly string[]): string {
  const value = args.length === 0 ? ROOT_EXPORT_BASE
    : args.length === 1 && args[0]?.startsWith("--base=") ? args[0].slice(7)
    : args.length === 2 && args[0] === "--base" ? args[1] : undefined;
  if (typeof value !== "string" || value.length !== 40 || !/^[a-f0-9]+$/.test(value)) throw Error("base must be one full lowercase Git SHA-1 identity");
  return value;
}
async function main() {
  const report: Record<string, unknown> = { diagnostic: "root-export-runtime-proof", scope: "runtime-exports-only", typeExports: "source-reviewed-separately",
    base: ROOT_EXPORT_BASE, head: null, added: [], removed: [], baseCount: null, currentCount: null, equal: false };
  let root: string | undefined;
  const beforeAmem = process.env.AMEM_HOME, beforeAgent = process.env.AGENTHUB_HOME;
  try {
    const base = baseArgument(process.argv.slice(2)); report.base = base;
    const repo = resolve(import.meta.dir, ".."); root = mkdtempSync(join(tmpdir(), "amem-root-exports-"));
    const extracted = join(root, "base"), archive = join(root, "base.tar"), family = join(root, "family"), memory = join(family, "memory");
    mkdirSync(extracted, { mode: 0o700 }); mkdirSync(memory, { recursive: true, mode: 0o700 });
    process.env.AMEM_HOME = memory; process.env.AGENTHUB_HOME = family;
    const { memoryGitArgv, memoryGitEnv } = await import(pathToFileURL(join(repo, "src/memory/platform.ts")).href) as typeof import("../src/memory/platform.ts");
    const env = memoryGitEnv({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" }, { repositoryIsolation: true });
    const headCommand = memoryGitArgv(["rev-parse", "--verify", "HEAD"]);
    const head = spawnSync(headCommand[0]!, headCommand.slice(1), { cwd: repo, env, encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
    if (head.error || head.status !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) throw Error("current proof head unavailable");
    report.head = head.stdout.trim();
    if (process.env.FIX_HEAD && process.env.FIX_HEAD !== report.head) throw Error("proof checkout does not match fixed head");
    const git = memoryGitArgv(["archive", "--format=tar", "--output", archive, base, "--", "src", "package.json"]);
    const archived = spawnSync(git[0]!, git.slice(1), { cwd: repo, env, encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
    if (archived.error || archived.status !== 0 || archived.signal) throw Error("fixed-base source archive unavailable");
    const tar = spawnSync("tar", ["-xf", archive, "-C", extracted], { cwd: root, env, encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
    if (tar.error || tar.status !== 0 || tar.signal) throw Error("fixed-base source archive extraction unavailable");
    const current = await import(pathToFileURL(join(repo, "src/index.ts")).href), previous = await import(pathToFileURL(join(extracted, "src/index.ts")).href);
    const currentNames = Object.keys(current).sort(), baseNames = Object.keys(previous).sort(), currentSet = new Set(currentNames), baseSet = new Set(baseNames);
    const added = currentNames.filter(name => !baseSet.has(name)), removed = baseNames.filter(name => !currentSet.has(name));
    Object.assign(report, { added, removed, baseCount: baseNames.length, currentCount: currentNames.length, equal: added.length === 0 && removed.length === 0 });
    if (added.length || removed.length) process.exitCode = 1;
  } catch {
    report.error = "runtime root export comparison failed; use a complete local base commit and inspect the owned proof inputs"; process.exitCode = 1;
  } finally {
    if (beforeAmem === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = beforeAmem;
    if (beforeAgent === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = beforeAgent;
    if (root) try { rmSync(root, { recursive: true, force: true }); } catch { report.cleanup = "owned proof directory cleanup failed"; report.equal = false; process.exitCode = 1; }
    console.log(JSON.stringify(report, null, 2));
  }
}
if (import.meta.main) await main();
