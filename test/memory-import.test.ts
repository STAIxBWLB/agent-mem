import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importClaudeMem } from "../src/memory/import.ts";
import { MemoryStore, type NoteInput } from "../src/memory/store.ts";

// #258 phase 3: claude-mem import, model-suggested edges kept out of evidence, and the measurement inputs.

const dirs: string[] = [];
const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `ahub-mem3-${name}-`))); dirs.push(d); return d; };
const open = () => { const s = new MemoryStore({ home: temp("home") }); cleanup.push(() => s.close()); return s; };
const note = (text: string, over: Partial<NoteInput> = {}): NoteInput => ({ op: "note", project: "work/app", scope: "project", tier: "long", kind: "decision", peer: "codex", text, about: [], source: "hub", ...over });

test("claude-mem import copies the hub's notes of this project once, never model answers, PII or secrets, and never writes claude-mem", () => {
  const file = join(temp("cm"), "claude-mem.db");
  const db = new Database(file);
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  const add = (project: string, title: string, text: string, metadata: unknown) => db.query("INSERT INTO observations (project, title, text, narrative, created_at_epoch, metadata) VALUES (?, ?, ?, NULL, ?, ?)").run(project, title, text, 1_790_000_000_000, metadata === null ? null : JSON.stringify(metadata));
  add("app", "agent-hub task #3: parser", "regex split fails on quotes", { peer: "codex", task: 3, kind: "fail" });
  add("app", "a decision", "the parser owns quoting", { peer: "claude", kind: "decision" });
  add("app", "ahub ask (model answer): why", "A: because", { peer: "hub", kind: "finding", source: "ahub ask" });
  add("app", "call", "phone 900101-1234567 back", { peer: "codex", kind: "finding" });
  add("app", "creds", "token: abcdefgh12345678", { peer: "codex", kind: "finding" });
  add("other", "elsewhere", "another repo's note", { peer: "codex", kind: "decision" });
  add("work", "superproject", "the superproject's note, under its own policy", { peer: "codex", kind: "decision" });
  add("app", "native observation", "captured by a hook, not a hub note", null);
  db.close();
  const before = Bun.file(file).size;
  const s = open();
  const isPii = (t: string) => /\d{6}-\d{7}/.test(t);
  const nodes = (text: string) => text.includes("parser") ? ["symbol:parse@src/csv.ts"] : [];
  const r = importClaudeMem(s, { project: "github.com/o/app", chain: ["work", "app"], isPii, nodes, db: file });
  expect(r).toMatchObject({ read: 5, added: 2, skipped: { model: 1, pii: 1, secret: 1 }, more: false, cursor: 5 }); // only the repository's own name, not the chain above it
  const got = s.list();
  expect(got.map((v) => v.text).sort()).toEqual(["regex split fails on quotes", "the parser owns quoting"]);
  expect(got.every((v) => v.tier === "long" && v.source === "claude-mem" && v.project === "github.com/o/app")).toBe(true);
  expect(got.find((v) => v.kind === "fail")!.about).toEqual(["symbol:parse@src/csv.ts"]); // the text's own nodes, never a bare task number
  // The same observation imported on another machine is the same entry.
  const other = open();
  importClaudeMem(other, { project: "github.com/o/app", chain: ["app"], isPii, nodes, db: file });
  expect(other.list().map((v) => v.id).sort()).toEqual(got.map((v) => v.id).sort());
  // A second import adds nothing, and claude-mem's file is unchanged.
  expect(importClaudeMem(s, { project: "github.com/o/app", chain: ["work", "app"], isPii, db: file }).added).toBe(0);
  expect(Bun.file(file).size).toBe(before);
  expect(() => importClaudeMem(s, { project: "github.com/o/app", chain: ["app"], isPii, db: join(temp("none"), "missing.db") })).toThrow("no claude-mem store");
});

