import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";

// #226: the bounded transcript scan runs in the hook parent before the worker spawns. A slow worker start can no
// longer take the scan's slice, the worker never scans a second time, and hooks without a transcript never load it.
const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0)) close(); });
const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts"), hooks = resolve(import.meta.dir, "../src/hooks.ts");

function fixture() {
  const f = hookFixture(); clean.push(f.close);
  const transcript = join(f.root, "transcript.jsonl"), at = new Date().toISOString();
  writeFileSync(transcript, [{ type: "system", subtype: "away_summary", timestamp: at, content: "parent recap 226" },
    { type: "user", isCompactSummary: true, timestamp: at, message: { content: "parent compact 226" } }].map(row => JSON.stringify(row)).join("\n") + "\n");
  // Preload for both processes: the worker sleeps 200 ms before anything else (a cold, contended start) and records
  // whether it was asked to scan; any process that loads hook-transcript.ts records its role.
  const marks = join(f.root, "marks.jsonl"), preload = join(f.root, "slow-worker.ts");
  writeFileSync(marks, "");
  writeFileSync(preload, `import {appendFileSync,readFileSync} from 'node:fs';
const marks=${JSON.stringify(marks)},worker=${JSON.stringify(worker)},preload=${JSON.stringify(preload)};
const role=process.argv[2]===worker?'worker':'parent';
Bun.plugin({name:'mark-226',setup(b){b.onLoad({filter:/[/]hook-transcript\\.ts$/},({path})=>{appendFileSync(marks,JSON.stringify({loaded:role})+'\\n');return {loader:'ts',contents:readFileSync(path,'utf8')};});}});
if(role==='worker'){const until=performance.now()+200;while(performance.now()<until){}}
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>{if(Array.isArray(argv)&&argv[2]===worker){
 const input=options?.stdin;if(input)try{const p=JSON.parse(Buffer.from(input).toString());appendFileSync(marks,JSON.stringify({workerTranscript:p.transcript!==undefined})+'\\n');}catch{}
 return spawn([argv[0],argv[1],'--preload',preload,...argv.slice(2)],options);}return spawn(argv,options);};`);
  const entry = join(f.root, "entry.ts");
  writeFileSync(entry, `import { hookMain } from ${JSON.stringify(hooks)};await hookMain(process.argv.slice(2),performance.now());`);
  const run = (event: string, payload: Record<string, unknown>) => {
    const result = Bun.spawnSync([process.execPath, "--smol", "--preload", preload, entry, event], { cwd: f.cwd, env: f.env,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: event, cwd: f.cwd, session_id: "s226", ...payload })), stdout: "pipe", stderr: "pipe", timeout: 5000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
  };
  const read = () => readFileSync(marks, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { loaded?: string; workerTranscript?: boolean });
  return { ...f, transcript, run, read };
}

for (const event of ["Stop", "SessionEnd"] as const) test(`a deliberately slow worker start no longer stops the parent committing summaries: ${event}`, async () => {
  const f = fixture(); await f.seed();
  // The real 140 ms handler. The worker spends 200 ms before doing anything, so before #226 it could scan nothing.
  const metric = f.run(event, { transcript_path: f.transcript, last_assistant_message: "answer" });
  expect(metric.transcriptOffset).toBeGreaterThan(0);
  // Durable after replay: the summaries the parent staged reach the capture store on the next ordinary hook.
  f.run("PostToolUse", { tool_name: "Read", tool_response: "barrier" });
  const rows = f.rows();
  expect(rows.some(row => row.event === "Recap" && row.excerpt.includes("parent recap 226"))).toBe(true);
  expect(rows.some(row => row.event === "Compact" && row.excerpt.includes("parent compact 226"))).toBe(true);
  const marks = f.read();
  expect(marks.filter(mark => mark.loaded === "parent")).toHaveLength(1);
  expect(marks.filter(mark => mark.loaded === "worker")).toHaveLength(0);              // the worker never scans: no double scan
  expect(marks.filter(mark => mark.workerTranscript === true)).toHaveLength(0);
});

test("hooks without a transcript never load the transcript scanner", async () => {
  const f = fixture(); await f.seed();
  f.run("PostToolUse", { tool_name: "Read", tool_response: "plain" });
  f.run("Stop", { last_assistant_message: "no transcript path" });
  expect(f.read().filter(mark => mark.loaded)).toEqual([]);
});

test("a thrown parent scan still reports `unavailable` and the worker does not retry the scan", async () => {
  const f = fixture(); await f.seed();
  const { symlinkSync } = await import("node:fs");
  const link = f.transcript + ".link"; symlinkSync(f.transcript, link);
  const metric = f.run("Stop", { transcript_path: link, last_assistant_message: "answer" });
  expect(metric.transcriptStopReason).toBe("unavailable");
  expect(f.read().filter(mark => mark.workerTranscript === true)).toHaveLength(0);
});
