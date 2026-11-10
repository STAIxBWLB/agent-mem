import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANDIDATE_RETENTION, withPendingCandidates, type PendingCandidateReader } from "../src/memory/candidates.ts";

const cleanup: (() => void)[] = [], day = 86400_000;
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home() {
  const base = mkdtempSync(join(tmpdir(), "amem-waiting-projects-")); cleanup.push(() => rmSync(base, { recursive: true, force: true })); return base;
}
function fixture(shown = true) {
  const base = home(), db = new Database(join(base, "candidates.db")), now = Date.now(); cleanup.push(() => db.close());
  db.run("PRAGMA journal_mode=WAL"); db.run("PRAGMA wal_autocheckpoint=0");
  db.run(`CREATE TABLE candidates (id TEXT, project TEXT, kind TEXT, payload TEXT, at INTEGER, status TEXT, note_id TEXT${shown ? ", shown_at INTEGER" : ""})`);
  let id = 0;
  const insert = (project: string, kind = "memory", status = "pending", at = now, shownAt: number | null = null) => {
    const values = [String(++id), project, kind, "unread payload", at, status, null, ...(shown ? [shownAt] : [])];
    db.query(`INSERT INTO candidates VALUES (${values.map(() => "?").join(",")})`).run(...values);
  };
  return { base, db, now, insert };
}
function stamps(base: string) {
  return ["candidates.db", "candidates.db-wal"].map(name => {
    const stat = statSync(join(base, name), { bigint: true });
    return [String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
  });
}

test("allWaiting includes accepting-only and unknown waiting kinds; default projects stays pending-known only", () => {
  const f = fixture();
  f.insert("pending-known"); f.insert("accepting-only", "memory", "accepting");
  f.insert("future-pending", "future-kind"); f.insert("future-accepting", "future-kind", "accepting");
  f.insert("accepted-only", "memory", "accepted"); f.insert("rejected-only", "memory", "rejected");
  withPendingCandidates(f.base, reader => {
    expect(reader.projects()).toEqual(["pending-known"]);
    expect(reader.projects({})).toEqual(reader.projects());
    expect(reader.projects({ allWaiting: true })).toEqual(["accepting-only", "future-accepting", "future-pending", "pending-known"]);
  });
});

test("both modes apply live age/grace retention while protecting unshown waiting candidates", () => {
  const f = fixture(), old = f.now - 40 * day;
  f.insert("expired-pending", "memory", "pending", old, f.now - 8 * day);
  f.insert("expired-accepting", "future-kind", "accepting", old, f.now - 8 * day);
  f.insert("grace-pending", "memory", "pending", old, f.now - day);
  f.insert("grace-accepting", "future-kind", "accepting", old, f.now - day);
  f.insert("protected-pending", "memory", "pending", old);
  f.insert("protected-accepting", "future-kind", "accepting", old);
  withPendingCandidates(f.base, reader => {
    expect(reader.projects()).toEqual(["grace-pending", "protected-pending"]);
    expect(reader.projects({ allWaiting: true })).toEqual(["grace-accepting", "grace-pending", "protected-accepting", "protected-pending"]);
  });
});

test("the existing retained window is applied before known-kind filtering in either mode", () => {
  const f = fixture();
  f.insert("window", "memory", "pending", f.now - day);
  f.db.transaction(() => { for (let i = 0; i < CANDIDATE_RETENTION.count; i++) f.insert("window", "future-kind"); })();
  withPendingCandidates(f.base, reader => {
    expect(reader.projects()).toEqual([]);
    expect(reader.projects({ allWaiting: true })).toEqual(["window"]);
  });
});

test("project reads preserve candidate DB/WAL metadata and do not migrate an old schema", () => {
  for (const shown of [false, true]) {
    const f = fixture(shown); f.insert("waiting", "future-kind", "accepting", f.now - 100 * day);
    const before = stamps(f.base);
    withPendingCandidates(f.base, reader => {
      expect(reader.projects({ allWaiting: true })).toEqual(["waiting"]); expect(reader.projects()).toEqual([]);
    });
    expect(stamps(f.base)).toEqual(before);
    expect((f.db.query("PRAGMA table_info(candidates)").all() as { name: string }[]).some(row => row.name === "shown_at")).toBe(shown);
  }
});

test("missing and present ports validate options identically and expire after their callback", () => {
  const f = fixture(), missing = home();
  for (const base of [missing, f.base]) {
    let escaped!: PendingCandidateReader;
    withPendingCandidates(base, reader => {
      escaped = reader; expect(reader.projects({ allWaiting: true })).toEqual([]);
      for (const invalid of [null, false, [], { allWaiting: false }, { allWaiting: "true" }, { unknown: true }])
        expect(() => reader.projects(invalid as Parameters<PendingCandidateReader["projects"]>[0])).toThrow("project options");
    });
    expect(() => escaped.projects({ allWaiting: true })).toThrow("closed");
  }
  expect(existsSync(join(missing, "candidates.db"))).toBe(false);
});
