import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generationDir, readSelector } from "./generation.ts";

/**
 * F16, `amem sync --if-due`: the person's own shell (an EXIT trap) asks amem to sync when it is due; amem itself runs nothing between sessions and never
 * registers a hook for it. Like every mutating command it needs a terminal, so an unattended scheduler (cron, launchd) is not a caller (a hook may not do network work: AGENTS.md, test/hooks-network.test.ts). The only state is one small stamp beside the logs.
 * The stamp holds times and a failure count, never an error text (a git error can carry a remote URL).
 */
export interface SyncState { lastAttemptAt: string | null; lastOkAt: string | null; failures: number }
export const SYNC_STATE_FILE = "sync-state.json";
/** After a success, the next attempt is due this long after the last one. */
export const SYNC_INTERVAL_MS = 60 * 60_000;
/** After a failure the wait starts here and doubles with each further failure. */
export const SYNC_BACKOFF_BASE_MS = 15 * 60_000;
export const SYNC_BACKOFF_CAP_MS = 24 * 60 * 60_000;
const MAX_FAILURES = 30, MAX_BYTES = 4096;
const EMPTY: SyncState = { lastAttemptAt: null, lastOkAt: null, failures: 0 };
const iso = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;

/** Never throws: a missing, oversized or malformed stamp is "no history", which makes a sync due. */
export function readSyncState(home: string): SyncState {
  let fd: number | undefined;
  try {
    fd = openSync(join(home, SYNC_STATE_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return { ...EMPTY };
    const buffer = Buffer.alloc(stat.size), size = readSync(fd, buffer, 0, buffer.length, 0);
    const value = JSON.parse(buffer.subarray(0, size).toString("utf8")) as Record<string, unknown>;
    const failures = Number.isSafeInteger(value.failures) && (value.failures as number) >= 0 ? Math.min(value.failures as number, MAX_FAILURES) : 0;
    return { lastAttemptAt: iso(value.lastAttemptAt), lastOkAt: iso(value.lastOkAt), failures };
  } catch { return { ...EMPTY }; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to close */ } }
}

/** The wait after the last attempt: the plain interval after a success, 15 minutes doubling to a day after failures. */
export function syncWaitMs(failures: number): number {
  return failures <= 0 ? SYNC_INTERVAL_MS : Math.min(SYNC_BACKOFF_BASE_MS * 2 ** (failures - 1), SYNC_BACKOFF_CAP_MS);
}

/** The earliest next attempt, or null when none was recorded (due now). */
export function nextSyncAt(state: SyncState): number | null {
  return state.lastAttemptAt === null ? null : Date.parse(state.lastAttemptAt) + syncWaitMs(state.failures);
}

/** `force` (`--force`) ignores the schedule and the backoff. */
export function syncDue(state: SyncState, now: number, force = false): boolean {
  const next = nextSyncAt(state);
  return force || next === null || now >= next;
}

/** `--if-due` stops a running git step after this long, so a shell that runs it on exit is held for a bounded time. */
export const SYNC_IF_DUE_DEADLINE_MS = 30_000;

/**
 * The stop signal of one `--if-due` run: the 30 second deadline, or any way the person ends it: Ctrl-C (SIGINT), SIGTERM, SIGHUP (the terminal closed, which is also how an
 * EXIT trap's shell can go away) and SIGQUIT. git runs in its own process group while a stop signal is given (so the stop reaches its transport children), which also means a
 * terminal's signals no longer reach git by themselves: amem turns each of them into the abort. `on`, not `once`: a second Ctrl-C must not fall back to the default action
 * (which would end amem and strand git) while the first is still stopping git; the handlers stay until `dispose`. A process that dies some other way is covered by the exit
 * handler in sync.ts, which signals every live git group. The emitter is a seam for tests; the CLI passes `process`.
 */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
export type StopCause = "person" | "deadline";
export function stopSignal(ms: number, emitter: { on(name: string, fn: () => void): unknown; off(name: string, fn: () => void): unknown }, names: readonly string[] = STOP_SIGNALS): { signal: AbortSignal; dispose: () => void; cause: () => StopCause | undefined; signalName: () => string | undefined } {
  const controller = new AbortController(), deadline = AbortSignal.timeout(ms);
  let cause: StopCause | undefined, named: string | undefined;
  // The first thing that ends the run is its cause: a person who closes the terminal after the deadline already fired did not stop it.
  const handlers = names.map(name => [name, () => { if (cause === undefined) { cause = "person"; named = name; } controller.abort(); }] as const);
  deadline.addEventListener("abort", () => { cause ??= "deadline"; }, { once: true });
  for (const [name, handler] of handlers) emitter.on(name, handler);
  return { signal: AbortSignal.any([controller.signal, deadline]), dispose: () => { for (const [name, handler] of handlers) emitter.off(name, handler); }, cause: () => cause, signalName: () => named };
}

/**
 * End this process the way the signal would have, once amem's own handlers are removed (a handler suppresses the default action, so a run a person ended would otherwise exit 1
 * instead of 130, 143, 129). SIGQUIT's default action is a core dump, and Bun honours it: a re-raised SIGQUIT on Linux writes a core file the size of the process image (measured
 * 5.9 GB, taking seconds, in a container with `ulimit -c unlimited`) while the shell waits for the exit, so it exits with the status that death would have had (128 + 3) at once.
 */
export function endLikeSignal(name: string): void {
  if (name === "SIGQUIT") process.exit(128 + 3);
  process.kill(process.pid, name as NodeJS.Signals);
}

/**
 * The repository the active profile syncs through: a curated split keeps a private cache in `shard-sync/objects.git`, a generation home keeps its own `.git` inside the
 * generation directory (the memory home's own `.git` is then only the legacy input), and shared-v1 keeps `.git` in the memory home. Undefined when the profile cannot be
 * resolved (an unreadable selector): no remote is then reported rather than a guess.
 */
function syncRepository(home: string): string | undefined {
  try {
    if (lstatSync(join(home, "shards.json"), { throwIfNoEntry: false })) return join(home, "shard-sync", "objects.git", "config");
    const { selector } = readSelector(home);
    if (selector?.kind === "generation") return join(generationDir(home, selector.generation!), ".git", "config");
    return join(home, ".git", "config");
  } catch { return undefined; }
}

/**
 * Whether the active profile has a sync remote configured, from its repository's own config file: no git process, and never the URL (it can carry a credential).
 */
export function remoteConfigured(home: string): boolean {
  const file = syncRepository(home);
  if (file === undefined) return false;
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) return false;
    const buffer = Buffer.alloc(stat.size), size = readSync(fd, buffer, 0, buffer.length, 0);
    return /^\s*\[remote "origin"\]/m.test(buffer.subarray(0, size).toString("utf8"));
  } catch { return false; }   // no such repository
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to close */ } }
}

