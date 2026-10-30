/** Metadata-only input-set ancestry for the generation reader's cold path. Never loads proof bodies. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { realPath } from "./platform.ts";

export const PUBLIC_PRUNE_INPUT_MAX_BYTES = 65_536;
export const PUBLIC_PRUNE_REPLAY_MAX_BYTES = 256 * 1024 * 1024;
export const PUBLIC_PRUNE_MAX_SETS = 4096;
export interface PublicPruneInputSetV1 {
  schema: "agent-mem.public-prune-input-set/v1"; receivingGeneration: string; previous: string | null; inputs: string[];
}
export class PublicPruneInputError extends Error {
  constructor(readonly code: "unavailable" | "resource" | "binding" = "unavailable") {
    super(`public prune input ${code}`); this.name = "PublicPruneInputError";
  }
}
function guard(ok: unknown, resource = false): asserts ok { if (!ok) throw new PublicPruneInputError(resource ? "resource" : "unavailable"); }
function protectedCall<T>(work: () => T): T {
  try { return work(); } catch (error) { if (error instanceof PublicPruneInputError) throw error; throw new PublicPruneInputError(); }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hex = (v: unknown, n: number): v is string => typeof v === "string" && v.length === n && /^[a-f0-9]+$/.test(v);
export function validatePublicPruneInputSet(v: unknown): PublicPruneInputSetV1 {
  return protectedCall(() => {
    guard(object(v) && Object.keys(v).length === 4 && ["schema", "receivingGeneration", "previous", "inputs"].every(key => Object.hasOwn(v, key)));
    guard(Buffer.byteLength(canonicalJSON(v)) <= PUBLIC_PRUNE_INPUT_MAX_BYTES, true);
    guard(v.schema === "agent-mem.public-prune-input-set/v1" && hex(v.receivingGeneration, 32) && (v.previous === null || hex(v.previous, 64)) && Array.isArray(v.inputs));
    let previous = "";
    for (const id of v.inputs) { guard(hex(id, 64) && id > previous); previous = id; }
    return { schema: v.schema, receivingGeneration: v.receivingGeneration, previous: v.previous, inputs: [...v.inputs] as string[] };
  });
}
function owned(stat: BigIntStats, directory = false): void {
  guard(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n)
    && stat.uid === BigInt(process.getuid?.() ?? -1) && (stat.mode & 0o077n) === 0n);
}
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
/** Complete bounded chain, closed canonical metadata, exact hashes and monotone membership. */
export function readPublicPruneInputSetChain(input: { dir: string; receivingGeneration: string; inputSetHash: string }): { commitments: string[]; inputs: string[] } {
  return protectedCall(() => {
    guard(hex(input.receivingGeneration, 32) && hex(input.inputSetHash, 64));
    const original = lstatSync(input.dir, { bigint: true }); owned(original, true);
    const dir = realPath(input.dir), root = lstatSync(dir, { bigint: true }); owned(root, true); guard(root.dev === original.dev && root.ino === original.ino);
    const folder = join(dir, "public-prune-input-sets"), parent = lstatSync(folder, { bigint: true }); owned(parent, true);
    const frontier = new Map<string, BigIntStats>(), commitments: string[] = [], seen = new Set<string>();
    let id: string | null = input.inputSetHash, later: Set<string> | undefined, inputs: string[] = [], total = 0;
    while (id !== null) {
      guard(!seen.has(id)); guard(seen.size < PUBLIC_PRUNE_MAX_SETS, true); seen.add(id); commitments.push(id);
      const file = join(folder, id + ".json"), before = lstatSync(file, { bigint: true }); owned(before);
      guard(before.size > 0n && before.size <= BigInt(PUBLIC_PRUNE_INPUT_MAX_BYTES), true);
      total += Number(before.size); guard(total <= PUBLIC_PRUNE_REPLAY_MAX_BYTES, true);
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let bytes: Buffer;
      try {
        const opened = fstatSync(fd, { bigint: true }); owned(opened); guard(same(before, opened));
        const data = Buffer.alloc(Number(opened.size) + 1); let count = 0;
        while (count < data.length) { const n = readSync(fd, data, count, data.length - count, count); if (!n) break; count += n; }
        const after = fstatSync(fd, { bigint: true }), named = lstatSync(file, { bigint: true }); owned(after); owned(named);
        guard(count === Number(before.size) && same(before, after) && same(before, named)); bytes = data.subarray(0, count); frontier.set(file, before);
      } finally { closeSync(fd); }
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), raw: unknown = JSON.parse(text), canonical = canonicalJSON(raw);
      guard(text === canonical || text === canonical + "\n");
      const set = validatePublicPruneInputSet(raw); guard(hashJSON(set) === id && set.receivingGeneration === input.receivingGeneration);
      if (later) guard(set.inputs.every(member => later!.has(member))); else inputs = set.inputs;
      later = new Set(set.inputs); id = set.previous;
    }
    for (const [file, before] of frontier) { const now = lstatSync(file, { bigint: true }); owned(now); guard(same(before, now)); }
    for (const [file, before] of [[input.dir, original], [dir, root], [folder, parent]] as const) {
      const now = lstatSync(file, { bigint: true }); owned(now, true); guard(now.dev === before.dev && now.ino === before.ino);
    }
    return { commitments, inputs: [...inputs] };
  });
}
