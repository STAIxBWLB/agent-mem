import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drainHookCaptures, hookCapturePending, hookCaptureScope, quarantineHookScope, stageHookCapture } from "../src/hook-spool.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { normalizeCaptureFields, type NormalizedCaptureFields } from "../src/memory/capture-input.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookRecoveryDiagnostic } from "./fakes/hooks-recovery-diagnostic.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [], originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) f.close();
});
function fixture(remote?: string) {
  const f = hookFixture(remote); fixtures.push(f); process.env.HOME = f.env.HOME;
  const options = { cwd: f.cwd, base: f.base };
  return { ...f, options,
    age(days: number) {
      const dir = join(f.base, "hook-spool");
      for (const name of readdirSync(dir).filter(name => /^hook-.*\.json$/.test(name))) {
        const file = join(dir, name), row = JSON.parse(readFileSync(file, "utf8")), at = new Date(Date.now() - days * 24 * 3600_000); row.capture.at = at.toISOString(); writeFileSync(file, JSON.stringify(row)); utimesSync(file, at, at);
      }
    },
    pending() {
      const dir = join(f.base, "hook-spool");
      return [dir, join(dir, ".capacity")].flatMap(folder => existsSync(folder) ? readdirSync(folder)
        .filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))
        .map(name => ({ name, value: JSON.parse(readFileSync(join(folder, name), "utf8")) })) : []);
    },
  };
}

/** Published N-1 homes may already exceed the new cooperative per-cwd share. Seed valid
 * immutable publications directly so admission does not evict the backlog being tested. */
async function legacyBacklog(options: { cwd: string; base: string }, prompts: string[], input: Record<string, unknown> = {}, maximumBytes = Infinity): Promise<number> {
  const staged = await stageHookCapture("PostToolUse", { ...input, prompt: prompts[0] }, options);
  expect(staged).toBeDefined();
  const dir = join(options.base, "hook-spool"), source = join(dir, staged!.name);
  const template = JSON.parse(readFileSync(source, "utf8")) as { nonce: string; capture: NormalizedCaptureFields };
  rmSync(source);
  let bytes = 0, count = 0;
  for (const prompt of prompts) {
    const { tool, status, ...fields } = template.capture;
    const capture = normalizeCaptureFields({ ...fields, excerpt: prompt, ...(tool === null ? {} : { tool }), ...(status === null ? {} : { status }) });
    const nonce = count.toString(16).padStart(32, "0"), body = JSON.stringify({ ...template, nonce, capture });
    if (bytes + Buffer.byteLength(body) > maximumBytes) break;
    writeFileSync(join(dir, staged!.name.replace(/[a-f0-9]{32}\.json$/, nonce + ".json")), body, { mode: 0o600, flag: "wx" });
    bytes += Buffer.byteLength(body); count++;
  }
  return count;
}
const capacityDrops = (base: string) => readMetrics(base).filter(row => row.captureDropReason === "scope_capacity").reduce((sum, row) => sum + (row.captureDrops ?? 0), 0);

test("pending hook stages contain bounded normalized capture fields, never the raw native envelope", async () => {
  const f = fixture();
  const staged = await stageHookCapture("PreToolUse", { cwd: f.cwd, hook_event_name: "PreToolUse", prompt: "public retained excerpt", metadata: { rawEnvelopeMarker: "RAW_ENVELOPE_NOT_CAPTURED" }, tool_name: "Read", tool_input: { file_path: "src/public.ts", command: "SEARCHABLE_COMMAND" } }, f.options);
  expect(staged).toBeDefined(); expect(hookCapturePending(f.base, staged!.name)).toBe(true);
  const rows = f.pending(); expect(rows).toHaveLength(1);
  expect(rows[0]!.value.capture).toMatchObject({ agent: "claude", event: "PreToolUse", tool: "Read", paths: ["src/public.ts"], status: "ok", excerpt: "SEARCHABLE_COMMAND | src/public.ts\npublic retained excerpt" });
  expect(Number.isFinite(Date.parse(rows[0]!.value.capture.at))).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("RAW_ENVELOPE_NOT_CAPTURED"); expect(JSON.stringify(rows)).toContain("SEARCHABLE_COMMAND");
  expect(rows[0]!.value).not.toHaveProperty("input"); expect(rows[0]!.value).not.toHaveProperty("tool_input");
});

test("complete-input private flags and secret metadata are refused before any pending stage", async () => {
  const f = fixture();
  for (const input of [{ private: true }, { metadata: { pii: true } }, { tool_input: { private: true } }, { metadata: { api_key: "sk-" + "synthetic".repeat(9) } }]) {
    expect(await stageHookCapture("PostToolUse", { ...input, cwd: f.cwd, prompt: "must not persist" }, f.options)).toBeUndefined();
  }
  expect(f.pending()).toEqual([]); expect(existsSync(join(f.base, "hook-spool"))).toBe(false);
});

