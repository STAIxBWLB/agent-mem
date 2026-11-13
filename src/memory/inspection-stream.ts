import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";

export interface InspectionPrefix { offset: number; hash: string }
export interface InspectionLocation { offset: number; length: number }
export interface InspectionStreamResult { offset: number; hash: string; tailBytes: number; stamp: string; start: number }
export class InspectionStreamError extends Error {
  constructor(
    readonly code: "input-unavailable" | "input-changed" | "input-bound",
    readonly bound?: { kind: "row-bytes"; limit: number; observed: number },
  ) { super(code); this.name = "InspectionStreamError"; }
}

const CHUNK_BYTES = 64 * 1024;
// ponytail: retain at most a 16 MiB physical row by default. Larger rows need
// incremental JSON decoding rather than whole-row retention.
const DEFAULT_ROW_BYTES = 16 * 1024 * 1024;
const stampOf = (stat: BigIntStats) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String));
function filesystem<T>(read: () => T, code: "input-unavailable" | "input-changed" = "input-unavailable"): T {
  try { return read(); } catch { throw new InspectionStreamError(code); }
}

/**
 * Read-only complete-line visitation with no total source-byte or physical-row limit.
 * Locations exclude the newline. A nonempty unterminated tail refuses the whole read;
 * callers must not certify callback results until this function and their final recheck succeed.
 * Retained input is one bounded line plus one chunk; assembling a split line can briefly duplicate it.
 */
export function visitInspectionFile(
  file: string,
  prefixes: readonly InspectionPrefix[],
  visit: (bytes: Buffer, location: InspectionLocation) => void,
  maxRowBytes = DEFAULT_ROW_BYTES,
): InspectionStreamResult {
  if (!Number.isSafeInteger(maxRowBytes) || maxRowBytes < 0) throw new InspectionStreamError("input-unavailable");
  const expected = [...prefixes].sort((left, right) => left.offset - right.offset);
  for (const prefix of expected) {
    if (!Number.isSafeInteger(prefix.offset) || prefix.offset < 0 || !/^[a-f0-9]{64}$/.test(prefix.hash)) throw new InspectionStreamError("input-unavailable");
  }
  const before = filesystem(() => lstatSync(file, { bigint: true }));
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(Number(before.size))) throw new InspectionStreamError("input-unavailable");
  const size = Number(before.size), stamp = stampOf(before);
  if (expected.some(prefix => prefix.offset > size)) throw new InspectionStreamError("input-changed");
  const fd = filesystem(() => openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  let completed = false;
  try {
    const opened = filesystem(() => fstatSync(fd, { bigint: true }));
    if (!opened.isFile() || stampOf(opened) !== stamp) throw new InspectionStreamError("input-changed");
    const hash = createHash("sha256");
    let nextPrefix = 0;
    while (expected[nextPrefix]?.offset === 0) {
      if (hash.copy().digest("hex") !== expected[nextPrefix]!.hash) throw new InspectionStreamError("input-changed");
      nextPrefix++;
    }
    const hashPiece = (piece: Buffer, offset: number) => {
      let start = 0;
      while (nextPrefix < expected.length && expected[nextPrefix]!.offset <= offset + piece.length) {
        const prefix = expected[nextPrefix]!, end = prefix.offset - offset;
        if (end <= 0 || piece[end - 1] !== 10) throw new InspectionStreamError("input-changed");
        hash.update(piece.subarray(start, end));
        if (hash.copy().digest("hex") !== prefix.hash) throw new InspectionStreamError("input-changed");
        start = end; nextPrefix++;
      }
      hash.update(piece.subarray(start));
    };
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let offset = 0, lineOffset = 0, lineBytes = 0, parts: Buffer[] = [];
    while (offset < size) {
      const count = filesystem(() => readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset));
      if (!count) throw new InspectionStreamError("input-changed");
      let start = 0;
      while (start < count) {
        const newline = chunk.subarray(0, count).indexOf(10, start), end = newline < 0 ? count : newline;
        const length = end - start, observed = lineBytes + length;
        if (observed > maxRowBytes) throw new InspectionStreamError("input-bound", { kind: "row-bytes", limit: maxRowBytes, observed });
        if (length) parts.push(Buffer.from(chunk.subarray(start, end)));
        lineBytes = observed;
        const through = newline < 0 ? count : end + 1;
        hashPiece(chunk.subarray(start, through), offset + start);
        if (newline >= 0) {
          const bytes = parts.length === 1 ? parts[0]! : Buffer.concat(parts, lineBytes);
          const location = { offset: lineOffset, length: lineBytes };
          parts = []; lineBytes = 0; lineOffset = offset + through;
          visit(bytes, location);
        }
        start = through;
      }
      offset += count;
    }
    const current = filesystem(() => fstatSync(fd, { bigint: true }), "input-changed");
    const named = filesystem(() => lstatSync(file, { bigint: true }), "input-changed");
    if (!current.isFile() || !named.isFile() || named.isSymbolicLink() || stampOf(current) !== stamp || stampOf(named) !== stamp) throw new InspectionStreamError("input-changed");
    if (lineOffset !== size || nextPrefix !== expected.length) throw new InspectionStreamError("input-unavailable");
    const result = { offset: size, hash: hash.digest("hex"), tailBytes: 0, stamp, start: 0 };
    completed = true;
    return result;
  } finally {
    try { closeSync(fd); }
    catch { if (completed) throw new InspectionStreamError("input-unavailable"); }
  }
}

