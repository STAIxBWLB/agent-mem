import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CandidateStore, candidateInputId, withPendingCandidates, type CandidateInput, type PendingCandidateReader } from "../src/memory/candidates.ts";
import { hasShownColumn } from "../src/memory/candidate-pending.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() { const dir = mkdtempSync(join(tmpdir(), "amem-inbox-candidates-")); roots.push(dir); return dir; }
const input = (project: string, index: number): CandidateInput => ({ project, kind: "memory", text: `synthetic inbox original ${index}` });
function database(home: string) { const store = new CandidateStore({ memoryDir: home }); store.close(); return new Database(join(home, "candidates.db")); }
function insert(db: Database, value: CandidateInput, at: number, status = "pending", shownAt: number | null = null) {
  const id = candidateInputId(value);
  db.query("INSERT INTO candidates (id,project,kind,payload,at,status,note_id,shown_at) VALUES (?,?,?,?,?,?,NULL,?)")
    .run(id, value.project, value.kind, JSON.stringify(value), at, status, shownAt);
  return id;
}
function bytes(home: string) {
  return Object.fromEntries(["candidates.db", "candidates.db-wal"].map(name => {
    const file = join(home, name), content = existsSync(file) ? readFileSync(file) : undefined;
    // SQLite may recreate an empty derived WAL/SHM on a read-only WAL attach. No frames and no main-DB
    // change is still read-only; every nonempty WAL byte remains part of this exact comparison.
    return [name, content && (name === "candidates.db" || content.length > 0) ? content.toString("base64") : null];
  }));
}

test("pending inbox reads live WAL without pruning, schema changes, chmod or DB/WAL frame writes", () => {
  const dir = home(), store = new CandidateStore({ memoryDir: dir });
  try {
    const id = store.put(input("project-a", 1), "public"), file = join(dir, "candidates.db");
    expect(existsSync(file + "-wal")).toBe(true); expect(readFileSync(file + "-wal").length).toBeGreaterThan(0);
    chmodSync(file, 0o640); const before = bytes(dir), mode = lstatSync(file).mode;
    for (let pass = 0; pass < 3; pass++) withPendingCandidates(dir, reader => {
      expect(reader.projects()).toEqual(["project-a"]); expect(reader.list(["project-a"]).map(candidate => candidate.id)).toEqual([id]);
      expect(reader.list([])).toEqual([]);
    });
    expect(bytes(dir)).toEqual(before); expect(lstatSync(file).mode).toBe(mode);
  } finally { store.close(); }
});

test("pending projects and alias lists match writer ordering, age/grace and count retention without performing retention", () => {
  const dir = home(), db = database(dir), now = Date.now(), day = 86400_000;
  let oldest = "", tieA = "", tieB = "", fresh = "", expired = "";
  try {
    oldest = insert(db, input("canonical", 1), now - 40 * day); // Unshown pending never expires by age.
    tieA = insert(db, input("canonical", 2), now - day);
    tieB = insert(db, input("alias", 3), now - day);
    fresh = insert(db, input("alias", 4), now - 40 * day, "pending", now - 2 * day); // Within shown grace.
    expired = insert(db, input("canonical", 5), now - 40 * day, "pending", now - 8 * day);
    insert(db, input("accepting-only", 6), now, "accepting"); insert(db, input("decided-only", 7), now, "accepted");
    const before = bytes(dir);
    withPendingCandidates(dir, reader => {
      expect(reader.projects()).toEqual(["alias", "canonical"]);
      expect(reader.list(["canonical", "alias"]).map(candidate => candidate.id)).toEqual([tieB, tieA, fresh, oldest]);
      expect(reader.list(["accepting-only"])).toEqual([]);
    });
    expect(bytes(dir)).toEqual(before); expect(db.query("SELECT id FROM candidates WHERE id=?").get(expired)).not.toBeNull();
  } finally { db.close(); }
  const writer = new CandidateStore({ memoryDir: dir, now: () => now, reconcile: { canonical: "canonical", aliases: ["alias"] } });
  try {
    expect(writer.list({ project: "canonical", status: "pending" }).map(candidate => candidate.id)).toEqual([tieB, tieA, fresh, oldest]);
    expect(writer.get(expired, "canonical")).toBeUndefined();
  } finally { writer.close(); }
});

