import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchesEntries, mentionsPrivatePath, policyEntries } from "../src/memory/path-glob.ts";

// Parity of the amem port with agent-hub's REAL matcher: the expected values in the fixture were produced by the hub's `matchesPolicy` and `policyPaths`
// (scripts/gen-path-policy-parity.ts), never by this port. A mismatch is fixed in src/memory/path-glob.ts, or the fixture is regenerated from a newer hub.
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "path-policy-parity.json"), "utf8")) as {
  hubCommit: string; entries: string[]; paths: string[]; expected: Record<string, Record<string, boolean>>; exact: Record<string, Record<string, boolean>>; validation: { value: unknown; result: string[] | "REFUSED" }[];
};

test("the fixture was produced by the hub's matcher and is not trivially all-true or all-false", () => {
  expect(fixture.hubCommit).toMatch(/^[0-9a-f]{40}$/);
  const cells = Object.values(fixture.expected).flatMap(row => Object.values(row));
  expect(cells.length).toBe(fixture.entries.length * fixture.paths.length);
  expect(cells.filter(Boolean).length).toBeGreaterThan(40); expect(cells.filter(x => !x).length).toBeGreaterThan(300);
  const strict = Object.values(fixture.exact).flatMap(row => Object.values(row));
  expect(strict.filter(Boolean).length).toBeGreaterThan(20); expect(strict.filter(x => !x).length).toBeGreaterThan(400); expect(strict.filter(Boolean).length).toBeLessThan(cells.filter(Boolean).length);
});

for (const entry of fixture.entries) test(`matches exactly the paths the hub matches for ${JSON.stringify(entry)}`, () => {
  const ported = policyEntries([entry], "pii.paths");
  const wrong = fixture.paths.filter(path => matchesEntries(path, ported, true) !== fixture.expected[entry]![path]);
  expect(wrong, `paths where the port and the hub disagree for ${entry}`).toEqual([]);
  // includeParents false: only a path at or beneath the entry. With parents on a partial match already counts, which hides the glob structure.
  const wrongExact = fixture.paths.filter(path => matchesEntries(path, ported, false) !== fixture.exact[entry]![path]);
  expect(wrongExact, `paths where the port and the hub disagree for ${entry} without parents`).toEqual([]);
});

test("entry validation agrees with the hub: the same lists are refused, the same normalized spellings accepted", () => {
  for (const row of fixture.validation) {
    const ported = (() => { try { return policyEntries(row.value, "pii.paths"); } catch { return "REFUSED" as const; } })();
    expect(ported, JSON.stringify(row.value)?.slice(0, 60)).toEqual(row.result);
  }
});

test("the reported failures: a glob entry and a directory entry catch the paths a plain substring never did", () => {
  expect(mentionsPrivatePath("the export lives in data/2025/customers.csv", [], ["data/**/*.csv"])).toBe(true);
  expect(mentionsPrivatePath("see hr/payroll.xlsx", [], ["hr/*"])).toBe(true);
  expect(mentionsPrivatePath("about src/a.ts only", [], ["data/**/*.csv", "hr/*"])).toBe(false);
  expect(mentionsPrivatePath("clean text", ["path:data/x/y.csv"], ["data/**/*.csv"])).toBe(true);
  expect(mentionsPrivatePath("clean text", ["symbol:load@hr/a.ts"], ["hr/*"])).toBe(true);
  // a directory entry protects its subtree, and the spelling folds (case, NFD)
  expect(mentionsPrivatePath("DATA/RAW/X.TXT", [], ["data/raw"])).toBe(true);
  expect(mentionsPrivatePath("Cafe\u0301/menu.md", [], ["Café/**"])).toBe(true);
});

test("pathological input stays bounded: a long path or a long wildcard run does not hang", () => {
  const started = performance.now();
  expect(matchesEntries(`${"a/".repeat(2000)}x`, ["**/*b*c*d*e*f*g*h"], true)).toBe(true); // over 4096 characters is refused as private, as the hub does
  expect(matchesEntries("a".repeat(150) + "/x", ["*a*a*a*a*a*a*a*a*b"], true)).toBe(false);
  expect(performance.now() - started).toBeLessThan(2000);
});
