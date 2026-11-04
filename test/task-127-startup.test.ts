import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { analyze } from "../scripts/task-127-instrument.ts";

for (const stage of ["before-prefix", "start-record", "binary-open", "entry-written", "header-written"]) {
  test(`task127 startup kill boundary retains attributable prefix: ${stage}`, () => {
    const root = mkdtempSync(join(tmpdir(), "task127-startup-control-")), callId = "00000000-0000-0000-0000-000000000001";
    try {
      const intent = { callId, parentPid: process.pid, expectedRole: "worker", intendedAt: Date.now() };
      writeFileSync(join(root, callId + ".intent.json"), JSON.stringify(intent));
      const script = `import{publishStartup}from${JSON.stringify(resolve(import.meta.dir, "../scripts/task-127-startup.ts"))};import{writeFileSync}from'node:fs';import{join}from'node:path';const target=${JSON.stringify(stage)};if(target==='before-prefix')process.kill(process.pid,'SIGKILL');publishStartup({trace:${JSON.stringify(root)},callId:${JSON.stringify(callId)},pid:process.pid,role:'worker',identify(){writeFileSync(join(${JSON.stringify(root)},'identity.called'),'yes');return{pid:process.pid,available:true,startIdentity:process.pid+':1'};},afterStage(stage){if(stage===target)process.kill(process.pid,'SIGKILL');}});`;
      const child = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
      expect(child.signalCode, child.stderr.toString()).toBe("SIGKILL");
      // The parent owns the subprocess handle/PID even when no child JS prefix could be published.
      const binding = { callId, pid: child.pid, parentPid: process.pid, controlledSignal: child.signalCode };
      writeFileSync(join(root, callId + ".spawn.json"), JSON.stringify(binding));
      writeFileSync(join(root, callId + ".call.json"), JSON.stringify({ callId, event: "Stop", logicalRun: 1, followUp: 0 }));
      const log = join(root, "stdout.log"); writeFileSync(log, JSON.stringify({ diagnostic: "transcript-budget-invocation", event: "Stop", logicalRun: 1, followUp: 0 }));
      const decoded = analyze(root, log) as { calls: { startupAttribution: { childEntryPrefixObserved: boolean; validatedChildPhaseObserved: boolean } }[] };
      const attribution = decoded.calls[0]!.startupAttribution;
      expect(attribution.childEntryPrefixObserved).toBe(stage === "entry-written" || stage === "header-written");
      expect(attribution.validatedChildPhaseObserved).toBe(stage === "header-written");
      expect(JSON.parse(readFileSync(join(root, callId + ".intent.json"), "utf8")).callId).toBe(binding.callId);
      expect(binding.pid).toBeGreaterThan(0);
      const prefixes = readdirSync(root).filter(name => name.endsWith(".start.json"));
      if (stage === "before-prefix") { expect(prefixes).toHaveLength(0); return; }
      expect(prefixes).toHaveLength(1);
      const prefix = JSON.parse(readFileSync(join(root, prefixes[0]!), "utf8"));
      expect(prefix).toMatchObject({ callId, pid: child.pid, role: "worker", startupProtocol: 2 });
      const binary = join(root, `${callId}-${child.pid}.bin`), header = join(root, `${callId}-${child.pid}.json`);
      if (stage === "start-record") expect(existsSync(binary)).toBe(false);
      else if (stage === "binary-open") expect(readFileSync(binary)).toHaveLength(0);
      else {
        const bytes = readFileSync(binary); expect(bytes).toHaveLength(32); expect(bytes.readUInt32LE(0)).toBe(1); expect(bytes.readUInt32LE(4)).toBe(0);
      }
      expect(existsSync(header)).toBe(stage === "header-written");
      expect(existsSync(join(root, "identity.called"))).toBe(stage === "header-written");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
