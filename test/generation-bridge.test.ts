import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readLegacySnapshot, legacyEntries, legacyHead, captureLegacyMain, SegmentReader, type LegacyCheckpoint } from "../src/memory/bridge.ts";
import { entryId, type Entry } from "../src/memory/store.ts";
import { memoryGitSync } from "../src/memory/platform.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const own = "1111111111111111", other = "2222222222222222", generation = "a".repeat(32);
function temp(): string { const root = mkdtempSync(join(tmpdir(), "amem-generation-bridge-")); roots.push(root); return root; }
function fixture(): string {
  const root = temp();
  for (const path of ["log", "local"]) mkdirSync(join(root, path));
  writeFileSync(join(root, "machine.json"), JSON.stringify({ id: own, label: "fixture" }) + "\n");
  // Invalid SQLite bytes prove the bridge never consults or initializes a legacy derived index.
  writeFileSync(join(root, "index.db"), "not an index, must remain unopened");
  return root;
}
function note(text = "legacy contract", local = false): Entry {
  const body = { schema: "agent-hub.memory/v1" as const, op: "note" as const, at: "2026-10-16T00:00:00.000Z", machine: own, project: "agent-hub", scope: "project" as const, tier: local ? "short" as const : "long" as const, kind: "contract" as const, peer: "person", source: "person" as const, text, about: ["path:src/public.ts"], ...(local ? { expires: "2020-01-01T00:00:00.000Z" } : {}) };
  return { ...body, id: entryId(body) };
}
const line = (row: Entry) => JSON.stringify(row) + "\n";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const receipt = (rows: ReturnType<typeof readLegacySnapshot>): LegacyCheckpoint[] => rows.map(({ source, path, offset, hash, commit, tailBytes, stamp }) => ({ source, path, offset, hash, tailBytes, ...(stamp ? { stamp } : {}), ...(commit ? { commit } : {}) }));
function treeBytes(root: string, path = ""): Record<string, string> {
  return Object.fromEntries(readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const relative = path ? `${path}/${entry.name}` : entry.name;
    return entry.isDirectory() ? Object.entries(treeBytes(root, relative)) : [[relative, readFileSync(join(root, relative)).toString("base64")]];
  }));
}
function git(dir: string, ...args: string[]): string {
  const result = memoryGitSync(["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
  return result.stdout.trim();
}
function cache(root: string, empty = false) {
  const remote = temp(), dir = join(root, "generations", generation, "bridge.git");
  git(remote, "init", "-b", "main");
  mkdirSync(join(remote, "log")); mkdirSync(join(remote, "local"));
  const row = note("cached legacy contract");
  if (!empty) {
    writeFileSync(join(remote, "log", `${other}.jsonl`), line(row));
    writeFileSync(join(remote, "local", `${other}.jsonl`), line(note("remote local must be excluded", true)));
  }
  git(remote, "add", "."); git(remote, "commit", ...(empty ? ["--allow-empty"] : []), "-m", "fixture legacy main");
  mkdirSync(join(root, "generations", generation), { recursive: true });
  git(root, "init", "--bare", dir);
  git(dir, "fetch", remote, "+refs/heads/main:refs/remotes/legacy/main");
  const commit = git(remote, "rev-parse", "HEAD");
  captureLegacyMain(root, generation, commit);
  return { remote, dir, row, commit };
}

test("bridge reads raw root segments and only this machine's local rows without any legacy writes", () => {
  const root = fixture(), shared = note(), local = note("expired local row stays authoritative", true);
  writeFileSync(join(root, "log", `${other}.jsonl`), line(shared));
  writeFileSync(join(root, "local", `${own}.jsonl`), line(local));
  writeFileSync(join(root, "local", `${other}.jsonl`), "unreadable foreign local bytes\n");
  const before = treeBytes(root), snapshot = readLegacySnapshot(root);
  expect(snapshot.map(row => [row.source, row.path, row.local])).toEqual([["legacy-local", `log/${other}.jsonl`, false], ["legacy-local", `local/${own}.jsonl`, true]]);
  expect(legacyEntries(snapshot)).toEqual([shared, local]);
  expect(snapshot.every(row => row.offset === row.bytes.length && row.hash === hash(row.bytes))).toBe(true);
  expect(treeBytes(root)).toEqual(before);
});

test("bridge ignores partial UTF-8 tails and captured limits exclude later suffixes and new segments", () => {
  const root = fixture(), first = note(), second = note("한글 tail"), path = join(root, "log", `${own}.jsonl`);
  const next = Buffer.from(line(second)), unicode = next.indexOf(Buffer.from("한"));
  expect(unicode).toBeGreaterThan(0);
  writeFileSync(path, Buffer.concat([Buffer.from(line(first)), next.subarray(0, unicode + 1)]));
  const captured = readLegacySnapshot(root), checkpoints = receipt(captured);
  expect(legacyEntries(captured)).toEqual([first]);
  expect(captured[0]?.tailBytes).toBe(unicode + 1);
  appendFileSync(path, next.subarray(unicode + 1));
  writeFileSync(join(root, "log", `${other}.jsonl`), line(note("new segment after capture")));
  expect(legacyEntries(readLegacySnapshot(root, { checkpoints }))).toHaveLength(3);
  expect(readLegacySnapshot(root, { limits: checkpoints })).toEqual(captured);
  expect(readLegacySnapshot(root, { checkpoints, limits: checkpoints })).toEqual(captured);
});

test("bridge checkpoint rewrite, truncation and disappeared segment errors never reset or fall back", () => {
  for (const change of ["rewrite", "truncate", "disappear"] as const) {
    const root = fixture(), path = join(root, "log", `${own}.jsonl`);
    writeFileSync(path, line(note()));
    const checkpoints = receipt(readLegacySnapshot(root));
    if (change === "rewrite") writeFileSync(path, line(note("rewritten legacy authority")));
    if (change === "truncate") writeFileSync(path, "");
    if (change === "disappear") rmSync(path);
    const before = treeBytes(root);
    expect(() => readLegacySnapshot(root, { checkpoints })).toThrow("person inspection required");
    expect(() => readLegacySnapshot(root, { limits: checkpoints })).toThrow("person inspection required");
    expect(treeBytes(root)).toEqual(before);
  }
});

test("bridge validates schema and full content IDs and deduplicates canonically equal original identities", () => {
  const root = fixture(), row = note(), reordered = Object.fromEntries(Object.entries(row).reverse());
  writeFileSync(join(root, "log", `${own}.jsonl`), line(row));
  writeFileSync(join(root, "log", `${other}.jsonl`), JSON.stringify(reordered) + "\n");
  expect(legacyEntries(readLegacySnapshot(root))).toEqual([row]);
  for (const bad of [{ ...row, text: "changed under existing ID" }, { ...row, schema: "future-schema" }, { ...row, op: "prune" }, { ...row, about: "not an array" }]) {
    writeFileSync(join(root, "log", `${other}.jsonl`), JSON.stringify(bad) + "\n");
    let skipped = 0;
    expect(legacyEntries(readLegacySnapshot(root, { onMalformed: () => skipped++ }))).toEqual([row]);
    expect(skipped).toBe(1);
  }
});

test("bridge uses only pinned cached legacy main blobs, ignores remote locals and never fetches during reads", () => {
  const root = fixture(), cached = cache(root);
  const before = treeBytes(root);
  const snapshot = readLegacySnapshot(root, { generation });
  expect(legacyHead(root, generation)).toBe(cached.commit);
  expect(legacyEntries(snapshot)).toEqual([cached.row]);
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0]).toMatchObject({ source: "legacy-main", path: `log/${other}.jsonl`, commit: cached.commit, local: false });
  expect(treeBytes(root)).toEqual(before);
  // Advancing the source repository is deliberately not visible until an explicit fetch.
  const late = note("late offline legacy write");
  appendFileSync(join(cached.remote, "log", `${other}.jsonl`), line(late));
  git(cached.remote, "add", "."); git(cached.remote, "commit", "-m", "fixture later legacy write");
  expect(readLegacySnapshot(root, { generation })).toEqual(snapshot);
  git(cached.dir, "fetch", cached.remote, "+refs/heads/main:refs/remotes/legacy/main");
  expect(readLegacySnapshot(root, { generation, commit: cached.commit })).toEqual(snapshot);
  captureLegacyMain(root, generation, git(cached.remote, "rev-parse", "HEAD"), cached.commit);
  expect(legacyEntries(readLegacySnapshot(root, { generation, checkpoints: receipt(snapshot) }))).toEqual([cached.row, late]);
});

