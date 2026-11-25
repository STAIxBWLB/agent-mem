import { placementMarkerState, placementRuntimeRefusal, withDoctorPlacementScratch } from "./sync-placement-guard.ts";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { indexFileName } from "./index-file.ts";
import { assertFormatFloor } from "./formats.ts";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { sessionStartBrief, type BriefOptions } from "../session-brief.ts";
import { openCuratedForRead } from "./curated-read.ts";
import { RECAP_SCRATCH } from "./recap-scratch.ts";
import { pendingSummary } from "./candidate-pending.ts";
import { inspectNativeRoot, nativeRoots, type NativeRootKind } from "./native-roots.ts";
import { readCaptureDrops } from "./metrics.ts";
import { isRecapTelemetry } from "./recap-telemetry.ts";
import { walkShards } from "./catalog.ts";
import { loadAmemConfig, repoConfigRoot } from "./config.ts";
import { readSelector } from "./generation.ts";
import { processLiveness, withGitTimeout } from "./platform.ts";
import { endLikeSignal, STOP_SIGNALS } from "./sync-cadence.ts";
import { boundRepoRoot } from "./repo-scope.ts";
import { aliasedKeys, shardDir } from "./shard.ts";
import { curatedCount, projectTransition, transitionKey, transitionNotice } from "./roots.ts";
import type { MemoryStore, View } from "./store.ts";
import { nextSyncAt, readSyncState, remoteConfigured, syncDue, usableState } from "./sync-cadence.ts";
import { readSyncStatus } from "./sync-progress.ts";
import { readSetupDrift } from "../setup-drift.ts";
import { readHookSpoolStatus } from "../hook-spool.ts";

/**
 * F15, `amem doctor`: one report over the memory home. It writes nothing into the home. Every check that needs a store (the notes, the brief, the index proof) runs on a
 * private scratch copy of the logs in a temporary directory that is removed afterwards: opening the live store would take a reader lease, refresh and checkpoint the live
 * index, and the live work list would run its migration. The live index is only snapshotted (a read-only connection and `VACUUM INTO`), so "index equals rebuild" compares the
 * index the way a reader would refresh it with a full rebuild, without anyone's index being touched. A home nobody used, and a project the home has not seen, stay absent.
 * Every section is `ok`, `attention` (something to look at), `skipped` (nothing to check here, with the reason: not a problem) or `unavailable` (it could not be
 * checked, with the reason), never a silent zero.
 */
export type SectionStatus = "ok" | "attention" | "skipped" | "unavailable";
export type Section<T extends object = Record<string, unknown>> = { status: SectionStatus } & T;
export const DOCTOR_SCHEMA = "amem.doctor/v1";
export const CLIS = ["claude", "codex", "kimi", "pi", "qwen"] as const;
export type Cli = typeof CLIS[number];
/** A CLI whose last capture is older than this is called stale. */
export const CAPTURE_STALE_MS = 7 * 86400_000;
/** A sync remote whose last success is older than this needs attention. */
export const SYNC_STALE_MS = 7 * 86400_000;
const DEFAULT_BRIEF_TOKENS = 1200;
const COPY_LIMIT_BYTES = 64 * 1024 * 1024;
/** Notes read per project for the duplicate and stale checks; a report says when a project has more. */
export const LIST_ALL = 100_000;
const MAX_IDS = 10;

export interface DoctorOptions {
  home: string; homeSource: string; cwd: string; project: string; aliases: readonly string[]; now: number;
  /** Test seam for setup path resolution; the CLI uses the process environment. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Opens this project's curated store on `base`, the way the other person reads do (a split home through its project shard). Doctor passes a private scratch base, never the live home. */
  openCurated: (base: string) => MemoryStore;
  /** The cadence command the person runs from their own shell; shown in the report, never installed. */
  syncCommand?: string;
  /** Test seam: called with the scratch directory right after it is made, before anything else runs. The CLI never sets it. */
  afterScratch?: (dir: string) => void;
}
export interface DoctorReport {
  schema: typeof DOCTOR_SCHEMA;
  status: SectionStatus;
  home: { path: string; source: string };
  project: string;
  sections: {
    duplicates: Section; stale: Section; candidates: Section; capture: Section; brief: Section; index: Section; readers: Section; policy: Section; cadence: Section;
    /** Added after v1 shipped (#132); additive, so the schema stays amem.doctor/v1. */
    drops: Section;
    /** #217, additive: bounded read-only home-wide hook backlog inventory. */
    spool?: Section;
    /** #188, additive: present only when the project's curated logs hold forget or prune operations. Informational; status is always ok. */
    masked?: Section;
    /** #202, additive: applied native setup registrations checked against the shared path resolver. */
    setup?: Section;
    /** #551, additive: present on a placement home only - the writer verification the next sync performs. */
    writers?: Section;
    /** #581, additive: present only when this working root last resolved to a different, unjoined key. Read-only. */
    transition?: Section;
  };
}

