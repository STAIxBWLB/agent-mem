import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORK_BRIEF_BYTES, readWorkBrief, workBriefFile } from "../src/brief-work.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { machineId } from "../src/memory/machine.ts";
import { processSignature } from "../src/memory/platform.ts";
import { shardDir, shardMachineDir } from "../src/memory/shard.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { sessionStartBrief } from "../src/session-brief.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ROWS = 5_000;

/** A work log large enough that its replay cannot finish in the brief's work slice, seeded as the store itself would append. */
async function fixture(rows = ROWS) {
  const root = mkdtempSync(join(tmpdir(), "amem-brief-work-")); roots.push(root);
  const base = join(root, "memory"), project = "work-project", machine = machineId(base).id;
  const directory = join(shardDir(base, project), "work", "log");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lines = Array.from({ length: rows }, (_, i) => {
    const body = { schema: "agent-mem.work-list/v1", project, machine, at: 1_700_000_000_000 + i,
      nonce: (i + 1).toString(16).padStart(32, "0"), list: i === rows - 1 ? "focus" : "queue",
      fields: i === rows - 1 ? { task: "review-cache", status: "doing" } : { task: "ship-snapshot", status: "doing" } };
    return canonicalJSON({ ...body, id: hashJSON(body) });
  });
  const log = join(directory, `${machine}.jsonl`);
  writeFileSync(log, lines.join("\n") + "\n", { mode: 0o600 });
  const store = new WorkListStore({ base, project, policy: () => true });
  await store.read(undefined, true);
  await store.publishBrief();
  store.close();
  const options = { cwd: root, base, project, nativeSession: { signature: processSignature(process.pid)! }, timeRemaining: () => 11 };
  return { root, base, project, machine, log, options, file: workBriefFile({ base, project, machine }) };
}

/** A home with one live store, plus the native and library brief options over it. */
function home(project: string) {
  const root = mkdtempSync(join(tmpdir(), "amem-brief-work-home-")); roots.push(root);
  const base = join(root, "memory"), machine = machineId(base).id;
  const store = new WorkListStore({ base, project, policy: () => true });
  const options = { cwd: root, base, project, nativeSession: { signature: processSignature(process.pid)! }, timeRemaining: () => 2000 };
  const live = { cwd: root, base, project, timeRemaining: () => 2000 };
  return { root, base, project, machine, store, options, live };
}

test("the incremental fold matches a full rebuild of the same log", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-brief-work-fold-")); roots.push(root);
  const base = join(root, "memory"), project = "fold-project", machine = machineId(base).id;
  const binding = { base, project, machine };
  const options = { cwd: root, base, project, nativeSession: { signature: processSignature(process.pid)! }, timeRemaining: () => 2000 };
  const store = new WorkListStore({ base, project, policy: () => true });
  try {
    await store.write("queue", { task: "second", status: "doing", note: "first" });
    await store.write("queue", { task: "second", note: null });                                  // a null clears the field
    await store.write("queue", { task: "first", status: "todo" });                               // a new item sorts ahead
    await store.write("queue", { status: "doing", owner: "fixture" });                           // a list-level field
    await store.write("archive", { status: "done" });                                            // a closed list is kept
    const foldedRun = await sessionStartBrief(options), folded = readWorkBrief(binding)!;
    await store.publishBrief();                                                                  // the full replay
    const rebuiltRun = await sessionStartBrief(options), rebuilt = readWorkBrief(binding)!;
    expect(rebuiltRun.context).toBe(foldedRun.context);
    expect(rebuilt.rows).toEqual(folded.rows);
    expect(rebuilt.truncated).toBe(false);
  } finally { store.close(); }
});

test("the native work section comes from the snapshot while the work index cannot be opened", async () => {
  const f = await fixture();
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  writeFileSync(join(shardDir(f.base, f.project), "work", "index.db"), "invalid sqlite, native must not open it");
  const library = await sessionStartBrief({ cwd: f.root, base: f.base, project: f.project, timeRemaining: () => 11 });
  expect(library.coverage.work).toBe("unavailable");
  const native = await sessionStartBrief(f.options);
  expect(native.coverage.work).toBe("complete");
  expect(native.context).toContain('"section":"work"');
  expect(native.context).toContain("ship-snapshot");
  expect(native.tokens).toBeLessThanOrEqual(1200);
});

test("a later work-log append makes the snapshot stale, never wrong, without rewriting it", async () => {
  const f = await fixture(50), before = readFileSync(f.file);
  const last = JSON.parse(readFileSync(f.log, "utf8").trimEnd().split("\n").at(-1)!) as { id: string; [key: string]: unknown };
  const { id: _id, ...body } = last;
  const next = { ...body, at: Number(body.at) + 1, nonce: "f".repeat(32) };
  appendFileSync(f.log, canonicalJSON({ ...next, id: hashJSON(next) }) + "\n");
  const result = await sessionStartBrief(f.options);
  expect(result.coverage.work).toBe("unavailable");
  expect(result.context).toContain("work: work cache stale");
  expect(readFileSync(f.file)).toEqual(before);
});

