import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Shared bounded transport for prebuilt brief sections; never a database or a refresh on read. */
export const BRIEF_CACHE_BYTES = 32 * 1024;
export interface BriefCacheBinding { directory: string; project: string; section: "capture" | "curated" }
export interface BriefCacheRow { source: unknown; data: unknown; partial: boolean }
export interface BriefCache {
  schema: "agent-mem.brief-cache/v1"; project: string; section: BriefCacheBinding["section"];
  builtThrough: number; partial: boolean; rows: BriefCacheRow[];
}
export function briefCacheFile(binding: BriefCacheBinding): string { return join(binding.directory, `brief-${binding.section}.json`); }

export function readBriefCache(binding: BriefCacheBinding): BriefCache | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(briefCacheFile(binding), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size < 1 || stat.size > BRIEF_CACHE_BYTES || (stat.mode & 0o077) !== 0) return;
    const bytes = Buffer.alloc(BRIEF_CACHE_BYTES + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0); // one bounded read, including an oversize sentinel
    const after = fstatSync(fd);
    if (size !== stat.size || size > BRIEF_CACHE_BYTES || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) return;
    const cache = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))) as BriefCache;
    if (cache.schema !== "agent-mem.brief-cache/v1" || cache.project !== binding.project || cache.section !== binding.section
      || !Number.isSafeInteger(cache.builtThrough) || cache.builtThrough < 1 || typeof cache.partial !== "boolean"
      || !Array.isArray(cache.rows) || cache.rows.length > 8
      || cache.rows.some(row => !row || typeof row.partial !== "boolean" || row.source === undefined || row.data === undefined)) return;
    return cache;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Invalidate under the source store's write transaction, before a summary can commit. */
export function invalidateBriefCache(binding: BriefCacheBinding): void { rmSync(briefCacheFile(binding), { force: true }); }

/** Atomic private replacement; callers serialize publication with their source-store writers. Refuse a replacement when a newer committed-row watermark is already visible. */
export function writeBriefCache(binding: BriefCacheBinding, cache: BriefCache): void {
  const text = JSON.stringify(cache) + "\n";
  if (Buffer.byteLength(text) > BRIEF_CACHE_BYTES) throw new Error("brief cache byte bound");
  const file = briefCacheFile(binding), temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    const prior = readBriefCache(binding);
    if (prior && prior.builtThrough > cache.builtThrough) return;
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