const worst = (values: SectionStatus[]): SectionStatus => values.includes("attention") ? "attention" : values.includes("unavailable") ? "unavailable" : "ok";
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
const unavailable = (reason: string): Section => ({ status: "unavailable", reason });
const skipped = (reason: string): Section => ({ status: "skipped", reason });
/** #188: counts only, from the curated copy the doctor already opened. Never raises attention by itself. */
function maskedSection(curated: MemoryStore | undefined): { masked?: Section } {
  if (!curated) return {};
  const { forgets, prunes } = curated.maskingCounts();
  if (!forgets && !prunes) return {};
  return { masked: { status: "ok", forgets, prunes, note: "masked entries stay in the local log and in sync history; see docs/purge.md" } };
}
/** #581: a read of roots.jsonl and aliases.jsonl only; doctor never writes a root line. */
function transitionSection(options: DoctorOptions): { transition?: Section } {
  try {
  const transition = projectTransition(options.home, options.cwd, transitionKey(options.cwd), key => curatedCount(options.home, key, shardDir));
  return transition ? { transition: { status: "attention", ...transition, notice: transitionNotice(transition) } } : {};
  } catch { return {}; }
}
const ids = (list: string[]): string[] => list.slice(0, MAX_IDS).map(id => id.slice(0, 8));
const regularDir = (path: string): boolean => { try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; } };
const regularFile = (path: string): boolean => { try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; } };

type Layout = "shared-v1" | "generation" | "split";
function layoutOf(home: string): Layout {
  if (existsSync(join(home, "shards.json"))) return "split";
  return readSelector(home).selector?.kind === "generation" ? "generation" : "shared-v1";
}

/** Whether this project's curated notes already exist, so there is something to copy. */
function curatedPresent(home: string, project: string, layout: Layout): boolean {
  if (layout === "split") return existsSync(join(shardDir(home, project), "generation.json"));
  if (layout === "generation") return true;
  return regularDir(join(home, "log"));
}

/** What a scratch copy leaves out: databases, locks, repositories, the machine-local capture and work trees, spools and ingest cursors. */
const SKIP = /\.db(-wal|-shm)?$|\.lock$|\.tmp$|^\.git$|\.git$|^spool$|^ingest$|^readers$/;
class TooBig extends Error {}
// ponytail: at most three complete copy attempts; a future incremental snapshot protocol can reduce retry cost.
const RECAP_SNAPSHOT_ATTEMPTS = 3;
export class RecapSourceChangedError extends Error {
  constructor(directory: boolean) {
    super(`recap source ${directory ? "directory " : ""}changed during snapshot after ${RECAP_SNAPSHOT_ATTEMPTS} attempts; wait for memory writes to settle, then retry Recap.`);
    this.name = "RecapSourceChangedError";
  }
}
interface CopyBudget { bytes: number; verify?: (() => void)[]; verifyBytes?: number }
function retainVerification(budget: CopyBudget, path: string, stamp: string, verify: () => void): void {
  budget.verify!.push(verify);
  // Account for captured path/stamp strings and a conservative per-closure allowance in the provider's cache bound.
  budget.verifyBytes = (budget.verifyBytes ?? 0) + 2 * (Buffer.byteLength(path) + Buffer.byteLength(stamp)) + 512;
}
function observedCopy(from: string, to: string, budget: CopyBudget): void {
  budget.bytes += statSync(from).size; if (budget.bytes > COPY_LIMIT_BYTES) throw new TooBig();
  let verifySource: (() => void) | undefined;
  if (budget.verify) {
    const stamp = () => { const s = lstatSync(from, { bigint: true }); if (!s.isFile()) throw Error("recap source is not a plain file"); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; };
    const before = stamp(); verifySource = () => { let current: string; try { current = stamp(); } catch { throw Error("recap source changed"); } if (current !== before) throw Error("recap source changed"); };
    retainVerification(budget, from, before, verifySource);
  }
  try { copyFileSync(from, to); } catch (error) { verifySource?.(); throw error; }
}
function observeDirectory(from: string, budget: CopyBudget, keep: (name: string) => boolean): (() => void) | undefined {
  if (!budget.verify) return;
  const stamp = () => { const s = lstatSync(from, { bigint: true }); if (!s.isDirectory()) throw Error("recap source directory changed"); return JSON.stringify([String(s.dev), String(s.ino), readdirSync(from).filter(keep).sort()]); };
  const before = stamp(), verify = () => { let current: string; try { current = stamp(); } catch { throw Error("recap source directory changed"); } if (current !== before) throw Error("recap source directory changed"); };
  retainVerification(budget, from, before, verify); return verify;
}
function copyTree(from: string, to: string, budget: CopyBudget, skipNames: ReadonlySet<string> = new Set()): void {
  const verifyDirectory = observeDirectory(from, budget, name => !(SKIP.test(name) && !(basename(from) === "public-prune-objects" && /^[a-f0-9]{40}\.git$/.test(name))) && !skipNames.has(name));
  try {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(from)) {
      const proofObject = basename(from) === "public-prune-objects" && /^[a-f0-9]{40}\.git$/.exec(name)?.[0] === name;
      if (SKIP.test(name) && !proofObject || skipNames.has(name)) continue;
      const source = join(from, name), stat = lstatSync(source);
      if (proofObject && !stat.isFile()) throw new Error("a public prune object is not a plain file");
      if (stat.isSymbolicLink()) throw new Error("the memory home holds a link where a plain file or directory is expected");
      if (stat.isDirectory()) copyTree(source, join(to, name), budget, skipNames);
      else if (stat.isFile()) observedCopy(source, join(to, name), budget);
    }
  } catch (error) { verifyDirectory?.(); throw error; }
}

