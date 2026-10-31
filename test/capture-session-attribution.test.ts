import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { pathToFileURL } from "node:url";
import { hookFixture, workMarker } from "./fakes/hooks-fixture.ts";
import { drainHookCaptures, stageHookCapture } from "../src/hook-spool.ts";
import { addAttributionColumns, CaptureStore } from "../src/memory/capture.ts";
import { normalizeCaptureFields } from "../src/memory/capture-input.ts";
import { sessionStartBrief } from "../src/session-brief.ts";

const clean: (() => void)[] = [];
const oldHome = process.env.HOME;
afterEach(() => { process.env.HOME = oldHome; for (const close of clean.splice(0)) close(); });
function fixture() {
  const f = hookFixture(); clean.push(f.close); process.env.HOME = f.env.HOME;
  return { ...f, options: { cwd: f.cwd, base: f.base } };
}
async function drain(f: ReturnType<typeof fixture>) {
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try { await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt })); return store.rows({ project: f.project }); }
  finally { store.close(); }
}
const spoolText = (base: string) => [join(base, "hook-spool"), join(base, "hook-spool", ".capacity")]
  .flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")).map(name => readFileSync(join(dir, name), "utf8")) : []).join("\n");

test("main-agent and subagent payloads stage a session hash and the subagent marker, never the raw id or transcript path", async () => {
  const f = fixture();
  const raw = "0f9a2c71-raw-session-identifier", transcript = "/Users/someone/.claude/projects/x/transcript.jsonl";
  await stageHookCapture("PostToolUse", { session_id: raw, transcript_path: transcript, tool_name: "Read", tool_response: "main agent capture" }, f.options);
  await stageHookCapture("PostToolUse", { session_id: raw, transcript_path: transcript, agent_id: "agent-7", agent_type: "Explore", tool_name: "Grep", tool_response: "subagent capture" }, f.options);
  const staged = spoolText(f.base);
  expect(staged).not.toContain(raw); expect(staged).not.toContain(transcript); expect(staged).not.toContain("agent-7"); expect(staged).not.toContain("Explore");
  const rows = await drain(f);
  const main = rows.find(row => row.excerpt === "main agent capture")!, sub = rows.find(row => row.excerpt === "subagent capture")!;
  expect(main.session).toMatch(/^[a-f0-9]{16}$/); expect(sub.session).toBe(main.session!);
  expect(main.subagent).toBeUndefined(); expect(sub.subagent).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(raw);
});

test("missing and hostile attribution values are dropped, within the record bound", async () => {
  const f = fixture();
  const cases: [unknown, unknown][] = [[undefined, undefined], ["", ""], ["x".repeat(257), 7], [42, { id: 1 }], [["a"], true], [null, null]];
  for (const [i, [session_id, agent_id]] of cases.entries()) {
    const payload: Record<string, unknown> = { tool_name: "Read", tool_response: `hostile ${i}` };
    if (session_id !== undefined) payload.session_id = session_id;
    if (agent_id !== undefined) payload.agent_id = agent_id;
    await stageHookCapture("PostToolUse", payload, f.options);
  }
  const rows = await drain(f);
  expect(rows).toHaveLength(cases.length);
  for (const row of rows) { expect(row.session).toBeUndefined(); expect(row.subagent).toBeUndefined(); }
  // The longest accepted id still yields the fixed-width key.
  await stageHookCapture("PostToolUse", { session_id: "y".repeat(256), tool_response: "max id" }, f.options);
  expect((await drain(f)).find(row => row.excerpt === "max id")?.session).toMatch(/^[a-f0-9]{16}$/);
  // Direct callers cannot store an unhashed session or a non-boolean marker.
  const direct = normalizeCaptureFields({ agent: "x", event: "e", session: "raw-session-id", subagent: "yes" as unknown as boolean });
  expect(direct.session).toBeUndefined(); expect(direct.subagent).toBeUndefined();
});