test("bridge rejects cached non-fast-forward legacy histories even with unchanged segment bytes", () => {
  const root = fixture(), cached = cache(root), checkpoints = receipt(readLegacySnapshot(root, { generation }));
  git(cached.remote, "checkout", "--orphan", "rewritten");
  git(cached.remote, "add", "."); git(cached.remote, "commit", "-m", "fixture rewritten ancestry");
  git(cached.dir, "fetch", cached.remote, "+refs/heads/rewritten:refs/remotes/legacy/main");
  expect(() => captureLegacyMain(root, generation, git(cached.remote, "rev-parse", "HEAD"), cached.commit)).toThrow("person inspection required");
  expect(legacyHead(root, generation)).toBe(cached.commit);
  expect(readLegacySnapshot(root, { generation, checkpoints })).toBeDefined();
});

test("bridge rejects source file, source directory and generation cache symlinks", () => {
  const outside = temp(); writeFileSync(join(outside, "source.jsonl"), line(note()));
  for (const target of ["file", "log", "local", "cache"] as const) {
    const root = fixture();
    if (target === "file") symlinkSync(join(outside, "source.jsonl"), join(root, "log", `${own}.jsonl`));
    else if (target === "cache") {
      mkdirSync(join(root, "generations", generation), { recursive: true });
      symlinkSync(outside, join(root, "generations", generation, "bridge.git"), "dir");
    } else { rmSync(join(root, target), { recursive: true }); symlinkSync(outside, join(root, target), "dir"); }
    if (target === "cache") expect(() => captureLegacyMain(root, generation, "a".repeat(40))).toThrow();
    else expect(() => readLegacySnapshot(root)).toThrow();
  }
});


