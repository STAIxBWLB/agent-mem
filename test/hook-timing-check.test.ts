import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function probe(flags: NodeJS.ProcessEnv, passed = false, priorExit = 0) {
  const root = mkdtempSync(join(tmpdir(), "amem-timing-gate-")), summary = join(root, "summary.md");
  try {
    const file = resolve(import.meta.dir, "../scripts/hook-timing-check.ts");
    const env = { ...flags, GITHUB_STEP_SUMMARY: summary };
    const values = passed ? { knownWork: true, wallMs: 55, limitMs: 140 } : { knownWork: false, wallMs: 161.6, limitMs: 140 };
    const script = `import {singleAttemptTiming} from ${JSON.stringify(file)};process.exitCode=${priorExit};singleAttemptTiming('cold fixture',${passed},${JSON.stringify(values)},${JSON.stringify(env)});`;
    const result = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), summary: readFileSync(summary, "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a single timing miss is strict locally and with only one CI marker", () => {
  for (const env of [{}, { CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
    const result = probe(env);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('"status":"fail"');
    expect(result.stderr).not.toMatch(/^::warning/m);
    expect(result.summary).toContain("161.6");
  }
});

test("a GitHub single timing miss warns and records its exact numbers in both outputs", () => {
  const result = probe({ CI: "true", GITHUB_ACTIONS: "true" });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('"status":"warning"');
  expect(result.stdout).toContain('"knownWork":false');
  expect(result.stderr).toContain("::warning title=Hook single-attempt timing::");
  expect(result.summary).toContain("cold fixture: warning");
  expect(result.summary).toContain('"wallMs":161.6');
  expect(result.summary).toContain('"limitMs":140');
});

test("a warning cannot erase an existing hard gate failure", () => {
  expect(probe({ CI: "true", GITHUB_ACTIONS: "true" }, false, 7).code).toBe(7);
});

test("a passing single measurement is still recorded in the GitHub step summary", () => {
  const result = probe({ CI: "true", GITHUB_ACTIONS: "true" }, true);
  expect(result.code).toBe(0);
  expect(result.summary).toContain("cold fixture: pass");
  expect(result.stderr).not.toContain("::warning");
});
