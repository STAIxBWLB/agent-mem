import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { readBriefCache } from "../src/brief-cache.ts";
import { stageHookCapture, stageTranscriptCapture } from "../src/hook-spool.ts";
import { applyHookSpoolReplay, claimFor, parseReplayPlan, planHookSpoolReplay, type HookSpoolReplayPlan } from "../src/hook-spool-replay.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { appendLifecycle } from "../src/memory/lifecycle.ts";
import { createHash } from "node:crypto";
import { runCli } from "../src/cli.ts";

// #217 PR2: fixture homes only. These tests never read or write a live or parked spool.
const clean: (() => void)[] = [];
const oldHome = process.env.HOME;
afterEach(() => { process.env.HOME = oldHome; for (const close of clean.splice(0)) close(); });
function fixture() {
  const f = hookFixture(); clean.push(f.close); process.env.HOME = f.env.HOME;
  const spool = join(f.base, "hook-spool");
  const pending = () => existsSync(spool) ? readdirSync(spool).filter(name => name.startsWith("hook-")).sort() : [];
  const rows = () => { const store = new CaptureStore({ memoryDir: f.base, project: f.project }); try { return store.rows({ project: f.project }); } finally { store.close(); } };
  const stage = async (text: string) => (await stageHookCapture("PostToolUse", { session_id: "s", tool_name: "Read", tool_response: text }, { cwd: f.cwd, base: f.base }))!;
  return { ...f, spool, pending, rows, stage };
}
const tree = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];

test("preview is read-only and body-free: it creates no file, directory or index and shows no excerpt", async () => {
  const f = fixture(); await f.seed();
  await f.stage("secret-free but private body text 217");
  const before = tree(f.base), modes = readdirSync(f.base).map(name => name);
  const plan = await planHookSpoolReplay({ base: f.base });
  expect(tree(f.base)).toEqual(before);
  expect(readdirSync(f.base)).toEqual(modes);
  expect(JSON.stringify(plan)).not.toContain("private body text 217");
  expect(plan.counts.replayable).toBe(1);
  expect(plan.records[0]).toMatchObject({ class: "replayable", cwd: f.cwd, project: f.project });
});

test("apply replays a replayable record exactly once, then retires its exact claim", async () => {
  const f = fixture(); await f.seed();
  await f.stage("replay me once");
  const plan = await planHookSpoolReplay({ base: f.base });
  const receipt = await applyHookSpoolReplay({ base: f.base, plan });
  expect(receipt).toMatchObject({ applied: 1, retired: 1, retained: 0 });
  expect(f.rows().filter(row => row.excerpt.includes("replay me once"))).toHaveLength(1);
  expect(f.pending()).toEqual([]);
  // The same plan again appends nothing (the record is absent, I2); a fresh preview finds nothing either.
  expect(await applyHookSpoolReplay({ base: f.base, plan })).toMatchObject({ applied: 0, retired: 0, absent: 1 });
  expect(f.rows().filter(row => row.excerpt.includes("replay me once"))).toHaveLength(1);
  expect((await planHookSpoolReplay({ base: f.base })).records).toEqual([]);
});

test("crash after the append but before the claim retires: rerunning the same plan appends nothing twice", async () => {
  const f = fixture(); await f.seed();
  const staged = await f.stage("crash between append and ack");
  const plan = await planHookSpoolReplay({ base: f.base });
  // Crash point: the capture append completed but the exact claim was not retired. Reproduce it: append the record with
  // the receipt the replay uses, and leave it under the plan's own deterministic claim name (a rename keeps the inode).
  const raw = readFileSync(join(f.spool, staged.name)), c = JSON.parse(raw.toString("utf8")).capture;
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    store.append({ project: f.project, agent: c.agent, event: c.event, at: c.at, paths: c.paths, ...(c.tool === null ? {} : { tool: c.tool }),
      ...(c.status === null ? {} : { status: c.status }), excerpt: c.excerpt, ...(c.session === undefined ? {} : { session: c.session }) },
      { receipt: createHash("sha256").update(raw).digest("hex") });
  } finally { store.close(); }
  renameSync(join(f.spool, staged.name), join(f.spool, `${staged.name}.draining-${claimFor(plan.digest, staged.name)}`));
  const receipt = await applyHookSpoolReplay({ base: f.base, plan });
  expect(receipt).toMatchObject({ applied: 1, retired: 1 });
  expect(f.rows().filter(row => row.excerpt.includes("crash between append"))).toHaveLength(1);
  expect(f.pending()).toEqual([]);
});

