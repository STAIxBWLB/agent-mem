import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function probe(flags: NodeJS.ProcessEnv, wallP95Ms = 195.3, peakRssMB = 75, priorExit = 0) {
  const root = mkdtempSync(join(tmpdir(), "amem-budget-platform-")), summary = join(root, "summary.md");
  try {
    const file = resolve(import.meta.dir, "../scripts/hook-timing-check.ts");
    const values = { wallP95Ms, peakRssMB, wallLimitMs: 150, rssLimitMB: 100 };
    const script = `import {workloadBudget} from ${JSON.stringify(file)};process.exitCode=${priorExit};const result=workloadBudget('plain',${JSON.stringify(values)},${JSON.stringify({ ...flags, GITHUB_STEP_SUMMARY: summary })});if(!result.pass)process.exitCode=1;`;
    const result = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(), summary: readFileSync(summary, "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const githubMac = { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" };

test("only the GitHub macOS runner warns on p95 and records the original numbers", () => {
  const result = probe(githubMac);
  expect(result.code).toBe(0); expect(result.out).toContain('"status":"warning"');
  expect(result.out).toContain('"wallTimingPass":false'); expect(result.out).toContain('"wallAdvisory":true');
  expect(result.err).toContain("::warning title=Hook macOS runner p95::");
  expect(result.summary).toContain("plain: warning");
  expect(result.summary).toContain('"wallP95Ms":195.3'); expect(result.summary).toContain('"wallLimitMs":150');
});

test("the same p95 miss fails Ubuntu, non-CI and every incomplete or incorrect runner marker", () => {
  for (const flags of [{}, { RUNNER_OS: "macOS" }, { CI: "true", RUNNER_OS: "macOS" }, { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" },
    { CI: "true", GITHUB_ACTIONS: "true" }, { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" },
    { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Windows" }, { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "macos" }]) {
    const result = probe(flags);
    expect(result.code).not.toBe(0); expect(result.out).toContain('"status":"fail"');
    expect(result.out).toContain('"wallAdvisory":false'); expect(result.err).not.toContain("::warning");
    expect(result.summary).toContain('"wallP95Ms":195.3');
  }
});

test("RSS at or above 100 MB remains hard even with a GitHub macOS p95 warning", () => {
  for (const wall of [55, 195.3]) for (const rss of [100, 105]) {
    const result = probe(githubMac, wall, rss);
    expect(result.code).not.toBe(0); expect(result.out).toContain('"peakPass":false');
    expect(result.out).toContain('"status":"fail"'); expect(result.summary).toContain("plain: fail");
  }
});

test("a p95 warning cannot erase an existing hard R1 or functional exit, and invalid samples fail", () => {
  expect(probe(githubMac, 195.3, 75, 7).code).toBe(7);
  expect(probe(githubMac, Number.NaN).code).not.toBe(0);
  expect(probe(githubMac, 55, Number.NaN).code).not.toBe(0);
});

test("within-budget workloads pass on either runner and locally without a warning", () => {
  for (const flags of [{}, githubMac, { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" }]) {
    const result = probe(flags, 75, 80);
    expect(result.code).toBe(0); expect(result.out).toContain('"status":"pass"'); expect(result.err).not.toContain("::warning");
  }
});