test("a home policy configuration change invalidates the snapshot", async () => {
  const f = await fixture(50), before = readFileSync(f.file);
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["internal-marker"] }));
  const result = await sessionStartBrief(f.options);
  expect(result.coverage.work).toBe("unavailable");
  expect(readFileSync(f.file)).toEqual(before);
});

for (const mode of ["missing", "public", "oversize", "symlink", "malformed", "foreign"] as const) test(`work snapshot ${mode} is unavailable without repairing it`, async () => {
  const f = await fixture(20), file = f.file;
  if (mode === "missing") rmSync(file);
  if (mode === "public") chmodSync(file, 0o644);
  if (mode === "oversize") writeFileSync(file, "x".repeat(WORK_BRIEF_BYTES + 1));
  if (mode === "malformed") writeFileSync(file, "{bad");
  if (mode === "foreign") { const brief = JSON.parse(readFileSync(file, "utf8")); brief.project = "foreign"; writeFileSync(file, JSON.stringify(brief)); }
  if (mode === "symlink") { const target = file + ".target"; writeFileSync(target, readFileSync(file)); rmSync(file); symlinkSync(target, file); }
  const directory = shardMachineDir(f.base, f.project, f.machine);
  const listing = readdirSync(directory).sort(), bytes = mode === "missing" ? undefined : readFileSync(file);
  const result = await sessionStartBrief(f.options);
  expect(result.coverage.work).toBe("unavailable");
  expect(result.context).toContain("work: work cache missing");
  expect(readdirSync(directory).sort()).toEqual(listing);
  if (bytes) expect(readFileSync(file)).toEqual(bytes);
});

test("a list whose done items sort first still shows its open item", async () => {
  const h = home("done-first");
  try {
    for (let i = 1; i <= 40; i++) await h.store.write("queue", { task: `task-${String(i).padStart(2, "0")}`, status: "done" });
    await h.store.write("queue", { task: "task-41", status: "doing" });
    const native = await sessionStartBrief(h.options), live = await sessionStartBrief(h.live);
    const view = readWorkBrief({ base: h.base, project: h.project, machine: h.machine })!.rows[0]!.source;
    expect(view.items).toHaveLength(41);                                                        // every item, so the open one cannot be cut away
    expect(native.coverage.work).toBe("complete");
    expect(native.context).toContain("task-41");
    expect(native.context).not.toContain("task-01");                                            // the display still shows two open items at most
    const section = (context: string) => context.split("\n").find(line => line.includes('"section":"work"'));
    expect(section(native.context)).toBe(section(live.context));                                // the snapshot display is the live read's
  } finally { h.store.close(); }
});

test("a composed set past the file bound is never published as a subset", async () => {
  const h = home("oversize-views");
  try {
    for (let i = 0; i < 300; i++) await h.store.write("bulk", { task: `item-${String(i).padStart(3, "0")}`, note: "x".repeat(60) });
    const result = await sessionStartBrief(h.options), file = workBriefFile({ base: h.base, project: h.project, machine: h.machine });
    expect(statSync(file).size).toBeLessThanOrEqual(WORK_BRIEF_BYTES);
    expect(result.coverage.work).toBe("unavailable");                                           // stale, not a truncated view that reads complete
    expect(result.context).toContain("work: work cache stale");
    expect(result.context).not.toContain("item-");
  } finally { h.store.close(); }
});

test("a publish overlapping another same-machine writer never records a frontier ahead of its rows", async () => {
  const h = home("interleave");
  const other = new WorkListStore({ base: h.base, project: h.project, policy: () => true });
  try {
    await h.store.write("queue", { task: "zero", status: "done" });                              // a published file this write can fold onto
    const publish = h.store.publishBrief.bind(h.store);
    other.publishBrief = async () => { /* the second writer appends and then exits before publishing */ };
    h.store.publishBrief = async (row, prior, appended) => { await other.write("queue", { task: "second", status: "doing" }); await publish(row, prior, appended); };
    await h.store.write("queue", { task: "first", status: "doing" });
    const result = await sessionStartBrief(h.options);
    if (result.coverage.work !== "complete") { expect(result.context).toContain("work: work cache"); return; }
    expect(result.context).toContain("first");
    expect(result.context).toContain("second");   // the recorded frontier covers both rows or the file is stale, never one claim for two rows
  } finally { other.close(); h.store.close(); }
});
