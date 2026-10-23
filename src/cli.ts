import { createMemoryMcp } from "./mcp-memory.ts";
import { serveMcp } from "./mcp.ts";
import { createStandalonePolicy } from "./memory/policy.ts";
import { vaultCandidates } from "./memory/vault.ts";
import { importClaudeMemWorkState } from "./memory/import.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, looksSecret, machineId, openShardStore, type StoreOptions } from "./memory/store.ts";
import { rawMemoryCommand, rawGoalCommand } from "./memory/commands.ts";
import { memoryProjectKey } from "./memory/project.ts";
import { CandidateStore, type CandidateFilter } from "./memory/candidates.ts";
import { aliasedKeys, appendAlias, appendUnalias, listAliases, readShardedSelection, resolveAlias } from "./memory/shard.ts";
import { capacityReport, capacityText } from "./memory/capacity.ts";
import { readCaptureConfigFile, writeCaptureConfigFile, type CaptureConfig } from "./memory/capture.ts";

import { commandHelp, parseCommand } from "./commands-table.ts";
import { completionScript } from "./completion.ts";
import { memoryHome } from "./memory/home.ts";
import { resolveProfile } from "./memory/generation.ts";
import { migrate } from "./memory/migrate.ts";
import { migrateShards, shardMigrationStatus } from "./memory/shard-migration.ts";
import { applyPrune, planPrune, PRUNE_PLAN_MAX_BYTES } from "./memory/prune.ts";
import { readCatalogFresh } from "./memory/catalog.ts";
import { appendLifecycle, projectState } from "./memory/lifecycle.ts";
import { gcText, runGc } from "./memory/gc.ts";
import { usageReport, usageText } from "./memory/usage.ts";
import { exportProject } from "./memory/project-export.ts";
import { searchAllProjects, vaultCandidatesAll } from "./memory/cross-project.ts";
import { requireShard } from "./memory/curated-read.ts";
import { applySplit, previewSplit } from "./memory/capacity-split.ts";

export const PERSON_ONLY = "amem is for the person; agents read memory through the hub's hub_memory_* tools";
const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
export interface CliContext { cwd?: string; env?: Readonly<Record<string, string | undefined>>; stdinTTY?: boolean }

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
  return ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].some(key => env[key] !== undefined);
}