test("a claim held by another plan is reported and left alone", async () => {
  const f = fixture(); await f.seed();
  const staged = await f.stage("held by another plan");
  renameSync(join(f.spool, staged.name), join(f.spool, `${staged.name}.draining-${"a".repeat(24)}`));
  const plan = await planHookSpoolReplay({ base: f.base });
  expect(plan.counts.claimed_elsewhere).toBe(1);
  const receipt = await applyHookSpoolReplay({ base: f.base, plan });
  expect(receipt.applied).toBe(0);
  expect(readdirSync(f.spool).some(name => name.endsWith(".draining-" + "a".repeat(24)))).toBe(true);
});

test("an abandoned cwd is cwd_missing plus attribution_unproven and is never rebound or retired", async () => {
  const f = fixture(); await f.seed();
  const other = join(f.root, "gone-project"); mkdirSync(other);
  await stageHookCapture("PostToolUse", { tool_response: "from a removed checkout" }, { cwd: other, base: f.base });
  rmSync(other, { recursive: true });
  const plan = await planHookSpoolReplay({ base: f.base });
  const record = plan.records.find(r => r.cwd.endsWith("gone-project"))!;
  expect(record).toMatchObject({ class: "cwd_missing", project: null, reasons: ["cwd_missing"] });
  expect(record.confirmable).toBeUndefined();
  expect((await applyHookSpoolReplay({ base: f.base, plan })).applied).toBe(0);
  expect((await applyHookSpoolReplay({ base: f.base, plan, confirmUnverifiable: true })).applied).toBe(0);   // never, even with the flag
  expect(f.pending()).toHaveLength(1);
});

/** A reboot-like previous-boot record: its device-bound scope matches neither this boot's scope nor its current legacy scope. */
async function previousBoot(f: ReturnType<typeof fixture>, text: string, cwd = f.cwd) {
  const staged = (await stageHookCapture("PostToolUse", { session_id: "s", tool_name: "Read", tool_response: text }, { cwd, base: f.base }))!;
  const file = join(f.spool, staged.name), value = JSON.parse(readFileSync(file, "utf8"));
  value.scope = "e".repeat(64); writeFileSync(file, JSON.stringify(value));
  const renamed = staged.name.replace(/-[a-f0-9]{64}-([a-f0-9]{32})\.json$/, `-${"e".repeat(64)}-$1.json`);
  renameSync(file, join(f.spool, renamed));
  return renamed;
}

test("decision A: a previous-boot record is physical_identity_unverifiable only, skipped without the flag, replayed with it", async () => {
  const f = fixture(); await f.seed();
  const renamed = await previousBoot(f, "previous boot record");
  const plan = await planHookSpoolReplay({ base: f.base });
  expect(plan.records[0]).toMatchObject({ class: "physical_identity_unverifiable", reasons: ["physical_identity_unverifiable"], confirmable: true, cwd: f.cwd, project: f.project });
  expect(plan.needsConfirmation).toEqual([{ cwd: f.cwd, project: f.project, count: 1 }]);
  const without = await applyHookSpoolReplay({ base: f.base, plan });
  expect(without.applied).toBe(0);
  expect(without.outcomes[0]!.reason).toContain("--confirm-unverifiable");
  expect(f.pending()).toEqual([renamed]);
  const confirmed = await applyHookSpoolReplay({ base: f.base, plan, confirmUnverifiable: true });
  expect(confirmed).toMatchObject({ applied: 1, retired: 1 });
  expect(f.rows().filter(row => row.excerpt.includes("previous boot record"))).toHaveLength(1);
  expect(f.pending()).toEqual([]);
});

