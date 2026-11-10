import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookTimeoutProbe } from "./fakes/hooks-timeout-probe.ts";

for (const [event, phase, branch] of [
  ["SessionStart", "loader", "pre-admission"],
  ["PreToolUse", "command", "spawned-not-entered"],
] as const) test(`real ${event} ${phase} timeout retains every strict outcome with a mandatory cleanup control`, async () => {
  const f = hookFixture(), run = f.run;
  // Delay only the actual native invocation. Its mandatory control uses its own
  // fixture and must reach every child/entry under the published bin bootstrap and existing host seam.
  f.run = (name, payload, extra = {}) => {
    const preload = extra.BUN_OPTIONS!.slice("--preload=".length), code = readFileSync(preload, "utf8");
    const anchor = phase === "loader" ? " const source=readFileSync(path,'utf8'),guard=" : "const sleeper='sleep 30 &";
    expect(code.split(anchor)).toHaveLength(2);
    writeFileSync(preload, code.replace(anchor, phase === "loader" ? " Bun.sleepSync(200);" + anchor : "const sleeper='/bin/sleep 0.3; sleep 30 &"));
    return run(name, payload, extra);
  };
  try {
    const result = await hookTimeoutProbe(f, event, false);
    expect(result.branch).toBe(branch);
    expect(result.remainingProcesses).toBe(0);
    expect(result.ownedChildren).toBe(phase === "loader" ? 0 : 2);
    expect(result.pending).toMatch(/^hook-/);
    expect(result.rssMB).toBeGreaterThan(0);
  } finally { f.close(); }
}, 10000);
