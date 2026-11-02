import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { drainHookCaptures, stageHookCapture } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { indexFileName } from "../src/memory/index-file.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { previousRelease } from "../scripts/previous-release.ts";

// #199 AC6: this build and the previous published release on one shared home. The CI job `previous-release` resolves
// that release with scripts/previous-release.ts and sets AMEM_PREV_ROOT; locally the suite skips without it, and
// AMEM_PREV_REQUIRED=1 (set by the job) turns a missing root into a failure instead of a skip.
const root = process.env.AMEM_PREV_ROOT, required = process.env.AMEM_PREV_REQUIRED === "1";

test("previousRelease picks the highest plain release not newer than package.json", () => {
  const published = ["0.17.0", "0.18.0", "0.19.0", "0.20.0-rc.1", "0.10.0"];
  expect(previousRelease("0.19.0", published)).toBe("0.19.0");  // a development tree: the last release
  expect(previousRelease("0.20.0", published)).toBe("0.19.0");  // a release commit not yet published: the one before
  expect(previousRelease("0.9.0", published)).toBeUndefined();
  expect(() => previousRelease("next", published)).toThrow("plain semver");
});

test("the previous-release job has its release", () => { if (required) expect(root, "AMEM_PREV_ROOT").toBeTruthy(); });

