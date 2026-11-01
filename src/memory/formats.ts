import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
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
const MAX_BYTES = 64 * 1024, SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export class FormatFloorError extends Error {
  constructor(readonly code: "format_floor" | "format_floor_unreadable", message: string, readonly floor?: FormatFloor & { reader: string }) { super(message); this.name = "FormatFloorError"; }
}
let ownVersion: string | undefined;
/** This package's version, read only when a floor file exists. */
const readerVersion = () => ownVersion ??= (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const parts = (version: string) => SEMVER.exec(version)!.slice(1, 4).map(Number);
function below(reader: string, floor: string): boolean {
  const a = parts(reader), b = parts(floor);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** Bounded read of the floor records: undefined when there is no file; anything that is not a regular file of valid records refuses. */
export function readFormatFloors(home: string): FormatFloor[] | undefined {
  const file = join(home, FORMATS_FILE), unreadable = (why: string) => new FormatFloorError("format_floor_unreadable", `${file}: ${why}; nothing was read or written. Fix or restore the file (it is append-only and written by a person).`);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined; throw unreadable("not a readable regular file"); }
  let text: string;
  try {
    const stat = fstatSync(fd);
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
  return value.map(({ surface, minReader, since }) => ({ surface, minReader, since }));
}

/** Refuse before touching `surface` when the home records a floor above this release. */
export function assertFormatFloor(home: string, surface: FormatSurface): void {
  const floors = readFormatFloors(home);
  if (!floors) return;
  const reader = readerVersion();
  for (const floor of floors) if ((floor.surface === surface || floor.surface === "home") && below(reader, floor.minReader)) {
    throw new FormatFloorError("format_floor", `amem ${reader} is below the ${surface} format floor ${floor.minReader} (since ${floor.since}) recorded in ${join(home, FORMATS_FILE)}; nothing was read or written. Upgrade amem to ${floor.minReader} or later.`, { ...floor, reader });
  }
}
