import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { buildIntentBrief } from "./memory/intent-brief.ts";
import { proposeConsolidation } from "./memory/consolidate.ts";
import { createIntentBriefSource } from "./memory/recall.ts";
import { createRecallStalenessProbe } from "./memory/recall-staleness.ts";
import { recordMemoryUse } from "./memory/use-telemetry.ts";
import { DecayApplyError } from "./memory/decay-review.ts";
import { createMemoryMcp } from "./mcp-memory.ts";
import { serveMcp, writeConfirmed } from "./mcp.ts";
import { createStandalonePolicy } from "./memory/policy.ts";
import { configuredPolicy, configuredPolicyOptions, loadAmemConfig, repoConfigRoot } from "./memory/config.ts";
import { vaultCandidates } from "./memory/vault.ts";
import { importClaudeMemCapture, importClaudeMemWorkState } from "./memory/import.ts";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, looksSecret, machineId, openShardStore, type StoreOptions } from "./memory/store.ts";
import { rawMemoryCommand, rawGoalCommand } from "./memory/commands.ts";
import { memoryProjectKey } from "./memory/project.ts";
import { CandidateStore, candidateTargetRevision, type CandidateFilter } from "./memory/candidates.ts";
import { aliasedKeys, appendAlias, appendUnalias, listAliases, readShardedSelection, resolveAlias } from "./memory/shard.ts";
import { capacityReport, capacityText } from "./memory/capacity.ts";
import { readCaptureConfigFile, writeCaptureConfigFile, type CaptureConfig } from "./memory/capture.ts";

import { commandHelp, parseCommand } from "./commands-table.ts";
import { completionScript } from "./completion.ts";
import { memoryHome, resolveMemoryHome } from "./memory/home.ts";
import { realPath } from "./memory/platform.ts";
import { hashJSON, readSelector, resolveProfile } from "./memory/generation.ts";
import { migrate } from "./memory/migrate.ts";
import { migrateShards, shardMigrationStatus } from "./memory/shard-migration.ts";
import { applyPrune, planPrune, PRUNE_PLAN_MAX_BYTES } from "./memory/prune.ts";
import { readCatalogFresh } from "./memory/catalog.ts";
import { appendLifecycle, assertProjectActive, projectState } from "./memory/lifecycle.ts";
import { gcText, runGc } from "./memory/gc.ts";
import { usageReport, usageText } from "./memory/usage.ts";
import { exportProject, type ProjectExportFormat } from "./memory/project-export.ts";
import { importProject } from "./memory/project-import.ts";
import { importExternalMemory, type ExternalMemorySource } from "./memory/external-import.ts";
import { searchAllProjects, vaultCandidatesAll } from "./memory/cross-project.ts";
import { requireShard } from "./memory/curated-read.ts";
import { appendGitattributes, appendRepoLine, boundRepoRoot, planGitattributes, planRepoPromotion, readRepoScope, repoLogIgnored, repoLogPath, repoReadPolicy, repoVisibility, type RepoView } from "./memory/repo-scope.ts";
import type { Visibility } from "./memory/sync.ts";
import { applySplit, previewSplit } from "./memory/capacity-split.ts";
import { evalText, parseKs } from "./memory/eval.ts";
import { builtinSet, evalSeeded, evalStore, FIXTURE_PATH, readEvalSet } from "./memory/eval-fixture.ts";
import { markShown, pendingSummary } from "./memory/candidate-pending.ts";
import { buildNote, FAIL_TEMPLATE, hasFailLabel, noteAdd, parseFailTemplate, type FailFields } from "./memory/note-add.ts";
import { runEditor } from "./memory/editor.ts";
import { doctorReport, doctorText } from "./memory/doctor.ts";
import { endLikeSignal, nextSyncAt, readSyncState, recordSyncAttempt, remoteConfigured, syncDue, stopSignal, syncOutcome, usableState, SYNC_IF_DUE_DEADLINE_MS, type StopCause } from "./memory/sync-cadence.ts";

export const PERSON_ONLY = "amem is for the person: an agent reads memory through its `amem mcp` server (see `amem --help`); the person reviews what agents propose with `amem review`";
const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
export interface CliOutputReceipt { project: string; ids: readonly string[]; rendered(): boolean }
export interface CliContext {
  /** Prepared output metadata only. Invoke rendered only after the output writer succeeds. */
  onOutputReady?: (receipt: CliOutputReceipt) => void;
  cwd?: string; env?: Readonly<Record<string, string | undefined>>; stdinTTY?: boolean;
  /** Narrow seam for deterministic fixtures standing in for `gh` (#15 T4): the CLI always uses the native remote visibility check. */
  visibility?: (url: string) => Promise<Visibility>;
  /** Trusted isolated-HOME setup fixture; ordinary CLI use asks through its terminal. */
  setupConfirm?: (plan: import("./setup.ts").SetupPlan) => Promise<boolean>;
  /** Narrow seams for `amem note add` and `amem review walk`; each defaults to the real terminal. Fixtures stand in for the person at the keyboard. */
  prompt?: (question: string) => string | null | Promise<string | null>;
  /** Where `review walk` prints each candidate BEFORE it asks about it; defaults to stdout, which must then be a terminal. A fixture that supplies this stands in for the terminal. */
  write?: (text: string) => void;
  /** Whether stdout is a terminal, for the real stdout only (default `process.stdout.isTTY`). */
  stdoutTTY?: boolean;
  edit?: (initial: string) => string | Promise<string>;
  /** Test seam: the `sync --if-due` deadline in milliseconds (the CLI always uses 30 seconds). */
  syncDeadlineMs?: number;
  /** Called with the signal name when a person's signal ended `sync --if-due`, after its handlers are removed. `main` re-raises it once the output is written; absent, nothing happens. */
  onPersonStop?: (signal: string) => void;
  stdin?: () => string;
}

