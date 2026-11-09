import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecordInstruction, RECORD_INSTRUCTION_FILE } from "../src/memory/record-instruction.ts";
import { loadAmemConfig } from "../src/memory/config.ts";
import { runHook } from "../src/hooks.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0)) close(); });
function directory() { const root = mkdtempSync(join(tmpdir(), "amem-record-selection-")); clean.push(() => rmSync(root, { recursive: true, force: true })); return root; }
for (const instruction of ["a", "b", "alternate"] as const) test(`person-written selection supports ${instruction} without changing config`, () => {
  const base = directory();
  expect(readRecordInstruction(base)).toEqual({ mode: "a", invalid: false });
  writeFileSync(join(base, RECORD_INSTRUCTION_FILE), JSON.stringify({ instruction }), { mode: 0o600 });
  expect(readRecordInstruction(base)).toEqual({ mode: instruction, invalid: false });
  expect(loadAmemConfig(base).config.records).toBeUndefined();
});
for (const text of ["{", "{}", '{"instruction":"other"}', '{"instruction":"b","extra":true}', "[]", " ".repeat(65537)]) test(`invalid selection falls back to A (${text.length} bytes)`, () => {
  const base = directory(); writeFileSync(join(base, RECORD_INSTRUCTION_FILE), text, { mode: 0o600 });
  expect(readRecordInstruction(base)).toEqual({ mode: "a", invalid: true });
});
test("non-private, linked and non-regular selection files fail open without following links", () => {
  const base = directory(), file = join(base, RECORD_INSTRUCTION_FILE), other = join(base, "other");
  writeFileSync(file, '{"instruction":"b"}', { mode: 0o644 });
  expect(readRecordInstruction(base)).toEqual({ mode: "a", invalid: true });
  chmodSync(file, 0o600); linkSync(file, other);
  expect(readRecordInstruction(base)).toEqual({ mode: "a", invalid: true });
  rmSync(file); symlinkSync(other, file);
  expect(readRecordInstruction(base)).toEqual({ mode: "a", invalid: true });
  rmSync(file); mkdirSync(file);
  expect(readRecordInstruction(base)).toEqual({ mode: "a", invalid: true });
});
test("invalid selection emits A and a numeric flag, while records=false still wins", async () => {
  const f = hookFixture(); clean.push(f.close); mkdirSync(f.base, { recursive: true });
  writeFileSync(join(f.base, RECORD_INSTRUCTION_FILE), '{"instruction":"bad"}', { mode: 0o600 });
  const input = { source: "resume", session_id: "selection" }, options = { cwd: f.cwd, base: f.base };
  const result = await runHook("SessionStart", input, options, { deadlineMs: 2000 });
  expect(result.output?.hookSpecificOutput.additionalContext).toStartWith("Only when a turn settles");
  expect(readMetrics(f.base).at(-1)).toMatchObject({ recordVariant: "a", recordInstructionInvalid: 1, recordInstructionEmitted: 1 });
  writeFileSync(join(f.base, "amem.config.json"), '{"records":false}');
  await runHook("SessionStart", input, options, { deadlineMs: 2000 });
  expect(readMetrics(f.base).at(-1)).toMatchObject({ recordEnabled: 0, recordInstructionEmitted: 0, recordInstructionInvalid: 1 });
});
