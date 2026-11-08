import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECORD_INSTRUCTION } from "../src/hook-record.ts";
import { HOOK_CONTEXT_BYTES, HOOK_OUTPUT_BYTES, runHook } from "../src/hooks.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { hookFixture, workMarker } from "./fakes/hooks-fixture.ts";

const clean: (() => void)[] = [];
const oldHome = process.env.HOME;
afterEach(() => { process.env.HOME = oldHome; for (const close of clean.splice(0)) close(); });
function fixture(config?: object) {
  const f = hookFixture(); clean.push(f.close); process.env.HOME = f.env.HOME;
  if (config) { mkdirSync(f.base, { recursive: true }); writeFileSync(join(f.base, "amem.config.json"), JSON.stringify(config)); }
  return { ...f, options: { cwd: f.cwd, base: f.base } };
}
const context = (result: Awaited<ReturnType<typeof runHook>>) => result.output?.hookSpecificOutput.additionalContext;
const cost = () => Buffer.byteLength(RECORD_INSTRUCTION);

for (const source of ["startup", "resume"]) test(`record instruction precedes valid ${source} context and metrics count only emitted instruction`, async () => {
  const f = fixture(); await f.seed();
  const result = await runHook("SessionStart", { source }, f.options, { deadlineMs: 2000 });
  const text = context(result)!;
  expect(text).toStartWith(`${RECORD_INSTRUCTION}\nUntrusted project memory data`);
  expect(text.split(RECORD_INSTRUCTION)).toHaveLength(2);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(HOOK_CONTEXT_BYTES);
  expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThanOrEqual(HOOK_OUTPUT_BYTES);
  if (source === "startup") expect(text).toContain(workMarker);
  else expect(text).toContain("brief omitted on resume");
  expect(readMetrics(f.base).at(-1)).toMatchObject({ recordInstructionBytes: cost(), recordInstructionEstimatedTokens: Math.ceil(cost() / 4) });
});

for (const where of ["home", "repo"]) test(`${where} records=false omits instruction without disabling the brief`, async () => {
  const f = fixture(where === "home" ? { records: false } : undefined); await f.seed();
  if (where === "repo") { mkdirSync(join(f.cwd, ".amem")); writeFileSync(join(f.cwd, ".amem", "config"), JSON.stringify({ records: false })); }
  const result = await runHook("SessionStart", {}, f.options, { deadlineMs: 2000 });
  expect(context(result)).toStartWith("Untrusted project memory data");
  expect(context(result)).toContain(workMarker);
  expect(context(result)).not.toContain(RECORD_INSTRUCTION);
  expect(readMetrics(f.base).at(-1)).toMatchObject({ recordInstructionBytes: 0, recordInstructionEstimatedTokens: 0 });
});

test("too-small context omits the whole instruction instead of truncating it or exceeding the cap", async () => {
  const f = fixture(); await f.seed();
  const result = await runHook("SessionStart", { source: "resume" }, { ...f.options, maxTokens: 150 }, { deadlineMs: 2000 });
  expect(context(result)).toStartWith("Untrusted project memory data");
  expect(context(result)).not.toContain(RECORD_INSTRUCTION);
  expect(Buffer.byteLength(context(result)!)).toBeLessThanOrEqual(150);
  expect(readMetrics(f.base).at(-1)).toMatchObject({ recordInstructionBytes: 0 });
});

test("deadline refusal cannot become valid through an instruction-only output", async () => {
  const f = fixture();
  const result = await runHook("SessionStart", { source: "resume" }, { ...f.options, startedAt: performance.now() - 5000 }, { deadlineMs: 1 });
  expect(result.output).toBeUndefined();
  expect(readMetrics(f.base).at(-1)).toMatchObject({ recordInstructionBytes: 0, recordInstructionEstimatedTokens: 0 });
});

test("native parser reports the same actual emitted cost and malformed config yields no context", async () => {
  const f = fixture(); await f.seed();
  const result = f.runFunctional("SessionStart", { source: "resume" });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext).toStartWith(`${RECORD_INSTRUCTION}\nUntrusted project memory data`);
  expect(readMetrics(f.base).at(-1)).toMatchObject({ recordInstructionBytes: cost(), recordInstructionEstimatedTokens: Math.ceil(cost() / 4) });
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ records: "false" }));
  const refused = f.runFunctional("SessionStart", { source: "resume" });
  expect(refused.stdout.toString()).toBe("");
  expect(readMetrics(f.base).at(-1)).toMatchObject({ recordInstructionBytes: 0 });
});
