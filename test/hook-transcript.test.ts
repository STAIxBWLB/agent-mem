import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scanHookTranscriptTail, transcriptSummary, HOOK_TRANSCRIPT_BYTES } from "../src/hook-transcript.ts";
import { drainHookCaptures, hookCaptureScope } from "../src/hook-spool.ts";
import * as spool from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { readCaptureDrops } from "../src/memory/metrics.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import * as policyModule from "../src/memory/policy.ts";
const realCreatePolicy = policyModule.createStandalonePolicy;

const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture() {
  const f = hookFixture(); fixtures.push(f);
  const transcript = join(f.root, "native-transcript.jsonl"), id = "native-session-identifier-201";
  writeFileSync(transcript, "", { mode: 0o600 });
  const input = { cwd: f.cwd, transcript_path: transcript, session_id: id };
  const scan = () => scanHookTranscriptTail(input, { cwd: f.cwd, base: f.base, deadline: performance.now() + 2000 });
  const add = (...rows: unknown[]) => appendFileSync(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const store = () => new CaptureStore({ memoryDir: f.base, project: f.project, cwd: f.cwd });
  const drain = async () => {
    const capture = store();
    try { await drainHookCaptures({ cwd: f.cwd, base: f.base, project: f.project, expectedScope: hookCaptureScope(f.cwd, f.base), timeRemaining: () => 2000 }, (row, receipt) => capture.append(row, { receipt })); return capture.readPage({ project: f.project, limit: 100 }).rows; }
    finally { capture.close(); }
  };
  return { ...f, transcript, id, input, scan, add, drain };
}
const at = new Date().toISOString();
const cursorFile = (f: ReturnType<typeof fixture>) => join(f.base, "hook-transcripts", createHash("sha256").update("amem-session\0" + f.id).digest("hex").slice(0, 16) + ".db");

test("an unchanged empty cursor commits without changing the database", async () => {
  const f = fixture();
  await f.scan();
  const file = cursorFile(f), observer = new Database(file, { readonly: true });
  try {
    const version = () => (observer.query("PRAGMA data_version").get() as { data_version: number }).data_version;
    const beforeVersion = version(), beforeBytes = readFileSync(file), before = observer.query("SELECT * FROM cursor").get();
    await f.scan(); await f.scan();
    expect(observer.query("SELECT * FROM cursor").get()).toEqual(before);
    expect(version()).toBe(beforeVersion);
    expect(readFileSync(file)).toEqual(beforeBytes);
  } finally { observer.close(); }
});

test("an incomplete appended line still checkpoints the changed size without advancing", async () => {
  const f = fixture(); await f.scan();
  appendFileSync(f.transcript, '{"type":"ai-title"');
  const result = await f.scan(), db = new Database(cursorFile(f), { readonly: true });
  try {
    expect(result?.offset).toBe(0);
    expect(db.query("SELECT offset,size,readStart FROM cursor").get()).toEqual({ offset: 0, size: Buffer.byteLength(readFileSync(f.transcript)), readStart: 0 });
  } finally { db.close(); }
});

test("a first-line untimed fallback commits even when publication backpressures without cursor progress", async () => {
  const f = fixture(); f.add({ type: "system", subtype: "away_summary", content: "untimed backpressure checkpoint" });
  await scanHookTranscriptTail(f.input, { cwd: f.cwd, base: f.base, deadline: performance.now() + 2000, workBudgetMs: 0 });
  const file = cursorFile(f), before = new Database(file, { readonly: true });
  let readAt: string;
  try { readAt = (before.query("SELECT readAt FROM cursor").get() as { readAt: string }).readAt; } finally { before.close(); }
  const full = spyOn(spool, "stageTranscriptCapture").mockImplementation(async () => { throw new spool.HookSpoolFull(); });
  try { expect(await f.scan()).toEqual({ offset: 0, stopReason: "spool_full" }); } finally { full.mockRestore(); }
  const db = new Database(file, { readonly: true });
  try {
    expect(db.query("SELECT offset FROM cursor").get()).toEqual({ offset: 0 });
    expect(db.query("SELECT at FROM fallback").all()).toEqual([{ at: readAt! }]);
  } finally { db.close(); }
  await f.scan();
  const rows = await f.drain();
  expect(rows).toHaveLength(1); expect(rows[0]?.at).toBe(readAt!);
});

test("publication before a rolled-back cursor retains the untimed receipt on resume and rotation", async () => {
  const f = fixture(), row = { type: "system", subtype: "away_summary", content: "untimed interrupted publication" };
  f.add(row);
  await expect(scanHookTranscriptTail(f.input, { cwd: f.cwd, base: f.base, deadline: performance.now() + 2000,
    onPublication: async () => { throw new Error("interrupt after durable publication"); } })).rejects.toThrow("interrupt after durable publication");
  const db = new Database(cursorFile(f), { readonly: true });
  try {
    expect(db.query("SELECT offset FROM cursor").get()).toEqual({ offset: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM fallback").get()).toEqual({ count: 0 });
  } finally { db.close(); }
  const first = await f.drain(); expect(first).toHaveLength(1);
  await f.scan(); expect(await f.drain()).toEqual(first);
  renameSync(f.transcript, f.transcript + ".old"); f.add(row); await f.scan();
  expect(await f.drain()).toEqual(first);
});

test("a schema-less cursor file left before initialization resumes with one valid cursor", async () => {
  const f = fixture(); await f.scan();
  writeFileSync(cursorFile(f), "", { mode: 0o600 });
  f.add({ type: "system", subtype: "away_summary", content: "after interrupted initialization", timestamp: at });
  await f.scan();
  const db = new Database(cursorFile(f), { readonly: true });
  try { expect(db.query("SELECT id,offset FROM cursor").all()).toEqual([{ id: 1, offset: Buffer.byteLength(readFileSync(f.transcript)) }]); }
  finally { db.close(); }
  expect((await f.drain()).map(row => row.excerpt)).toEqual(["after interrupted initialization"]);
});

test("the scanner recovers a killed cursor transaction before publishing an untimed summary", async () => {
  const f = fixture(); await f.scan();
  const file = cursorFile(f);
  const crash = join(f.root, "cursor-crash"); mkdirSync(crash, { mode: 0o700 });
  const crashFile = join(crash, "cursor.db"); copyFileSync(file, crashFile);
  writeFileSync(join(crash, "ffi-fixture-marker.json"), "{}", { mode: 0o600 });
  // A separate owned writer forces dirty pages out without committing. No production connection's settings change.
  const killed = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "fakes/cursor-crash.ts"), "--db", crashFile, "--out", crash],
    { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(killed.signalCode, killed.stderr.toString()).toBe("SIGKILL");
  expect(killed.stdout.toString()).toContain('"stage":"kill-ready"');
  expect(readFileSync(join(crash, "pre-kill.db"))).not.toEqual(readFileSync(join(crash, "seed-committed.db")));
  const journal = readFileSync(crashFile + "-journal");
  expect(journal.length).toBeGreaterThan(512);
  expect(journal.subarray(0, 8).toString("hex")).toBe("d9d505f920a163d7");
  // Place the unchanged killed DB/journal bytes at the session path; no SQLite open or journal repair precedes the scanner.
  renameSync(crashFile, file); renameSync(crashFile + "-journal", file + "-journal");
  f.add({ type: "system", subtype: "away_summary", content: "untimed after hot journal" });
  await f.scan();
  const db = new Database(file, { readonly: true });
  try {
    expect(db.query("SELECT offset FROM cursor").get()).toEqual({ offset: Buffer.byteLength(readFileSync(f.transcript)) });
    expect(db.query("SELECT COUNT(*) AS count FROM fallback").get()).toEqual({ count: 1001 });
    expect(db.query("SELECT COUNT(*) AS count FROM fallback WHERE at = ?").get("2026-11-04T00:00:00.000Z")).toEqual({ count: 1000 });
    expect(db.query("SELECT COUNT(*) AS count FROM fallback WHERE at = ?").get("2099-01-01T00:00:00.000Z")).toEqual({ count: 0 });
  } finally { db.close(); }
  const first = await f.drain(); expect(first).toHaveLength(1);
  await f.scan(); expect(await f.drain()).toEqual(first);
});

test("only native title, recap and compact fields are extracted", () => {
  expect(transcriptSummary('{"type":"assistant","content":"ordinary"}')).toBeUndefined();
  expect(transcriptSummary(JSON.stringify({ type: "user", isCompactSummary: true, timestamp: at, message: { content: [{ type: "text", text: "first" }, { type: "image" }, { type: "text", text: "next" }] } })))
    .toEqual({ event: "Compact", text: "first\nnext", at });
  expect(transcriptSummary(JSON.stringify({ type: "system", subtype: "away_summary", content: "state (disable recaps in /config)" }))).toEqual({ event: "Recap", text: "state" });
  expect(transcriptSummary(JSON.stringify({ type: "assistant", isCompactSummary: true, content: "wrong envelope" }))).toBeUndefined();
});

test("incremental summaries use native times, title predecessor, dedup and private attribution", async () => {
  const f = fixture();
  f.add({ type: "assistant", timestamp: at }, { type: "ai-title", aiTitle: "public title" }, { type: "ai-title", aiTitle: "public title" },
    { type: "system", subtype: "away_summary", timestamp: at, content: "recap state (disable recaps in /config)" },
    { type: "user", isCompactSummary: true, timestamp: at, message: { content: "compact next step" } });
  await f.scan(); await f.scan();
  const rows = await f.drain();
  expect(rows.map(row => row.event).sort()).toEqual(["Compact", "Recap", "Title"]);
  expect(rows.every(row => row.at === at && row.agent === "claude" && /^[a-f0-9]{16}$/.test(row.session!))).toBe(true);
  expect(rows.find(row => row.event === "Recap")?.excerpt).toBe("recap state");
  for (const name of readdirSync(join(f.base, "hook-transcripts"))) {
    const data = readFileSync(join(f.base, "hook-transcripts", name));
    expect(data.includes(Buffer.from(f.id))).toBe(false); expect(data.includes(Buffer.from(f.transcript))).toBe(false);
  }
  expect(JSON.stringify(rows)).not.toContain(f.id); expect(JSON.stringify(rows)).not.toContain(f.transcript);
  f.add({ type: "ai-title", aiTitle: "a changed title" }); await f.scan();
  expect((await f.drain()).filter(row => row.event === "Title")).toHaveLength(2);
});

test("rotation and truncation replays share content receipts", async () => {
  const f = fixture(), row = { type: "system", subtype: "away_summary", timestamp: at, content: "stable recap" };
  f.add(row); await f.scan(); expect(await f.drain()).toHaveLength(1);
  renameSync(f.transcript, f.transcript + ".old"); f.add(row); await f.scan(); expect(await f.drain()).toHaveLength(1);
  writeFileSync(f.transcript, ""); await f.scan(); f.add(row); await f.scan(); expect(await f.drain()).toHaveLength(1);
});

test("a deadline after one summary commits its prefix and resumes the remaining kinds", async () => {
  const f = fixture(), title = { type: "ai-title", aiTitle: "partial title", timestamp: at };
  f.add(title, { type: "system", subtype: "away_summary", content: "partial recap", timestamp: at },
    { type: "user", isCompactSummary: true, message: { content: "partial compact" }, timestamp: at });
  const options = { cwd: f.cwd, base: f.base, deadline: performance.now() + 2000 }, stage = spool.stageTranscriptCapture;
  const stopAfterFirst = spyOn(spool, "stageTranscriptCapture").mockImplementation(async (...args: Parameters<typeof stage>) => {
    const result = await stage(...args); options.deadline = -1; return result;
  });
  try {
    const progress = await scanHookTranscriptTail(f.input, options);
    expect(stopAfterFirst).toHaveBeenCalledTimes(1); expect(progress?.stopReason).toBe("deadline");
  }
  finally { stopAfterFirst.mockRestore(); }
  const file = readdirSync(join(f.base, "hook-transcripts")).find(name => name.endsWith(".db"))!;
  const db = new Database(join(f.base, "hook-transcripts", file), { readonly: true });
  try { expect((db.query("SELECT offset FROM cursor").get() as { offset: number }).offset).toBe(Buffer.byteLength(JSON.stringify(title) + "\n")); }
  finally { db.close(); }
  expect((await f.drain()).map(row => row.event)).toEqual(["Title"]);
  await f.scan(); await f.scan();
  expect((await f.drain()).map(row => row.event).sort()).toEqual(["Compact", "Recap", "Title"]);
});

test("a full spool reports its stop reason without advancing the unadmitted row", async () => {
  const f = fixture(); f.add({ type: "system", subtype: "away_summary", timestamp: at, content: "wait for capacity" });
  const full = spyOn(spool, "stageTranscriptCapture").mockImplementation(async () => { throw new spool.HookSpoolFull(); });
  try { expect(await f.scan()).toEqual({ offset: 0, stopReason: "spool_full" }); }
  finally { full.mockRestore(); }
  expect(await f.drain()).toHaveLength(0);
  await f.scan(); await f.scan(); expect(await f.drain()).toHaveLength(1);
});

test("full summary screens precede byte caps and private spans are removed", async () => {
  const f = fixture();
  f.add({ type: "system", subtype: "away_summary", timestamp: at, content: "public ".repeat(400) + " ghp_" + "A".repeat(36) },
    { type: "user", isCompactSummary: true, timestamp: at, message: { content: "visible <private>private-sentinel</private> " + "한".repeat(1000) } });
  await f.scan(); const rows = await f.drain();
  expect(rows).toHaveLength(1); expect(rows[0]?.event).toBe("Compact");
  expect(rows[0]?.excerpt).not.toContain("private-sentinel"); expect(Buffer.byteLength(rows[0]!.excerpt)).toBeLessThanOrEqual(2000);
});

test("an invocation stops at the byte ceiling and leaves an incomplete line for retry", async () => {
  const f = fixture(), ordinary = JSON.stringify({ type: "assistant", text: "x".repeat(1000) }) + "\n";
  appendFileSync(f.transcript, ordinary.repeat(Math.ceil(HOOK_TRANSCRIPT_BYTES / ordinary.length)));
  f.add({ type: "system", subtype: "away_summary", timestamp: at, content: "after bounded tail" });
  expect((await f.scan())?.stopReason).toBe("cap"); expect(await f.drain()).toHaveLength(0);
  await f.scan(); expect(await f.drain()).toHaveLength(1);
  appendFileSync(f.transcript, '{"type":"ai-title","aiTitle":"later title"'); await f.scan(); expect(await f.drain()).toHaveLength(1);
  appendFileSync(f.transcript, '}\n'); await f.scan(); expect(await f.drain()).toHaveLength(2);
});

test("an oversized single line is counted once and skipped through its newline across invocations", async () => {
  const f = fixture();
  f.add({ type: "system", subtype: "away_summary", timestamp: at, content: "x".repeat(HOOK_TRANSCRIPT_BYTES * 2 + 100) },
    { type: "system", subtype: "away_summary", timestamp: at, content: "public recap after oversized row" });
  await f.scan(); expect(await f.drain()).toHaveLength(0);
  await f.scan(); expect(await f.drain()).toHaveLength(0);
  await f.scan(); const rows = await f.drain();
  expect(rows).toHaveLength(1); expect(rows[0]?.excerpt).toBe("public recap after oversized row");
  const drops = readCaptureDrops(f.base);
  expect(drops.readable && drops.counts.transcript_line_bound).toBe(1);
});

test("missing identity, linked transcript and elapsed deadline never create a cursor", async () => {
  const f = fixture();
  await scanHookTranscriptTail({ ...f.input, session_id: undefined }, { cwd: f.cwd, base: f.base, deadline: performance.now() + 1000 });
  await scanHookTranscriptTail(f.input, { cwd: f.cwd, base: f.base, deadline: 0 });
  const link = f.transcript + ".link"; symlinkSync(f.transcript, link);
  await expect(scanHookTranscriptTail({ ...f.input, transcript_path: link }, { cwd: f.cwd, base: f.base, deadline: performance.now() + 1000 })).rejects.toThrow();
  expect(existsSync(join(f.base, "hook-transcripts"))).toBe(false);
});

for (const event of ["Stop", "SessionEnd"]) test(`the real ${event} handler scans and replays native summaries`, async () => {
  const f = fixture();
  f.add({ type: "system", subtype: "away_summary", timestamp: at, content: "native handler summary" });
  const result = f.runFunctional(event, { ...f.input, last_assistant_message: "ordinary final answer" });
  expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe("");
  const rows = await f.drain();
  expect(rows.filter(row => row.event === "Recap" && row.excerpt === "native handler summary")).toHaveLength(1);
  expect(rows.filter(row => row.event === event)).toHaveLength(1);
});

test("subagent summaries keep attribution and project policy refuses PII and denied text", async () => {
  const f = fixture();
  f.add({ type: "system", subtype: "away_summary", timestamp: at, content: "agent summary", isSidechain: true },
    { type: "system", subtype: "away_summary", timestamp: at, content: "person@example.org" },
    { type: "system", subtype: "away_summary", timestamp: at, content: "private metadata summary", isPrivate: true },
    { type: "system", subtype: "away_summary", timestamp: at, content: "read .env credentials" });
  await f.scan(); const rows = await f.drain();
  expect(rows).toHaveLength(1); expect(rows[0]?.subagent).toBe(true);
});

test("untimed content keeps its first fallback timestamp after rotation", async () => {
  const f = fixture(), row = { type: "system", subtype: "away_summary", content: "untimed recap" };
  f.add(row); await f.scan(); const first = await f.drain();
  renameSync(f.transcript, f.transcript + ".old"); f.add(row); await f.scan();
  expect(await f.drain()).toEqual(first);
});

test("title timestamp carry ignores nested timestamps in ordinary tool data", async () => {
  const f = fixture();
  f.add({ type: "assistant", message: { tool_input: { timestamp: "2000-01-01T00:00:00.000Z" } }, timestamp: at },
    { type: "ai-title", aiTitle: "correct predecessor time" });
  await f.scan(); expect((await f.drain())[0]?.at).toBe(at);
});

test("a parent alias cannot hide a configured denied transcript location", async () => {
  const f = fixture(), blocked = join(f.root, "restricted-transcripts"), alias = join(f.root, "public-alias");
  mkdirSync(blocked); symlinkSync(blocked, alias, "dir");
  writeFileSync(join(blocked, "native.jsonl"), JSON.stringify({ type: "system", subtype: "away_summary", timestamp: at, content: "denied origin recap" }) + "\n");
  await scanHookTranscriptTail({ ...f.input, transcript_path: join(alias, "native.jsonl") },
    { cwd: f.cwd, base: f.base, deadline: performance.now() + 2000, policy: { denyPaths: ["restricted-transcripts"] } });
  expect(existsSync(join(f.base, "hook-transcripts"))).toBe(false);
  expect(await f.drain()).toHaveLength(0);
});

test("a hook-spool floor refuses staging and leaves the transcript cursor untouched for a supported reader", async () => {
  const f = fixture();
  f.add({ type: "system", subtype: "away_summary", timestamp: at, content: "recap after reader upgrade" });
  mkdirSync(f.base, { recursive: true });
  const floor = join(f.base, "formats.json");
  writeFileSync(floor, JSON.stringify([{ surface: "hook-spool", minReader: "99.0.0", since: "2026-11-01" }]));
  await expect(f.scan()).rejects.toMatchObject({ code: "format_floor" });
  expect(existsSync(join(f.base, "hook-transcripts"))).toBe(false);
  const { stageTranscriptCapture } = await import("../src/hook-spool.ts");
  expect(await stageTranscriptCapture({ agent: "claude", event: "Recap", at, excerpt: "direct below-floor summary" }, { cwd: f.cwd, base: f.base })).toBeUndefined();
  writeFileSync(floor, "[]"); await f.scan();
  expect((await f.drain()).map(row => row.excerpt)).toEqual(["recap after reader upgrade"]);
});

test("untimed A-B-A title transitions survive and full-file rotation does not duplicate them", async () => {
  const f = fixture(), rows = ["A", "B", "A"].map(aiTitle => ({ type: "ai-title", aiTitle }));
  f.add(...rows); await f.scan();
  const before = await f.drain();
  expect(before.map(row => row.excerpt).sort()).toEqual(["A", "A", "B"]);
  renameSync(f.transcript, f.transcript + ".old"); f.add(...rows); await f.scan();
  expect(await f.drain()).toEqual(before);
  f.add({ type: "ai-title", aiTitle: "A" }); await f.scan();
  expect(await f.drain()).toHaveLength(3);
});

test("a 100-title burst backpressures at the cwd share and resumes losslessly behind its cursor (#217)", async () => {
  const f = fixture(), expected = Array.from({ length: 100 }, (_, i) => `share burst title ${i}`);
  f.add(...expected.map(aiTitle => ({ type: "ai-title", aiTitle, timestamp: at })));
  const first = await f.scan();
  expect(first?.stopReason).toBe("spool_full");
  expect(first?.offset).toBeGreaterThan(0); expect(first?.offset).toBeLessThan(Buffer.byteLength(readFileSync(f.transcript)));
  let rows = await f.drain();
  for (let pass = 0; pass < 5 && rows.length < expected.length; pass++) { await f.scan(); rows = await f.drain(); }
  expect(rows.map(row => row.excerpt).sort()).toEqual([...expected].sort());
  expect(new Set(rows.map(row => row.id)).size).toBe(100);
  const loss = readCaptureDrops(f.base);
  expect(loss.readable && (loss.counts.scope_capacity ?? 0)).toBe(0);
  expect(loss.readable && (loss.counts.summary_capacity ?? 0)).toBe(0);
});

test("task 110: slow setup does not eat the scan's work budget; the budget counts from the first line", async () => {
  // On a slow runner the final hook scanned a fixed 60 ms window that setup (policy, cursor database, read) had already spent,
  // so it staged nothing or only the first summary. With workBudgetMs the line loop gets its budget after setup, and the
  // hard deadline still ends it.
  const f = fixture();
  f.add({ type: "system", subtype: "away_summary", content: "budget recap", timestamp: at },
    { type: "user", isCompactSummary: true, message: { content: "budget compact" }, timestamp: at });
  // Only the scan's own setup call is slow (the first one); per-line staging builds its policy normally.
  let setupCalls = 0;
  const slow = spyOn(policyModule, "createStandalonePolicy").mockImplementation((...args: Parameters<typeof policyModule.createStandalonePolicy>) => {
    if (setupCalls++ === 0) { const until = performance.now() + 80; while (performance.now() < until) { /* setup slower than the 60 ms budget */ } }
    return realCreatePolicy(...args);
  });
  try {
    const started = performance.now();
    const progress = await scanHookTranscriptTail(f.input, { cwd: f.cwd, base: f.base, deadline: started + 2000, workBudgetMs: 60 });
    expect(progress?.stopReason).toBeUndefined();
  } finally { slow.mockRestore(); }
  expect((await f.drain()).map(row => row.event).sort()).toEqual(["Compact", "Recap"]);
  // Control: the old fixed window (deadline = start + 60) is spent by the same setup and stages nothing.
  const g = fixture();
  g.add({ type: "system", subtype: "away_summary", content: "fixed recap", timestamp: at });
  let setupCalls2 = 0;
  const slow2 = spyOn(policyModule, "createStandalonePolicy").mockImplementation((...args: Parameters<typeof policyModule.createStandalonePolicy>) => {
    if (setupCalls2++ === 0) { const until = performance.now() + 80; while (performance.now() < until) { /* same slow setup */ } }
    return realCreatePolicy(...args);
  });
  try { expect((await scanHookTranscriptTail(g.input, { cwd: g.cwd, base: g.base, deadline: performance.now() + 60 }))?.stopReason).toBe("deadline"); }
  finally { slow2.mockRestore(); }
  // A hard deadline still wins over the budget.
  const h = fixture(); h.add({ type: "system", subtype: "away_summary", content: "hard recap", timestamp: at });
  expect((await scanHookTranscriptTail(h.input, { cwd: h.cwd, base: h.base, deadline: performance.now() - 1, workBudgetMs: 60 }))?.stopReason).toBe("deadline");
});
