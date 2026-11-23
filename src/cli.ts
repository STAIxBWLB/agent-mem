import { appendMetricsLater, createPeakTracker, observeMcpPhase, processPeakRssKB } from "./memory/metrics.ts";
import { parseRecordLines } from "./hook-record.ts";
import { assertFormatFloor } from "./memory/formats.ts";
import { placementRuntimeRefusal, readPlacementRuntimeMarkers } from "./memory/sync-placement-guard.ts";
import { readActivePlacementBinding } from "./memory/sync-placement-active.ts";
import { activatePublicPruneView } from "./memory/public-prune-activation.ts";
import { AgentReadAmbiguous, AgentReadFailure, AgentUsageError, agentCliRead } from "./cli-agent-reads.ts";
import { cliAttribution, withCliAttribution } from "./memory/cli-attribution.ts";
import { createHash, randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { buildIntentBrief } from "./memory/intent-brief.ts";
import { proposeConsolidation } from "./memory/consolidate.ts";
import { recordCaptureLookup, recordSourceCheck, recordWindow } from "./memory/record-candidates.ts";
import { createIntentBriefSource, recallViewIsLive } from "./memory/recall.ts";
import { createRecallStalenessProbe } from "./memory/recall-staleness.ts";
import { recordMemoryUse } from "./memory/use-telemetry.ts";
import { DecayApplyError, UNUSED_INJECTION_REASON } from "./memory/decay-review.ts";
import { createMemoryMcp } from "./mcp-memory.ts";
import { safeProfileLockMessage } from "./memory/profile-lock-diagnostic.ts";
import { PLACEMENT_CHECKPOINT_PENDING_MESSAGE } from "./memory/sync-placement-journal-format.ts";
import { MCP_TOOLS, serveMcp, writeConfirmed } from "./mcp.ts";
import { createStandalonePolicy } from "./memory/policy.ts";
import { configuredPolicy, configuredPolicyOptions, loadAmemConfig, repoConfigRoot } from "./memory/config.ts";
import { vaultCandidates, vaultCandidatesText, vaultCandidatesAllText } from "./memory/vault.ts";
import type { IngestKind, IngestReceipt } from "./ingest.ts";
import { importClaudeMemCapture, importClaudeMemWorkState } from "./memory/import.ts";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSessionKey } from "./memory/capture-input.ts";
import { originLine, originRecheck } from "./memory/candidate-origin.ts";
import { MemoryStore, looksSecret, machineId, openShardStore, type StoreOptions } from "./memory/store.ts";
import { CLI_MEMORY_RENDER } from "./memory/style.ts";
import { rawMemoryCommand, rawGoalCommand, claudeMemImportText } from "./memory/commands.ts";
import { memoryProjectKey } from "./memory/project.ts";
import { CandidateStore, candidateInputId, candidateTargetRevision, type CandidateFilter } from "./memory/candidates.ts";
import { candidateOverlaps, candidateOverlapsBatch } from "./memory/candidate-overlaps.ts";
import { openCuratedForRead } from "./memory/curated-read.ts";
import { aliasedKeys, appendAlias, appendUnalias, listAliases, readShardedSelection, resolveAlias } from "./memory/shard.ts";
import { capacityReport, capacityText, capacityApplyText, capacitySplitText } from "./memory/capacity.ts";
import { CaptureStore, readCaptureConfigFile, writeCaptureConfigFile, type CaptureConfig } from "./memory/capture.ts";