test("decision A: a changed project, policy or alias between preview and confirmed apply refuses with no effect", async () => {
  for (const change of ["policy", "alias", "project"] as const) {
    const f = fixture(); await f.seed();
    await previousBoot(f, `confirm ${change}`);
    const plan = await planHookSpoolReplay({ base: f.base });
    expect(plan.needsConfirmation, change).toHaveLength(1);
    if (change === "policy") writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ denyPaths: ["unrelated/**"] }));
    if (change === "alias") appendFileSync(join(f.base, "aliases.jsonl"), JSON.stringify({ schema: "agent-mem.alias/v1", op: "alias", alias: f.project, key: "example.test/elsewhere", actor: "person", machine: "fixture", at: new Date().toISOString() }) + "\n");
    if (change === "project") Bun.spawnSync(["git", "-C", f.cwd, "remote", "add", "origin", "https://example.test/changed/repo.git"], { env: f.env });
    await expect(applyHookSpoolReplay({ base: f.base, plan, confirmUnverifiable: true }), change).rejects.toThrow(/preview/);
    expect(f.rows().filter(row => row.excerpt.includes(`confirm ${change}`)), change).toHaveLength(0);
  }
});

test("decision A: an inactive project or a policy-refused unverifiable record is never applied, even with the flag", async () => {
  for (const kind of ["inactive", "policy"] as const) {
    const f = fixture(); await f.seed();
    await previousBoot(f, kind === "policy" ? "holds marker-217-pii" : "inactive record");
    if (kind === "policy") writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["marker-217-pii"] }));
    if (kind === "inactive") appendLifecycle(f.base, { op: "archive", key: f.project, actor: "person", machine: "fixture" });
    const plan = await planHookSpoolReplay({ base: f.base });
    expect(plan.records[0]!.reasons, kind).toEqual(["physical_identity_unverifiable", kind === "policy" ? "policy_refused" : "project_inactive"]);
    expect(plan.records[0]!.confirmable, kind).toBeUndefined();
    expect(plan.needsConfirmation, kind).toEqual([]);
    expect((await applyHookSpoolReplay({ base: f.base, plan, confirmUnverifiable: true })).applied, kind).toBe(0);
  }
});

test("decision A: attribution_unproven (no strict project) is never applied, even with the flag", async () => {
  const f = fixture(); await f.seed();
  const plain = join(f.root, "no-git-here"); mkdirSync(plain);
  await previousBoot(f, "unattributable record", plain);
  // A strict-identity failure: an unreadable .git marker that physicalGit sees but Git cannot use.
  writeFileSync(join(plain, ".git"), "gitdir: /nonexistent/elsewhere");
  const plan = await planHookSpoolReplay({ base: f.base });
  const record = plan.records.find(r => r.cwd === plain)!;
  expect(record.reasons).toEqual(["physical_identity_unverifiable", "attribution_unproven"]);
  expect(record.confirmable).toBeUndefined();
  expect((await applyHookSpoolReplay({ base: f.base, plan, confirmUnverifiable: true })).applied).toBe(0);
});

