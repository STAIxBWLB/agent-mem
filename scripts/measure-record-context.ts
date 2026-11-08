/** Aggregate-only Record context and derived-index measurements. Never invoke a hook on a real home. */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertCopyHome } from "./ac4-recheck.ts";
import { HOOK_EVENTS } from "../src/hook-contract.ts";

const MAXIMUM = 1200;
const PUBLIC_EVENTS = new Set<string>([...HOOK_EVENTS, "Record", "Title", "Recap", "Compact"]);
async function runtime(root: string) {
  const load = (file: string) => import(pathToFileURL(join(root, "src", file)).href);
  return {
    capture: await load("memory/capture.ts") as typeof import("../src/memory/capture.ts"),
    store: await load("memory/store.ts") as typeof import("../src/memory/store.ts"),
    work: await load("memory/work-lists.ts") as typeof import("../src/memory/work-lists.ts"),
    brief: await load("session-brief.ts") as typeof import("../src/session-brief.ts"),
    doctor: await load("memory/doctor.ts") as typeof import("../src/memory/doctor.ts"),
    platform: await load("memory/platform.ts") as typeof import("../src/memory/platform.ts"),
    record: await load("hook-record.ts") as typeof import("../src/hook-record.ts"),
    config: await load("memory/config.ts") as typeof import("../src/memory/config.ts"),
    project: await load("memory/project.ts") as typeof import("../src/memory/project.ts"),
  };
}
async function projectBytes(api: Awaited<ReturnType<typeof runtime>>, base: string, cwd: string, project: string) {
  const configured = api.config.loadAmemConfig(base, api.config.repoConfigRoot(cwd)).config;
  if (configured.briefBytes !== undefined && configured.briefBytes < MAXIMUM) throw Error("copied-home brief ceiling is below the measurement protocol; report it separately instead of comparing different ceilings");
  const instructionBytes = configured.records === false ? 0 : Buffer.byteLength(api.record.RECORD_INSTRUCTION) + 1;
  const started = performance.now();
  const brief = await api.doctor.withBriefSnapshot(base, project, measureOnly => api.brief.sessionStartBrief({
    base, cwd, project, maxTokens: MAXIMUM - instructionBytes, measureOnly,
    nativeSession: { signature: api.platform.processSignature(process.pid)! }, timeRemaining: () => 2000,
  }));
  if (!brief.context) throw Error("Record context measurement is unavailable; check the copied home's profile and policy before rerunning");
  const events: Record<string, number> = {};
  for (const line of brief.context.split("\n")) if (line.startsWith("{")) {
    const row = JSON.parse(line) as { section: string; data: { event?: string } };
    if (row.section === "capture") { const event = row.data.event && PUBLIC_EVENTS.has(row.data.event) ? row.data.event : "other"; events[event] = (events[event] ?? 0) + 1; }
  }
  return { dataBytes: Buffer.byteLength(brief.context), instructionBytes, instructionEstimatedTokens: Math.ceil(instructionBytes / 4),
    totalBytes: Buffer.byteLength(brief.context) + instructionBytes, maximum: MAXIMUM,
    coverage: brief.coverage, partial: brief.partial, events, projectionMs: performance.now() - started,
    mode: "read-only-native-shaped-projection-not-R2" };
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
    if (!key || !["--baseline", "--candidate", "--output", "--copy", "--project", "--cwd"].includes(key) || !value || values[key]) throw Error("invalid Record measurement arguments; supply --baseline ROOT --candidate ROOT --output FILE and optionally --copy HOME --project KEY --cwd DIR");
    values[key] = value;
  }
  if (!values["--baseline"] || !values["--candidate"] || !values["--output"]) throw Error("missing Record measurement inputs; supply --baseline ROOT --candidate ROOT --output FILE");
  const baseline = await runtime(resolve(values["--baseline"])), candidate = await runtime(resolve(values["--candidate"]));
  const scratch = mkdtempSync(join(tmpdir(), "amem-record-context-"));
  try {
    for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/fixture/record-context.git"]]) {
      const git = candidate.platform.memoryGitSync(args, { cwd: scratch, encoding: "utf8", timeout: 2000, maxBuffer: 256 * 1024 });
      if (git.status !== 0) throw Error("fixture repository setup failed; check local Git availability before rerunning");
    }
    const raw = join(scratch, "raw"), recorded = join(scratch, "recorded"), project = candidate.project.memoryProjectKey(scratch, { repositoryIsolation: true });
    await seed(candidate, raw, project, false); await seed(candidate, recorded, project, true);
    const before = await projectBytes(baseline, raw, scratch, project), after = await projectBytes(candidate, recorded, scratch, project);
    const unchanged = await projectBytes(candidate, raw, scratch, project);
    let realCopy: unknown;
    if (values["--copy"]) {
      if (!values["--project"] || !values["--cwd"]) throw Error("copied-home inputs incomplete; supply its --project and --cwd");
      const copy = assertCopyHome(values["--copy"]);
      realCopy = { before: await projectBytes(baseline, copy, values["--cwd"], values["--project"]), after: await projectBytes(candidate, copy, values["--cwd"], values["--project"]) };
    }
    const report = { schema: "agent-mem.record-context/v1", fixture: { before, after, noRecordsCandidate: unchanged,
      bytesDelta: after.totalBytes - before.totalBytes, noLarger: after.totalBytes <= before.totalBytes },
      ...(realCopy ? { realCopy } : {}), indexCost: await indexCost(candidate, join(scratch, "large"), project), rawPrivateContentPublished: false };
    writeFileSync(values["--output"], JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(report));
    if (!report.fixture.noLarger) process.exitCode = 1;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (import.meta.main) await main();
