import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture, workMarker } from "./fakes/hooks-fixture.ts";
import { stageHookCapture, drainHookCaptures } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { captureDropSummary } from "../src/memory/metrics.ts";
import { seedHookBacklog } from "./fakes/hooks-backlog.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [], originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) f.close();
});
function fixture() { const f = hookFixture(); fixtures.push(f); process.env.HOME = f.env.HOME; return f; }
const reserved = (base: string) => join(base, "hook-spool", ".capacity");
const publications = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name => /^hook-.*\.json$/.test(name)) : [];
function age(file: string) {
  const value = JSON.parse(readFileSync(file, "utf8")), old = new Date(Date.now() - 8 * 24 * 3600_000);
  value.capture.at = old.toISOString(); writeFileSync(file, JSON.stringify(value)); utimesSync(file, old, old);
}

test("SessionStart skips active inventory and active retirement, retains known work, and publishes only its reserve", async () => {
  const f = fixture(); await f.seed();
  const preload = join(f.root, "session-no-maintenance.ts"), marker = join(f.root, "forbidden-session-scan"), spool = resolve(import.meta.dir, "../src/hook-spool.ts");
  // These are failure tripwires on the actual module, not substitutes for its policy or binding helpers.
  writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';Bun.plugin({name:'session-no-maintenance',setup(builder){builder.onLoad({filter:/hook-spool\\.ts$/},({path})=>{if(path!==${JSON.stringify(spool)})return;let source=readFileSync(path,'utf8');const active='  const dir = capacity ? join(directory(base), ".capacity") : directory(base), maximum = capacity',retire='  const retired = new Set<string>(), cwdHash';if(source.split(active).length!==2||source.split(retire).length!==2)throw new Error('tripwire source moved');source=source.replace(active,${JSON.stringify(`  if (!capacity) { writeFileSync(${JSON.stringify(marker)}, "active"); throw new Error("SessionStart active inventory"); }\n`)}+active).replace(retire,${JSON.stringify(`  if (!capacity) { writeFileSync(${JSON.stringify(marker)}, "retirement"); throw new Error("SessionStart active retirement"); }\n`)}+retire);return {loader:'ts',contents:source};});}});`);
  const result = f.runFunctional("SessionStart", {}, { BUN_OPTIONS: `--preload=${preload}` });
  expect(result.exitCode, result.stderr.toString()).toBe(0); expect(result.stdout.length).toBeGreaterThan(0);
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext).toContain(workMarker);
  expect(existsSync(marker)).toBe(false);
  const names = publications(reserved(f.base)); expect(names).toHaveLength(1);
  expect(publications(join(f.base, "hook-spool"))).toEqual([]);
  const value = JSON.parse(readFileSync(join(reserved(f.base), names[0]!), "utf8"));
  expect(value.capture.event).toBe("SessionStart");
});

for (const existingCursor of [false, true]) test("an aged reserve without pressure leaves maintenance cursors untouched: existing=" + existingCursor, async () => {
  const f = fixture(), options = { cwd: f.cwd, base: f.base };
  const first = (await stageHookCapture("SessionStart", { prompt: "aged reserve row" }, options))!;
  const file = join(reserved(f.base), first.name); age(file);
  const body = readFileSync(file, "utf8"), maintenance = join(f.base, "hook-spool", ".maintenance"), cursor = join(maintenance, "reserve");
  if (existingCursor) {
    mkdirSync(maintenance, { mode: 0o700 }); writeFileSync(cursor, "7", { mode: 0o600 });
    utimesSync(cursor, new Date(0), new Date(0));
  }
  const before = existingCursor ? { body: readFileSync(cursor, "utf8"), modified: statSync(cursor).mtimeMs } : undefined;
  const next = await stageHookCapture("SessionStart", { prompt: "room remains in reserve" }, options);
  expect(next?.deferred).toBe(true); expect(publications(reserved(f.base))).toHaveLength(2);
  expect(readFileSync(file, "utf8")).toBe(body); expect(captureDropSummary(f.base)).toEqual({});
  expect(existsSync(maintenance)).toBe(existingCursor);
  if (before) {
    expect(readdirSync(maintenance)).toEqual(["reserve"]);
    expect(readFileSync(cursor, "utf8")).toBe(before.body); expect(statSync(cursor).mtimeMs).toBe(before.modified);
  }
});