test("an unknown or newer schema stays pending and untouched (#199)", async () => {
  const f = fixture(); await f.seed();
  const staged = await f.stage("future schema");
  const file = join(f.spool, staged.name), value = JSON.parse(readFileSync(file, "utf8"));
  value.format = 9; writeFileSync(file, JSON.stringify(value));
  const before = readFileSync(file, "utf8");
  const plan = await planHookSpoolReplay({ base: f.base });
  expect(plan.records[0]!.class).toBe("unknown_schema");
  await applyHookSpoolReplay({ base: f.base, plan });
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("a policy refusal on the record's own cwd is policy_refused and not applied", async () => {
  const f = fixture(); await f.seed();
  await f.stage("contains marker-217-pii");
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["marker-217-pii"] }));
  const plan = await planHookSpoolReplay({ base: f.base });
  expect(plan.records[0]!.class).toBe("policy_refused");
  expect((await applyHookSpoolReplay({ base: f.base, plan })).applied).toBe(0);
  expect(f.rows().some(row => row.excerpt.includes("marker-217-pii"))).toBe(false);
});

test("an archived project is project_inactive and takes no replay", async () => {
  const f = fixture(); await f.seed();
  await f.stage("archived project body");
  appendLifecycle(f.base, { op: "archive", key: f.project, actor: "person", machine: "fixture" });
  const plan = await planHookSpoolReplay({ base: f.base });
  expect(plan.records[0]!.class).toBe("project_inactive");
});

test("apply refuses with no effect when the bytes, the policy, the source directory or the plan file changed", async () => {
  for (const change of ["bytes", "policy", "source", "edited"] as const) {
    const f = fixture(); await f.seed();
    const staged = await f.stage(`binding ${change}`);
    let plan: HookSpoolReplayPlan = await planHookSpoolReplay({ base: f.base });
    if (change === "bytes") { const file = join(f.spool, staged.name), v = JSON.parse(readFileSync(file, "utf8")); v.capture.excerpt += "!"; writeFileSync(file, JSON.stringify(v)); }
    if (change === "policy") writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ denyPaths: ["unrelated/**"] }));
    if (change === "source") { renameSync(f.spool, f.spool + ".old"); mkdirSync(f.spool, { mode: 0o700 }); renameSync(join(f.spool + ".old", staged.name), join(f.spool, staged.name)); }
    if (change === "edited") plan = { ...plan, records: plan.records.map(r => ({ ...r, project: "someone/else" })) };
    await expect(applyHookSpoolReplay({ base: f.base, plan }), change).rejects.toThrow(/preview|edited/);
    expect(f.rows().filter(row => row.excerpt.includes(`binding ${change}`)), change).toHaveLength(0);
  }
});

test("an explicit parked source is read in place; its private mode is required", async () => {
  const f = fixture(); await f.seed();
  const staged = await f.stage("parked record");
  const parked = join(f.root, "hook-spool-orphans-fixture"); mkdirSync(parked, { mode: 0o700 });
  renameSync(join(f.spool, staged.name), join(parked, staged.name));
  const plan = await planHookSpoolReplay({ base: f.base, source: parked });
  expect(plan.records[0]).toMatchObject({ tier: "source", class: "replayable" });
  expect((await applyHookSpoolReplay({ base: f.base, plan })).applied).toBe(1);
  expect(readdirSync(parked)).toEqual([]);
  chmodSync(parked, 0o755);
  await expect(planHookSpoolReplay({ base: f.base, source: parked })).rejects.toThrow("not a private directory");
});

test("one CaptureStore at a time across projects", async () => {
  const f = fixture(); await f.seed();
  const other = join(f.root, "second"); mkdirSync(other);
  Bun.spawnSync(["git", "init", "--quiet", other], { env: f.env });
  await f.stage("project one");
  await stageHookCapture("PostToolUse", { tool_response: "project two" }, { cwd: other, base: f.base });
  const plan = await planHookSpoolReplay({ base: f.base });
  expect(plan.counts.replayable).toBe(2);
  let open = 0, peak = 0;
  const realClose = CaptureStore.prototype.close, realAppend = CaptureStore.prototype.append, seen = new Set<CaptureStore>();
  const appendSpy = spyOn(CaptureStore.prototype, "append").mockImplementation(function (this: CaptureStore, ...args: Parameters<typeof realAppend>) {
    if (!seen.has(this)) { seen.add(this); open++; peak = Math.max(peak, open); }
    return realAppend.apply(this, args);
  });
  const closeSpy = spyOn(CaptureStore.prototype, "close").mockImplementation(function (this: CaptureStore) { if (seen.delete(this)) open--; return realClose.call(this); });
  try { expect((await applyHookSpoolReplay({ base: f.base, plan })).applied).toBe(2); }
  finally { appendSpy.mockRestore(); closeSpy.mockRestore(); }
  expect(peak).toBe(1);
  expect(open).toBe(0);
});