test("alias reads share the existing 500 aggregate cap and keep physical per-project retention priorities", () => {
  const dir = home(), db = database(dir), now = Date.now();
  try {
    db.transaction(() => {
      for (let index = 0; index < 300; index++) { insert(db, input("canonical", index), now + index); insert(db, input("alias", index + 300), now + index); }
    })();
  } finally { db.close(); }
  const before = bytes(dir), read = withPendingCandidates(dir, reader => reader.list(["canonical", "alias", "alias"]));
  expect(read).toHaveLength(500); expect(bytes(dir)).toEqual(before);
  const writer = new CandidateStore({ memoryDir: dir, now: () => now, reconcile: { canonical: "canonical", aliases: ["alias"] } });
  try { expect(read).toEqual(writer.list({ project: "canonical", status: "pending" })); } finally { writer.close(); }
});

test("unknown SQL kinds are skipped before LIMIT and shared decode preserves writer unknown-kind counters", () => {
  const dir = home(), db = database(dir), now = Date.now(); let known = "";
  try {
    known = insert(db, input("known", 1), now);
    db.query("INSERT INTO candidates(id,project,kind,payload,at,status) VALUES (?,?,?,?,?,'pending')").run("1".repeat(64), "future-only", "future-kind", "not-json", now + 1);
    db.query("INSERT INTO candidates(id,project,kind,payload,at,status) VALUES (?,?,?,?,?,'pending')").run("2".repeat(64), "known", "future-kind", "not-json", now + 2);
    db.query("INSERT INTO candidates(id,project,kind,payload,at,status) VALUES (?,?,?,?,?,'pending')").run("3".repeat(64), "known", "memory", JSON.stringify({ project: "known", kind: "future-kind" }), now + 3);
  } finally { db.close(); }
  withPendingCandidates(dir, reader => { expect(reader.projects()).toEqual(["known"]); expect(reader.list(["known"]).map(candidate => candidate.id)).toEqual([known]); });
  const writer = new CandidateStore({ memoryDir: dir });
  try { expect(writer.list({ project: "known", status: "pending" }).map(candidate => candidate.id)).toEqual([known]); expect(writer.skippedUnknownKinds).toBe(2); }
  finally { writer.close(); }
});

test("read-only pending classification supports legacy candidates without shown_at and never migrates them", () => {
  const dir = home(), file = join(dir, "candidates.db"), db = new Database(file, { create: true }), value = input("legacy", 1), id = candidateInputId(value);
  try {
    db.run("CREATE TABLE candidates(id TEXT PRIMARY KEY,project TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL,note_id TEXT)");
    db.query("INSERT INTO candidates VALUES (?,?,?,?,?,'pending',NULL)").run(id, value.project, value.kind, JSON.stringify(value), Date.now() - 90 * 86400_000);
  } finally { db.close(); }
  const before = bytes(dir);
  withPendingCandidates(dir, reader => { expect(reader.projects()).toEqual(["legacy"]); expect(reader.list(["legacy"])[0]?.id).toBe(id); expect(reader.nextExpiry()).toBeNull(); });
  expect(bytes(dir)).toEqual(before);
  const verify = new Database(file, { readonly: true }); try { expect(hasShownColumn(verify)).toBe(false); } finally { verify.close(); }
});

for (const fault of ["hash", "malformed", "project-binding"] as const) test(`pending reader refuses ${fault} corruption using the canonical validator`, () => {
  const dir = home(), db = database(dir), value = input("selected", 1), id = insert(db, value, Date.now());
  try {
    if (fault === "hash") db.query("UPDATE candidates SET payload=? WHERE id=?").run(JSON.stringify({ ...value, text: "changed immutable body" }), id);
    if (fault === "malformed") db.query("UPDATE candidates SET payload=? WHERE id=?").run("not-json", id);
    if (fault === "project-binding") db.query("UPDATE candidates SET project=? WHERE id=?").run("other", id);
  } finally { db.close(); }
  const before = bytes(dir);
  expect(() => withPendingCandidates(dir, reader => reader.list([fault === "project-binding" ? "other" : "selected"]))).toThrow();
  expect(bytes(dir)).toEqual(before);
});

