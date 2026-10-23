import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookBin, hookEvents, hookFixture } from "./fakes/hooks-fixture.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture() {
  // This suite measures network attempts, with expensive builtin instrumentation in both processes.
  // The independent R2 script retains its no-remote identity workload and actual clocks.
  const f = hookFixture("https://example.invalid/p3/offline-fixture.git"); fixtures.push(f);
  const bin = join(f.root, "tripwire-bin"), marker = join(f.root, "network-attempts.jsonl"), preload = join(f.root, "tripwire.ts");
  const receipt = join(f.root, "brief-instrumentation.jsonl"), worker = join(import.meta.dir, "../src/session-brief-worker.ts");
  mkdirSync(bin);
  // A fail-open hook can swallow the exception. The append-only marker still proves that it tried networking.
  writeFileSync(preload, `import {appendFileSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const hookBin=${JSON.stringify(hookBin)},marker=${JSON.stringify(marker)},receipt=${JSON.stringify(receipt)},worker=${JSON.stringify(worker)},preload=${JSON.stringify(preload)};
globalThis.__AMEM_NETWORK_TRIPWIRE__=true;
const trip=(name)=>{appendFileSync(marker,JSON.stringify({name})+'\\n');throw Error('fixture network tripwire');};
globalThis.fetch=(...args)=>trip('fetch');
globalThis.WebSocket=class {constructor(){trip('WebSocket');}};
for(const [name,keys] of Object.entries({'node:http':['request','get'],'node:https':['request','get'],'node:net':['connect','createConnection'],'node:tls':['connect'],'node:dns':['lookup','resolve','resolve4','resolve6'],'node:dns/promises':['lookup','resolve','resolve4','resolve6']})){
 const module=require(name);for(const key of keys)module[key]=()=>trip(name+'.'+key);
}
require('node:net').Socket.prototype.connect=function(){return trip('Socket.connect');};
Bun.connect=()=>trip('Bun.connect');
// Observe the actual parent brief entry as well as the remaining fixed worker path.
globalThis.__AMEM_BRIEF_ENTRY__=()=>{appendFileSync(receipt,JSON.stringify({kind:'parent-brief'})+String.fromCharCode(10));if(process.env.AMEM_BRIEF_TRIP_CONTROL==='1'){try{fetch('https://example.invalid');}catch{}}};
Bun.plugin({name:'parent-brief-network-control',setup(b){b.onLoad({filter:/session-brief\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),needle='export async function sessionStartBrief(options: BriefOptions): Promise<BriefResult> {';
 if(source.split(needle).length!==2)throw Error('parent brief diagnostic anchor changed');
 const control="globalThis.__AMEM_BRIEF_ENTRY__();";
 return {loader:'ts',contents:source.replace(needle,needle+control)};
});}});
// Instrument only the package's fixed worker. Production's child environment remains restricted.
const nativeSpawn=Bun.spawn.bind(Bun);
Bun.spawn=(command,options)=>{
 if(Array.isArray(command)&&command[0]===process.execPath&&command[1]==='--smol'&&command[2]===worker){
  appendFileSync(receipt,JSON.stringify({kind:'spawned'})+'\\n');
  return nativeSpawn([command[0],'--smol','--preload',preload,...command.slice(2)],{...options,env:{...options?.env,AMEM_NETWORK_MARKER:marker,AMEM_BRIEF_TRIP_CONTROL:process.env.AMEM_BRIEF_TRIP_CONTROL}});
 }
 return nativeSpawn(command,options);
};
if(process.argv[1]===worker){
 appendFileSync(receipt,JSON.stringify({kind:'loaded'})+'\\n');
 if(process.env.AMEM_BRIEF_TRIP_CONTROL==='1'){try{fetch('https://example.invalid');}catch{}}
}
`);
  for (const command of ["curl", "wget", "ssh", "scp", "npm", "npx", "claude", "codex", "kimi", "pi", "qwen", "jcode", "ollama", "openai"]) {
    writeFileSync(join(bin, command), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(process.env.AMEM_NETWORK_MARKER,JSON.stringify({name:${JSON.stringify(command)}})+'\\n');process.exit(79);\n`, { mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = { ...f.env, PATH: `${bin}:${f.env.PATH ?? ""}`, AMEM_NETWORK_MARKER: marker, BUN_OPTIONS: `--preload=${preload}` };
  return { ...f, env, marker, preload,
    attempts: () => existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { name: string }) : [],
    receipts: () => existsSync(receipt) ? readFileSync(receipt, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { kind: string }) : [],
    child(args: string[], stdin = "", extra: NodeJS.ProcessEnv = {}) {
      // This suite proves offline behavior and entered tripwires, independently of R2 runner speed.
      if (args[0] === hookBin && args[1] === "hook") return f.runFunctional(args[2]!, stdin, { ...env, ...extra });
      return Bun.spawnSync([process.execPath, ...(args[0] === hookBin ? ["--smol"] : []), "--preload", preload, ...args], { cwd: f.cwd, env: { ...env, ...extra }, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe", timeout: 5000, maxBuffer: 64 * 1024 });
    },
  };
}

function boundedContextIfPresent(stdout: string) {
  expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(8192);
  if (!stdout.trim()) return;
  const output = JSON.parse(stdout), context = output.hookSpecificOutput?.additionalContext;
  expect(output.hookSpecificOutput?.hookEventName).toBe("SessionStart"); expect(typeof context).toBe("string");
  expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1200);
  expect(stdout).not.toMatch(/"(?:decision|permissionDecision|updatedInput|block)"\s*:|"continue"\s*:\s*false/);
}
function pendingCaptures(f: ReturnType<typeof fixture>, event: string, excerpt: string) {
  const dir = join(f.base, "hook-spool");
  const matches = existsSync(dir) ? readdirSync(dir).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))
    .map(name => JSON.parse(readFileSync(join(dir, name), "utf8")))
    .filter(value => value.schema === "agent-mem.hook-capture/v1" && value.cwd === f.cwd && value.capture?.event === event && value.capture?.excerpt === excerpt) : [];
  for (const value of matches) {
    expect(value.capture.agent).toBe("claude"); expect(Number.isFinite(Date.parse(value.capture.at))).toBe(true);
    expect(Array.isArray(value.capture.paths)).toBe(true); expect(value.capture.paths.length).toBeLessThanOrEqual(32);
    expect(Number.isFinite(value.capture.bytes)).toBe(true); expect(Buffer.byteLength(value.capture.excerpt)).toBeLessThanOrEqual(8000);
  }
  return matches;
}
function replayOffline(f: ReturnType<typeof fixture>, event: string, excerpt: string) {
  const barriers: string[] = []; let rows = f.rows();
  const matching = (kind: string, text: string) => rows.filter(row => row.event === kind && row.excerpt === text && row.project === f.project);
  for (let i = 0; i < 4; i++) {
    const marker = `network ${event} replay barrier ${i}`, before = f.receipts().length;
    const result = f.child([hookBin, "hook", "PostToolUse"], JSON.stringify({ cwd: f.cwd, hook_event_name: "PostToolUse", prompt: marker }));
    expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe("");
    expect(f.receipts().slice(before)).toEqual([{ kind: "spawned" }, { kind: "loaded" }]); expect(f.attempts()).toEqual([]);
    barriers.push(marker); rows = f.rows();
    if (matching(event, excerpt).length === 1 && pendingCaptures(f, event, excerpt).length === 0 && barriers.some(text => matching("PostToolUse", text).length === 1)) break;
  }
  expect(matching(event, excerpt)).toHaveLength(1); expect(pendingCaptures(f, event, excerpt)).toHaveLength(0);
  expect(barriers.some(text => matching("PostToolUse", text).length === 1)).toBe(true);
  for (const marker of barriers) {
    const saved = matching("PostToolUse", marker), pending = pendingCaptures(f, "PostToolUse", marker);
    expect(saved.length).toBeLessThanOrEqual(1); expect(pending.length).toBeLessThanOrEqual(1);
    expect(saved.length === 1 || pending.length === 1).toBe(true);
    if (saved.length && pending.length) expect(saved[0]!.at).toBe(pending[0]!.capture.at);
  }
}

test("AC3 network tripwires have positive controls for swallowed fetch, sockets, DNS and PATH commands", () => {
  const f = fixture();
  const control = f.child(["--eval", `for(const run of [()=>fetch('https://example.invalid'),()=>new WebSocket('wss://example.invalid'),()=>require('node:http').get('http://example.invalid'),()=>require('node:net').connect(443,'example.invalid'),()=>require('node:dns').lookup('example.invalid')]){try{await run();}catch{}};Bun.spawnSync(['curl','https://example.invalid'],{env:process.env});const inherited=Bun.spawnSync([process.execPath,'--eval',${JSON.stringify("if(globalThis.__AMEM_NETWORK_TRIPWIRE__!==true)process.exit(4);try{await fetch('https://example.invalid');}catch{}")}],{env:process.env});if(inherited.exitCode!==0)throw Error('inherited preload control failed');`]);
  expect(control.exitCode).toBe(0);
  const names = f.attempts().map(row => row.name);
  for (const name of ["fetch", "WebSocket", "node:http.get", "node:net.connect", "node:dns.lookup", "curl"]) expect(names).toContain(name);
  expect(names.filter(name => name === "fetch")).toHaveLength(2); // Explicit preload and inherited BUN_OPTIONS both trip.
});

test("AC3 actual parent SessionStart brief tripwire observes a swallowed fetch attempt", async () => {
  const f = fixture(); await f.seed();
  const input = JSON.stringify({ hook_event_name: "SessionStart", cwd: f.cwd, session_id: "brief-network-control" });
  const result = f.child([hookBin, "hook", "SessionStart"], input, { AMEM_BRIEF_TRIP_CONTROL: "1" });
  expect(result.exitCode).toBe(0);
  boundedContextIfPresent(result.stdout.toString());
  expect(f.receipts()).toEqual([{ kind: "parent-brief" }]);
  expect(f.attempts()).toEqual([{ name: "fetch" }]);
});

test("AC3 actual executable hooks and SessionStart context do not attempt network or provider commands", async () => {
  const f = fixture(); await f.seed();
  for (const event of hookEvents) {
    const receiptCount = f.receipts().length, captureIds = new Set(f.rows().map(row => row.id));
    const excerpt = `network original ${event}`;
    const result = f.child([hookBin, "hook", event], JSON.stringify({ hook_event_name: event, cwd: f.cwd, session_id: "network-fixture", prompt: excerpt, tool_name: "Read", tool_input: { file_path: "src/public.ts" }, tool_response: excerpt }));
    expect(result.exitCode).toBe(0);
    expect(f.receipts().slice(receiptCount)).toEqual(event === "SessionStart" ? [{ kind: "parent-brief" }] : [{ kind: "spawned" }, { kind: "loaded" }]);
    if (event === "SessionStart") {
      boundedContextIfPresent(result.stdout.toString());
      expect(f.receipts()).toEqual([{ kind: "parent-brief" }]);
    }
    expect(f.attempts()).toEqual([]);
    replayOffline(f, event, excerpt);
    expect(f.rows().filter(row => !captureIds.has(row.id) && row.event === event && row.excerpt === excerpt && row.project === f.project)).toHaveLength(1);
  }
  expect(f.rows().some(row => row.event === "PostToolUse")).toBe(true);
});

test("AC3 native Codex ingest executable remains offline and actually imports the project record", () => {
  const f = fixture(), sessions = join(f.env.CODEX_HOME!, "sessions", "2026", "10", "23"); mkdirSync(sessions, { recursive: true });
  const at = "2026-10-23T01:00:00.000Z", text = "p3-offline-ingest-positive-marker";
  writeFileSync(join(sessions, "rollout-fixture.jsonl"), [
    { timestamp: at, type: "session_meta", payload: { cwd: f.cwd, id: "network-fixture" } },
    { timestamp: at, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const result = f.child([hookBin, "ingest", "codex"]);
  expect(result.exitCode).toBe(0); expect(f.rows().some(row => row.excerpt.includes(text))).toBe(true);
  expect(f.attempts()).toEqual([]);
});

test("AC3 direct capture append path stays offline under the same runtime tripwires", () => {
  const f = fixture(), source = join(import.meta.dir, "../src/memory/capture.ts");
  const result = f.child(["--eval", `const {CaptureStore}=await import(${JSON.stringify(source)});const store=new CaptureStore({memoryDir:process.env.AMEM_HOME,project:${JSON.stringify(f.project)}});try{store.append({project:${JSON.stringify(f.project)},agent:'fixture',event:'PostToolUse',excerpt:'direct-offline-positive-marker'});}finally{store.close();}`]);
  expect(result.exitCode).toBe(0); expect(f.rows().some(row => row.excerpt === "direct-offline-positive-marker")).toBe(true);
  expect(f.attempts()).toEqual([]);
});
