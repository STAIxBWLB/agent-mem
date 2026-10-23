import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test.skipIf(process.platform !== "linux")("hook peak excludes pre-exec launcher residency while retaining raw rusage evidence", () => {
  const module = fileURLToPath(new URL("../src/hook-resources.ts", import.meta.url));
  const child = `import {hookPeakRssKB} from ${JSON.stringify(module)};const before=hookPeakRssKB();let pressure=Buffer.alloc(16*1024*1024,1);const marker=pressure[0],allocated=hookPeakRssKB();pressure=null;Bun.gc(true);console.log(JSON.stringify({before,allocated,marker,own:hookPeakRssKB(),raw:process.resourceUsage().maxRSS,current:process.memoryUsage().rss/1024}));`;
  const parent = `const pressure=Buffer.alloc(128*1024*1024,1); const r=Bun.spawnSync([process.execPath,'--smol','-e',${JSON.stringify(child)}],{stdout:'pipe',stderr:'pipe',detached:true});console.log(r.stdout.toString());if(pressure[0]!==1||r.exitCode!==0)process.exit(1);`;
  const result = Bun.spawnSync([process.execPath, "--smol", "-e", parent], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const usage = JSON.parse(result.stdout.toString());
  console.log("hook RSS proof", JSON.stringify(usage));
  expect(usage.raw).toBeGreaterThan(64 * 1024);
  expect(usage.marker).toBe(1); expect(usage.allocated).toBeGreaterThanOrEqual(usage.before + 12 * 1024);
  expect(usage.own).toBeGreaterThanOrEqual(usage.allocated);
  expect(usage.own).toBeGreaterThan(0); expect(usage.own).toBeGreaterThanOrEqual(usage.current - 4096);
  expect(usage.own).toBeLessThan(usage.raw - 64 * 1024);
});

test.skipIf(process.platform !== "linux")("actual hook metrics retain raw launcher high-water separately from the hook image peak", async () => {
  const { hookFixture, hookBin } = await import("./fakes/hooks-fixture.ts");
  const { join } = await import("node:path");
  const f = hookFixture();
  try {
    const payload = { hook_event_name: "PostToolUse", cwd: f.cwd, prompt: "production hook RSS proof" };
    const script = `const pressure=Buffer.alloc(128*1024*1024,1);const r=Bun.spawnSync(${JSON.stringify([hookBin, "hook", "PostToolUse"])},{cwd:${JSON.stringify(f.cwd)},env:${JSON.stringify(f.env)},stdin:Buffer.from(${JSON.stringify(JSON.stringify(payload))}),stdout:'pipe',stderr:'pipe',detached:true,timeout:3000});if(r.exitCode!==0||pressure[0]!==1)process.exit(1);console.log((await Bun.file(${JSON.stringify(join(f.base, "metrics.jsonl"))}).text()).trim());`;
    const result = Bun.spawnSync([process.execPath, "--smol", "-e", script], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const metric = JSON.parse(result.stdout.toString());
    console.log("native hook RSS proof", JSON.stringify({ ownCombinedMB: metric.rssMB, rawCombinedMB: metric.rawRssMB }));
    expect(metric.kind).toBe("hook"); expect(metric.rssMB).toBeGreaterThan(0);
    expect(metric.rawRssMB).toBeGreaterThan(128); expect(metric.rssMB).toBeLessThan(metric.rawRssMB - 64);
  } finally { f.close(); }
}, 10000);
