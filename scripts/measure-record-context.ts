/** Aggregate-only Record context and derived-index measurements. Never invoke a hook on a real home. */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertCopyHome } from "./ac4-recheck.ts";
import { HOOK_EVENTS } from "../src/hook-contract.ts";

const PUBLIC_EVENTS = new Set<string>([...HOOK_EVENTS, "Record", "Title", "Recap", "Compact"]);
type Phase = "arguments" | "runtime" | "fixture" | "copy" | "index";
let phase: Phase = "arguments";
interface NativeFormatter {
  sessionNoticeAndLimit(base: string, cwd: string, options: { cwd: string; base: string }, currentDropped: boolean): { dropNotice: string; contextLimit: number; instruction: string };
  joinedContext(body: string, notice: string, maximum: number): string;
  instructionCost(context: string): { recordInstructionBytes: number; recordInstructionEstimatedTokens: number };
}
export interface RecordContextProjection {
  totalBytes: number; maximum: number;
  coverage: { work: string; capture: string };
  sections: { work: number; capture: number };
  events: Record<string, number>;
}
type Qualification = { complete: true } | { complete: false; cause: string; nextStep: string };
/** Check observed data selection, never qualify a shorter unavailable header as a successful projection. */
export function qualifyRecordContext(projection: RecordContextProjection, expectation: "raw" | "records" | "observed" = "observed"): Qualification {
  const counts = [projection.sections.work, projection.sections.capture, ...Object.values(projection.events)];
  const measurable = [projection.coverage.work, projection.coverage.capture].every(value => value === "complete" || value === "partial")
    && Number.isSafeInteger(projection.totalBytes) && projection.totalBytes > 0
    && Number.isSafeInteger(projection.maximum) && projection.maximum > 0 && projection.totalBytes <= projection.maximum
    && counts.every(value => Number.isSafeInteger(value) && value >= 0)
    && Object.values(projection.events).reduce((sum, value) => sum + value, 0) === projection.sections.capture;
  const selected = expectation === "observed" || projection.sections.work > 0 && (expectation === "records"
    ? (projection.events.Record ?? 0) >= 1
    : projection.sections.capture > 0 && (projection.events.Record ?? 0) === 0 && (projection.events.PostToolUse ?? 0) > 0);
  return measurable && selected ? { complete: true } : {
    complete: false, cause: "Context sources are unavailable or the expected synthetic work/capture selection is missing.",
    nextStep: "Inspect the isolated fixture or reviewer-owned copy's source coverage and policy, then rerun; do not count header-only savings as success.",
  };
}
export function qualifyRecordContextFixture(before: RecordContextProjection, after: RecordContextProjection, unchanged: RecordContextProjection) {
  for (const [projection, expectation] of [[before, "raw"], [after, "records"], [unchanged, "raw"]] as const) {
    const qualified = qualifyRecordContext(projection, expectation);
    if (!qualified.complete) return { ...qualified, pass: false as const, noLarger: false as const };
  }
  const noLarger = after.totalBytes <= before.totalBytes;
  return { complete: true as const, pass: noLarger, noLarger, bytesDelta: after.totalBytes - before.totalBytes,
    ...(!noLarger ? { cause: "The qualified Record projection exceeds the baseline context bytes.", nextStep: "Retain this failed comparison and review selection and byte budgets before repeating the measurement." } : {}) };
}
/** Test-only export access, not a formatter copy or a shipping API/body change. */
function exposeNativeFormatters(roots: string[]) {
  const files = new Set(roots.map(root => join(root, "src/hooks.ts")));
  Bun.plugin({ name: "record-context-native-formatter", setup(builder) {
    builder.onLoad({ filter: /\/hooks\.ts$/ }, ({ path }) => {
      if (!files.has(path)) return;
      let contents = readFileSync(path, "utf8");
      for (const name of ["sessionNoticeAndLimit", "joinedContext", "instructionCost"]) {
        const needle = `\nfunction ${name}(`;
        if (contents.split(needle).length !== 2) throw Error("native context formatter anchor changed; recheck the measurement preload against this runtime before rerunning");
        contents = contents.replace(needle, `\nexport function ${name}(`);
      }
      return { loader: "ts", contents };
    });
  } });
}
async function runtime(root: string) {
  const load = (file: string) => import(pathToFileURL(join(root, "src", file)).href);
  return {
    capture: await load("memory/capture.ts") as typeof import("../src/memory/capture.ts"),
    store: await load("memory/store.ts") as typeof import("../src/memory/store.ts"),
    work: await load("memory/work-lists.ts") as typeof import("../src/memory/work-lists.ts"),
    brief: await load("session-brief.ts") as typeof import("../src/session-brief.ts"),
    doctor: await load("memory/doctor.ts") as typeof import("../src/memory/doctor.ts"),
    platform: await load("memory/platform.ts") as typeof import("../src/memory/platform.ts"),
    config: await load("memory/config.ts") as typeof import("../src/memory/config.ts"),
    project: await load("memory/project.ts") as typeof import("../src/memory/project.ts"),
    formatter: await load("hooks.ts") as NativeFormatter,
  };
}
function sourcePin(root: string, api: Awaited<ReturnType<typeof runtime>>) {
  const options = { cwd: root, encoding: "utf8" as const, timeout: 2000, maxBuffer: 256 * 1024 };
  const head = api.platform.memoryGitSync(["rev-parse", "HEAD"], options), status = api.platform.memoryGitSync(["status", "--porcelain"], options);
  const commit = head.stdout.toString().trim();
  if (head.status !== 0 || status.status !== 0 || !/^[a-f0-9]{40}$/.test(commit) || status.stdout.toString().trim()) throw Error("measurement runtime is not a clean pinned Git checkout; commit the intended code and rerun on that revision");
  return { commit };
}
async function projectBytes(api: Awaited<ReturnType<typeof runtime>>, base: string, cwd: string, project: string) {
  const budget = api.formatter.sessionNoticeAndLimit(base, cwd, { cwd, base }, false);
  const started = performance.now();
  const brief = await api.doctor.withBriefSnapshot(base, project, measureOnly => api.brief.sessionStartBrief({
    base, cwd, project, maxTokens: Math.max(1, budget.contextLimit - Buffer.byteLength(budget.dropNotice) - (budget.dropNotice ? 1 : 0)), measureOnly,
    nativeSession: { signature: api.platform.processSignature(process.pid)! }, timeRemaining: () => 2000,
  }));
  if (!brief.context) throw Error("Record context measurement is unavailable; check the copied home's profile and policy before rerunning");
  if (!await api.config.configuredPolicy(base, cwd).screen({ context: brief.context })) throw Error("copied-home policy declined the complete context; check its policy before repeating this measurement");
  const body = api.formatter.joinedContext(brief.context, budget.dropNotice, budget.contextLimit);
  const context = body ? budget.instruction + body : "", cost = api.formatter.instructionCost(context);
  if (!context) throw Error("native context formatter could not fit this projection; report the copied-home ceiling separately");
  const events: Record<string, number> = {}, sections = { work: 0, capture: 0 };
  for (const line of brief.context.split("\n")) if (line.startsWith("{")) {
    const row = JSON.parse(line) as { section: string; data: { event?: string } };
    if (row.section === "work") sections.work++;
    if (row.section === "capture") { sections.capture++; const event = row.data.event && PUBLIC_EVENTS.has(row.data.event) ? row.data.event : "other"; events[event] = (events[event] ?? 0) + 1; }
  }
  const projection = { dataBytes: Buffer.byteLength(brief.context), instructionBytes: cost.recordInstructionBytes, instructionEstimatedTokens: cost.recordInstructionEstimatedTokens,
    dropNoticeBytes: Buffer.byteLength(budget.dropNotice), totalBytes: Buffer.byteLength(context), maximum: budget.contextLimit + Buffer.byteLength(budget.instruction),
    coverage: brief.coverage, partial: brief.partial, sections, events, projectionMs: performance.now() - started,
    mode: "read-only-native-formatter-projection-not-R2", intakeAttempted: false, formatterExportsOnly: true };
  const qualified = qualifyRecordContext(projection);
  if (!qualified.complete) throw Error(`${qualified.cause} ${qualified.nextStep}`);
  return projection;
}
async function seed(api: Awaited<ReturnType<typeof runtime>>, base: string, project: string, records: boolean) {
  const store = new api.store.MemoryStore({ memoryDir: base, screen: () => "keep" });
  try { store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "Preserve the public cache contract.", about: ["src/cache.ts"] }); } finally { store.close(); }
  const work = new api.work.WorkListStore({ base, project, policy: () => true });
  try { await work.write("cache repair", { task: "verify cache replay", status: "doing" }); } finally { work.close(); }
  const capture = new api.capture.CaptureStore({ memoryDir: base, project });
  const now = Date.now() - 60_000;
  try {
    for (let n = 0; n < 20; n++) capture.append({ project, agent: "claude", event: "PostToolUse", at: new Date(now + n).toISOString(), paths: ["src/cache.ts"],
      excerpt: `Read cache implementation ${n}: ` + "The cache receipt must survive an interrupted writer and remain idempotent on replay. ".repeat(3) });
    if (records) for (const [n, text] of ["amem: fix | src/cache.ts | duplicate replay -> retain the receipt", "amem: contract | src/cache.ts | Cache publication stays idempotent"].entries()) {
      capture.append({ project, agent: "claude", event: "Record", at: new Date(now + 100 + n).toISOString(), excerpt: text, paths: ["src/cache.ts"] });
    }
  } finally { capture.close(); }
}
async function indexCost(api: Awaited<ReturnType<typeof runtime>>, base: string, project: string) {
  const first = new api.capture.CaptureStore({ memoryDir: base, project }), file = join(first.dir, "capture.db"); first.close();
  const db = new Database(file), at = new Date().toISOString();
  try {
    db.run("DROP INDEX rows_brief_records_v1");
    const insert = db.query("INSERT INTO rows(at,project,agent,event,paths,excerpt,bytes) VALUES (?,?,'fixture',?,'[\"src/cache.ts\"]',?,128)");
    db.transaction(() => {
      for (let n = 0; n < 100_000; n++) insert.run(at, project, n % 500 === 0 ? "Record" : "PostToolUse",
        n % 500 === 0 ? "amem: finding | src/cache.ts | indexcostneedle" : `raw indexcostneedle ${n}`);
    }).immediate();
  } finally { db.close(); }
  const capture = new api.capture.CaptureStore({ memoryDir: base, project }), original = Database.prototype.run;
  let buildMs: number | undefined;
  Database.prototype.run = function(this: Database, ...args: Parameters<typeof original>) {
    const started = performance.now();
    try { return original.apply(this, args); }
    finally { if (typeof args[0] === "string" && args[0].startsWith("CREATE INDEX IF NOT EXISTS rows_brief_records_v1")) buildMs = performance.now() - started; }
  };
  const started = performance.now();
  try {
    capture.readPage({ project, query: "indexcostneedle", limit: 1 });
    const offHookMs = performance.now() - started;
    if (buildMs === undefined) throw Error("Record index build was not observed; restore the unindexed fixture and rerun");
    return { rows: 100_000, records: 200, recordIndexBuildMs: buildMs, totalOffHookSearchMs: offHookMs,
      scope: "one-time-large-derived-index-build-not-hook-R2" };
  } finally { Database.prototype.run = original; capture.close(); }
}

