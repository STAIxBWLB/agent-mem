/** Private local publication authority, never a transport object or a native-row rewrite. */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, fsyncDirectory, type BoundProfile } from "./generation.ts";
import { assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { realPath } from "./platform.ts";
import { validatePruneRow, type PruneRow } from "./prune.ts";
import type { PublicPruneLineage } from "./public-prune-witness.ts";
import { resolveShardProfile } from "./shard.ts";

export interface PublisherBoundaryV1 {
  schema: "agent-mem.prune-publisher-boundary/v1";
  generation: string; sealHash: string; machine: string; end: number; prefixSha256: string;
}
const fail = (): never => { throw new Error("prune publisher boundary unavailable or changed"); };
function guard(value: unknown): asserts value { if (!value) fail(); }
function owned(stat: Stats, directory = false, links = 1): void {
  guard(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === links)
    && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0);
}
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function bytes(file: string, limit: number, links = 1): Buffer {
  const before = lstatSync(file); owned(before, false, links); guard(before.size <= limit);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd); owned(opened, false, links); guard(same(before, opened));
    const value = readFileSync(fd); guard(value.length === before.size && same(opened, fstatSync(fd)) && same(opened, lstatSync(file))); return value;
  } finally { closeSync(fd); }
}
function context(profile: BoundProfile, mutation: MutationHandle): { machine: string; sealHash: string; log: string; file: string; local: string } {
  assertMutationHandle(mutation, profile.dir);
  guard(profile.kind === "generation" && profile.sharded && profile.foreignPruneFormat === "agent-mem.public-prune-witness/v1");
  const current = resolveShardProfile(profile.home, profile.shardUser ? { user: true } : { project: profile.shardKey });
  guard(current.generation === profile.generation && current.foreignPruneFormat === profile.foreignPruneFormat
    && current.selectorRevision === profile.selectorRevision && realPath(current.dir) === realPath(profile.dir));
  for (const dir of [profile.home, profile.dir, join(profile.dir, "local"), join(profile.dir, "log")]) owned(lstatSync(dir), true);
  const rootMachine = JSON.parse(bytes(join(profile.home, "machine.json"), 4096).toString("utf8")) as { id?: unknown };
  const shardMachine = JSON.parse(bytes(join(profile.dir, "machine.json"), 4096).toString("utf8")) as { id?: unknown };
  guard(typeof rootMachine.id === "string" && /^[a-f0-9]{16}$/.test(rootMachine.id) && rootMachine.id === shardMachine.id);
  // resolveShardProfile checks descriptor/sourceDigest; hash the original complete seal bytes too.
  const sealHash = createHash("sha256").update(bytes(join(profile.dir, "generation-seal.json"), 4096)).digest("hex");
  bytes(join(profile.dir, "generation.json"), 4096); bytes(join(profile.dir, "migration-sources.json"), 262144);
  const machine = rootMachine.id, local = join(profile.dir, "local");
  return { machine, sealHash, local, file: join(local, `publisher-boundary-${machine}.json`), log: join(profile.dir, "log", `${machine}.jsonl`) };
}
/** Streaming complete prefix and bounded line scan; no lifetime byte/row omission. */
function inspect(log: string, end?: number, rows?: ReadonlyMap<string, { row: PruneRow; canonical: string }>): { end: number; hash: string; found: Set<string> } {
  const before = lstatSync(log, { throwIfNoEntry: false });
  if (!before) { guard(end === undefined || end === 0); return { end: 0, hash: createHash("sha256").digest("hex"), found: new Set() }; }
  owned(before); const bound = end ?? before.size; guard(Number.isSafeInteger(bound) && bound >= 0 && bound <= before.size);
  const fd = openSync(log, constants.O_RDONLY | constants.O_NOFOLLOW), digest = createHash("sha256"), chunk = Buffer.alloc(65536);
  let position = 0, lineStart = 0, line: number[] = [], last = -1, boundaryNewline = bound === 0;
  const found = new Set<string>(), older = new Set<string>();
  try {
    guard(same(before, fstatSync(fd)));
    while (position < before.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - position), position); guard(count > 0);
      if (position < bound) digest.update(chunk.subarray(0, Math.min(count, bound - position)));
      for (let i = 0; i < count; i++) {
        const byte = chunk[i]!; last = byte;
        if (position + i + 1 === bound) boundaryNewline = byte === 10;
        if (rows) {
          if (byte === 10) {
            guard(line.length > 0);
            const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(line)));
            const id = value && typeof value === "object" && "id" in value && typeof value.id === "string" ? value.id : undefined;
            const candidate = id === undefined ? undefined : rows.get(id);
            const canonical = lineStart >= bound ? canonicalJSON(value) : undefined;
            if (candidate) {
              if (lineStart < bound) older.add(candidate.row.id);
              else if (canonical === candidate.canonical) { validatePruneRow(value, candidate.row.generation, "synced"); found.add(candidate.row.id); }
            }
            line = []; lineStart = position + i + 1;
          } else { line.push(byte); guard(line.length <= 1024 * 1024); }
        }
      }
      position += count;
      if (!rows && position === before.size) break;
    }
    guard(boundaryNewline && (before.size === 0 || last === 10) && same(before, fstatSync(fd)) && same(before, lstatSync(log)));
    for (const id of older) found.delete(id);
    return { end: bound, hash: digest.digest("hex"), found };
  } finally { closeSync(fd); }
}
function decode(value: Buffer): PublisherBoundaryV1 {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(value), v = JSON.parse(text) as PublisherBoundaryV1;
  guard(v && Object.keys(v).sort().join(",") === "end,generation,machine,prefixSha256,schema,sealHash"
    && v.schema === "agent-mem.prune-publisher-boundary/v1" && /^[a-f0-9]{32}$/.test(v.generation)
    && /^[a-f0-9]{16}$/.test(v.machine) && /^[a-f0-9]{64}$/.test(v.sealHash) && /^[a-f0-9]{64}$/.test(v.prefixSha256)
    && Number.isSafeInteger(v.end) && v.end >= 0 && text === canonicalJSON(v) + "\n"); return v;
}
/** Recover only an exact private temp/final inode pair while holding the real kernel fence. */
function recover(file: string, local: string): void {
  const final = lstatSync(file, { throwIfNoEntry: false }); if (!final || final.nlink === 1) return;
  owned(final, false, 2); decode(bytes(file, 4096, 2));
  const candidates = readdirSync(local).filter(name => /^\.publisher-boundary-[a-f0-9]{32}\.tmp$/.test(name))
    .map(name => join(local, name)).filter(name => { const stat = lstatSync(name); return stat.dev === final.dev && stat.ino === final.ino; });
  guard(candidates.length === 1); const temp = candidates[0]!; owned(lstatSync(temp), false, 2);
  guard(same(final, lstatSync(file)) && same(final, lstatSync(temp))); unlinkSync(temp); fsyncDirectory(local);
}
export function assertPublisherBoundary(profile: BoundProfile, mutation: MutationHandle): PublisherBoundaryV1 {
  const ctx = context(profile, mutation); recover(ctx.file, ctx.local);
  const value = decode(bytes(ctx.file, 4096));
  guard(value.generation === profile.generation && value.machine === ctx.machine && value.sealHash === ctx.sealHash);
  guard(inspect(ctx.log, value.end).hash === value.prefixSha256); assertMutationHandle(mutation, profile.dir); return value;
}
/** Explicit sync-only admission: existing complete own log is a conservative migration upper bound. */
export function ensurePublisherBoundary(profile: BoundProfile, mutation: MutationHandle): PublisherBoundaryV1 {
  const ctx = context(profile, mutation); recover(ctx.file, ctx.local);
  if (lstatSync(ctx.file, { throwIfNoEntry: false })) return assertPublisherBoundary(profile, mutation);
  const prefix = inspect(ctx.log), value: PublisherBoundaryV1 = { schema: "agent-mem.prune-publisher-boundary/v1", generation: profile.generation!,
    sealHash: ctx.sealHash, machine: ctx.machine, end: prefix.end, prefixSha256: prefix.hash };
  const temp = join(ctx.local, `.publisher-boundary-${randomBytes(16).toString("hex")}.tmp`), fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, canonicalJSON(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  // A crash leaves either a harmless unregistered temp or an exact recoverable pair.
  linkSync(temp, ctx.file); fsyncDirectory(ctx.local); unlinkSync(temp); fsyncDirectory(ctx.local);
  return assertPublisherBoundary(profile, mutation);
}
/** Verify one candidate set with one complete JSONL parse, independent of the candidate count. */
export function publisherPruneLineages(profile: BoundProfile, mutation: MutationHandle, rows: readonly PruneRow[]): Map<string, PublicPruneLineage> {
  const boundary = assertPublisherBoundary(profile, mutation), candidates = new Map<string, { row: PruneRow; canonical: string }>();
  for (const row of rows) {
    if (row.machine !== boundary.machine || row.generation !== boundary.generation || row.placement !== "synced") continue;
    validatePruneRow(row, boundary.generation, "synced");
    const canonical = canonicalJSON(row), previous = candidates.get(row.id);
    guard(!previous || previous.canonical === canonical); candidates.set(row.id, { row, canonical });
  }
  const result = new Map<string, PublicPruneLineage>();
  if (!candidates.size) return result;
  const ctx = context(profile, mutation), proof = inspect(ctx.log, boundary.end, candidates);
  guard(proof.hash === boundary.prefixSha256); assertPublisherBoundary(profile, mutation);
  for (const id of proof.found) result.set(id, { kind: "post-seal", seal: boundary.sealHash, end: boundary.end });
  return result;
}
/** Compatibility entry point; batch callers avoid rescanning once per original. */
export function publisherPruneLineage(profile: BoundProfile, mutation: MutationHandle, row: PruneRow): PublicPruneLineage | undefined {
  return publisherPruneLineages(profile, mutation, [row]).get(row.id);
}