test("PostToolUseFailure stages and drains the actual error excerpt with failed status", async () => {
  const f = fixture(), error = { message: "synthetic public tool failure", exit_code: 7 };
  const staged = await stageHookCapture("PostToolUseFailure", { cwd: f.cwd, hook_event_name: "PostToolUseFailure", error, tool_response: "must not replace error", prompt: "must not replace error either" }, f.options);
  expect(staged).toBeDefined(); expect(f.pending()[0]!.value.capture).toMatchObject({ status: "failed", excerpt: JSON.stringify(error) });
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    const result = await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }));
    expect(result.captured).toEqual([staged!.name]);
    expect(store.rows()).toHaveLength(1); expect(store.rows()[0]).toMatchObject({ project: f.project, event: "PostToolUseFailure", status: "failed", excerpt: JSON.stringify(error) });
  } finally { store.close(); }
});

test("a committed capture with lost acknowledgement retries its stable receipt exactly once", async () => {
  const f = fixture(), staged = await stageHookCapture("PostToolUse", { cwd: f.cwd, prompt: "durable exactly-once marker" }, f.options);
  expect(staged).toBeDefined(); const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    let committed = false;
    const first = await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => {
      store.append(input, { receipt }); committed = true; throw new Error("lost acknowledgement fixture");
    });
    expect(committed).toBe(true); expect(first.captured).toEqual([]); expect(first.blocked).toBe(1);
    expect(store.rows()).toHaveLength(1); expect(hookCapturePending(f.base, staged!.name)).toBe(true);
    const next = await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }));
    expect(next.captured).toEqual([staged!.name]); expect(store.rows()).toHaveLength(1);
    expect(hookCapturePending(f.base, staged!.name)).toBe(false);
    expect((await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }))).captured).toEqual([]);
    expect(store.rows()).toHaveLength(1);
  } finally { store.close(); }
});

test("foreign cwd and changed physical cwd cannot attach a retained event to a new project", async () => {
  const f = fixture(), foreign = join(f.root, "foreign"); mkdirSync(foreign);
  expect(await stageHookCapture("PostToolUse", { cwd: foreign, prompt: "foreign" }, f.options)).toBeUndefined();
  const staged = await stageHookCapture("PostToolUse", { cwd: f.cwd, prompt: "original cwd marker" }, f.options); expect(staged).toBeDefined();
  renameSync(f.cwd, join(f.root, "old-project")); mkdirSync(f.cwd);
  let appended = false;
  const result = await drainHookCaptures({ ...f.options, project: "foreign/project" }, () => { appended = true; return { id: 1 }; });
  expect(result.captured).toEqual([]); expect(appended).toBe(false); expect(hookCapturePending(f.base, staged!.name)).toBe(true);
});

test("changed Git control scope stays pending instead of attaching to the newly resolved project", async () => {
  const f = fixture(), config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
  const staged = await stageHookCapture("PostToolUse", { cwd: f.cwd, prompt: "original scope marker" }, f.options); expect(staged).toBeDefined();
  appendFileSync(config, '\n[remote "origin"]\n url = https://example.invalid/foreign/project.git\n');
  let appended = false;
  const result = await drainHookCaptures({ ...f.options, project: "example.invalid/foreign/project" }, () => { appended = true; return { id: 1 }; });
  expect(result.captured).toEqual([]); expect(appended).toBe(false); expect(hookCapturePending(f.base, staged!.name)).toBe(true);
  writeFileSync(config, original);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    expect((await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }))).captured).toEqual([staged!.name]);
    expect(store.rows()).toHaveLength(1); expect(store.rows()[0]!.project).toBe(f.project);
  } finally { store.close(); }
});

test("an N-1 backlog at the exact pending-file cap drains one bounded batch without admission loss", async () => {
  const f = fixture();
  expect(await legacyBacklog(f.options, Array.from({ length: 256 }, (_, i) => `bounded pending ${i}`))).toBe(256);
  const result = await drainHookCaptures({ ...f.options, project: f.project }, () => ({ id: 1 }));
  expect(result.captured).toHaveLength(32); expect(f.pending()).toHaveLength(224);
  expect(capacityDrops(f.base)).toBe(0);
});

for (const [event, share] of [["PostToolUse", 64], ["SessionStart", 8]] as const) test(`fair-share admission keeps ${share} ${event} rows and counts the displaced oldest row`, async () => {
  const f = fixture();
  for (let i = 0; i <= share; i++) {
    const staged = await stageHookCapture(event, { prompt: `share ${i}` }, f.options);
    expect(staged).toBeDefined();
    if (i === 0) {
      const older = new Date(Date.now() - 10_000);
      utimesSync(join(f.base, "hook-spool", ...(event === "SessionStart" ? [".capacity"] : []), staged!.name), older, older);
    }
  }
  expect(f.pending()).toHaveLength(share);
  expect(f.pending().some(row => row.value.capture.excerpt === "share 0")).toBe(false);
  expect(f.pending().some(row => row.value.capture.excerpt === `share ${share}`)).toBe(true);
  expect(f.pending().length + capacityDrops(f.base)).toBe(share + 1);
  expect(capacityDrops(f.base)).toBe(1);
});