/** The curated side of the home, without any database: the logs of this project (and its aliases), and the small files that bind them. */
function copyCurated(options: Pick<DoctorOptions, "home" | "project" | "aliases">, layout: Layout, scratch: string, budget: CopyBudget, recap = false): void {
  const home = options.home;
  observeDirectory(home, budget, name => !SKIP.test(name) && !(recap && isRecapTelemetry(name)) && regularFile(join(home, name)));
  for (const name of readdirSync(home)) {      // top-level plain files: machine.json, shards.json, profile.json, aliases.jsonl, lifecycle.jsonl, the configuration
    if (SKIP.test(name) || recap && isRecapTelemetry(name) || !regularFile(join(home, name))) continue;
    observedCopy(join(home, name), join(scratch, name), budget);
  }
  const selected = readSelector(home).selector;
  if (selected?.schema === "agent-mem.profile/v2" || selected?.schema === "agent-mem.profile/v3") {
    const name = `${selected.pruneInputSetHash}.json`, source = join(home, "public-prune-input-sets", name), stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("the committed public prune view is not a plain file");
    const directory = join(scratch, "public-prune-input-sets"); mkdirSync(directory, { mode: 0o700 });
    observedCopy(source, join(directory, name), budget); chmodSync(join(directory, name), 0o600);
  }
  if (layout === "split") {
    for (const key of [options.project, ...options.aliases]) {
      const dir = shardDir(home, key);
      if (existsSync(join(dir, "generation.json"))) copyTree(dir, join(scratch, "projects", dir.split("/").pop()!), budget, new Set(["machine", "work"]));
    }
    if (regularDir(join(home, "user"))) copyTree(join(home, "user"), join(scratch, "user"), budget);
  } else {
    if (layout === "generation") copyTree(join(home, "generations"), join(scratch, "generations"), budget);
    for (const folder of ["log", "local"]) if (regularDir(join(home, folder))) copyTree(join(home, folder), join(scratch, folder), budget);   // shared-v1's logs; a generation's legacy input
  }
}

/** The work logs of this project and its aliases, in a private base of their own: the brief opens a work list read-write and migrates its index. */
function copyWork(options: Pick<DoctorOptions, "home" | "project" | "aliases">, base: string, budget: CopyBudget): boolean {
  let any = false;
  for (const name of ["machine.json", "aliases.jsonl", "lifecycle.jsonl"]) if (regularFile(join(options.home, name))) { mkdirSync(base, { recursive: true, mode: 0o700 }); observedCopy(join(options.home, name), join(base, name), budget); }
  for (const key of [options.project, ...options.aliases]) {
    const dir = shardDir(options.home, key), log = join(dir, "work", "log");
    if (!regularDir(log)) continue;
    copyTree(log, join(base, "projects", dir.split("/").pop()!, "work", "log"), budget);
    if (regularFile(join(dir, "project.json"))) observedCopy(join(dir, "project.json"), join(base, "projects", dir.split("/").pop()!, "project.json"), budget);
    any = true;
  }
  return any;
}

/** Reuse doctor's bounded private inputs for an on-demand brief, never a live store or reader lease. */
export async function withBriefSnapshot<T>(home: string, project: string, read: (inputs: NonNullable<BriefOptions["measureOnly"]>) => Promise<T>, onValidated?: (validate: () => void, retries: number, verifyBytes: number) => void): Promise<T> {
  const aliases = aliasedKeys(home, project), selection = readSelector(home).revision, layout = layoutOf(home), guard = guardScratch();
  const inputDirectories = [join(home, "projects"), ...(layout === "split" ? [join(home, "user")] : [join(home, "log"), join(home, "local")]),
    ...(layout === "generation" ? [join(home, "generations")] : []),
    ...[project, ...aliases].flatMap(key => { const dir = shardDir(home, key); return [dir, join(dir, "work"), join(dir, "work", "log")]; })];
  const checkDirectories = () => {
    for (const dir of inputDirectories) { const stat = lstatSync(dir, { throwIfNoEntry: false }); if (stat && !stat.isDirectory()) throw Error("recap input is not a plain directory"); }
  };
  const check = (budget: CopyBudget) => {
    checkDirectories();
    if (readSelector(home).revision !== selection || layoutOf(home) !== layout || JSON.stringify(aliasedKeys(home, project)) !== JSON.stringify(aliases)) throw Error("recap binding changed");
    for (const verify of budget.verify!) verify();
  };
  try {
    for (let attempt = 0; attempt < RECAP_SNAPSHOT_ATTEMPTS; attempt++) {
      const budget: CopyBudget = { bytes: 0, verify: [] };
      try {
        checkDirectories();
        return await withDoctorPlacementScratch(home, guard.adopt, async scratch => {
          let curated: MemoryStore | undefined;
          try {
            const options = { home, project, aliases }, workBase = join(scratch, "work-base"); mkdirSync(workBase, { mode: 0o700 });
            copyWork(options, workBase, budget);
            if (curatedPresent(home, project, layout)) {
              const copy = join(scratch, "home"); copyCurated(options, layout, copy, budget, true);
              curated = openCuratedForRead(copy, project, RECAP_SCRATCH);
              if (!curated) throw Error("recap curated snapshot unavailable");
            }
            check(budget);
            const result = await read({ ...(curated ? { curated } : {}), workBase });
            check(budget);
            onValidated?.(() => check(budget), attempt, budget.verifyBytes ?? 0);
            return result;
          } finally { curated?.close(); }
        });
      } catch (error) {
        if (!(error instanceof Error) || !["recap source changed", "recap source directory changed"].includes(error.message)) throw error;
        if (attempt + 1 === RECAP_SNAPSHOT_ATTEMPTS) throw new RecapSourceChangedError(error.message === "recap source directory changed");
      }
    }
    throw Error("recap snapshot unavailable; retry Recap.");
  } catch (error) {
    if (error instanceof TooBig) throw Error("recap snapshot exceeds the 64 MiB copy limit");
    throw error;
  } finally {
    guard.release();
  }
}