test("suggested edges remain outside retrieval until confirmed; rejected edges disappear and project scope is enforced", async () => {
  const s = open();
  const a = s.note(note("use a regex split", { about: ["path:src/csv.ts"] }));
  const b = s.note(note("never split with a regex", { about: ["path:src/other.ts"] }));
  const sid = s.suggest(a, b, "contradicts")!;
  expect(s.suggest(a, b, "contradicts")).toBeUndefined(); // once
  const related = () => s.related("work/app", ["path:src/csv.ts"], 8).map((v) => v.id);
  expect(related()).toEqual([a]);
  const edges = () => s.graph("work/app", `mem:${a}`).edges.filter((e) => e.from === `mem:${a}` && e.to === `mem:${b}`).map((e) => e.rel);
  expect(edges()).toEqual(["suggested contradicts"]);
  s.judge(sid.slice(0, 8), "confirm", "user");
  expect(related()).toEqual([a, b]);
  expect(edges()).toEqual(["contradicts"]);
  const other = s.note(note("unrelated", { about: ["path:src/x.ts"] }));
  const rid = s.suggest(a, other, "same_topic")!;
  s.judge(rid, "reject", "user");
  expect(s.graph("work/app", `mem:${a}`).edges.some((e) => e.to === `mem:${other}`)).toBe(false);
  expect(s.suggestions().map((x) => x.status).sort()).toEqual(["confirmed", "rejected"]);
  // Review of #356: another project sees no suggestion between this project's entries, and cannot judge one.
  const third = s.suggest(b, other, "same_topic")!;
  expect(s.suggestions("work/other")).toEqual([]);
  expect(s.judge(third, "confirm", "user", "work/other")).toBeUndefined();
  expect(s.suggestions("work/app").map((x) => x.id)).toContain(third);

});

function sourceRows(rows: { project?: string; text?: string; metadata?: string }[]) {
  const file = join(temp("cursor-source"), "claude-mem.db");
  const db = new Database(file);
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  for (const r of rows) db.query("INSERT INTO observations (project, title, text, created_at_epoch, metadata) VALUES (?, '', ?, 1790000000000, ?)")
    .run(r.project ?? "app", r.text ?? "a useful note", r.metadata ?? '{"peer":"codex"}');
  db.close();
  return file;
}

test("claude-mem project filtering prevents starvation and the local cursor advances bounded windows, including skipped rows", () => {
  const file = sourceRows([
    ...Array.from({ length: 6 }, () => ({ project: "other" })),
    { text: "one" }, { metadata: '{"peer":42}' }, { text: "two" }, { text: "" },
    { metadata: '{"peer":broken}' }, { text: "three" },
  ]);
  const s = open();
  const opts = { project: "github.com/o/app", chain: ["app"], isPii: () => false, db: file, limit: 1 };
  const cursors: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = importClaudeMem(s, opts);
    expect(r.read).toBe(1);
    expect(r.more).toBe(true);
    cursors.push(r.cursor);
  }
  expect(cursors).toEqual([7, 8, 9, 10, 11, 12]);
  expect(s.list().map((v) => v.text).sort()).toEqual(["one", "three", "two"]);
  expect(importClaudeMem(s, opts)).toMatchObject({ read: 0, added: 0, more: false, cursor: 12 });
  expect(importClaudeMem(s, { ...opts, restart: true, limit: 100 })).toMatchObject({ read: 6, added: 0, more: false, cursor: 12 });
  const cursorFile = join(s.dir, "import-state.json");
  expect(statSync(cursorFile).mode & 0o777).toBe(0o600);
  expect(Object.values(JSON.parse(readFileSync(cursorFile, "utf8")))).toEqual([12]);
  // The same claude-mem basename can belong to distinct hub namespaces; their cursors cannot starve each other.
  expect(importClaudeMem(s, { ...opts, project: "github.com/other/app", limit: 100 })).toMatchObject({ read: 6, added: 3, cursor: 12 });
  const before = s.dump(); s.rebuild(); expect(s.dump()).toBe(before);
});