test("a failed loss receipt cannot evict a replayable row under fair-share pressure", async () => {
  const f = fixture();
  for (let i = 0; i < 64; i++) await stageHookCapture("PostToolUse", { prompt: `receipt-protected ${i}` }, f.options);
  const before = f.pending().map(row => JSON.stringify(row.value)).sort();
  mkdirSync(join(f.base, "metrics.jsonl"));
  await expect(stageHookCapture("PostToolUse", { prompt: "not acknowledged" }, f.options)).rejects.toThrow("hook storage full");
  // Claims may be renamed, but every original byte-bearing record remains recoverable.
  expect(f.pending().map(row => JSON.stringify(row.value)).sort()).toEqual(before);
  rmSync(join(f.base, "metrics.jsonl"), { recursive: true });
  expect(await stageHookCapture("PostToolUse", { prompt: "receipt restored" }, f.options)).toBeDefined();
  expect(f.pending().length + capacityDrops(f.base)).toBe(65);
  expect(f.pending().filter(row => row.value.capture.excerpt === "receipt restored")).toHaveLength(1);
});

for (const outcome of ["ENOENT", "ENOTDIR"] as const) test("one-hour orphan retirement requires positive cwd absence, not another path error: " + outcome, async () => {
  const f = fixture(), parent = join(f.cwd, "nested"), cwd = join(parent, "orphan");
  mkdirSync(cwd, { recursive: true });
  await stageHookCapture("PostToolUse", { prompt: "own cwd evidence" }, { ...f.options, cwd });
  f.age(2 / 24);
  rmSync(parent, { recursive: true });
  if (outcome === "ENOTDIR") writeFileSync(parent, "a file is not evidence that the nested cwd was deleted");
  expect(await stageHookCapture("PostToolUse", { prompt: "healthy admission" }, f.options)).toBeDefined();
  const lost = readMetrics(f.base).filter(row => row.captureDropReason === "cwd_removed").reduce((sum, row) => sum + (row.captureDrops ?? 0), 0);
  expect(lost).toBe(outcome === "ENOENT" ? 1 : 0);
  expect(f.pending().filter(row => row.value.cwd === cwd)).toHaveLength(outcome === "ENOENT" ? 0 : 1);
});

test("an already expired hook deadline still publishes durable capture before optional work", async () => {
  const f = fixture();
  const { runHook } = await import("../src/hooks.ts");
  const receipt = await runHook("PostToolUse", { prompt: "expired deadline retained" }, { ...f.options, startedAt: performance.now() - 1000 });
  expect(receipt).toMatchObject({ captured: false, pending: true });
  const pending = f.pending();
  expect(pending).toHaveLength(1); expect(pending[0]!.value.capture.excerpt).toBe("expired deadline retained");
  expect(f.rows()).toHaveLength(0);
});


for (const event of ["PostToolUse", "SessionStart"] as const) test(`functional ${event} retains a full-tier event and accounts for replay or pressure retirement within 24 following invocations`, async () => {
  const f = fixture();
  const accepted = Array.from({ length: 256 }, (_, i) => `backlog ${i}`);
  expect(await legacyBacklog(f.options, accepted)).toBe(256);
  accepted.push("full queue follow-up");
  const probe = hookRecoveryDiagnostic(f.root);
  const result = f.runFunctional(event, { prompt: "full queue follow-up" }, probe);
  expect(result.exitCode).toBe(0);
  const traces = [result.stderr.toString()];
  const codes = traces[0]!.trim().split("\n").map(line => JSON.parse(line) as number[]);
  expect(codes.every(row => Array.isArray(row) && row.every(Number.isFinite)), traces[0]).toBe(true);
  expect(codes.some(row => row[0] === 25), traces[0]).toBe(event !== "SessionStart");
  expect(codes.some(row => row[0] === 27), traces[0]).toBe(true);
  let rows = f.rows(), pending = f.pending();
  const retained = rows.filter(row => row.excerpt === accepted.at(-1)), held = pending.filter(row => row.value.capture.excerpt === accepted.at(-1));
  expect(Math.max(retained.length, held.length), traces.join("\n")).toBe(1);
  if (retained.length && held.length) expect(retained[0]!.at).toBe(held[0]!.value.capture.at);
  // 256 ordinary slots remain bounded; only already-screened native intake uses the separate 32-slot reserve.
  expect(readdirSync(join(f.base, "hook-spool")).filter(name => /^hook-/.test(name)).length).toBeLessThanOrEqual(256);
  expect(pending.length).toBeLessThanOrEqual(288);
  let following = 0;
  for (let invocation = 0; invocation < 24 && pending.length > 0; invocation++) {
    const next = f.runFunctional("PostToolUse", { prompt: `replay barrier ${invocation}` }, probe);
    traces.push(next.stderr.toString()); expect(next.exitCode).toBe(0);
    following++;
    rows = f.rows(); pending = f.pending();
  }
  expect(pending, traces.join("\n")).toHaveLength(0);
  expect(rows.length + capacityDrops(f.base), traces.join("\n")).toBe(accepted.length + following);
  expect(new Set(rows.map(row => row.excerpt)).size).toBe(rows.length);
  expect(rows.filter(row => row.excerpt === "full queue follow-up")).toHaveLength(1);
});

