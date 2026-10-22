import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookBin, hookEvents, hookFixture, workMarker } from "./fakes/hooks-fixture.ts";

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
  writeFileSync(preload, `import {appendFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const marker=${JSON.stringify(marker)},receipt=${JSON.stringify(receipt)},worker=${JSON.stringify(worker)},preload=${JSON.stringify(preload)};
globalThis.__AMEM_NETWORK_TRIPWIRE__=true;
const trip=(name)=>{appendFileSync(marker,JSON.stringify({name})+'\\n');throw Error('fixture network tripwire');};
globalThis.fetch=(...args)=>trip('fetch');
globalThis.WebSocket=class {constructor(){trip('WebSocket');}};
for(const [name,keys] of Object.entries({'node:http':['request','get'],'node:https':['request','get'],'node:net':['connect','createConnection'],'node:tls':['connect'],'node:dns':['lookup','resolve','resolve4','resolve6'],'node:dns/promises':['lookup','resolve','resolve4','resolve6']})){
 const module=require(name);for(const key of keys)module[key]=()=>trip(name+'.'+key);
}
require('node:net').Socket.prototype.connect=function(){return trip('Socket.connect');};
Bun.connect=()=>trip('Bun.connect');
// Instrument only the package's fixed worker. Production's child environment remains restricted.
const nativeSpawn=Bun.spawn.bind(Bun);
Bun.spawn=(command,options)=>{
 if(Array.isArray(command)&&command[0]===process.execPath&&command[1]===worker){
  appendFileSync(receipt,JSON.stringify({kind:'spawned'})+'\\n');
  return nativeSpawn([command[0],'--preload',preload,...command.slice(1)],{...options,env:{...options?.env,AMEM_NETWORK_MARKER:marker,AMEM_BRIEF_TRIP_CONTROL:process.env.AMEM_BRIEF_TRIP_CONTROL}});
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
      return Bun.spawnSync([process.execPath, "--preload", preload, ...args], { cwd: f.cwd, env: { ...env, ...extra }, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe", timeout: 5000, maxBuffer: 64 * 1024 });
    },
  };
}

test("AC3 network tripwires have positive controls for swallowed fetch, sockets, DNS and PATH commands", () => {
  const f = fixture();
  const control = f.child(["--eval", `for(const run of [()=>fetch('https://example.invalid'),()=>new WebSocket('wss://example.invalid'),()=>require('node:http').get('http://example.invalid'),()=>require('node:net').connect(443,'example.invalid'),()=>require('node:dns').lookup('example.invalid')]){try{await run();}catch{}};Bun.spawnSync(['curl','https://example.invalid'],{env:process.env});const inherited=Bun.spawnSync([process.execPath,'--eval',${JSON.stringify("if(globalThis.__AMEM_NETWORK_TRIPWIRE__!==true)process.exit(4);try{await fetch('https://example.invalid');}catch{}")}],{env:process.env});if(inherited.exitCode!==0)throw Error('inherited preload control failed');`]);
  expect(control.exitCode).toBe(0);
  const names = f.attempts().map(row => row.name);
  for (const name of ["fetch", "WebSocket", "node:http.get", "node:net.connect", "node:dns.lookup", "curl"]) expect(names).toContain(name);
  expect(names.filter(name => name === "fetch")).toHaveLength(2); // Explicit preload and inherited BUN_OPTIONS both trip.
});

test("AC3 actual SessionStart brief child tripwire observes a swallowed fetch attempt", async () => {
  const f = fixture(); await f.seed();
  const input = JSON.stringify({ hook_event_name: "SessionStart", cwd: f.cwd, session_id: "brief-network-control" });
  const result = f.child([hookBin, "hook", "SessionStart"], input, { AMEM_BRIEF_TRIP_CONTROL: "1" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.length, JSON.stringify({ attempts: f.attempts(), receipts: f.receipts(), stderr: result.stderr.toString() })).toBeGreaterThan(0);
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput?.additionalContext).toContain(workMarker);
  expect(f.receipts()).toEqual([{ kind: "spawned" }, { kind: "loaded" }]);
  expect(f.attempts()).toEqual([{ name: "fetch" }]);
});

test("AC3 actual executable hooks and SessionStart context do not attempt network or provider commands", async () => {
  const f = fixture(); await f.seed();
  for (const event of hookEvents) {
    const result = f.child([hookBin, "hook", event], JSON.stringify({ hook_event_name: event, cwd: f.cwd, session_id: "network-fixture", prompt: "public fixture", tool_name: "Read", tool_input: { file_path: "src/public.ts" }, tool_response: "public result" }));
    expect(result.exitCode).toBe(0);
    if (event === "SessionStart") {
      expect(JSON.parse(result.stdout.toString()).hookSpecificOutput?.additionalContext).toContain(workMarker);
      expect(f.receipts()).toEqual([{ kind: "spawned" }, { kind: "loaded" }]);
    }
    expect(f.attempts()).toEqual([]);
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
