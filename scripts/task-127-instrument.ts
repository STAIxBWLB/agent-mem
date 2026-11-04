/** Task127 installer/analyzer. It writes only diagnostic output, never an arm's sources. */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { PHASES, transformSource } from "./task-127-transform.ts";
import { buildDarwinLockProbe } from "./task-127-lock-probe.ts";

const TARGETS = ["src/hooks.ts", "src/hook-spool.ts", "src/hook-transcript.ts", "src/session-brief-worker.ts",
  "test/fakes/hooks-fixture.ts", "scripts/measure-transcript-budget.ts"];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function option(name: string): string {
  const index = process.argv.indexOf(name), value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return resolve(value);
}
export function install(repo: string, out: string, probeBinary?: string): void {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const sources: Record<string, { before: string; transformed: string }> = {};
  for (const file of TARGETS) {
    const text = readFileSync(join(repo, file), "utf8"), transformed = transformSource(file, text);
    new Bun.Transpiler({ loader: "ts" }).transformSync(transformed);
    sources[file] = { before: digest(text), transformed: digest(transformed) };
  }
  for (const name of ["task-127-preload.ts", "task-127-transform.ts", "task-127-lock-probe.ts", "task-127-read-cursor.ts", "task-127-fgetlk.c", "task-127-startup.ts", "task-127-r1.ts"]) {
    copyFileSync(join(import.meta.dir, name), join(out, name));
  }
  if (process.platform === "darwin") {
    if (probeBinary) { copyFileSync(probeBinary, join(out, "task-127-fgetlk")); chmodSync(join(out, "task-127-fgetlk"), 0o700); }
    else buildDarwinLockProbe(out);
  }
  const preload = join(out, "preload.ts");
  writeFileSync(preload, `import { activate } from "./task-127-preload.ts";\nactivate(${JSON.stringify(repo)}, ${JSON.stringify(preload)});\n`, { mode: 0o600, flag: "wx" });
  const manifest = { schema: 1, repo, preload, phases: PHASES, recordBytes: 32, maxRecordsPerProcess: 512,
    nativeProbe: process.platform === "darwin" ? { sha256: digest(readFileSync(join(out, "task-127-fgetlk"))), sourceSHA256: digest(readFileSync(join(out, "task-127-fgetlk.c"))) } : null,
    sources, observerEffects: ["Every native process loads a diagnostic preload, records native start identity, opens an artifact FD and performs bounded unfsynced phase writes.",
      "Parent spawn observes child identity; R1/BUSY observers run outside handler timing but can change inter-call host state.",
      "Matched instrumented outcomes select hypotheses; only separate uninstrumented runs establish acceptance."] };
  writeFileSync(join(out, "instrumentation.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ installed: true, preload, sourceFilesUnchanged: true }));
}
interface Header { schema: number; callId: string; pid: number; role: string; identity: unknown; entryAt: number; recordBytes: number; limit: number }
interface Phase { id: number; name: string; sequence: number; at: number; a: number; b: number }
export function analyze(trace: string, stdout: string): object {
  const faults: string[] = [], headers = new Map<string, Header>(), records = new Map<string, Phase[]>();
  const calls: { callId: string; event: string; logicalRun: number; followUp: number }[] = [];
  const observer: Record<string, unknown>[] = [];
  const spawns = new Map<string, { pid: number; parentPid: number; childIdentity?: { available?: boolean; startIdentity?: string } }>();
  const starts: { callId: string; pid: number; role: string; entryAt: number }[] = [];
  const intents = new Map<string, object>();
  const rawEntries = new Map<string, number>();
  const files = readdirSync(trace);
  if (files.length > 80_000) throw new Error("task127 artifact file cap");
  for (const name of files) {
    if (name.endsWith(".fault.json")) faults.push(name + ": " + readFileSync(join(trace, name), "utf8").slice(0, 500));
    else if (name.endsWith(".call.json")) calls.push(JSON.parse(readFileSync(join(trace, name), "utf8")));
    else if (name.endsWith(".spawn.json")) spawns.set(name.slice(0, -11), JSON.parse(readFileSync(join(trace, name), "utf8")));
    else if (name.endsWith(".intent.json")) intents.set(name.slice(0, -12), JSON.parse(readFileSync(join(trace, name), "utf8")));
    else if (name.endsWith(".start.json")) {
      try { starts.push(JSON.parse(readFileSync(join(trace, name), "utf8"))); }
      catch { faults.push("malformed startup prefix: " + name); }
    }
    else if (name.endsWith(".observer.jsonl")) {
      for (const line of readFileSync(join(trace, name), "utf8").trim().split("\n").filter(Boolean)) {
        try { observer.push(JSON.parse(line)); } catch { faults.push("malformed observer: " + name); }
      }
    } else if (/^[a-f0-9-]{36}-\d+[.]json$/.test(name)) {
      try { headers.set(name.slice(0, -5), JSON.parse(readFileSync(join(trace, name), "utf8"))); }
      catch { faults.push("malformed header: " + name); }
    }
  }
  const binaries = new Set(files.filter(name => name.endsWith(".bin")).map(name => name.slice(0, -4)));
  for (const [stem, header] of headers) {
    if (!binaries.has(stem)) faults.push("header without binary: " + stem);
    if (stem !== `${header.callId}-${header.pid}` || !["cli", "worker", "harness"].includes(header.role)) faults.push("header identity mismatch: " + stem);
    if (!(header.identity as { available?: boolean })?.available) faults.push("entry PID identity unavailable: " + stem);
  }
  for (const name of files.filter(name => name.endsWith(".bin"))) {
    const stem = name.slice(0, -4), bytes = readFileSync(join(trace, name)), header = headers.get(stem), phases: Phase[] = [];
    if (bytes.length >= 32 && bytes.readUInt32LE(0) === 1 && bytes.readUInt32LE(4) === 0 && Number.isFinite(bytes.readDoubleLE(8))) rawEntries.set(stem, bytes.readDoubleLE(8));
    if (!header || header.schema !== 1 || header.recordBytes !== 32 || header.limit !== 512 || bytes.length % 32 || bytes.length > 16_384) { faults.push("invalid binary/header: " + name); continue; }
    for (let offset = 0; offset < bytes.length; offset += 32) {
      const id = bytes.readUInt32LE(offset), sequence = bytes.readUInt32LE(offset + 4), at = bytes.readDoubleLE(offset + 8);
      const a = bytes.readDoubleLE(offset + 16), b = bytes.readDoubleLE(offset + 24);
      if (!PHASES[id] || sequence !== phases.length || ![at, a, b].every(Number.isFinite)) faults.push("invalid phase: " + name + ":" + offset);
      phases.push({ id, name: PHASES[id] ?? "unknown", sequence, at, a, b });
    }
    if (phases[0]?.id !== 1) faults.push("missing process entry: " + name);
    records.set(stem, phases);
  }
  const diagnostics: Record<string, unknown>[] = [];
  for (const line of readFileSync(stdout, "utf8").split("\n")) {
    if (!line.startsWith('{"diagnostic"')) continue;
    try { diagnostics.push(JSON.parse(line)); } catch { faults.push("malformed stdout diagnostic"); }
  }
  const invocations = diagnostics.filter(row => row.diagnostic === "transcript-budget-invocation");
  const key = (row: { event?: unknown; logicalRun?: unknown; followUp?: unknown }) => JSON.stringify([row.event, row.logicalRun, row.followUp]);
  const byKey = new Map(calls.map(call => [key(call), call]));
  const callIds = new Set(calls.map(call => call.callId));
  if (byKey.size !== calls.length) faults.push("duplicate workload call mapping");
  const invocationKeys = new Set(invocations.map(key));
  if (invocationKeys.size !== invocations.length) faults.push("duplicate native invocation");
  if (invocations.length !== calls.length) faults.push("invocation/call count mismatch");
  for (const invocation of invocations) if (!byKey.has(key(invocation))) faults.push("invocation without call mapping: " + key(invocation));
  for (const call of calls) if (!invocationKeys.has(key(call))) faults.push("call without native invocation: " + key(call));
  for (const [, header] of headers) if (header.role !== "harness" && !callIds.has(header.callId)) faults.push("orphan process header: " + header.callId);
  const ownershipStillObserved: object[] = [];
  const results = calls.map(call => {
    const processes = [...headers.entries()].filter(([, header]) => header.callId === call.callId && header.role !== "harness");
    const cli = processes.filter(([, header]) => header.role === "cli");
    if (cli.length !== 1) faults.push("missing/duplicate CLI process: " + call.callId);
    const worker = processes.filter(([, header]) => header.role === "worker");
    if (worker.length > 1) faults.push("multiple workers for one call: " + call.callId);
    const spawn = spawns.get(call.callId);
    if (spawn && spawn.parentPid !== cli[0]?.[1].pid) faults.push("spawn parent mismatch: " + call.callId);
    if (worker.length && worker[0]![1].pid !== spawn?.pid) faults.push("worker/spawn mismatch: " + call.callId);
    if (spawn && !worker.length) faults.push("startup incomplete: spawned worker lacks full header: " + call.callId);
    const observedIdentity = worker[0]?.[1].identity as { available?: boolean; startIdentity?: string } | undefined;
    if (observedIdentity?.available && spawn?.childIdentity?.available && observedIdentity.startIdentity !== spawn.childIdentity.startIdentity) faults.push("worker start identity changed: " + call.callId);
    const expectedIdentity = observedIdentity?.available ? observedIdentity : spawn?.childIdentity;
    for (const row of observer.filter(row => row.callId === call.callId && row.diagnostic === "task127-r1-identities" && row.stage === "after")) {
      for (const process of row.processes as { pid: number; available: boolean; startIdentity?: string; state?: string }[]) {
        if (process.pid === spawn?.pid && process.available && expectedIdentity?.available && process.startIdentity === expectedIdentity.startIdentity) {
          ownershipStillObserved.push({ callId: call.callId, at: row.at, process, limitation: "PID still observed after command-path R1 check; may be exiting/zombie, not final-exit or lock ownership proof" });
        }
      }
    }
    const workerPhases = worker.flatMap(([stem]) => records.get(stem) ?? []);
    const reads = workerPhases.filter(phase => phase.id === 108), consumed = workerPhases.filter(phase => phase.id === 116);
    if (reads.length > 1 || reads.some(phase => phase.a < 0 || phase.a > 256 * 1024)) faults.push("scan read budget or count exceeded: " + call.callId);
    const startupPrefixes = starts.filter(start => start.callId === call.callId);
    const rawChildEntry = startupPrefixes.some(prefix => prefix.role === "worker" && prefix.pid === spawn?.pid
      && rawEntries.get(`${call.callId}-${prefix.pid}`) === prefix.entryAt);
    return { ...call, processes: processes.map(([stem, header]) => ({ ...header, phases: records.get(stem) ?? [] })),
      startupAttribution: { intent: intents.get(call.callId) ?? null, spawn: spawn ?? null, prefixes: startupPrefixes,
        childEntryPrefixObserved: rawChildEntry, validatedChildPhaseObserved: workerPhases.some(phase => phase.id === 1),
        limitation: "Parent intent/spawn attributes a pre-phase-1 kill; it does not manufacture a child phase or complete trace." },
      readBytes: reads[0]?.a ?? null, consumedBytes: consumed[0]?.a ?? null,
      scanBytesKnown: reads.length === 1, consumedBytesKnown: consumed.length === 1,
      workerFullHeaderTraceMissing: worker.length === 0,
      observations: observer.filter(row => row.callId === call.callId) };
  });
  const busy = observer.filter(row => row.diagnostic === "task127-cursor-busy");
  const finalOwnership = observer.filter(row => row.diagnostic === "task127-r1-final" && row.ownershipUnresolved === true);
  return { observerComplete: faults.length === 0 && calls.length > 0, faults,
    invocationCount: invocations.length, callMetadataCount: calls.length,
    missingFullWorkerHeaders: results.filter(row => row.workerFullHeaderTraceMissing).length,
    overflowOrErrorCount: faults.length, ownershipUnresolved: ownershipStillObserved.length > 0 || finalOwnership.length > 0, ownershipStillObserved, finalOwnership,
    firstBusyCount: busy.filter(row => row.attempt === 1).length,
    cursorBusyObservations: busy, lockObservations: observer.filter(row => row.diagnostic === "task127-first-busy-locks" || row.diagnostic === "task127-r1-exiting-locks"),
    calls: results, limitations: ["Absent worker entry may be a kill before preload entry; it is not proof of process exit.",
      "Last numeric phase bounds an observed interval, not a kernel stack or guaranteed syscall cause.",
      "Missing post-kill scan byte counters are unknown, never silently zero.", "Lock snapshots may race release and need stable PID identities for attribution."] };
}
if (import.meta.main) {
  if (process.argv.includes("--analyze")) {
    const result = analyze(option("--analyze"), option("--stdout"));
    writeFileSync(option("--out"), JSON.stringify(result, null, 2) + "\n");
    process.exitCode = (result as { observerComplete: boolean }).observerComplete ? 0 : 1;
  } else install(option("--repo"), option("--out"), process.argv.includes("--probe-binary") ? option("--probe-binary") : undefined);
}
