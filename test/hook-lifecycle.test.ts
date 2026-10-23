import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { drainHookCaptures, stageHookCapture } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { appendLifecycle } from "../src/memory/lifecycle.ts";
import { captureDropSummary } from "../src/memory/metrics.ts";

// #15 T5 review: hooks keep staging events for a project the person archived or forgot. The drain must retire those records with a counted reason, not
// keep them as "transient": the home-wide spool holds 256 files, so one project's text would otherwise fill it for every project.
const clean: (() => void)[] = [], home = process.env.HOME;
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
function fixture() {
  const f = hookFixture(); clean.push(f.close); process.env.HOME = f.env.HOME;
  new CaptureStore({ memoryDir: f.base, project: f.project }).close();                 // the shard exists, as after any earlier session
  const options = { cwd: f.cwd, base: f.base };
  const pending = () => [join(f.base, "hook-spool"), join(f.base, "hook-spool", ".capacity")].flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name)) : []);
  const stage = async (...prompts: string[]) => { for (const prompt of prompts) await stageHookCapture("PostToolUse", { prompt }, options); };
  const lifecycle = (op: "archive" | "unarchive" | "forget") => appendLifecycle(f.base, { op, key: f.project, actor: "person", machine: "fixture" });
  const drain = (append: (input: never, receipt: string) => never) => drainHookCaptures({ ...options, project: f.project }, append as never);
  return { ...f, options, pending, stage, lifecycle, drain };
}
const forbidden = () => { throw new Error("a capture must never be appended for a project that is not active"); };

for (const [op, reason] of [["archive", "project_archived"], ["forget", "project_forgotten"]] as const) {
  test(`after ${op}, the staged events of the project are retired by the drain with a counted reason, never kept pending and never appended`, async () => {
    const f = fixture();
    await f.stage("one", "two", "three");
    expect(f.pending()).toHaveLength(3);
    f.lifecycle(op);
    const result = await f.drain(forbidden as never);
    expect(result.captured).toEqual([]);
    expect(f.pending()).toHaveLength(0);                                                       // nothing pins the spool
    expect(captureDropSummary(f.base)[reason]).toBe(3);
    // and no capture row exists
    const store = new CaptureStore({ memoryDir: f.base, project: f.project, lifecycle: "ignore" });
    try { expect(store.rows({ project: f.project })).toHaveLength(0); } finally { store.close(); }
  });
}

test("after unarchive, new events drain and append again; the ones dropped while archived stay dropped", async () => {
  const f = fixture();
  await f.stage("while archived");
  f.lifecycle("archive");
  await f.drain(forbidden as never);
  f.lifecycle("unarchive");
  await f.stage("after unarchive");
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt }));
    expect(store.rows({ project: f.project }).map(row => row.excerpt)).toEqual(["after unarchive"]);
  } finally { store.close(); }
  expect(f.pending()).toHaveLength(0);
});

test("the drop receipt carries a count and a reason only, never the dropped text", async () => {
  const f = fixture();
  await f.stage("SECRET-FREE-BUT-PRIVATE-TEXT-7731");
  f.lifecycle("forget");
  await f.drain(forbidden as never);
  const metrics = Bun.file(join(f.base, "metrics.jsonl"));
  expect(await metrics.text()).not.toContain("7731");
  expect(captureDropSummary(f.base).project_forgotten).toBe(1);
});