/** A stamp from the future (a clock set back, a hand edit) would block the sync until then plus the wait: it counts as no history, and so does a success it claims. */
export function usableState(state: SyncState, now: number): SyncState {
  const future = (value: string | null) => value !== null && Date.parse(value) > now;
  if (future(state.lastAttemptAt)) return { lastAttemptAt: null, lastOkAt: future(state.lastOkAt) ? null : state.lastOkAt, failures: 0 };
  return future(state.lastOkAt) ? { ...state, lastOkAt: null } : state;
}

/**
 * What a finished sync means for the schedule. `ok` clears the backoff. `local` is a refusal that the schedule cannot fix and that no remote ever saw, or a run its person ended (another sync or
 * mutation holds the lock, no remote is configured, the configured policy declines a note, the remote is public, a usage error): it is not stamped, so it neither
 * backs the schedule off nor makes a contended run look like a failed one. Everything else is a `failed` transport or git step, and an error this module does not
 * recognise counts as failed (the safe side: it waits instead of retrying every minute).
 */
export type SyncOutcome = "ok" | "failed" | "local";
const LOCAL = /^(usage:|another (sync|memory mutation|generation|shard sync)|no (generation )?sync remote|the configured privacy policy|the sync remote is public|this (machine's|store's) long-term|a line of this machine's long-term|more than \d+ long-term)/;
export function syncOutcome(error: string | undefined, cause?: StopCause): SyncOutcome {
  if (error === undefined) return "ok";
  // A run its person ended (Ctrl-C, a closing terminal) is not a failure of the remote: the same Ctrl-C reads "fetch failed" or "stopped" depending on which step it hit, so the cause,
  // not the text, decides. Only the deadline (a remote that did not answer in time) stays a failure to back off from.
  if (cause === "person") return "local";
  return LOCAL.test(error.replace(/^amem sync: /, "")) ? "local" : "failed";
}

/** Records one attempt. A stamp that cannot be written never fails the sync it describes. */
export function recordSyncAttempt(home: string, ok: boolean, at: number): SyncState {
  const prior = readSyncState(home), when = new Date(at).toISOString();
  const next: SyncState = { lastAttemptAt: when, lastOkAt: ok ? when : prior.lastOkAt, failures: ok ? 0 : Math.min(prior.failures + 1, MAX_FAILURES) };
  const file = join(home, SYNC_STATE_FILE), temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(next) + "\n", { mode: 0o600 });
    renameSync(temp, file);
  } catch { try { rmSync(temp, { force: true }); } catch { /* best effort */ } }
  return next;
}