/** Candidate and note text came from an agent or the person, and goes to a terminal: flatten control characters (an ANSI escape included) and bound it. */
const terminalSafe = (value: string, max = 600): string => { const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/ {2,}/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max)}...` : flat; };
/** Every value given for a repeatable flag, in order (`parseCommand` keeps only the last). */
function repeated(argv: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === flag) { const value = argv[++i]; if (value !== undefined && !value.startsWith("--")) out.push(value); }
    else if (token.startsWith(`${flag}=`)) out.push(token.slice(flag.length + 1));
  }
  return out;
}
/** Narrow descriptor seam for deterministic race fixtures; the CLI always uses the native implementation. */
export interface PrunePlanFileIO {
  open(path: string, flags: number): number;
  stat(fd: number): { size: number; isFile(): boolean };
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}
const planFileIO: PrunePlanFileIO = {
  open: (path, flags) => openSync(path, flags), stat: fd => fstatSync(fd),
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position), close: fd => closeSync(fd),
};

/** Open once: pathname replacement cannot redirect the read and growth cannot exceed the fixed byte budget. */
export function readPrunePlanFile(path: string, io: PrunePlanFileIO = planFileIO): string {
  try {
    const fd = io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = io.stat(fd);
      if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > PRUNE_PLAN_MAX_BYTES) throw new Error();
      const data = Buffer.alloc(PRUNE_PLAN_MAX_BYTES + 1);
      let length = 0;
      while (length < data.length) {
        const n = io.read(fd, data, length, data.length - length, length);
        if (!Number.isSafeInteger(n) || n < 0 || n > data.length - length) throw new Error();
        if (n === 0) break;
        length += n;
      }
      if (length > PRUNE_PLAN_MAX_BYTES) throw new Error();
      const after = io.stat(fd);
      if (!after.isFile() || after.size !== before.size || length !== before.size) throw new Error();
      return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, length));
    } finally { io.close(fd); }
  } catch { throw new Error("prune plan unavailable or oversized"); }
}

/** Honest native-shell defaults, matching every marker detectCliIdentity treats as non-console (invalid included). */
export function agentMarked(env: Readonly<Record<string, string | undefined>>): boolean {
  return ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"].some(key => env[key] !== undefined);
}

function shardStatePresent(): boolean {
  try { lstatSync(join(memoryHome(), "shards.json")); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** `reconciled` (#27): the project filter also covers every key aliased to `project`; prune and other planners keep the exact key. */
function curatedStore(project: string, opts: StoreOptions, reconciled = true): MemoryStore {
  // #15 T5: the person's own project-local recall (search, list, show, graph, goals, prune) leaves an archived or forgotten project too, on a split home and on
  // an unsplit one alike. `search --all-projects --include-archived` and `project export` are the explicit ways to reach an archived project.
  assertProjectActive(memoryHome(), project);
  const aliases = reconciled ? aliasedKeys(memoryHome(), project) : [];
  const withAliases: StoreOptions = aliases.length ? { ...opts, reconcile: { canonical: project, aliases } } : opts;
  if (shardStatePresent()) {
    readShardedSelection(memoryHome());
    return openShardStore({ ...withAliases, project });
  }
  return new MemoryStore(withAliases);
}

/** The same store `curatedStore` opens, on another base: doctor's private scratch copy. No lifecycle gate here, the copy carries the home's lifecycle log and doctor read it already. */
function curatedStoreAt(base: string, project: string, opts: StoreOptions): MemoryStore {
  const aliases = aliasedKeys(base, project), withAliases: StoreOptions = aliases.length ? { ...opts, reconcile: { canonical: project, aliases } } : opts;
  if (existsSync(join(base, "shards.json"))) { readShardedSelection(base); return openShardStore({ ...withAliases, memoryDir: base, project }); }
  return new MemoryStore({ ...withAliases, memoryDir: base });
}

export async function runCli(argv: readonly string[], context: CliContext = {}): Promise<string> {
  if (argv.length === 1 && argv[0] === "mcp") {
    const memory = createMemoryMcp({ cwd: context.cwd ?? process.cwd(), base: memoryHome(context.env ?? process.env) });
    await serveMcp({ tools: memory.tools, close: memory.close, onEmitted: memory.onEmitted, version: VERSION });
    return "";
  }
  if (argv[0] === "hook") {
    const { hookMain } = await import("./hooks.ts");
    return hookMain(argv.slice(1));
  }
  if (argv[0] === "ingest") {
    // Capture-only native intake: no project/home override, policy bypass or curated write capability.
    const parsed = parseCommand(argv);
    if (parsed.options["--help"] === true) return commandHelp();
    const kind = parsed.positionals[0];
    if (parsed.positionals.length !== 1 || !["codex", "kimi", "pi", "qwen"].includes(kind ?? "")) throw new Error("usage: amem ingest codex|kimi|pi|qwen [--since ISO] [--json]");
    const { ingestTranscript } = await import("./ingest.ts");
    return JSON.stringify(await ingestTranscript(kind as "codex" | "kimi" | "pi" | "qwen", {
      cwd: context.cwd ?? process.cwd(), base: memoryHome(context.env ?? process.env),
      ...(typeof parsed.options["--since"] === "string" ? { since: parsed.options["--since"] as string } : {}),
    }));
  }
  // F1: `--help` and `--version` only print text, so they work in an agent shell too. Every other command keeps the honest-session refusal below.
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "version")) return `amem ${VERSION}`;
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) return commandHelp();
  if (agentMarked(context.env ?? process.env)) throw new Error(PERSON_ONLY);
  if (argv[0] === "--version" || argv[0] === "version") return `amem ${VERSION}`;
  if (argv[0] === "--help" || argv[0] === "help" || argv.includes("--help")) return commandHelp();
  let parsed;
  try {
    parsed = parseCommand(argv);
    if (parsed.path[0] === "version") return `amem ${VERSION}`;
    if (parsed.path[0] === "completion") {
      if (parsed.positionals.length !== 1) throw new Error("usage: amem completion zsh|bash|fish");
      return completionScript(parsed.positionals[0]!);
    }
  } catch (error) {
    if (argv.find(arg => !arg.startsWith("--")) === "completion") Object.assign(error as Error, { exitCode: 2 });
    throw error;
  }
  const { definition, options, rawArgs: args } = parsed;
  if (parsed.path[0] === "setup") {
    if (parsed.positionals.length !== 1 || options["--apply"] === true && options["--undo"] === true) throw new Error("usage: amem setup claude|codex|kimi|pi|qwen|jcode|agy|all [--apply|--undo]");
    const { runSetup } = await import("./setup.ts");
    return runSetup(parsed.positionals[0]!, options["--apply"] === true ? "apply" : options["--undo"] === true ? "undo" : "preview", {
      env: context.env ?? process.env, stdinTTY: context.stdinTTY ?? process.stdin.isTTY, cwd: context.cwd ?? process.cwd(),
      ...(context.setupConfirm ? { confirm: context.setupConfirm } : {}),
    });
  }
  const goal = parsed.path[0] === "goal", review = parsed.path[0] === "review", sub = goal || review ? parsed.path[1]! : parsed.path[0]!;
  const policyFree = options["--policy-free"] === true;
  const mutating = definition.mutates === true || definition.mutates === "apply" && options["--apply"] === true || definition.mutates === "label" && options["--label"] !== undefined
    || definition.mutates === "confirm" && options["--confirm"] === true;
  if (mutating && !(context.stdinTTY ?? process.stdin.isTTY)) throw new Error("mutating commands require a terminal on stdin");
  // F4: the configured policy (the machine's `amem.config.json`, narrowed by the repository's `.amem/config`) applies to every command that used to need
  // `--policy-free`. The flag is still accepted and means nothing more, so existing scripts keep working.
  const policyCwd = context.cwd ?? process.cwd();
  const policyOf = () => configuredPolicy(memoryHome(), policyCwd);   // the same home every other command here resolves
  let canonicalProject: string | undefined;
  const boundProject = () => canonicalProject ??= resolveAlias(memoryHome(), memoryProjectKey(context.cwd ?? process.cwd()));
  const commandBinding = (home: string, project: string): (() => void) => {
    const base = realPath(home), selector = readSelector(base).revision, aliases = aliasedKeys(base, project).join("\n");
    const split = shardStatePresent(), shards = split ? JSON.stringify(readShardedSelection(base)) : undefined;
    return () => {
      const currentSplit = shardStatePresent();
      if (realPath(memoryHome()) !== base || resolveAlias(base, memoryProjectKey(policyCwd)) !== project || readSelector(base).revision !== selector || aliasedKeys(base, project).join("\n") !== aliases || projectState(base, project) !== "active" || split !== currentSplit || split && JSON.stringify(readShardedSelection(base)) !== shards) throw new Error("memory command binding changed since preview");
    };
  };
  const outputReady = (ids: readonly string[], project = boundProject()) => {
    if (!context.onOutputReady || !ids.length) return;
    const base = realPath(memoryHome()), assertCurrent = commandBinding(base, project), deliveryId = `cli:${randomUUID()}`, selected = [...new Set(ids)].slice(0, 256);
    context.onOutputReady({ project, ids: selected, rendered: () => {
      let candidates: CandidateStore | undefined;
      try { assertCurrent(); candidates = new CandidateStore({ memoryDir: base }); let known = true;
        for (const entryId of selected) known = recordMemoryUse(candidates, { project, entryId, deliveryId }, { rendered: 1 }, { assertCurrent }) && known;
        return known;
      } catch { return false; } finally { try { candidates?.close(); } catch { /* optional telemetry cannot fail emitted output */ } }
    } });
  };
  if (sub === "consolidate") {
    const requested = typeof options["--project"] === "string" ? options["--project"] as string : boundProject();
    if (!requested.trim() || requested.length > 400 || requested.includes("\0")) throw Error("invalid consolidation project");
    const base = memoryHome(), project = resolveAlias(base, requested), aliases = aliasedKeys(base, project);
    // The policy below is narrowed by the repository around the working directory, which is the bound project's. Another project's own repository policy cannot be resolved from here, so screening it with this one would apply the wrong narrowing.
    if (project !== boundProject()) throw Error("consolidate --project must name the current project; run it from the other project's directory to consolidate that one");
    assertProjectActive(base, project);
    const store = curatedStore(project, { deferPromotions: true, screen: () => "keep" });
    let candidates: CandidateStore | undefined;
    try {
      const binding = commandBinding(store.profile.home, boundProject()), policyKey = () => JSON.stringify(configuredPolicyOptions(base, policyCwd));
      const assertCurrent = () => { binding(); assertProjectActive(base, project); if (resolveAlias(base, requested) !== project || aliasedKeys(base, project).join("\n") !== aliases.join("\n")) throw Error("consolidation project binding changed"); };
      candidates = new CandidateStore({ memoryDir: base, reconcile: { canonical: project, aliases } });
      const report = await proposeConsolidation(store, candidates, { project, actor: "person", policy: policyOf, policyVersion: policyKey, assertCurrent });
      return options["--json"] ? JSON.stringify(report, null, 2) : `${report.candidates.length} consolidation candidates queued for amem review; no curated notes changed${report.alreadyReviewed ? `; ${report.alreadyReviewed} already reviewed` : ""}${report.truncated ? "; scan truncated" : ""}${report.oversized ? `; ${report.oversized} proposals too large` : ""}${report.localExcluded ? `; ${report.localExcluded} local sources excluded` : ""}`;
    } finally { candidates?.close(); store.close(); }
  }
  if (sub === "brief") {
    const intent = options["--for"]; if (typeof intent !== "string" || !intent.trim() || intent.length > 1000 || parsed.positionals.length) throw Error("usage: amem brief --for <intent> [--paths <path>] [--symbols <symbol>] [--bytes N] [--json]");
    const rawBytes = options["--bytes"];
    if (rawBytes !== undefined && !/^[1-9][0-9]*$/.test(String(rawBytes))) throw Error("brief bytes must be a positive decimal integer");
    const maxBytes = rawBytes === undefined ? 2048 : Number(rawBytes); if (!Number.isSafeInteger(maxBytes) || maxBytes > 8192) throw Error("brief bytes must be 1..8192");
    const project = boundProject(), base = realPath(memoryHome()), paths = repeated(argv, "--paths"), symbols = repeated(argv, "--symbols");
    if (paths.length > 150 || symbols.length > 150 || [...paths, ...symbols].some(value => value.length > 512)) throw Error("brief paths and symbols exceed the input bound");
    const store = curatedStore(project, { deferPromotions: true });
    try {
      const assertCurrent = commandBinding(base, project), repository = boundRepoRoot(policyCwd, base, project), root = repository ?? policyCwd;
      const rootConfirmed = repository !== undefined || project.startsWith("local:") && resolveAlias(base, memoryProjectKey(policyCwd)) === project;
      const settings = () => configuredPolicyOptions(base, policyCwd), policyKey = () => hashJSON(settings()), revision = policyKey(), snapshot = createStandalonePolicy(settings());
      const policy = () => snapshot, policyVersion = () => policyKey();
      if (policyVersion() !== revision) throw Error("brief policy changed before read");
      const result = await buildIntentBrief(createIntentBriefSource(store, project),
        { project, cwd: root, repo: project, intent, paths, symbols, maxBytes, policy, policyVersion, assertCurrent, now: () => store.readNow(), stale: createRecallStalenessProbe({ cwd: root, rootConfirmed, policy }) });
      assertCurrent(); outputReady(result.items.map(view => view.id), project);
      return options["--json"] ? JSON.stringify({ brief: result.text, bytes: result.bytes, truncated: result.truncated, state: result.state }, null, 2) : result.text;
    } finally { store.close(); }
  }
  if ((options["--history"] === true || options["--as-of"] !== undefined) && (options["--all-projects"] === true || options["--tier"] === "repo")) throw Error("historical recall selects this active project's curated store; cross-project/repo history is unavailable");
  if (sub === "migrate") {
    const modes = ["--dry-run", "--resume", "--deactivate"].filter(key => options[key] === true);
    if (modes.length > 1) throw new Error("migration modes are mutually exclusive");
    const mode = options["--dry-run"] ? "dry-run" : options["--resume"] ? "resume" : options["--deactivate"] ? "deactivate" : "apply";
    const common = { memoryDir: memoryHome(), ...(options["--generation"] ? { generation: String(options["--generation"]) } : {}), authorizedPerson: true, tty: true };
    const shardRequested = options["--shards"] === true || (mode === "resume" && shardStatePresent());
    if (shardRequested) {
      if (mode === "deactivate") throw new Error("--deactivate is not a shard migration mode");
      return JSON.stringify(await migrateShards({ ...common, mode }), null, 2);
    }
    return JSON.stringify(await migrate({ ...common, mode }), null, 2);
  }
  if (sub === "status") {
    // F1: say where the memory lives and which configuration is in effect. The migration fields keep their names and shape; `home` and `config` are added.
    const where = resolveMemoryHome(), loaded = loadAmemConfig(where.home, repoConfigRoot(policyCwd));
    const { config, source } = loaded;
    return JSON.stringify({ home: { path: where.home, source: where.source },
      config: { machine: source.machine, repo: source.repo, denyPaths: config.denyPaths.length, piiPatterns: config.piiPatterns.length,
        ...(config.briefBytes !== undefined ? { briefBytes: config.briefBytes } : {}), ...(config.excerptBytes !== undefined ? { excerptBytes: config.excerptBytes } : {}),
        ...(config.capturePaths !== undefined ? { capturePaths: config.capturePaths } : {}), ...(Object.keys(config.capture).length ? { capture: config.capture } : {}) },
      // F7: pending candidates, and a warning when any is within 7 days of its age expiry (a shown one is then deleted after its grace period; an unshown one is kept until it is shown).
      candidates: (() => { const bound = boundProject(), summary = pendingSummary(where.home, [bound, ...aliasedKeys(where.home, bound)], Date.now(), true);
        if (summary === null) return { unavailable: "candidates.db exists but cannot be read" };
        return { ...summary, ...(summary.dueWithin7Days ? { warning: `${summary.dueWithin7Days} candidate${summary.dueWithin7Days === 1 ? "" : "s"} within 7 days of expiry: run \`amem review walk\`` } : {}) }; })(),
      ...shardMigrationStatus(where.home) }, null, 2);
  }
  if (sub === "doctor") {
    // F15: one read-only report; see src/memory/doctor.ts for exactly what "read-only" covers.
    const where = resolveMemoryHome(), project = boundProject();
    const report = await doctorReport({ home: where.home, homeSource: where.source, cwd: policyCwd, project, aliases: aliasedKeys(where.home, project), now: Date.now(),
      openCurated: base => curatedStoreAt(base, project, { deferPromotions: true }) });
    return options["--json"] ? JSON.stringify(report, null, 2) : doctorText(report);
  }
  if (sub === "prune") {
    const applying = options["--apply"] === true;
    if (applying ? options["--dry-run"] || options["--cutoff"] || !options["--plan"] : !options["--dry-run"] || !options["--cutoff"] || options["--plan"]) throw new Error("usage: amem prune [--user] --cutoff <UTC> --dry-run | [--user] --apply --plan <file>");
    let input: string | undefined;
    if (applying) {
      input = readPrunePlanFile(String(options["--plan"]));
    }
    const project = boundProject();
    if (options["--user"] === true) {
      if (!shardStatePresent()) throw new Error("prune --user requires an active curated shard migration; the default prune command selects the current project");
      readShardedSelection(memoryHome());
    }
    const store = options["--user"] === true
      ? openShardStore({ memoryDir: memoryHome(), user: true, deferPromotions: true })
      : curatedStore(project, { deferPromotions: true }, false);
    try {
      const auth = { project, actor: "person" as const, authorize: () => true };
      return JSON.stringify(applying ? applyPrune(store.prunePort(), input, auth) : planPrune(store.prunePort(), { cutoff: String(options["--cutoff"]) }, auth), null, 2);
    } finally { store.close(); }
  }
  if (sub === "decay") {
    const applying = options["--apply"] === true;
    if (applying && context.write === undefined && !(context.stdoutTTY ?? process.stdout.isTTY)) throw new Error("decay apply shows a revision preview before confirmation, so stdout must be a terminal");
    const { decayPreview, applyDecay, readDecayCounters, DECAY_DEFAULT_DAYS, assertExactDecayForget } = await import("./memory/decay-review.ts");
    const project = boundProject(), base = memoryHome(), aliases = aliasedKeys(base, project);
    const store = curatedStore(project, { deferPromotions: true, screen: note => policyOf().screenStandalone(note) ? "promote" : "keep" });
    try {
      const assertCurrent = commandBinding(store.profile.home, project);
      const selected = parsed.positionals.length ? parsed.positionals : undefined;
      if (options["--days"] !== undefined && !/^[1-9][0-9]*$/.test(String(options["--days"]))) throw new Error("decay days must be a positive decimal integer");
      const days = options["--days"] === undefined ? DECAY_DEFAULT_DAYS : Number(options["--days"]);
      const settings = { days, ...(selected ? { ids: selected } : {}), aliases, counters: () => readDecayCounters(base, [project, ...aliases]) };
      const current = { ...settings, screen: (note: import("./memory/store.ts").View) => policyOf().screenStandalone(note), assertCurrent };
      const preview = decayPreview(store, project, current), action = options["--forget"] === true ? "FORGET" : "demote";
      const display = [`${action} preview: ${preview.entries.length} notes older than ${days} days; citation history unknown (${preview.citedExemptions ?? "unknown"} observed retained-positive exemptions)${preview.truncated ? "; truncated" : ""}`,
        ...preview.entries.map(entry => `${entry.target.id}  revision ${entry.target.revision}  ${entry.view.at}  ${entry.view.kind}: ${terminalSafe(entry.view.title ?? entry.view.text)}`)].join("\n");
      if (!applying) return options["--json"] ? JSON.stringify(preview, null, 2) : display;
      if (!preview.entries.length) return options["--json"] ? JSON.stringify({ action, ids: [] }) : "no eligible notes to apply";
      if (options["--forget"] === true) assertExactDecayForget(store, preview.entries.map(entry => entry.target.id), project);
      const write = context.write ?? ((text: string) => { process.stdout.write(`${text}\n`); }); write(display);
      const ask = context.prompt ?? ((question: string) => prompt(question));
      const answer = await ask(`Type yes to ${action} these ${preview.entries.length} exact entries${options["--forget"] ? " permanently (hidden claude-mem-imported copies require separate review; expanded groups are refused)" : ` into the short tier, expires ${preview.demoteExpiresAt}`}: `);
      if (answer?.trim() !== "yes") return options["--json"] ? JSON.stringify({ cancelled: true }) : "decay apply cancelled";
      assertCurrent();
      const result = applyDecay(store, preview, { ...current, actor: "person", confirmed: true, forget: options["--forget"] === true });
      return options["--json"] ? JSON.stringify(result, null, 2) : `${result.action}: ${result.ids.length} entries${result.expiresAt ? `; expires ${result.expiresAt}` : ""}`;
    } catch (error) { if (error instanceof DecayApplyError) error.jsonOutput = options["--json"] === true; throw error; }
    finally { store.close(); }
  }
  if (sub === "note") {
    // F6: the person writes a curated note. Person-only (the agent-marker refusal and the terminal requirement above already ran, because `note add` mutates).
    const env = context.env ?? process.env, edit = context.edit ?? ((initial: string) => runEditor(env, initial));
    const kind = (options["--kind"] ?? "finding") as Parameters<typeof buildNote>[0]["kind"];
    const fail: Partial<FailFields> = { ...(typeof options["--approach"] === "string" ? { approach: options["--approach"] } : {}), ...(typeof options["--symptom"] === "string" ? { symptom: options["--symptom"] } : {}),
      ...(typeof options["--cause"] === "string" ? { cause: options["--cause"] } : {}), ...(typeof options["--retry-when"] === "string" ? { retryWhen: options["--retry-when"] } : {}) };
    const evidence = repeated(argv, "--evidence"); if (evidence.length) fail.evidence = evidence;
    let text: string | undefined = parsed.positionals.join(" ");
    if (text === "-") text = (context.stdin ?? (() => readFileSync(0, "utf8")))();
    else if (!text.trim()) {
      text = undefined;
      // No text: a fail note with no field given opens the labelled template, any other note opens an empty file.
      if (kind === "fail" && !Object.keys(fail).length) Object.assign(fail, parseFailTemplate(await edit(FAIL_TEMPLATE)));
      else if (kind !== "fail") text = await edit("");
    }
    const project = boundProject(), policy = policyOf();
    const store = curatedStore(project, { deferPromotions: true, screen: note => policy.screenStandalone(note) ? "promote" : "keep" });
    try {
      const { id } = noteAdd(store, project, { kind, tier: (options["--tier"] ?? "long") as "short" | "long", scope: (options["--scope"] ?? "project") as "project" | "shared",
        ...(text !== undefined ? { text } : {}), ...(typeof options["--title"] === "string" ? { title: options["--title"] } : {}), ...(Object.keys(fail).length ? { fail } : {}) }, policy);
      return options["--json"] ? JSON.stringify({ id, kind }, null, 2) : `added ${kind} note ${id}`;
    } finally { store.close(); }
  }
  if (review) {
    const id = parsed.positionals[0];
    if (sub !== "list" && sub !== "walk" && (!id || !/^[a-f0-9]{64}$/.test(id))) throw new Error("review accept/reject requires a full 64-character candidate id");
    const project = boundProject(), aliases = aliasedKeys(memoryHome(), project), candidates = new CandidateStore(aliases.length ? { reconcile: { canonical: project, aliases } } : {});
    try {
      if (sub === "walk") {
        // F7 / AC4: each candidate is stamped shown as it is put in front of the person, then accepted, edited (written as the person's own note and the candidate closed), rejected or skipped.
        // The candidate is WRITTEN to the terminal before the question, and stamped shown only after that write succeeded: a person who answers a/e/r must have seen what it is, and a Ctrl-C
        // or a closed pipe before the print leaves nothing stamped. Each outcome is written as it happens, so an interrupted walk still shows what it did.
        // The walk asks accept, edit or reject questions, so what it prints must reach a person: with stdout redirected to a file or a pipe nobody sees the candidate, and stamping it shown
        // would start the 7-day clock for something unread. Refused before anything is read or stamped. (A caller-supplied `write` is a fixture standing in for the terminal.)
        if (context.write === undefined && !(context.stdoutTTY ?? process.stdout.isTTY)) throw new Error("review walk prints each candidate and asks about it, so stdout must be a terminal (not redirected to a file or a pipe)");
        const write = context.write ?? ((text: string) => { process.stdout.write(`${text}\n`); });
        const ask = context.prompt ?? ((question: string) => prompt(question)), scope = [project, ...aliases], base = realPath(candidates.dir), assertWalkCurrent = commandBinding(candidates.dir, project);
        // Oldest first: those are the ones nearest their expiry (`list` is newest first).
        const rows = candidates.list({ project, status: "pending", ...(options["--kind"] ? { kind: options["--kind"] as CandidateFilter["kind"] } : {}) }).reverse();
        if (!rows.length) return "no candidates pending";
        const done = { accepted: 0, edited: 0, rejected: 0, skipped: 0, failed: 0 };
        const lines = { push: (...texts: string[]) => { for (const text of texts) write(text); return 0; } };
        const body = (candidate: (typeof rows)[number]): string => { const input = candidate.input;
          if (input.kind === "promotion") {
            const viewStore = curatedStore(project, { deferPromotions: true, screen: () => "skip" });
            try {
              const target = viewStore.get(input.target.id, project);
              return target && target.id === input.target.id && candidateTargetRevision(target) === input.target.revision
                ? `promotion. Goal goal:${input.goalId}, mem:${target.id}. ${target.title ? `${target.title}: ` : ""}${target.text}`
                : `promotion. Goal goal:${input.goalId}, target mem:${input.target.id} changed or is unavailable; reject or skip`;
            } finally { viewStore.close(); }
          }
          if (input.kind === "model-answer") return `Model answer (not evidence; cannot accept, author an independent note with amem note add). ${input.text}`;
          if (input.kind === "consolidation") return `${input.action}. Sources: ${input.targets.map(target => `mem:${target.id}`).join(", ")}. ${input.text}`;
          return input.kind === "memory" ? `${input.title ? `${input.title}: ` : ""}${input.text}` : input.kind === "fail" ? `fail. Approach: ${input.approach} Symptom: ${input.symptom} Cause: ${input.cause} Retry when: ${input.retryWhen}`
            : input.kind === "correction" ? `correction. ${input.proposedText} Reason: ${input.reason}` : `decay. ${input.reason}`; };
        const step = async (args: string[]) => { try { await runCli(args, context); return true; } catch (error) { lines.push(`  ${(error as Error).message.split("\n")[0]}`); done.failed++; return false; } };
        for (const [index, candidate] of rows.entries()) {
          assertWalkCurrent();
          lines.push(`${index + 1}/${rows.length}  ${candidate.id.slice(0, 12)}  ${candidate.input.kind}  ${candidate.createdAt.slice(0, 10)}`, `  ${terminalSafe(body(candidate))}`);
          assertWalkCurrent();
          markShown(base, scope, Date.now(), [candidate.id]);     // after the write: shown means the person could read it
          const answer = ((await ask("[a]ccept [e]dit [r]eject [s]kip [q]uit: ")) ?? "q").trim().toLowerCase()[0] ?? "s";
          assertWalkCurrent();
          if (answer === "q") break;
          if (answer === "a") { if (await step(["review", "accept", candidate.id, ...(candidate.input.kind === "memory" ? ["--kind", "memory"] : []), "--json"])) done.accepted++; }
          else if (answer === "r") { if (await step(["review", "reject", candidate.id])) done.rejected++; }
          else if (answer === "e") {
            const input = candidate.input;
            if (input.kind !== "memory" && input.kind !== "fail") { lines.push("  edit is for memory and fail candidates; accept, reject or skip this one"); done.failed++; continue; }
            const edit = context.edit ?? ((initial: string) => runEditor(context.env ?? process.env, initial));
            // A memory candidate proposed as a fail note opens the template (its own text pre-filled under Approach when it is not already labelled), so the person can structure it.
            const first = input.kind === "fail" ? `Approach: ${input.approach}\nSymptom: ${input.symptom}\nCause: ${input.cause}\nEvidence: ${input.evidenceRefs.join(", ")}\nRetry when: ${input.retryWhen}\n`
              : input.noteKind === "fail" && !hasFailLabel(input.text) ? `Approach: ${input.text}\nSymptom: \nCause: \nEvidence: \nRetry when: \n` : input.text;
            try {
              const edited = await edit(first); assertWalkCurrent(); const standalone = policyOf(), store = curatedStore(project, { deferPromotions: true, screen: note => standalone.screenStandalone(note) ? "promote" : "keep" });
              // A fail candidate, and a general memory candidate proposed as a fail note, are both written as a structured fail note from the labelled body the person edited.
              const asFail = input.kind === "fail" || input.noteKind === "fail";
              try { noteAdd(store, project, asFail ? { kind: "fail", tier: "long", scope: "project", fail: parseFailTemplate(edited), ...(input.kind === "memory" && input.title ? { title: input.title } : {}) } : { kind: input.kind === "memory" ? input.noteKind ?? "finding" : "finding", tier: "long", scope: "project", text: edited, ...(input.kind === "memory" && input.title ? { title: input.title } : {}) }, standalone); }
              finally { store.close(); }
              candidates.reject(candidate.id, { project, actor: "person", verdict: "public" }); done.edited++;
            } catch (error) { lines.push(`  ${(error as Error).message.split("\n")[0]}`); done.failed++; }
          } else done.skipped++;
        }
        return `accepted ${done.accepted}, edited ${done.edited}, rejected ${done.rejected}, skipped ${done.skipped}, failed ${done.failed}`;
      }
      if (sub === "list") {
        const rows = candidates.list({ project, ...(options["--status"] ? { status: options["--status"] as CandidateFilter["status"] } : {}),
          ...(options["--kind"] ? { kind: options["--kind"] as CandidateFilter["kind"] } : {}), ...(options["--limit"] ? { limit: Number(options["--limit"]) } : {}) });
        // AC4, "shown" means the person read the candidate's content, and the list cannot know that: it prints an id, a kind and a date (no content), it is run by scripts and cron, and
        // `--json` may be piped to a program. So `review list` stamps nothing, exactly like the hook; only `review walk`, which prints each candidate before it asks, does.
        return options["--json"] ? JSON.stringify(rows, null, 2) : rows.length ? rows.map(candidate => `${candidate.id}  ${candidate.input.kind}  ${candidate.status}  ${candidate.createdAt}`).join("\n") : "no candidates waiting for review";
      }
      if (sub === "reject") {
        candidates.reject(id!, { project, actor: "person", verdict: "public" });
        return options["--json"] ? JSON.stringify({ candidateId: id, status: "rejected" }, null, 2) : `rejected candidate ${id}`;
      }
      const candidate = candidates.get(id!, project);
      if (!candidate) throw new Error("candidate unavailable");
      if (options["--kind"] !== undefined && candidate.input.kind !== options["--kind"]) throw new Error("candidate kind does not match --kind");
      if (candidate.input.kind === "decay") throw new Error("decay candidates are listing-only; use `amem demote` or `amem forget` after review");
      const store = curatedStore(project, { deferPromotions: true, screen: note => policyOf().screenStandalone(note) ? "promote" : "keep" });
      try {
        const assertCurrent = commandBinding(store.profile.home, project);
        if (!await policyOf().screen(candidate.input)) throw new Error("candidate refused by the current standalone privacy policy (secrets, personal data, deny paths and the patterns in amem.config.json)");
        assertCurrent();
        const result = candidates.accept(id!, { project, actor: "person", verdict: "public", store,
          policyVersion: () => JSON.stringify(configuredPolicyOptions(realPath(store.profile.home), policyCwd)),
          policy: (proposal, target, note, goal) => { assertCurrent(); return policyOf().screenStandalone({ ...proposal.input, ...(target ? { targetView: target } : {}), note, ...(goal ? { goalView: goal } : {}) }); },
        });
        return options["--json"] ? JSON.stringify(result, null, 2) : `accepted candidate ${id} as ${candidate.input.kind === "promotion" ? "promoted" : "ordinary"} note ${result.noteId}`;
      } finally { store.close(); }
    } finally { candidates.close(); }
  }
  if (sub === "vault-candidates" && (options["--all-projects"] === true || options["--project"] !== undefined)) {
    if (options["--all-projects"] === true && options["--project"] !== undefined) throw new Error("choose either --all-projects or --project <key>, not both");
    const result = await vaultCandidatesAll(memoryHome(), { policy: policyOf(), ...(options["--project"] !== undefined ? { project: resolveAlias(memoryHome(), String(options["--project"])) } : {}), ...(options["--limit"] ? { limit: Number(options["--limit"]) } : {}) });
    return JSON.stringify(result, null, 2);
  }
  if (sub === "vault-candidates") {
    const project = boundProject(), store = curatedStore(project, { deferPromotions: true });
    try {
      const result = await vaultCandidates(store, { project, policy: policyOf(), ...(options["--limit"] ? { limit: Number(options["--limit"]) } : {}) });
      return JSON.stringify(result, null, 2);
    } finally { store.close(); }
  }
  if (sub === "eval") {
    // F13: read-only. A set with entries is scored against a throwaway store seeded with them (touches no memory home); one without scores the bound project's real entries.
    const ks = parseKs(typeof options["--k"] === "string" ? options["--k"] : undefined);
    const file = typeof options["--set"] === "string" ? options["--set"] : undefined;
    const builtin = file === undefined ? undefined : builtinSet(file);
    const set = readEvalSet(builtin ?? file ?? FIXTURE_PATH);
    let report;
    if (set.entries?.length) report = evalSeeded(set, ks);
    else {
      const project = boundProject(), store = curatedStore(project, { deferPromotions: true });
      try { report = evalStore(store, project, set, ks); } finally { store.close(); }
    }
    return options["--json"] ? JSON.stringify(report, null, 2) : evalText(report, builtin ? `built-in fixture ${file}` : file ?? "built-in fixture");
  }
  if (sub === "capacity") {
    const share = options["--disk-share"];
    if (share !== undefined && (!Number.isFinite(Number(share)) || Number(share) <= 0 || Number(share) > 1)) throw new Error("--disk-share must be a number in (0, 1]");
    const report = capacityReport({ ...(share !== undefined ? { diskShare: Number(share) } : {}) });
    if (parsed.path[1] !== "apply") return options["--json"] ? JSON.stringify(report, null, 2) : capacityText(report);
    if (options["--split"] === true) {
      // #15 D7: each shard's own share of the global budget, written to its own config. The same two steps as the home default below, bound to the shards it was made for.
      if (options["--cap-mb"] !== undefined || options["--retention-days"] !== undefined) throw new Error("--split computes each shard's values; do not combine it with --cap-mb or --retention-days");
      const diskShare = share !== undefined ? { diskShare: Number(share) } : {};
      return JSON.stringify(options["--confirm"] === true ? applySplit(memoryHome(), diskShare) : previewSplit(memoryHome(), diskShare), null, 2);
    }
    // Person-only (agent marker and TTY are refused above): preview first, --confirm writes the home default config.
    const file = join(memoryHome(), "capture-config.json");
    const target: CaptureConfig = {
      capMb: options["--cap-mb"] ? Number(options["--cap-mb"]) : report.proposal.capMb,
      retentionDays: options["--retention-days"] ? Number(options["--retention-days"]) : report.proposal.retentionDays,
    };
    if (!Number.isFinite(target.capMb) || target.capMb <= 0 || !Number.isFinite(target.retentionDays) || target.retentionDays <= 0) throw new Error("capacity apply needs positive --cap-mb and --retention-days");
    const preview = { file, current: readCaptureConfigFile(file), target, reason: report.proposal.reason };
    const previewFile = join(memoryHome(), "capture-config.preview.json");
    if (options["--confirm"] !== true) {
      writeFileSync(previewFile, JSON.stringify(preview) + "\n", { mode: 0o600 });
      return JSON.stringify({ preview, confirm: "re-run with --confirm to write" }, null, 2);
    }
    let approved: { file?: string; current?: unknown; target?: CaptureConfig };
    try { approved = JSON.parse(readFileSync(previewFile, "utf8")) as typeof approved; }
    catch { throw new Error("capacity apply needs a preview first; re-run without --confirm"); }
    if (approved.file !== file || JSON.stringify(approved.current) !== JSON.stringify(preview.current)
      || approved.target?.capMb !== target.capMb || approved.target?.retentionDays !== target.retentionDays) {
      throw new Error("capacity preview changed; re-run without --confirm");
    }
    const written = writeCaptureConfigFile(file, target);
    rmSync(previewFile, { force: true });
    return JSON.stringify({ preview, written: { cap_mb: written.capMb, retention_days: written.retentionDays } }, null, 2);
  }
  if (sub === "projects") {
    // Archived projects stay listed (the person must see what is cold); a forgotten one is out of the default view, and --all brings it back with its state.
    const rows = readCatalogFresh(memoryHome()).filter(project => options["--all"] === true || project.state !== "forgotten");
    if (options["--json"]) return JSON.stringify(rows, null, 2);
    if (!rows.length) return "no project shards yet";
    const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
    // Per-project curated counts exist only after the split; before it every note is in one shared store, so the honest figure is unavailable, never 0.
    const split = shardStatePresent();
    return rows.map(p => `${p.key}  ${p.state}${p.local ? "  local-only key" : ""}${p.aliases.length ? `  aliases: ${p.aliases.join(", ")}` : ""}  capture ${p.captureRows} rows ${mb(p.captureBytes)}  curated ${split ? p.curatedEntries ?? "unavailable" : "unavailable (home not split)"}  disk ${mb(p.diskBytes)}  last ${p.captureLastAt ?? "never"}`).join("\n");
  }
  if (sub === "usage") {
    const limit = options["--limit"] === undefined ? undefined : Number(options["--limit"]);
    const report = usageReport(memoryHome(), { ...(limit !== undefined ? { limit } : {}), includeForgotten: options["--all"] === true });
    return options["--json"] ? JSON.stringify(report, null, 2) : usageText(report);
  }
  if (sub === "gc") {
    // A preview reads; only --confirm evicts (and then the terminal and agent-marker refusals above already ran, because `mutates: "confirm"`).
    const batches = options["--batches"] === undefined ? undefined : Number(options["--batches"]);
    const result = runGc(memoryHome(), { dryRun: options["--confirm"] !== true, ...(batches !== undefined ? { maxBatchesPerShard: batches } : {}) });
    return options["--json"] ? JSON.stringify(result, null, 2) : `${result.dryRun ? "preview (nothing evicted; add --confirm):\n" : ""}${gcText(result)}`;
  }
  if (sub === "import" && ["claude-auto", "codex"].includes(parsed.path[1] ?? "")) {
    for (const flag of ["--db", "--limit", "--restart", "--capture-days"]) if (options[flag] !== undefined) throw new Error(`${flag} only applies to import claude-mem`);
    const source = parsed.path[1] as ExternalMemorySource, policy = policyOf();
    const result = await importExternalMemory({ base: memoryHome(), project: boundProject(), source, cwd: policyCwd, env: context.env ?? process.env,
      ...(typeof options["--from"] === "string" ? { from: options["--from"] } : {}), policy: value => policy.screenStandalone(value) });
    return options["--json"] ? JSON.stringify(result, null, 2)
      : `imported ${result.added} ${source} candidates from ${result.files} files (${result.read} records, ${result.pending.count} pending); skipped ${result.skipped.rules} rule files, ${result.skipped.policy} policy/secret records, ${result.skipped.invalid} invalid records and ${result.skipped.truncated} oversized inputs${result.queueFull ? "; candidate queue is full" : result.limitReached ? "; per-run candidate cap reached" : ""}`;
  }
  if (sub === "project") {
    const op = parsed.path[1]!, [requested] = parsed.positionals;
    if (!requested) throw new Error(`usage: amem project ${op} <key>`);
    if (op === "export") {
      if (typeof options["--to"] !== "string") throw new Error("usage: amem project export <key> --to <file>");
      const format = (options["--format"] ?? "json") as ProjectExportFormat;
      // The bundle leaves the home, so it is screened by the configured policy (secrets, personal data, the configured patterns and deny paths).
      const result = await exportProject(memoryHome(), requested, { to: options["--to"], policy: policyOf(), format });
      return options["--json"] ? JSON.stringify(result, null, 2) : `exported ${result.project} to ${result.file} as ${result.format}: ${result.counts.capture} capture rows, ${result.counts.curated} notes, ${result.counts.goals} goals, ${result.counts.workLists} work lists${result.withheld ? `; ${result.withheld} withheld by the screen` : ""}`;
    }
    if (op === "import") {
      if (typeof options["--from"] !== "string") throw new Error("usage: amem project import <key> --from <file.jsonl> [--confirm] [--allow-shared]");
      const key = resolveAlias(memoryHome(), requested), policy = policyOf();
      const store = curatedStore(key, { screen: note => policy.screenStandalone(note) ? "promote" : "keep", createAliases: true });
      try {
        const result = await importProject(store, { from: options["--from"], project: key, confirm: options["--confirm"] === true,
          allowShared: options["--allow-shared"] === true, policy: note => policy.screenStandalone(note) });
        const counts = `sources ${JSON.stringify(result.provenance.source)}, peers ${JSON.stringify(result.provenance.peer)}, scopes ${JSON.stringify(result.provenance.scope)}`;
        const summary = result.applied ? `imported ${result.added} of ${result.read} curated notes into ${result.project} with their original ids`
          : `preview: ${result.wouldAdd} of ${result.read} curated notes can be imported into ${result.project} with their original ids (re-run with --confirm to write)`;
        return options["--json"] ? JSON.stringify(result, null, 2)
          : `${summary}; ${counts}; skipped ${result.skipped.invalid} invalid, ${result.skipped.policy} policy/secret and ${result.skipped.other} non-curated records. ${result.warnings.join(" ")}`;
      } finally { store.close(); }
    }
    const key = requireShard(memoryHome(), requested);
    if (op === "forget" && options["--confirm"] !== true) {
      const state = projectState(memoryHome(), key), shard = readCatalogFresh(memoryHome()).find(p => p.key === key);
      return `preview: forget ${key} (now ${state}; capture ${shard?.captureRows ?? 0} rows, curated ${shardStatePresent() ? shard?.curatedEntries ?? "unavailable" : "unavailable (home not split)"}). Forget is an append-only record that takes the project out of recall and every listing for good; nothing is erased here and it cannot be undone. Re-run with --confirm to record it.`;
    }
    const written = appendLifecycle(memoryHome(), { op: op as "archive" | "unarchive" | "forget", key, actor: "person", machine: machineId(memoryHome()).id });
    return options["--json"] ? JSON.stringify(written, null, 2) : `${op === "forget" ? "forgot" : op === "archive" ? "archived" : "unarchived"} ${written.key}${requested !== written.key ? ` (alias ${requested})` : ""}`;
  }
  if (sub === "search" && options["--all-projects"] === true) {
    if (options["--filter"] === true) throw new Error("--filter applies to project-local search, not --all-projects");
    const words = parsed.positionals.join(" ");
    if (!words.trim()) throw new Error("usage: amem search --all-projects <words> [--limit N] [--include-archived] [--json]");
    const result = searchAllProjects(memoryHome(), words, { ...(options["--limit"] !== undefined ? { limit: Number(options["--limit"]) } : {}), includeArchived: options["--include-archived"] === true });
    if (options["--json"]) return JSON.stringify(result, null, 2);
    const one = (hit: (typeof result.hits)[number]) => hit.view ? `${hit.project}  ${hit.view.id.slice(0, 8)}  ${hit.view.kind}  ${(hit.view.title ?? hit.view.text).split("\n")[0]!.slice(0, 100)}` : `${hit.project}  capture ${hit.capture!.id}  ${hit.capture!.event}  ${hit.capture!.excerpt.split("\n")[0]!.slice(0, 100)}`;
    return [`crossed projects: searched ${result.projects.length} (${result.projects.join(", ")})`, ...(result.hits.length ? result.hits.map(one) : ["(nothing)"])].join("\n");
  }
  if (sub === "search" && options["--include-archived"] === true) throw new Error("--include-archived only applies with --all-projects");
  if (sub === "alias") {
    if (parsed.path[1] === "add") {
      const [from, to] = parsed.positionals;
      if (!from || !to) throw new Error("usage: amem alias add <from-key> <to-key>");
      const op = appendAlias(memoryHome(), { alias: from, key: to, actor: "person", machine: machineId(memoryHome()).id });
      return options["--json"] ? JSON.stringify(op, null, 2) : `alias ${op.alias} -> ${op.key}`;
    }
    if (parsed.path[1] === "remove") {
      // #27 option 2: person only (ordinary CLI refusal of agent markers above, a TTY through `mutates`), append only, the latest op wins.
      const [from] = parsed.positionals;
      if (!from || parsed.positionals.length !== 1) throw new Error("usage: amem alias remove <alias-key>");
      const op = appendUnalias(memoryHome(), { alias: from, actor: "person", machine: machineId(memoryHome()).id });
      return options["--json"] ? JSON.stringify(op, null, 2) : `alias ${op.alias} removed`;
    }
    const ops = listAliases(memoryHome());
    return options["--json"] ? JSON.stringify(ops, null, 2) : ops.length ? ops.map((op) => op.op === "alias" ? `${op.at}  ${op.alias} -> ${op.key}  (${op.actor})` : `${op.at}  ${op.alias} removed  (${op.actor})`).join("\n") : "no aliases recorded";
  }
  // ponytail: board task links need the host's authenticated task boundary; add a host bridge before supporting them here.
  if (goal && sub === "link") throw new Error("goal link needs a host with a task board; amem alone has none");
  // #15 T4 / D6: the repo scope. Person-only and a terminal were enforced above (agent markers, `mutates`); amem never runs git.
  const repoCwd = context.cwd ?? process.cwd();
  if (sub === "repo") {
    const project = boundProject(), root = boundRepoRoot(repoCwd, memoryHome(), project);
    if (!root) throw new Error("this directory is not inside the working tree of the repository that is this project (amem repo works on the current repository only)");
    if (parsed.path[1] === "attributes") {
      const plan = planGitattributes(root);
      if (plan.unsafe) throw new Error(plan.unsafe);
      if (plan.present) return `${plan.path} already has the merge=union entry for .amem/log.jsonl`;
      if (options["--confirm"] !== true) return `preview: append ".amem/log.jsonl merge=union" to ${plan.path} (nothing written; add --confirm). amem never commits it: you do.`;
      const written = appendGitattributes(root);
      return `${written.added ? "added" : "already had"} the merge=union entry in ${written.path}; commit it through normal review`;
    }
    const scoped = repoReadPolicy(root);
    const read = "reason" in scoped ? undefined : await readRepoScope(root, scoped.policy);
    const status = { root, file: repoLogPath(root), state: read?.state ?? "unavailable", entries: read?.views.length ?? 0, skipped: read?.skipped ?? null, ...(read?.reason ? { reason: read.reason } : {}), ...("reason" in scoped ? { reason: scoped.reason } : {}) };
    return options["--json"] ? JSON.stringify(status, null, 2) : [`repo scope of ${project}: ${status.state}`, `file: ${status.file}`, `entries: ${status.entries}${read ? ` (skipped: ${read.skipped.malformed} malformed, ${read.skipped.mismatched} id mismatch, ${read.skipped.duplicate} duplicate, ${read.skipped.withheld} withheld by the screen)` : ""}`,
      ...(status.reason ? [`unavailable: ${status.reason}`] : [])].join("\n");
  }
  if (sub === "promote" && options["--to"] === undefined && (options["--confirm"] !== undefined || options["--confirm-public"] !== undefined)) throw new Error("--confirm and --confirm-public only apply with --to repo");
  if (sub === "promote" && options["--to"] !== undefined) {
    const idText = parsed.positionals[0];
    if (!idText || parsed.positionals.length !== 1) throw new Error("usage: amem promote <id> --to repo --policy-free [--confirm [--confirm-public <entry id prefix>]]");
    const project = boundProject(), root = boundRepoRoot(repoCwd, memoryHome(), project);
    if (!root) throw new Error("repo scope needs the working tree of the repository that is this project: run it from inside that repository");
    const store = curatedStore(project, { deferPromotions: true, screen: () => "skip" });
    let view;
    try { view = store.get(idText, project); } finally { store.close(); }
    if (!view) throw new Error(`no memory entry ${idText} in this project (amem list shows the ids)`);
    // `get` also returns shared-scope notes of other projects: only this project's own private notes go into this repository.
    if (resolveAlias(memoryHome(), view.project) !== project) throw new Error(`${view.id.slice(0, 8)} belongs to another project; only this project's notes can be promoted into its repository`);
    const plan = await planRepoPromotion(root, view, configuredPolicyOptions(memoryHome(), root));
    if (plan.refusals.length) throw new Error(`not promoted to repo scope:\n- ${plan.refusals.join("\n- ")}`);
    const seen = await repoVisibility(root, context.visibility);
    const preview = [`the exact line that would be appended to ${plan.path}:`, plan.text, ...(plan.droppedNodes.length ? [`(left out, private references: ${plan.droppedNodes.join(", ")})`] : []),
      `repository visibility: ${seen.state}${seen.remotes.length ? ` (${[...new Set(seen.remotes.map(r => `${r.name}${r.kind === "push" ? " (push)" : ""} ${r.visibility}`))].join(", ")})` : " (no remote)"}`];
    if (plan.alreadyPresent) return [...preview, "already in the file: nothing to write"].join("\n");
    const entryPrefix = plan.line.id.slice(0, 8);
    if (options["--confirm"] !== true) return [...preview, seen.state === "private" ? "nothing written; add --confirm to append it" : `NOT a verified private repository: add --confirm --confirm-public ${entryPrefix} to append this entry (per entry, never blanket)`].join("\n");
    if (seen.state !== "private") {
      const given = options["--confirm-public"];
      if (typeof given !== "string" || given.length < 8 || !/^[a-f0-9]+$/.test(given) || !plan.line.id.startsWith(given)) throw new Error(`the repository is ${seen.state === "public" ? "public" : "not verified private"}: repo scope needs your confirmation of this entry: --confirm-public ${entryPrefix} (the first 8 characters of the id in the line above)`);
    }
    const written = appendRepoLine(root, plan.line);
    return [...preview, `appended to ${written.path}. amem does not commit or push: review and commit it yourself.`,
      ...(repoLogIgnored(root) ? ["WARNING: git ignores .amem/log.jsonl here, so `git status` will not show it and it cannot be committed until you un-ignore it (a .gitignore or .git/info/exclude rule)."] : [])].join("\n");
  }
  if (sub === "show" && /^repo:/.test(parsed.positionals[0] ?? "")) {
    const project = boundProject(), root = boundRepoRoot(repoCwd, memoryHome(), project), scoped = root ? repoReadPolicy(root) : undefined;
    const rows = root && scoped && !("reason" in scoped) ? (await readRepoScope(root, scoped.policy)).views : [];
    const wanted = parsed.positionals[0]!.slice(5), hit = rows.filter(row => row.id === wanted || wanted.length >= 6 && row.id.startsWith(wanted));
    if (hit.length !== 1) throw new Error(`no repo entry ${parsed.positionals[0]} in this repository's .amem/log.jsonl`);
    const row = hit[0]!;
    return options["--json"] ? JSON.stringify(row, null, 2) : [`repo:${row.id}  ${row.kind}, repo scope, ${row.at}`, ...(row.about.length ? [`about: ${row.about.join(", ")}`] : []), "", ...(row.title ? [row.title] : []), row.text].join("\n");
  }
  // Recall (D4): the current project plus, when the repository IS this project, that repository's `.amem/`. Never another project's.
  const withRepoRows = async (output: string): Promise<string> => {
    if (options["--history"] === true || options["--as-of"] !== undefined) return output;
    if (sub !== "list" && sub !== "search") return output;
    const root = boundRepoRoot(repoCwd, memoryHome(), boundProject());
    if (!root) return output;
    const scoped = repoReadPolicy(root);
    if ("reason" in scoped) return options["--json"] ? output : `${output}\n(repo scope unavailable: ${scoped.reason})`;
    const read = await readRepoScope(root, scoped.policy);
    if (read.state === "absent" && !read.skipped.malformed) return output;
    const words = sub === "search" ? parsed.positionals.join(" ").toLowerCase().split(/\s+/).filter(Boolean) : [];
    const kind = options["--kind"], since = options["--since"], limit = options["--limit"] !== undefined ? Number(options["--limit"]) : 50;
    const rows = read.views.filter(row => options["--tier"] !== "short" && (kind === undefined || row.kind === kind) && (typeof since !== "string" || Date.parse(row.at) >= Date.parse(since))
      && words.every(word => `${row.title ?? ""}\n${row.text}\n${row.about.join(" ")}`.toLowerCase().includes(word))).slice(0, limit);
    if (options["--json"]) { try { const base = JSON.parse(output) as unknown[]; return JSON.stringify([...base, ...rows], null, 2); } catch { return output; } }
    const line = (row: RepoView) => `repo:${row.id.slice(0, 8)}  ${row.at.slice(0, 16).replace("T", " ")}  repo  ${row.kind.padEnd(8)} ${`${row.title ? `${row.title}: ` : ""}${row.text}`.replace(/\s+/g, " ").slice(0, 100)}`;
    const note = read.state === "unsafe" ? [`(repo scope unavailable: ${read.reason})`] : read.skipped.malformed + read.skipped.mismatched + read.skipped.withheld ? [`(${read.skipped.malformed + read.skipped.mismatched} repo lines skipped as invalid, ${read.skipped.withheld} withheld by the screen)`] : [];
    return [output, ...(rows.length ? ["repo scope (.amem/log.jsonl):", ...rows.map(line)] : []), ...note].join("\n");
  };
  const crosses = definition.policyFree === true;
  const cwd = context.cwd ?? process.cwd();
  const configured = policyOf(), recallRoot = boundRepoRoot(cwd, memoryHome(), boundProject());
  const rootConfirmed = recallRoot !== undefined || boundProject().startsWith("local:") && resolveAlias(memoryHome(), memoryProjectKey(cwd)) === boundProject();
  // Reads can trigger held-note reconciliation. Defer it unless this command is one that moves notes across the boundary (promote, sync, import, review accept), and then the configured policy decides each note.
  const open = () => curatedStore(boundProject(), { screen: note => !crosses ? "skip" : configured.screenStandalone(note) ? "promote" : "keep" });
  // A person's reads are unscreened. A write is screened by the configured policy, which includes the built-in secret screen.
  if (goal) return rawGoalCommand(args, cwd, { project: boundProject(), open, clean: (title, milestones) => !mutating || configured.screenStandalone({ title, milestones }),
    onDone: async (done, store) => {
      const project = boundProject(), base = realPath(store.profile.home), assertCurrent = commandBinding(store.profile.home, project);
      if (readSelector(base).revision !== store.profile.selectorRevision) throw new Error("goal promotion store selector changed");
      assertCurrent();
      const { offerGoalPromotions } = await import("./memory/goal-promotion.ts");
      assertCurrent();
      const candidates = new CandidateStore({ memoryDir: base, reconcile: { canonical: project, aliases: aliasedKeys(base, project) } });
      try { return await offerGoalPromotions(store, candidates, project, done.id, { policy: () => configuredPolicy(base, cwd), assertCurrent }); }
      finally { candidates.close(); }
    } });
  const receipt: { bridgeStatus?: { skippedRows: number } } = {};
  // F16: `sync --if-due` is the entry for the person's own shell (an EXIT trap; it needs a terminal like every mutating command). amem registers no sync hook and runs nothing between sessions. It does nothing without a
  // configured remote, nothing when the schedule or the failure backoff says it is not due (`--force` skips that), and it stops a running git step after 30 seconds.
  const ifDue = sub === "sync" && options["--if-due"] === true, syncHome = memoryHome();
  if (options["--force"] === true && !ifDue) throw new Error("--force only applies with sync --if-due");
  if (ifDue) {
    if (options["--remote"] === undefined && !remoteConfigured(syncHome)) return options["--json"] ? JSON.stringify({ ok: true, skipped: "no sync remote configured" }) : "no sync remote configured: nothing to do";
    const state = usableState(readSyncState(syncHome), Date.now());
    if (!syncDue(state, Date.now(), options["--force"] === true)) {
      const next = nextSyncAt(state);
      return options["--json"] ? JSON.stringify({ ok: true, skipped: "not due", nextAttemptAt: next === null ? null : new Date(next).toISOString(), failures: state.failures })
        : `sync not due until ${next === null ? "now" : new Date(next).toISOString()}${state.failures ? ` (${state.failures} failure${state.failures === 1 ? "" : "s"} in a row: the wait doubles up to a day; --force skips it)` : ""}`;
    }
  }
  // Only a real attempt is stamped: a local refusal (lock held, no remote, policy, usage) is not, and a future stamp is no history (src/memory/sync-cadence.ts).
  const stampSync = (error: string | undefined, cause?: StopCause) => { if (syncOutcome(error, cause) !== "local") recordSyncAttempt(syncHome, error === undefined, Date.now()); };
  const captureImport = sub === "import" && parsed.path[1] === "claude-mem", captureDays = options["--capture-days"] === undefined ? undefined : Number(options["--capture-days"]);
  if (captureImport && captureDays !== undefined && (!Number.isSafeInteger(captureDays) || captureDays <= 0)) throw new Error("--capture-days takes a positive integer");
  const captureArgs = new Set<number>();
  if (captureImport) for (let index = 0; index < args.length; index++) {
    if (args[index] === "--capture-days") { captureArgs.add(index); captureArgs.add(index + 1); }
    else if (args[index]?.startsWith("--capture-days=")) captureArgs.add(index);
  }
  // --filter selects the standalone CLI mode; hosts keep their existing raw command arguments.
  const legacySearch = options["--filter"] === true;
  const syncArgs = args.filter((arg, index) => arg !== "--if-due" && arg !== "--force" && !captureArgs.has(index) && (!legacySearch || arg !== "--filter"));
  let output: string;
  const stop = ifDue ? stopSignal(context.syncDeadlineMs ?? SYNC_IF_DUE_DEADLINE_MS, process) : undefined;
  try {
    output = await withRepoRows(await rawMemoryCommand(syncArgs, cwd, { person: true, rankedSearch: !legacySearch, project: boundProject(), open, readable: notes => notes, stale: createRecallStalenessProbe({ cwd: recallRoot ?? cwd, rootConfirmed, policy: () => configured }), outputReady: notes => outputReady(notes.map(view => view.id)), importPolicy: () => text => configured.declinesPersonal(text),
      sync: { screen: row => configured.screenStandalone(row), ...(stop ? { signal: stop.signal } : {}) },   // the repository-narrowed policy binds what sync publishes too
      onBridgeStatus: status => { receipt.bridgeStatus = status; } }));
  } catch (error) {
    if (sub === "sync") stampSync((error as Error).message, stop?.cause());
    throw error;
  }
  finally {
    stop?.dispose();
    // A run its person ended ends like that signal (130, 143, 129, 131), as `amem doctor` does, also when `--json` reports it as a result instead of an error: the caller decides when.
    const ended = stop?.cause() === "person" ? stop.signalName() : undefined;
    if (ended !== undefined) context.onPersonStop?.(ended);
  }
  if (sub === "sync") {
    // `--json` returns the failed result instead of throwing: read the real outcome from it, never assume a returned string means the sync worked.
    let failure: string | undefined;
    if (options["--json"]) { try { const result = JSON.parse(output) as { ok?: unknown; error?: unknown }; if (result.ok === false) failure = typeof result.error === "string" ? result.error : "sync failed"; } catch { /* not a sync result */ } }
    stampSync(failure, stop?.cause());
  }
  if (captureImport) {
    const policy = configured, db = options["--db"] ? { db: String(options["--db"]) } : {}, limit = options["--limit"] ? { limit: Number(options["--limit"]) } : {}, restart = options["--restart"] === true;
    const work = await importClaudeMemWorkState({ base: memoryHome(), project: boundProject(), policy: row => policy.screen(row), ...db, ...limit, restart });
    const capture = captureDays === undefined ? undefined : await importClaudeMemCapture({ base: memoryHome(), project: boundProject(), cwd, days: captureDays, ...db, ...limit, restart, policy: { host: policy } });
    return options["--json"] ? JSON.stringify({ ...JSON.parse(output), work, ...(capture ? { capture } : {}) }, null, 2) : `${output}\nwork lists: ${JSON.stringify(work)}${capture ? `\ncapture: ${JSON.stringify(capture)}` : ""}`;
  }
  return !options["--json"] && receipt.bridgeStatus
    ? `${output}\n(legacy malformed lines skipped: ${receipt.bridgeStatus.skippedRows})` : output;
}

export function formatCliError(error: unknown): string { return error instanceof DecayApplyError ? error.render() : `amem: ${(error as Error).message}`; }

/** A completed write means rendered output, never evidence of host delivery or citation. */
export async function writeCliOutput(text: string, output: Writable = process.stdout): Promise<void> { await writeConfirmed(output, text); }
export async function main(argv = process.argv.slice(2)): Promise<void> {
  let personStop: string | undefined;
  try {
    const receipts: CliOutputReceipt[] = [], output = await runCli(argv, { onOutputReady: receipt => receipts.push(receipt), onPersonStop: name => { personStop ??= name; } });
    if (output) { await writeCliOutput(output + "\n"); for (const receipt of receipts) { try { receipt.rendered(); } catch { /* telemetry stays optional */ } } }
  } catch (error) {
    console.error(formatCliError(error)); process.exitCode = (error as { exitCode?: number }).exitCode ?? 1;
  }
  if (personStop !== undefined) endLikeSignal(personStop);   // after the report, with amem's own handlers already removed
}

if (import.meta.main) await main();