/** A snapshot of the live shared-v1 index (a read-only connection, so no checkpoint, no lease), or false when there is none. */
function snapshotIndex(live: string, to: string): boolean {
  const file = join(live, indexFileName(false));
  if (!regularFile(file)) return false;
  const forms: (() => Database)[] = [
    () => new Database(file, { readonly: true }),
    () => new Database(`file:${encodeURI(file).replace(/\?/g, "%3F").replace(/#/g, "%23")}?immutable=1`, { readonly: true } as ConstructorParameters<typeof Database>[1]),
  ];
  for (const open of forms) {
    let db: Database | undefined;
    try { db = open(); db.run("PRAGMA busy_timeout = 1000"); db.run(`VACUUM INTO '${to.replaceAll("'", "''")}'`); return true; }
    catch { /* the next form */ } finally { try { db?.close(); } catch { /* nothing to close */ } }
  }
  throw new Error("the live index could not be snapshotted");
}

function duplicatesAndStale(options: DoctorOptions, rows: View[], store: MemoryStore): { duplicates: Section; stale: Section } {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.kind, (row.title ?? "").trim().toLowerCase(), row.text.replace(/\s+/g, " ").trim().toLowerCase()]);
    groups.set(key, [...(groups.get(key) ?? []), row.id]);
  }
  const same = [...groups.values()].filter(group => group.length > 1).map(group => group.sort());
  let legacy = 0;
  try { legacy = store.dedupe(options.project, false).groups.length; } catch { /* the legacy preview is optional */ }
  const truncated = rows.length >= LIST_ALL;
  const duplicates: Section = { status: same.length || legacy || truncated ? "attention" : "ok", notes: rows.length, identicalGroups: same.length,
    ...(same.length ? { examples: same.slice(0, MAX_IDS).map(group => group.map(id => id.slice(0, 8))) } : {}), importedGroups: legacy,
    ...(truncated ? { truncated: `only the newest ${LIST_ALL} notes were read` } : {}),
    ...(legacy ? { hint: "amem dedupe previews the imported duplicates; amem dedupe --apply reconciles them" } : {}) };
  const root = boundRepoRoot(options.cwd, options.home, options.project);
  let stale: Section;
  if (!root) stale = skipped("run doctor from inside this project's repository to check its path references");
  else {
    const missing = rows.filter(row => { const paths = row.about.filter(node => node.startsWith("path:")).map(node => node.slice(5)); return paths.length > 0 && paths.every(path => !existsSync(join(root, path))); });
    stale = { status: missing.length ? "attention" : "ok", checked: rows.length, missingReferences: missing.length, ...(missing.length ? { examples: ids(missing.map(row => row.id)), hint: "The person can inspect these examples with amem show <id> from their own shell." } : {}) };
  }
  return { duplicates, stale };
}

/** The incremental index, as a reader would refresh it from the snapshot of the live one, against a full rebuild of the same logs. Both live in the scratch copy. */
function indexSection(store: MemoryStore, layout: Layout, snapshotted: boolean): Section {
  if (layout !== "shared-v1") return skipped(store.profile.publicationFormat === "agent-mem.sync-placement/v1"
    ? "the live placement index cannot be compared without rebuilding it on open; run amem rebuild to rebuild the index"
    : "a curated split or generation home builds and seals its index when it is created; amem rebuild repeats it");
  try {
    store.list({ limit: 1 });                         // brings the snapshot level with the logs, as the next reader would
    const incremental = store.dump(); store.rebuild();
    return incremental === store.dump() ? { status: "ok", liveIndex: snapshotted ? "snapshotted" : "absent" }
      : { status: "attention", liveIndex: snapshotted ? "snapshotted" : "absent", hint: "the index differs from a rebuild of the logs: run amem rebuild" };
  } catch (error) { return unavailable(message(error)); }
}

function receiptPhase(home: string, cli: Cli): "applied" | "prepared" | null {
  try {
    const file = join(home, "setup", `${cli}.json`), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return null;
    const value = JSON.parse(readFileSync(file, "utf8")) as { target?: unknown; phase?: unknown };
    return value.target === cli && (value.phase === "applied" || value.phase === "prepared") ? value.phase : null;
  } catch { return null; }
}

/**
 * Per CLI: is a capture hook registered, and when did it last capture. "Registered" is what the setup receipt says (`hookEvidence`): a hook the person removed by hand
 * afterwards still shows as registered until `amem setup <cli> --apply` or `--undo` is run again. A CLI without a receipt is `manual`.
 */
type CaptureState = "fresh" | "stale" | "never";
type MachineState = CaptureState | "unknown";
type Tally = Map<string, { rows: number; last: string | null }>;

function tallyInto(seen: Tally, row: { agent: string; n: number; last: string | null }): void {
  const prior = seen.get(row.agent);
  seen.set(row.agent, { rows: (prior?.rows ?? 0) + row.n, last: prior?.last && prior.last > (row.last ?? "") ? prior.last : row.last });
}

