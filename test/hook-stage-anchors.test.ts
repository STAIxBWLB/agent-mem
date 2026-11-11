import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertHookStageAnchorsHealthy, hookStageAnchors, hookStagePreload, instrumentHookStageSource, validateHookStageSources, type HookStageFile } from "./fakes/hook-stage-preload.ts";

const root = resolve(import.meta.dir, "..");
const files = Object.keys(hookStageAnchors) as HookStageFile[];

test("every stage anchor occurs exactly once in the current source tree", () => {
  expect(files).toHaveLength(6);
  expect(files.reduce((count, file) => count + hookStageAnchors[file].length, 0)).toBe(32);
  validateHookStageSources(root);
  const names = new Set<string>();
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const instrumented = instrumentHookStageSource(file, source);
    expect(() => new Bun.Transpiler({ loader: file.endsWith(".js") ? "js" : "ts" }).transformSync(instrumented)).not.toThrow();
    for (const [name] of hookStageAnchors[file]) {
      expect(names.has(name)).toBe(false);
      names.add(name);
      expect(instrumented.split(`__amemHookStage('${name}')`).length - 1).toBe(1);
    }
  }
});

test("every missing or duplicate anchor names its stage and source file", () => {
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    for (const [name, needle] of hookStageAnchors[file]) {
      const missing = source.replace(needle, "");
      const duplicate = source + "\n" + needle;
      for (const [text, count] of [[missing, 0], [duplicate, 2]] as const) {
        expect(() => instrumentHookStageSource(file, text)).toThrow(`hook stage anchor ${name} in ${file}: expected exactly once, found ${count}`);
      }
    }
  }
});

test("a caught preload import failure remains a hard diagnostic failure even on hosted CI", () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-stage-anchors-"));
  try {
    const preload = join(dir, "preload.ts"), trace = join(dir, "trace.jsonl"), failure = join(dir, "failure.txt");
    writeFileSync(failure, "");
    writeFileSync(preload, hookStagePreload(join(dir, "worker.ts"), trace, preload, failure));
    // Same import-error catch as the executable's fail-open hook path; the process still exits zero.
    writeFileSync(join(dir, "hooks.ts"), "export const changed = true;");
    const result = Bun.spawnSync([process.execPath, "--preload", preload, "-e", `try { await import(${JSON.stringify(join(dir, "hooks.ts"))}); } catch {} `], {
      env: { ...process.env, CI: "true", GITHUB_ACTIONS: "true" }, stdout: "pipe", stderr: "pipe", timeout: 2000,
    });
    expect(result.exitCode).toBe(0);
    expect(() => assertHookStageAnchorsHealthy(failure)).toThrow("hook stage anchor parent-entry in src/hooks.ts: expected exactly once, found 0");
    writeFileSync(failure, "");
    expect(() => assertHookStageAnchorsHealthy(failure)).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
