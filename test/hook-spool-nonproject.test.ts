import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { HookSpoolFull, stageHookCapture, stageTranscriptCapture } from "../src/hook-spool.ts";
import { readCaptureDrops } from "../src/memory/metrics.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

// #385: captures recorded while the agent's cwd is a non-project (no .git) directory.
// Route A: a later hook of the same session at a repository cwd attributes them to that project.
// Route B: a row with no session, or one no same-session project hook attributed within one hour, retires as nonproject_unattributed.
const fixtures: ReturnType<typeof hookFixture>[] = [], originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) f.close();
});
function setup() {
  const f = hookFixture(); fixtures.push(f); process.env.HOME = f.env.HOME;
  const scratch = join(f.root, "scratch"); mkdirSync(scratch); // Not inside any git repository.
  return { f, scratch };
}
function pending(base: string): { file: string; cwd: string; event: string }[] {
  const dir = join(base, "hook-spool");
  return [dir, join(dir, ".capacity")].flatMap(folder => (existsSync(folder) ? readdirSync(folder) : [])
    .filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))
    .map(name => { const file = join(folder, name), record = JSON.parse(readFileSync(file, "utf8")) as { cwd: string; capture: { event: string } }; return { file, cwd: record.cwd, event: record.capture.event }; }));
}
function drops(base: string, reason: string): number {
  const read = readCaptureDrops(base); if (!read.readable) throw new Error("drops unreadable");
  return (read.counts as Record<string, number>)[reason] ?? 0;
}
const excerpts = (f: ReturnType<typeof hookFixture>) => f.rows().map(row => (row as { excerpt?: string }).excerpt ?? "");

test("#385 AC1/route A: a same-session summary from a non-project cwd reaches the project's rows from the next project hook", async () => {
  const { f, scratch } = setup(), excerpt = "nonproject summary 385";
  // hooks-fixture sends session_id "p3-fixture"; the transcript reader stores its captureSessionKey.
  const { captureSessionKey } = await import("../src/memory/capture-input.ts");
  expect(await stageTranscriptCapture({ agent: "claude", event: "Title", at: new Date().toISOString(), excerpt, session: captureSessionKey("p3-fixture") }, { cwd: scratch, base: f.base })).toBeDefined();
  const result = f.runFunctional("UserPromptSubmit", { prompt: "continue" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(pending(f.base).filter(row => row.cwd === scratch)).toEqual([]);
  expect(excerpts(f).some(text => text.includes(excerpt))).toBe(true);
}, 20000);

test("#385 route A: another session's non-project rows are never attributed", async () => {
  const { f, scratch } = setup(), excerpt = "other session summary";
  const { captureSessionKey } = await import("../src/memory/capture-input.ts");
  await stageTranscriptCapture({ agent: "claude", event: "Title", at: new Date().toISOString(), excerpt, session: captureSessionKey("someone-else") }, { cwd: scratch, base: f.base });
  expect(f.runFunctional("UserPromptSubmit", { prompt: "continue" }).exitCode).toBe(0);
  expect(pending(f.base).filter(row => row.cwd === scratch).map(row => row.event)).toEqual(["Title"]);
  expect(excerpts(f).some(text => text.includes(excerpt))).toBe(false);
}, 20000);

test("#385 route B: a non-project row without a session, and one unattributed for an hour, retire with a counted reason", async () => {
  const { f, scratch } = setup();
  const { captureSessionKey } = await import("../src/memory/capture-input.ts");
  await stageTranscriptCapture({ agent: "claude", event: "Title", at: new Date().toISOString(), excerpt: "no session" }, { cwd: scratch, base: f.base });
  const old = new Date(Date.now() - 2 * 3600_000);
  await stageTranscriptCapture({ agent: "claude", event: "Recap", at: old.toISOString(), excerpt: "stale session", session: captureSessionKey("gone") }, { cwd: scratch, base: f.base });
  // Publishing the Recap already ran maintenance, which retires the session-less Title at once (route B, no age wait).
  for (const row of pending(f.base)) utimesSync(row.file, old, old);
  // Any later publication runs bounded maintenance; this one is an ordinary project tool event.
  await stageHookCapture("PostToolUse", { session_id: "p3-fixture", hook_event_name: "PostToolUse", cwd: f.cwd, tool_name: "Read", tool_input: {}, tool_response: "ok" }, { cwd: f.cwd, base: f.base });
  expect(pending(f.base).filter(row => row.cwd === scratch)).toEqual([]);
  expect(drops(f.base, "nonproject_unattributed")).toBe(2);
}, 20000);

test("#385 AC3: non-project rows filling the spool cannot cause HookSpoolFull for a project's summary", async () => {
  const { f } = setup();
  const { captureSessionKey } = await import("../src/memory/capture-input.ts");
  // Four non-project cwds at their full 64-file share fill the 256-file spool with fresh, same-session-attributable rows.
  for (let d = 0; d < 4; d++) {
    const cwd = join(f.root, `scratch-${d}`); mkdirSync(cwd);
    for (let i = 0; i < 64; i++) await stageTranscriptCapture({ agent: "claude", event: "Title", at: new Date().toISOString(), excerpt: `fill ${d}-${i}`, session: captureSessionKey("busy") }, { cwd, base: f.base });
  }
  expect(pending(f.base)).toHaveLength(256);
  const staged = await stageTranscriptCapture({ agent: "claude", event: "Title", at: new Date().toISOString(), excerpt: "project summary" }, { cwd: f.cwd, base: f.base });
  expect(staged).toBeDefined();
  expect(pending(f.base).filter(row => row.cwd === f.cwd).map(row => row.event)).toEqual(["Title"]);
  expect(drops(f.base, "nonproject_unattributed")).toBeGreaterThan(0);
  // A non-project cwd's own summary still refuses at the cap rather than evicting.
  const extra = join(f.root, "scratch-extra"); mkdirSync(extra);
  for (let i = 0; i < 300 && pending(f.base).length < 256; i++) await stageTranscriptCapture({ agent: "claude", event: "Title", at: new Date().toISOString(), excerpt: `refill ${i}`, session: captureSessionKey("busy") }, { cwd: join(f.root, `scratch-${i % 4}`), base: f.base }).catch(() => undefined);
  await expect(stageTranscriptCapture({ agent: "claude", event: "Title", at: new Date().toISOString(), excerpt: "orphan", session: captureSessionKey("busy") }, { cwd: extra, base: f.base })).rejects.toBeInstanceOf(HookSpoolFull);
}, 60000);
