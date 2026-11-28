import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";

/**
 * Format floors (#199 AC5). `formats.json` in the memory home is an append-only JSON array of `{ surface, minReader, since }` records: a
 * person appends one to stop releases older than `minReader` from reading that surface (`home` covers every surface). This package never
 * writes the file, so no writer raises a floor implicitly. Each surface checks its floor before it creates, opens or writes anything, and a
 * reader below it refuses with `code: "format_floor"`; a file this version cannot read refuses with `code: "format_floor_unreadable"`.
 * A record naming a surface this version does not know is not its concern. Releases before this one do not read the file.
 */
export const FORMATS_FILE = "formats.json";
export const FORMAT_SURFACES = ["curated", "capture", "hook-spool", "candidates", "work-lists", "sync"] as const;
export type FormatSurface = typeof FORMAT_SURFACES[number];
export interface FormatFloor { surface: string; minReader: string; since: string }
/**
 * The first release whose readers understand the `preference` note kind (#370). An older reader drops such a row and refuses its own
 * machine's sync publish over it, so a preference write is refused until a person records a floor at or above this one.
 */
// The writer refuses until the person records the floor, so no host writes a row its peers cannot sync past.
export const PREFERENCE_MIN_READER = "0.25.0";
const MAX_BYTES = 64 * 1024, SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export class FormatFloorError extends Error {
  constructor(readonly code: "format_floor" | "format_floor_unreadable", message: string, readonly floor?: FormatFloor & { reader: string }) { super(message); this.name = "FormatFloorError"; }
}
/**
 * This release's version, read once when the module loads, so a long-running process whose install is replaced in place keeps comparing its own
 * version. Undefined when it cannot be read: then every applicable floor refuses.
 */
const READER_VERSION: string | undefined = (() => {
  try { const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown }; return typeof version === "string" && SEMVER.test(version) ? version : undefined; }
  catch { return undefined; }
})();
/** This release's plain version as read at load, or undefined when unreadable. */
export function amemReaderVersion(): string | undefined { return READER_VERSION; }
const parts = (version: string) => SEMVER.exec(version)!.slice(1, 4).map(Number);
/** Compare versions accepted by format-floor records, using their numeric release components. */
export function formatVersionBelow(reader: string, floor: string): boolean {
  const a = parts(reader), b = parts(floor);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

// #656: parsed floors by resolved file path plus dev:ino:size:mtimeNs:ctimeNs, so a fence check that runs per row does not reopen
// the file. A stat error or any stamp change takes the full read; only a read whose open stamp equals its pre-open stamp is kept.
// ponytail: same-size in-place rewrites within one stat tick are not seen (the profile-marker-cache ceiling); upgrade is a content hash.
const floorMemo = new Map<string, { stamp: string; floors: FormatFloor[] }>();
const floorStamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
/** Bounded read of the floor records: undefined when there is no file; anything that is not a regular file of valid records refuses. */
export function readFormatFloors(home: string): FormatFloor[] | undefined {
  const file = join(home, FORMATS_FILE);
  let before: BigIntStats | undefined;
  try { before = lstatSync(file, { bigint: true, throwIfNoEntry: false }); } catch { before = undefined; }
  const cached = floorMemo.get(file);
  if (before?.isFile() && cached && cached.stamp === floorStamp(before)) return cached.floors.map(floor => ({ ...floor }));
  floorMemo.delete(file);
  const read = readFormatFloorsUncached(file);
  if (read && before?.isFile() && read.stamp === floorStamp(before)) {
    if (floorMemo.size >= 32) floorMemo.delete(floorMemo.keys().next().value!);
    floorMemo.set(file, { stamp: read.stamp, floors: read.floors.map(floor => ({ ...floor })) });
  }
  return read?.floors;
}
function readFormatFloorsUncached(file: string): { floors: FormatFloor[]; stamp: string } | undefined {
  const unreadable = (why: string) => new FormatFloorError("format_floor_unreadable", `${file}: ${why}; nothing was read or written. Fix or restore the file (it is append-only and written by a person).`);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined; throw unreadable("not a readable regular file"); }
  let text: string, stamp: string;
  try {
    const stat = fstatSync(fd); stamp = floorStamp(fstatSync(fd, { bigint: true }));
    if (!stat.isFile() || stat.size > MAX_BYTES) throw unreadable("not a regular file of at most 64 KiB");
    const data = Buffer.alloc(MAX_BYTES + 1); let size = 0, n: number;
    while (size < data.length && (n = readSync(fd, data, size, data.length - size, null)) > 0) size += n;
    if (size > MAX_BYTES) throw unreadable("not a regular file of at most 64 KiB");
    text = data.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw unreadable("not JSON"); }
  if (!Array.isArray(value) || !value.every(record => record && typeof record === "object" && !Array.isArray(record)
    && typeof record.surface === "string" && typeof record.minReader === "string" && SEMVER.test(record.minReader) && typeof record.since === "string")) throw unreadable("not an array of { surface, minReader, since } records");
  return { floors: value.map(({ surface, minReader, since }) => ({ surface, minReader, since })), stamp };
}

/** Refuse before touching `surface` when the home records a floor above this release. */
export function assertFormatFloor(home: string, surface: FormatSurface): void {
  const floors = readFormatFloors(home);
  if (!floors) return;
  const reader = READER_VERSION ?? "unknown";
  for (const floor of floors) if ((floor.surface === surface || floor.surface === "home") && (READER_VERSION === undefined || formatVersionBelow(READER_VERSION, floor.minReader))) {
    throw new FormatFloorError("format_floor", `amem ${reader} is below the ${surface} format floor ${floor.minReader} (since ${floor.since}) recorded in ${join(home, FORMATS_FILE)}; nothing was read or written. Upgrade amem to ${floor.minReader} or later.`, { ...floor, reader });
  }
}

/** A person opts into a capability only by an applicable floor, never by this code writing one. */
export function formatFloorAtLeast(home: string, surface: FormatSurface, minimum: string): boolean {
  if (!SEMVER.test(minimum)) return false;
  return (readFormatFloors(home) ?? []).some(floor => (floor.surface === surface || floor.surface === "home") && !formatVersionBelow(floor.minReader, minimum));
}

/**
 * The step a person takes to raise a floor: the exact record, the file it goes in, and that this package never writes that file. It is the
 * next step a refusal names, so the writer that refuses keeps the path and the record from one place.
 */
export function floorRaiseHint(home: string, surface: FormatSurface, minReader: string): string {
  return `append {"surface":"${surface}","minReader":"${minReader}","since":"YYYY-MM-DD"} to ${join(home, FORMATS_FILE)} by hand (amem never writes that file)`;
}
