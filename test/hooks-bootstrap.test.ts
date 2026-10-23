import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookBin, hookFixture } from "./fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";

test("hook bootstrap enters smol before imports with the same PID stdin preload and original start", () => {
  const f = hookFixture(), log = join(f.root, "bootstrap.jsonl"), preload = join(f.root, "bootstrap-observer.ts");
  try {
    writeFileSync(preload, `import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,smol:process.execArgv.includes("--smol"),at:Date.now(),boot:process.env.AMEM_HOOK_BOOT_AT??null})+"\\n");`);
    const start = performance.now();
    const result = Bun.spawnSync([process.execPath, "--preload", preload, hookBin, "hook", "PostToolUse"], {
      cwd: f.cwd, env: f.env, stdin: Buffer.from(JSON.stringify({ cwd: f.cwd, hook_event_name: "PostToolUse", prompt: "bootstrap stdin retained" })), stdout: "pipe", stderr: "pipe", timeout: 3000,
    });
    const wall = performance.now() - start;
    expect(result.exitCode).toBe(0);
    const records = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records.map(r => [r.pid, r.smol])).toEqual([[result.pid, false], [result.pid, true]]);
    expect(Number(records[1]!.boot)).toBeLessThanOrEqual(records[0]!.at + 1);
    const metric = readMetrics(f.base).filter(r => r.kind === "hook"); expect(metric).toHaveLength(1);
    expect(metric[0]!.wallMs).toBeGreaterThanOrEqual(records[1]!.at - records[0]!.at);
    expect(metric[0]!.wallMs).toBeLessThanOrEqual(wall + 5);
    for (let pass = 0; pass < 4 && !f.rows().some(row => row.excerpt === "bootstrap stdin retained"); pass++) expect(f.run("PostToolUse", { prompt: `bootstrap replay barrier ${pass}` }).exitCode).toBe(0);
    expect(f.rows().filter(row => row.excerpt === "bootstrap stdin retained")).toHaveLength(1);
  } finally { f.close(); }
});

test("the published executable starts directly in smol mode without a second bootstrap", () => {
  const f = hookFixture(), log = join(f.root, "native-boot.jsonl"), preload = join(f.root, "native-boot-observer.ts");
  try {
    writeFileSync(preload, `import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,smol:process.execArgv.includes("--smol")})+"\\n");`);
    const result = f.run("PostToolUse", { prompt: "published entrypoint" }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(log,"utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([{pid:result.pid,smol:true}]);
  } finally { f.close(); }
});
