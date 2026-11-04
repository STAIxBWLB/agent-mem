import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodePhaseTrace, PHASE_BYTES, PHASE_MAGIC, PHASE_SLOTS } from "../src/hook-phase-diagnostic.ts";

test("task123 phase trace is shared across processes, bounded, and survives an owned child kill", async () => {
  const root = mkdtempSync(join(tmpdir(), "task123-phase-")), file = join(root, "trace");
  const bytes = Buffer.alloc(PHASE_BYTES); bytes.writeUInt32LE(PHASE_MAGIC, 0); bytes.writeUInt32LE(1, 4); writeFileSync(file, bytes, { mode: 0o600 });
  const module = resolve(import.meta.dir, "../src/hook-phase-diagnostic.ts");
  const code = `import {phase} from ${JSON.stringify(module)};for(let i=0;i<250;i++)phase(30,i);phase(44,7,9);console.log('ready');await Bun.sleep(5000);`;
  const child = Bun.spawn([process.execPath, "--smol", "-e", code], { env: { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root, AMEM_TASK123_TRACE: file, AMEM_TASK123_WORKER: "1" }, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    try { expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready"); }
    finally { reader.releaseLock(); }
    const live = decodePhaseTrace(readFileSync(file));
    expect(live.available).toBe(true);
    if (!live.available) throw Error("task123 phase trace was not readable; fix the probe before measuring workers");
    expect(live.workerPid).toBe(child.pid); expect(live.lastSeq).toBe(251);
    expect(live.records).toHaveLength(PHASE_SLOTS); expect(live.overwritten).toBe(251 - PHASE_SLOTS);
    expect(live.last).toMatchObject({ code: 44, phase: "store.append.enter", value: 7, count: 9 });
    child.kill("SIGKILL"); await child.exited;
    expect(decodePhaseTrace(readFileSync(file))).toEqual(live);
  } finally { child.kill("SIGKILL"); await child.exited; rmSync(root, { recursive: true, force: true }); }
});

test("task123 phase decoder refuses missing or malformed traces", () => {
  expect(decodePhaseTrace(new Uint8Array(4))).toEqual({ available: false, reason: "trace-size" });
  expect(decodePhaseTrace(new Uint8Array(PHASE_BYTES))).toEqual({ available: false, reason: "trace-header" });
});