test("an expired full-tier hook still retains its next event in the bounded native reserve", async () => {
  const f = fixture();
  expect(await legacyBacklog(f.options, Array.from({ length: 256 }, (_, i) => `expired backlog ${i}`))).toBe(256);
  const { runHook } = await import("../src/hooks.ts");
  const result = await runHook("PostToolUse", { prompt: "expired full-tier current" }, { ...f.options, startedAt: performance.now() - 1000 });
  expect(result).toMatchObject({ captured: false, pending: true });
  expect(f.pending().filter(row => row.value.capture.excerpt === "expired full-tier current")).toHaveLength(1);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    const noTime = await drainHookCaptures({ ...f.options, project: f.project, timeRemaining: () => 0 }, (input, receipt) => store.append(input, { receipt }));
    expect(noTime.captured).toHaveLength(0);
    // The same bounded replay consumes reserve plus backlog; constant 8ms proves progress at the threshold.
    for (let invocation = 0; invocation < 9 && f.pending().length > 0; invocation++) {
      const next = await drainHookCaptures({ ...f.options, project: f.project, timeRemaining: () => 8 }, (input, receipt) => store.append(input, { receipt }));
      expect(next.captured.length).toBeGreaterThan(0);
    }
    expect(store.rows().length + capacityDrops(f.base)).toBe(257); expect(f.pending()).toHaveLength(0);
    expect(capacityDrops(f.base)).toBe(32);
    expect(store.rows().filter(row => row.excerpt === "expired full-tier current")).toHaveLength(1);
    expect((await drainHookCaptures({ ...f.options, project: f.project, timeRemaining: () => 8 }, (input, receipt) => store.append(input, { receipt }))).captured).toHaveLength(0);
  } finally { store.close(); }
});

test("a project resolution stamp cannot admit newer stages after an origin changes", async () => {
  const f = fixture(), expectedScope = hookCaptureScope(f.cwd, f.base);
  expect(expectedScope).toBeDefined();
  appendFileSync(join(f.cwd, ".git", "config"), '\n[remote "origin"]\n url = https://example.invalid/new/project.git\n');
  const pending = await stageHookCapture("PostToolUse", { prompt: "new scope only" }, f.options);
  expect(pending).toBeDefined(); expect(hookCaptureScope(f.cwd, f.base)).not.toBe(expectedScope);
  let appended = false;
  const result = await drainHookCaptures({ ...f.options, project: f.project, expectedScope }, () => { appended = true; return { id: 1 }; });
  expect(result.captured).toEqual([]); expect(appended).toBe(false); expect(hookCapturePending(f.base, pending!.name)).toBe(true);
});

function git(f: ReturnType<typeof fixture>, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", f.cwd, ...args], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

test("checkout and return preserve a pending event's semantic project scope", async () => {
  const f = fixture();
  git(f, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "initial");
  const branch = git(f, "symbolic-ref", "--short", "HEAD");
  const staged = await stageHookCapture("PostToolUse", { prompt: "checkout roundtrip marker" }, f.options);
  expect(staged).toBeDefined();
  const scope = hookCaptureScope(f.cwd, f.base);
  git(f, "checkout", "--quiet", "-b", "temporary-scope-branch");
  git(f, "checkout", "--quiet", branch);
  expect(hookCaptureScope(f.cwd, f.base)).toBe(scope);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    expect((await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }))).captured).toEqual([staged!.name]);
    expect(store.rows().map(row => row.excerpt)).toEqual(["checkout roundtrip marker"]);
  } finally { store.close(); }
});

test("rewriting config with the same origin and unrelated settings does not strand pending capture", async () => {
  const f = fixture("https://example.invalid/team/semantic.git"), config = join(f.cwd, ".git", "config");
  const staged = await stageHookCapture("PostToolUse", { prompt: "same origin rewrite marker" }, f.options);
  expect(staged).toBeDefined();
  const scope = hookCaptureScope(f.cwd, f.base), original = readFileSync(config, "utf8");
  writeFileSync(config + ".replacement", original + '\n# cosmetic rewrite\n[user]\n name = Different Fixture\n');
  renameSync(config + ".replacement", config);
  expect(hookCaptureScope(f.cwd, f.base)).toBe(scope);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    expect((await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }))).captured).toEqual([staged!.name]);
    expect(store.rows().map(row => row.excerpt)).toEqual(["same origin rewrite marker"]);
  } finally { store.close(); }
});

test("removed cwd records retire with a count and cannot become a replacement project's capture", async () => {
  const f = fixture(), removed = join(f.cwd, "removed-worktree"); mkdirSync(removed);
  const staged = await stageHookCapture("PostToolUse", { cwd: removed, prompt: "removed cwd private canary" }, { ...f.options, cwd: removed });
  expect(staged).toBeDefined(); f.age(8); rmSync(removed, { recursive: true });
  expect(await stageHookCapture("PostToolUse", { prompt: "healthy current marker" }, f.options)).toBeDefined();
  expect(f.pending().some(row => row.value.cwd === removed)).toBe(false);
  expect(existsSync(join(f.base, "hook-spool", ".quarantine"))).toBe(false);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }));
    expect(store.rows().map(row => row.excerpt)).toEqual(["healthy current marker"]);
    expect(hookCapturePending(f.base, staged!.name)).toBe(false);
    expect(readMetrics(f.base).filter(row => row.captureDropReason === "cwd_removed").reduce((n,row) => n + (row.captureDrops ?? 0), 0)).toBe(1);
  } finally { store.close(); }
});

