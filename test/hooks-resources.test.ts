import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test.skipIf(process.platform !== "linux")("hook peak excludes pre-exec launcher residency while retaining raw rusage evidence", () => {
  const module = fileURLToPath(new URL("../src/hook-resources.ts", import.meta.url));
  const child = `import {hookPeakRssKB} from ${JSON.stringify(module)};console.log(JSON.stringify({own:hookPeakRssKB(),raw:process.resourceUsage().maxRSS,current:process.memoryUsage().rss/1024}));`;
  const parent = `const pressure=Buffer.alloc(96*1024*1024,1); const r=Bun.spawnSync([process.execPath,'--smol','-e',${JSON.stringify(child)}],{stdout:'pipe',stderr:'pipe',detached:true});console.log(r.stdout.toString());if(pressure[0]!==1||r.exitCode!==0)process.exit(1);`;
  const result = Bun.spawnSync([process.execPath, "--smol", "-e", parent], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const usage = JSON.parse(result.stdout.toString());
  expect(usage.raw).toBeGreaterThan(64 * 1024);
  expect(usage.own).toBeGreaterThan(0); expect(usage.own).toBeGreaterThanOrEqual(usage.current - 4096);
  expect(usage.own).toBeLessThan(usage.raw - 64 * 1024);
});
