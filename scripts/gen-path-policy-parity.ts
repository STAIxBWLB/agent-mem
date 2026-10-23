/**
 * Regenerates test/fixtures/path-policy-parity.json from agent-hub's REAL matcher (#15 T4: the repo scope ports it, src/memory/path-glob.ts).
 *   bun scripts/gen-path-policy-parity.ts <agent-hub checkout> > test/fixtures/path-policy-parity.json
 * The expected values come from `matchesPolicy` (includeParents true, as `mentionsPrivatePath` calls it) in an EMPTY project, so no path exists, which is how a note
 * that merely names a path is judged, and from `policyPaths` for the entries the hub refuses. Never edit the JSON by hand: regenerate it.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const hub = resolve(process.argv[2] ?? "");
if (!process.argv[2]) { console.error("usage: bun scripts/gen-path-policy-parity.ts <agent-hub checkout>"); process.exit(2); }
const { matchesPolicy, policyPaths } = await import(join(hub, "src/hub/path-policy.ts"));
const commit = spawnSync("git", ["-C", hub, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "parity-")));
const entries = ["data/**/*.csv", "hr/*", "hr2", "secrets/**", "**/ß", "reports/q?-*.pdf", "a/b", "Café/**", "docs/*/draft*", "**/private", ".", "./x//y/", "a/**/b/**", "*"];
const paths = ["data/2025/customers.csv", "data/customers.csv", "data/2025/customers.txt", "data/a/b/c.csv", "data2/x.csv", "data", "data/2025",
  "hr/payroll.xlsx", "hr/a/b.xlsx", "hr", "hr2/x", "hr2", "hr22/x", "secrets/k", "secrets", "x/secrets/k", "src/ß", "ß", "a/b/ß", "src/SS",
  "reports/q1-final.pdf", "reports/q12-final.pdf", "reports/q1-final.docx", "a/b", "a/b/c", "a", "a/bc", "Café/x", "CAFE\u0301/x", "cafe/x",
  "docs/x/draft1", "docs/x/y/draft1", "docs/x/final", "m/private", "private", "m/n/private/q", "m/privates", "DATA/2025/CUSTOMERS.CSV", "Data/x.CSV", "src/a.ts", "README.md",
  "x/y", "x", "./x/y/z", "../data/a.csv", "/data/a.csv", "a/x/b/c", "a/b/x/b"];
const expected: Record<string, Record<string, boolean>> = {}, exact: Record<string, Record<string, boolean>> = {};
for (const entry of entries) {
  expected[entry] = {}; exact[entry] = {};
  for (const path of paths) {
    expected[entry]![path] = matchesPolicy(cwd, path, policyPaths([entry], "pii.paths"), true);
    // includeParents false: only a path AT or BENEATH the entry matches, the stricter reading that makes the glob structure observable (with parents on, any partial match counts).
    exact[entry]![path] = matchesPolicy(cwd, path, policyPaths([entry], "pii.paths"), false);
  }
}
const invalid: unknown[] = [["/abs"], ["../x"], ["a/../b"], ["a[1]"], ["a{b}"], ["!a"], ["a\\b"], ["a**b"], ["**a/b"], [""], [5], "x", Array.from({ length: 65 }, (_, i) => `p${i}`), ["x".repeat(201)], ["a\u0000b"], ["*".repeat(17)], ["./a//b/"], ["a/**/b/**"], ["data/**/*.csv", "hr/*"], [], undefined];
const validation = invalid.map(value => { try { return { value, result: policyPaths(value, "pii.paths") }; } catch { return { value, result: "REFUSED" }; } });
rmSync(cwd, { recursive: true, force: true });
console.log(JSON.stringify({ generatedBy: "scripts/gen-path-policy-parity.ts", hubCommit: commit, entries, paths, expected, exact, validation }, null, 1));
