import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/memory/platform.ts";

test("shared-v1 sync Git preserves the caller's GIT_CONFIG_COUNT key/value environment", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "amem-v1-git-config-")));
  const wrapper = join(dir, "caller.ts"), module = join(import.meta.dir, "../src/memory/sync.ts");
  writeFileSync(wrapper, `for (const key of Object.keys(process.env)) if (/^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)$/.test(key)) delete process.env[key];
Object.assign(process.env,{GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:"amem.callerProbe",GIT_CONFIG_VALUE_0:"supplied-v1-config"});
const {syncGit}=await import(${JSON.stringify(module)});
console.log(JSON.stringify(await syncGit(${JSON.stringify(dir)},["config","--get","amem.callerProbe"])));
`);
  const child = Bun.spawn([process.execPath, wrapper], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ code: 0, out: "supplied-v1-config" });
  } finally { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); }
});
