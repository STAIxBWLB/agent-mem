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

const githubMac = { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" };
const completeEvidence = { telemetryValid: true, survivors: 0, abandonedOwnedWorkers: 1, unavailableRssSources: 1, receiptIncomplete: true, wallMs: 301 };
const advisoryKinds = ["rss-unknown", "owned-descendant-receipt", "not-durable", "transcript-wall-max"];

test("each new advisory requires the exact hosted GitHub macOS markers", async () => {
  const { budgetFailureAdvisory } = await import("../scripts/hook-timing-check.ts");
  for (const kind of advisoryKinds) {
    expect(budgetFailureAdvisory(kind, completeEvidence, githubMac)).toBe(true);
    for (const env of [{}, { CI: "true" }, { GITHUB_ACTIONS: "true" }, { RUNNER_OS: "macOS" },
      { CI: "true", RUNNER_OS: "macOS" }, { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" },
      { CI: "true", GITHUB_ACTIONS: "true" }, { ...githubMac, RUNNER_OS: "Linux" },
      { ...githubMac, RUNNER_OS: "macos" }, { ...githubMac, CI: "1" }, { ...githubMac, GITHUB_ACTIONS: "TRUE" }])
      expect(budgetFailureAdvisory(kind, completeEvidence, env), `${kind}: ${JSON.stringify(env)}`).toBe(false);
  }
});

test("unattributed RSS and receipt gaps remain hard failures", async () => {
  const { budgetFailureAdvisory } = await import("../scripts/hook-timing-check.ts");
  for (const kind of ["rss-unknown", "owned-descendant-receipt"]) {
    for (const abandonedOwnedWorkers of [undefined, 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      expect(budgetFailureAdvisory(kind, { ...completeEvidence, abandonedOwnedWorkers }, githubMac)).toBe(false);
    for (const unavailableRssSources of (kind === "rss-unknown" ? [undefined, 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1] : [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]))
      expect(budgetFailureAdvisory(kind, { ...completeEvidence, unavailableRssSources }, githubMac)).toBe(false);
  }
  for (const unavailableRssSources of [undefined, 0])
    expect(budgetFailureAdvisory("owned-descendant-receipt", { ...completeEvidence, unavailableRssSources }, githubMac)).toBe(true);
  expect(budgetFailureAdvisory("owned-descendant-receipt", { ...completeEvidence, receiptIncomplete: false }, githubMac)).toBe(false);
  expect(budgetFailureAdvisory("owned-descendant-receipt", { ...completeEvidence, receiptIncomplete: undefined }, githubMac)).toBe(false);
  expect(budgetFailureAdvisory("rss-unknown", { ...completeEvidence, receiptIncomplete: undefined }, githubMac)).toBe(true);
});

test("survivors, invalid telemetry and malformed optional evidence never become advisories", async () => {
  const { budgetFailureAdvisory } = await import("../scripts/hook-timing-check.ts");
  for (const kind of advisoryKinds) {
    for (const survivors of [1, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, undefined, "0"])
      expect(budgetFailureAdvisory(kind, { ...completeEvidence, survivors: survivors as number }, githubMac)).toBe(false);
    for (const telemetryValid of [false, undefined, 1, "true"])
      expect(budgetFailureAdvisory(kind, { ...completeEvidence, telemetryValid: telemetryValid as boolean }, githubMac)).toBe(false);
    for (const abandonedOwnedWorkers of [-1, 1.5, Number.NaN])
      expect(budgetFailureAdvisory(kind, { ...completeEvidence, abandonedOwnedWorkers }, githubMac)).toBe(false);
    for (const unavailableRssSources of [-1, 1.5, Number.NaN])
      expect(budgetFailureAdvisory(kind, { ...completeEvidence, unavailableRssSources }, githubMac)).toBe(false);
    for (const wallMs of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(budgetFailureAdvisory(kind, { ...completeEvidence, wallMs }, githubMac)).toBe(false);
    expect(budgetFailureAdvisory(kind, { ...completeEvidence, receiptIncomplete: "true" as unknown as boolean }, githubMac)).toBe(false);
  }
});

test("only the transcript per-attempt maximum and durability classes accept minimal valid evidence", async () => {
  const { budgetFailureAdvisory } = await import("../scripts/hook-timing-check.ts");
  const minimal = { telemetryValid: true, survivors: 0 };
  expect(budgetFailureAdvisory("not-durable", minimal, githubMac)).toBe(true);
  expect(budgetFailureAdvisory("transcript-wall-max", { ...minimal, wallMs: 300.001 }, githubMac)).toBe(true);
  for (const wallMs of [undefined, 0, 299, 300])
    expect(budgetFailureAdvisory("transcript-wall-max", { ...minimal, wallMs }, githubMac)).toBe(false);
  for (const kind of ["ceiling", "regression", "hooks-p95", "wall-max", "stall", "unknown", "", "RSS-UNKNOWN"])
    expect(budgetFailureAdvisory(kind, completeEvidence, githubMac)).toBe(false);
});

function advisoryProbe(kind: string, priorExit = 0, summaryAvailable = true, env: NodeJS.ProcessEnv = githubMac) {
  const root = mkdtempSync(join(tmpdir(), "amem-budget-advisory-")), summary = join(root, "summary.md");
  try {
    const file = resolve(import.meta.dir, "../scripts/hook-timing-check.ts");
    const flags = { ...env, ...(summaryAvailable ? { GITHUB_STEP_SUMMARY: summary } : {}) };
    const script = `import {reportBudgetAdvisory} from ${JSON.stringify(file)};process.exitCode=${priorExit};const reported=reportBudgetAdvisory(${JSON.stringify(kind)},'synthetic budget check',${JSON.stringify(completeEvidence)},${JSON.stringify(flags)});console.log(JSON.stringify({reported}));`;
    const result = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
    let contents = ""; try { contents = readFileSync(summary, "utf8"); } catch { /* strict verdicts do not create an advisory summary */ }
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), summary: contents };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("each attributed advisory emits diagnostic JSON, a warning and mandatory summary without clearing an existing failure", () => {
  for (const kind of advisoryKinds) {
    const result = advisoryProbe(kind, 7);
    expect(result.code).toBe(7);
    expect(result.stdout).toContain('"diagnostic":"hosted-macos-budget-advisory"');
    expect(result.stdout).toContain(`"kind":"${kind}"`);
    expect(result.stdout).toContain('"survivors":0');
    expect(result.stdout).toContain('"reported":true');
    expect(result.stderr).toContain("::warning title=Hook macOS runner budget::");
    expect(result.summary).toContain(`synthetic budget check: warning (${kind})`);
    expect(result.summary).toContain('"abandonedOwnedWorkers":1');
    expect(result.summary).toContain('"wallMs":301');
  }
  expect(advisoryProbe("not-durable").code).toBe(0);
});

test("strict failures return false without warning or summary, and advisory summary absence fails", () => {
  for (const result of [advisoryProbe("ceiling", 9), advisoryProbe("rss-unknown", 9, true, {})]) {
    expect(result.code).toBe(9); expect(result.stdout).toContain('"reported":false');
    expect(result.stderr).not.toContain("::warning"); expect(result.summary).toBe("");
  }
  for (const kind of advisoryKinds) {
    const result = advisoryProbe(kind, 0, false);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("GitHub macOS budget step summary is unavailable");
    expect(result.stdout).not.toContain('"reported":true');
  }
});
