import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { snapshotRevision } from "../src/ui/snapshot-revision.ts";

const roots: string[] = [], project = "a".repeat(16), machine = "b".repeat(16), generation = "c".repeat(32), now = 1_800_000_000_000;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() { const base = mkdtempSync(join(tmpdir(), "amem-snapshot-revision-")); roots.push(base); return base; }
function put(base: string, name: string, text = "source\n") {
  const file = join(base, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file;
}
const revision = (base: string) => snapshotRevision(base, now);

test("a physical-home alias shares its revision while links below that home still refuse", () => {
  const base = home(), parent = home(), alias = join(parent, "memory-link");
  put(base, "log/peer.jsonl"); symlinkSync(base, alias);
  expect(revision(alias)).toBe(revision(base));
  symlinkSync(join(base, "log/peer.jsonl"), join(base, "aliases.jsonl"));
  expect(() => revision(alias)).toThrow("plain file or directory");
  expect(() => revision(base)).toThrow("plain file or directory");
});

test("authoritative append, same-size rewrite with restored mtime, replacement and permission changes invalidate", () => {
  const base = home(), file = put(base, "log/segment.jsonl", "first\n");
  let before = revision(base); expect(revision(base)).toBe(before);
  appendFileSync(file, "tail\n"); expect(revision(base)).not.toBe(before);
  before = revision(base); const stamp = statSync(file);
  writeFileSync(file, "other\ntail\n"); utimesSync(file, stamp.atime, stamp.mtime);
  expect(revision(base)).not.toBe(before);
  before = revision(base); put(base, "replacement", "other\ntail\n"); renameSync(join(base, "replacement"), file);
  expect(revision(base)).not.toBe(before);
  before = revision(base); chmodSync(file, 0o600); expect(revision(base)).not.toBe(before);
});

test("external configs, lifecycle, aliases, new projects, work and every generation/prune binding are observed", () => {
  const base = home();
  for (const name of ["amem.config.json", "capture-config.json", "formats.json", "profile.json", "shards.json", "aliases.jsonl", "lifecycle.jsonl", "machine.json", "metrics.jsonl", "profile.lock", "public-prune-view.intent.json",
    `projects/${project}/project.json`, `projects/${project}/work/log/peer.jsonl`, `projects/${project}/machine/${machine}/config.json`,
    `projects/${project}/legacy/log/peer.jsonl`, "user/local/peer.jsonl", `generations/${generation}/generation-seal.json`,
    `generations/${generation}/bridge-snapshot.json`, `generations/${generation}/bridge-snapshots/${"d".repeat(40)}/log/peer.jsonl`,
    `public-prune-input-sets/${"e".repeat(64)}.json`, `projects/${project}/public-prune-objects/${"f".repeat(64)}`,
    "sync-placement/active.json", `sync-placement/epochs/${"e".repeat(64)}/records-00001.jsonl`]) {
    const before = revision(base); put(base, name, name === "amem.config.json" ? '{"denyPaths":["private"]}' : "source\n");
    expect(revision(base), name).not.toBe(before);
  }
  const before = revision(base); rmSync(join(base, `projects/${project}/work/log/peer.jsonl`)); expect(revision(base)).not.toBe(before);
});

test("capture WAL commits and checkpoints change the revision without opening a read-write store in the probe", () => {
  const base = home(), file = put(base, `projects/${project}/machine/${machine}/capture.db`, "");
  const db = new Database(file);
  try {
    db.run("PRAGMA journal_mode=WAL"); db.run("PRAGMA wal_autocheckpoint=0"); db.run("CREATE TABLE rows (id INTEGER PRIMARY KEY, text TEXT)");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)"); const empty = revision(base);
    db.run("INSERT INTO rows(text) VALUES ('external event')"); const written = revision(base);
    expect(written).not.toBe(empty); expect(revision(base)).toBe(written);
    db.run("PRAGMA wal_checkpoint(TRUNCATE)"); const checkpointed = revision(base);
    expect(checkpointed).not.toBe(written); expect(revision(base)).toBe(checkpointed);
  } finally { db.close(); }
});