async function main() {
  const values: Record<string, string> = {};
  for (let n = 2; n < process.argv.length; n += 2) {
    const key = process.argv[n], value = process.argv[n + 1];
    if (!key || !["--baseline", "--candidate", "--output", "--copy", "--project", "--cwd"].includes(key) || !value || values[key]) throw Error("invalid Record measurement arguments; supply --baseline ROOT --candidate ROOT --output FILE and optionally --copy PARENT-OF-MEMORY --project KEY --cwd DIR");
    values[key] = value;
  }
  if (!values["--baseline"] || !values["--candidate"] || !values["--output"]) throw Error("missing Record measurement inputs; supply --baseline ROOT --candidate ROOT --output FILE");
  phase = "runtime";
  const baseRoot = resolve(values["--baseline"]), candidateRoot = resolve(values["--candidate"]);
  exposeNativeFormatters([baseRoot, candidateRoot]);
  const baseline = await runtime(baseRoot), candidate = await runtime(candidateRoot);
  const sources = { baseline: sourcePin(baseRoot, baseline), candidate: sourcePin(candidateRoot, candidate) };
  const scratch = mkdtempSync(join(tmpdir(), "amem-record-context-"));
  try {
    phase = "fixture";
    for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/fixture/record-context.git"]]) {
      const git = candidate.platform.memoryGitSync(args, { cwd: scratch, encoding: "utf8", timeout: 2000, maxBuffer: 256 * 1024 });
      if (git.status !== 0) throw Error("fixture repository setup failed; check local Git availability before rerunning");
    }
    const raw = join(scratch, "raw"), recorded = join(scratch, "recorded"), project = candidate.project.memoryProjectKey(scratch, { repositoryIsolation: true });
    await seed(candidate, raw, project, false); await seed(candidate, recorded, project, true);
    const before = await projectBytes(baseline, raw, scratch, project), after = await projectBytes(candidate, recorded, scratch, project);
    const unchanged = await projectBytes(candidate, raw, scratch, project);
    const qualified = qualifyRecordContextFixture(before, after, unchanged);
    if (!qualified.complete) throw Error(`${qualified.cause} ${qualified.nextStep}`);
    let realCopy: unknown;
    if (values["--copy"]) {
      phase = "copy";
      if (!values["--project"] || !values["--cwd"]) throw Error("copied-home inputs incomplete; supply its --project and --cwd");
      const copy = assertCopyHome(values["--copy"]);
      realCopy = { before: await projectBytes(baseline, copy, values["--cwd"], values["--project"]), after: await projectBytes(candidate, copy, values["--cwd"], values["--project"]) };
    }
    phase = "runtime";
    if (sourcePin(baseRoot, baseline).commit !== sources.baseline.commit || sourcePin(candidateRoot, candidate).commit !== sources.candidate.commit) throw Error("measurement runtime changed during projection; rerun on immutable checkouts");
    phase = "index";
    const report = { schema: "agent-mem.record-context/v1", complete: true, pass: qualified.pass, sources, fixture: { before, after, noRecordsCandidate: unchanged, ...qualified },
      ...(realCopy ? { realCopy } : {}), indexCost: await indexCost(candidate, join(scratch, "large"), project), rawPrivateContentPublished: false };
    writeFileSync(values["--output"], JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(report));
    if (!report.fixture.noLarger) process.exitCode = 1;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try { await main(); }
  catch {
    const remedies: Record<Phase, { cause: string; nextStep: string }> = {
      arguments: { cause: "measurement arguments are missing or invalid", nextStep: "Supply --baseline ROOT --candidate ROOT --output FILE; copied inputs also need --copy PARENT-OF-MEMORY --project KEY --cwd DIR." },
      runtime: { cause: "runtime source is unavailable, unpinned or incompatible with the formatter preload", nextStep: "Use clean Part-1-capable Git checkouts and verify the preload's three native formatter anchors." },
      fixture: { cause: "synthetic seeding or context projection did not complete", nextStep: "Run the synthetic-canary regression and inspect its fixture policy and byte cap." },
      copy: { cause: "copied-home input or projection was refused", nextStep: "Provide the parent of a separate memory copy with its project/cwd, then check the copied profile, policy and byte cap; never pass a live home." },
      index: { cause: "the synthetic derived-index measurement did not complete", nextStep: "Check the isolated large-store fixture and retain this failure rather than treating it as a passed measurement." },
    };
    console.log(JSON.stringify({ schema: "agent-mem.record-context/v1", complete: false, stage: phase, ...remedies[phase] }));
    process.exitCode = 1;
  }
}
