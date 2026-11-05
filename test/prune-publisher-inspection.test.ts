import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as mutation from "../src/memory/mutation.ts";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJSON, generationDescriptor, hashJSON } from "../src/memory/generation.ts";
import { ensurePublisherBoundary, inspectPublisherPruneLineages, publisherPruneLineages } from "../src/memory/prune-publisher-lineage.ts";
import { pruneId, type PruneRow } from "../src/memory/prune.ts";
import { resolveShardProfile } from "../src/memory/shard.ts";
import { publicPruneGraph } from "./fixtures/public-prune-graph.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const done of cleanup.splice(0).reverse()) done(); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amem-publisher-inspection-")); chmodSync(home, 0o700); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const generation = "a".repeat(32), machine = "b".repeat(16), dir = join(home, "user");
  const write = (file: string, value: unknown) => writeFileSync(file, canonicalJSON(value) + "\n", { mode: 0o600 });
  for (const folder of [dir, join(dir, "log"), join(dir, "local"), join(home, "public-prune-input-sets")]) mkdirSync(folder, { mode: 0o700 });
  const view = { schema: "agent-mem.public-prune-view/v1", receivingGeneration: generation, realms: {} }, viewHash = hashJSON(view);
  write(join(home, "public-prune-input-sets", viewHash + ".json"), view);
  const selector = { schema: "agent-mem.profile/v2", kind: "generation", generation, foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: viewHash };
  write(join(home, "profile.json"), selector); write(join(home, "shards.json"), { schema: "agent-mem.shards/v2", generation, phase: "active", selectorRevision: hashJSON(selector) });
  for (const base of [home, dir]) write(join(base, "machine.json"), { id: machine, label: "inspection fixture" });
  write(join(dir, "generation.json"), generationDescriptor(generation)); write(join(dir, "migration-sources.json"), { schema: "agent-mem.migration-sources/v1", sources: [] });
  write(join(dir, "generation-seal.json"), { schema: "agent-mem.generation-seal/v1", generation, descriptorHash: hashJSON(generationDescriptor(generation)), sourceDigest: hashJSON({ sources: [] }) });
  const profile = resolveShardProfile(home, { user: true }), handle = mutation.acquireMutation(dir); if (!handle) throw Error("fixture publisher lock unavailable"); cleanup.push(handle);
  const log = join(dir, "log", machine + ".jsonl"), boundary = join(dir, "local", `publisher-boundary-${machine}.json`);
  const row = (at = "2026-10-31T00:00:00.000Z"): PruneRow => { const { id: _id, ...body } = { ...publicPruneGraph().manifest.prune, generation, machine, at }; return { ...body, id: pruneId(body) }; };
  const append = (value: unknown) => appendFileSync(log, canonicalJSON(value) + "\n", { mode: 0o600 });
  return { home, dir, profile, handle, log, boundary, row, append };
}
function tree(root: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const visit = (file: string) => {
    const stat = lstatSync(file, { bigint: true });
    result[file.slice(root.length)] = [String(stat.dev), String(stat.ino), String(stat.mode), String(stat.nlink), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs),
      stat.isFile() ? createHash("sha256").update(readFileSync(file)).digest("hex") : null];
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name));
  };
  visit(root); return result;
}

test("read-only inspection proves exact post-boundary originals without any writer fence or byte/mtime change", () => {
  const f = fixture(), old = f.row(), fresh = f.row("2026-10-31T01:00:00.000Z"), missing = f.row("2026-10-31T02:00:00.000Z");
  f.append(old); const boundary = ensurePublisherBoundary(f.profile, f.handle); f.append(fresh); f.append(fresh); f.append(old);
  const expected = publisherPruneLineages(f.profile, f.handle, [old, fresh, missing]); f.handle();
  const before = tree(f.home), acquire = spyOn(mutation, "acquireMutation").mockImplementation(() => { throw Error("inspection must not acquire a mutation fence"); });
  try {
    expect(inspectPublisherPruneLineages(f.profile, [old, fresh, missing])).toEqual(expected);
    expect(expected).toEqual(new Map([[fresh.id, { kind: "post-seal", seal: boundary.sealHash, end: boundary.end }]]));
    expect(acquire).not.toHaveBeenCalled(); expect(tree(f.home)).toEqual(before);
  } finally { acquire.mockRestore(); }
});

test("missing publisher boundary refuses read-only without creating any file", () => {
  const f = fixture(), row = f.row(); f.append(row); f.handle(); const before = tree(f.home);
  expect(() => inspectPublisherPruneLineages(f.profile, [row])).toThrow("prune publisher boundary unavailable or changed");
  expect(existsSync(f.boundary)).toBe(false); expect(tree(f.home)).toEqual(before);
});

test("pending hardlink temp/final pair is retained and never recovered by inspection", () => {
  const f = fixture(); ensurePublisherBoundary(f.profile, f.handle); const row = f.row(); f.append(row);
  const temp = join(f.dir, "local", `.publisher-boundary-${"d".repeat(32)}.tmp`); linkSync(f.boundary, temp); f.handle(); const before = tree(f.home);
  expect(() => inspectPublisherPruneLineages(f.profile, [row])).toThrow("prune publisher boundary unavailable or changed");
  expect(existsSync(temp)).toBe(true); expect(lstatSync(temp).nlink).toBe(2); expect(lstatSync(f.boundary).nlink).toBe(2); expect(tree(f.home)).toEqual(before);
});

test("oversized own log is rejected by stat before the first own-log open/read", () => {
  const f = fixture(); ensurePublisherBoundary(f.profile, f.handle); const row = f.row(); f.append(row); f.handle();
  truncateSync(f.log, 8 * 1024 * 1024 + 1);
  const open = fs.openSync, read = fs.readSync, descriptors = new Set<number>(); let opens = 0, reads = 0;
  const openSpy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof open>) => {
    const fd = Reflect.apply(open, fs, args); if (args[0] === f.log) { opens++; descriptors.add(fd); } return fd;
  }) as typeof open);
  const readSpy = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof read>) => { if (descriptors.has(args[0])) reads++; return Reflect.apply(read, fs, args); }) as typeof read);
  try { expect(() => inspectPublisherPruneLineages(f.profile, [row])).toThrow(); expect(opens).toBe(0); expect(reads).toBe(0); }
  finally { readSpy.mockRestore(); openSpy.mockRestore(); }
});

test("physical source line bound is checked before JSON parsing or candidate collection", () => {
  const f = fixture(); ensurePublisherBoundary(f.profile, f.handle); const row = f.row(); writeFileSync(f.log, "{}\n".repeat(20001), { mode: 0o600 }); f.handle();
  const parse = JSON.parse; let ownParses = 0;
  const parsing = spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => { if (text === "{}") ownParses++; return parse(text, reviver); });
  try { expect(() => inspectPublisherPruneLineages(f.profile, [row])).toThrow(); expect(ownParses).toBe(0); }
  finally { parsing.mockRestore(); }
});

test("candidate duplicates consume the same 20000-row and 8MiB inspection budgets", () => {
  const f = fixture(); ensurePublisherBoundary(f.profile, f.handle); const row = f.row(); f.append(row); f.handle();
  expect(() => inspectPublisherPruneLineages(f.profile, Array(20001).fill(row))).toThrow();
  const count = Math.floor(8 * 1024 * 1024 / Buffer.byteLength(canonicalJSON(row) + "\n")) + 1; expect(count).toBeLessThanOrEqual(20000);
  expect(() => inspectPublisherPruneLineages(f.profile, Array(count).fill(row))).toThrow();
});