function shardStatePresent(): boolean {
  try { lstatSync(join(memoryHome(), "shards.json")); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** `reconciled` (#27): the project filter also covers every key aliased to `project`; prune and other planners keep the exact key. */
function curatedStore(project: string, opts: StoreOptions, reconciled = true): MemoryStore {
  const aliases = reconciled ? aliasedKeys(memoryHome(), project) : [];
  const withAliases: StoreOptions = aliases.length ? { ...opts, reconcile: { canonical: project, aliases } } : opts;
  if (shardStatePresent()) {
    readShardedSelection(memoryHome());
    return openShardStore({ ...withAliases, project });
  }
  return new MemoryStore(withAliases);
}

export async function runCli(argv: readonly string[], context: CliContext = {}): Promise<string> {
  if (argv.length === 1 && argv[0] === "mcp") {
    const memory = createMemoryMcp({ cwd: context.cwd ?? process.cwd(), base: memoryHome(context.env ?? process.env) });
    await serveMcp({ tools: memory.tools, close: memory.close, version: VERSION });
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
    if (parsed.positionals.length !== 1 || !["codex", "kimi", "pi"].includes(kind ?? "")) throw new Error("usage: amem ingest codex|kimi|pi [--since ISO] [--json]");
    const { ingestTranscript } = await import("./ingest.ts");
    return JSON.stringify(await ingestTranscript(kind as "codex" | "kimi" | "pi", {
      cwd: context.cwd ?? process.cwd(), base: memoryHome(context.env ?? process.env),
      ...(typeof parsed.options["--since"] === "string" ? { since: parsed.options["--since"] as string } : {}),
    }));
  }
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
  const goal = parsed.path[0] === "goal", review = parsed.path[0] === "review", sub = goal || review ? parsed.path[1]! : parsed.path[0]!;
  const policyFree = options["--policy-free"] === true;
  const mutating = definition.mutates === true || definition.mutates === "apply" && options["--apply"] === true || definition.mutates === "label" && options["--label"] !== undefined
    || definition.mutates === "confirm" && options["--confirm"] === true;
  if (mutating && !(context.stdinTTY ?? process.stdin.isTTY)) throw new Error("mutating commands require a terminal on stdin");
  if (definition.policyFree && !policyFree) {
    throw new Error(review ? "review accept requires --policy-free; use ahub memory to apply the host's privacy policy" : `${sub} requires --policy-free; use ahub memory ${sub} to apply the host's privacy policy`);
  }
  let canonicalProject: string | undefined;
  const boundProject = () => canonicalProject ??= resolveAlias(memoryHome(), memoryProjectKey(context.cwd ?? process.cwd()));
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
  if (sub === "status") return JSON.stringify(shardMigrationStatus(memoryHome()), null, 2);
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
  if (review) {
    if (sub === "accept" && options["--kind"] !== "memory" && shardStatePresent()) throw new Error("candidate acceptance requires shard-aware review integration; use --kind memory only for a general memory candidate");
    if (sub === "accept" && options["--kind"] !== "memory" && resolveProfile(memoryHome()).kind === "generation") throw new Error("candidate review is not yet integrated with this generation; use --kind memory only for a general memory candidate");
    if (sub === "list" && options["--kind"] !== "memory" && resolveProfile(memoryHome()).kind === "generation") throw new Error("candidate review is not yet integrated with this generation; select --kind memory for the standalone memory candidate surface");
    const id = parsed.positionals[0];
    if (sub !== "list" && (!id || !/^[a-f0-9]{64}$/.test(id))) throw new Error("review accept/reject requires a full 64-character candidate id");
    const project = boundProject(), aliases = aliasedKeys(memoryHome(), project), candidates = new CandidateStore(aliases.length ? { reconcile: { canonical: project, aliases } } : {});
    try {
      if (sub === "list") {
        const rows = candidates.list({ project, ...(options["--status"] ? { status: options["--status"] as CandidateFilter["status"] } : {}),
          ...(options["--kind"] ? { kind: options["--kind"] as CandidateFilter["kind"] } : {}), ...(options["--limit"] ? { limit: Number(options["--limit"]) } : {}) });
        return options["--json"] ? JSON.stringify(rows, null, 2) : rows.length ? rows.map(candidate => `${candidate.id}  ${candidate.input.kind}  ${candidate.status}  ${candidate.createdAt}`).join("\n") : "no candidates waiting for review";
      }
      if (sub === "reject") {
        candidates.reject(id!, { project, actor: "person", verdict: "public" });
        return options["--json"] ? JSON.stringify({ candidateId: id, status: "rejected" }, null, 2) : `rejected candidate ${id}`;
      }
      const candidate = candidates.get(id!, project);
      if (!candidate) throw new Error("candidate unavailable");
      if (options["--kind"] === "memory" && candidate.input.kind !== "memory") throw new Error("--kind memory accepts only a general memory candidate");
      if (candidate.input.kind === "decay") throw new Error("decay candidates are listing-only; use ahub memory demote or forget after review");
      if (candidate.input.kind !== "memory" && (shardStatePresent() || resolveProfile(memoryHome()).kind === "generation")) throw new Error("candidate acceptance requires shard-aware and profile-aware host integration for this candidate kind; the candidate remains pending");
      const standalone = createStandalonePolicy();
      if (!await standalone.screen(candidate.input)) throw new Error("candidate refused by current host policy; current standalone privacy policy declined it");
      // Candidate acceptance uses the actual secret screen; the core defers unrelated automatic promotions.
      const store = curatedStore(project, { deferPromotions: true, screen: note => looksSecret(`${note.title ?? ""}\n${note.text}`) ? "keep" : "promote" });
      try {
        const result = candidates.accept(id!, { project, actor: "person", verdict: "public", store,
          policy: (proposal, _target, note) => !looksSecret(JSON.stringify(proposal.input)) && !looksSecret(JSON.stringify(note)),
        });
        return options["--json"] ? JSON.stringify(result, null, 2) : `accepted candidate ${id} as ordinary note ${result.noteId}`;
      } finally { store.close(); }
    } finally { candidates.close(); }
  }
  if (sub === "vault-candidates" && (options["--all-projects"] === true || options["--project"] !== undefined)) {
    if (options["--all-projects"] === true && options["--project"] !== undefined) throw new Error("choose either --all-projects or --project <key>, not both");
    const result = await vaultCandidatesAll(memoryHome(), { policy: createStandalonePolicy(), ...(options["--project"] !== undefined ? { project: resolveAlias(memoryHome(), String(options["--project"])) } : {}), ...(options["--limit"] ? { limit: Number(options["--limit"]) } : {}) });
    return JSON.stringify(result, null, 2);
  }
  if (sub === "vault-candidates") {
    const project = boundProject(), store = curatedStore(project, { deferPromotions: true });
    try {
      const result = await vaultCandidates(store, { project, policy: createStandalonePolicy(), ...(options["--limit"] ? { limit: Number(options["--limit"]) } : {}) });
      return JSON.stringify(result, null, 2);
    } finally { store.close(); }
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
    return rows.map(p => `${p.key}  ${p.state}${p.local ? "  local-only key" : ""}${p.aliases.length ? `  aliases: ${p.aliases.join(", ")}` : ""}  capture ${p.captureRows} rows ${mb(p.captureBytes)}  curated ${p.curatedEntries ?? "unavailable"}  disk ${mb(p.diskBytes)}  last ${p.captureLastAt ?? "never"}`).join("\n");
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
  if (sub === "project") {
    const op = parsed.path[1]!, [requested] = parsed.positionals;
    if (!requested) throw new Error(`usage: amem project ${op} <key>`);
    if (op === "export") {
      if (typeof options["--to"] !== "string") throw new Error("usage: amem project export <key> --to <file>");
      // The screen is the standalone one (secrets, PII patterns, denied paths); `--policy-free` is accepted only because a person may decline the host's narrower policy, which amem alone does not have.
      const result = await exportProject(memoryHome(), requested, { to: options["--to"] });
      return options["--json"] ? JSON.stringify(result, null, 2) : `exported ${result.project} to ${result.file}: ${result.counts.capture} capture rows, ${result.counts.curated} notes, ${result.counts.goals} goals, ${result.counts.workLists} work lists${result.withheld ? `; ${result.withheld} withheld by the screen` : ""}`;
    }
    const key = requireShard(memoryHome(), requested);
    if (op === "forget" && options["--confirm"] !== true) {
      const state = projectState(memoryHome(), key), shard = readCatalogFresh(memoryHome()).find(p => p.key === key);
      return `preview: forget ${key} (now ${state}; capture ${shard?.captureRows ?? 0} rows, curated ${shard?.curatedEntries ?? "unavailable"}). Forget is an append-only record that takes the project out of recall and every listing for good; nothing is erased here and it cannot be undone. Re-run with --confirm to record it.`;
    }
    const written = appendLifecycle(memoryHome(), { op: op as "archive" | "unarchive" | "forget", key, actor: "person", machine: machineId(memoryHome()).id });
    return options["--json"] ? JSON.stringify(written, null, 2) : `${op === "forget" ? "forgot" : op === "archive" ? "archived" : "unarchived"} ${written.key}${requested !== written.key ? ` (alias ${requested})` : ""}`;
  }
  if (sub === "search" && options["--all-projects"] === true) {
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
  if (goal && sub === "link") throw new Error("goal link needs host integration; use ahub goal link");
  const crosses = definition.policyFree === true && policyFree;
  const cwd = context.cwd ?? process.cwd();
  // Reads can trigger held-note reconciliation. Defer it unless this terminal explicitly authorized crossing policy.
  const open = () => curatedStore(boundProject(), { screen: note => !crosses ? "skip" : looksSecret(`${note.title ?? ""}\n${note.text}`) ? "keep" : "promote" });
  // A person's reads are unscreened. Writes crossing the boundary remain secret-screened without host policy.
  if (goal) return rawGoalCommand(args, cwd, { project: boundProject(), open, clean: (title, milestones) => !mutating || !looksSecret(`${title}\n${milestones.join("\n")}`) });
  const receipt: { bridgeStatus?: { skippedRows: number } } = {};
  const output = await rawMemoryCommand(args, cwd, { project: boundProject(), open, readable: notes => notes, importPolicy: () => () => false,
    onBridgeStatus: status => { receipt.bridgeStatus = status; } });
  if (sub === "import" && parsed.path[1] === "claude-mem") {
    const policy = createStandalonePolicy();
    const work = await importClaudeMemWorkState({ base: memoryHome(), project: boundProject(), policy: row => policy.screen(row), ...(options["--db"] ? { db: String(options["--db"]) } : {}), ...(options["--limit"] ? { limit: Number(options["--limit"]) } : {}), restart: options["--restart"] === true });
    return options["--json"] ? JSON.stringify({ ...JSON.parse(output), work }, null, 2) : `${output}\nwork lists: ${JSON.stringify(work)}`;
  }
  return !options["--json"] && receipt.bridgeStatus
    ? `${output}\n(legacy malformed lines skipped: ${receipt.bridgeStatus.skippedRows})` : output;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try { const output = await runCli(argv); if (output) console.log(output); }
  catch (error) { console.error(`amem: ${(error as Error).message}`); process.exitCode = (error as { exitCode?: number }).exitCode ?? 1; }
}

if (import.meta.main) await main();