/** Re-read one complete physical row only while its whole-file identity still matches the captured source. */
export function readInspectionRow(
  file: string,
  location: InspectionLocation,
  expectedStamp: string,
  maxRowBytes = DEFAULT_ROW_BYTES,
): Buffer {
  if (!Number.isSafeInteger(maxRowBytes) || maxRowBytes < 0
    || !Number.isSafeInteger(location.offset) || location.offset < 0
    || !Number.isSafeInteger(location.length) || location.length < 0
    || !Number.isSafeInteger(location.offset + location.length)) throw new InspectionStreamError("input-unavailable");
  if (location.length > maxRowBytes) throw new InspectionStreamError("input-bound", { kind: "row-bytes", limit: maxRowBytes, observed: location.length });
  const before = filesystem(() => lstatSync(file, { bigint: true }));
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(Number(before.size))) throw new InspectionStreamError("input-unavailable");
  const stamp = stampOf(before);
  if (stamp !== expectedStamp) throw new InspectionStreamError("input-changed");
  if (location.offset + location.length >= Number(before.size)) throw new InspectionStreamError("input-unavailable");
  const fd = filesystem(() => openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  let completed = false;
  try {
    const opened = filesystem(() => fstatSync(fd, { bigint: true }));
    if (!opened.isFile() || stampOf(opened) !== stamp) throw new InspectionStreamError("input-changed");
    const edge = Buffer.alloc(1);
    const newline = (offset: number) => filesystem(() => readSync(fd, edge, 0, 1, offset)) === 1 && edge[0] === 10;
    if (location.offset > 0 && !newline(location.offset - 1) || !newline(location.offset + location.length)) throw new InspectionStreamError("input-unavailable");
    const bytes = Buffer.alloc(location.length);
    let at = 0;
    while (at < bytes.length) {
      const count = filesystem(() => readSync(fd, bytes, at, Math.min(CHUNK_BYTES, bytes.length - at), location.offset + at));
      if (!count) throw new InspectionStreamError("input-changed");
      at += count;
    }
    const current = filesystem(() => fstatSync(fd, { bigint: true }), "input-changed");
    const named = filesystem(() => lstatSync(file, { bigint: true }), "input-changed");
    if (!current.isFile() || !named.isFile() || named.isSymbolicLink() || stampOf(current) !== stamp || stampOf(named) !== stamp) throw new InspectionStreamError("input-changed");
    completed = true;
    return bytes;
  } finally {
    try { closeSync(fd); }
    catch { if (completed) throw new InspectionStreamError("input-unavailable"); }
  }
}