import { COMMANDS, CommandUsageError, commandHelp, commandPath, parseCommand, usageLine } from "./commands-table.ts";
import { completionScript } from "./completion.ts";
import { memoryHome, resolveMemoryHome } from "./memory/home.ts";
import { realPath } from "./memory/platform.ts";
import { RemoteRealmRefusal } from "./memory/sync-placement-remote-refusal.ts";
import { hashJSON, readSelector, resolveProfile } from "./memory/generation.ts";
import { migrate, migrationText } from "./memory/migrate.ts";
import { migrateShards, shardMigrationStatus, shardMigrationText } from "./memory/shard-migration.ts";
import { applyPrune, planPrune, pruneText, PRUNE_PLAN_MAX_BYTES } from "./memory/prune.ts";
import { readCatalogFresh } from "./memory/catalog.ts";
import { appendLifecycle, assertProjectActive, projectState } from "./memory/lifecycle.ts";
import { gcText, runGc } from "./memory/gc.ts";
import { usageReport, usageText } from "./memory/usage.ts";
import * as reports from "./memory/report-text.ts";
import { exportProject, type ProjectExportFormat } from "./memory/project-export.ts";
import { importProject } from "./memory/project-import.ts";
import { importExternalMemory, type ExternalMemorySource } from "./memory/external-import.ts";
import { forgetNearby } from "./memory/forget-nearby.ts";
import { searchAllProjects, vaultCandidatesAll } from "./memory/cross-project.ts";
import { requireShard } from "./memory/curated-read.ts";
import { appendGitattributes, appendRepoLine, boundRepoRoot, planGitattributes, planRepoPromotion, readRepoScope, repoLogIgnored, repoLogPath, repoReadPolicy, repoVisibility } from "./memory/repo-scope.ts";
import type { Visibility } from "./memory/sync.ts";
import { applySplit, previewSplit } from "./memory/capacity-split.ts";
import { evalText, parseKs } from "./memory/eval.ts";
import { unrankedScoreDetails } from "./memory/search-score.ts";
import { builtinSet, evalSeeded, evalStore, FIXTURE_PATH, readEvalSet } from "./memory/eval-fixture.ts";
import { markShown, pendingSummary } from "./memory/candidate-pending.ts";
import { buildNote, FAIL_TEMPLATE, hasFailLabel, noteAdd, parseFailTemplate, type FailFields } from "./memory/note-add.ts";
import { runEditor } from "./memory/editor.ts";
import { doctorReport, doctorText } from "./memory/doctor.ts";
import { statusText, type StatusView } from "./memory/status-text.ts";
import { asciiMarkers, errorLine, errorSpans, EXIT, markerCell, paint, Report, resolveColor, streamEnv } from "@staix/cli-output";
import { style, facts, label, memoryRecordText, memoryScoresText, memoryTableText, PLAIN, singleLine, wordedKey, type Style } from "./memory/style.ts";
import { endLikeSignal, nextSyncAt, readSyncState, recordSyncAttempt, remoteConfigured, syncDue, stopSignal, syncOutcome, usableState, SYNC_IF_DUE_DEADLINE_MS, type StopCause } from "./memory/sync-cadence.ts";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
export interface CliOutputReceipt { project: string; ids: readonly string[]; rendered(): boolean }
export interface CliContext {
  /** Prepared output metadata only. Invoke rendered only after the output writer succeeds. */
  onOutputReady?: (receipt: CliOutputReceipt) => void;
  onExitCode?: (code: number) => void;
  cwd?: string; env?: Readonly<Record<string, string | undefined>>; stdinTTY?: boolean;
  /** Narrow seam for deterministic fixtures standing in for `gh` (#15 T4): the CLI always uses the native remote visibility check. */
  visibility?: (url: string) => Promise<Visibility>;
  /** Legacy setup fixture seam; explicit apply/undo flags no longer prompt. */
  setupConfirm?: (plan: import("./setup.ts").SetupPlan) => Promise<boolean>;
  /** Narrow seams for `amem note add` and `amem review walk`; each defaults to the real terminal. Fixtures stand in for the person at the keyboard. */
  prompt?: (question: string) => string | null | Promise<string | null>;
  /** Where `review walk` prints each candidate BEFORE it asks about it; defaults to stdout, which must then be a terminal. A fixture that supplies this stands in for the terminal. */
  write?: (text: string) => void;
  /** Whether stdout is a terminal, for the real stdout only (default `process.stdout.isTTY`). */
  stdoutTTY?: boolean;
  edit?: (initial: string) => string | Promise<string>;
  /** Where `sync --progress` writes (default process.stderr) and whether that is a terminal; fixtures stand in for both. */
  stderr?: (text: string) => void; stderrTTY?: boolean;
  /** Test seams for `amem formats raise`: the process table (`pid args` lines; default `ps -axo pid=,args=`) and the clock that dates the record. */
  processTable?: () => string; now?: () => number; embeddedAmem?: (dir: string) => boolean;
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
export function readPrunePlanFile(path: string, io: PrunePlanFileIO = planFileIO, maximum = PRUNE_PLAN_MAX_BYTES): string {
  try {
    const fd = io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = io.stat(fd);
      if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximum) throw new Error();
      const data = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < data.length) {
        const n = io.read(fd, data, length, data.length - length, length);
        if (!Number.isSafeInteger(n) || n < 0 || n > data.length - length) throw new Error();
        if (n === 0) break;
        length += n;
      }
      if (length > maximum) throw new Error();
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

/** #217 PR2: pure checks only (no home, source or store access), so a bad invocation is refused before anything is read. */
function assertSpoolReplayArguments(path: readonly string[], options: Record<string, unknown>): void {
  if (path[1] !== "replay") throw new AgentUsageError("usage: amem spool replay [--json] [--source <absolute dir>] | amem spool replay --apply --plan <file>");
  const apply = options["--apply"] === true, planFile = options["--plan"], source = options["--source"];
  if (apply && typeof planFile !== "string") throw new AgentUsageError("spool replay --apply needs --plan <saved preview>; run `amem spool replay --json > plan.json` first");
  if (!apply && planFile !== undefined) throw new AgentUsageError("--plan is only used with --apply; drop it to preview, or add --apply to apply it");
  if (apply && source !== undefined) throw new AgentUsageError("--source is fixed by the saved plan; drop --source when applying");
  if (options["--confirm-unverifiable"] === true && !apply) throw new AgentUsageError("--confirm-unverifiable only applies with --apply --plan; preview first, review the mappings, then apply");
  if (typeof planFile === "string" && (!planFile || planFile.includes("\0"))) throw new AgentUsageError("--plan is empty or contains a NUL byte; pass the saved preview's path");
  if (source !== undefined) {
    if (typeof source !== "string" || !source || source.includes("\0")) throw new AgentUsageError("--source is empty or contains a NUL byte; pass an absolute path to a private directory");
    if (!isAbsolute(source)) throw new AgentUsageError("--source is a relative path; pass the absolute path of the parked directory");
  }
}
/** Realm admission receipts name hashes and counts only; the project key is the caller's own argument. */
function realmAdmissionDetail(result: { state: string; next?: { sequence: number; mode: "new" | "existing" }; sequence?: number; headHash?: string; created?: boolean; discarded?: number; discards?: number; staged?: number; nextStep?: string }): string {
  if (result.staged) return `; ${result.state === "abandoned" ? "removed" : "would remove"} ${result.staged} private intent stage(s), ${result.discarded ?? result.discards ?? 0} bytes${result.state === "abandoned" ? "" : "; rerun with --confirm"}`;
  if (result.state === "admitted") return `; appended record ${result.sequence} ${result.headHash}${result.created ? "; wrote the realm's empty curated metadata first" : ""}`;
  if (result.state === "already-admitted") return result.nextStep ? `; ${result.nextStep}` : "; the realm is already in the effective inventory and nothing was appended";
  if (result.state === "abandoned") return `; removed the retained intent for record ${result.sequence} and discarded ${result.discarded ?? 0} incomplete bytes`;
  if (result.next) return `; would append record ${result.next.sequence} over the ${result.next.mode} realm's curated metadata; writes nothing until --apply`;
  if (result.state === "abandonable" || result.state === "retained") return `; would remove the retained intent for record ${result.sequence} and discard ${result.discards ?? result.discarded ?? 0} incomplete bytes; rerun with --confirm`;
  return result.nextStep ? `; ${result.nextStep}` : `; no change`;
}
/** Body-free preview text: counts by class, then each record's cwd, current project and class for explicit confirmation. */
function replayPreviewText(plan: { records: { name: string; cwd: string; project: string | null; class: string; event: string | null }[]; counts: Record<string, number>; digest: string; needsConfirmation: { cwd: string; project: string; count: number }[] }): string {
  const lines = [`spool replay preview (no record bodies shown; plan ${plan.digest.slice(0, 12)})`,
    ...Object.entries(plan.counts).filter(([, n]) => n > 0).map(([cls, n]) => `  ${cls}: ${n}`)];
  const byCwd = new Map<string, { project: string | null; classes: Map<string, number> }>();
  for (const record of plan.records) {
    const row = byCwd.get(record.cwd) ?? { project: record.project, classes: new Map() };
    row.classes.set(record.class, (row.classes.get(record.class) ?? 0) + 1); byCwd.set(record.cwd, row);
  }
  for (const [cwd, row] of byCwd) lines.push(`  ${cwd || "(unreadable record)"} -> ${row.project ?? "(project unresolved)"}: ${[...row.classes].map(([c, n]) => `${c} ${n}`).join(", ")}`);
  if (plan.needsConfirmation.length) {
    lines.push("Needs confirmation (decision A: this boot cannot prove the original identity; each maps by its own cwd):");
    for (const group of plan.needsConfirmation) lines.push(`  ${group.cwd} -> ${group.project}: ${group.count}`);
    lines.push("To apply these mappings too, after checking each one: amem spool replay --json > plan.json && amem spool replay --apply --plan plan.json --confirm-unverifiable");
  }
  lines.push("Without --confirm-unverifiable only replayable records are applied: amem spool replay --json > plan.json && amem spool replay --apply --plan plan.json");
  return lines.join("\n");
}

/** Administrative metadata is checked as a complete value, never by stripping individual fields. */
function assertAgentAdministrative(value: unknown, policy: ReturnType<typeof configuredPolicy>): void {
  if (cliAttribution()?.actor !== "agent") return;
  let plain: unknown;
  try { plain = JSON.parse(JSON.stringify(value)); } catch { throw Error("Memory operation unavailable or refused; no partial result is shown."); }
  if (!policy.screenStandalone(plain)) throw new ReadPolicyWithheld();
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

/** Fixed metadata only: never include the withheld result or its error cause. */
class CliPartialApplyError extends Error {
  constructor(readonly appliedCount: number, readonly jsonOutput: boolean) {
    super(appliedCount > 0 ? "Operation partially applied; receipt withheld by policy. Inspect state before retrying."
      : "Operation stopped; the failed target may have changed. Receipt withheld by policy. Inspect state before retrying.");
  }
  render(): string {
    return this.jsonOutput ? JSON.stringify({ ok: false, partial: this.appliedCount > 0, appliedCount: this.appliedCount, failedMayHaveChanged: true, receiptWithheld: true }, null, 2) : this.message;
  }
}

/**
 * `amem manifest`: what this install serves, read by installers (dotfiles#320) without a compiled list. A tool is a plain name, or
 * `{ name, readOnly: true }` when its MCP annotation says it changes nothing. No memory data, so it needs no home.
 */
export function manifest() {
  return { name: "@staix/agent-mem", version: VERSION,
    mcp: { server: "amem", tools: MCP_TOOLS.map(tool => tool.annotations.readOnlyHint ? { name: tool.name, readOnly: true as const } : tool.name) },
    commands: Object.keys(COMMANDS) };
}

/** Setup apply errors can contain configuration paths or native output. Classify only
 * this explicit operation into fixed text; never include the caught message or cause. */
function markedSetupApplyError(parsed: ReturnType<typeof parseCommand>, error: unknown): Error | undefined {
  const target = parsed.positionals[0];
  if (parsed.path.length !== 1 || parsed.path[0] !== "setup" || parsed.options["--apply"] !== true || parsed.options["--undo"] === true
    || parsed.positionals.length !== 1 || target === "console" || !COMMANDS.setup?.args?.[0]?.values?.includes(target!)) return undefined;
  const detail = error && typeof error === "object" ? error as { message?: unknown; code?: unknown; exitCode?: unknown } : {};
  const text = typeof detail.message === "string" ? detail.message : "";
  const code = typeof detail.code === "string" ? detail.code : "";
  let cause = "setup_apply_failed", next = "Review the setup preview and saved setup ownership state before retrying.", partial = true;
  if (text === "Memory operation unavailable or refused; no partial result is shown.") {
    cause = "setup_policy_refused"; next = "Review setup policy with the person and keep denied configuration private."; partial = false;
  } else if (/^installed (?:claude|codex|kimi|pi|qwen|jcode|opencode|gemini|agy) CLI does not expose MCP registration; no registration command was run$/.test(text)) {
    cause = "native_capability_unverified"; next = "Verify that the installed client can start and exposes MCP administration, then rerun setup preview."; partial = false;
  } else if (/^(?:claude|codex|pi|qwen|gemini) MCP registration timed out in staging; no native output disclosed$/.test(text)) {
    cause = "native_registration_timeout"; next = "Check that the installed client starts promptly, then rerun setup preview."; partial = false;
  } else if (/^qwen MCP registration rejected command arguments in staging; no native output disclosed$/.test(text)) {
    cause = "native_arguments_rejected"; next = "Check the installed client's supported MCP command syntax, then rerun setup preview."; partial = false;
  } else if (/^(?:claude|codex|pi|qwen|gemini) MCP registration failed in staging; no native output disclosed$/.test(text)) {
    cause = "native_registration_failed"; next = "Check the installed client's MCP administration locally, then rerun setup preview."; partial = false;
  } else if (/^(?:claude|codex|pi|qwen|gemini) native registration (?:produced no configuration|produced invalid configuration; no configuration published|did not produce the planned amem server|changed unrelated MCP servers; no configuration published)$/.test(text)
    || text === "codex native registration changed unrelated settings; no configuration published") {
    cause = "native_result_mismatch"; next = "Review the installed client's configuration format and version, then rerun setup preview."; partial = false;
  } else if (text === "setup receipt version is unsupported; run setup or undo with the release that wrote it") {
    cause = "setup_receipt_version_unsupported"; next = "Run setup or undo with the amem release that wrote the receipt."; partial = false;
  } else if (text === "setup receipt was written from an Orca Claude profile; rerun setup from that Orca profile") {
    cause = "setup_receipt_orca_profile"; next = "The receipt was written from an Orca Claude profile; rerun setup from that Orca profile."; partial = false;
  } else if (text === "setup receipt is stale: its managed entries were replaced at another amem install root; rerun with --adopt-current to adopt the current wiring") {
    cause = "setup_receipt_stale"; next = "The receipt's managed entries were replaced at another amem install root outside setup; rerun with --apply --adopt-current to keep the receipt aside and adopt the current wiring, which --undo then restores."; partial = false;
  } else if (/^setup-owned .+ changed; refusing to overwrite it$/.test(text) || text === "Pi amem-session extension already exists and is not this setup's file; inspect it, move your changes to another extension file or remove it, then rerun setup"
    || text === "previous-runtime hook settings are customized; review hook configuration before retrying setup"
    || /^setup receipt (?:does not match this installation|target mismatch|invalid|directory ownership invalid)$/.test(text)) {
    cause = "setup_ownership_conflict"; next = "Review the managed entries and saved setup receipt before retrying; keep unrelated configuration intact."; partial = false;
  } else if (/^setup is busy(?: or its lock is unreadable|; retry after the active setup exits)$/.test(text)) {
    cause = "setup_busy"; next = "Wait for the active setup to finish, then rerun setup preview."; partial = false;
  } else if (/^setup configuration changed (?:while reading|before removal|before publication|during preparation)$/.test(text)) {
    cause = "setup_configuration_changed"; next = "Wait for other configuration writers to finish, then rerun setup preview.";
  } else if (/^setup (?:configuration (?:must be an object|does not parse as a JSON object|does not parse as TOML|unavailable or oversized)|hook (?:groups|handlers) must be arrays|TOML unavailable or unsupported; no configuration changed)$/.test(text)) {
    cause = "setup_configuration_unavailable"; next = "Review the configuration's supported format and size, then rerun setup preview."; partial = false;
  } else if (["EACCES", "EPERM", "EROFS"].includes(code)) {
    cause = "setup_filesystem_permissions"; next = "Review the setup file and directory permissions, then rerun setup preview.";
  } else if (["ENOSPC", "EDQUOT"].includes(code)) {
    cause = "setup_storage_capacity"; next = "Check available storage and quotas, then rerun setup preview.";
  } else if (["EIO", "ENOENT", "ENOTDIR", "EISDIR", "EMFILE", "ENFILE"].includes(code)) {
    cause = "setup_filesystem_unavailable"; next = "Check that the setup configuration and storage are available, then rerun setup preview.";
  }
  const safe = new Error(`Setup apply failed [cause: ${cause}]. Next step: ${next} Recheck with amem setup ${target} --json before another apply.${partial ? " Some setup changes may already be applied; review current state before retrying." : ""}`);
  if (typeof detail.exitCode === "number" && Number.isSafeInteger(detail.exitCode)) Object.assign(safe, { exitCode: detail.exitCode });
  return safe;
}

/** Some commands write files despite having no mutates entry; preserve their existing effectful error/receipt treatment. */
function markedReadOnly(parsed: ReturnType<typeof parseCommand>): boolean {
  return parsed.definition.mutates === undefined && parsed.path[0] !== "setup"
    && !(parsed.path[0] === "eval" && parsed.path[1] === "audit" && parsed.path[2] === "sample")
    && !(parsed.path[0] === "project" && parsed.path[1] === "export");
}

class ReadPolicyWithheld extends Error {
  constructor() { super("Memory read withheld [cause: policy_withheld]; no partial result is shown. Ask the person to check the configured policy."); }
}

/** Human-only receipts; host handlers and every JSON response retain their existing bytes. */
function receiptText(output: string, parsed: ReturnType<typeof parseCommand>, context: CliContext): string {
  const command = parsed.path.join(" ");
  const receipts = new Set(["note", "note add", "confirm", "reject", "promote", "demote", "forget", "supersede", "rebuild", "dedupe", "consolidate", "review accept", "review reject", "review decide", "project export", "project import", "project archive", "project unarchive", "project forget", "alias add", "alias remove", "goal new", "goal state", "goal done", "goal take", "import claude-mem", "import claude-auto", "import codex", "repo attributes"]);
  if (!receipts.has(command) || !output || command === "import claude-mem" || output === "Operation completed; receipt withheld by policy. Run amem status to inspect state." || output === "Operation did not complete; receipt withheld by policy. Inspect state before retrying." || command === "promote" && parsed.options["--to"] === "repo") return output;
  const preview = /^preview\b/i.test(output) || command === "review decide" && parsed.options["--confirm"] !== true || command === "dedupe" && parsed.options["--apply"] !== true;
  const s = outputStyle(context, parsed.options), lines = (command === "alias add" && !s.ascii ? output.replace(" -> ", " → ") : output).split("\n"), out = new Report(reportWidth(context) ?? 80, s.ascii, { sanitize: singleLine, keepTokensWhole: true });
  out.bullet(preview ? "pending" : "ok", lines[0]!);
  for (const line of lines.slice(1)) if (line.trim()) out.note(line);
  return out.render(s.color).join("\n");
}

/** #326: a marked score read the policy refuses names its cause class and where to check it, never the matched value. */
export const AUDIT_SCORE_REFUSED = "Audit score refused [cause: policy_denied]: the configured policy denies a value in the rendered score (its seed, as-of or project digest); no partial result is shown. Next step: check the policy (amem.config.json in the memory home, narrowed by the repository's .amem/config) against those values, or sample again with a different --seed.";

export async function runCli(argv: readonly string[], context: CliContext = {}): Promise<string> {
  if (argv.includes("-h")) argv = argv.map(arg => arg === "-h" ? "--help" : arg);
  // The output flags may precede the command, but capture and MCP dispatch still need the command first.
  const leading: string[] = [];
  let offset = 0;
  while (offset < argv.length) {
    const token = argv[offset]!;
    if (token === "--ascii" || token.startsWith("--color=")) { leading.push(token); offset++; continue; }
    if (token === "--color" && argv[offset + 1] !== undefined && !argv[offset + 1]!.startsWith("--")) {
      leading.push(token, argv[offset + 1]!); offset += 2; continue;
    }
    break;
  }
  if (leading.length && argv[offset] !== undefined && !argv[offset]!.startsWith("--")) argv = [...argv.slice(offset), ...leading];
  // Native capture and the MCP server retain their existing surfaces and attribution.
  if (argv[0] === "hook" || argv[0] === "ingest" || argv[0] === "mcp") return runCliCommand(argv, context);
  const env = context.env ?? process.env, marked = agentMarked(env);
  const peer = !marked ? "person" : env.AGENTHUB_PEER_ID !== undefined ? env.AGENTHUB_PEER_ID || "agent"
    : env.CLAUDECODE !== undefined || env.CLAUDE_CODE_SESSION_ID !== undefined ? "claude" : env.CODEX_THREAD_ID !== undefined ? "codex" : "pi";
  return withCliAttribution({ actor: marked ? "agent" : "person", peer, policy: () => configuredPolicy(memoryHome(), context.cwd ?? process.cwd()) }, async () => {
    const output = await runCliCommand(argv, context);
    if (marked && !argv.includes("--help") && !["--version", "version", "--help", "help", "completion"].includes(argv[0] ?? "")) {
      const parsed = parseCommand(argv);
      // Audit outputs and review targets are screened whole for marked reads.
      if (parsed.definition.mutates !== undefined || parsed.path[0] === "setup" || parsed.path[0] === "eval" && parsed.path[1] === "audit" || parsed.path[0] === "review" && parsed.path[1] === "targets") {
        let receipt: unknown = output;
        // Import receipts contain fixed counters named `pii`; they are not row privacy flags.
        // Screen the complete rendered receipt, including every key and value, as text.
        if (!(parsed.path[0] === "import" && parsed.path[1] === "claude-mem")) {
          try { receipt = JSON.parse(output); } catch { /* human receipts remain strings */ }
        }
        try { assertAgentAdministrative(receipt, configuredPolicy(parsed.path[0] === "setup" ? memoryHome({ ...process.env, ...env }) : memoryHome(), context.cwd ?? process.cwd())); }
        catch (error) {
          if (markedReadOnly(parsed) && !(error instanceof ReadPolicyWithheld)) throw error;
          // A score leaves nothing behind, so an output the policy refuses refuses the read; a sample has written its private sheet already, and withholding
          // the receipt reports exactly that without naming the file.
          if (parsed.path[0] === "eval" && parsed.path[2] === "score") throw Error(AUDIT_SCORE_REFUSED);
          if (markedReadOnly(parsed)) throw new ReadPolicyWithheld();
          // The command returned successfully: withholding its receipt cannot undo its effects.
          const failed = receipt !== null && typeof receipt === "object" && "ok" in receipt && receipt.ok === false;
          return parsed.options["--json"] === true ? JSON.stringify({ ok: !failed, completed: !failed, receiptWithheld: true })
            : failed ? "Operation did not complete; receipt withheld by policy. Inspect state before retrying." : "Operation completed; receipt withheld by policy. Run amem status to inspect state.";
        }
      }
    }
    return output;
  }).catch(async (error: unknown) => {
    // Preserve the authoritative partial outcome, without exposing a cause or a withheld target.
    if (marked && error instanceof DecayApplyError) {
      let readable = false;
      try { readable = configuredPolicy(memoryHome(), context.cwd ?? process.cwd()).screenStandalone(error.report); } catch { /* Withhold if policy is unavailable. */ }
      if (!readable) throw new CliPartialApplyError(error.applied.length, error.jsonOutput);
      const safe = new DecayApplyError(error.report, undefined); safe.jsonOutput = error.jsonOutput; throw safe;
    }
    // Data-free errors (decided before any store or file is opened) keep their own message.
    // #590 H7: a CommandUsageError is decided from argv words before any store access, so it stays a usage error.
    if (marked && (error instanceof AgentUsageError || error instanceof CommandUsageError || error instanceof AgentReadFailure || error instanceof AgentReadAmbiguous)) throw error;
    if (marked && error instanceof RemoteRealmRefusal) throw error;
    // The checkpoint pending message is a fixed data-free remedy shared by journal and writer guards.
    if (marked && error instanceof Error && error.message === PLACEMENT_CHECKPOINT_PENDING_MESSAGE) throw new Error(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
    // #326: the audit score refusal is a fixed cause-class string that names no matched value.
    if (marked && error instanceof Error && error.message === AUDIT_SCORE_REFUSED) throw new Error(AUDIT_SCORE_REFUSED);
    // #288 step 3: checkpoint refusals are fixed cause-and-next-step strings with numbers only (no path, row or project).
    if (marked && error instanceof Error && error.name === "PlacementCheckpointError" && error instanceof (await import("./memory/sync-placement-checkpoint-person.ts")).PlacementCheckpointError) throw new Error(error.message);
    // #578 Q3: a placement fence refusal is a fixed cause class and next step (no path, pid, row or project).
    if (marked && error instanceof Error && error.name === "PlacementInventoryFenceError" && error instanceof (await import("./memory/sync-placement-activation-locks.ts")).PlacementInventoryFenceError) throw new Error(error.message);
    const recovery=marked?safeProfileLockMessage(error):undefined;if(recovery)throw new Error(recovery);
    // #520/#551: a placement refusal keeps its fixed data - the receipt case its target and remedy, every other case its
    // category, cause class and remedy - so a marked session prints that instead of the masked line. Every other placement
    // and sync failure keeps the generic masked refusal below.
    if (marked) {
      const refusal = (await import("./sync-placement-writer-context.ts")).placementWriterRefusalText(error);
      if (refusal) throw new Error(refusal);
    }
    if (marked) {
      // parseCommand is pure: when it rejects argv, the error it raised is a usage error, not memory data.
      let usage: Error | undefined, parsed: ReturnType<typeof parseCommand> | undefined;
      try { parsed = parseCommand(argv); } catch (parseError) { usage = parseError as Error; }
      if (usage) throw Object.assign(new Error(usage.message), (error as { exitCode?: number }).exitCode === undefined ? {} : { exitCode: (error as { exitCode?: number }).exitCode });
      const setupError = parsed && markedSetupApplyError(parsed, error);
      if (setupError) throw setupError;
      if (parsed && markedReadOnly(parsed)) {
        if (error instanceof ReadPolicyWithheld) throw error;
        if (error instanceof Error && error.message === "Memory operation unavailable or refused; no partial result is shown.") throw Error(error.message);
        throw new AgentReadFailure();
      }
    }
    // Marked administrative failures must not reveal a target's private state or native errors.
    if (marked) throw Error("Memory operation unavailable or refused; no partial result is shown.");
    throw error;
  }).then(output => {
    // Preserve the value and the policy-screened result; only the JSON presentation changes.
    try {
      const parsed = parseCommand(argv);
      if (parsed.options["--help"] === true || argv.includes("--help")) return output;
      if (parsed.options["--json"] === true) return JSON.stringify(JSON.parse(output), null, 2);
      // #590: status and doctor wrap through the Report builder at the same width, so a continuation aligns under its value.
      const rendered = receiptText(output, parsed, context);
      if (marked && rendered !== output && !configuredPolicy(memoryHome(), context.cwd ?? process.cwd()).screenStandalone(rendered)) return "Operation completed; receipt withheld by policy. Run amem status to inspect state.";
      return rendered;
    } catch { /* Help and non-JSON special commands keep their existing output. */ }
    return output;
  });
}
/**
 * Every lazily imported module outside the CLI-only commands (relative to this file), loaded at `amem mcp` start (#199). A later `import()`
 * then hits the module cache, so an install replaced in place under a running server never mixes two versions in one process.
 * `test/coexistence.test.ts` fails when a new lazy import is neither listed here nor named there as CLI-only.
 */
export const MCP_PRELOAD = ["./memory/store.ts", "./memory/capture.ts", "./memory/sync.ts", "./memory/shard-sync.ts", "./memory/public-prune-advance.ts"] as const;
// The boundary check admits only literal specifiers, so the list above is spelled out again here; the test compares the two.
const preloadMcp = () => Promise.all([import("./memory/store.ts"), import("./memory/capture.ts"), import("./memory/sync.ts"), import("./memory/shard-sync.ts"), import("./memory/public-prune-advance.ts")]);
async function runCliCommand(argv: readonly string[], context: CliContext): Promise<string> {
  if (argv[0] === "mcp" && !argv.includes("--help")) {
    parseCommand(argv);
    const env = context.env ?? process.env, base = memoryHome(env), peaks = createPeakTracker();
    try {
      const peak = processPeakRssKB();
      if (peak !== undefined) appendMetricsLater(base, [{ at: new Date().toISOString(), kind: "mcp-phase", tool: "startup", wallMs: performance.now(), rssMB: peak / 1024, peakRaised: true }]);
    } catch { /* telemetry is optional */ }
    const preloadDone = observeMcpPhase(base, peaks, "preload");
    try { await preloadMcp(); } finally { preloadDone(); }
    // #323: a host that knows the proposing session passes it; the CLI keys it like capture does, so a candidate points at the same session rows.
    const originSession = captureSessionKey(env.AMEM_ORIGIN_SESSION), originPeer = env.AGENTHUB_PEER_ID?.trim() || undefined;
    const constructDone = observeMcpPhase(base, peaks, "construct");
    let memory: ReturnType<typeof createMemoryMcp>;
    try { memory = createMemoryMcp({ cwd: context.cwd ?? process.cwd(), base, peaks,
      ...(originSession || originPeer ? { origin: () => ({ ...(originSession ? { session: originSession } : {}), ...(originPeer ? { peer: originPeer } : {}) }) } : {}) }); } finally { constructDone(); }
    await serveMcp({ tools: memory.tools, close: memory.close, onEmitted: memory.onEmitted, version: VERSION });
    return "";
  }
  if (argv[0] === "hook" && !argv.includes("--help")) {
    const { hookMain } = await import("./hooks.ts");
    return hookMain(argv.some(arg => arg === "--ascii" || arg === "--color" || arg.startsWith("--color=")) ? parseCommand(argv).positionals : argv.slice(1));
  }
  if (argv[0] === "ingest") {
    // Capture-only native intake: no project/home override, policy bypass or curated write capability.
    const parsed = parseCommand(argv);
    if (parsed.options["--help"] === true) return commandHelp(argv);
    const kind = parsed.positionals[0];
    if (parsed.positionals.length !== 1 || !["codex", "kimi", "pi", "qwen"].includes(kind ?? "")) throw new Error("usage: amem ingest codex|kimi|pi|qwen [--since ISO] [--json]");
    const { ingestTranscript } = await import("./ingest.ts");
    const result = await ingestTranscript(kind as IngestKind, {
      cwd: context.cwd ?? process.cwd(), base: memoryHome(context.env ?? process.env),
      ...(typeof parsed.options["--since"] === "string" ? { since: parsed.options["--since"] as string } : {}),
    });
    return parsed.options["--json"] === true ? JSON.stringify(result, null, 2) : ingestText(kind as IngestKind, result, outputStyle(context, parsed.options), reportWidth(context));
  }
  // Help and version carry no memory data.
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "version")) return `amem ${VERSION}`;
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) return commandHelp();
  if (argv[0] === "--version" || argv[0] === "version") return `amem ${VERSION}`;
  if (argv[0] === "help") {
    // #590 H7: `help <unknown>` is a usage error, not the overview.
    const words = argv.slice(1).filter(word => !word.startsWith("-"));
    if (words.length && commandPath(argv.slice(1)).length < words.length) throw new CommandUsageError(`unknown command ${words.join(" ")}`);
    return commandHelp(argv.slice(1));
  }
  if (argv[0] === "--help" || argv.includes("--help")) return commandHelp(argv);
  let parsed;
  try {
    parsed = parseCommand(argv);
    // #590 H7: these groups do nothing bare (eval and capacity run their own report; spool and eval audit name their usage themselves).
    if (["project", "skills", "formats", "note", "import"].includes(parsed.path.join(" "))) throw new CommandUsageError(`amem ${parsed.path.join(" ")} needs a command`);
    if (parsed.path[0] === "version") return `amem ${VERSION}`;
    if (parsed.path[0] === "manifest") return JSON.stringify(manifest(), null, parsed.options["--json"] === true ? undefined : 2);
    if (parsed.path[0] === "completion") {
      if (parsed.positionals.length !== 1) throw new Error("usage: amem completion zsh|bash|fish");
      return completionScript(parsed.positionals[0]!);
    }
  } catch (error) {
    if (argv.find(arg => !arg.startsWith("--")) === "completion") Object.assign(error as Error, { exitCode: 2 });
    throw error;
  }
  const { definition, options, rawArgs: args } = parsed;
  const identity = cliAttribution() ?? { actor: "person" as const, peer: "person" }, actor = identity.actor;
  if (parsed.path[0] === "migrate" && options["--sync-placement"] === true) {
    const modes = ["--dry-run","--apply","--resume","--abandon","--deactivate"].filter(key=>options[key]===true);
    if (modes.length>1 || parsed.positionals.length || ["--shards","--public-prune-view","--generation","--deactivate"].some(key=>options[key]!==undefined))
      throw new AgentUsageError("Sync placement is a home-wide forward-only migration; use only --sync-placement with --dry-run, --apply, --resume or pre-marker --abandon and the writer roots, never combine migration families or deactivate.");
    if (options["--list-remote"] === true && (modes.length || options["--admit"] !== undefined || options["--from-remote"] === true || options["--writer-root"] !== undefined || options["--confirm"] === true || options["--checkpoint"] === true || options["--plan"] !== undefined))
      throw new AgentUsageError("Remote realm listing uses only --sync-placement --list-remote and optional --json.");
    if (options["--from-remote"] === true && options["--admit"] === undefined)
      throw new AgentUsageError("--from-remote requires --sync-placement --admit <project>.");
    if (options["--checkpoint-on-bound"] !== undefined) {
      if (modes.length || ["--checkpoint","--admit","--list-remote","--from-remote","--writer-root","--plan"].some(key=>options[key]!==undefined) || !["on","off"].includes(String(options["--checkpoint-on-bound"])))
        throw new AgentUsageError("The sync-run checkpoint opt-in uses only --sync-placement --checkpoint-on-bound on|off, previewing by default and writing with --confirm.");
    } else if (options["--checkpoint"] === true) {
      // #288 step 3: preview (default), --confirm --plan, --resume or --abandon; one mode at a time.
      const chosen = [options["--confirm"] === true, options["--resume"] === true, options["--abandon"] === true].filter(Boolean).length;
      if (options["--admit"] !== undefined || options["--list-remote"] === true || options["--from-remote"] === true || options["--apply"] === true || options["--dry-run"] === true || chosen > 1 || (options["--confirm"] === true) !== (options["--plan"] !== undefined)
        || (options["--resume"] === true || options["--abandon"] === true) && options["--writer-root"] !== undefined)
        throw new AgentUsageError("A placement checkpoint uses --sync-placement --checkpoint --writer-root <install root> (repeat) to preview, then --confirm --plan <saved preview JSON> with the same writer roots, or --resume / --abandon alone.");
    } else if (options["--plan"] !== undefined) {
      throw new AgentUsageError("--plan applies only to --sync-placement --checkpoint --confirm.");
    } else if (options["--admit"] !== undefined) {
      if (options["--writer-root"] !== undefined || options["--confirm"] === true && options["--abandon"] !== true)
        throw new AgentUsageError("Admitting one realm uses only --sync-placement --admit <project> with --dry-run, --apply, --resume or --abandon --confirm; writer roots belong to initial activation.");
    } else if (options["--confirm"] === true) {
      throw new AgentUsageError("--confirm applies only to --sync-placement --admit <project> --abandon or --sync-placement --checkpoint --plan <file>; other placement modes keep their own confirmation.");
    }
  } else if (parsed.path[0] === "migrate" && (options["--writer-root"] !== undefined||options["--abandon"]!==undefined||options["--admit"]!==undefined||options["--list-remote"]!==undefined||options["--from-remote"]!==undefined||options["--checkpoint"]!==undefined||options["--plan"]!==undefined)) {
    throw new AgentUsageError("--writer-root, --abandon, --admit, --list-remote, --from-remote, --checkpoint and --plan apply only to --sync-placement; run amem migrate --sync-placement --dry-run to review the inventory.");
  }
  if (parsed.path[0] === "skills" && parsed.path[1] === "export") {
    if (parsed.positionals.length !== 1) throw new Error("usage: amem skills export <dir> [--json]");
    const { exportSkills } = await import("./skills-install.ts");
    const destination = parsed.positionals[0]!;
    const report = exportSkills(destination.trim() ? resolve(context.cwd ?? process.cwd(), destination) : destination, { env: context.env ?? process.env });
    if (report.actions.some(a => ["refused", "foreign", "modified"].includes(a.change)) && !report.actions.some(a => a.change === "install" || a.change === "replace")) context.onExitCode?.(1);
    if (options["--json"] === true) return JSON.stringify(report, null, 2);
    return [`amem skills export: ${report.root}${report.linkedFrom ? ` (linked from ${report.linkedFrom})` : ""}`, "NAME                 CHANGE     PATH / REASON", ...report.actions.map(a => `${a.name.padEnd(20)} ${a.change.padEnd(10)} ${a.path}${a.reason ? ` / ${a.reason}` : ""}`)].join("\n");
  }
  if (parsed.path[0] === "setup") {
    if (parsed.positionals.length !== 1 || options["--apply"] === true && options["--undo"] === true
      || options["--adopt-current"] === true && (options["--apply"] !== true || parsed.positionals[0] === "console")) throw new Error("usage: amem setup claude|codex|kimi|pi|qwen|jcode|opencode|gemini|agy|all|console [--root <abs path>] [--apply [--adopt-current]|--undo]");
    if (parsed.positionals[0] === "console") {
      const { consoleSetup, consoleSetupText } = await import("./setup-console.ts");
      const mode = options["--apply"] === true ? "apply" : options["--undo"] === true ? "undo" : "preview";
      const root = typeof options["--root"] === "string" ? (await import("./setup.ts")).installRoot(options["--root"]).path : undefined;
      const result = root === undefined ? consoleSetup(mode, context.env ?? process.env) : consoleSetup(mode, context.env ?? process.env, join(root, "src", "ui", "plugin.ts"));
      return options["--json"] === true ? JSON.stringify(result, null, 2) : consoleSetupText(result, mode);
    }
    const { runSetup } = await import("./setup.ts");
    return runSetup(parsed.positionals[0]!, options["--apply"] === true ? "apply" : options["--undo"] === true ? "undo" : "preview", {
      env: context.env ?? process.env, stdinTTY: context.stdinTTY ?? process.stdin.isTTY, cwd: context.cwd ?? process.cwd(),
      ...(typeof options["--root"] === "string" ? { root: options["--root"] } : {}),
      ...(options["--adopt-current"] === true ? { adoptCurrent: true } : {}),
      ...(context.setupConfirm ? { confirm: context.setupConfirm } : {}), json: options["--json"] === true, style: outputStyle(context, options), columns: reportWidth(context), verbose: options["--verbose"] === true,
    });
  }
  if (identity.actor === "agent") {
    const read = await agentCliRead(parsed, argv, { ...context, columns: reportWidth(context) ?? 80, style: options["--json"] === true ? PLAIN : outputStyle(context, options) });
    if (read !== undefined) return read;
  }
  const goal = parsed.path[0] === "goal", review = parsed.path[0] === "review", sub = goal || review ? parsed.path[1]! : parsed.path[0]!;
  const policyFree = options["--policy-free"] === true;
  const mutating = definition.mutates === true || definition.mutates === "apply" && options["--apply"] === true || definition.mutates === "label" && options["--label"] !== undefined
    || definition.mutates === "confirm" && options["--confirm"] === true;
  // F4: the configured policy (the machine's `amem.config.json`, narrowed by the repository's `.amem/config`) applies to every command that used to need
  // `--policy-free`. The flag is still accepted and means nothing more, so existing scripts keep working.
  const policyCwd = context.cwd ?? process.cwd();
  const policyOf = () => configuredPolicy(memoryHome(), policyCwd);   // the same home every other command here resolves
  const administrative = <T>(value: T): T => { assertAgentAdministrative(value, policyOf()); return value; };
  // Reformat only after the prior human receipt passes the same whole-output screen.
  const screenedLegacy = (legacy: string, formatted: string): string => actor === "agent" && !policyOf().screenStandalone(legacy) ? legacy : formatted;
  // #590 task 429: a mutating command's receipt in a marked session; a denial of either text keeps the existing withheld-receipt line.
  const screenedReceipt = (legacy: string, formatted: string): string =>
    actor === "agent" && (!policyOf().screenStandalone(legacy) || !policyOf().screenStandalone(formatted)) ? "Operation completed; receipt withheld by policy. Run amem status to inspect state." : formatted;
  const screenedReadPair = (legacy: string, formatted: string): string => {
    if (actor === "agent" && (!policyOf().screenStandalone(legacy) || !policyOf().screenStandalone(formatted))) throw new ReadPolicyWithheld();
    return formatted;
  };
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
  // #217 PR2: pure argument refusals for spool replay run first, before the administrative policy read touches the home.
  if (sub === "spool") assertSpoolReplayArguments(parsed.path, options);
  if (["migrate", "prune", "capacity", "gc", "project", "alias", "machine", "sync", "import", "dedupe", "consolidate", "spool"].includes(sub)) administrative({ command: parsed.path, arguments: args });
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
      const readRecords = recordWindow(base, project, policyCwd);
      const origin = { peer: identity.peer, at: new Date().toISOString(), ...(captureSessionKey((context.env ?? process.env).AMEM_ORIGIN_SESSION) ? { session: captureSessionKey((context.env ?? process.env).AMEM_ORIGIN_SESSION)! } : {}) };
      const report = await proposeConsolidation(store, candidates, { project, actor, origin, policy: policyOf, policyVersion: policyKey, assertCurrent, ...(readRecords ? { records: readRecords } : {}) });
      return options["--json"] ? JSON.stringify(report, null, 2) : `${report.candidates.length} consolidation candidates queued for amem review; no curated notes changed${report.records ? `; ${report.records.queued} of ${report.records.found} Record(s)${report.records.truncated ? " in the newest 32" : ""}` : ""}${report.alreadyReviewed ? `; ${report.alreadyReviewed} already reviewed` : ""}${report.truncated ? "; scan truncated" : ""}${report.oversized ? `; ${report.oversized} proposals too large` : ""}${report.localExcluded ? `; ${report.localExcluded} local sources excluded` : ""}`;
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
      store.prepareCuratedBriefs([project]);
      return options["--json"] ? JSON.stringify({ brief: result.text, bytes: result.bytes, truncated: result.truncated, state: result.state }, null, 2) : result.text;
    } finally { store.close(); }
  }
  if ((options["--history"] === true || options["--as-of"] !== undefined) && (options["--all-projects"] === true || options["--tier"] === "repo")) throw Error("historical recall selects this active project's curated store; cross-project/repo history is unavailable");
  if (sub === "migrate") {
    const modes = ["--apply", "--dry-run", "--resume", "--abandon", "--deactivate"].filter(key => options[key] === true);
    if (modes.length > 1) throw new Error("migration modes are mutually exclusive");
    const mode = options["--apply"] ? "apply" : options["--resume"] ? "resume" : options["--deactivate"] ? "deactivate" : "dry-run";
    if (options["--sync-placement"] === true) {
      if (options["--list-remote"] === true) {
        const { discoverRemotePlacementRealms } = await import("./memory/sync-placement-transport.ts");
        const realms = await discoverRemotePlacementRealms(memoryHome(), { ...(context.visibility ? { visibility: context.visibility } : {}) });
        const nextStep = "amem migrate --sync-placement --admit <project> --from-remote --dry-run";
        return options["--json"] === true ? JSON.stringify({ realms, nextStep }, null, 2) : `${realms.map(realm => `scope=${realm.scope} keyHash=${realm.keyHash}; next ${nextStep}`).join("\n") || "no remote-only placement realms"}`;
      }
      if (options["--checkpoint-on-bound"] !== undefined) {
        const { checkpointOnBoundOptInChange } = await import("./memory/sync-placement-opt-in.ts");
        const r = checkpointOnBoundOptInChange(memoryHome(), options["--checkpoint-on-bound"] === "on", options["--confirm"] === true);
        return options["--json"] === true ? JSON.stringify(r, null, 2) : r.text;
      }
      if (options["--checkpoint"] === true) {
        const person = await import("./memory/sync-placement-checkpoint-person.ts");
        const writerRoots = repeated(argv, "--writer-root"), ownRoot = fileURLToPath(new URL("..", import.meta.url));
        // #567: a retained-history refusal names its cause class (and, for bound, its counts) in --json as a failed result
        // with exit 1. Human output keeps the thrown fixed message, which already carries the cause and next step.
        const historyJson = (error: unknown): string => {
          if (options["--json"] === true && error instanceof person.PlacementCheckpointError && error.causeClass === "history" && error.history) {
            context.onExitCode?.(1);
            return JSON.stringify({ ok: false, refusal: error.history, message: error.message, nextStep: error.history.cause === "bound" ? "retain the history; a window this large needs the multi-plan checkpoint work (#288)" : person.CHECKPOINT_PREVIEW }, null, 2);
          }
          throw error;
        };
        if (options["--resume"] === true) { const r = await person.resumePlacementCheckpointPerson(memoryHome()); return options["--json"] === true ? JSON.stringify(r, null, 2) : `sync placement checkpoint: ${r.resumed ? "resumed" : "nothing pending"}; window ${r.window}\nnext: ${r.nextStep}\n`; }
        if (options["--abandon"] === true) { const r = await person.abandonPlacementCheckpointPerson(memoryHome()); return options["--json"] === true ? JSON.stringify(r, null, 2) : `sync placement checkpoint: ${r.abandoned ? `abandoned (${r.removed} staged files removed)` : "nothing pending"}\nnext: ${r.nextStep}\n`; }
        if (options["--confirm"] === true) {
          let saved: unknown;
          try { saved = JSON.parse(readPrunePlanFile(String(options["--plan"]), undefined, 4 * 1024 * 1024)); } catch { throw new Error("The checkpoint --plan file is unreadable or not the saved preview JSON; rerun amem migrate --sync-placement --checkpoint --json with the writer roots and save its output."); }
          const r = await person.confirmPlacementCheckpoint(memoryHome(), saved, { writerRoots, ownRoot }).catch(historyJson);
          if (typeof r === "string") return r;
          return options["--json"] === true ? JSON.stringify(r, null, 2) : `sync placement checkpoint: committed window ${r.window} with one writer renewal (plan ${r.planHash})\nnext: ${r.nextStep}\n`;
        }
        const preview = await person.previewPlacementCheckpoint(memoryHome(), { writerRoots, ownRoot }).catch(historyJson);
        if (typeof preview === "string") return preview;
        if (options["--json"] === true) return JSON.stringify(preview, null, 2);
        const { placementJournalObjectCompositionText } = await import("./memory/sync-placement-journal-storage.ts"), h = preview.headroom;
        // Counts and hashes only; the sealed plan itself is in --json for the confirm step.
        return `sync placement checkpoint preview: window ${preview.window} -> ${preview.nextWindow}; ${preview.currentObjects} of ${h.limit} live objects now\n`
          + `${placementJournalObjectCompositionText(preview.journalObjects)}\n`
          + `completed plan: ${h.completedPlan.slots} slots + ${h.completedPlan.reservedJournalChunks} reserved journal chunks; prospective plan: ${h.prospectivePlan.state === "cache-only" ? `${h.prospectivePlan.slots} slots + ${h.prospectivePlan.reservedJournalChunks} reserved journal chunks (cache-only; remote may have changed)` : h.prospectivePlan.state === "none" ? "none" : "unavailable without current remote evidence; using completed history"}\n`
          + `headroom after checkpoint: ${h.remaining} of ${h.limit} (live ${h.liveAfter}, next renewal ${h.nextRenewal}, largest plan ${h.largestPlan.slots} + ${h.largestPlan.reservedJournalChunks} reserved journal chunks)\n`
          + `home floor ${preview.requiredHomeFloor}: ${preview.floorReady ? "ready" : `missing; preview amem formats raise home ${preview.requiredHomeFloor}, then --confirm it`}; writers ${preview.writers}; plan ${preview.planHash}\n`
          + `next: save this preview with --json, then ${preview.nextStep}\n`;
      }
      if (options["--admit"] !== undefined) {
        const { previewRealmAdmission, planRealmAbandon, applyRealmAdmission } = await import("./memory/sync-placement-realm-admission.ts");
        const project = String(options["--admit"]);
        const { readRemoteAdoption, inspectRemoteAdoptionPending, pendingRemoteAdoptions } = await import("./memory/sync-placement-remote-stage.ts");
        const realm = createHash("sha256").update(project).digest("hex"), recovery = options["--resume"] === true || options["--abandon"] === true;
        const pending = recovery ? pendingRemoteAdoptions(memoryHome()) : undefined;
        const remotePending = recovery && (!!readRemoteAdoption(memoryHome(), realm) || inspectRemoteAdoptionPending(memoryHome(), realm).length > 0 || !!pending?.unknown || !!pending?.hashes.includes(realm));
        if (options["--from-remote"] === true || remotePending) {
          const { remoteRealmAdmission } = await import("./memory/sync-placement-remote-admission.ts");
          const result = await remoteRealmAdmission(memoryHome(), project, { mode: options["--apply"] === true ? "apply" : options["--resume"] === true ? "resume" : options["--abandon"] === true ? "abandon" : "dry-run",
            ...(options["--confirm"] === true ? { confirm: true } : {}), ...(context.visibility ? { visibility: context.visibility } : {}) });
          if (result.state === "preview") result.nextStep = "amem migrate --sync-placement --admit <project> --from-remote --apply";
          if (options["--json"] === true) return JSON.stringify(result, null, 2);
          return `sync placement remote admission: ${result.state}; realm ${result.realm}${result.remoteHead ? `; remote head ${result.remoteHead}` : ""}${result.omitted !== undefined ? `; omitted ${result.omitted}` : ""}${result.nextStep ? `; next ${result.nextStep}` : ""}\n`;
        }
        const result = options["--apply"] === true ? await applyRealmAdmission(memoryHome(), project, { mode: "apply" })
          : options["--resume"] === true ? await applyRealmAdmission(memoryHome(), project, { mode: "resume" })
          : options["--abandon"] === true ? options["--confirm"] === true ? await applyRealmAdmission(memoryHome(), project, { mode: "abandon", confirm: true })
            : planRealmAbandon(memoryHome(), project)
          : previewRealmAdmission(memoryHome(), project);
        if (options["--json"] === true) return JSON.stringify(result, null, 2);
        // Identifiers and counts only: the named project key never reaches output.
        return `sync placement realm admission: ${result.state}; realm ${result.realm}${realmAdmissionDetail(result)}\n`;
      }
      const { activateSyncPlacement } = await import("./memory/sync-placement-activation.ts");
      const result = await activateSyncPlacement({ memoryDir:memoryHome(),mode:options["--abandon"]?"abandon":mode as "dry-run"|"apply"|"resume",
        writerRoots:repeated(argv,"--writer-root"),ownRoot:fileURLToPath(new URL("..",import.meta.url)),
        authorize:()=>true });
      if (options["--json"] === true) return JSON.stringify(result,null,2);
      // Metadata only: the source reader and locator are never serialized into this receipt.
      return `sync placement: ${result.mode}; ${result.active?"active":"inactive"}; home-wide, forward-only (no deactivate)\n${JSON.stringify(result,null,2)}`;
    }
    const common = { memoryDir: memoryHome(), ...(options["--generation"] ? { generation: String(options["--generation"]) } : {}), authorizedPerson: true, tty: true };
    if (options["--public-prune-view"] === true) {
      if (options["--deactivate"] || options["--generation"] || options["--shards"]) throw new Error("public prune view is forward-only on an active split; no deactivate, generation replacement or new split");
      if (actor === "agent" && mode !== "dry-run") administrative({ command: "migrate --public-prune-view", mode });
      const result = await activatePublicPruneView({ memoryDir: memoryHome(), mode: mode as "dry-run" | "apply" | "resume", authorizedPerson: true, tty: true });
      return options["--json"] ? JSON.stringify(result, null, 2) : `public prune view: ${result.mode}; generation ${result.generation}; mask build ${result.maskBuildCheck}; forward-only, no deactivation`;
    }
    const shardRequested = options["--shards"] === true || (mode === "resume" && shardStatePresent());
    if (shardRequested) {
      if (mode === "deactivate") throw new Error("--deactivate is not a shard migration mode");
      if (actor === "agent" && mode !== "dry-run") administrative(await migrateShards({ ...common, mode: "dry-run" }));
      const result = await migrateShards({ ...common, mode });
      return options["--json"] ? JSON.stringify(result, null, 2) : (mode === "dry-run" ? screenedReadPair : screenedReceipt)(shardMigrationText(result, outputStyle(context, options)), reports.shardMigrateReportText(result, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
    }
    if (actor === "agent" && mode === "deactivate") administrative({ target: common.memoryDir, selector: readSelector(common.memoryDir), mode });
    else if (actor === "agent" && mode !== "dry-run") administrative(await migrate({ ...common, mode: "dry-run" }));
    const result = await migrate({ ...common, mode });
    return options["--json"] ? JSON.stringify(result, null, 2) : (mode === "dry-run" ? screenedReadPair : screenedReceipt)(migrationText(result, outputStyle(context, options)), reports.migrateReportText(result, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
  }
  if (sub === "status") {
    // F1: say where the memory lives and which configuration is in effect. The migration fields keep their names and shape; `home` and `config` are added.
    const where = resolveMemoryHome(), loaded = loadAmemConfig(where.home, repoConfigRoot(policyCwd));
    const { config, source } = loaded;
    const status = { home: { path: where.home, source: where.source },
      config: { machine: source.machine, repo: source.repo, denyPaths: config.denyPaths.length, piiPatterns: config.piiPatterns.length,
        ...(config.briefBytes !== undefined ? { briefBytes: config.briefBytes } : {}), ...(config.excerptBytes !== undefined ? { excerptBytes: config.excerptBytes } : {}),
        ...(config.capturePaths !== undefined ? { capturePaths: config.capturePaths } : {}), ...(Object.keys(config.capture).length ? { capture: config.capture } : {}) },
      // F7: pending candidates, and a warning when any is within 7 days of its age expiry (a shown one is then deleted after its grace period; an unshown one is kept until it is shown).
      candidates: (() => { const bound = boundProject(), summary = pendingSummary(where.home, [bound, ...aliasedKeys(where.home, bound)], Date.now(), true);
        if (summary === null) return { unavailable: "candidates.db exists but cannot be read" };
        return { ...summary, ...(summary.dueWithin7Days ? { warning: `${summary.dueWithin7Days} candidate${summary.dueWithin7Days === 1 ? "" : "s"} within 7 days of expiry: run \`amem review walk\`` } : {}) }; })(),
      ...shardMigrationStatus(where.home) };
    return options["--json"] ? JSON.stringify(status, null, 2) : statusText(status as unknown as StatusView, outputStyle(context, options), reportOptions(context, options));
  }
  if (parsed.path[0] === "formats" && parsed.path[1] === "raise") {
    const { planFormatRaise, applyFormatRaise, formatRaiseRefusal, installVersion, runningAmemRoots } = await import("./memory/formats-raise.ts");
    const { readSetupWriterRoots } = await import("./setup.ts"), { readEffectiveSyncPlacementWriterRoots } = await import("./memory/sync-placement-effective-writers.ts");
    const [surface, minReader] = parsed.positionals;
    if (!surface || !minReader || parsed.positionals.length !== 2) throw new Error("usage: amem formats raise <surface> <min-reader> [--confirm] [--json]");
    const home = realPath(memoryHome()), own = realPath(fileURLToPath(new URL("..", import.meta.url)));
    const inventory = (): import("./memory/formats-raise.ts").FormatWriterInventory => {
      const writers: import("./memory/formats-raise.ts").FormatWriter[] = [], incomplete: string[] = [], seen = new Set<string>();
      const add = (source: "setup" | "sync-placement" | "running" | "library-host" | "self", root: string, pid?: number, host?: string) => {
        let canonical = root; try { canonical = realPath(root); } catch { /* a missing root reads as an unknown version */ }
        const key = `${source}\0${canonical}\0${pid ?? ""}`; if (seen.has(key)) return; seen.add(key);
        writers.push({ source, root: canonical, version: installVersion(canonical), ...(pid !== undefined ? { pid } : {}), ...(host !== undefined ? { host } : {}) });
      };
      add("self", own);
      try { for (const root of readSetupWriterRoots(home)) add("setup", root); } catch (error) { incomplete.push(`setup receipts: ${(error as Error).message.split("\n")[0]}`); }
      if ((readPlacementRuntimeMarkers(home).profile as { publicationFormat?: string } | undefined)?.publicationFormat === "agent-mem.sync-placement/v1") {
        try { for (const root of readEffectiveSyncPlacementWriterRoots(home)) add("sync-placement", root); } catch { incomplete.push("sync-placement writer roots unreadable"); }
      }
      try {
        const table = () => (context.processTable ?? (() => require("node:child_process").execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }) as string))();
        for (const { pid, root, host } of runningAmemRoots(table, context.embeddedAmem)) add(host ? "library-host" : "running", root, pid, host);
      } catch { incomplete.push("running processes could not be listed"); }
      return { writers: writers.sort((a, b) => a.source.localeCompare(b.source) || a.root.localeCompare(b.root) || (a.pid ?? 0) - (b.pid ?? 0)), incomplete };
    };
    const now = context.now ? () => new Date(context.now!()) : undefined;
    const plan = planFormatRaise(home, surface, minReader, inventory(), now);
    if (options["--confirm"] !== true) {
      const refusal = formatRaiseRefusal(plan);
      if (options["--json"] === true) return JSON.stringify({ ...plan, refusal: refusal ?? null }, null, 2);
      const s = outputStyle(context, options), out = new Report(reportWidth(context) ?? 80, s.ascii, { sanitize: singleLine, keepTokensWhole: true });
      out.header("amem", "Format floor"); out.section("Preview"); out.bullet("pending", "Review the proposed floor before confirming.");
      out.kv([["Surface", plan.record.surface], ["Minimum reader", plan.record.minReader], ["Since", plan.record.since], ["File", plan.file], ["Existing", plan.existing.length ? plan.existing.map(floor => `${floor.surface} >= ${floor.minReader}`).join(", ") : "none"]]);
      out.section("Writers", String(plan.writers.length));
      if (plan.writers.length) out.table(["SOURCE", "VERSION", "INSTALL"], plan.writers.map(writer => [writer.source, writer.version ?? "?", `${writer.root}${writer.pid ? ` (pid ${writer.pid}${writer.host ? `, ${writer.host}` : ""})` : ""}`]), 2);
      else out.note("No writers found.");
      if (refusal) { out.section("Attention"); out.bullet("warn", refusal); }
      else out.next(`amem formats raise ${surface} ${minReader} --confirm`);
      const legacy = [`preview: append ${JSON.stringify(plan.record)} to ${plan.file}`, `existing floors: ${plan.existing.length ? plan.existing.map(floor => `${floor.surface}>=${floor.minReader}`).join(", ") : "none"}`, `writers checked (${plan.writers.length}):`, ...plan.writers.map(writer => `  ${writer.source.padEnd(14)} ${writer.version ?? "unknown"}  ${writer.root}${writer.pid ? ` (pid ${writer.pid}${writer.host ? `, ${writer.host}` : ""})` : ""}`), refusal ? `refused: ${refusal}` : `ready: rerun with --confirm to append the record`].join("\n");
      return screenedLegacy(legacy, out.render(s.color).join("\n"));
    }
    const record = applyFormatRaise(plan, () => planFormatRaise(home, surface, minReader, inventory(), now));
    if (options["--json"] === true) return JSON.stringify({ appended: record, file: plan.file }, null, 2);
    const s = outputStyle(context, options), out = new Report(reportWidth(context) ?? 80, s.ascii, { sanitize: singleLine });
    out.bullet("ok", `Appended ${record.surface} minimum reader ${record.minReader} to ${plan.file}.`);
    return screenedLegacy(`appended ${JSON.stringify(record)} to ${plan.file}`, out.render(s.color).join("\n"));
  }
  if (sub === "doctor") {
    // F15: one read-only report; see src/memory/doctor.ts for exactly what "read-only" covers.
    const where = resolveMemoryHome(), project = boundProject();
    const report = await doctorReport({ home: where.home, homeSource: where.source, cwd: policyCwd, project, aliases: aliasedKeys(where.home, project), now: Date.now(),
      openCurated: base => curatedStoreAt(base, project, { deferPromotions: true }) });
    return options["--json"] ? JSON.stringify(report, null, 2) : doctorText(report, outputStyle(context, options), reportOptions(context, options));
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
      const auth = { project, actor, authorize: () => true };
      const port = store.prunePort();
      let plan: ReturnType<typeof planPrune>;
      if (applying) { try { plan = JSON.parse(input!) as ReturnType<typeof planPrune>; } catch { throw Error("prune plan unavailable or oversized"); } }
      else plan = planPrune(port, { cutoff: String(options["--cutoff"]) }, auth);
      administrative(plan);
      if (actor === "agent") {
        const ids = new Set(plan.rows?.flatMap(row => row.payload.targets.map(target => target.id)) ?? []);
        administrative(port.snapshot().rows.filter(source => ids.has(source.row.id)).map(source => source.row));
      }
      const result = applying ? applyPrune(port, input, auth) : plan;
      return options["--json"] ? JSON.stringify(result, null, 2) : (applying ? screenedReceipt : screenedReadPair)(pruneText(result, outputStyle(context, options)), reports.pruneReportText(result, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
    } finally { store.close(); }
  }
  if (sub === "decay") {
    const applying = options["--apply"] === true && options["--confirm"] === true;
    if (options["--confirm"] === true && options["--apply"] !== true) throw new Error("decay --confirm requires --apply");
    const { decayPreview, applyDecay, readDecayCounters, DECAY_DEFAULT_DAYS, assertExactDecayForget, unusedInjectionTargets } = await import("./memory/decay-review.ts");
    const project = boundProject(), base = memoryHome(), aliases = aliasedKeys(base, project);
    const store = curatedStore(project, { deferPromotions: true, screen: note => policyOf().screenStandalone(note) ? "promote" : "keep" });
    try {
      const assertCurrent = commandBinding(store.profile.home, project);
      if (options["--propose"] === true) {
        if (options["--apply"] || options["--confirm"] || options["--forget"] || options["--days"] || parsed.positionals.length) throw Error("decay --propose cannot be combined with apply, age or ids; run it alone to queue candidates");
        const { readReviewSnapshot, REVIEW_DEFAULTS } = await import("./memory/review-targets.ts");
        const settings = loadAmemConfig(base, repoConfigRoot(policyCwd)).config.review;
        const candidates = new CandidateStore({ memoryDir: base, reconcile: { canonical: project, aliases } });
        try {
          const targets = unusedInjectionTargets(store, project, readReviewSnapshot(base, [project, ...aliases]), { now: store.readNow(), days: settings?.unused_days ?? REVIEW_DEFAULTS.unused_days, threshold: settings?.unused_rendered ?? REVIEW_DEFAULTS.unused_rendered, aliases, screen: view => policyOf().screenStandalone(view), exclude: target => candidates.get(candidateInputId({ project, kind: "decay", target, reason: UNUSED_INJECTION_REASON }), project) !== undefined });
          assertCurrent();
          for (const entry of targets) candidates.put({ project, kind: "decay", target: entry.target, reason: UNUSED_INJECTION_REASON }, "public");
          const receipt = { unusedInjection: targets.length };
          return options["--json"] ? JSON.stringify(receipt) : `queued ${targets.length} unused-injection decay candidates; review with amem review list`;
        } finally { candidates.close(); }
      }
      const selected = parsed.positionals.length ? parsed.positionals : undefined;
      if (options["--days"] !== undefined && !/^[1-9][0-9]*$/.test(String(options["--days"]))) throw new Error("decay days must be a positive decimal integer");
      const days = options["--days"] === undefined ? DECAY_DEFAULT_DAYS : Number(options["--days"]);
      const settings = { days, ...(selected ? { ids: selected } : {}), aliases, counters: () => readDecayCounters(base, [project, ...aliases]) };
      const current = { ...settings, screen: (note: import("./memory/store.ts").View) => policyOf().screenStandalone(note), assertCurrent };
      const preview = administrative(decayPreview(store, project, current)), action = options["--forget"] === true ? "FORGET" : "demote";
      const display = [`${action} preview: ${preview.entries.length} notes older than ${days} days; citation history unknown (${preview.citedExemptions ?? "unknown"} observed retained-positive exemptions)${preview.truncated ? "; truncated" : ""}`,
        ...preview.entries.map(entry => `${entry.target.id}  revision ${entry.target.revision}  ${entry.view.at}  ${entry.view.kind}: ${terminalSafe(entry.view.title ?? entry.view.text)}`)].join("\n");
      if (!applying) return options["--json"] ? JSON.stringify(preview, null, 2) : screenedReadPair(display, reports.decayReportText({ kind: "preview", plan: preview, action }, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
      if (!preview.entries.length) return options["--json"] ? JSON.stringify({ action, ids: [] }) : screenedReadPair("no eligible notes to apply", reports.decayReportText({ kind: "empty" }, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
      if (options["--forget"] === true) assertExactDecayForget(store, preview.entries.map(entry => entry.target.id), project);
      assertCurrent();
      const result = applyDecay(store, preview, { ...current, actor, confirmed: true, forget: options["--forget"] === true });
      return options["--json"] ? JSON.stringify(result, null, 2) : screenedReceipt(`${result.action}: ${result.ids.length} entries${result.expiresAt ? `; expires ${result.expiresAt}` : ""}`, reports.decayReportText({ kind: "applied", ...result }, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
    } catch (error) { if (error instanceof DecayApplyError) error.jsonOutput = options["--json"] === true; throw error; }
    finally { store.close(); }
  }
  if (sub === "note") {
    // F6: the person writes a curated note. Current attribution and configured policy apply to the complete note.
    const env = context.env ?? process.env, edit = (initial: string) => {
      if (!(context.stdinTTY ?? process.stdin.isTTY)) throw Error("note editor requires a terminal on stdin; provide text or - for non-interactive input");
      return (context.edit ?? ((value: string) => runEditor(env, value)))(initial);
    };
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
    if (sub === "targets") {
      const { reviewTargets, readReviewSnapshot, reviewUse, noRecentReview, REVIEW_DEFAULTS } = await import("./memory/review-targets.ts");
      const base = memoryHome(), bound = boundProject(), project = options["--project"] === undefined ? bound : resolveAlias(base, String(options["--project"]));
      if (project !== bound) throw Error("review targets can screen only the current project's policy; run it from that project's checkout");
      const rawLimit = options["--limit"] === undefined ? "50" : String(options["--limit"]);
      if (!/^[1-9][0-9]*$/.test(rawLimit) || Number(rawLimit) > 500) throw Error("review targets --limit must be from 1 to 500; pass a limit in that range");
      const aliases = aliasedKeys(base, project), snapshot = readReviewSnapshot(base, [project, ...aliases]);
      const store = openCuratedForRead(base, project);
      if (!store) {
        if (options["--json"]) return "[]";
        const s = outputStyle(context, options), out = new Report(reportWidth(context) ?? 80, s.ascii, { sanitize: singleLine });
        out.header("amem", "Review targets"); out.section("Entries", "0"); out.line("  No review targets.");
        return screenedLegacy("no review targets", out.render(s.color).join("\n"));
      }
      try {
        const policy = policyOf(), root = boundRepoRoot(policyCwd, base, project), stale = createRecallStalenessProbe({ cwd: root ?? policyCwd, rootConfirmed: root !== undefined, policy: () => policy });
        const settings = loadAmemConfig(base, repoConfigRoot(policyCwd)).config.review;
        const rows = store.withDeferredPromotions(() => store.list({ project, limit: 5000 })).filter(row => actor !== "agent" || policy.screenStandalone(row));
        const result = reviewTargets(rows, { now: store.readNow(), recheckDays: settings?.recheck_days ?? REVIEW_DEFAULTS.recheck_days, limit: Number(rawLimit), stale,
          use: row => reviewUse(snapshot, [project, ...aliases], row.id), eligibleForRecheck: (row, cutoff) => noRecentReview(snapshot, row.id, cutoff) });
        if (options["--json"]) return JSON.stringify(result, null, 2);
        const s = outputStyle(context, options), out = new Report(reportWidth(context) ?? 80, s.ascii, { sanitize: singleLine });
        out.header("amem", "Review targets"); out.section("Entries", String(result.length));
        if (result.length) { out.table(["ID", "REASON", "AGE", "RENDERED", "DELIVERED", "CITED"], result.map(row => [row.id.slice(0, 16), row.reason, `${row.ageDays} d`, String(row.counts.rendered ?? "?"), String(row.counts.delivered ?? "?"), String(row.counts.cited ?? "?")]), 1); out.note("Full entries: amem show <id> or --json."); }
        else out.line("  No review targets.");
        const legacy = result.length ? result.map(row => `${row.id}  ${row.reason}  ${row.ageDays}d  rendered ${row.counts.rendered ?? "unknown"} delivered ${row.counts.delivered ?? "unknown"} cited ${row.counts.cited ?? "unknown"}`).join("\n") : "no review targets";
        return screenedLegacy(legacy, out.render(s.color).join("\n"));
      } finally { store.close(); }
    }
    const id = parsed.positionals[0];
    if (sub !== "list" && sub !== "walk" && (!id || !/^[a-f0-9]{64}$/.test(id))) throw new Error(`review ${sub} requires a full 64-character candidate id`);
    if (sub === "walk" && !(context.stdinTTY ?? process.stdin.isTTY)) throw Error("review walk requires a terminal on stdin; stdout must be a terminal too");
    if (sub === "walk" && context.write === undefined && !(context.stdoutTTY ?? process.stdout.isTTY)) throw new Error("review walk prints each candidate and asks about it, so stdout must be a terminal (not redirected to a file or a pipe)");
    const project = boundProject(), aliases = aliasedKeys(memoryHome(), project), candidates = new CandidateStore(aliases.length ? { reconcile: { canonical: project, aliases } } : {});
    let overlapStore: MemoryStore | undefined;
    try {
      const overlapsFor = async (candidate: import("./memory/candidates.ts").Candidate) => {
        if (candidate.status !== "pending") return [];
        overlapStore ??= openCuratedForRead(memoryHome(), project);
        if (!overlapStore) return [];
        const assertCurrent = commandBinding(memoryHome(), project); assertCurrent();
        const overlaps = await candidateOverlaps(candidate, overlapStore, { project, policy: policyOf,
          policyVersion: () => JSON.stringify(configuredPolicyOptions(memoryHome(), policyCwd)) });
        assertCurrent(); return overlaps;
      };
      const candidatePermitted = (candidate: import("./memory/candidates.ts").Candidate): boolean => {
        if (actor !== "agent") return true;
        const policy = policyOf();
        if (!policy.screenStandalone(candidate)) return false;
        const input = candidate.input, targets = "targets" in input ? input.targets : "target" in input ? [input.target] : [];
        if (!targets.length && input.kind !== "promotion") return true;
        const targetStore = curatedStore(project, { deferPromotions: true, screen: () => "skip" });
        try {
          if (targets.some(target => { if (!target) return true; const view = targetStore.get(target.id, project); return !view || view.project !== project || !policy.screenStandalone(view); })) return false;
          if (input.kind === "promotion") { const goal = targetStore.goalOf(input.goalId, project); if (!goal || !policy.screenStandalone(goal)) return false; }
          return true;
        } finally { targetStore.close(); }
      };
      if (actor === "agent" && sub !== "list" && sub !== "walk") {
        const selected = candidates.get(id!, project);
        if (!selected || !candidatePermitted(selected)) throw Error("Memory operation unavailable or refused; no partial result is shown.");
      }
      const body = (candidate: import("./memory/candidates.ts").Candidate): string => { const input = candidate.input;
        if (input.kind === "promotion") {
          const viewStore = curatedStore(project, { deferPromotions: true, screen: () => "skip" });
          try {
            const target = viewStore.get(input.target.id, project);
            administrative({ candidate, target });
            return target && target.id === input.target.id && candidateTargetRevision(target) === input.target.revision
              ? `promotion. Goal goal:${input.goalId}, mem:${target.id}. ${target.title ? `${target.title}: ` : ""}${target.text}`
              : `promotion. Goal goal:${input.goalId}, target mem:${input.target.id} changed or is unavailable; reject or skip`;
          } finally { viewStore.close(); }
        }
        if (input.kind === "model-answer") return `Model answer (not evidence; cannot accept, author an independent note with amem note add). ${input.text}`;
        if (input.kind === "consolidation") return `${input.action}. Sources: ${input.targets.map(target => `mem:${target.id}`).join(", ")}. ${input.text}`;
        return input.kind === "memory" ? `${input.title ? `${input.title}: ` : ""}${input.text}` : input.kind === "fail" ? `fail. Approach: ${input.approach} Symptom: ${input.symptom} Cause: ${input.cause} Retry when: ${input.retryWhen}`
          : input.kind === "correction" ? `correction. ${input.proposedText} Reason: ${input.reason}` : `decay. ${input.reason}`; };
      // #323 item 4: can the origin still be re-checked against capture? An expired session is reported as such, never as a failed check.
      const recheckOf = (candidate: import("./memory/candidates.ts").Candidate) => {
        // Read-only: a preview never creates or migrates capture storage; a missing or cold shard is unavailable, not expired.
        let capture: import("./memory/capture.ts").CaptureStore | undefined;
        try {
          const policy = policyOf();
          return originRecheck(candidate.origin, candidate.originKnown, session => {
            const opened = capture ??= new CaptureStore({ memoryDir: memoryHome(), project, cwd: policyCwd, readOnly: true, recentReadRows: true, maxReadRows: 128 });
            return opened.sessionState(session, row => policy.screenStandalone(row));
          });
        } catch { return "unavailable" as const; } finally { capture?.close(); }
      };
      if (sub === "decide") {
        // #431 AC5: what `review walk` gives a person, one candidate at a time and without a terminal. The preview prints the
        // candidate and its overlaps and stamps it shown (the caller read it); --confirm then applies exactly the named decision.
        const decision = parsed.positionals[1];
        if (decision !== "accept" && decision !== "reject" && decision !== "defer") throw new Error("usage: amem review decide <full-candidate-id> accept|reject|defer [--confirm]");
        const candidate = candidates.get(id!, project);
        if (!candidate || !candidatePermitted(candidate)) throw new Error("candidate unavailable");
        if (candidate.status !== "pending") throw new Error(`candidate is ${candidate.status}, not pending`);
        if (decision === "accept" && candidate.input.kind === "decay" && candidate.input.reason !== UNUSED_INJECTION_REASON) throw new Error("decay candidates are listing-only unless proposed for unused injection; use amem decay to review current eligibility");
        if (decision === "accept" && candidate.input.kind === "model-answer") throw new Error("model answers cannot be accepted; author an independent note with amem note add");
        if (options["--confirm"] !== true) {
          const shown = terminalSafe(body(candidate)), overlaps = await overlapsFor(candidate);
          const preview = { candidateId: candidate.id, kind: candidate.input.kind, createdAt: candidate.createdAt, decision, body: shown,
            origin: candidate.originKnown ? candidate.origin ?? null : "unknown", originRecheck: recheckOf(candidate),
            overlaps: overlaps.map(overlap => ({ id: overlap.id, score: overlap.score, title: overlap.title ?? null })), next: `amem review decide ${candidate.id} ${decision} --confirm` };
          administrative(preview);
          markShown(realPath(candidates.dir), [project, ...aliases], Date.now(), [candidate.id]);
          return options["--json"] ? JSON.stringify(preview, null, 2)
            : [`${candidate.id}  ${candidate.input.kind}  ${candidate.createdAt.slice(0, 10)}`, `  ${shown}`, `  ${originLine(candidate.origin, candidate.originKnown)} (recheck: ${preview.originRecheck})`, ...preview.overlaps.map(overlap => `  overlap mem:${overlap.id} (${overlap.score.toFixed(3)}): ${terminalSafe(overlap.title ?? "untitled")}`),
              `preview only: run ${preview.next} to ${decision} it`].join("\n");
        }
        if (decision === "defer") return options["--json"] ? JSON.stringify({ candidateId: candidate.id, status: "pending", decision }, null, 2) : `deferred candidate ${candidate.id}; it stays pending`;
        if (decision === "reject") {
          candidates.reject(candidate.id, { project, actor, verdict: "public" });
          return options["--json"] ? JSON.stringify({ candidateId: candidate.id, status: "rejected" }, null, 2) : `rejected candidate ${candidate.id}`;
        }
        candidates.close(); overlapStore?.close(); overlapStore = undefined;
        return runCli(["review", "accept", candidate.id, "--kind", candidate.input.kind, ...(options["--json"] === true ? ["--json"] : [])], context);
      }
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
        const rows = candidates.list({ project, status: "pending", ...(options["--kind"] ? { kind: options["--kind"] as CandidateFilter["kind"] } : {}) }).reverse().filter(candidatePermitted);
        if (!rows.length) return "no candidates pending";
        const done = { accepted: 0, edited: 0, rejected: 0, skipped: 0, failed: 0 };
        const lines = { push: (...texts: string[]) => { for (const text of texts) write(text); return 0; } };
        const step = async (args: string[]) => { try { await runCli(args, context); return true; } catch (error) { lines.push(`  ${(error as Error).message.split("\n")[0]}`); done.failed++; return false; } };
        for (const [index, candidate] of rows.entries()) {
          assertWalkCurrent();
          if (!candidatePermitted(candidate)) throw Error("Memory operation unavailable or refused; no partial result is shown.");
          lines.push(`${index + 1}/${rows.length}  ${candidate.id.slice(0, 12)}  ${candidate.input.kind}  ${candidate.createdAt.slice(0, 10)}`, `  ${originLine(candidate.origin, candidate.originKnown)}`, `  ${terminalSafe(body(candidate))}`);
          for (const overlap of await overlapsFor(candidate)) lines.push(`  overlap mem:${overlap.id} (${overlap.score.toFixed(3)}): ${terminalSafe(overlap.title ?? "untitled")}`);
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
              candidates.reject(candidate.id, { project, actor, verdict: "public" }); done.edited++;
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
        if (options["--json"]) {
          const revision = JSON.stringify(configuredPolicyOptions(memoryHome(), policyCwd)), assertCurrent = commandBinding(memoryHome(), project);
          if (rows.some(candidate => candidate.status === "pending")) overlapStore ??= openCuratedForRead(memoryHome(), project);
          const sourceCurrent = overlapStore?.beginRecallRead();
          // Project identity can require Git processes: fence it around the whole read, not once per note.
          // The helper still checks source and policy revisions after every awaited screen.
          assertCurrent();
          const overlaps = overlapStore ? await candidateOverlapsBatch(rows, overlapStore, { project, policy: policyOf,
            policyVersion: () => JSON.stringify(configuredPolicyOptions(memoryHome(), policyCwd)) }) : rows.map(() => []);
          const hinted = rows.map((candidate, index) => ({ ...candidate, overlaps: overlaps[index]! }));
          assertCurrent(); sourceCurrent?.();
          if (JSON.stringify(configuredPolicyOptions(memoryHome(), policyCwd)) !== revision) throw Error("overlap policy changed");
          return JSON.stringify(hinted, null, 2);
        }
        return rows.length ? rows.map(candidate => `${candidate.id}  ${candidate.input.kind}  ${candidate.status}  ${candidate.createdAt}  ${originLine(candidate.origin, candidate.originKnown)}`).join("\n") : "no candidates waiting for review";
      }
      if (sub === "reject") {
        candidates.reject(id!, { project, actor, verdict: "public" });
        return options["--json"] ? JSON.stringify({ candidateId: id, status: "rejected" }, null, 2) : `rejected candidate ${id}`;
      }
      const candidate = candidates.get(id!, project);
      if (!candidate) throw new Error("candidate unavailable");
      if (options["--kind"] !== undefined && candidate.input.kind !== options["--kind"]) throw new Error("candidate kind does not match --kind");
      if (candidate.input.kind === "decay" && candidate.input.reason !== UNUSED_INJECTION_REASON) throw new Error("decay candidates are listing-only unless proposed for unused injection; use amem decay to review current eligibility");
      const store = curatedStore(project, { deferPromotions: true, screen: note => policyOf().screenStandalone(note) ? "promote" : "keep" });
      try {
        const assertCurrent = commandBinding(store.profile.home, project);
        if (!await policyOf().screen(candidate.input)) throw new Error("candidate refused by the current standalone privacy policy (secrets, personal data, deny paths and the patterns in amem.config.json)");
        assertCurrent();
        const result = candidates.accept(id!, { project, actor, verdict: "public", store,
          policyVersion: () => JSON.stringify(configuredPolicyOptions(realPath(store.profile.home), policyCwd)),
          policy: (proposal, target, note, goal) => { assertCurrent(); return policyOf().screenStandalone({ ...proposal.input, ...(target ? { targetView: target } : {}), note, ...(goal ? { goalView: goal } : {}) }); },
          // #368: a Record candidate quotes capture rows, so acceptance point-reads exactly those turns of its shard,
          // rather than the brief window a candidate can outlive.
          recordSource: recordSourceCheck(recordCaptureLookup(realPath(store.profile.home), policyCwd)),
          unusedEligible: view => {
            const { readReviewSnapshot, REVIEW_DEFAULTS } = require("./memory/review-targets.ts") as typeof import("./memory/review-targets.ts");
            const { unusedInjectionTargets } = require("./memory/decay-review.ts") as typeof import("./memory/decay-review.ts");
            const settings = loadAmemConfig(store.profile.home, repoConfigRoot(policyCwd)).config.review;
            return unusedInjectionTargets(store, project, readReviewSnapshot(store.profile.home, [project, ...aliases]), { now: store.readNow(), days: settings?.unused_days ?? REVIEW_DEFAULTS.unused_days, threshold: settings?.unused_rendered ?? REVIEW_DEFAULTS.unused_rendered, aliases, id: view.id, screen: row => policyOf().screenStandalone(row) }).some(entry => entry.target.id === view.id);
          },
        });
        return options["--json"] ? JSON.stringify(result, null, 2) : `accepted candidate ${id} as ${candidate.input.kind === "promotion" ? "promoted" : "ordinary"} note ${result.noteId}`;
      } finally { store.close(); }
    } finally { overlapStore?.close(); candidates.close(); }
  }
  if (sub === "vault-candidates" && (options["--all-projects"] === true || options["--project"] !== undefined)) {
    if (options["--all-projects"] === true && options["--project"] !== undefined) throw new Error("choose either --all-projects or --project <key>, not both");
    const result = await vaultCandidatesAll(memoryHome(), { policy: policyOf(), ...(options["--project"] !== undefined ? { project: resolveAlias(memoryHome(), String(options["--project"])) } : {}), ...(options["--limit"] ? { limit: Number(options["--limit"]) } : {}) });
    return options["--json"] ? JSON.stringify(result, null, 2) : screenedReadPair(vaultCandidatesAllText(result, outputStyle(context, options)), reports.vaultReportText(result.projects, result.crossedProjects, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
  }
  if (sub === "vault-candidates") {
    const project = boundProject(), store = curatedStore(project, { deferPromotions: true });
    try {
      const result = await vaultCandidates(store, { project, policy: policyOf(), ...(options["--limit"] ? { limit: Number(options["--limit"]) } : {}) });
      return options["--json"] ? JSON.stringify(result, null, 2) : screenedReadPair(vaultCandidatesText(result, outputStyle(context, options)), reports.vaultReportText(result.length ? [{ project: result[0]!.project, candidates: result }] : [], false, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
    } finally { store.close(); }
  }
  if (sub === "eval") {
    // F13: read-only. A set with entries is scored against a throwaway store seeded with them (touches no memory home); one without scores the bound project's real entries.
    if (parsed.path[1] === "audit") {
      // #326: a private local sheet plus a content-free score. Judging happens outside amem, so nothing on this path calls a model or the network.
      const audit = await import("./memory/eval-audit.ts"), { MAX_AUDIT_NOTES } = await import("./memory/eval.ts");
      if (parsed.path[2] === "sample") {
        const n = options["--n"] === undefined ? 40 : Number(options["--n"]), seed = typeof options["--seed"] === "string" ? options["--seed"] : "";
        if (!Number.isInteger(n) || n < 1 || n > MAX_AUDIT_NOTES) throw new Error(`--n must be an integer from 1 to ${MAX_AUDIT_NOTES}`);
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(seed)) throw new Error("--seed is required: 1 to 64 letters, digits, '.', '_' or '-', so the same seed and store draw the same sample");
        // Anchors are checked against this cwd's work tree, so another project's key would silently check them against the wrong repository: the audit only
        // samples the project bound here or one of its aliases, and names the checkout to run it from.
        const cwd = context.cwd ?? process.cwd(), home = memoryHome(), bound = boundProject();
        const project = options["--project"] === undefined ? bound : resolveAlias(home, String(options["--project"]));
        if (project !== bound && !aliasedKeys(home, bound).includes(project)) throw new Error(`the audit checks note anchors against the git work tree of ${cwd}, so it samples only the project bound there (${bound}); run \`amem eval audit sample\` from that project's checkout to audit that project`);
        const root = audit.auditRoot(cwd);
        // The age buckets the draw stratifies by are measured at one explicit instant, recorded in the sheet: the same seed, store and as-of draw the same sample.
        const asOf = options["--as-of"] === undefined ? Date.now() : audit.auditAsOf(String(options["--as-of"]), Date.now());
        const store = curatedStore(project, { deferPromotions: true });
        let sheet;
        // The configured policy screens each frame member before the sheet's first write, for a person and an agent-marked session alike (like `project export`).
        // It screens the complete view, not the fields the sheet copies: a denied pattern in `task`, `peer` or `source` is a denial of that note.
        // It is read once: the screen runs per frame member, and the policy reads the config files when it is built.
        const screen = policyOf();
        try { sheet = audit.auditSample({ store, project, n, seed, root, asOf, screen: view => screen.screenStandalone(view) }); } finally { store.close(); }
        const out = typeof options["--out"] === "string" ? options["--out"] : join(memoryHome(), "eval", `audit-${project.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80)}-${seed}.json`);
        const file = audit.writeAuditSheet(out, sheet);
        return options["--json"] === true ? JSON.stringify({ file, project: sheet.project, seed: sheet.seed, asOf: sheet.asOf, frame: sheet.frame, drawn: sheet.drawn, truncated: sheet.truncated, withheld: sheet.withheld }, null, 2) : screenedLegacy(audit.auditSheetText(sheet, file), audit.auditSheetText(sheet, file, { columns: reportWidth(context) ?? 80, style: outputStyle(context, options), ...(context.now ? { now: context.now() } : {}) }));
      }
      if (parsed.path[2] === "score") {
        const [sheet] = parsed.positionals;
        if (!sheet) throw new Error("usage: amem eval audit score <sheet> (the file `amem eval audit sample` wrote)");
        const score = audit.auditScore(audit.readAuditSheet(sheet));
        return options["--json"] === true ? JSON.stringify(score, null, 2) : screenedLegacy(audit.auditScoreText(score), audit.auditScoreText(score, { columns: reportWidth(context) ?? 80, style: outputStyle(context, options), ...(context.now ? { now: context.now() } : {}) }));
      }
      throw new Error("usage: amem eval audit sample --seed <s> [--n <n>] [--project <key>] | amem eval audit score <sheet>");
    }
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
    return options["--json"] ? JSON.stringify(report, null, 2) : evalText(report, builtin ? `built-in fixture ${file}` : file ?? "built-in fixture", { columns: reportWidth(context) ?? 80, style: outputStyle(context, options) });
  }
  if (sub === "spool") {
    // #217 PR2. Every argument refusal runs before any home, source or store access; both actors take this guarded
    // preview/apply path (no marker-only ban, no generic TTY gate). The replay module is loaded only here.
    // Argument refusals already ran in assertSpoolReplayArguments, before any home access.
    const apply = options["--apply"] === true, planFile = options["--plan"], source = options["--source"];
    const replay = await import("./hook-spool-replay.ts");
    if (!apply) {
      const plan = administrative(await replay.planHookSpoolReplay({ base: memoryHome(), ...(typeof source === "string" ? { source } : {}) }));
      return options["--json"] === true ? JSON.stringify(plan, null, 2) : screenedReadPair(replayPreviewText(plan), reports.spoolReplayReportText(plan, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
    }
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(planFile as string, "utf8")); }
    catch { throw new Error(`cannot read the replay plan ${planFile as string}; run \`amem spool replay --json > plan.json\` and pass that file`); }
    const plan = administrative(replay.parseReplayPlan(saved));
    const receipt = administrative(await replay.applyHookSpoolReplay({ base: memoryHome(), plan, confirmUnverifiable: options["--confirm-unverifiable"] === true }));
    return options["--json"] === true ? JSON.stringify(receipt, null, 2)
      : `replayed ${receipt.applied} (${receipt.spooled} via the capture spool), retired ${receipt.retired}, retained ${receipt.retained}, ${receipt.absent} absent (completed by an earlier run of this plan, or removed or drained by someone else; nothing was appended for it); ${receipt.outcomes.filter(o => o.outcome === "skipped").length} skipped by the plan`;
  }
  if (sub === "capacity") {
    const share = options["--disk-share"];
    if (share !== undefined && (!Number.isFinite(Number(share)) || Number(share) <= 0 || Number(share) > 1)) throw new Error("--disk-share must be a number in (0, 1]");
    const report = administrative(capacityReport({ ...(share !== undefined ? { diskShare: Number(share) } : {}) }));
    const capacityStyle = options["--json"] === true ? PLAIN : outputStyle(context, options), capacityRender = { columns: reportWidth(context) ?? 80, style: capacityStyle };
    if (parsed.path[1] !== "apply") return options["--json"] ? JSON.stringify(report, null, 2) : capacityText(report, capacityRender);
    const confirmation = ["amem", "capacity", "apply", ...(options["--split"] === true ? ["--split"] : []), ...(["--disk-share", "--cap-mb", "--retention-days"] as const).flatMap(flag => typeof options[flag] === "string" && options[flag] !== "" ? [flag, String(Number(options[flag]))] : []), "--confirm"].join(" ");
    if (options["--split"] === true) {
      // #15 D7: each shard's own share of the global budget, written to its own config. The same two steps as the home default below, bound to the shards it was made for.
      if (options["--cap-mb"] !== undefined || options["--retention-days"] !== undefined) throw new Error("--split computes each shard's values; do not combine it with --cap-mb or --retention-days");
      const diskShare = share !== undefined ? { diskShare: Number(share) } : {};
      const result = options["--confirm"] === true ? applySplit(memoryHome(), diskShare) : previewSplit(memoryHome(), diskShare);
      return options["--json"] ? JSON.stringify(result, null, 2) : capacitySplitText(result, capacityStyle, { ...capacityRender, next: confirmation });
    }
    // Preview first; --confirm writes the bound home default config.
    const file = join(memoryHome(), "capture-config.json");
    const target: CaptureConfig = {
      capMb: options["--cap-mb"] ? Number(options["--cap-mb"]) : report.proposal.capMb,
      retentionDays: options["--retention-days"] ? Number(options["--retention-days"]) : report.proposal.retentionDays,
    };
    if (!Number.isFinite(target.capMb) || target.capMb <= 0 || !Number.isFinite(target.retentionDays) || target.retentionDays <= 0) throw new Error("capacity apply needs positive --cap-mb and --retention-days");
    const preview = administrative({ file, current: readCaptureConfigFile(file), target, reason: report.proposal.reason });
    const previewFile = join(memoryHome(), "capture-config.preview.json");
    if (options["--confirm"] !== true) {
      writeFileSync(previewFile, JSON.stringify(preview) + "\n", { mode: 0o600 });
      const result = { preview, confirm: "re-run with --confirm to write" };
      return options["--json"] ? JSON.stringify(result, null, 2) : capacityApplyText(result, capacityStyle, { ...capacityRender, next: confirmation });
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
    const result = { preview, written: { cap_mb: written.capMb, retention_days: written.retentionDays } };
    return options["--json"] ? JSON.stringify(result, null, 2) : capacityApplyText(result, capacityStyle, { ...capacityRender, next: confirmation });
  }
  if (sub === "projects") {
    // Archived projects stay listed (the person must see what is cold); a forgotten one is out of the default view, and --all brings it back with its state.
    const rows = readCatalogFresh(memoryHome()).filter(project => options["--all"] === true || project.state !== "forgotten");
    if (options["--json"]) return JSON.stringify(rows, null, 2);
    if (!rows.length) return screenedReadPair("no project shards yet", reports.projectsReportText(rows, false, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
    const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
    // Per-project curated counts exist only after the split; before it every note is in one shared store, so the honest figure is unavailable, never 0.
    const split = shardStatePresent();
    const legacy = rows.map(p => `${p.key}  ${p.state}${p.local ? "  local-only key" : ""}${p.aliases.length ? `  aliases: ${p.aliases.join(", ")}` : ""}  capture ${p.captureRows} rows ${mb(p.captureBytes)}  curated ${split ? p.curatedEntries ?? "unavailable" : "unavailable (home not split)"}  disk ${mb(p.diskBytes)}  last ${p.captureLastAt ?? "never"}`).join("\n");
    return screenedReadPair(legacy, reports.projectsReportText(rows, split, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
  }
  if (sub === "usage") {
    const limit = options["--limit"] === undefined ? undefined : Number(options["--limit"]);
    const report = usageReport(memoryHome(), { ...(limit !== undefined ? { limit } : {}), includeForgotten: options["--all"] === true });
    return options["--json"] ? JSON.stringify(report, null, 2) : screenedReadPair(usageText(report), reports.usageReportText(report, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
  }
  if (sub === "gc") {
    // A preview reads; only explicit --confirm evicts, after the administrative preflight.
    const batches = options["--batches"] === undefined ? undefined : Number(options["--batches"]);
    if (actor === "agent") administrative(runGc(memoryHome(), { dryRun: true, ...(batches !== undefined ? { maxBatchesPerShard: batches } : {}) }));
    const result = runGc(memoryHome(), { dryRun: options["--confirm"] !== true, ...(batches !== undefined ? { maxBatchesPerShard: batches } : {}) });
    return options["--json"] ? JSON.stringify(result, null, 2) : screenedLegacy(`${result.dryRun ? "preview (nothing evicted; add --confirm):\n" : ""}${gcText(result)}`, gcText(result, { columns: reportWidth(context) ?? 80, style: outputStyle(context, options), next: `amem gc --confirm${batches === undefined ? "" : ` --batches ${batches}`}` }));
  }
  if (sub === "import" && ["claude-auto", "codex"].includes(parsed.path[1] ?? "")) {
    for (const flag of ["--db", "--limit", "--restart", "--capture-days"]) if (options[flag] !== undefined) throw new Error(`${flag} only applies to import claude-mem`);
    const source = parsed.path[1] as ExternalMemorySource, policy = policyOf();
    const result = await importExternalMemory({ base: memoryHome(), project: boundProject(), source, cwd: policyCwd, env: context.env ?? process.env,
      ...(typeof options["--from"] === "string" ? { from: options["--from"] } : {}), policy: value => policy.screenStandalone(value) });
    return options["--json"] ? JSON.stringify(result, null, 2)
      : result.checked ? `no ${source} memory found; checked ${result.checked.join(" and ")}`
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
        const describe = (values: Record<string, number>) => Object.entries(values).map(([key, value]) => `${wordedKey(key)} ${value}`).join(", ") || "none";
        const counts = `sources ${describe(result.provenance.source)}, peers ${describe(result.provenance.peer)}, scopes ${describe(result.provenance.scope)}, machines ${describe(result.provenance.machine)}`;
        const summary = result.applied ? `imported ${result.added} of ${result.read} curated notes into ${result.project} with their original ids`
          : `preview: ${result.wouldAdd} of ${result.read} curated notes can be imported into ${result.project} with their original ids (re-run with --confirm to write)`;
        const formatted = `${summary}; ${counts}; skipped ${result.skipped.invalid} invalid, ${result.skipped.policy} policy/secret and ${result.skipped.other} non-curated records. ${result.warnings.join(" ")}`;
        const legacyCounts = `sources ${JSON.stringify(result.provenance.source)}, peers ${JSON.stringify(result.provenance.peer)}, scopes ${JSON.stringify(result.provenance.scope)}, machines ${JSON.stringify(result.provenance.machine)}`;
        const legacy = `${summary}; ${legacyCounts}; skipped ${result.skipped.invalid} invalid, ${result.skipped.policy} policy/secret and ${result.skipped.other} non-curated records. ${result.warnings.join(" ")}`;
        return options["--json"] ? JSON.stringify(result, null, 2) : screenedLegacy(legacy, formatted);
      } finally { store.close(); }
    }
    const key = administrative(requireShard(memoryHome(), requested));
    if (op === "forget" && options["--confirm"] !== true) {
      const state = projectState(memoryHome(), key), shard = readCatalogFresh(memoryHome()).find(p => p.key === key);
      return `preview: forget ${key} (now ${state}; capture ${shard?.captureRows ?? 0} rows, curated ${shardStatePresent() ? shard?.curatedEntries ?? "unavailable" : "unavailable (home not split)"}). Forget is an append-only record that takes the project out of recall and every listing for good; nothing is erased here and it cannot be undone. Re-run with --confirm to record it.`;
    }
    const written = appendLifecycle(memoryHome(), { op: op as "archive" | "unarchive" | "forget", key, actor, machine: machineId(memoryHome()).id });
    return options["--json"] ? JSON.stringify(written, null, 2) : `${op === "forget" ? "forgot" : op === "archive" ? "archived" : "unarchived"} ${written.key}${requested !== written.key ? ` (alias ${requested})` : ""}`;
  }
  // Only the existing cross-project capture renderer uses this; project search and agent MCP routing stay unchanged.
  const captureSearchText = (capture: { event: string; excerpt: string; paths: string[] }): string => {
    if (capture.event !== "Record") return capture.excerpt.split(/[\r\n]/, 1)[0]! + (/[\r\n]/.test(capture.excerpt) ? "..." : "");
    const parsed = parseRecordLines(capture.excerpt), record = parsed.records[0];
    // Historical capture can contain arbitrary event text. Never render it as a canonical Record or inject another display line.
    return record && parsed.records.length === 1 && Object.keys(parsed.drops).length === 0 && record.line === capture.excerpt
      && JSON.stringify(record.anchors) === JSON.stringify(capture.paths) ? record.line : "[invalid Record format or anchors; inspect --json output]";
  };
  if (sub === "search" && options["--all-projects"] === true) {
    if (options["--explain"] === true) throw new Error("--explain applies to current-project ranked search, not --all-projects");
    if (options["--filter"] === true) throw new Error("--filter applies to project-local search, not --all-projects");
    const words = parsed.positionals.join(" ");
    if (!words.trim()) throw new Error("usage: amem search --all-projects <words> [--limit N] [--include-archived] [--json]");
    const result = searchAllProjects(memoryHome(), words, { ...(options["--limit"] !== undefined ? { limit: Number(options["--limit"]) } : {}), includeArchived: options["--include-archived"] === true });
    if (options["--json"]) return JSON.stringify(result, null, 2);
    const one = (hit: (typeof result.hits)[number]) => hit.view ? `${hit.project}  ${hit.view.id.slice(0, 8)}  ${hit.view.kind}  ${(hit.view.title ?? hit.view.text).split("\n")[0]!.slice(0, 100)}` : `${hit.project}  capture ${hit.capture!.id}  ${hit.capture!.event}${hit.capture!.subagent ? "  subagent" : ""}  ${hit.capture!.event === "Record" ? captureSearchText(hit.capture!) : hit.capture!.excerpt.split("\n")[0]!.slice(0, 100)}`;
    const legacy = [`crossed projects: searched ${result.projects.length} (${result.projects.join(", ")})`, ...(result.hits.length ? result.hits.map(one) : ["(nothing)"])].join("\n");
    const rows = result.hits.map(hit => hit.view ? { project: hit.project, id: hit.view.id, kind: hit.view.kind, tier: hit.view.tier, peer: hit.view.peer, scope: hit.view.scope, at: hit.view.at, text: `${hit.view.title ? `${hit.view.title}: ` : ""}${hit.view.text}` } : { project: hit.project, id: `capture:${hit.capture!.id}`, kind: "capture", peer: hit.capture!.agent, at: hit.capture!.at, text: `${hit.capture!.event}${hit.capture!.subagent ? " subagent" : ""}: ${captureSearchText(hit.capture!)}` });
    const width = reportWidth(context) ?? 80, displayStyle = outputStyle(context, options), projects = new Report(width, displayStyle.ascii, { sanitize: singleLine });
    projects.section("Projects", String(result.projects.length)); projects.line(`Crossed projects: ${result.projects.join(", ") || "none"}.`);
    return screenedReadPair(legacy, `${memoryTableText(rows, "Cross-project search", { columns: width, style: displayStyle, ...(context.now ? { now: context.now() } : {}) })}\n\n${projects.render(displayStyle.color).join("\n")}`);
  }
  if (sub === "search" && options["--include-archived"] === true) throw new Error("--include-archived only applies with --all-projects");
  if (sub === "search" && options["--explain"] === true) {
    if (options["--filter"] === true) throw new Error("--explain cannot be combined with --filter");
    if (options["--history"] === true || options["--as-of"] !== undefined) throw new Error("--explain cannot be combined with --history or --as-of");
    if (!parsed.positionals.join(" ").trim()) throw new Error("--explain requires a non-empty search query");
  }
  if (sub === "alias") {
    if (parsed.path[1] === "add") {
      const [from, to] = parsed.positionals;
      if (!from || !to) throw new Error("usage: amem alias add <from-key> <to-key>");
      const op = appendAlias(memoryHome(), { alias: from, key: to, actor, machine: machineId(memoryHome()).id });
      return options["--json"] ? JSON.stringify(op, null, 2) : `alias ${op.alias} -> ${op.key}`;
    }
    if (parsed.path[1] === "remove") {
      // #27 option 2: append only, the latest op wins; attribution is not authentication.
      const [from] = parsed.positionals;
      if (!from || parsed.positionals.length !== 1) throw new Error("usage: amem alias remove <alias-key>");
      const op = appendUnalias(memoryHome(), { alias: from, actor, machine: machineId(memoryHome()).id });
      return options["--json"] ? JSON.stringify(op, null, 2) : `alias ${op.alias} removed`;
    }
    const ops = listAliases(memoryHome());
    return options["--json"] ? JSON.stringify(ops, null, 2) : ops.length ? ops.map((op) => op.op === "alias" ? `${op.at}  ${op.alias} -> ${op.key}  (${op.actor})` : `${op.at}  ${op.alias} removed  (${op.actor})`).join("\n") : "no aliases recorded";
  }
  // ponytail: board task links need the host's authenticated task boundary; add a host bridge before supporting them here.
  if (goal && sub === "link") throw new Error("goal link needs a host with a task board; amem alone has none");
  // #15 T4 / D6: repository writes keep their explicit confirmation and visibility fences; amem never runs git.
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
    if (options["--json"]) return JSON.stringify(status, null, 2);
    return screenedReadPair([`repo scope of ${project}: ${status.state}`, `file: ${status.file}`, `entries: ${status.entries}${read ? ` (skipped: ${read.skipped.malformed} malformed, ${read.skipped.mismatched} id mismatch, ${read.skipped.duplicate} duplicate, ${read.skipped.withheld} withheld by the screen)` : ""}`,
      ...(status.reason ? [`unavailable: ${status.reason}`] : [])].join("\n"), reports.repoStatusReportText(status, project, outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
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
    const sourceView = view, sourceRevision = candidateTargetRevision(view);
    if (actor === "agent" && !recallViewIsLive(sourceView, Date.now())) throw Error("Memory operation unavailable or refused; no partial result is shown.");
    administrative(sourceView); // Screen fields the repository representation deliberately drops, too.
    const assertSourceReadable = () => {
      if (actor !== "agent") return;
      const fresh = curatedStore(project, { deferPromotions: true, screen: () => "skip" });
      try {
        const current = fresh.get(sourceView.id, project);
        if (!current || candidateTargetRevision(current) !== sourceRevision || !recallViewIsLive(current, fresh.readNow()) || resolveAlias(memoryHome(), current.project) !== project) throw Error("Memory operation unavailable or refused; no partial result is shown.");
        administrative(current);
      } finally { fresh.close(); }
    };
    const plan = await planRepoPromotion(root, view, configuredPolicyOptions(memoryHome(), root));
    if (plan.refusals.length) throw new Error(`not promoted to repo scope:\n- ${plan.refusals.join("\n- ")}`);
    const seen = await repoVisibility(root, context.visibility);
    assertSourceReadable(); // Visibility can await: recheck before either preview or publication.
    administrative({ path: plan.path, line: plan.line });
    const preview = [`the exact line that would be appended to ${plan.path}:`, plan.text, ...(plan.droppedNodes.length ? [`(left out, private references: ${plan.droppedNodes.join(", ")})`] : []),
      `repository visibility: ${seen.state}${seen.remotes.length ? ` (${[...new Set(seen.remotes.map(r => `${r.name}${r.kind === "push" ? " (push)" : ""} ${r.visibility}`))].join(", ")})` : " (no remote)"}`];
    const entryPrefix = plan.line.id.slice(0, 8);
    if (plan.alreadyPresent || options["--confirm"] !== true) {
      const s = outputStyle(context, options), report = new Report(reportWidth(context) ?? 80, s.ascii, { sanitize: singleLine, keepTokensWhole: true });
      report.header("amem", "Repository promotion"); report.section("Preview");
      const targetParts = Array.from(plan.path), target = targetParts.length > 25 ? `${targetParts.slice(0, 10).join("")}...${targetParts.slice(-12).join("")}` : plan.path;
      report.kv([["Scope", "repo"], ["Kind", plan.line.kind], ["Target", target], ["Visibility", seen.state]]);
      if (plan.droppedNodes.length) report.line(`Private references omitted: ${plan.droppedNodes.join(", ")}`);
      report.line(plan.alreadyPresent ? "already in the file: nothing to write" : seen.state === "private" ? "Nothing written; add --confirm to append it." : `NOT a verified private repository: add --confirm --confirm-public ${entryPrefix} to append this entry (per entry, never blanket).`);
      // AC8 exception: the canonical line must be shown verbatim before appending to a shared repository.
      return `${report.render(s.color).join("\n")}\nLine to append:\n${plan.text}`;
    }
    if (seen.state !== "private") {
      const given = options["--confirm-public"];
      if (typeof given !== "string" || given.length < 8 || !/^[a-f0-9]+$/.test(given) || !plan.line.id.startsWith(given)) throw new Error(`the repository is ${seen.state === "public" ? "public" : "not verified private"}: repo scope needs your confirmation of this entry: --confirm-public ${entryPrefix} (the first 8 characters of the id in the line above)`);
    }
    assertSourceReadable();
    const written = appendRepoLine(root, plan.line);
    return [...preview, `appended to ${written.path}. amem does not commit or push: review and commit it yourself.`,
      ...(repoLogIgnored(root) ? ["WARNING: git ignores .amem/log.jsonl here, so `git status` will not show it and it cannot be committed until you un-ignore it (a .gitignore or .git/info/exclude rule)."] : [])].join("\n");
  }
  if (sub === "show" && /^capture:[1-9][0-9]*$/.test(parsed.positionals[0] ?? "") && options["--history"] !== true && options["--as-of"] === undefined) {
    // #323 item 3: a capture row (a Record included) by id, through the screened MCP read, with its session and row time.
    const memory = createMemoryMcp({ cwd: context.cwd ?? process.cwd(), base: memoryHome() });
    try {
      const shown = await memory.tools.amem_show({ id: parsed.positionals[0]! }) as { capture?: import("./memory/capture.ts").CaptureRow } | null;
      const row = shown?.capture; if (!row) throw new Error(`no capture row ${parsed.positionals[0]} in this project (capture is machine-local and expires; inspect the current project timeline and retention)`);
      return options["--json"] === true ? JSON.stringify(row, null, 2)
        : memoryRecordText({ id: `capture:${row.id}`, kind: row.event, at: row.at, text: row.excerpt }, { columns: reportWidth(context) ?? 80, style: outputStyle(context, options), ...(context.now ? { now: context.now() } : {}) }, [["Recorded at", row.at], ["Agent", row.agent], ["Session", row.session ?? "unavailable"], ...(row.tool ? [["Tool", row.tool] as [string, string]] : []), ...(row.paths.length ? [["Paths", row.paths.join(", ")] as [string, string]] : []), ...(row.subagent ? [["Subagent", "yes"] as [string, string]] : [])]);
    } finally { memory.close(); }
  }
  if (sub === "show" && /^repo:/.test(parsed.positionals[0] ?? "")) {
    const project = boundProject(), root = boundRepoRoot(repoCwd, memoryHome(), project), scoped = root ? repoReadPolicy(root) : undefined;
    const rows = root && scoped && !("reason" in scoped) ? (await readRepoScope(root, scoped.policy)).views : [];
    const wanted = parsed.positionals[0]!.slice(5), hit = rows.filter(row => row.id === wanted || wanted.length >= 6 && row.id.startsWith(wanted));
    if (hit.length !== 1) throw new Error(`no repo entry ${parsed.positionals[0]} in this repository's .amem/log.jsonl`);
    const row = hit[0]!;
    if (actor === "agent" && options["--json"] !== true) return [`repo:${row.id}  ${row.kind}, repo scope, ${row.at}`, ...(row.about.length ? [`about: ${row.about.join(", ")}`] : []), "", ...(row.title ? [row.title] : []), row.text].join("\n");
    return options["--json"] ? JSON.stringify(row, null, 2) : memoryRecordText({ id: `repo:${row.id}`, kind: row.kind, at: row.at, text: `${row.title ? `${row.title}\n` : ""}${row.text}` }, { columns: reportWidth(context) ?? 80, style: outputStyle(context, options), ...(context.now ? { now: context.now() } : {}) }, [["Scope", "repo"], ...(row.about.length ? [["About", row.about.join(", ")] as [string, string]] : [])]);
  }
  let priorRead: string | undefined;
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
    const repoDetails = explainSearch ? rows.map(row => ({ ...row, scoreDetails: unrankedScoreDetails("repo", null) })) : rows;
    if (options["--json"]) { try { const base = JSON.parse(output) as unknown[]; return JSON.stringify([...base, ...repoDetails], null, 2); } catch { return output; } }
    const note = read.state === "unsafe" ? [`(repo scope unavailable: ${read.reason})`] : read.skipped.malformed + read.skipped.mismatched + read.skipped.withheld ? [`(${read.skipped.malformed + read.skipped.mismatched} repo lines skipped as invalid, ${read.skipped.withheld} withheld by the screen)`] : [];
    const line = (row: (typeof rows)[number]) => `repo:${row.id.slice(0, 8)}  ${row.at.slice(0, 16).replace("T", " ")}  repo  ${row.kind.padEnd(8)} ${`${row.title ? `${row.title}: ` : ""}${row.text}`.replace(/\s+/g, " ").slice(0, 100)}`;
    const lines = explainSearch ? rows.flatMap(row => [line(row), `score: ${JSON.stringify(unrankedScoreDetails("repo", null))}`]) : rows.map(line);
    const legacy = [priorRead ?? output, ...(rows.length ? ["repo scope (.amem/log.jsonl):", ...lines] : []), ...note].join("\n");
    const render = { columns: reportWidth(context) ?? 80, style: outputStyle(context, options), ...(context.now ? { now: context.now() } : {}) };
    const table = rows.length ? memoryTableText(rows.map(row => ({ id: `repo:${row.id}`, kind: row.kind, at: row.at, text: `${row.title ? `${row.title}: ` : ""}${row.text}` })), "Repository", render) : "";
    const scores = explainSearch ? memoryScoresText(rows.map(row => ({ id: `repo:${row.id}`, details: unrankedScoreDetails("repo", null) as unknown as Record<string, unknown> })), render) : "";
    return screenedReadPair(legacy, [output, ...(rows.length ? ["repo scope (.amem/log.jsonl):", table] : []), ...(scores ? ["", scores] : []), ...note].join("\n"));
  };
  const crosses = definition.policyFree === true;
  const cwd = context.cwd ?? process.cwd();
  const configured = policyOf(), recallRoot = boundRepoRoot(cwd, memoryHome(), boundProject());
  const rootConfirmed = recallRoot !== undefined || boundProject().startsWith("local:") && resolveAlias(memoryHome(), memoryProjectKey(cwd)) === boundProject();
  // Reads can trigger held-note reconciliation. Defer it unless this command is one that moves notes across the boundary (promote, sync, import, review accept), and then the configured policy decides each note.
  const open = () => curatedStore(boundProject(), { ...(identity.actor === "agent" ? { deferPromotions: true } : {}), screen: note => !crosses ? "skip" : configured.screenStandalone(note) ? "promote" : "keep" });
  // A person's reads are unscreened. A write is screened by the configured policy, which includes the built-in secret screen.
  if (goal && actor === "agent") {
    const ids = sub === "new" ? repeated(argv, "--depends") : parsed.positionals.slice(0, 1);
    if (ids.length) {
      const targetStore = open();
      try { for (const id of ids) { const target = targetStore.goalOf(id.replace(/^goal:/, ""), boundProject()); if (!target) throw Error("Memory operation unavailable or refused; no partial result is shown."); administrative(target); } }
      finally { targetStore.close(); }
    }
  }
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
  if (sub === "sync" && options["--status"] === true) {
    // #418: read-only status from the telemetry sidecars; no realm, lock, proof, journal or schedule is touched.
    if (Object.keys(options).some(name => name !== "--status" && name !== "--json")) throw new Error("sync --status takes only --json");
    const { readSyncStatus, renderSyncStatus } = await import("./memory/sync-progress.ts"), report = readSyncStatus(syncHome);
    return options["--json"] ? JSON.stringify(report, null, 2) : screenedReadPair(renderSyncStatus(report), reports.syncStatusReportText(report, context.now?.() ?? Date.now(), outputStyle(context, options), { columns: reportWidth(context) ?? 80, ...(context.now ? { now: context.now() } : {}) }));
  }
  if (sub === "sync") { assertFormatFloor(syncHome, "sync"); const refusal = placementRuntimeRefusal(syncHome); if (refusal) throw new Error("amem sync: " + refusal); }
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
  // `sync --progress` is the CLI's own rendering choice; the raw command, which hosts share, never sees it.
  if (sub === "sync") for (let index = 0; index < args.length; index++) {
    if (args[index] === "--progress") { captureArgs.add(index); captureArgs.add(index + 1); }
    else if (args[index]?.startsWith("--progress=")) captureArgs.add(index);
  }
  // --filter and --explain select standalone CLI behavior; hosts keep their existing raw command arguments.
  const legacySearch = options["--filter"] === true;
  const explainSearch = sub === "search" && options["--explain"] === true;
  const syncArgs = args.filter((arg, index) => arg !== "--if-due" && arg !== "--force" && !captureArgs.has(index) && (!legacySearch || arg !== "--filter") && (!explainSearch || arg !== "--explain"));
  const memoryArgs = captureImport && !options["--json"] ? [...syncArgs, "--json"] : syncArgs;
  let output: string;
  let placementWriters: import("./sync-placement-writer-context.ts").PlacementWriterContext | undefined;
  let progress: import("./memory/sync-progress.ts").SyncProgress | undefined;
  const stop = ifDue ? stopSignal(context.syncDeadlineMs ?? SYNC_IF_DUE_DEADLINE_MS, process) : undefined;
  try {
    if (sub === "sync" && (readPlacementRuntimeMarkers(syncHome).profile as { publicationFormat?:string } | undefined)?.publicationFormat === "agent-mem.sync-placement/v1") {
      const { activePlacementWriterContext } = await import("./sync-placement-writer-context.ts");
      progress = await placementProgress(syncHome, typeof options["--progress"] === "string" ? options["--progress"] as string : "auto", context);
      try { placementWriters = activePlacementWriterContext(syncHome,fileURLToPath(new URL("..",import.meta.url))); }
      catch (error) {
        // #551 AC1: a writer-context refusal is this run's own failed result, so --json reports it instead of printing one
        // masked line; a human run keeps the refusal's fixed text and exit 1, and every other refusal keeps its own path.
        const refusal = (await import("./sync-placement-writer-context.ts")).placementWriterRefusalText(error);
        if (refusal === undefined || !options["--json"]) throw error;
        stampSync(refusal, stop?.cause());
        return JSON.stringify({ ok: false, pushed: false, entries: 0, failure: { cause: "refusal" }, error: refusal }, null, 2);
      }
      const markers = readPlacementRuntimeMarkers(syncHome);
      if (!readActivePlacementBinding(syncHome, markers.profile, markers.shards)) throw Error("sync placement activation metadata unavailable or changed; inspect the retained activation before continuing");
    }
    output = await withRepoRows(await rawMemoryCommand(memoryArgs, cwd, { person: true, rankedSearch: !legacySearch, ...(identity.actor === "agent" ? { screenGraph: true } : {}), ...(explainSearch ? { explainSearch: true } : {}), ...(options["--json"] !== true ? { [CLI_MEMORY_RENDER]: { render: { columns: reportWidth(context) ?? 80, style: outputStyle(context, options), ...(context.now ? { now: context.now() } : {}) }, ...(actor === "agent" ? { renderLegacy: (legacy: string, formatted: string) => { priorRead = legacy; return screenedReadPair(legacy, formatted); } } : {}) } } : {}), project: boundProject(), open: sub === "sync" && placementWriters ? () => openShardStore({ memoryDir: syncHome, user: true, deferPromotions: true }) : open, readable: notes => identity.actor === "person" ? notes : notes.filter(view => view.project === boundProject() && policyOf().screenStandalone(view)), stale: createRecallStalenessProbe({ cwd: recallRoot ?? cwd, rootConfirmed, policy: () => configured }), outputReady: notes => outputReady(notes.map(view => view.id)), importPolicy: () => text => configured.declinesPersonal(text),
      // #578 Q2: the CLI sync (also --if-due) is eligible; the home opt-in still decides whether a checkpoint can run.
      sync: { ...(placementWriters ? { placementAttestation:placementWriters.attest, placementCheckpoint: true } : {}), ...(progress ? { progress } : {}), screen: row => configured.screenStandalone(row), policyVersion: () => JSON.stringify(configuredPolicyOptions(memoryHome(), policyCwd)), ...(stop ? { signal: stop.signal } : {}) },   // the repository-narrowed policy binds what sync publishes too
      onBridgeStatus: status => { receipt.bridgeStatus = status; },
      // #188: ids-only listing of nearby machine-local rows; policy-refused rows are neither listed nor counted.
      forgetNearby: note => forgetNearby({ base: memoryHome(), project: note.project, text: note.text, title: note.title, screen: value => configured.screenStandalone(value) }) }));
  } catch (error) {
    if (sub === "sync") progress?.finish(stop?.cause() ? "cancelled" : "failed", stop?.cause() ? "cancelled" : "unavailable");
    if (sub === "sync") stampSync((error as Error).message, stop?.cause());
    if (sub === "sync" && placementWriters?.lastRefusal) throw (await import("./sync-placement-writer-context.ts")).placementSyncFailure(placementWriters.lastRefusal, error);
    throw error;
  }
  finally {
    // A run that never reached the transport's receipt (an early refusal) must not stay "running".
    progress?.finish("failed", "unavailable");
    stop?.dispose();
    // A run its person ended ends like that signal (130, 143, 129, 131), as `amem doctor` does, also when `--json` reports it as a result instead of an error: the caller decides when.
    const ended = stop?.cause() === "person" ? stop.signalName() : undefined;
    if (ended !== undefined) context.onPersonStop?.(ended);
  }
  if (sub === "sync") {
    // `--json` returns the failed result instead of throwing: read the real outcome from it, never assume a returned string means the sync worked.
    let failure: string | undefined;
    if (options["--json"]) { try {
      const result = JSON.parse(output) as { ok?: unknown; error?: unknown };
      if (result.ok === false) {
        failure = typeof result.error === "string" ? result.error : "sync failed";
        if (placementWriters?.lastRefusal) { result.error = `${placementWriters.lastRefusal.message} ${failure}`; output = JSON.stringify(result,null,2); }
      }
    } catch { /* not a sync result */ } }
    stampSync(failure, stop?.cause());
  }
  if (captureImport) {
    const policy = configured, db = options["--db"] ? { db: String(options["--db"]) } : {}, limit = options["--limit"] ? { limit: Number(options["--limit"]) } : {}, restart = options["--restart"] === true;
    const work = await importClaudeMemWorkState({ base: memoryHome(), project: boundProject(), policy: row => policy.screen(row), ...db, ...limit, restart });
    const capture = captureDays === undefined ? undefined : await importClaudeMemCapture({ base: memoryHome(), project: boundProject(), cwd, days: captureDays, ...db, ...limit, restart, policy: { host: policy } });
    if (options["--json"]) return JSON.stringify({ ...JSON.parse(output), work, ...(capture ? { capture } : {}) }, null, 2);
    const s = outputStyle(context, options), notes = JSON.parse(output), source = typeof options["--db"] === "string" ? options["--db"] : undefined;
    const safe = source === undefined || !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(source);
    const next = safe ? ["amem import claude-mem", ...(source ? [`--db '${source.replaceAll("'", "'\\''")}'`] : []), ...(limit.limit !== undefined ? [`--limit ${limit.limit}`] : []), ...(captureDays !== undefined ? [`--capture-days ${captureDays}`] : [])].join(" ") : undefined;
    return screenedLegacy(claudeMemImportText(notes, work, capture, { captureDays, restart }, s), claudeMemImportText(notes, work, capture, { captureDays, restart }, s, { columns: reportWidth(context) ?? 80, ...(next ? { next } : {}) }));
  }
  return !options["--json"] && receipt.bridgeStatus
    ? `${output}\n(legacy malformed lines skipped: ${receipt.bridgeStatus.skippedRows})` : output;
}

/** Color for human output only on an interactive stdout without NO_COLOR or TERM=dumb (#125). */
/**
 * #418: one reporter per placement sync. The private sidecar backs `sync --status` in every mode; stderr gets human
 * lines or versioned JSON events. Each part fails alone and silently: telemetry never fails or alters the sync.
 */
async function placementProgress(home: string, mode: string, context: CliContext): Promise<import("./memory/sync-progress.ts").SyncProgress> {
  const { SyncProgress, renderSyncProgress, syncProgressSidecar } = await import("./memory/sync-progress.ts");
  const write = context.stderr ?? ((text: string) => { process.stderr.write(text); });
  const render = mode === "json" ? "json" : mode === "human" || mode === "auto" && (context.stderrTTY ?? process.stderr.isTTY) ? "human" : undefined;
  const parts = [syncProgressSidecar(home), ...(render ? [(snapshot: import("./memory/sync-progress.ts").SyncProgressSnapshot) => write((render === "json" ? JSON.stringify(snapshot) : renderSyncProgress(snapshot)) + "\n")] : [])];
  const live = new Set(parts.keys());
  return new SyncProgress({ sink: snapshot => { for (const index of live) try { parts[index]!(snapshot); } catch { live.delete(index); } } });
}
function outputStyle(context: CliContext, options: Record<string, string | boolean>): Style {
  const color = resolveColor(typeof options["--color"] === "string" ? options["--color"] : undefined, streamEnv((context.stdoutTTY ?? process.stdout.isTTY) === true, context.env ?? process.env), "amem");
  if (color instanceof Error) throw color;
  return style(options["--json"] !== true && color, asciiMarkers(context.env ?? process.env, options["--ascii"] === true));
}
function reportOptions(context: CliContext, options: Record<string, string | boolean>): { verbose: boolean; version: string; columns?: number } {
  const columns = reportWidth(context);
  return { verbose: options["--verbose"] === true, version: VERSION, ...(columns !== undefined ? { columns } : {}) };
}
function reportWidth(context: CliContext): number | undefined {
  const env = context.env ?? process.env, configured = Number(env.COLUMNS);
  if (Number.isSafeInteger(configured) && configured >= 20) return configured;
  return (context.stdoutTTY ?? process.stdout.isTTY) ? process.stdout.columns : undefined;
}

/** Native ingest remains capture-only and agent-reachable; this formats only its returned receipt. */
export function ingestText(kind: IngestKind, result: IngestReceipt, s: Style = PLAIN, columns?: number): string {
  const state = result.errors || result.remaining || result.spooled ? "attention" : result.files || result.read ? "complete" : "skipped";
  const reason: string | undefined = result.reason;
  const actions: Record<string, string> = {
    source_unavailable: "check that this client's native transcript root is available, then ingest again",
    source_bound: "review the native source size and supported discovery bounds before retrying",
    cursor_busy: "wait for the active ingest writer, then ingest again",
    scope_changed: "run ingest again from the same repository after its scope is stable",
    schema_or_time: "check the native transcript format and timestamps; unreadable records were skipped",
    unsupported_version: "check the reported writer version against the supported ingest contract before retrying",
  };
  const version = "version" in result && typeof result.version === "string" ? result.version : undefined;
  const action = reason ? actions[reason] ?? "review the receipt before retrying"
    : result.errors ? "review the ingest errors and supported native source contract before retrying"
      : result.remaining ? "run the same ingest command again to continue"
      : result.spooled ? "the next capture write replays rows spooled while the store was busy"
        : state === "skipped" ? "open a native session in this repository before ingesting its transcript" : undefined;
  const report = new Report(columns ?? 80, s.ascii, { sanitize: singleLine, keepTokensWhole: true });
  report.header("amem", `Ingest ${kind}`); report.section("Receipt");
  report.bullet(state === "complete" ? "ok" : state === "skipped" ? "absent" : "warn", state === "complete" ? "Ingest completed." : state === "skipped" ? "No transcript imported." : "Ingest needs attention.");
  report.kv([["State", state], ["Files", String(result.files)], ["Read", String(result.read)], ["Imported", String(result.imported)], ["Skipped", String(result.skipped)], ["Spooled", String(result.spooled)], ["Errors", String(result.errors)], ["Remaining", result.remaining ? "yes" : "no"], ...(reason ? [["Reason", reason.replace(/_/g, " ") + (version ? ` (version ${version})` : "")] as [string, string]] : [])]);
  if (action) { report.section("Attention"); report.bullet(state === "attention" ? "warn" : "absent", action); }
  if (result.remaining || reason === "cursor_busy" || reason === "scope_changed") report.next(`amem ingest ${kind}`);
  report.line(""); report.line(`Summary: ${result.imported} imported, ${result.skipped} skipped, ${result.errors} errors`);
  return report.render(s.color).join("\n");
}

/**
 * #590 H7: a usage error prints its message, one usage line and the help page that explains it. A message that already
 * is a `usage:` line stays the one usage line.
 */
export function formatCliError(error: unknown, usage = false, argv: readonly string[] = []): string {
  if (error instanceof DecayApplyError || error instanceof CliPartialApplyError) return error.render();
  const raw = String((error as Error).message), message = errorLine("amem", raw, "", { tty: false })[0]!;
  if (!usage && (error as { exitCode?: number }).exitCode !== 2) return message;
  const path = commandPath(argv[0] === "help" ? [] : argv);
  const help = `Run 'amem help${path.length ? ` ${path.join(" ")}` : ""}' for details.`;
  return raw.startsWith("usage:") ? `${message}\n${help}` : `${message}\nUsage: ${usageLine(path)}\n${help}`;
}

/** A completed write means rendered output, never evidence of host delivery or citation. */
export async function writeCliOutput(text: string, output: Writable = process.stdout): Promise<void> { await writeConfirmed(output, text); }
export async function main(argv = process.argv.slice(2)): Promise<void> {
  let personStop: string | undefined;
  try {
    const receipts: CliOutputReceipt[] = [], output = await runCli(argv, { onOutputReady: receipt => receipts.push(receipt), onPersonStop: name => { personStop ??= name; }, onExitCode: code => { process.exitCode = code; } });
    if (output) { await writeCliOutput(output + "\n"); for (const receipt of receipts) { try { receipt.rendered(); } catch { /* telemetry stays optional */ } } }
  } catch (error) {
    let prefix = "";
    if (process.stderr.isTTY) {
      let options: Record<string, string | boolean> = {};
      try { options = parseCommand(argv).options; } catch { /* Invalid options still report their usage error. */ }
      const color = resolveColor(typeof options["--color"] === "string" ? options["--color"] : undefined, streamEnv(true, process.env), "amem");
      const ascii = asciiMarkers(process.env, options["--ascii"] === true);
      // ponytail: amem keeps the two-cell marker column; upgrade when errorSpans exposes that padding.
      const marker = errorSpans("amem", "", "", { tty: true, ascii })[0]![0]!;
      prefix = `${paint([{ ...marker, text: markerCell("fail", ascii) }], !argv.includes("--json") && color === true)} `;
    }
    const code = (error as { exitCode?: number }).exitCode ?? ((error as Error).message.startsWith("usage:") ? EXIT.usage : EXIT.fail);
    console.error(prefix + formatCliError(error, code === 2, argv)); process.exitCode = code;
  }
  if (personStop !== undefined) endLikeSignal(personStop);   // after the report, with amem's own handlers already removed
}

if (import.meta.main) await main();