test("a policy-denied session id refuses the whole event before anything is stored", async () => {
  const f = fixture();
  await stageHookCapture("PostToolUse", { session_id: "AKIAIOSFODNN7EXAMPLE", tool_response: "policy screened" }, f.options);
  expect(spoolText(f.base)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect((await drain(f)).some(row => row.excerpt === "policy screened")).toBe(false);
});

test("the SessionStart brief and sessionStartBrief() leave subagent capture out; search and show keep it", async () => {
  const f = fixture(); await f.seed();
  await stageHookCapture("PostToolUse", { session_id: "s", tool_response: "visible main capture" }, f.options);
  await stageHookCapture("PostToolUse", { session_id: "s", agent_id: "a1", tool_response: "hidden subagent capture" }, f.options);
  await drain(f);
  const brief = await sessionStartBrief({ cwd: f.cwd, base: f.base, project: f.project });
  expect(brief.context).toContain("visible main capture"); expect(brief.context).not.toContain("hidden subagent capture");
  expect(brief.context).toContain(workMarker);
  const native = f.runFunctional("SessionStart", { source: "startup" });
  const context = JSON.parse(native.stdout.toString()).hookSpecificOutput.additionalContext as string;
  expect(context).not.toContain("hidden subagent capture");
  const { createMemoryMcp } = await import("../src/mcp-memory.ts");
  const memory = createMemoryMcp({ cwd: f.cwd, base: f.base });
  try {
    const found = JSON.stringify(await memory.tools.amem_search({ query: "hidden subagent capture" }));
    expect(found).toContain("hidden subagent capture"); expect(found).toContain("\"subagent\":true");
  } finally { memory.close(); }
});

test("older rows without the columns read unchanged, and the shard gains the columns additively", async () => {
  const f = fixture();
  const legacy = new CaptureStore({ memoryDir: f.base, project: f.project }), dir = legacy.dir;
  legacy.append({ project: f.project, agent: "fixture", event: "PostToolUse", excerpt: "pre-173 row" }); legacy.close();
  // Simulate a pre-#173 shard: drop the new columns.
  const db = new Database(join(dir, "capture.db"));
  db.run("ALTER TABLE rows DROP COLUMN session"); db.run("ALTER TABLE rows DROP COLUMN subagent"); db.close();
  const reopened = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    const [row] = reopened.rows({ project: f.project });
    expect(row).toEqual({ id: row!.id, at: row!.at, project: f.project, agent: "fixture", event: "PostToolUse", tool: null, paths: [], status: null, excerpt: "pre-173 row" });
    reopened.append({ project: f.project, agent: "fixture", event: "PostToolUse", excerpt: "post-173 row", session: "0123456789abcdef", subagent: true });
    expect(reopened.rows({ project: f.project }).at(-1)).toMatchObject({ session: "0123456789abcdef", subagent: true });
  } finally { reopened.close(); }
});

test("two first opens after upgrade migrate concurrently: a column added between schema read and ALTER is tolerated", async () => {
  const f = fixture();
  const first = new CaptureStore({ memoryDir: f.base, project: f.project }), file = join(first.dir, "capture.db");
  first.append({ project: f.project, agent: "fixture", event: "PostToolUse", excerpt: "pre-upgrade row" }); first.close();
  const legacy = new Database(file); legacy.run("ALTER TABLE rows DROP COLUMN session"); legacy.run("ALTER TABLE rows DROP COLUMN subagent"); legacy.close();
  // Writer A has read table_info (no columns); writer B's ALTERs land before each of A's ALTERs.
  const a = new Database(file), b = new Database(file);
  try {
    addAttributionColumns(a, column => { b.run(`ALTER TABLE rows ADD COLUMN ${column} ${column === "session" ? "TEXT" : "INTEGER"}`); });
    const names = (a.query("PRAGMA table_info(rows)").all() as { name: string }[]).map(c => c.name);
    expect(names.filter(name => name === "session" || name === "subagent").sort()).toEqual(["session", "subagent"]);
  } finally { a.close(); b.close(); }
  // Both real opens now succeed and see the old row unchanged.
  const one = new CaptureStore({ memoryDir: f.base, project: f.project }), two = new CaptureStore({ memoryDir: f.base, project: f.project });
  try { expect(one.rows({ project: f.project }).map(row => row.excerpt)).toEqual(["pre-upgrade row"]); expect(two.rows({ project: f.project })).toHaveLength(1); }
  finally { one.close(); two.close(); }
  // A non-duplicate failure still surfaces.
  const broken = new Database(":memory:"); broken.run("CREATE TABLE rows (id INTEGER)");
  try { expect(() => addAttributionColumns(broken, () => { broken.run("DROP TABLE rows"); })).toThrow(); } finally { broken.close(); }
});

