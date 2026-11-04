/** Nonshipping diagnostic runtime; generated preload wrappers call activate(). */
import { appendFileSync, constants, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { transformSource } from "./task-127-transform.ts";
import { processIdentity, snapshotCursorLocks } from "./task-127-lock-probe.ts";
import { readCursorOffset } from "./task-127-read-cursor.ts";

const LIMIT = 512, RECORD_BYTES = 32, now = () => performance.timeOrigin + performance.now();
export function activate(repo: string, preload: string): void {
  const trace = process.env.AMEM_TASK127_TRACE_DIR;
  if (!trace) throw new Error("task127 trace directory is required");
  mkdirSync(trace, { recursive: true, mode: 0o700 });
  const callId = process.env.AMEM_TASK127_CALL_ID ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(callId)) throw new Error("task127 call identity malformed");
  const role = process.argv.some(arg => arg === join(repo, "src/session-brief-worker.ts")) ? "worker"
    : process.argv.some(arg => arg === join(repo, "bin/amem.js")) ? "cli" : "harness";
  const stem = `${callId}-${process.pid}`, file = join(trace, stem + ".bin");
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  writeFileSync(join(trace, stem + ".json"), JSON.stringify({ schema: 1, callId, pid: process.pid, role,
    identity: processIdentity(process.pid), entryAt: now(), recordBytes: RECORD_BYTES, limit: LIMIT }) + "\n", { mode: 0o600, flag: "wx" });
  let sequence = 0, faulted = false, observationCount = 0;
  const observer = (value: object) => {
    if (observationCount++ >= 24_576) { fault("observer row cap"); return; }
    appendFileSync(join(trace, `${stem}.observer.jsonl`), JSON.stringify({ ...value, at: now(), observerPid: process.pid, callId: activeCall ?? callId }) + "\n", { mode: 0o600 });
  };
  const fault = (reason: string) => {
    if (faulted) return;
    faulted = true;
    writeFileSync(join(trace, stem + ".fault.json"), JSON.stringify({ reason, pid: process.pid, callId }) + "\n");
  };
  const record = Buffer.alloc(RECORD_BYTES);
  const phase = (id: number, a = 0, b = 0) => {
    if (role === "harness" && id !== 1) return;
    if (sequence >= LIMIT) { fault("phase record cap"); return; }
    record.writeUInt32LE(id, 0); record.writeUInt32LE(sequence, 4); record.writeDoubleLE(now(), 8);
    record.writeDoubleLE(a, 16); record.writeDoubleLE(b, 24);
    try { if (writeSync(fd, record, 0, RECORD_BYTES, sequence * RECORD_BYTES) !== RECORD_BYTES) fault("partial phase write"); }
    catch { fault("phase write unavailable"); }
    sequence++;
  };
  let activeCall: string | undefined;
  const counts = new Map<string, number>();
  const candidates = (): number[] => {
    if (!activeCall) return [];
    try { return [JSON.parse(readFileSync(join(trace, activeCall + ".spawn.json"), "utf8")).pid as number]; }
    catch { return []; }
  };
  const r1 = async (stage: string, alive: number[], context: object) => {
    const pids = [...new Set([...alive, ...candidates()])];
    observer({ diagnostic: "task127-r1-identities", stage, context, alive,
      processes: pids.map(pid => processIdentity(pid)) });
  };
  const readCursor = (cursor: string, context: object) => readCursorOffset(cursor, {
    onBusy: event => observer({ diagnostic: "task127-cursor-busy", context, ...event }),
    onFirstBusy: async () => { observer({ diagnostic: "task127-first-busy-locks", context,
      snapshot: await snapshotCursorLocks(cursor, candidates()) }); },
  });
  const port = globalThis as unknown as {
    __t127phase: typeof phase; __t127fixtureEnv: () => NodeJS.ProcessEnv;
    __t127r1: typeof r1; __t127readCursor: typeof readCursor;
  };
  port.__t127phase = phase;
  port.__t127fixtureEnv = () => ({ BUN_OPTIONS: `--preload=${preload}`, AMEM_TASK127_TRACE_DIR: trace });
  port.__t127r1 = r1; port.__t127readCursor = readCursor;
  phase(1);
  // ponytail: diagnostic monkeypatches cover Bun's overloads with any; exact argv guards bound the seam.
  // Upgrade: a dedicated test-only subprocess observation port if the native argv contracts change.
  const mutable = Bun as unknown as { spawn: (...args: any[]) => any; spawnSync: (...args: any[]) => any };
  const spawn = mutable.spawn.bind(Bun), spawnSync = mutable.spawnSync.bind(Bun);
  mutable.spawn = (argv, options) => {
    if (!Array.isArray(argv) || argv[2] !== join(repo, "src/session-brief-worker.ts")) return spawn(argv, options);
    const child = spawn([argv[0], argv[1], "--preload", preload, ...argv.slice(2)], {
      ...options, env: { ...options?.env, AMEM_TASK127_TRACE_DIR: trace, AMEM_TASK127_CALL_ID: callId },
    });
    writeFileSync(join(trace, callId + ".spawn.json"), JSON.stringify({ callId, pid: child.pid, parentPid: process.pid,
      parentIdentity: processIdentity(process.pid), spawnedAt: now() }) + "\n", { mode: 0o600, flag: "wx" });
    return child;
  };
  mutable.spawnSync = (argv, options) => {
    if (!Array.isArray(argv) || argv[0] !== join(repo, "bin/amem.js") || argv[1] !== "hook") return spawnSync(argv, options);
    const input = JSON.parse(Buffer.from(options.stdin).toString("utf8")) as { session_id?: unknown };
    const match = typeof input.session_id === "string" ? /^(Stop|SessionEnd|StopBurst)-(\d+)$/.exec(input.session_id) : null;
    if (!match) throw new Error("task127 requires synthetic native workload identity");
    const id = randomUUID(), key = match[0], followUp = counts.get(key) ?? 0;
    if (!counts.has(key) && counts.size >= 120) throw new Error("task127 workload map cap");
    counts.set(key, followUp + 1); activeCall = id;
    const metadata = { callId: id, event: match[1], logicalRun: Number(match[2]), followUp, beforeAt: now() };
    writeFileSync(join(trace, id + ".call.json"), JSON.stringify(metadata) + "\n", { mode: 0o600, flag: "wx" });
    const result = spawnSync(argv, { ...options, env: { ...options.env, AMEM_TASK127_CALL_ID: id } });
    observer({ diagnostic: "task127-native-return", ...metadata, pid: result.pid, exitCode: result.exitCode, signalCode: result.signalCode });
    return result;
  };
  const targets = new Set(["src/hooks.ts", "src/hook-spool.ts", "src/hook-transcript.ts", "src/session-brief-worker.ts",
    "test/fakes/hooks-fixture.ts", "scripts/measure-transcript-budget.ts"]);
  Bun.plugin({ name: "task127-disposable-phases", setup(builder) {
    builder.onLoad({ filter: /[.](?:ts|js)$/ }, args => {
      const absolute = resolve(args.path);
      const relative = absolute.startsWith(repo + "/") ? absolute.slice(repo.length + 1) : "";
      if (!targets.has(relative)) return;
      return { loader: "ts", contents: transformSource(relative, readFileSync(absolute, "utf8")) };
    });
  } });
}
