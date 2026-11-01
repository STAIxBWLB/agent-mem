import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanHookTranscriptTail, transcriptSummary, HOOK_TRANSCRIPT_BYTES } from "../src/hook-transcript.ts";
import { drainHookCaptures, hookCaptureScope } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { readCaptureDrops } from "../src/memory/metrics.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

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
  await f.scan(); expect(await f.drain()).toHaveLength(0);
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