test("claude-mem cursor survives reopen and resets a recreated project source even when unrelated rows have higher ids", () => {
  const file = sourceRows([{ text: "old one" }, { text: "old two" }]);
  const s = open();
  const opts = { project: "github.com/o/app", chain: ["app"], isPii: () => false, db: file };
  expect(importClaudeMem(s, opts)).toMatchObject({ read: 2, added: 2, cursor: 2 });
  const otherHandle = new MemoryStore({ home: s.dir.slice(0, -"/memory".length) });
  cleanup.push(() => otherHandle.close());
  expect(importClaudeMem(otherHandle, opts)).toMatchObject({ read: 0, added: 0, cursor: 2 });
  // Recreate the database at the same real path: this project restarted below the cursor,
  // while unrelated projects already have ids above it. A global MAX(id) must not hide the reset.
  unlinkSync(file);
  const db = new Database(file);
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  db.run(`INSERT INTO observations (project, text, created_at_epoch, metadata) VALUES ('app', 'new source', 1790000000000, '{"peer":"codex"}')`);
  for (const text of ["foreign two", "foreign three", "foreign four"]) db.query("INSERT INTO observations (project, text, created_at_epoch, metadata) VALUES (?, ?, ?, ?)").run("other", text, 1_790_000_000_000, '{"peer":"codex"}');
  expect(db.query("SELECT MAX(id) AS id FROM observations").get()).toEqual({ id: 4 });
  db.close();
  expect(importClaudeMem(s, opts)).toMatchObject({ read: 1, added: 1, more: false, cursor: 1 });
  expect(s.list().map((v) => v.text).sort()).toEqual(["new source", "old one", "old two"]);
  expect(importClaudeMem(s, opts)).toMatchObject({ read: 0, added: 0, more: false, cursor: 1 });
  writeFileSync(join(s.dir, "import-state.json"), "{broken");
  expect(importClaudeMem(s, opts)).toMatchObject({ read: 1, added: 0, cursor: 1 });
});

test("claude-mem cursor records completed rows after a callback error and restart reconsiders earlier privacy skips", () => {
  const file = sourceRows([{ text: "public first" }, { text: "private later" }, { text: "public last" }]);
  const s = open();
  const base = { project: "github.com/o/app", chain: ["app"], db: file };
  expect(() => importClaudeMem(s, { ...base, isPii: (text) => { if (text.includes("private")) throw new Error("policy unavailable"); return false; } })).toThrow("policy unavailable");
  expect(importClaudeMem(s, { ...base, isPii: (text) => text.includes("private") })).toMatchObject({ read: 2, added: 1, skipped: { pii: 1 }, cursor: 3 });
  // A new policy cannot implicitly revisit skipped history: that is the explicit restart operation.
  expect(importClaudeMem(s, { ...base, isPii: () => false })).toMatchObject({ read: 0, added: 0 });
  expect(importClaudeMem(s, { ...base, restart: true, isPii: () => false })).toMatchObject({ read: 3, added: 1, cursor: 3 });
  expect(s.list()).toHaveLength(3);
});


test("claude-mem import succeeds with a warning when machine-local cursor persistence fails", () => {
  const file = sourceRows([{ text: "recoverable import" }]), s = open(), logs: string[] = [];
  mkdirSync(join(s.dir, "import-state.json")); // a rename onto a directory cannot succeed, even under a privileged user
  const opts = { project: "github.com/o/app", chain: ["app"], db: file, isPii: () => false, log: (line: string) => logs.push(line) };
  expect(importClaudeMem(s, opts)).toMatchObject({ read: 1, added: 1, cursor: 1 });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("could not be saved");
  expect(importClaudeMem(s, opts)).toMatchObject({ read: 1, added: 0 });
  expect(s.list()).toHaveLength(1);
});
