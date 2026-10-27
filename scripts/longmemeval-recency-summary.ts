/** Compact, fail-closed aggregation for the frozen #105 recency experiment. */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { RECENCY_BASE, RECENCY_FILES, RECENCY_MODES, patchRecencySource, type RecencyFile, type RecencyMode } from "./longmemeval-recency.ts";
import { readBoundedReport } from "./longmemeval-compare.ts";
import { adopts, FIXTURE_NAMES, type AdoptionVerdict } from "./f14-gate.ts";
import { memoryGitEnv, memoryGitSync } from "../src/memory/platform.ts";

const TARGET = { fixtureSets: [] as const, longMemEvalTypes: ["knowledge-update", "multi-session"] as const };
const VARIANTS = ["S", "M"] as const;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function fileSha(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
function assert(ok: unknown, reason: string): asserts ok { if (!ok) throw Error("recency summary: " + reason); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (obj(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function gitBase(file: RecencyFile): string {
  const result = memoryGitSync(["-C", resolve(import.meta.dir, ".."), "-c", "core.hooksPath=/dev/null", "show", `${RECENCY_BASE}:${file}`], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: memoryGitEnv({ PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, { repositoryIsolation: true }),
  });
  assert(result.status === 0, `cannot read pinned base source ${file}`);
  return result.stdout;
}
function sourceExpectations(mode: RecencyMode) {
  return Object.fromEntries(RECENCY_FILES.map(file => {
    const before = gitBase(file), after = patchRecencySource(before, file, mode);
    return [file, { before: sha(before), after: sha(after), changed: before !== after }];
  })) as Record<RecencyFile, { before: string; after: string; changed: boolean }>;
}
function reportPath(dir: string, mode: RecencyMode, variant: "S" | "M"): string { return join(dir, `${mode}-${variant}.json`); }
function jsonFile(path: string): any { return readBoundedReport(path); }
interface SummaryContext {
  directory: string;
  expectedByMode: Record<RecencyMode, Record<RecencyFile, { before: string; after: string; changed: boolean }>>;
}
async function compareIdentity(context: SummaryContext, mode: RecencyMode, variant: "S" | "M", report: any, receipt: any, provenance: any, driverSha: string) {
  for (const [name, value] of [["receipt", receipt], ["provenance", provenance]] as const) {
    assert(obj(value) && value.issue === 105 && value.mode === mode && value.variant === variant, `${mode}-${variant} ${name} mode/variant mismatch`);
    assert(value.baseCommit === RECENCY_BASE && value.driverSha256 === driverSha, `${mode}-${variant} ${name} base/driver mismatch`);
    assert(typeof value.runtimeCommit === "string" && /^[a-f0-9]{40}$/.test(value.runtimeCommit), `${mode}-${variant} ${name} runtime commit malformed`);
    assert(typeof value.patchSha256 === "string" && /^[a-f0-9]{64}$/.test(value.patchSha256), `${mode}-${variant} ${name} patch hash malformed`);
    assert(Array.isArray(value.changes) && canonical(value.changes) === canonical((Object.keys(context.expectedByMode[mode]) as RecencyFile[]).map(file => ({ file, ...context.expectedByMode[mode][file] }))), `${mode}-${variant} ${name} source patch identity mismatch`);
  }
  assert(receipt.runtimeCommit === provenance.runtimeCommit && receipt.patchSha256 === provenance.patchSha256 && canonical(receipt.changes) === canonical(provenance.changes), `${mode}-${variant} receipt/provenance mismatch`);
  assert(report.complete === true && report.fatal === undefined && Array.isArray(report.failed) && report.failed.length === 0, `${mode}-${variant} report is not complete and failure-free`);
  assert(receipt.complete === true && receipt.failed === 0, `${mode}-${variant} receipt is incomplete or failed`);
  assert(receipt.reportSha256 === await fileSha(reportPath(context.directory, mode, variant)), `${mode}-${variant} report hash differs from receipt`);
  assert(obj(report.runtime) && report.runtime.commit === receipt.runtimeCommit, `${mode}-${variant} report runtime commit differs from receipt`);
  assert(receipt.dataset?.sha256 === report.dataset?.sha256 && receipt.dataset?.bytes === report.dataset?.bytes && receipt.harnessSha256 === report.harnessSha256, `${mode}-${variant} report controls differ from receipt`);
  assert(receipt.questions === report.questions && receipt.abstentions === report.abstentions, `${mode}-${variant} report counts differ from receipt`);
  assert(report.selection?.questionTypes === null && report.selection?.skippedByType === 0 && report.selection?.examined === report.questions, `${mode}-${variant} report is not full/unfiltered`);
  assert(report.questions === 500, `${mode}-${variant} report does not contain all 500 questions`);
  assert(typeof receipt.patchSha256 === "string" && receipt.patchSha256 === await fileSha(reportPath(context.directory, mode, variant) + ".patch"), `${mode}-${variant} patch file hash differs from receipt`);
}

function shortMetrics(metrics: any): unknown {
  assert(obj(metrics) && obj(metrics.overall) && obj(metrics.byType), "report metrics malformed");
  return { overall: metrics.overall, byType: metrics.byType };
}
async function readCondition(context: SummaryContext, mode: RecencyMode, variant: "S" | "M", driverSha: string) {
  const path = reportPath(context.directory, mode, variant), report = jsonFile(path), receipt = jsonFile(path + ".receipt.json"), provenance = jsonFile(path + ".provenance.json");
  await compareIdentity(context, mode, variant, report, receipt, provenance, driverSha);
  return { report, receipt, provenance, file: { report: basename(path), reportSha256: receipt.reportSha256, receipt: basename(path + ".receipt.json"), provenance: basename(path + ".provenance.json"),
    baseCommit: receipt.baseCommit, runtimeCommit: receipt.runtimeCommit, driverSha256: receipt.driverSha256, patchSha256: receipt.patchSha256,
    sourceChanges: receipt.changes, dataset: { sha256: report.dataset.sha256, bytes: report.dataset.bytes }, harnessSha256: report.harnessSha256, questions: report.questions, abstentions: report.abstentions }, metrics: shortMetrics(report.metrics) };
}
async function fixturesFor(context: SummaryContext, mode: RecencyMode, baseline: any, driverSha: string) {
  const path = join(context.directory, `${mode}-fixtures.json`), value = jsonFile(path);
  assert(obj(value) && value.issue === 105 && value.mode === mode && value.variant === "S" && value.baseCommit === RECENCY_BASE && value.driverSha256 === driverSha, `${mode} fixture provenance malformed`);
  assert(value.runtimeCommit === baseline.provenance.runtimeCommit && value.patchSha256 === baseline.provenance.patchSha256 && canonical(value.changes) === canonical(baseline.provenance.changes), `${mode} fixtures do not match S provenance`);
  assert(obj(value.reports), `${mode} fixture reports missing`);
  for (const name of FIXTURE_NAMES) {
    const fixture = value.reports[name];
    assert(obj(fixture) && obj(fixture.all) && Array.isArray(fixture.perQuestion), `${mode} fixture ${name} malformed`);
    assert(Number.isFinite(fixture.all.mrr) && Number.isFinite(fixture.all.hit?.[1]) && Number.isFinite(fixture.all.hit?.[10]), `${mode} fixture ${name} aggregate malformed`);
  }
  return { path: basename(path), sha256: await fileSha(path), reports: value.reports, summary: Object.fromEntries(FIXTURE_NAMES.map(name => [name, value.reports[name].all])) };
}
function onlyPendingAc4(verdict: AdoptionVerdict) {
  const pending = "private AC4: reviewer no-loss rerun pending";
  return verdict.status === "incomplete" && verdict.reasons.length === 1 && verdict.reasons[0] === pending;
}
function candidateAssessment(mode: "recency-tie" | "floor-half", baseline: any, candidate: any, baseFixtures: any, gotFixtures: any) {
  const verdict = adopts({ target: TARGET, baselineFixtures: baseFixtures.reports, candidateFixtures: gotFixtures.reports,
    longMemEval: { S: { baseline: baseline.S.report, candidate: candidate.S.report }, M: { baseline: baseline.M.report, candidate: candidate.M.report } }, privateAc4: "missing" });
  assert(verdict.comparisons.S && verdict.comparisons.M, `${mode} F14v2 comparisons are incomplete`);
  const { comparisons, ...decision } = verdict;
  return { byDataset: { S: comparisons.S!, M: comparisons.M! }, verdict: decision, publicEligibility: { eligible: onlyPendingAc4(verdict), status: verdict.status, reasons: verdict.reasons } };
}
export async function summarizeRecency(directory: string) {
  const context: SummaryContext = { directory: resolve(directory), expectedByMode: Object.fromEntries(RECENCY_MODES.map(mode => [mode, sourceExpectations(mode)])) as Record<RecencyMode, Record<RecencyFile, { before: string; after: string; changed: boolean }>> };
  const driverSha = sha(readFileSync(join(import.meta.dir, "longmemeval-recency.ts")));
  const gateSha = sha(readFileSync(join(import.meta.dir, "f14-gate.ts")));
  const compareSha = sha(readFileSync(join(import.meta.dir, "longmemeval-compare.ts")));
  const conditions = {} as Record<RecencyMode, Record<"S" | "M", Awaited<ReturnType<typeof readCondition>>>>;
  for (const mode of RECENCY_MODES) {
    conditions[mode] = {} as Record<"S" | "M", Awaited<ReturnType<typeof readCondition>>>;
    for (const variant of VARIANTS) conditions[mode][variant] = await readCondition(context, mode, variant, driverSha);
  }
  for (const mode of RECENCY_MODES) {
    const s = conditions[mode].S, m = conditions[mode].M;
    assert(s.file.driverSha256 === m.file.driverSha256 && s.file.dataset.sha256 !== m.file.dataset.sha256, `${mode} S/M driver or dataset identity invalid`);
    assert(s.file.harnessSha256 === m.file.harnessSha256, `${mode} S/M harness mismatch`);
    assert(s.file.patchSha256 === m.file.patchSha256, `${mode} S/M patch hash mismatch`);
    assert(canonical(s.file.sourceChanges.map((c: any) => ({ file: c.file, before: c.before, after: c.after, changed: c.changed }))) === canonical(m.file.sourceChanges.map((c: any) => ({ file: c.file, before: c.before, after: c.after, changed: c.changed }))), `${mode} S/M source hashes differ`);
  }
  for (const variant of VARIANTS) {
    const base = conditions.baseline[variant].report;
    for (const mode of RECENCY_MODES.slice(1)) {
      const candidate = conditions[mode][variant].report;
      assert(base.dataset.sha256 === candidate.dataset.sha256 && base.dataset.bytes === candidate.dataset.bytes && base.harnessSha256 === candidate.harnessSha256, `${mode}-${variant} dataset/harness mismatch against baseline`);
    }
  }
  const fixtures = {} as Record<RecencyMode, Awaited<ReturnType<typeof fixturesFor>>>;
  for (const mode of RECENCY_MODES) fixtures[mode] = await fixturesFor(context, mode, conditions[mode].S, driverSha);
  const recency = candidateAssessment("recency-tie", conditions.baseline, conditions["recency-tie"], fixtures.baseline, fixtures["recency-tie"]);
  const floor = candidateAssessment("floor-half", conditions.baseline, conditions["floor-half"], fixtures.baseline, fixtures["floor-half"]);
  const compact = (condition: Awaited<ReturnType<typeof readCondition>>) => ({ ...condition.file, metrics: condition.metrics });
  return { preRegistration: { issue: 105, baseCommit: RECENCY_BASE, target: TARGET, comparisonFloor: 0.5, expectations: {
      primary: "all@10 increases on pooled knowledge-update and multi-session targets",
      guardrails: "temporal-reasoning MRR may decrease by at most 0.01; every other metric remains flat",
      fixtures: "all four fixture sets remain unchanged or improve",
    }, conditions: RECENCY_MODES },
    driverSha256: driverSha, gateSha256: gateSha, compareSha256: compareSha,
    conditions: Object.fromEntries(RECENCY_MODES.map(mode => [mode, { S: compact(conditions[mode].S), M: compact(conditions[mode].M),
      fixtures: { file: fixtures[mode].path, sha256: fixtures[mode].sha256, summary: fixtures[mode].summary } }])), comparisons: { recencyTie: recency, floorHalf: { ...floor, comparisonOnly: true, selectedForAdoption: false } },
    adoption: recency.verdict, publicEligibility: recency.publicEligibility };
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  assert(args.length === 4 && args[0] === "--directory" && args[2] === "--output", "usage: bun scripts/longmemeval-recency-summary.ts --directory DIR --output NEWFILE");
  const output = resolve(args[3]!);
  const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  assert(!existsSync(output), "output must be a new file");
  const result = await summarizeRecency(args[1]!);
  mkdirSync(resolve(output, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ output, adoption: result.adoption, publicEligibility: result.publicEligibility }));
}