test("reader stays scoped to its explicit home and rejects a symlinked database", () => {
  const a = home(), b = home(), left = new CandidateStore({ memoryDir: a }), right = new CandidateStore({ memoryDir: b });
  let idA: string, idB: string;
  try { idA = left.put(input("same-project", 1), "public"); idB = right.put(input("same-project", 2), "public"); }
  finally { left.close(); right.close(); }
  expect(withPendingCandidates(a, reader => reader.list(["same-project"]).map(row => row.id))).toEqual([idA!]);
  expect(withPendingCandidates(b, reader => reader.list(["same-project"]).map(row => row.id))).toEqual([idB!]);
  const third = home(); symlinkSync(join(a, "candidates.db"), join(third, "candidates.db"));
  expect(() => withPendingCandidates(third, reader => reader.projects())).toThrow();
});

test("missing database is empty while unsupported databases and format floors fail closed without sidecar writes", () => {
  const missing = home(); expect(withPendingCandidates(missing, reader => ({ projects: reader.projects(), rows: reader.list(["project"]), expiry: reader.nextExpiry() }))).toEqual({ projects: [], rows: [], expiry: null }); expect(existsSync(join(missing, "candidates.db"))).toBe(false);
  const unsupported = home(), db = new Database(join(unsupported, "candidates.db"), { create: true }); db.run("CREATE TABLE unrelated(value TEXT)"); db.close();
  const before = bytes(unsupported); expect(() => withPendingCandidates(unsupported, reader => reader.projects())).toThrow(); expect(bytes(unsupported)).toEqual(before);
  const fenced = home(), writer = new CandidateStore({ memoryDir: fenced }); writer.put(input("fenced", 1), "public"); writer.close();
  writeFileSync(join(fenced, "formats.json"), JSON.stringify([{ surface: "candidates", minReader: "99.0.0", since: "2026-11-01T00:00:00.000Z" }]));
  const prior = bytes(fenced); expect(() => withPendingCandidates(fenced, reader => reader.projects())).toThrow(); expect(bytes(fenced)).toEqual(prior);
});

test("readonly connection closes on callback failure and the borrowed port cannot escape its lifetime", () => {
  const dir = home(), writer = new CandidateStore({ memoryDir: dir }); writer.put(input("project", 1), "public"); writer.close();
  let retained: PendingCandidateReader | undefined;
  const close = spyOn(Database.prototype, "close");
  try {
    expect(() => withPendingCandidates(dir, reader => { retained = reader; expect(reader.projects()).toEqual(["project"]); throw Error("synthetic callback failure"); })).toThrow("synthetic callback failure");
    expect(close).toHaveBeenCalledTimes(1);
  } finally { close.mockRestore(); }
  expect(() => retained!.list(["project"])).toThrow("closed");
  expect(withPendingCandidates(dir, reader => reader.list(["project"]))).toHaveLength(1);
});


test("read-only expiry reports only the earliest future shown pending age/grace boundary", () => {
  const dir = home(), db = database(dir), now = Date.now(), day = 86400_000;
  try {
    insert(db, input("project", 1), now - 30 * day + 60000, "pending", now - 8 * day);
    insert(db, input("project", 2), now - 40 * day, "pending", now - 7 * day + 120000);
    insert(db, input("project", 3), now - 100 * day); // Unshown never supplies an expiry.
    insert(db, input("project", 4), now - 40 * day, "pending", now - 8 * day); // Already expired.
    insert(db, input("project", 5), now - 30 * day + 30000, "accepting", now - 8 * day);
  } finally { db.close(); }
  const before = bytes(dir);
  withPendingCandidates(dir, reader => { expect(reader.nextExpiry()).toBe(now + 60000); expect(reader.list(["project"])).toHaveLength(3); });
  expect(bytes(dir)).toEqual(before);
});