test("CLI refuses bad invocations before any home or store access, for person and agent alike", async () => {
  const f = fixture();
  const home = join(f.root, "untouched-home");
  for (const env of [{ AMEM_HOME: home }, { AMEM_HOME: home, CLAUDECODE: "1" }]) {
    const cases: [string[], RegExp][] = [
      [["spool", "replay", "--source", "relative/dir"], /relative path/],
      [["spool", "replay", "--apply"], /needs --plan/],
      [["spool", "replay", "--plan", "x.json"], /only used with --apply/],
      [["spool", "replay", "--apply", "--plan", "x.json", "--source", "/tmp/x"], /fixed by the saved plan/],
      [["spool", "replay", "--source", "/tmp/a\0b"], /NUL/],
      [["spool", "replay", "--confirm-unverifiable"], /only applies with --apply/],
      [["spool", "other"], /unknown command spool other/],   // the pure parser refuses it first
    ];
    for (const [argv, message] of cases) await expect(runCli(argv, { env: { ...process.env, ...env }, cwd: f.cwd }), argv.join(" ")).rejects.toThrow(message);
    expect(existsSync(home)).toBe(false);
  }
});

test("a saved plan file round-trips and an edited one is refused", async () => {
  const f = fixture(); await f.seed();
  await f.stage("round trip");
  const plan = await planHookSpoolReplay({ base: f.base });
  expect(parseReplayPlan(JSON.parse(JSON.stringify(plan))).digest).toBe(plan.digest);
  expect(() => parseReplayPlan({ ...plan, counts: { ...plan.counts, replayable: 9 } })).toThrow("edited after the preview");
  expect(() => parseReplayPlan({ schema: "nope" })).toThrow("not an amem spool replay plan");
});

test("I2: a plan that failed on record 2 of 2 resumes: rerunning it applies record 2 exactly once", async () => {
  const f = fixture(); await f.seed();
  await f.stage("resume first"); await Bun.sleep(5); await f.stage("resume second");
  const plan = await planHookSpoolReplay({ base: f.base });
  expect(plan.counts.replayable).toBe(2);
  const realAppend = CaptureStore.prototype.append; let calls = 0;
  const spy = spyOn(CaptureStore.prototype, "append").mockImplementation(function (this: CaptureStore, ...args: Parameters<typeof realAppend>) {
    if (++calls === 2) throw new Error("injected failure on record 2");
    return realAppend.apply(this, args);
  });
  try { await expect(applyHookSpoolReplay({ base: f.base, plan })).rejects.toThrow("injected failure on record 2"); }
  finally { spy.mockRestore(); }
  // Record 1 retired; record 2 sits under this plan's own claim.
  expect(f.pending()).toHaveLength(1);
  expect(f.pending()[0]).toContain(".draining-");
  const receipt = await applyHookSpoolReplay({ base: f.base, plan });
  expect(receipt).toMatchObject({ applied: 1, retired: 1, retained: 0, absent: 1 });
  const rows = f.rows().map(row => row.excerpt);
  expect(rows.filter(text => text.includes("resume first"))).toHaveLength(1);
  expect(rows.filter(text => text.includes("resume second"))).toHaveLength(1);
  expect(receipt.outcomes.find(o => o.outcome === "absent")?.reason).toContain("nothing was appended");
  expect(rows).toHaveLength(new Set(rows).size);
  expect(f.pending()).toEqual([]);
});

