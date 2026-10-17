import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, looksSecret, machineId } from "./memory/store.ts";
import { rawMemoryCommand, rawGoalCommand } from "./memory/commands.ts";
import { memoryProjectKey } from "./memory/project.ts";
import { CandidateStore, type CandidateFilter } from "./memory/candidates.ts";
import { appendAlias, listAliases } from "./memory/shard.ts";
import { capacityReport, capacityText } from "./memory/capacity.ts";
import { readCaptureConfigFile, writeCaptureConfigFile, type CaptureConfig } from "./memory/capture.ts";

import { commandHelp, parseCommand } from "./commands-table.ts";
import { completionScript } from "./completion.ts";
import { memoryHome } from "./memory/home.ts";
import { resolveProfile } from "./memory/generation.ts";
import { migrate } from "./memory/migrate.ts";
import { applyPrune, planPrune, PRUNE_PLAN_MAX_BYTES } from "./memory/prune.ts";

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

export async function runCli(argv: readonly string[], context: CliContext = {}): Promise<string> {
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
  const mutating = definition.mutates === true || definition.mutates === "apply" && options["--apply"] === true || definition.mutates === "label" && options["--label"] !== undefined;
  if (mutating && !(context.stdinTTY ?? process.stdin.isTTY)) throw new Error("mutating commands require a terminal on stdin");
  if (definition.policyFree && !policyFree) {
    throw new Error(review ? "review accept requires --policy-free; use ahub memory to apply the host's privacy policy" : `${sub} requires --policy-free; use ahub memory ${sub} to apply the host's privacy policy`);
  }
  if (sub === "migrate") {
    const modes = ["--dry-run", "--resume", "--deactivate"].filter(key => options[key] === true);
    if (modes.length > 1) throw new Error("migration modes are mutually exclusive");
    const mode = options["--dry-run"] ? "dry-run" : options["--resume"] ? "resume" : options["--deactivate"] ? "deactivate" : "apply";
    return JSON.stringify(await migrate({ memoryDir: memoryHome(), mode, ...(options["--generation"] ? { generation: String(options["--generation"]) } : {}), authorizedPerson: true, tty: true }), null, 2);
  }
  if (sub === "prune") {
    const applying = options["--apply"] === true;
    if (applying ? options["--dry-run"] || options["--cutoff"] || !options["--plan"] : !options["--dry-run"] || !options["--cutoff"] || options["--plan"]) throw new Error("usage: amem prune --cutoff <UTC> --dry-run | --apply --plan <file>");
    let input: string | undefined;
    if (applying) {
      input = readPrunePlanFile(String(options["--plan"]));
    }
    const store = new MemoryStore({ deferPromotions: true });
    try {
      const auth = { project: memoryProjectKey(context.cwd ?? process.cwd()), actor: "person" as const, authorize: () => true };
      return JSON.stringify(applying ? applyPrune(store.prunePort(), input, auth) : planPrune(store.prunePort(), { cutoff: String(options["--cutoff"]) }, auth), null, 2);
    } finally { store.close(); }
  }
  if (review) {
    if (resolveProfile(memoryHome()).kind === "generation") throw new Error("candidate review is not yet integrated with this generation; use the profile-aware host after its integration");
    const id = parsed.positionals[0];
    if (sub !== "list" && (!id || !/^[a-f0-9]{64}$/.test(id))) throw new Error("review accept/reject requires a full 64-character candidate id");
    const project = memoryProjectKey(context.cwd ?? process.cwd()), candidates = new CandidateStore();
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
      if (candidate.input.kind === "decay") throw new Error("decay candidates are listing-only; use ahub memory demote or forget after review");
      // Candidate acceptance uses the actual secret screen; the core defers unrelated automatic promotions.
      const store = new MemoryStore({ deferPromotions: true, screen: note => looksSecret(`${note.title ?? ""}\n${note.text}`) ? "keep" : "promote" });
      try {
        const result = candidates.accept(id!, { project, actor: "person", verdict: "public", store,
          policy: (proposal, _target, note) => !looksSecret(JSON.stringify(proposal.input)) && !looksSecret(JSON.stringify(note)),
        });
        return options["--json"] ? JSON.stringify(result, null, 2) : `accepted candidate ${id} as ordinary v1 note ${result.noteId}`;
      } finally { store.close(); }
    } finally { candidates.close(); }
  }
  if (sub === "capacity") {
    const share = options["--disk-share"];
    if (share !== undefined && (!Number.isFinite(Number(share)) || Number(share) <= 0 || Number(share) > 1)) throw new Error("--disk-share must be a number in (0, 1]");
    const report = capacityReport({ ...(share !== undefined ? { diskShare: Number(share) } : {}) });
    if (parsed.path[1] !== "apply") return options["--json"] ? JSON.stringify(report, null, 2) : capacityText(report);
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
  if (sub === "alias") {
    if (parsed.path[1] === "add") {
      const [from, to] = parsed.positionals;
      if (!from || !to) throw new Error("usage: amem alias add <from-key> <to-key>");
      const op = appendAlias(memoryHome(), { alias: from, key: to, actor: "person", machine: machineId(memoryHome()).id });
      return options["--json"] ? JSON.stringify(op, null, 2) : `alias ${op.alias} -> ${op.key}`;
    }
    const ops = listAliases(memoryHome());
    return options["--json"] ? JSON.stringify(ops, null, 2) : ops.length ? ops.map((op) => `${op.at}  ${op.alias} -> ${op.key}  (${op.actor})`).join("\n") : "no aliases recorded";
  }
  // ponytail: board task links need the host's authenticated task boundary; add a host bridge before supporting them here.
  if (goal && sub === "link") throw new Error("goal link needs host integration; use ahub goal link");
  const crosses = definition.policyFree === true && policyFree;
  // Reads can trigger held-note reconciliation. Defer it unless this terminal explicitly authorized crossing policy.
  const open = () => new MemoryStore({ screen: note => !crosses ? "skip" : looksSecret(`${note.title ?? ""}\n${note.text}`) ? "keep" : "promote" });
  const cwd = context.cwd ?? process.cwd();
  // A person's reads are unscreened. Writes crossing the boundary remain secret-screened without host policy.
  if (goal) return rawGoalCommand(args, cwd, { open, clean: (title, milestones) => !mutating || !looksSecret(`${title}\n${milestones.join("\n")}`) });
  const receipt: { bridgeStatus?: { skippedRows: number } } = {};
  const output = await rawMemoryCommand(args, cwd, { open, readable: notes => notes, importPolicy: () => () => false,
    onBridgeStatus: status => { receipt.bridgeStatus = status; } });
  return !options["--json"] && receipt.bridgeStatus
    ? `${output}\n(legacy malformed lines skipped: ${receipt.bridgeStatus.skippedRows})` : output;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try { console.log(await runCli(argv)); }
  catch (error) { console.error(`amem: ${(error as Error).message}`); process.exitCode = (error as { exitCode?: number }).exitCode ?? 1; }
}

if (import.meta.main) await main();
