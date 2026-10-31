import { expect, test } from "bun:test";
import { join } from "node:path";

// Explicit list: never rediscover this guard in the child and recurse.
const files = ["cli-projects", "project-export", "capture", "ingest", "qwen-ingest", "hooks-network"];
const preload = join(import.meta.dir, "fakes/capture-future-clock.mjs");
for (const name of files) {
  test(`capture fixtures survive a clock advanced by 180 days: ${name}`, async () => {
    const child = Bun.spawn([process.execPath, "test", "--preload", preload, `./test/${name}.test.ts`, "--timeout", "20000"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, AGENTHUB_HOME: "", AMEM_HOME: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  }, 60000);
}

test("future clock reaches restricted-env Bun children and preserves explicit dates", async () => {
  const probe = `const offset=Date.now()-performance.timeOrigin;
if(offset<179*86400000||offset>181*86400000)throw Error('Date.now was not advanced');
if(Math.abs(new Date().getTime()-Date.now())>1000)throw Error('zero-argument Date disagrees');
if(Math.abs(Date.parse(Date())-Date.now())>2000)throw Error('Date() disagrees');
if(Date.parse('2026-10-17T00:00:00Z')!==1792195200000)throw Error('explicit time changed');`;
  const source = `${probe}
const child=Bun.spawnSync([process.execPath,'--eval',${JSON.stringify(probe)}],{env:{},stdout:'pipe',stderr:'pipe'});
if(child.exitCode!==0)throw Error(child.stderr.toString());`;
  const child = Bun.spawn([process.execPath, "--preload", preload, "--eval", source], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
});
