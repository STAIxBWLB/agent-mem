import { expect, test } from "bun:test";
import { join } from "node:path";

// Explicit list: never rediscover this guard in the child and recurse.
const files = ["cli-projects", "project-export", "capture", "ingest", "qwen-ingest", "hooks-network"];
const preload = join(import.meta.dir, "fakes/capture-future-clock.mjs");
for (const name of files) {
  test(`capture fixtures survive a clock advanced by 180 days: ${name}`, async () => {
    const child = Bun.spawn([process.execPath, "--preload", preload, "test", `./test/${name}.test.ts`, "--timeout", "20000"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, AGENTHUB_HOME: "", AMEM_HOME: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  }, 60000);
}