test("I2: a resumed plan still refuses when a present record changed", async () => {
  const f = fixture(); await f.seed();
  const one = await f.stage("stale first"); await Bun.sleep(5); const two = await f.stage("stale second");
  const plan = await planHookSpoolReplay({ base: f.base });
  rmSync(join(f.spool, one.name));
  appendFileSync(join(f.spool, two.name), " ");
  await expect(applyHookSpoolReplay({ base: f.base, plan })).rejects.toThrow("changed since the preview");
  expect(f.rows().filter(row => row.excerpt.includes("stale second"))).toHaveLength(0);
});

test("I3: more records than the open-file limit preview completely or fail loudly, never silently short", async () => {
  const f = fixture(); await f.seed();
  // The hook path admits 64 active records per cwd, so park in batches (like the real orphan directory) to reach 100.
  const parked = join(f.root, "hook-spool-orphans-fd"); mkdirSync(parked, { mode: 0o700 });
  for (let i = 0; i < 100; i++) { const staged = await f.stage(`fd pressure ${i}`); renameSync(join(f.spool, staged.name), join(parked, staged.name)); }
  expect(readdirSync(parked)).toHaveLength(100);
  const script = join(f.root, "preview-fd.ts");
  writeFileSync(script, `import { planHookSpoolReplay } from ${JSON.stringify(join(import.meta.dir, "../src/hook-spool-replay.ts"))};
try { const plan = await planHookSpoolReplay({ base: ${JSON.stringify(f.base)}, source: ${JSON.stringify(parked)} }); console.log(JSON.stringify({ records: plan.records.length, counts: plan.counts })); }
catch (error) { console.log(JSON.stringify({ code: (error as { code?: string }).code, message: String((error as Error).message) })); }
`);
  const run = Bun.spawnSync(["/bin/sh", "-c", `ulimit -n 64 && exec "${process.execPath}" "${script}"`], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 30000 });
  const out = run.stdout.toString().trim().split("\n").pop() ?? "";
  expect(out, run.stderr.toString()).not.toBe("");
  const result = JSON.parse(out) as { records?: number; counts?: Record<string, number>; code?: string; message?: string };
  if (result.code !== undefined) {
    expect(result.code).toBe("replay_resource_exhausted");
    expect(result.message).toContain("ulimit -n");
  } else {
    expect(result.records).toBe(100);
    expect(result.counts!.replayable).toBe(100);
  }
});

test("I3: an open failure other than a vanished file fails the preview with its cause and next step", async () => {
  const f = fixture(); await f.seed();
  await f.stage("unreadable");
  const name = f.pending()[0]!;
  chmodSync(join(f.spool, name), 0o000);
  try {
    if (process.getuid?.() === 0) return; // root reads anyway
    await expect(planHookSpoolReplay({ base: f.base })).rejects.toThrow(/EACCES.*ulimit -n|EACCES/);
  } finally { chmodSync(join(f.spool, name), 0o600); }
});

for (const event of ["Recap", "Compact"] as const) test(`spool replay prepares a prebuilt ${event} section`, async () => {
  const f = fixture(); await f.seed();
  const staged = await stageTranscriptCapture({ agent: "claude", event, at: new Date().toISOString(), excerpt: "replayed summary marker", session: "a".repeat(16) }, { cwd: f.cwd, base: f.base });
  expect(staged).toBeDefined();
  const plan = await planHookSpoolReplay({ base: f.base });
  expect(await applyHookSpoolReplay({ base: f.base, plan })).toMatchObject({ applied: 1, retired: 1 });
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    const cache = readBriefCache({ directory: store.dir, project: f.project, section: "capture" });
    expect(cache?.builtThrough).toBeGreaterThan(0);
    expect(JSON.stringify(cache?.rows)).toContain("replayed summary marker");
  } finally { store.close(); }
});