/** This home's machine id from machine.json, read-only (doctor never creates the identity); undefined when absent or invalid. */
function localMachineId(home: string): string | undefined {
  try {
    const file = join(home, "machine.json"), stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    const id = (JSON.parse(readFileSync(file, "utf8")) as { id?: unknown }).id;
    return typeof id === "string" && /^[0-9a-f]{16}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

function stateOf(last: string | null, now: number): CaptureState {
  return last === null ? "never" : now - Date.parse(last) > CAPTURE_STALE_MS ? "stale" : "fresh";
}

/**
 * The one place a capture hint is chosen (#509 extends it). `trigger` names the state that raised it: the machine-wide one (#510), this project's one
 * (the fallback when another shard could not be read), or a missing setup for a CLI that has never captured anywhere.
 */
export function captureHint(cli: Cli, registered: boolean, state: CaptureState, trigger: "machine" | "project" | "setup", unsafeRoots: readonly NativeRootKind[] = []): string {
  if (unsafeRoots.length) return `the ${cli} ${unsafeRoots.join(" and ")} root is an unsafe symlink and was skipped: use a directory inside HOME owned by this user without group or world write access, then rerun amem ingest ${cli}`;
  if (trigger === "setup") return cli === "claude" ? "run amem setup claude --apply to register the capture hooks" : `run amem setup ${cli} --apply, or amem ingest ${cli} by hand`;
  const where = trigger === "machine" ? "on this machine (all projects)" : "in this project (other projects could not be read)";
  if (registered && cli === "codex" && state === "never") return `the codex hook is registered but has never captured ${where}: approve it in Codex's /hooks trust review (setup never grants hook trust), then open a session`;
  return `the ${cli} ${registered ? "hook is registered but its capture" : "capture"} is ${state} ${where}: open a session${cli === "claude" ? "" : `, or run amem ingest ${cli}`}`;
}

/**
 * Per CLI: this project's state (its shard and aliases, as before) and a machine-wide state over every shard's capture.db (#510).
 * Both come from the same read-only aggregate in one walkShards pass; the machine-wide values are counts and times only, never another project's key, path or rows.
 * An other-shard database that is busy, missing rows table or unreadable makes the machine-wide state `unknown` (not `never`) and is not an error.
 */
function captureSection(options: DoctorOptions): Section {
  const keys = [options.project, ...options.aliases];
  const here: Tally = new Map(), machine: Tally = new Map();
  // Machine-wide means this machine: only capture directories named by this home's machine.json count, read without creating it.
  // Another machine's synced rows must not mask a stale local CLI (#510 AC2). No readable identity: the machine-wide state is unknown.
  const local = localMachineId(options.home);
  let readable = true, othersUnreadable = local === undefined;
  for (const shard of walkShards(options.home)) {
    const own = keys.includes(shard.key);
    for (const dir of shard.machineDirs) {
      const thisMachine = local !== undefined && basename(dir) === local;
      if (!own && !thisMachine) continue;
      const file = join(dir, "capture.db");
      if (!existsSync(file)) continue;
      let db: Database | undefined;
      try {
        db = new Database(file, { readonly: true }); db.run("PRAGMA busy_timeout = 1000");
        for (const row of db.query("SELECT agent, COUNT(*) AS n, MAX(at) AS last FROM rows GROUP BY agent").all() as { agent: string; n: number; last: string | null }[]) {
          if (thisMachine) tallyInto(machine, row);
          if (own) tallyInto(here, row);
        }
      } catch { if (own) readable = false; if (thisMachine) othersUnreadable = true; } finally { db?.close(); }
    }
  }
  const clis: Record<string, unknown> = {};
  const attention: string[] = [];
  for (const cli of CLIS) {
    const phase = receiptPhase(options.home, cli), registered = phase === "applied", entry = here.get(cli), wide = machine.get(cli);
    const last = entry?.last ?? null, state = stateOf(last, options.now);
    const wideLast = wide?.last ?? null, wideKnown = stateOf(wideLast, options.now);
    // A fresh row anywhere is definitive; stale or never is only known when every other shard was read.
    const machineState: MachineState = wideKnown === "fresh" || !othersUnreadable ? wideKnown : "unknown";
    // Attention follows the machine-wide state (#510): a registered hook not fresh anywhere, or any CLI whose capture went stale everywhere.
    // When that state is unknown, this project's state decides, as before. A CLI fresh elsewhere but absent here is reported, not flagged.
    const decided: CaptureState = machineState === "unknown" ? state : machineState, trigger = machineState === "unknown" ? "project" : "machine";
    const env = options.env ?? process.env;
    const unsafeRoots = registered && (cli === "codex" || cli === "kimi" || cli === "pi")
      ? nativeRoots(cli, env).filter(root => inspectNativeRoot(root.folder, env.HOME?.trim() || undefined).state === "unsafe").map(root => root.kind) : [];
    const needs = unsafeRoots.length > 0 || (registered ? decided !== "fresh" : decided === "stale");
    if (needs) attention.push(cli);
    const unusedHere = state !== "fresh" && machineState === "fresh";
    const hint = needs ? captureHint(cli, registered, decided, trigger, unsafeRoots) : !registered && decided === "never" ? captureHint(cli, registered, decided, "setup") : undefined;
    clis[cli] = { hook: registered ? "registered" : "manual", ...(registered ? { hookEvidence: "setup receipt" } : {}), ...(phase === "prepared" ? { setup: "prepared, not applied" } : {}), capture: state, lastCaptureAt: last, rows: entry?.rows ?? 0,
      machineCapture: machineState, machineLastCaptureAt: wideLast, machineRows: wide?.rows ?? 0, ...(unusedHere ? { note: "not used in this project" } : {}), ...(hint ? { hint } : {}) };
  }
  return { status: !readable ? "unavailable" : attention.length ? "attention" : "ok", ...(readable ? {} : { reason: "a capture database could not be read" }), clis };
}

/**
 * The SessionStart brief's size for this project: the brief the SessionStart worker builds (the native parent's deferred brief is smaller and is not what is measured).
 * It is built from the scratch copy of the curated logs and of the work logs; the capture section reads this machine's capture database read-only and only when it exists.
 */
async function briefSection(options: DoctorOptions, curated: MemoryStore | undefined, workBase: string | undefined, copyFailed: string | undefined): Promise<Section> {
  if (copyFailed) return unavailable(copyFailed);
  let configured: number | undefined;
  try { configured = loadAmemConfig(options.home, repoConfigRoot(options.cwd)).config.briefBytes; } catch { /* the policy section reports it */ }
  const budget = Math.min(DEFAULT_BRIEF_TOKENS, configured ?? Number.MAX_SAFE_INTEGER);
  try {
    const result = await sessionStartBrief({ cwd: options.cwd, base: options.home, project: options.project, now: () => options.now,
      measureOnly: { ...(curated ? { curated } : {}), ...(workBase ? { workBase } : {}) } });
    if (result.context === "") return unavailable("the brief is empty for this project (archived, forgotten or its binding changed)");
    const tight = result.tokens > budget * 0.9;
    return { status: result.partial || tight ? "attention" : "ok", tokens: result.tokens, budget, coverage: result.coverage,
      ...(result.partial ? { hint: "a section is partial or unavailable in the brief: see coverage" } : tight ? { hint: "the brief uses over 90% of its budget" } : {}) };
  } catch (error) { return unavailable(message(error)); }
}

function readersSection(options: DoctorOptions): Section {
  const dir = join(options.home, "readers");
  if (!existsSync(dir)) return { status: "ok", live: 0, stale: 0, unreadable: 0 };
  if (!regularDir(dir)) return unavailable("the readers directory is not a plain directory");
  let live = 0, stale = 0, unreadable = 0;
  try {
    for (const name of readdirSync(dir).filter(file => file.endsWith(".json")).sort()) {
      try {
        const stat = lstatSync(join(dir, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
        const value = JSON.parse(readFileSync(join(dir, name), "utf8")) as { pid?: unknown; signature?: unknown };
        const liveness = processLiveness(value.pid, typeof value.signature === "string" ? value.signature : undefined);
        if (liveness === "gone") stale++; else live++;
      } catch { unreadable++; }
    }
  } catch (error) { return unavailable(message(error)); }
  return { status: stale || unreadable ? "attention" : "ok", live, stale, unreadable, ...(stale || unreadable ? { hint: "a reader lease of a process that is gone is cleared by the next reader; an unreadable one needs a look" } : {}) };
}

/**
 * #551: what the next `amem sync` on this home would verify, reported as fixed data. Only a placement home gets the section,
 * so every other report (and its golden snapshot) is unchanged. A refusal names its category, cause class and remedy; a state
 * that could not be proven is `unavailable` with no category claimed, never a root reported as missing.
 */
async function writersSection(options: DoctorOptions): Promise<Section | undefined> {
  // #551: only a proven non-placement home omits the section. Markers that cannot be read or parsed prove nothing either
  // way, so they are reported as unverified rather than as a home that never activated placement sync.
  if (placementMarkerState(options.home) === "not placement") return undefined;
  const { placementWriterVerification } = await import("../sync-placement-writer-context.ts");
  const result = placementWriterVerification(options.home, fileURLToPath(new URL("../../", import.meta.url)));
  if (result.refusal) return { status: "attention", category: result.refusal.category, cause: result.refusal.causeClass, phase: result.refusal.phase, reason: result.refusal.message };
  if (result.unverified) return { status: "unavailable", reason: result.unverified };
  return { status: "ok", writers: result.writers };
}

function policySection(options: DoctorOptions): Section {
  try {
    const { config, source } = loadAmemConfig(options.home, repoConfigRoot(options.cwd));
    return { status: "ok", machine: source.machine, repo: source.repo, denyPaths: config.denyPaths.length, piiPatterns: config.piiPatterns.length,
      ...(config.briefBytes !== undefined ? { briefBytes: config.briefBytes } : {}), ...(config.excerptBytes !== undefined ? { excerptBytes: config.excerptBytes } : {}),
      ...(config.capturePaths !== undefined ? { capturePaths: config.capturePaths } : {}) };
  } catch (error) { return unavailable(message(error)); }
}

/** #132: capture rows hooks dropped, by reason, from the bounded rolling metrics tail (counts only; no row text is ever recorded there). */
function dropsSection(options: DoctorOptions): Section {
  const read = readCaptureDrops(options.home);
  if (!read.readable) return unavailable(read.reason);   // an existing file doctor cannot read is never a healthy zero
  // One torn line (an interrupted append) is reported, not fatal; a tail with lines of which none parses is a file doctor cannot decode.
  if (read.lines > 0 && read.malformedLines === read.lines) return unavailable("metrics.jsonl has no decodable record in its recent tail");
  const counts = read.counts, total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  return { status: total ? "attention" : "ok", window: "recent metrics tail", total, counts, ...(read.malformedLines ? { malformedLines: read.malformedLines } : {}),
    ...(total ? { hint: "capture rows were dropped recently (see counts by reason); amem doctor --json keeps the numbers" } : {}) };
}

/** Bounded read-only inventory and classification; no replay, claim or retirement. */
function spoolSection(options: DoctorOptions): Section {
  try {
    const inventory = readHookSpoolStatus(options.home);
    const tiers = [inventory.active, inventory.reserve];
    const full = tiers.some(tier => tier.files >= tier.maxFiles || tier.bytes >= tier.maxBytes);
    const near = tiers.some(tier => tier.files >= tier.maxFiles * 0.9 || tier.bytes >= tier.maxBytes * 0.9);
    return { ...inventory, status: !inventory.complete ? "unavailable" : full || near ? "attention" : "ok",
      coverage: inventory.complete ? "complete" : "partial",
      classificationCoverage: inventory.kinds.complete ? "complete" : "partial",
      fill: full ? "full" : near ? "nearly_full" : !inventory.complete ? "unknown" : tiers.some(tier => tier.files > 0) ? "pending" : "empty",
      ...(!inventory.complete ? { reason: "hook spool inventory is partial; reported file and byte counts are lower bounds" } : {}),
      ...(full || near ? { hint: "pending hook spool needs attention: capture can be dropped when both tiers fill; supported orphan recovery is pending" } : {}) };
  } catch { return unavailable("hook spool could not be read safely"); }
}

/** F16: which CLIs ingest at SessionEnd (setup receipts), and the person-owned sync cadence. amem registers no sync hook (a hook may not do network work). */
function cadenceSection(options: DoctorOptions): Section {
  const ingest: Record<string, string> = {};
  for (const cli of CLIS) ingest[cli] = receiptPhase(options.home, cli) === "applied" ? (cli === "claude" ? "hooks" : "session end") : "manual";
  const remote = remoteConfigured(options.home), state = usableState(readSyncState(options.home), options.now), next = nextSyncAt(state);
  const latest = readSyncStatus(options.home, options.now).operations
    .filter(op => op.state !== "running" && op.state !== "interrupted" && op.lastAliveUnixMs <= options.now)
    .sort((a, b) => b.lastAliveUnixMs - a.lastAliveUnixMs)[0];
  const lastOk = state.lastOkAt === null ? -Infinity : Date.parse(state.lastOkAt);
  const writerRefusal = latest?.state === "failed" && latest.lastAliveUnixMs > lastOk ? latest.writerRefusal : undefined;
  const command = options.syncCommand ?? "amem sync --if-due";
  const stale = remote && (state.lastOkAt === null || options.now - Date.parse(state.lastOkAt) > SYNC_STALE_MS || state.failures >= 3);
  const sync = { remote: remote ? "configured" : "none", lastAttemptAt: state.lastAttemptAt, lastOkAt: state.lastOkAt, failures: state.failures,
    nextAttemptAt: next === null ? null : new Date(next).toISOString(), due: remote ? syncDue(state, options.now) : false,
    ...(writerRefusal ? { writerRefusal } : {}),
    ...(remote ? { schedule: `run \`${command}\` from your own shell (for example a zshexit or bash EXIT trap): it needs a terminal like every mutating command; amem registers no sync hook and runs nothing between sessions` } : {}) };
  const manual = CLIS.filter(cli => ingest[cli] === "manual");
  return { status: stale || writerRefusal ? "attention" : "ok", ingest, ...(manual.length ? { manual } : {}), sync,
    ...(stale ? { hint: state.failures >= 3 ? "sync has failed repeatedly; amem sync --force shows why" : "no recent successful sync: run amem sync" } : {}) };
}

/**
 * Let the event loop run once. Doctor's stages are mostly synchronous (a git lookup is a `spawnSync`), and Bun runs a signal handler only when the loop turns: a signal that arrives
 * during a stalled call would otherwise wait for the end of doctor, where the handler is already removed and the signal is lost. Between stages this lets the handler act at once.
 * (Measured: with every tick removed a stalled git call loses the signal; removing any ONE tick does not, because other `await`s between stages turn the loop too. They are
 * redundant on purpose, so a later stage that stops awaiting cannot silently reopen the gap: `test/doctor.test.ts` stalls every git call, one at a time.)
 */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** `amem-doctor-<pid>-<random>`: the owner's pid is in the name so a later run can tell a leftover from a live run. */
const SCRATCH = /^amem-doctor-(\d+)-[A-Za-z0-9]{6}$/, OLD_SCRATCH = /^amem-doctor-[A-Za-z0-9]{6}$/;
const OLD_SCRATCH_AGE_MS = 24 * 3600_000;

/**
 * Remove scratch directories an earlier doctor left behind (it was killed by something no handler sees, or by a version that had none). A directory goes only when it is a plain
 * directory this user owns, named exactly as doctor names them, and its owner pid is gone: a live pid, or one that cannot be told, keeps its directory (a reused pid costs
 * a leftover, never a live run's data). A directory from before the pid was in the name has no owner to ask, so it goes only after a day. Returns how many were removed. Never throws.
 */
export function sweepStaleScratch(tmp: string = tmpdir(), alive: (pid: number) => boolean = pid => processLiveness(pid) !== "gone", now: number = Date.now(), uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined): number {
  let removed = 0;
  let names: string[] = [];
  try { names = readdirSync(tmp); } catch { return 0; }
  for (const name of names) {
    const owner = SCRATCH.exec(name), old = !owner && OLD_SCRATCH.test(name);
    if (!owner && !old) continue;
    try {
      const path = join(tmp, name), stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) continue;
      if (owner ? alive(Number(owner[1])) : now - stat.mtimeMs < OLD_SCRATCH_AGE_MS) continue;
      rmSync(path, { recursive: true, force: true }); removed++;
    } catch { /* gone already, or not ours to remove */ }
  }
  return removed;
}

/**
 * Keep doctor's scratch directory removed however this process ends while doctor runs. Install it first, then `adopt` the directory once `mkdtemp` has made it: a signal that
 * arrives in between meets a handler, which has nothing to remove yet but still ends the process with the signal. A handler cannot be left out of the picture: with one installed the
 * default action is suppressed, so after removing the directory it removes itself and re-raises the signal, which ends the process with the status the shell expects (and only when
 * no other handler of the host remains, so it never double-fires). An `exit` handler covers a throw. Everything is removed again by `release` once doctor finished normally.
 * SIGKILL cannot be handled by anyone: the next doctor's `sweepStaleScratch` removes that directory.
 */
function guardScratch(): { adopt: (dir: string) => void; release: () => void } {
  let dir: string | undefined;
  const remove = () => { if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  const handlers = STOP_SIGNALS.map(name => {
    const handler = () => {
      remove();
      process.off(name, handler);
      if (process.listenerCount(name) !== 0) return;       // another handler of the host remains: it decides how the process ends
      endLikeSignal(name);       // the signal itself again, so a parent sees `signalCode` (SIGQUIT exits 131 instead: see there)
    };
    process.on(name, handler);
    return [name, handler] as const;
  });
  process.on("exit", remove);
  return { adopt: made => { dir = made; }, release: () => { for (const [name, handler] of handlers) process.off(name, handler); process.off("exit", remove); } };
}

/**
 * Every git lookup doctor makes is a `spawnSync`, and a signal sent to doctor ALONE (`kill <pid>`; a terminal's Ctrl-C or closing window signals the whole group, and ends the stalled git
 * with it) is handled when the loop next turns. Without a limit a hung git held it for the call, and doctor makes a chain of them (measured: 20 s with 4 s calls). With this limit
 * a lone signal waits at most one call for the signal handler, which then removes the scratch copy and ends doctor.
 */
export const DOCTOR_GIT_TIMEOUT_MS = 5_000;
export function doctorReport(options: DoctorOptions): Promise<DoctorReport> {
  // Doctor reads every surface below, live or through a scratch copy: a floor on any of them refuses the whole report before anything is read (#199 AC5).
  for (const surface of ["curated", "capture", "candidates", "work-lists", "hook-spool"] as const) assertFormatFloor(options.home, surface);
  return withGitTimeout(DOCTOR_GIT_TIMEOUT_MS, async () => {
    const guard = guardScratch();
    try { return await withDoctorPlacementScratch(options.home, guard.adopt, scratch => runDoctor(options, scratch)); }
    finally { guard.release(); }
  });
}
async function runDoctor(options: DoctorOptions, scratch: string): Promise<DoctorReport> {
  let duplicates: Section, stale: Section, index: Section;
  let curated: MemoryStore | undefined, workBase: string | undefined, copyFailed: string | undefined;
  try {
    let layout: Layout | undefined;
    try { layout = layoutOf(options.home); } catch (error) { throw new Error(`the memory profile cannot be read: ${message(error)}`); }
    const refusal = placementRuntimeRefusal(options.home);
    if (refusal) throw Error(refusal);
    sweepStaleScratch();
    options.afterScratch?.(scratch);
    const budget = { bytes: 0 };
    try {
      // The work logs go to a private base of their own, whether or not the project has curated notes: the brief's work section opens a list read-write.
      workBase = join(scratch, "work-base"); copyWork(options, workBase, budget);
      if (!curatedPresent(options.home, options.project, layout)) {
        duplicates = stale = index = skipped("no curated notes for this project yet");
      } else {
        const home = join(scratch, "home");
        copyCurated(options, layout, home, budget);
        const snapshotted = layout === "shared-v1" && snapshotIndex(options.home, join(home, indexFileName(false)));
        curated = options.openCurated(home);
        const rows = curated.list({ project: options.project, limit: LIST_ALL });
        await tick();
        ({ duplicates, stale } = duplicatesAndStale(options, rows, curated));
        await tick();
        // The brief is measured after this and before the index proof's rebuild only because the brief reads rows, not the index tables.
        index = indexSection(curated, layout, snapshotted);
      }
    } catch (error) {
      copyFailed = error instanceof TooBig ? "the logs are over 64 MiB: the brief and the checks that need a copy were not run" : message(error);
      workBase = undefined; duplicates = stale = index = unavailable(copyFailed);
    }
  } catch (error) { copyFailed = message(error); duplicates = stale = index = unavailable(copyFailed); }
  await tick();
  let candidates: Section;
  try {
    const summary = pendingSummary(options.home, [options.project, ...options.aliases], options.now, true);
    candidates = summary === null ? unavailable("candidates.db exists but cannot be read")
      : { status: summary.dueWithin7Days ? "attention" : "ok", ...summary, ...(summary.dueWithin7Days ? { hint: "run amem review walk" } : {}) };
  } catch (error) { candidates = unavailable(message(error)); }
  let setup: Section;
  try { setup = { ...readSetupDrift({ home: options.home, ...(options.env ? { env: options.env } : {}), cwd: options.cwd }) }; }
  catch { setup = unavailable("setup registrations could not be checked"); }
  let sections: DoctorReport["sections"];
  try {
    await tick();
    const writers = await writersSection(options);
    sections = { duplicates, stale, candidates, capture: captureSection(options), brief: await briefSection(options, curated, workBase, copyFailed), index, readers: readersSection(options), policy: policySection(options), cadence: cadenceSection(options), drops: dropsSection(options), spool: spoolSection(options), setup, ...(writers ? { writers } : {}), ...maskedSection(curated), ...transitionSection(options) };
    await tick();   // a signal that arrived during the last synchronous stage is handled while the guard is still installed
  } finally { curated?.close(); }
  return { schema: DOCTOR_SCHEMA, status: worst(Object.values(sections).map(section => section.status)), home: { path: options.home, source: options.homeSource }, project: options.project, sections };
}