test("FTS indexes are the same after incremental appends and a full rebuild", async () => {
  const f = fixture();
  const store = new CaptureStore({ memoryDir: f.base, project: f.project }), file = join(store.dir, "capture.db");
  try {
    for (let i = 0; i < 6; i++) store.append({ project: f.project, agent: "fixture", event: "PostToolUse", excerpt: `rebuild row ${i}`, ...(i % 2 ? { subagent: true, session: "0123456789abcdef" } : {}) });
  } finally { store.close(); }
  // Incremental: the trigger-maintained index. Full rebuild: a fresh FTS table populated from rows at once.
  const terms = (db: Database, table: string) => {
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${table}_v USING fts5vocab(main, ${table}, instance)`);
    return JSON.stringify(db.query(`SELECT term, doc, offset FROM temp.${table}_v ORDER BY term, doc, offset`).all());
  };
  const db = new Database(file);
  try {
    const incremental = terms(db, "fts");
    db.run("CREATE VIRTUAL TABLE full_fts USING fts5(body)");
    db.run("INSERT INTO full_fts (rowid, body) SELECT id, excerpt FROM rows");
    expect(terms(db, "full_fts")).toBe(incremental);
    expect(incremental).toContain("rebuild");
  } finally { db.close(); }
});

test("the previously published reader (0.15.0) opens and reads a shard holding the new fields", async () => {
  const f = fixture();
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  store.append({ project: f.project, agent: "fixture", event: "PostToolUse", excerpt: "new-field row", session: "0123456789abcdef", subagent: true });
  store.close();
  const root = resolve(import.meta.dir, "../node_modules/@staix/agent-mem-v015/src/memory/capture.ts");
  const script = `const { CaptureStore } = await import(${JSON.stringify(pathToFileURL(root).href)});
const s = new CaptureStore({ memoryDir: ${JSON.stringify(f.base)}, project: ${JSON.stringify(f.project)} });
try { s.append({ project: ${JSON.stringify(f.project)}, agent: "old", event: "PostToolUse", excerpt: "old-writer row" }); console.log(JSON.stringify(s.rows({ project: ${JSON.stringify(f.project)} }))); } finally { s.close(); }`;
  const child = Bun.spawnSync([process.execPath, "-e", script], { env: { ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const rows = JSON.parse(child.stdout.toString()) as { excerpt: string }[];
  expect(rows.map(row => row.excerpt)).toEqual(["new-field row", "old-writer row"]);
  // The current reader sees the old writer's row without attribution.
  const reopened = new CaptureStore({ memoryDir: f.base, project: f.project });
  try { expect(reopened.rows({ project: f.project }).at(-1)).not.toHaveProperty("subagent"); } finally { reopened.close(); }
  rmSync(join(f.base, "hook-spool"), { recursive: true, force: true });
});

test("0.15.0 drain discards (never misreads) a pending hook record staged with attribution", async () => {
  const f = fixture();
  await stageHookCapture("PostToolUse", { session_id: "s", agent_id: "a", tool_response: "new-format pending" }, f.options);
  const old = pathToFileURL(resolve(import.meta.dir, "../node_modules/@staix/agent-mem-v015/src/hook-spool.ts")).href;
  const script = `const { drainHookCaptures } = await import(${JSON.stringify(old)});
const appended = [];
const r = await drainHookCaptures({ cwd: ${JSON.stringify(f.cwd)}, base: ${JSON.stringify(f.base)}, project: ${JSON.stringify(f.project)} }, (input) => { appended.push(input); return { id: 1 }; });
console.log(JSON.stringify({ captured: r.captured.length, appended }));`;
  const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: f.cwd, env: { ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ captured: 0, appended: [] });
  // 0.15.0 retires an undecodable record by deleting it: the recorded compatibility rule (docs/contracts.md #173).
  expect((await drain(f)).length).toBe(0);
});