test("bridge skips and counts malformed legacy rows consistently while strict generation validation remains available", () => {
  const root = fixture(), row = note(), path = join(root, "log", `${own}.jsonl`);
  writeFileSync(path, line(row) + "malformed JSON\n" + JSON.stringify({ schema: "agent-hub.memory/v1" }) + "\n");
  expect(legacyEntries(readLegacySnapshot(root))).toEqual([row]);
  let skipped = 0;
  const before = treeBytes(root), snapshot = readLegacySnapshot(root, { onMalformed: () => skipped++ });
  expect(skipped).toBe(2);
  let decodedSkipped = 0;
  expect(legacyEntries(snapshot, { onMalformed: () => decodedSkipped++ })).toEqual([row]);
  expect(decodedSkipped).toBe(2);
  expect(treeBytes(root)).toEqual(before);
  for (const bad of [{ ...row, text: "different content under original ID" }, { ...row, op: "future_operation" }, { ...row, op: "prune" }]) {
    writeFileSync(path, JSON.stringify(bad) + "\n");
    const invalid = readLegacySnapshot(root, { onMalformed: () => skipped++ });
    expect(legacyEntries(invalid)).toEqual([]);
    expect(() => legacyEntries(invalid, { strict: true })).toThrow("person inspection required");
  }
});

test("bridge previousCommit detects rewritten cached history even when the prior tree contained no segments", () => {
  const root = fixture(), cached = cache(root, true);
  const previousCommit = cached.commit;
  expect(readLegacySnapshot(root, { generation })).toEqual([]);
  git(cached.remote, "checkout", "--orphan", "different-empty-root");
  git(cached.remote, "commit", "--allow-empty", "-m", "fixture unrelated empty history");
  git(cached.dir, "fetch", cached.remote, "+refs/heads/different-empty-root:refs/remotes/legacy/main");
  expect(() => captureLegacyMain(root, generation, git(cached.remote, "rev-parse", "HEAD"), previousCommit)).toThrow("person inspection required");
  expect(legacyHead(root, generation)).toBe(previousCommit);
});