test("candidate WAL and the pending day counter participate, while read-only summary calls remain stable", () => {
  const base = home(), db = new Database(join(base, "candidates.db"));
  try {
    db.run("PRAGMA journal_mode=WAL"); db.run("PRAGMA wal_autocheckpoint=0");
    db.run("CREATE TABLE candidates (project TEXT, at INTEGER, shown_at INTEGER, status TEXT)");
    const first = revision(base);
    db.query("INSERT INTO candidates VALUES (?, ?, NULL, 'pending')").run("project", now);
    const changed = revision(base); expect(changed).not.toBe(first); expect(revision(base)).toBe(changed);
    expect(snapshotRevision(base, now + 86400_000)).not.toBe(changed);
    db.run("PRAGMA wal_checkpoint(TRUNCATE)"); expect(revision(base)).not.toBe(changed);
  } finally { db.close(); }
});

test("derived indexes, leases, ignored trees and empty WAL creation/deletion cannot invalidate a quiet source", () => {
  const base = home(); put(base, "log/peer.jsonl"); put(base, `projects/${project}/machine/${machine}/capture.db`);
  const before = revision(base);
  for (const name of ["index.db", "index-v2-i4.db-wal", "search.db", "catalog.db", "mutation-lock.db", "reader-admission.db",
    "readers/owner.json", "shard-readers/owner.json", ".git/objects/ignored", "node_modules/ignored/package.json",
    `projects/${project}/machine/${machine}/capture.db-shm`, `projects/${project}/work/index.db`,
    `projects/${project}/machine/${machine}/brief-capture.json`]) put(base, name);
  expect(revision(base)).toBe(before);
  const wal = put(base, `projects/${project}/machine/${machine}/capture.db-wal`, "");
  expect(revision(base)).toBe(before); rmSync(wal); expect(revision(base)).toBe(before);
  rmSync(join(base, "readers"), { recursive: true }); rmSync(join(base, "index.db")); expect(revision(base)).toBe(before);
});

test("relevant symlinks, invalid node types, unreadable candidates and malformed policies fail closed", () => {
  const base = home(), target = home(); put(target, "source.jsonl");
  symlinkSync(join(target, "source.jsonl"), join(base, "aliases.jsonl")); expect(() => revision(base)).toThrow("plain file or directory");
  rmSync(join(base, "aliases.jsonl")); mkdirSync(join(base, "aliases.jsonl")); expect(() => revision(base)).toThrow("file is unavailable");
  rmSync(join(base, "aliases.jsonl"), { recursive: true }); symlinkSync(target, join(base, "projects")); expect(() => revision(base)).toThrow("plain file or directory");
  rmSync(join(base, "projects")); put(base, "candidates.db", "invalid sqlite"); expect(() => revision(base)).toThrow("pending candidates");
  rmSync(join(base, "candidates.db")); put(base, "amem.config.json", "bad json"); expect(() => revision(base)).toThrow("JSON");
  expect(() => snapshotRevision(base, Number.NaN)).toThrow("clock");
});

test("depth and ignored-entry bounds refuse instead of returning an incomplete revision", () => {
  const base = home(); put(base, `bridge-snapshots/${Array(25).fill("nested").join("/")}/source.json`);
  expect(() => revision(base)).toThrow("depth bound");
  const other = home(); let reads = 0, closed = false;
  const fake = { readSync() { return { name: `ignored-${reads++}.tmp`, isDirectory: () => false, isSymbolicLink: () => false }; }, closeSync() { closed = true; } };
  const spy = spyOn(fs, "opendirSync").mockImplementation((() => fake) as unknown as typeof fs.opendirSync);
  try { expect(() => revision(other)).toThrow("entry bound"); expect(closed).toBe(true); expect(reads).toBe(16_385); }
  finally { spy.mockRestore(); }
});
