import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture, workMarker } from "./fakes/hooks-fixture.ts";
import { sessionStartBrief } from "../src/session-brief.ts";

test("native SessionStart preserves known work when the optional capture module cannot load", async () => {
  const f = hookFixture(), preload = join(f.root, "optional-capture-fault.ts"), worker = resolve(import.meta.dir, "../src/session-brief-worker.ts"), marker = join(f.root, "optional-attempted");
  try {
    await f.seed();
    writeFileSync(preload, `import {writeFileSync} from "node:fs";const marker=${JSON.stringify(marker)},worker=${JSON.stringify(worker)},preload=${JSON.stringify(preload)};
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>spawn(Array.isArray(argv)&&argv[2]===worker?[argv[0],argv[1],'--preload',preload,...argv.slice(2)]:argv,options);
if(process.argv[1]===worker)Bun.plugin({name:'optional-capture-fault',setup(b){b.onLoad({filter:/memory\\/capture\\.ts$/},()=>{writeFileSync(marker,'attempted');throw new Error('synthetic unavailable optional capture module');});}});
`);
    const result = f.run("SessionStart", { prompt: "priority capture retained" }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString(), `optional module attempted=${existsSync(marker)}; stderr=${result.stderr.toString()}`).not.toBe("");
    const context = JSON.parse(result.stdout.toString()).hookSpecificOutput?.additionalContext;
    expect(context).toContain(workMarker); expect(context).toContain("Untrusted project memory");
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1200); expect(context).toContain("capture=unavailable");
    for (let i = 0; i < 4 && !f.rows().some(row => row.excerpt === "priority capture retained"); i++) f.run("PostToolUse", { prompt: `priority replay ${i}` });
    expect(f.rows().filter(row => row.excerpt === "priority capture retained")).toHaveLength(1);
  } finally { f.close(); }
});

test("a native-sized brief budget keeps work and defers cold optional stores", async () => {
  const f = hookFixture();
  try {
    await f.seed();
    const brief = await sessionStartBrief({ cwd: f.cwd, base: f.base, project: f.project, timeRemaining: () => 70 });
    expect(brief.context).toContain(workMarker);
    expect(brief.coverage).toEqual({ work: "complete", curated: "unavailable", capture: "unavailable" });
    expect(brief.tokens).toBeLessThanOrEqual(1200);
  } finally { f.close(); }
});

test("a repeated full-tier refusal cannot discard the brief already computed by recovery", async () => {
  const f = hookFixture(), preload = join(f.root, "repeat-full.ts");
  try {
    await f.seed();
    writeFileSync(preload, `import {readFileSync} from 'node:fs';
Bun.plugin({name:'repeat-full-admission',setup(b){b.onLoad({filter:/hook-spool\\.ts$/},({path})=>({loader:'ts',contents:readFileSync(path,'utf8').replace('export async function stageHookCapture(event: string, input: unknown, options: Options): Promise<PendingHookCapture | undefined> {','export async function stageHookCapture(event: string, input: unknown, options: Options): Promise<PendingHookCapture | undefined> { throw new HookSpoolFull();')}));}});`);
    const result = f.run("SessionStart", {}, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext).toContain(workMarker);
  } finally { f.close(); }
});