test("bridge cache reads ignore inherited common-dir object-dir and namespace routing", () => {
  const root = fixture(), cached = cache(root), outside = temp();
  const expected = readLegacySnapshot(root, { generation }), head = legacyHead(root, generation), before = treeBytes(root);
  const overrides = { GIT_COMMON_DIR: outside, GIT_OBJECT_DIRECTORY: outside, GIT_NAMESPACE: "synthetic-unrelated-namespace" };
  const previous = Object.fromEntries(Object.keys(overrides).map(name => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(overrides)) {
      process.env[name] = value;
      expect(legacyHead(root, generation)).toBe(head);
      expect(readLegacySnapshot(root, { generation, commit: cached.commit })).toEqual(expected);
    }
  } finally { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  expect(treeBytes(root)).toEqual(before);
});


test("explicit cache capture rejects a rewritten prefix even when legacy main fast-forwards and grows", () => {
  const root = fixture(), cached = cache(root), prior = legacyHead(root, generation);
  writeFileSync(join(cached.remote, "log", `${other}.jsonl`), line(note("rewritten prefix")) + line(note("new suffix")));
  git(cached.remote, "add", "."); git(cached.remote, "commit", "-m", "fixture rewrite plus append");
  git(cached.dir, "fetch", cached.remote, "+refs/heads/main:refs/remotes/legacy/main");
  expect(() => captureLegacyMain(root, generation, git(cached.remote, "rev-parse", "HEAD"), cached.commit)).toThrow("person inspection required");
  expect(legacyHead(root, generation)).toBe(prior);
});


test("explicit cache capture resumes past interrupted private temp files without replacing mismatched immutable finals", () => {
  const root = fixture(), cached = cache(root);
  appendFileSync(join(cached.remote, "log", `${other}.jsonl`), line(note("captured after interrupted temp")));
  git(cached.remote, "add", "."); git(cached.remote, "commit", "-m", "fixture capture retry");
  git(cached.dir, "fetch", cached.remote, "+refs/heads/main:refs/remotes/legacy/main");
  const next = git(cached.remote, "rev-parse", "HEAD"), dir = join(root, "generations", generation, "bridge-snapshots", next, "log");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const orphan = join(dir, `.${other}.jsonl.interrupted.tmp`); writeFileSync(orphan, "partial private temporary data", { mode: 0o600 });
  expect(legacyHead(root, generation)).toBe(cached.commit);
  captureLegacyMain(root, generation, next, cached.commit);
  expect(legacyHead(root, generation)).toBe(next);
  expect(readFileSync(join(dir, `${other}.jsonl`), "utf8")).toBe(readFileSync(join(cached.remote, "log", `${other}.jsonl`), "utf8"));
  expect(readFileSync(orphan, "utf8")).toBe("partial private temporary data");
  captureLegacyMain(root, generation, next, next); // Matching immutable files cross the durability fence on retry.
  expect(legacyHead(root, generation)).toBe(next);
  writeFileSync(join(dir, `${other}.jsonl`), "mismatched final bytes");
  expect(() => captureLegacyMain(root, generation, next, next)).toThrow("person inspection required");
});


test("ordinary immutable archive reads retain no historical corpus in the live-prefix heap cache", () => {
  const root = fixture(), cached = cache(root), reader = new SegmentReader();
  let checkpoints: LegacyCheckpoint[] = [];
  for (let phase = 0; phase < 3; phase++) {
    const snapshot = readLegacySnapshot(root, { generation, reader, incremental: true, checkpoints });
    checkpoints = receipt(snapshot);
    expect((reader as unknown as { prefixes: Map<string, unknown> }).prefixes.size).toBe(0);
    if (phase < 2) {
      const previous = legacyHead(root, generation)!;
      appendFileSync(join(cached.remote, "log", `${other}.jsonl`), line(note(`later archived row ${phase}`)));
      git(cached.remote, "add", "."); git(cached.remote, "commit", "-m", `fixture archive ${phase}`);
      git(cached.dir, "fetch", cached.remote, "+refs/heads/main:refs/remotes/legacy/main");
      captureLegacyMain(root, generation, git(cached.remote, "rev-parse", "HEAD"), previous);
    }
  }
});


test("ordinary archived blob reads reject a symlinked log parent even when outside bytes match the captured hash", () => {
  const root = fixture(), cached = cache(root), outside = temp();
  const log = join(root, "generations", generation, "bridge-snapshots", cached.commit, "log");
  writeFileSync(join(outside, `${other}.jsonl`), line(cached.row));
  renameSync(log, `${log}-retained`);
  symlinkSync(outside, log, "dir");
  expect(() => readLegacySnapshot(root, { generation })).toThrow("person inspection required");
});