describe.skipIf(!root)("N-1: this build and the previous release share a home", () => {
  const prev = (path: string) => pathToFileURL(resolve(root!, path)).href;
  const clean: (() => void)[] = [];
  const oldHome = process.env.HOME;
  afterEach(() => { process.env.HOME = oldHome; for (const close of clean.splice(0)) close(); });
  const fixture = () => { const f = hookFixture(); clean.push(f.close); process.env.HOME = f.env.HOME; return { ...f, options: { cwd: f.cwd, base: f.base } }; };
  const spool = (base: string) => join(base, "hook-spool");
  const pending = (base: string) => existsSync(spool(base)) ? readdirSync(spool(base)).filter(name => name.startsWith("hook-")).sort() : [];
  const run = (f: ReturnType<typeof fixture>, code: string) => {
    const child = Bun.spawnSync([process.execPath, "-e", code], { cwd: f.cwd, env: { ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 15000 });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return child.stdout.toString().trim();
  };
  /** The previous release runs one ordinary hook: home-wide maintenance through stageHookCapture, then its drain for the same cwd. */
  const prevHook = (f: ReturnType<typeof fixture>, excerpt: string) => JSON.parse(run(f, `const { drainHookCaptures, stageHookCapture } = await import(${JSON.stringify(prev("src/hook-spool.ts"))});
const options = { cwd: ${JSON.stringify(f.cwd)}, base: ${JSON.stringify(f.base)} };
await stageHookCapture("PostToolUse", { tool_name: "Read", tool_response: ${JSON.stringify(excerpt)} }, options);
const appended = [];
await drainHookCaptures({ ...options, project: ${JSON.stringify(f.project)} }, (input) => { appended.push(input.agent + ":" + input.excerpt); return { id: 1 }; });
console.log(JSON.stringify(appended));`)) as string[];
  const drain = async (f: ReturnType<typeof fixture>) => {
    const store = new CaptureStore({ memoryDir: f.base, project: f.project });
    try { await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt })); return store.rows({ project: f.project }).map(row => row.agent + ":" + row.excerpt); }
    finally { store.close(); }
  };

  test("hook spool, new to old: the previous release's maintenance and drain keep or drain this build's records, never lose them", async () => {
    const f = fixture();
    const claude = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "claude from new" }, f.options))!;
    const jcode = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "jcode from new" }, { ...f.options, agent: "jcode" }))!;
    const appended = prevHook(f, "old barrier");
    expect(appended).toContain("claude:old barrier");
    // Whatever the previous release drains is drained exactly once; whatever it cannot read stays pending for this build.
    const left = pending(f.base);
    for (const [record, text] of [[claude, "claude:claude from new"], [jcode, "jcode:jcode from new"]] as const) {
      expect(appended.includes(text) || left.includes(record.name), `${text} drained or still pending`).toBe(true);
      expect(appended.includes(text) && left.includes(record.name)).toBe(false);
    }
    const rows = await drain(f);
    for (const [record, text] of [[claude, "claude:claude from new"], [jcode, "jcode:jcode from new"]] as const) if (left.includes(record.name)) expect(rows).toContain(text);
    expect(pending(f.base)).toEqual([]);
  });

  test("hook spool, old to new: a record the previous release left pending is drained by this build", async () => {
    const f = fixture();
    run(f, `const { stageHookCapture } = await import(${JSON.stringify(prev("src/hook-spool.ts"))});
await stageHookCapture("PostToolUse", { tool_name: "Read", tool_response: "old pending" }, { cwd: ${JSON.stringify(f.cwd)}, base: ${JSON.stringify(f.base)} });`);
    expect(pending(f.base)).toHaveLength(1);
    expect(await drain(f)).toContain("claude:old pending");
    expect(pending(f.base)).toEqual([]);
  });

  test("per-version index files: neither build rebuilds the other's index", () => {
    const f = fixture();
    const schema = (file: string) => { const db = new Database(file, { readonly: true }); try { return (db.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version; } finally { db.close(); } };
    const note = (text: string) => ({ op: "note", project: "p", scope: "project", tier: "long", kind: "finding", peer: "person", text, about: [], source: "person" });
    const prevStore = (body: string) => run(f, `const { MemoryStore } = await import(${JSON.stringify(prev("src/memory/store.ts"))}); const s = new MemoryStore({ memoryDir: ${JSON.stringify(f.base)}, screen: () => "keep" }); ${body} s.close();`);
    prevStore(`s.note(${JSON.stringify(note("by previous"))});`);
    const ours = join(f.base, indexFileName(false));
    const mine = new MemoryStore({ memoryDir: f.base, screen: () => "keep" }); try { mine.note(note("by this build") as never); } finally { mine.close(); }
    const files = readdirSync(f.base).filter(name => /^index.*\.db$/.test(name)).sort(), before = Object.fromEntries(files.map(name => [name, schema(join(f.base, name))]));
    expect(existsSync(ours)).toBe(true);
    expect(prevStore(`console.log(s.list({ project: "p" }).length);`)).toBe("2");
    const again = new MemoryStore({ memoryDir: f.base, screen: () => "keep" }); try { expect(again.list({ project: "p" })).toHaveLength(2); } finally { again.close(); }
    // The same index files, each at the schema it had: no rebuild, rename or drop in either direction.
    expect(readdirSync(f.base).filter(name => /^index.*\.db$/.test(name)).sort()).toEqual(files);
    for (const name of files) expect(schema(join(f.base, name)), name).toBe(before[name]!);
  });

  test("candidates: a kind the reader does not know is skipped, both ways", () => {
    const f = fixture();
    const store = new CandidateStore({ memoryDir: f.base });
    let id: string;
    try { id = store.put({ kind: "memory", project: f.project, text: "a known candidate" }, "public"); } finally { store.close(); }
    const db = new Database(join(f.base, "candidates.db"));
    try { db.query("INSERT INTO candidates (id, project, kind, payload, at, status) VALUES (?, ?, 'future-kind', ?, ?, 'pending')").run("f".repeat(64), f.project, JSON.stringify({ kind: "future-kind", project: f.project }), Date.now() + 60_000); }
    finally { db.close(); }
    expect(JSON.parse(run(f, `const { CandidateStore } = await import(${JSON.stringify(prev("src/memory/candidates.ts"))}); const s = new CandidateStore({ memoryDir: ${JSON.stringify(f.base)} });
try { console.log(JSON.stringify({ ids: s.list({ project: ${JSON.stringify(f.project)} }).map(c => c.id), skipped: s.skippedUnknownKinds })); } finally { s.close(); }`))).toEqual({ ids: [id!], skipped: 1 });
    const mine = new CandidateStore({ memoryDir: f.base });
    try { expect(mine.list({ project: f.project }).map(candidate => candidate.id)).toEqual([id!]); expect(mine.skippedUnknownKinds).toBe(1); } finally { mine.close(); }
  });

  test("format floors: a hook-spool floor above both releases stops each from staging or draining, and lifting it drains", async () => {
    const f = fixture();
    const staged = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "before floor" }, f.options))!;
    // A person raises the floor (formats.json is never written by amem code); the test plays that person.
    writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "hook-spool", minReader: "99.0.0", since: "2026-11-02" }]));
    // Releases before 0.19.0 predate format floors (#207) and cannot honor one: only a floor-aware release is held to it.
    if (existsSync(resolve(root!, "src/memory/formats.ts"))) { expect(prevHook(f, "old under floor")).toEqual([]); expect(pending(f.base)).toEqual([staged.name]); }
    expect(await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "new under floor" }, f.options)).toBeUndefined();
    expect(await drain(f)).toEqual([]);
    expect(pending(f.base)).toEqual([staged.name]);
    writeFileSync(join(f.base, "formats.json"), "[]");
    expect(await drain(f)).toContain("claude:before floor");
    expect(readFileSync(join(f.base, "formats.json"), "utf8")).toBe("[]");
  });
});