test("256 orphaned cwd records cannot disable actual hooks in another healthy cwd", async () => {
  const f = fixture(), removed = join(f.cwd, "orphaned-worktree"); mkdirSync(removed);
  expect(await legacyBacklog({ ...f.options, cwd: removed }, Array.from({ length: 256 }, (_, index) => `orphan canary ${index}`))).toBe(256);
  expect(f.pending()).toHaveLength(256);
  f.age(8);
  rmSync(removed, { recursive: true });
  const first = f.runFunctional("PostToolUse", { prompt: "healthy after orphan cap" });
  expect(first.exitCode).toBe(0);
  for (let pass = 0; pass < 4 && !f.rows().some(row => row.excerpt === "healthy after orphan cap"); pass++) {
    expect(f.runFunctional("PostToolUse", { prompt: `healthy recovery barrier ${pass}` }).exitCode).toBe(0);
  }
  expect(f.rows().filter(row => row.excerpt === "healthy after orphan cap")).toHaveLength(1);
  expect(f.rows().some(row => row.excerpt.startsWith("orphan canary"))).toBe(false);
  const retained = f.pending().filter(row => row.value.cwd === removed).length;
  const counted = readMetrics(f.base).filter(row => row.captureDropReason === "cwd_removed").reduce((n,row) => n + (row.captureDrops ?? 0), 0);
  expect(retained + counted).toBe(256); expect(counted).toBeGreaterThan(0);
  expect(existsSync(join(f.base, "hook-spool", ".quarantine"))).toBe(false);
}, 20000);

test("oldest pending records progress when each drain deadline permits only one append", async () => {
  const f = fixture();
  const older = await stageHookCapture("PostToolUse", { prompt: "oldest pending" }, f.options);
  expect(older).toBeDefined();
  utimesSync(join(f.base, "hook-spool", older!.name), new Date(0), new Date(0));
  const newer = await stageHookCapture("PostToolUse", { prompt: "newer current" }, f.options);
  expect(newer).toBeDefined();
  const appended: string[] = [];
  const first = await drainHookCaptures({ ...f.options, project: f.project, current: newer!.name, timeRemaining: () => appended.length ? 0 : 50 }, input => {
    appended.push(input.excerpt!); return { id: appended.length };
  });
  expect(first.captured).toEqual([older!.name]); expect(appended).toEqual(["oldest pending"]);
  expect(hookCapturePending(f.base, newer!.name)).toBe(true);
  utimesSync(join(f.base, "hook-spool", newer!.name), new Date(1000), new Date(1000));
  const latest = await stageHookCapture("PostToolUse", { prompt: "another current" }, f.options);
  const second: string[] = [];
  await drainHookCaptures({ ...f.options, project: f.project, current: latest!.name, timeRemaining: () => second.length ? 0 : 50 }, input => {
    second.push(input.excerpt!); return { id: 1 };
  });
  expect(second).toEqual(["newer current"]);
});

test("malformed and oversized publications age out without retaining raw bodies in quarantine", async () => {
  const f = fixture();
  for (const body of ["not JSON RAW_MALFORMED_CANARY", JSON.stringify({ schema: "unsupported", text: "RAW_UNKNOWN_SCHEMA_CANARY" }), "RAW_OVERSIZE_CANARY".repeat(20000)]) {
    const staged = await stageHookCapture("PostToolUse", { prompt: "replace only this fixture publication" }, f.options);
    expect(staged).toBeDefined();
    writeFileSync(join(f.base, "hook-spool", staged!.name), body);
    const healthy = await stageHookCapture("PostToolUse", { prompt: "healthy admission" }, f.options);
    expect(healthy).toBeDefined(); expect(hookCapturePending(f.base, staged!.name)).toBe(false);
    const quarantine = join(f.base, "hook-spool", ".quarantine");
    if (existsSync(quarantine)) for (const name of readdirSync(quarantine)) {
      expect(readFileSync(join(quarantine, name), "utf8")).not.toContain("RAW_");
    }
  }
});

test("resolved records denied by current policy retire outside the active queue", async () => {
  const f = fixture(), staged = await stageHookCapture("PostToolUse", { prompt: "denied-later-canary" }, f.options);
  expect(staged).toBeDefined();
  let appended = false;
  const result = await drainHookCaptures({ ...f.options, project: f.project, policy: { piiPatterns: ["denied-later-canary"] } }, () => { appended = true; return { id: 1 }; });
  expect(result.captured).toEqual([]); expect(result.blocked).toBe(1); expect(appended).toBe(false);
  expect(f.pending()).toEqual([]);
  const quarantine = join(f.base, "hook-spool", ".quarantine");
  expect(readdirSync(quarantine)).toHaveLength(1);
  expect(readFileSync(join(quarantine, readdirSync(quarantine)[0]!), "utf8")).not.toContain("denied-later-canary");
  expect(hookCapturePending(f.base, staged!.name)).toBe(true);
});

test("policy retirement never removes a foreign replacement of its unique claim", async () => {
  const f = fixture();
  await stageHookCapture("PostToolUse", { prompt: "owned before replacement" }, f.options);
  let replacement = "", replaced = false;
  const body = JSON.stringify({ foreignReplacement: true });
  const result = await drainHookCaptures({ ...f.options, project: f.project, policy: { host: { screen: async () => {
    if (!replaced) {
      replaced = true;
      const name = readdirSync(join(f.base, "hook-spool")).find(name => name.includes(".draining-"))!;
      replacement = join(f.base, "hook-spool", name);
      renameSync(replacement, replacement + ".original-fixture");
      writeFileSync(replacement, body);
    }
    return false;
  } } } }, () => { throw new Error("denied row must not append"); });
  expect(replaced).toBe(true); expect(result.captured).toEqual([]);
  expect(readFileSync(replacement, "utf8")).toBe(body);
});

