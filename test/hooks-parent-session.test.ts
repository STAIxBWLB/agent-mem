import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture, workMarker } from "./fakes/hooks-fixture.ts";

test("functional SessionStart returns known work without starting a second Bun worker", async () => {
  const f = hookFixture(), marker = join(f.root, "second-boot"), preload = join(f.root, "no-second-bun.ts");
  const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  try {
    await f.seed();
    writeFileSync(preload, `import {writeFileSync} from 'node:fs';const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>{if(Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}){writeFileSync(${JSON.stringify(marker)},'attempted');throw new Error('second Bun boot forbidden');}return spawn(argv,options);};`);
    const result = f.runFunctional("SessionStart", { prompt: "one boot public fixture" }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode).toBe(0); expect(result.stdout.length).toBeGreaterThan(0);
    const context = JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext;
    expect(context).toContain(workMarker);
    expect(context).toContain("curated=unavailable"); expect(context).toContain("curated refresh deferred");
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1200); expect(existsSync(marker)).toBe(false);
  } finally { f.close(); }
});
