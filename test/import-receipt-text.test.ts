import {afterEach,expect,test} from "bun:test";
import {Database as ImportReceiptDatabase} from "bun:sqlite";
import * as importReceiptFs from "node:fs";
import {mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runCli} from "../src/cli.ts";
import {claudeMemImportText} from "../src/memory/commands.ts";
import {PLAIN,style} from "../src/memory/style.ts";
import {realPath} from "../src/memory/platform.ts";
import {memoryProjectKey as importReceiptProjectKey,projectChain as importReceiptProjectChain} from "../src/memory/project.ts";
import {appendAlias as importReceiptAppendAlias} from "../src/memory/shard.ts";
const ANSI=/\x1b\[/,COLOR=style(true),WIDTH=160;
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0))fn();});
const strip=(text:string)=>text.replace(/\x1b\[\d+m/g,"");
function home(){const root=realPath(mkdtempSync(join(tmpdir(),"amem-import-receipt-")));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const cwd=join(root,"repo");mkdirSync(cwd);return{root,cwd,memory:join(root,"memory")};}

const importNotes = (more = false) => ({ read: 6, added: 2, skipped: { model: 1, pii: 1, secret: 1 }, more, cursor: 6 });
const importWork = (more = false) => ({ read: 5, added: 1, skipped: { invalid: 1, policy: 1 }, more, cursor: 5 });
const importCapture = (more = false) => ({ read: 4, added: 1, spooled: 1, skipped: 2, more });

test("claude-mem import receipt labels every counter and only reported skip reasons", () => {
  for (const s of [PLAIN, COLOR]) {
    const output = claudeMemImportText(importNotes(), importWork(), importCapture(), { captureDays: 7 }, s);
    const plain = strip(output);
    expect(plain).toStartWith("amem import claude-mem: complete\n");
    expect(plain).toMatch(/^OK +notes: read 6, added 2, skipped 4, spooled n\/a$/m);
    expect(plain).toContain("model 1, PII 1, secret 1, empty/malformed/already imported 1");
    expect(plain).toMatch(/^OK +work lists: read 5, added 1, skipped 4, spooled n\/a$/m);
    expect(plain).toContain("invalid 1, policy 1, already imported 2");
    expect(plain).toMatch(/^ATTENTION +capture: read 4, added 1, skipped 2, spooled 1$/m);
    expect(plain).toContain("combined 2 (empty/invalid, policy or already imported; no breakdown reported)");
    expect(plain).toContain("Next action: 1 capture row was spooled while busy; the next capture write (hook event or import adding capture rows) replays them.");
    const action = plain.split("\n").find(line => line.startsWith("Next action:"))!;
    expect(action).not.toContain("re-run"); expect(action).not.toContain("run this import");
    expect(plain).not.toContain("amem doctor");
    expect(plain).not.toContain('{"'); expect(plain).not.toContain("cursor");
    for (const line of plain.split("\n")) expect(line.length).toBeLessThanOrEqual(WIDTH);
  }
  expect(claudeMemImportText(importNotes(), importWork(), importCapture(), {}, COLOR)).toMatch(ANSI);
  const pending = claudeMemImportText(importNotes(), importWork(), importCapture(true));
  expect(pending).toContain("Next action: run the same import command again");
  expect(pending).not.toContain("amem doctor");
});

test.each(["notes", "work", "capture"] as const)("claude-mem overall verdict includes %s more even with zero added", flag => {
  const notes = { ...importNotes(flag === "notes"), read: 1, added: 0, skipped: { model: 1, pii: 0, secret: 0 } };
  const work = { ...importWork(flag === "work"), read: 1, added: 0, skipped: { invalid: 1, policy: 0 } };
  const capture = { ...importCapture(flag === "capture"), read: 1, added: 0, spooled: 0, skipped: 1 };
  const output = claudeMemImportText(notes, work, capture);
  expect(output).toStartWith("amem import claude-mem: run again\n");
  expect(output).toContain("Next action: run the same import command again");
  expect(output.match(/amem import claude-mem:/g)).toHaveLength(1);
});

test.each(["notes", "work", "capture"] as const)("claude-mem %s restart pagination tells the person to remove only restart", flag => {
  const notes = importNotes(flag === "notes"), work = importWork(flag === "work"), capture = importCapture(flag === "capture");
  const output = claudeMemImportText(notes, work, capture, { restart: true, captureDays: 7 });
  expect(output).toStartWith("amem import claude-mem: run again\n");
  expect(output).toContain("Next action: run the same import command again without --restart, keeping all other arguments, until all receipts are complete.");
  const ordinary = claudeMemImportText(notes, work, capture, { captureDays: 7 });
  expect(ordinary).toContain("Next action: run the same import command again until all receipts are complete.");
  expect(ordinary).not.toContain("without --restart");
});

test("claude-mem capture selection and restart caveats are explicit", () => {
  const notes = { ...importNotes(), read: 0, added: 0, skipped: { model: 0, pii: 0, secret: 0 } };
  const work = { ...importWork(), read: 0, added: 0, skipped: { invalid: 0, policy: 0 } };
  const none = claudeMemImportText(notes, work);
  expect(none).toMatch(/^SKIPPED +capture: not requested/m);
  expect(none).toContain("read 0, added 0, skipped 0"); expect(none).not.toContain("Widening");
  const selected = claudeMemImportText(notes, work, { read: 0, added: 0, skipped: 0, spooled: 0, more: false }, { captureDays: 14, restart: true });
  expect(selected).toContain("Capture window: last 14 days. Widening --capture-days later requires --restart.");
  expect(selected).toContain("Restart: selected cursors replayed from the start");
});

function importReceiptFixture(kind: "empty" | "work" | "capture" | "secret" = "empty") {
  const h = home(), file = join(h.root, "claude-mem.db"), db = new ImportReceiptDatabase(file), source = importReceiptProjectChain(h.cwd).at(-1)!;
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  db.run("CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)");
  db.run("CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, project TEXT, request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, created_at_epoch INTEGER)");
  if (kind === "work") db.query("INSERT INTO work_state_entries VALUES (1, ?, 'synthetic list', ?, ?)").run(source, JSON.stringify({ status: "doing" }), Date.now());
  if (kind === "capture" || kind === "secret") db.query("INSERT INTO observations VALUES (1, ?, 'fixture', ?, NULL, ?, ?)").run(source,
    kind === "secret" ? "password: synthetic-fixture" : "synthetic capture observation", Date.now(), kind === "secret" ? JSON.stringify({ peer: "codex", kind: "finding" }) : null);
  db.close();
  importReceiptAppendAlias(h.memory, { alias: source, key: importReceiptProjectKey(h.cwd), actor: "person", machine: "fixture" });
  return { ...h, file };
}

async function runImportReceipt(h: { cwd: string; memory: string; file: string }, args: string[] = [], env: Record<string, string | undefined> = {}, stdoutTTY = false, stdinTTY = true) {
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = h.memory;
  try { return await runCli(["import", "claude-mem", "--db", h.file, ...args], { cwd: h.cwd, env, stdoutTTY, stdinTTY }); }
  finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}

test.each(["work", "capture"] as const)("claude-mem CLI follows %s-only pagination and then completes", async kind => {
  const h = importReceiptFixture(kind), before = importReceiptFs.readFileSync(h.file), args = ["--limit", "1", ...(kind === "capture" ? ["--capture-days", "7"] : [])];
  const first = await runImportReceipt(h, [...args, "--restart"]);
  expect(first).toStartWith("amem import claude-mem: run again\n");
  expect(first).toMatch(kind === "work" ? /^ATTENTION +work lists: read 1, added 1/m : /^ATTENTION +capture: read 1, added 1/m);
  expect(first).toMatch(/^OK +notes: read 0, added 0/m);
  expect(first).toContain("without --restart, keeping all other arguments");
  if (kind === "capture") expect(first).toContain("Widening --capture-days later requires --restart.");
  expect(await runImportReceipt(h, args)).toStartWith("amem import claude-mem: complete\n");
  expect(importReceiptFs.readFileSync(h.file)).toEqual(before);
});

test("claude-mem CLI styles honor TTY and suppression while JSON keeps exact bytes", async () => {
  const h = importReceiptFixture(), captureArgs = ["--capture-days", "7"];
  expect(await runImportReceipt(h, captureArgs, {}, true)).toMatch(ANSI);
  const plain = await runImportReceipt(h, captureArgs);
  expect(plain).not.toMatch(ANSI);
  for (const env of [{ NO_COLOR: "" }, { TERM: "dumb" }]) expect(await runImportReceipt(h, captureArgs, env, true)).toBe(plain);
  const notes = { read: 0, added: 0, skipped: { model: 0, pii: 0, secret: 0 }, more: false, cursor: 0 };
  const work = { read: 0, added: 0, skipped: { invalid: 0, policy: 0 }, more: false, cursor: 0 };
  const capture = { read: 0, added: 0, spooled: 0, skipped: 0, more: false };
  for (const includeCapture of [false, true]) {
    const expected = JSON.stringify({ ...notes, work, ...(includeCapture ? { capture } : {}) }, null, 2);
    for (const env of [{}, { NO_COLOR: "" }, { TERM: "dumb" }]) {
      const output = await runImportReceipt(h, ["--json", ...(includeCapture ? captureArgs : [])], env, true);
      expect(output).toBe(expected); expect(output).not.toMatch(ANSI);
    }
  }
});

test("claude-mem human receipt keeps policy screening and person/TTY gates", async () => {
  const h = importReceiptFixture("secret"), output = await runImportReceipt(h, ["--capture-days", "7"]);
  expect(output).toStartWith("amem import claude-mem: complete\n");
  expect(output).toContain("secret 1"); expect(output).toContain("combined 1");
  expect(output).not.toContain("synthetic-fixture");
  const blank = { ...home(), file: "/must-not-read.db" };
  await expect(runImportReceipt(blank, [], { CODEX_THREAD_ID: "agent" }, true)).rejects.toThrow(/amem is for the person/);
  await expect(runImportReceipt(blank, [], {}, false, false)).rejects.toThrow(/terminal/);
  expect(importReceiptFs.existsSync(blank.memory)).toBe(false);
});