test("valid quoted alias and user escapes do not alter the project scope", async () => {
  const f = fixture("https://example.invalid/team/escaped-alias.git"), config = join(f.cwd, ".git", "config");
  const staged = await stageHookCapture("PostToolUse", { prompt: "unrelated escaped config marker" }, f.options);
  expect(staged).toBeDefined();
  const scope = hookCaptureScope(f.cwd, f.base), original = readFileSync(config, "utf8");
  appendFileSync(config, '\n[alias]\n fixture = "!printf \\"stable\\\\n\\""\n[user]\n name = "Fixture\\tName"\n');
  git(f, "config", "--get", "alias.fixture");
  expect(hookCaptureScope(f.cwd, f.base)).toBe(scope);
  writeFileSync(config + ".replacement", original + '\n[alias]\n fixture = "!printf \\"changed\\\\n\\""\n[user]\n name = "Other\\tFixture"\n');
  renameSync(config + ".replacement", config);
  git(f, "config", "--get", "alias.fixture");
  expect(hookCaptureScope(f.cwd, f.base)).toBe(scope);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    expect((await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }))).captured).toEqual([staged!.name]);
    expect(store.rows().map(row => row.excerpt)).toEqual(["unrelated escaped config marker"]);
  } finally { store.close(); }
});

test("invalid syntax in an unused Git value leaves project scope unknown", () => {
  const f = fixture(), config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
  for (const value of ['"unterminated', '"bad\\q"']) {
    writeFileSync(config, original + `\n[alias]\n broken = ${value}\n`);
    const native = Bun.spawnSync(["git", "-C", f.cwd, "config", "--get", "alias.broken"], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(native.exitCode).not.toBe(0);
    expect(hookCaptureScope(f.cwd, f.base)).toBeUndefined();
  }
});


test("the semantic stamp follows Git precedence when both global files decide the worktree", async () => {
  const f = fixture(), xdg = join(f.env.HOME!, ".config"), oldXdg = process.env.XDG_CONFIG_HOME,
    oldGlobal = process.env.GIT_CONFIG_GLOBAL, oldSystem = process.env.GIT_CONFIG_SYSTEM;
  mkdirSync(join(xdg, "git"), { recursive: true });
  const a = join(f.root, "worktree-A"), b = join(f.root, "worktree-B"), c = join(f.root, "worktree-C");
  for (const dir of [a, b, c]) mkdirSync(dir);
  writeFileSync(join(xdg, "git", "config"), `[core]\n worktree = ${b}\n`);
  writeFileSync(join(f.env.HOME!, ".gitconfig"), `[core]\n worktree = ${a}\n`);
  process.env.XDG_CONFIG_HOME = xdg; delete process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  try {
    const keyA = memoryProjectKey(f.cwd, { repositoryIsolation: true }), stampA = hookCaptureScope(f.cwd, f.base);
    expect(keyA.startsWith("worktree-A@")).toBe(true); expect(stampA).toBeDefined();
    const pending = await stageHookCapture("PostToolUse", { prompt: "old global worktree marker" }, f.options);
    expect(pending).toBeDefined();
    writeFileSync(join(f.env.HOME!, ".gitconfig"), `[core]\n worktree = ${c}\n`);
    const keyC = memoryProjectKey(f.cwd, { repositoryIsolation: true });
    expect(keyC.startsWith("worktree-C@")).toBe(true); expect(keyC).not.toBe(keyA);
    expect(hookCaptureScope(f.cwd, f.base)).not.toBe(stampA);
    let appended = false;
    expect((await drainHookCaptures({ ...f.options, project: keyC }, () => { appended = true; return { id: 1 }; })).captured).toEqual([]);
    expect(appended).toBe(false);
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
    if (oldSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = oldSystem;
  }
});

test("identical home config bytes do not erase HOME-dependent project scope", async () => {
  const f = fixture(), otherHome = join(f.root, "other-home"); mkdirSync(otherHome);
  const config = "[core]\n worktree = ~/same-relative-root\n";
  writeFileSync(join(f.env.HOME!, ".gitconfig"), config);
  writeFileSync(join(otherHome, ".gitconfig"), config);
  const scope = hookCaptureScope(f.cwd, f.base); expect(scope).toBeDefined();
  const staged = await stageHookCapture("PostToolUse", { prompt: "HOME-bound marker" }, f.options); expect(staged).toBeDefined();
  process.env.HOME = otherHome;
  expect(hookCaptureScope(f.cwd, f.base)).not.toBe(scope);
  let appended = false;
  expect((await drainHookCaptures({ ...f.options, project: f.project, expectedScope: scope }, () => { appended = true; return { id: 1 }; })).captured).toEqual([]);
  expect(appended).toBe(false);
  process.env.HOME = f.env.HOME;
  expect(hookCaptureScope(f.cwd, f.base)).toBe(scope);
});

test("native-resolution maintenance removes malformed records and retains every valid pending row", async () => {
  const f = fixture();
  for (let index = 0; index < 40; index++) await stageHookCapture("PostToolUse", { prompt: `native-failure marker ${index}` }, f.options);
  const scope = hookCaptureScope(f.cwd, f.base); expect(scope).toBeDefined();
  const original = f.pending(); expect(original).toHaveLength(40);
  writeFileSync(join(f.base, "hook-spool", original[0]!.name), "RAW_INVALID_RETIREMENT_CANARY");
  utimesSync(join(f.base, "hook-spool", original[0]!.name), new Date(0), new Date(0));
  const result = quarantineHookScope({ ...f.options, scope: scope! });
  expect(result.retired).toBe(1); expect(f.pending()).toHaveLength(39);
  expect(f.rows()).toEqual([]);
  expect(existsSync(join(f.base, "hook-spool", ".quarantine"))).toBe(false);
});

for (const event of ["PostToolUse", "Stop"] as const) test("parent native failure retires malformed publication but retains valid pending: " + event, async () => {
  const f = fixture("https://github.com/fixture/quarantine-parent"), config = join(f.cwd, ".git", "config"), original = readFileSync(config, "utf8");
  const scope = hookCaptureScope(f.cwd, f.base), valid = await stageHookCapture("PostToolUse", { prompt: "valid native-refusal pending" }, f.options);
  const broken = await stageHookCapture("PostToolUse", { prompt: "replaced malformed publication" }, f.options);
  expect(scope).toBeDefined(); expect(valid).toBeDefined(); expect(broken).toBeDefined();
  const preload = join(f.root, "malform-after-admission.ts"), entered = join(f.root, "malform-entered"), transcript = join(f.root, "transcript.jsonl");
  const invalidBody = "RAW_MALFORMED_PUBLICATION_CANARY";
  writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';
globalThis.__malformPublication=()=>{writeFileSync(${JSON.stringify(join(f.base, "hook-spool", broken!.name))},${JSON.stringify(invalidBody)});writeFileSync(${JSON.stringify(entered)},'entered');};
Bun.plugin({name:'malform-after-admission',setup(b){b.onLoad({filter:/[/]hook-project\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='  const reads = new Map<string, ReturnType<ProjectGitRead>>();';
 if(source.split(anchor).length!==2)throw Error('native resolver entry anchor changed');
 return {loader:'ts',contents:source.replace(anchor,'  (globalThis as any).__malformPublication();'+anchor)};
});}});`);
  appendFileSync(config, "\n[core]\nrepositoryformatversion = 999\n");
  expect(hookCaptureScope(f.cwd, f.base)).toBe(scope);
  // An ordinary transcript exercises the worker without another summary publication
  // whose admission maintenance could retire the malformed fixture independently.
  writeFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), content: "ordinary transcript" }) + "\n");
  const result = f.runFunctional(event, { prompt: "current unresolved capture", ...(event === "Stop" ? { transcript_path: transcript } : {}) }, { BUN_OPTIONS: `--preload=${preload}` });
  expect(result.exitCode, result.stderr.toString()).toBe(0); expect(readFileSync(entered, "utf8")).toBe("entered");
  expect(hookCapturePending(f.base, broken!.name)).toBe(false);
  expect(hookCapturePending(f.base, valid!.name)).toBe(true);
  expect(f.pending().filter(row => row.value.capture.excerpt === "valid native-refusal pending")).toHaveLength(1);
  expect(f.rows()).toHaveLength(0);
  writeFileSync(config, original);
  expect(f.runFunctional("PostToolUse", { prompt: "healthy quarantine recovery" }).exitCode).toBe(0);
  expect(f.rows().filter(row => row.excerpt === "valid native-refusal pending")).toHaveLength(1);
  expect(f.rows().some(row => row.excerpt === "replaced malformed publication")).toBe(false);
  expect(hookCapturePending(f.base, valid!.name)).toBe(false);
});

test("native-failure malformed maintenance respects a raised hook-spool floor", async () => {
  const f = fixture(), staged = await stageHookCapture("PostToolUse", { prompt: "below-floor malformed fixture" }, f.options), scope = hookCaptureScope(f.cwd, f.base)!;
  expect(staged).toBeDefined();
  writeFileSync(join(f.base, "hook-spool", staged!.name), "RAW_BELOW_FLOOR_CANARY");
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "hook-spool", minReader: "99.0.0", since: "2026-11-01" }]));
  expect(quarantineHookScope({ ...f.options, scope }).retired).toBe(0);
  expect(readFileSync(join(f.base, "hook-spool", staged!.name), "utf8")).toBe("RAW_BELOW_FLOOR_CANARY");
});

test("native fatal Git resolution retains pending for retry and never uses a local fallback", async () => {
  const f = fixture("https://github.com/fixture/native-fatal"), config = join(f.cwd, ".git", "config");
  const original = readFileSync(config, "utf8"), scope = hookCaptureScope(f.cwd, f.base);
  const staged = await stageHookCapture("PostToolUse", { cwd: f.cwd, prompt: "remote-bound pending" }, f.options);
  expect(staged).toBeDefined();
  appendFileSync(config, "\n[core]\nrepositoryformatversion = 999\n");
  expect(hookCaptureScope(f.cwd, f.base)).toBe(scope);
  for (let i = 0; i < 3 && f.pending().length; i++) expect(f.runFunctional("PostToolUse", { prompt: "fatal admission" }).exitCode).toBe(0);
  expect(f.pending()).toHaveLength(4);
  expect(f.pending().filter(row => row.value.capture.excerpt === "remote-bound pending")).toHaveLength(1);
  expect(existsSync(join(f.base, "hook-spool", ".quarantine"))).toBe(false);
  expect(f.rows()).toHaveLength(0);
  const fallback = memoryProjectKey(f.cwd, { repositoryIsolation: true });
  const store = new CaptureStore({ memoryDir: f.base, project: fallback });
  try { expect(store.rows({ project: fallback })).toHaveLength(0); } finally { store.close(); }
  writeFileSync(config, original);
  for (let i = 0; i < 4 && !f.rows().some(row => row.excerpt === "healthy recovery"); i++) expect(f.runFunctional("PostToolUse", { prompt: i === 0 ? "healthy recovery" : "replay barrier" }).exitCode).toBe(0);
  expect(f.rows().filter(row => row.excerpt === "healthy recovery")).toHaveLength(1);
  expect(f.rows().filter(row => row.excerpt === "remote-bound pending")).toHaveLength(1);
});

test("a full tier from another valid project retains this SessionStart and returns its known work", async () => {
  const a = fixture(), b = fixture();
  process.env.HOME = a.env.HOME;
  await a.seed();
  const foreign = { cwd: b.cwd, base: a.base };
  expect(await legacyBacklog(foreign, Array.from({ length: 256 }, (_, i) => `foreign valid ${i}`))).toBe(256);
  for (let i = 0; i < 6; i++) {
    const marker = `local full-tier ${i}`;
    const result = a.runFunctional("SessionStart", { prompt: marker });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext).toContain("p3-work-marker");
    expect(a.rows().filter(row => row.excerpt === marker).length + a.pending().filter(row => row.value.capture.excerpt === marker).length).toBe(1);
  }
  expect(a.rows().some(row => row.excerpt.startsWith("foreign valid"))).toBe(false);
  expect(a.pending().filter(row => row.value.cwd === b.cwd)).toHaveLength(256);
  expect(existsSync(join(a.base, "hook-spool", ".quarantine"))).toBe(false);
});

test("SessionStart reserves its own slot without retiring valid foreign records", async () => {
  const a = fixture(), b = fixture(); process.env.HOME = a.env.HOME;
  expect(await legacyBacklog({ cwd: b.cwd, base: a.base }, Array.from({ length: 256 }, (_, i) => `minimum foreign ${i}`))).toBe(256);
  const staged = await stageHookCapture("SessionStart", { prompt: "one reserved brief slot" }, { ...a.options, deferAtCapacity: true });
  expect(staged).toBeDefined();
  expect(a.pending().filter(row => row.value.cwd === b.cwd)).toHaveLength(256);
  expect(a.pending().filter(row => row.value.capture.excerpt === "one reserved brief slot")).toHaveLength(1);
  expect(existsSync(join(a.base, "hook-spool", ".quarantine"))).toBe(false);
});

test("young missing cwd records stay pending across SessionStart and ordinary admission", async () => {
  const a = fixture(), b = fixture(); process.env.HOME = a.env.HOME;
  await stageHookCapture("PostToolUse", { prompt: "deferred foreign orphan" }, { cwd: b.cwd, base: a.base });
  rmSync(b.cwd, { recursive: true, force: true });
  expect(await stageHookCapture("SessionStart", { prompt: "brief first" }, a.options)).toBeDefined();
  expect(a.pending().filter(row => row.value.capture.excerpt === "deferred foreign orphan")).toHaveLength(1);
  expect(await stageHookCapture("PostToolUse", { prompt: "ordinary retirement boundary" }, a.options)).toBeDefined();
  expect(a.pending().filter(row => row.value.capture.excerpt === "deferred foreign orphan")).toHaveLength(1);
  expect(existsSync(join(a.base, "hook-spool", ".quarantine"))).toBe(false);
});

test("SessionStart byte exhaustion uses its reserve without erasing foreign records", async () => {
  const a = fixture(), b = fixture(); process.env.HOME = a.env.HOME;
  const foreign = { cwd: b.cwd, base: a.base };
  const input = { prompt: "b".repeat(2000), tool_input: { paths: Array.from({ length: 32 }, (_, i) => `src/${i}-${"p".repeat(370)}`) } };
  const staged = await legacyBacklog(foreign, Array.from({ length: 256 }, () => input.prompt), input, 2 * 1024 * 1024);
  expect(staged).toBeGreaterThan(0); expect(staged).toBeLessThan(256);
  const payload = { prompt: "current byte-bound event", tool_input: { paths: Array.from({ length: 32 }, (_, i) => `src/${i}-${"가".repeat(350)}`) } };
  await expect(stageHookCapture("SessionStart", payload, { ...a.options, deferAtCapacity: true })).resolves.toBeDefined();
  expect(a.pending().filter(row => row.value.capture.excerpt === "current byte-bound event")).toHaveLength(1);
  expect(existsSync(join(a.base, "hook-spool", ".quarantine"))).toBe(false);
});