test("reserve-only SessionStart preserves exact-once replay and refuses at its protected future-schema global file cap", async () => {
  const f = fixture(), options = { cwd: f.cwd, base: f.base };
  const first = await stageHookCapture("SessionStart", { prompt: "first reserved session" }, options);
  expect(first?.deferred).toBe(true); expect(publications(join(f.base, "hook-spool"))).toEqual([]);
  const store = new CaptureStore({ home: f.root, project: f.project });
  try {
    const append = (input: Parameters<typeof store.append>[0], receipt: string) => store.append(input, { receipt });
    expect((await drainHookCaptures({ ...options, project: f.project }, append)).captured).toEqual([first!.name]);
    expect((await drainHookCaptures({ ...options, project: f.project }, append)).captured).toEqual([]);
    expect(store.rows({ project: f.project })).toHaveLength(1);
  } finally { store.close(); }
  await seedHookBacklog(options, { active: 0, reserve: 32, futureSchema: true, label: "protected future session" });
  await expect(stageHookCapture("SessionStart", { prompt: "over reserve" }, options)).rejects.toThrow("hook storage full");
  expect(publications(reserved(f.base))).toHaveLength(32);
  expect(publications(join(f.base, "hook-spool"))).toHaveLength(0);
  expect(captureDropSummary(f.base)).toEqual({});
});

test("reserve-only SessionStart refuses a protected future-schema byte cap below its file cap", async () => {
  const f = fixture(), options = { cwd: f.cwd, base: f.base };
  await seedHookBacklog(options, { active: 0, reserve: 4, futureSchema: true, label: "protected future byte-bound session" });
  const names = publications(reserved(f.base));
  for (const name of names) { const file = join(reserved(f.base), name); writeFileSync(file, readFileSync(file, "utf8").padEnd(64 * 1024, " ")); }
  const before = names.map(name => readFileSync(join(reserved(f.base), name), "utf8"));
  await expect(stageHookCapture("SessionStart", { prompt: "over reserve bytes" }, options)).rejects.toThrow("hook storage full");
  expect(publications(reserved(f.base))).toEqual(names); expect(names).toHaveLength(4);
  expect(names.map(name => readFileSync(join(reserved(f.base), name), "utf8"))).toEqual(before);
  expect(names.reduce((sum, name) => sum + statSync(join(reserved(f.base), name)).size, 0)).toBe(256 * 1024);
  expect(publications(join(f.base, "hook-spool"))).toHaveLength(0);
  expect(captureDropSummary(f.base)).toEqual({});
});

test("non-SessionStart maintains expired undrainable reserve even when active admission has room", async () => {
  const f = fixture(), options = { cwd: f.cwd, base: f.base };
  const pending = await stageHookCapture("SessionStart", { prompt: "expired old identity" }, options), file = join(reserved(f.base), pending!.name);
  age(file);
  const changed = Bun.spawnSync(["git", "-C", f.cwd, "remote", "add", "origin", "https://example.invalid/new/project.git"], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(changed.exitCode).toBe(0);
  expect(await stageHookCapture("PostToolUse", { prompt: "new active identity" }, options)).toBeDefined();
  expect(existsSync(file)).toBe(false); expect(publications(join(f.base, "hook-spool"))).toHaveLength(1);
  expect(captureDropSummary(f.base).undrainable_expired).toBe(1);
});

test("non-SessionStart reserve maintenance preserves old but still-drainable foreign data", async () => {
  const f = fixture(), foreign = hookFixture(); fixtures.push(foreign);
  const pending = await stageHookCapture("SessionStart", { prompt: "foreign retained identity" }, { cwd: foreign.cwd, base: f.base }), file = join(reserved(f.base), pending!.name);
  age(file);
  expect(await stageHookCapture("PostToolUse", { prompt: "ordinary local event" }, { cwd: f.cwd, base: f.base })).toBeDefined();
  expect(existsSync(file)).toBe(true); expect(captureDropSummary(f.base)).toEqual({});
});
