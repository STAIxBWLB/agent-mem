import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { recordContextData } from "../src/hook-record.ts";
import { runHook } from "../src/hooks.ts";
import { runCli } from "../src/cli.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { observeRoot, projectTransition, readRootBindings, rootHash, rootsLogPath, ROOTS_FILE } from "../src/memory/roots.ts";

// #581: a working root that resolves to a different project key gets a notice, never a stop.
const clean: (() => void)[] = [];
const oldHome = process.env.HOME, oldAmem = process.env.AMEM_HOME;
afterEach(() => {
  process.env.HOME = oldHome;
  if (oldAmem === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldAmem;
  for (const close of clean.splice(0)) close();
});

function fixture() {
  const f = hookFixture(); clean.push(f.close);
  process.env.HOME = f.env.HOME; process.env.AMEM_HOME = f.base;
  const git = (...args: string[]) => { const r = Bun.spawnSync(["git", "-C", f.cwd, ...args], { env: f.env, stdout: "pipe", stderr: "pipe" }); if (r.exitCode !== 0) throw new Error("git failed"); };
  const options = { cwd: f.cwd, base: f.base };
  const start = async () => runHook("SessionStart", { source: "startup" }, options, { deadlineMs: 3000 });
  const brief = async () => recordContextData((await start()).output?.hookSpecificOutput.additionalContext ?? "") ?? "";
  const cli = (...args: string[]) => runCli(args, { cwd: f.cwd, env: {}, stdinTTY: true });
  const note = (project: string, text: string) => {
    const store = new MemoryStore({ memoryDir: f.base, deferPromotions: true });
    try { return store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", text, peer: "person", source: "person", about: [] }); } finally { store.close(); }
  };
  return { ...f, git, start, brief, cli, note };
}
const status = async (f: ReturnType<typeof fixture>) => JSON.parse(await f.cli("status", "--json")).projectTransition;

test("AC1: after a remote is added, the brief and amem status name both keys and print a runnable alias command", async () => {
  const f = fixture();
  const before = f.project;
  f.note(before, "old-key contract kept under the pre-remote key");
  await f.start();                                                       // first sight records the pre-remote key
  expect(readRootBindings(f.base).get(rootHash(f.cwd))?.key).toBe(before);
  f.git("remote", "add", "origin", "https://github.com/Fixture/Moved.git");
  const after = memoryProjectKey(f.cwd);
  expect(after).toBe("github.com/fixture/moved");
  const text = await f.brief();
  expect(text).toContain(`amem: project key changed for this directory: was ${before} (1 curated notes), now ${after}. Join: amem alias add ${before} ${after}  Keep apart: amem project keep-separate`);
  const t = await status(f);
  expect(t).toEqual({ previousKey: before, key: after, previousCuratedNotes: 1, aliasCommand: `amem alias add ${before} ${after}`, keepCommand: "amem project keep-separate" });
  expect(await f.cli("status")).toContain(`amem alias add ${before} ${after}`);
  const doctor = JSON.parse(await f.cli("doctor", "--json"));
  expect(doctor.sections.transition).toMatchObject({ status: "attention", previousKey: before, key: after });
  // The notice persists until settled: a second SessionStart still names the old key and writes no new line.
  const lines = readFileSync(rootsLogPath(f.base), "utf8").split("\n").filter(Boolean).length;
  expect(await f.brief()).toContain(`was ${before}`);
  expect(readFileSync(rootsLogPath(f.base), "utf8").split("\n").filter(Boolean).length).toBe(lines);
});

test("AC2: running the printed alias command ends the notice and the old notes read under the new key", async () => {
  const f = fixture();
  const before = f.project, id = f.note(before, "old-key contract readable after the join");
  await f.start();
  f.git("remote", "add", "origin", "https://github.com/fixture/joined.git");
  const t = await status(f);
  const [, ...args] = (t.aliasCommand as string).split(" ");             // "amem alias add <old> <new>"
  await f.cli(...args);
  expect(await status(f)).toBeNull();
  expect(await f.brief()).not.toContain("project key changed");
  expect(await f.cli("show", id)).toContain("old-key contract readable after the join");
});

test("AC2: an alias-settled transition re-binds, so a later change names the middle key", async () => {
  const f = fixture();
  const first = f.project;
  await f.start();
  f.git("remote", "add", "origin", "https://github.com/fixture/middle.git");
  const middle = memoryProjectKey(f.cwd);
  await f.cli("alias", "add", first, middle);
  await f.start();                                                       // re-bind to the middle key
  expect(readRootBindings(f.base).get(rootHash(f.cwd))?.key).toBe(middle);
  f.git("remote", "set-url", "origin", "https://github.com/fixture/newest.git");
  const t = await status(f);
  expect(t).toMatchObject({ previousKey: middle, key: "github.com/fixture/newest" });
});

test("AC3: keep-separate previews, then ends the notice without joining", async () => {
  const f = fixture();
  const before = f.project;
  await f.start();
  f.git("remote", "add", "origin", "https://github.com/fixture/apart.git");
  const aliases = join(f.base, "aliases.jsonl"), size = () => existsSync(rootsLogPath(f.base)) ? readFileSync(rootsLogPath(f.base), "utf8").length : 0;
  const was = size();
  const preview = await f.cli("project", "keep-separate");
  expect(preview).toContain("amem project keep-separate --confirm");
  expect(size()).toBe(was);                                              // preview writes nothing
  expect(JSON.parse(await f.cli("project", "keep-separate", "--confirm", "--json")).kept).toMatchObject({ previousKey: before, key: "github.com/fixture/apart" });
  expect(await status(f)).toBeNull();
  expect(await f.brief()).not.toContain("project key changed");
  expect(existsSync(aliases)).toBe(false);                               // nothing joined
  await expect(f.cli("project", "keep-separate")).rejects.toMatchObject({ exitCode: 2 });
});

test("AC4: capture goes to the new key and SessionStart never fails on the transition or an unreadable roots.jsonl", async () => {
  const f = fixture();
  await f.start();
  f.git("remote", "add", "origin", "https://github.com/fixture/capture.git");
  const after = memoryProjectKey(f.cwd);
  for (const damage of ["transition", "malformed", "unreadable"]) {
    if (damage === "malformed") writeFileSync(rootsLogPath(f.base), "not json\n{\"schema\":1}\n", { flag: "a" });
    if (damage === "unreadable") chmodSync(rootsLogPath(f.base), 0o000);
    const result = await runHook("SessionStart", { source: "startup", prompt: `capture ${damage}` }, { cwd: f.cwd, base: f.base }, { deadlineMs: 3000 });
    expect(result.skipped).toBe(false);
  }
  chmodSync(rootsLogPath(f.base), 0o600);
  const run = f.run("SessionStart", { source: "startup" });
  expect(run.exitCode).toBe(0);
  await runHook("UserPromptSubmit", { prompt: "after the key changed" }, { cwd: f.cwd, base: f.base }, { deadlineMs: 3000 });
  const capture = new CaptureStore({ home: f.root, project: after });
  try { expect(capture.rows({ project: after }).length).toBeGreaterThan(0); } finally { capture.close(); }
  expect(observeRoot(join(f.root, "no-such-home", "x"), f.cwd, after)).toBe("failed");
});

test("AC5: roots.jsonl holds no path text, and neither sync nor project export carries it", async () => {
  const f = fixture();
  await f.start();
  const text = readFileSync(rootsLogPath(f.base), "utf8");
  expect(text).not.toContain(f.root);
  for (const line of text.split("\n").filter(Boolean)) {
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed).sort()).toEqual(["at", "key", "op", "root", "schema", ...(parsed.machine ? ["machine"] : [])].sort());
    expect(parsed.root).toMatch(/^[0-9a-f]{64}$/);
  }
  await runHook("UserPromptSubmit", { prompt: "make a capture shard" }, { cwd: f.cwd, base: f.base }, { deadlineMs: 3000 });
  const out = join(f.root, "export.json");
  await f.cli("project", "export", f.project, "--to", out);
  expect(readFileSync(out, "utf8")).not.toContain(ROOTS_FILE);
  expect(readFileSync(out, "utf8")).not.toContain(rootHash(f.cwd));
  const syncSources = readFileSync(join(import.meta.dir, "../src/memory/sync-binding.ts"), "utf8") + readFileSync(join(import.meta.dir, "../src/memory/sync-placement-capture.ts"), "utf8");
  expect(syncSources).not.toContain("roots.jsonl");
  expect(projectTransition(f.base, f.cwd, f.project)).toBeUndefined();
});
