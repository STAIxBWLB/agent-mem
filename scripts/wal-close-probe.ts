/** Disposable WAL-close experiment. No product edit, setting assignment or FFI.
 * SQLite contract references: https://sqlite.org/wal.html and https://sqlite.org/pragma.html#pragma_synchronous .
 * Process-kill recovery is distinct from power-loss durability; NORMAL never qualifies the no-close candidate.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { CaptureStore, CaptureInput } from "../src/memory/capture.ts";

const FIX_HEAD = "cdd196666e7efab2f7ec04c654a1bcfa8fd49517", CYCLES = 20;
const CASES = ["close", "passive-close", "truncate-close", "keeper-close", "kill-no-close", "other-writer-auto"] as const;
type Case = typeof CASES[number];
const ROWS = 32, AUTO_ROWS = 512, MAX_FILE_BYTES = 64 * 1024 * 1024;
const PROJECT = "wal-close-synthetic", SCHEMA = "wal-close-probe/v1";
const now = () => performance.timeOrigin + performance.now();
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
function json(file: string, value: unknown): void { writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); }
function hash(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function raw(file: string): Record<string, unknown> {
  const stat = lstatSync(file, { throwIfNoEntry: false, bigint: true });
  if (!stat) return { exists: false };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_FILE_BYTES)) throw Error("raw synthetic file bound/type");
  const fd = openSync(file, "r"), digest = createHash("sha256"), bytes = Buffer.alloc(64 * 1024), header = Buffer.alloc(Math.min(100, Number(stat.size)));
  let at = 0;
  try { for (;;) { const n = readSync(fd, bytes, 0, bytes.length, at); if (!n) break; if (at === 0) bytes.copy(header, 0, 0, header.length); digest.update(bytes.subarray(0, n)); at += n; if (at > MAX_FILE_BYTES) throw Error("raw file grew beyond bound"); } }
  finally { closeSync(fd); }
  const value: Record<string, unknown> = { exists: true, dev: String(stat.dev), ino: String(stat.ino), bytes: at, sha256: digest.digest("hex"), headerHex: header.toString("hex") };
  if (file.endsWith("-wal") && header.length >= 32) {
    const pageBytes = header.readUInt32BE(8);
    value.wal = { magicHex: header.subarray(0, 4).toString("hex"), version: header.readUInt32BE(4), pageBytes,
      checkpointSequence: header.readUInt32BE(12), saltsHex: header.subarray(16, 24).toString("hex"),
      physicalFrameSlots: pageBytes > 0 ? Math.max(0, (at - 32) / (pageBytes + 24)) : null,
      note: "Physical slots may include stale frames after WAL reuse; this is not a logical committed-frame count." };
  }
  return value;
}
function files(db: string) { return { at: now(), db: raw(db), wal: raw(db + "-wal"), shm: raw(db + "-shm") }; }
function setting(db: Database, name: string): unknown { return Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, unknown>)[0]; }
function readback(db: Database) {
  return { journalMode: setting(db, "journal_mode"), synchronous: setting(db, "synchronous"), walAutocheckpoint: setting(db, "wal_autocheckpoint"),
    pageSize: setting(db, "page_size"), fullfsync: setting(db, "fullfsync"), checkpointFullfsync: setting(db, "checkpoint_fullfsync"),
    sqlite: db.query("SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId").get() };
}
function privateDb(store: CaptureStore): Database { return (store as unknown as { db: Database }).db; }
/** Diagnostic-only lifetime fence: neither a store nor its DB may be GC-finalized before the owned hard exit. */
function pinUntilHardExit(...values: unknown[]): void {
  const retained = globalThis as unknown as { __walCloseProbeRetained?: unknown[] };
  (retained.__walCloseProbeRetained ??= []).push(...values);
}
interface Plan { schema: string; root: string; out: string; cycle: number; mode: Case; baseAt: string; sourceHead: string }
function planAt(root: string): Plan {
  const marker = join(root, "fixture.json"), stat = lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw Error("synthetic marker unavailable");
  const p = JSON.parse(readFileSync(marker, "utf8")) as Plan;
  // Cooperative fixture fencing, not authentication. The parent creates this new private directory only.
  if (p.schema !== SCHEMA || p.root !== resolve(root) || !p.root.startsWith(resolve(p.out) + "/") || p.sourceHead !== FIX_HEAD || !CASES.includes(p.mode) || p.cycle < 1 || p.cycle > CYCLES) throw Error("synthetic marker mismatch");
  return p;
}
function input(p: Plan, index: number): { row: CaptureInput; receipt: string } {
  return { row: { project: PROJECT, agent: "wal-probe", event: "Title", paths: [],
    at: new Date(Date.parse(p.baseAt) + index).toISOString(), excerpt: `synthetic cycle ${p.cycle} row ${index} ` + "x".repeat(1800) },
    receipt: hash(`${SCHEMA}:${p.cycle}:${index}`) };
}
const emit = (value: object) => { writeSync(1, JSON.stringify(value) + "\n"); };
async function handshake(): Promise<{ offsetLowerMs: number; offsetUpperMs: number; roundTripMs: number }> {
  const sent = now(); emit({ stage: "ready", at: sent });
  const reader = Bun.stdin.stream().getReader(); let text = "";
  try { while (!text.includes("\n")) { const next = await reader.read(); if (next.done) throw Error("clock acknowledgement missing"); text += new TextDecoder().decode(next.value); if (text.length > 1024) throw Error("clock acknowledgement bound"); } }
  finally { reader.releaseLock(); }
  const received = now(), ack = JSON.parse(text.trim()) as { parentReceived: number; parentSent: number };
  if (!Number.isFinite(ack.parentReceived) || !Number.isFinite(ack.parentSent) || ack.parentSent < ack.parentReceived) throw Error("clock acknowledgement invalid");
  return { offsetLowerMs: ack.parentSent - received, offsetUpperMs: ack.parentReceived - sent, roundTripMs: received - sent };
}
async function child(repo: string, root: string, verify: boolean): Promise<void> {
  const p = planAt(root), memory = join(root, "memory"), cwd = join(root, "project");
  if (!verify && existsSync(memory)) throw Error("primary requires a fresh memory home");
  const importStarted = now();
  const { CaptureStore } = await import(pathToFileURL(join(repo, "src/memory/capture.ts")).href) as typeof import("../src/memory/capture.ts");
  const { hookRssReading, hookPeakRssKB } = await import(pathToFileURL(join(repo, "src/hook-resources.ts")).href) as typeof import("../src/hook-resources.ts");
  const imported = now(), ctorEntered = now(), store = new CaptureStore({ memoryDir: memory, cwd, project: PROJECT, busyTimeoutMs: 0 });
  pinUntilHardExit(store, privateDb(store));
  const ctorReturned = now();
  const db = privateDb(store), file = join(store.dir, "capture.db"), actual = readback(db), rows = p.mode === "other-writer-auto" ? AUTO_ROWS : ROWS;
  if (verify) {
    const before = store.rows({ project: PROJECT, limit: AUTO_ROWS + 1 });
    if (before.length !== rows) throw Error(`reopen row count ${before.length}, expected ${rows}`);
    for (let index = 0; index < rows; index++) { const expected = input(p, index); const found = before[index]; if (!found || found.at !== expected.row.at || found.excerpt !== expected.row.excerpt) throw Error("reopened row content/time mismatch"); }
    for (let index = 0; index < rows; index++) { const expected = input(p, index), result = store.append(expected.row, { receipt: expected.receipt }); if (!("already" in result) || result.already !== true) throw Error("stable receipt did not deduplicate"); }
    if (store.rows({ project: PROJECT, limit: AUTO_ROWS + 1 }).length !== rows) throw Error("receipt replay changed row count");
    store.close(); emit({ stage: "verified", rows, allReceiptsAlready: true, actual, ctorMs: ctorReturned - ctorEntered }); process.exit(0);
  }
  let keeper: Database | undefined, second: CaptureStore | undefined;
  const timing: Record<string, number> = { moduleImportMs: imported - importStarted, ctorEntered, ctorReturned, ctorMs: ctorReturned - ctorEntered };
  if (p.mode === "keeper-close") { keeper = new Database(file); pinUntilHardExit(keeper); keeper.query("SELECT COUNT(*) FROM rows").get(); }
  if (p.mode === "other-writer-auto") { const start = now(); second = new CaptureStore({ memoryDir: memory, cwd, project: PROJECT, busyTimeoutMs: 0 }); pinUntilHardExit(second, privateDb(second)); timing.secondCtorMs = now() - start; }
  const writer = second ?? store, writerDb = privateDb(writer), initial = files(file), appendMs: number[] = [], autoSnapshots: ReturnType<typeof files>[] = [];
  for (let index = 0; index < rows; index++) {
    const expected = input(p, index), begin = now(), result = writer.append(expected.row, { receipt: expected.receipt }); appendMs.push(now() - begin);
    if (!("id" in result)) throw Error("probe append was not committed to actual database");
    if (p.mode === "other-writer-auto" && (index + 1) % 32 === 0) autoSnapshots.push(files(file));
  }
  const count = (writerDb.query("SELECT COUNT(*) AS n FROM rows").get() as { n: number }).n;
  if (count !== rows) throw Error("primary append count mismatch");
  const beforeStep = files(file), beforeActual = readback(writerDb), clock = await handshake();
  const probe: Record<string, unknown> = { stage: "result", mode: p.mode, cycle: p.cycle, rows, pid: process.pid, file, actual, beforeActual,
    keeperActual: keeper ? readback(keeper) : undefined, initial, beforeStep, autoSnapshots, timing, appendMs, clock };
  if (p.mode === "passive-close" || p.mode === "truncate-close") {
    timing.checkpointEntered = now(); probe.checkpoint = db.query(`PRAGMA wal_checkpoint(${p.mode === "passive-close" ? "PASSIVE" : "TRUNCATE"})`).get(); timing.checkpointReturned = now();
    probe.afterCheckpoint = files(file); // Probe-only checkpoint, never a product option or production proposal.
  }
  if (p.mode !== "kill-no-close") {
    timing.closeEntered = now(); store.close(); timing.closeReturned = now();
    if (keeper) { probe.whileKeeperOpen = files(file); timing.keeperCloseEntered = now(); keeper.close(); timing.keeperCloseReturned = now(); }
    if (second) { probe.whileSecondOpen = files(file); timing.secondCloseEntered = now(); second.close(); timing.secondCloseReturned = now(); }
  }
  // Same finish transport in every primary case: actual hook RSS readers, bounded output, own-group SIGKILL.
  timing.outputEntered = now(); probe.peakRssKB = hookPeakRssKB(); await Bun.stdout.write(JSON.stringify(probe) + "\n"); const outputReturned = now();
  const rssEntered = now(), rss = hookRssReading(), rssReturned = now();
  emit({ stage: "finish", outputReturned, rssEntered, rssReturned, rss, signalRequestAt: now() });
  if (process.env.WAL_PROBE_OWN_GROUP !== "1") throw Error("owned detached group marker missing");
  process.kill(-process.pid, "SIGKILL"); throw Error("self SIGKILL returned");
}
export async function runChild(repo: string, root: string, verify: boolean) {
  const stdoutFile = join(root, verify ? "verify.stdout.jsonl" : "primary.stdout.jsonl"), stderrFile = join(root, verify ? "verify.stderr.log" : "primary.stderr.log");
  writeFileSync(stdoutFile, ""); writeFileSync(stderrFile, ""); const frames: Record<string, unknown>[] = [], startedAt = now();
  const owned = Bun.spawn([process.execPath, fileURLToPath(import.meta.url), "--child", "--repo", repo, "--root", root, ...(verify ? ["--verify"] : [])], {
    detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: join(root, "home"), AMEM_HOME: join(root, "memory"), XDG_CONFIG_HOME: join(root, "home/.config"), WAL_PROBE_OWN_GROUP: "1" },
  });
  const processFile = join(root, verify ? "verify-process.json" : "primary-process.json");
  json(processFile, { startedAt, pid: owned.pid, timedOut: false, noticeAt: null, command: verify ? "verify" : "primary" });
  let noticeAt: number | undefined, timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
  const exit = owned.exited.then(code => { noticeAt = now(); if (timer) clearTimeout(timer); return code; });
  timer = setTimeout(() => { timedOut = true; json(processFile, { startedAt, pid: owned.pid, timedOut, noticeAt: noticeAt ?? null, signalRequestedAt: now(), note: "Logical watchdog; syscall/exit delay may outlast it and must remain censored." }); owned.kill("SIGKILL"); }, 35_000);
  const consume = async (stream: ReadableStream<Uint8Array>, destination: string, parse: boolean) => {
    const reader = stream.getReader(), decoder = new TextDecoder(); let text = "", total = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > 256 * 1024) { owned.kill("SIGKILL"); throw Error("child output bound"); }
      const part = decoder.decode(next.value, { stream: true }); appendFileSync(destination, part);
      if (parse) { text += part; for (;;) { const newline = text.indexOf("\n"); if (newline < 0) break; const line = text.slice(0, newline); text = text.slice(newline + 1); if (!line) continue;
        const frame = JSON.parse(line) as Record<string, unknown>; frames.push(frame);
        if (frame.stage === "ready") { const parentReceived = now(); owned.stdin.write(JSON.stringify({ parentReceived, parentSent: now() }) + "\n"); owned.stdin.end(); }
      } }
    } } } finally { reader.releaseLock(); }
  };
  try { const [exitCode] = await Promise.all([exit, consume(owned.stdout, stdoutFile, true), consume(owned.stderr, stderrFile, false)]);
    json(processFile, { startedAt, pid: owned.pid, timedOut, noticeAt, exitCode, signalCode: owned.signalCode });
    return { startedAt, noticeAt: noticeAt!, seconds: (now() - startedAt) / 1000, exitCode, signalCode: owned.signalCode, timedOut, frames };
  } catch (error) {
    if (noticeAt === undefined) { owned.kill("SIGKILL"); const reaped = await Promise.race([exit.then(() => true), Bun.sleep(1000).then(() => false)]); if (!reaped) { owned.unref(); throw Error("owned child cleanup unresolved; stop subsequent cases"); } }
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}
function percentile(values: number[], q: number): number | null { return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]! : null; }
function distribution(values: number[]) { return { count: values.length, minMs: values.length ? Math.min(...values) : null, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: values.length ? Math.max(...values) : null }; }
async function main(): Promise<void> {
  const repoArg = arg("--repo"), outArg = arg("--out"); if (!repoArg || !outArg) throw Error("usage: wal-close-probe.ts --repo FROZEN_CHECKOUT --out NEW_DIRECTORY");
  const repo = resolve(repoArg), out = resolve(outArg);
  if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true" || Bun.version !== "1.4.2" || process.env.BUN_OPTIONS || process.env.AMEM_TASK127_TRACE_DIR) throw Error("requires uninstrumented hosted macOS Bun1.4.2");
  const head = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  if (head !== FIX_HEAD) throw Error("fixed source head mismatch");
  if (existsSync(out) && readdirSync(out).length) throw Error("output must be new/empty; results never overwritten"); mkdirSync(out, { recursive: true, mode: 0o700 });
  const sourceHash = hash(readFileSync(join(repo, "src/memory/capture.ts"))), baseAt = new Date().toISOString();
  const systemHome = join(out, "system-home"); mkdirSync(systemHome, { mode: 0o700 });
  const system = Bun.spawnSync(["/usr/bin/sqlite3", ":memory:", "SELECT sqlite_version(),sqlite_source_id();"], { stdout: "pipe", stderr: "pipe", timeout: 3000, env: { PATH: process.env.PATH ?? "", HOME: systemHome, XDG_CONFIG_HOME: join(systemHome, ".config") } });
  json(join(out, "plan.json"), { schema: SCHEMA, FIX_HEAD, sourceHash, controllerHash: hash(readFileSync(fileURLToPath(import.meta.url))), cycles: CYCLES, cases: CASES, rows: ROWS, autoRows: AUTO_ROWS, baseAt,
    systemSQLiteCLI: { exitCode: system.exitCode, stdout: system.stdout.toString(), stderr: system.stderr.toString(), role: "separate system SQLite, not Bun's producer/consumer" },
    limitations: ["Synthetic ASCII rows and controlled fresh homes do not establish production tail bounds or power-loss survival.", "No hook deadline/RSS verdict, journaling setting or synchronous setting is changed."] });
  const results: Record<string, unknown>[] = []; let blocked: string | undefined;
  for (let cycle = 1; cycle <= CYCLES; cycle++) for (const mode of cycle % 2 ? CASES : [...CASES].reverse()) {
    const root = join(out, `cycle-${String(cycle).padStart(2, "0")}-${mode}`); mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "home")); mkdirSync(join(root, "project"));
    json(join(root, "fixture.json"), { schema: SCHEMA, root, out, cycle, mode, baseAt, sourceHead: FIX_HEAD } satisfies Plan);
    const result: Record<string, unknown> = { cycle, mode, root, executed: false, pass: false };
    try {
      if (blocked) throw Error("not executed after prior cleanup/timeout: " + blocked);
      const primary = await runChild(repo, root, false); result.executed = true; result.primary = primary;
      if (primary.timedOut) { blocked = "primary timed out"; throw Error(blocked); }
      if (primary.signalCode !== "SIGKILL") throw Error("primary did not end in own SIGKILL");
      const payload = primary.frames.find(frame => frame.stage === "result"), finish = primary.frames.find(frame => frame.stage === "finish");
      if (!payload || !finish || typeof payload.file !== "string" || !payload.file.startsWith(join(root, "memory") + "/")) throw Error("primary result/finish or synthetic file binding missing");
      const beforeReopen = files(payload.file); result.beforeFirstReopen = beforeReopen;
      // No SQLite open has occurred after the target action before this raw evidence snapshot.
      const verification = await runChild(repo, root, true); result.verification = verification;
      if (verification.timedOut) { blocked = "verification timed out"; throw Error(blocked); }
      if (verification.exitCode !== 0 || !verification.frames.some(frame => frame.stage === "verified")) throw Error("row/receipt reopen verification failed");
      const actual = payload.beforeActual as { journalMode: unknown; synchronous: unknown; walAutocheckpoint: unknown };
      if (String(actual.journalMode).toLowerCase() !== "wal") throw Error("CaptureStore did not read back WAL");
      const timing = payload.timing as Record<string, number>, clock = payload.clock as { offsetLowerMs: number; offsetUpperMs: number };
      if (![clock.offsetLowerMs, clock.offsetUpperMs].every(Number.isFinite) || clock.offsetLowerMs > clock.offsetUpperMs) throw Error("clock-offset interval invalid");
      const start = mode === "kill-no-close" ? timing.outputEntered! : timing.closeEntered!;
      result.finishBoundsMs = { lower: primary.noticeAt - start - clock.offsetUpperMs, upper: primary.noticeAt - start - clock.offsetLowerMs };
      if ((result.finishBoundsMs as { upper: number }).upper < 0) throw Error("negative finish interval");
      result.closeMs = timing.closeReturned === undefined ? null : timing.closeReturned - timing.closeEntered!;
      const step = payload.beforeStep as ReturnType<typeof files>;
      const dbChanged = step.db.sha256 !== beforeReopen.db.sha256;
      result.causality = { dbChanged, walExistedBefore: step.wal.exists, walBytesBefore: step.wal.bytes, walExistsAfterTarget: beforeReopen.wal.exists, walBytesAfterTarget: beforeReopen.wal.bytes,
        whileKeeperOpen: payload.whileKeeperOpen, whileSecondOpen: payload.whileSecondOpen, checkpoint: payload.checkpoint, afterCheckpoint: payload.afterCheckpoint };
      if (mode === "close" && (step.wal.exists !== true || beforeReopen.wal.exists === true || !dbChanged)) throw Error("last-close WAL removal and main-DB change not demonstrated");
      if (mode === "keeper-close") {
        const held = payload.whileKeeperOpen as ReturnType<typeof files>;
        if (held.wal.exists !== true || held.db.sha256 !== step.db.sha256 || beforeReopen.wal.exists === true || !dbChanged) throw Error("keeper counterfactual did not defer WAL cleanup/main-DB change until last close");
      }
      if (mode === "passive-close" || mode === "truncate-close") {
        const checkpoint = payload.checkpoint as { busy: number; log: number; checkpointed: number }, after = payload.afterCheckpoint as ReturnType<typeof files>;
        if (checkpoint.busy !== 0 || after.db.sha256 === step.db.sha256 || (mode === "passive-close" && checkpoint.log !== checkpoint.checkpointed) ||
          (mode === "truncate-close" && after.wal.exists === true && after.wal.bytes !== 0)) throw Error("probe-only checkpoint result/file causality incomplete");
      }
      if (mode === "kill-no-close") {
        result.commitDurabilityEligible = typeof actual.synchronous === "number" && actual.synchronous >= 2;
        if (result.commitDurabilityEligible !== true) throw Error("no-close candidate rejected: actual synchronous does not certify per-commit WAL durability; process-kill recovery is insufficient");
        if (step.wal.exists !== true || beforeReopen.wal.exists !== true || step.wal.sha256 !== beforeReopen.wal.sha256 || step.db.sha256 !== beforeReopen.db.sha256) throw Error("no-close raw WAL/DB changed before first reopen");
      }
      if (mode === "other-writer-auto") {
        const initial = payload.initial as ReturnType<typeof files>, shots = payload.autoSnapshots as ReturnType<typeof files>[];
        const initialWal = initial.wal.wal as { checkpointSequence?: number; saltsHex?: string } | undefined;
        result.autoCheckpointObserved = typeof actual.walAutocheckpoint === "number" && actual.walAutocheckpoint > 0 && shots.some(shot => {
          const header = shot.wal.wal as { checkpointSequence?: number; saltsHex?: string } | undefined;
          return shot.db.sha256 !== initial.db.sha256 && header && initialWal && ((header.checkpointSequence ?? 0) > (initialWal.checkpointSequence ?? 0) || header.saltsHex !== initialWal.saltsHex);
        });
        if (result.autoCheckpointObserved !== true) throw Error("bounded normal-write automatic checkpoint not demonstrated");
      }
      result.pass = true;
    } catch (error) { result.error = String(error); if (String(error).includes("cleanup unresolved")) blocked = String(error); }
    json(join(root, "case-result.json"), result); results.push(result); console.log(JSON.stringify({ cycle, mode, pass: result.pass, error: result.error }));
  }
  const distributionFor = (mode: Case) => distribution(results.filter(result => result.mode === mode && result.pass === true).map(result => (result.finishBoundsMs as { upper: number }).upper));
  const close = distributionFor("close"), noClose = distributionFor("kill-no-close");
  const complete = results.length === CYCLES * CASES.length && results.every(result => result.executed === true &&
    !(result.primary as { timedOut?: boolean })?.timedOut && !!result.verification && !(result.verification as { timedOut?: boolean })?.timedOut);
  const sourceUnchanged = sourceHash === hash(readFileSync(join(repo, "src/memory/capture.ts"))) && Bun.spawnSync(["git", "-C", repo, "diff", "--quiet", FIX_HEAD, "--", "src"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  const pass = complete && sourceUnchanged && results.every(result => result.pass === true);
  json(join(out, "summary.json"), { schema: SCHEMA, head, sourceHash, sourceUnchanged, measurementComplete: complete, pass, results,
    finishDistributions: Object.fromEntries(CASES.map(mode => [mode, distributionFor(mode)])),
    candidateF: { closeMs: close.count === CYCLES ? Math.ceil(close.maxMs!) : null, noCloseMs: noClose.count === CYCLES ? Math.ceil(noClose.maxMs!) : null,
      rule: "Ceiling of maximum paired child-to-parent finish UPPER bound; clock-offset interval comes from a pre-step pipe handshake. No arbitrary8ms constant. Censored/failed cases cannot qualify a candidate.",
      limitation: "Twenty controlled samples are not a future worst-case bound. No-close requires actual synchronous>=FULL2 plus replay proof; no power-cut test was performed." } });
  if (!pass) process.exitCode = 1;
}
if (import.meta.main) try { if (process.argv.includes("--child")) { const repo = arg("--repo"), root = arg("--root"); if (!repo || !root) throw Error("child repo/root required"); await child(resolve(repo), resolve(root), process.argv.includes("--verify")); } else await main(); }
catch (error) { console.error(JSON.stringify({ stage: "probe-error", error: String(error) })); process.exitCode = 1; }
