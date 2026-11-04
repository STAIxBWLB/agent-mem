/** Task 123 measurement branch only. Never merge this diagnostic helper into production. */
import { lstatSync } from "node:fs";

export const PHASE_BYTES = 4096, PHASE_MAGIC = 123226, PHASE_SLOTS = 127;
export const phases = {
  1: "worker.boot", 2: "worker.await-options", 3: "worker.receipt-ready", 4: "worker.capture-module-ready",
  10: "scan.enter", 11: "scan.return", 12: "scan.setup", 13: "cursor.open.enter", 14: "cursor.open.return",
  15: "cursor.begin.enter", 16: "cursor.begin.return", 17: "cursor.commit.enter", 18: "cursor.commit.return",
  19: "cursor.close.enter", 20: "cursor.close.return", 21: "scan.read.enter", 22: "scan.read.return",
  30: "publication.enter", 31: "publication.return", 32: "publication.admission", 34: "publication.write.enter",
  35: "publication.write.return", 36: "publication.rename.enter", 37: "publication.rename.return",
  40: "replay.enter", 41: "replay.return", 42: "store.constructor.enter", 43: "store.constructor.return",
  44: "store.append.enter", 45: "store.append.return", 46: "store.close.enter", 47: "store.close.return",
  50: "worker.await-final-receipt", 51: "worker.final-replay.enter", 52: "worker.final-replay.return",
  53: "worker.final-scope.enter", 54: "worker.final-scope.return", 55: "worker.emit.enter", 56: "worker.emit.return",
  57: "worker.rss.enter", 58: "worker.rss.return", 59: "worker.self-kill", 60: "worker.exit",
  70: "capture.constructor.body", 71: "capture.database.open.enter", 72: "capture.database.open.return",
  73: "capture.database.init.enter", 74: "capture.database.init.return", 75: "capture.append.transaction.enter",
  76: "capture.append.transaction.return",
} as const;
export type Phase = keyof typeof phases;
interface Mapping { bytes: Uint8Array<ArrayBuffer>; words: Uint32Array; view: DataView }
const worker = process.env.AMEM_TASK123_WORKER === "1";
let mapped: Mapping | undefined, attempted = false, sequence = 0;
function memory(): Mapping | undefined {
  if (attempted) return mapped;
  attempted = true;
  const file = process.env.AMEM_TASK123_TRACE;
  if (!file) return;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== PHASE_BYTES || stat.mode & 0o077) return;
    const bytes = Bun.mmap(file, { shared: true, sync: false, size: PHASE_BYTES });
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (Atomics.load(words, 0) !== PHASE_MAGIC || Atomics.load(words, 1) !== 1) return;
    mapped = { bytes, words, view };
    return mapped;
  } catch { return; }
}
/** Only the owned capture worker writes; the CLI only snapshots. No syscall per phase. */
export function phase(code: Phase, value = 0, count = 0): void {
  if (!worker) return;
  const map = memory(); if (!map) return;
  const prior = Atomics.load(map.words, 3);
  if (prior !== 0 && prior !== process.pid) return;
  Atomics.store(map.words, 3, process.pid);
  const seq = ++sequence, word = 8 + ((seq - 1) % PHASE_SLOTS) * 8, at = word * 4;
  Atomics.store(map.words, word, 0);
  map.view.setUint32(at + 4, code, true);
  map.view.setFloat64(at + 8, performance.timeOrigin + performance.now(), true);
  map.view.setFloat64(at + 16, value, true);
  map.view.setUint32(at + 24, count, true);
  Atomics.store(map.words, word + 7, seq);
  Atomics.store(map.words, word, seq);
  Atomics.store(map.words, 2, seq);
}
export function decodePhaseTrace(bytes: Uint8Array, history = true) {
  if (bytes.byteLength !== PHASE_BYTES) return { available: false as const, reason: "trace-size" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== PHASE_MAGIC || view.getUint32(4, true) !== 1) return { available: false as const, reason: "trace-header" };
  const lastSeq = view.getUint32(8, true), workerPid = view.getUint32(12, true), records = [];
  for (let seq = history ? Math.max(1, lastSeq - PHASE_SLOTS + 1) : lastSeq; seq > 0 && seq <= lastSeq; seq++) {
    const at = 32 + ((seq - 1) % PHASE_SLOTS) * 32;
    if (view.getUint32(at, true) !== seq || view.getUint32(at + 28, true) !== seq) continue;
    const code = view.getUint32(at + 4, true) as Phase, epochMs = view.getFloat64(at + 8, true);
    if (!(code in phases) || !Number.isFinite(epochMs)) continue;
    const value = view.getFloat64(at + 16, true), count = view.getUint32(at + 24, true);
    if (view.getUint32(at, true) !== seq || view.getUint32(at + 28, true) !== seq) continue;
    records.push({ seq, code, phase: phases[code], epochMs, value, count });
  }
  return { available: true as const, workerPid, lastSeq, overwritten: Math.max(0, lastSeq - PHASE_SLOTS), last: records.at(-1), ...(history ? { records } : {}) };
}
export function phaseSnapshot(history = false) {
  const map = memory();
  return map ? decodePhaseTrace(map.bytes, history) : { available: false as const, reason: "trace-map" };
}
