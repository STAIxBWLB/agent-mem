import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { appendAlias } from "../src/memory/shard.ts";

// Resolve the optional new module inside each named test, so the red-first receipt is an assertion failure.
async function ingestTranscript(kind: "codex" | "kimi" | "pi", options: Record<string, unknown>): Promise<any> {
  const target = "../src/ingest.ts";
  let api: { ingestTranscript?: (...args: any[]) => Promise<any> } = {};
  try { api = await import(target); } catch { /* The named assertion reports the absent feature. */ }
  expect(typeof api.ingestTranscript).toBe("function");
  return api.ingestTranscript!(kind, options);
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const at = "2026-10-23T01:00:00.000Z";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-ingest-")); roots.push(root);
  const cwd = join(root, "project"), other = join(root, "foreign"), base = join(root, "memory"), file = join(root, "transcript.jsonl");
  mkdirSync(cwd); mkdirSync(other);
  return { root, cwd, other, base, file };
}
function rows(f: ReturnType<typeof fixture>) { const store = new CaptureStore({ memoryDir: f.base, project: memoryProjectKey(f.cwd) }); try { return store.rows({ limit: 100 }); } finally { store.close(); } }
const line = (value: unknown) => JSON.stringify(value) + "\n";
const codexHeader = (cwd: string) => ({ timestamp: at, type: "session_meta", payload: { id: "synthetic-session", cwd } });
const codexMessage = (text: string) => ({ timestamp: at, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });

test("Codex ingestion is incremental, waits for partial tails, and replays a lost cursor idempotently", async () => {
  const f = fixture(); writeFileSync(f.file, line(codexHeader(f.cwd)) + line(codexMessage("first public answer")) + JSON.stringify(codexMessage("partial answer")));
  const first = await ingestTranscript("codex", { ...f, files: [f.file] }); expect(first.imported).toBe(1); expect(first.remaining).toBe(true);
  const idle = await ingestTranscript("codex", { ...f, files: [f.file] }); expect(idle.imported).toBe(0);
  appendFileSync(f.file, "\n"); expect((await ingestTranscript("codex", { ...f, files: [f.file] })).imported).toBe(1);
  const store = new CaptureStore({ memoryDir: f.base, project: memoryProjectKey(f.cwd) }); const cursors = join(store.dir, "ingest"); store.close();
  for (const name of readdirSync(cursors)) if (name.endsWith(".db")) rmSync(join(cursors, name));
  const replay = await ingestTranscript("codex", { ...f, files: [f.file] }); expect(replay.imported).toBe(0); expect(rows(f)).toHaveLength(2);
  const cursorText = readdirSync(cursors).filter(n => n.endsWith(".db")).map(n => readFileSync(join(cursors,n),"utf8")).join("");
  expect(cursorText).not.toContain("first public answer"); expect(cursorText).not.toContain(f.cwd);
});

test("Pi accepts native session/message entries but never foreign, untimed, private or denied complete records", async () => {
  const f = fixture();
  writeFileSync(f.file, line({ type: "session", version: 3, id: "session", timestamp: at, cwd: f.cwd })
    + line({ type: "message", id: "one", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "public pi answer" }] } })
    + line({ type: "message", id: "two", timestamp: at, private: true, message: { role: "user", content: "hidden" } })
    + line({ type: "message", id: "three", timestamp: at, extra: "never-retain", message: { role: "user", content: "otherwise public" } })
    + line({ type: "message", id: "four", message: { role: "user", content: "missing time" } })
    + line({ type: "message", id: "five", timestamp: at, cwd: f.other, message: { role: "user", content: "foreign answer" } }));
  let screens = 0;
  const receipt = await ingestTranscript("pi", { ...f, files: [f.file], policy: { host: { async screen(value: unknown) { screens++; return !JSON.stringify(value).includes("never-retain"); } } } });
  expect(receipt.imported).toBe(1); expect(receipt.errors).toBeGreaterThan(0); expect(screens).toBeGreaterThan(1); expect(rows(f).map(r => r.excerpt)).toEqual(["public pi answer"]);
});

test("Kimi native wire records use session state cwd and numeric source time", async () => {
  const f = fixture(), session = join(f.root,"kimi-session"), main = join(session,"agents","main"); mkdirSync(main,{recursive:true});
  writeFileSync(join(session,"state.json"),JSON.stringify({ cwd: f.cwd })); const file=join(main,"wire.jsonl");
  writeFileSync(file,line({type:"metadata",protocol_version:"1.5"}) + line({type:"context.append_message",time:Date.parse(at),message:{role:"assistant",content:[{type:"text",text:"public kimi answer"}]}}));
  expect((await ingestTranscript("kimi",{...f,files:[file]})).imported).toBe(1); expect(rows(f)[0]?.at).toBe(at);
  writeFileSync(join(session,"state.json"),JSON.stringify({cwd:f.other})); appendFileSync(file,line({type:"context.append_message",time:Date.parse(at),message:{role:"assistant",content:"foreign"}}));
  expect((await ingestTranscript("kimi",{...f,files:[file]})).imported).toBe(0); expect(rows(f)).toHaveLength(1);
});

test("bounded passes resume complete records, reset truncation and refuse linked input", async () => {
  const f=fixture();writeFileSync(f.file,line(codexHeader(f.cwd))+line(codexMessage("one"))+line(codexMessage("two")));
  const first=await ingestTranscript("codex",{...f,files:[f.file],maxBytes:400}); expect(first.remaining).toBe(true);
  await ingestTranscript("codex",{...f,files:[f.file],maxBytes:1000}); expect(rows(f)).toHaveLength(2);
  writeFileSync(f.file,line(codexHeader(f.cwd))+line(codexMessage("replacement")));
  await ingestTranscript("codex",{...f,files:[f.file]}); expect(rows(f).some(r=>r.excerpt==="replacement")).toBe(true);
  const link=join(f.root,"linked.jsonl");symlinkSync(f.file,link);expect((await ingestTranscript("codex",{...f,files:[link]})).errors).toBe(1);
});

test("project aliases are resolved at startup and since never fabricates timestamps", async () => {
  const f=fixture();appendAlias(f.base,{alias:memoryProjectKey(f.other),key:memoryProjectKey(f.cwd),actor:"person",machine:"fixture"});
  writeFileSync(f.file,line(codexHeader(f.other))+line(codexMessage("aliased public answer")));
  expect((await ingestTranscript("codex",{...f,files:[f.file],since:"2026-10-22T00:00:00Z"})).imported).toBe(1);
  const unknown=join(f.root,"unknown.jsonl");writeFileSync(unknown,line(codexMessage("no session scope")));
  const r=await ingestTranscript("codex",{...f,files:[unknown]});expect(r.imported).toBe(0);expect(r.errors).toBeGreaterThan(0);expect(JSON.stringify(r)).not.toContain(f.root);
});


test("absent native discovery roots are unavailable, never an observed empty history", async () => {
  const f=fixture(), previous=process.env.CODEX_HOME; process.env.CODEX_HOME=join(f.root,"missing-codex-home");
  try { const receipt=await ingestTranscript("codex",{cwd:f.cwd,base:f.base}); expect(receipt.errors).toBeGreaterThan(0); expect(receipt.reason).toBe("source_unavailable"); }
  finally { if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous; }
});

test("cursor files are private and oversized or linked sidecar state is refused", async () => {
  const f=fixture();writeFileSync(f.file,line(codexHeader(f.cwd))+line(codexMessage("initial")));
  await ingestTranscript("codex",{...f,files:[f.file]});
  const store=new CaptureStore({memoryDir:f.base,project:memoryProjectKey(f.cwd)}),dir=join(store.dir,"ingest");store.close();
  const file=join(dir,readdirSync(dir).find(name=>name.endsWith(".db"))!);chmodSync(file,0o644);
  appendFileSync(f.file,line(codexMessage("next")));await ingestTranscript("codex",{...f,files:[f.file]});expect(statSync(file).mode&0o777).toBe(0o600);
  const canary=join(f.root,"canary");writeFileSync(canary,"unchanged");symlinkSync(canary,file+"-journal");
  appendFileSync(f.file,line(codexMessage("not imported")));
  expect((await ingestTranscript("codex",{...f,files:[f.file]})).errors).toBeGreaterThan(0);expect(readFileSync(canary,"utf8")).toBe("unchanged");rmSync(file+"-journal");
  writeFileSync(file,Buffer.alloc(129*1024));expect((await ingestTranscript("codex",{...f,files:[f.file]})).errors).toBeGreaterThan(0);expect(rows(f).map(r=>r.excerpt)).toEqual(["initial","next"]);
});

test("invalid UTF-8 native records are skipped rather than imported with replacement text", async () => {
  const f=fixture(),prefix='{"timestamp":"'+at+'","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"';
  writeFileSync(f.file,Buffer.concat([Buffer.from(line(codexHeader(f.cwd))+prefix),Buffer.from([255]),Buffer.from('"}]}}\n')]));
  const receipt=await ingestTranscript("codex",{...f,files:[f.file]});expect(receipt.imported).toBe(0);expect(receipt.errors).toBe(1);expect(rows(f)).toHaveLength(0);
});


test("lowering or removing since backfills older records without recapturing newer ones", async () => {
  const f=fixture(),newer={...codexMessage("newer"),timestamp:"2026-10-23T03:00:00Z"};
  writeFileSync(f.file,line(codexHeader(f.cwd))+line(codexMessage("older"))+line(newer));
  expect((await ingestTranscript("codex",{...f,files:[f.file],since:"2026-10-23T02:00:00Z"})).imported).toBe(1);
  expect((await ingestTranscript("codex",{...f,files:[f.file],since:"2026-10-23T00:00:00Z"})).imported).toBe(1);
  expect((await ingestTranscript("codex",{...f,files:[f.file]})).imported).toBe(0);expect(rows(f).map(r=>r.excerpt).sort()).toEqual(["newer","older"]);
});

test("default discovery rotates past a perpetually partial first source", async () => {
  const f=fixture(),native=join(f.root,"native"),sessions=join(native,"sessions"),previous=process.env.CODEX_HOME;mkdirSync(sessions,{recursive:true});process.env.CODEX_HOME=native;
  try {
    writeFileSync(join(sessions,"a.jsonl"),line(codexHeader(f.cwd))+JSON.stringify(codexMessage("still partial")));
    for(const name of ["b","c"])writeFileSync(join(sessions,name+".jsonl"),line(codexHeader(f.cwd))+line(codexMessage("public "+name)));
    for(let i=0;i<4;i++)await ingestTranscript("codex",{cwd:f.cwd,base:f.base,maxFiles:1});
    expect(rows(f).map(r=>r.excerpt).sort()).toEqual(["public b","public c"]);
  } finally {if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;}
});

test("default discovery progresses beyond its former first 128 sources", async () => {
  const f=fixture(),native=join(f.root,"native"),sessions=join(native,"sessions"),previous=process.env.CODEX_HOME;mkdirSync(sessions,{recursive:true});process.env.CODEX_HOME=native;
  try {
    for(let i=0;i<130;i++)writeFileSync(join(sessions,String(i).padStart(3,"0")+".jsonl"),line(codexHeader(f.cwd))+line(codexMessage("source "+i)));
    let last: { remaining: boolean } | undefined;
    for(let i=0;i<3;i++)last=await ingestTranscript("codex",{cwd:f.cwd,base:f.base,maxFiles:64});
    expect(last?.remaining).toBe(false);
    const store=new CaptureStore({memoryDir:f.base,project:memoryProjectKey(f.cwd)});try{expect(store.rows({limit:200})).toHaveLength(130);}finally{store.close();}
  } finally {if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;}
},20000);

test("oversized native records drain across bounded passes once and do not strand later messages", async () => {
  const f=fixture(),large=line({type:"image",payload:"A".repeat(5*1024*1024)});
  writeFileSync(f.file,line(codexHeader(f.cwd))+line(codexMessage("before oversized"))+large+line(codexMessage("after oversized")));
  let imported=0,skipped=0,read=0,last:{remaining:boolean}|undefined;
  for(let i=0;i<4;i++){
    const receipt=await ingestTranscript("codex",{...f,files:[f.file]});
    imported+=receipt.imported;skipped+=receipt.skipped;read+=receipt.read;last=receipt;
  }
  expect(rows(f).map(row=>row.excerpt)).toEqual(["before oversized","after oversized"]);
  expect(imported).toBe(2);expect(read).toBe(4);expect(skipped).toBe(2);expect(last?.remaining).toBe(false);
});

test("oversized unterminated tails retain skip state until the real newline arrives", async () => {
  const f=fixture();writeFileSync(f.file,line(codexHeader(f.cwd))+"A".repeat(5*1024*1024));
  let read=0,skipped=0;
  for(let i=0;i<3;i++){
    const receipt=await ingestTranscript("codex",{...f,files:[f.file]});
    read+=receipt.read;skipped+=receipt.skipped;expect(receipt.remaining).toBe(true);expect(receipt.imported).toBe(0);
  }
  // This looks valid in isolation but remains part of the oversized physical record until its newline.
  appendFileSync(f.file,JSON.stringify(codexMessage("must remain discarded"))+"\n"+line(codexMessage("after actual newline")));
  const final=await ingestTranscript("codex",{...f,files:[f.file]});read+=final.read;skipped+=final.skipped;
  expect(rows(f).map(row=>row.excerpt)).toEqual(["after actual newline"]);
  expect(read).toBe(3);expect(skipped).toBe(2);expect(final.remaining).toBe(false);
});

test("a broader cutoff clears an in-flight oversized skip before backfilling", async () => {
  const f=fixture();writeFileSync(f.file,line(codexHeader(f.cwd))+line(codexMessage("backfilled before"))+line({type:"image",payload:"A".repeat(5*1024*1024)})+line(codexMessage("backfilled after")));
  await ingestTranscript("codex",{...f,files:[f.file],since:"2026-10-23T02:00:00Z"});
  for(let i=0;i<3;i++)await ingestTranscript("codex",{...f,files:[f.file],since:"2026-10-23T00:00:00Z"});
  expect(rows(f).map(row=>row.excerpt)).toEqual(["backfilled before","backfilled after"]);
});


test("pre-discard cursor schema migrates without replaying an already imported native record", async () => {
  const f=fixture();writeFileSync(f.file,line(codexHeader(f.cwd))+line(codexMessage("already present")));
  expect((await ingestTranscript("codex",{...f,files:[f.file]})).imported).toBe(1);
  const store=new CaptureStore({memoryDir:f.base,project:memoryProjectKey(f.cwd)}),dir=join(store.dir,"ingest");store.close();
  for(const name of readdirSync(dir).filter(name=>name.endsWith(".db"))){
    const database=new Database(join(dir,name));try{database.run("ALTER TABLE cursor DROP COLUMN skipping");}finally{database.close();}
  }
  appendFileSync(f.file,line(codexMessage("after schema migration")));
  expect((await ingestTranscript("codex",{...f,files:[f.file]})).imported).toBe(1);
  expect(rows(f).map(row=>row.excerpt)).toEqual(["already present","after schema migration"]);
});


test("ingest help returns guidance before intake, cwd access or any memory write, including agent shells", async () => {
  const f=fixture(),native=join(f.root,"native"),sessions=join(native,"sessions"),previous=process.env.CODEX_HOME;
  mkdirSync(sessions,{recursive:true});writeFileSync(join(sessions,"fixture.jsonl"),line(codexHeader(f.cwd))+line(codexMessage("help must not import")));process.env.CODEX_HOME=native;
  const { runCli, PERSON_ONLY }=await import("../src/cli.ts");
  try {
    for(const kind of ["codex","kimi","pi"]){
      const help=await runCli(["ingest",kind,"--help"],{
        get cwd(): string {throw new Error("help must not inspect a project or transcript");},
        env:{AMEM_HOME:f.base,AGENTHUB_PEER_ID:"codex"},stdinTTY:false,
      });
      expect(help).toContain("usage: amem");expect(help).toContain("ingest");expect(existsSync(f.base)).toBe(false);
    }
    // F1: plain `--help` works in an agent shell too, and opens nothing; a command is still refused.
    expect(await runCli(["--help"],{cwd:f.cwd,env:{AMEM_HOME:f.base,AGENTHUB_PEER_ID:"codex"}})).toContain("usage: amem");
    await expect(runCli(["list"],{cwd:f.cwd,env:{AMEM_HOME:f.base,AGENTHUB_PEER_ID:"codex"}})).rejects.toThrow(PERSON_ONLY);
    expect(existsSync(f.base)).toBe(false);
  } finally {if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;}
});

test("#136: Kimi protocol 1.6 is unsupported_version with the version named, malformed metadata still schema_or_time", async () => {
  const f = fixture(), session = join(f.root,"kimi-session"), main = join(session,"agents","main"); mkdirSync(main,{recursive:true});
  writeFileSync(join(session,"state.json"),JSON.stringify({ cwd: f.cwd })); const file=join(main,"wire.jsonl");
  const answer = line({type:"context.append_message",time:Date.parse(at),message:{role:"assistant",content:[{type:"text",text:"newer kimi answer"}]}});
  writeFileSync(file,line({type:"metadata",protocol_version:"1.6"}) + answer);
  const newer = await ingestTranscript("kimi",{...f,files:[file]});
  expect(newer).toMatchObject({ imported: 0, reason: "unsupported_version", version: "1.6" });
  expect(JSON.stringify(newer)).not.toContain("newer kimi answer");
  writeFileSync(file,line({type:"metadata",protocol_version:"<b>not a version</b>"}) + answer);
  const bad = await ingestTranscript("kimi",{...f,files:[file]});
  expect(bad.reason).toBe("schema_or_time"); expect(bad.version).toBeUndefined();
});

test("#136: timestamped Kimi records with no metadata stay schema_or_time with no version", async () => {
  const f = fixture(), session = join(f.root,"kimi-session"), main = join(session,"agents","main"); mkdirSync(main,{recursive:true});
  writeFileSync(join(session,"state.json"),JSON.stringify({ cwd: f.cwd })); const file=join(main,"wire.jsonl");
  writeFileSync(file,line({type:"context.append_message",time:Date.parse(at),message:{role:"assistant",content:[{type:"text",text:"no metadata answer"}]}}));
  const receipt = await ingestTranscript("kimi",{...f,files:[file]});
  expect(receipt.imported).toBe(0); expect(receipt.reason).toBe("schema_or_time"); expect(receipt.version).toBeUndefined();
});

function kimiCursorProtocols(f: ReturnType<typeof fixture>): string[] {
  const store = new CaptureStore({ memoryDir: f.base, project: memoryProjectKey(f.cwd) }), dir = join(store.dir, "ingest"); store.close();
  return readdirSync(dir).filter(name => name.endsWith(".db")).map(name => { const db = new Database(join(dir, name), { readonly: true }); try { return (db.query("SELECT protocol FROM cursor").get() as { protocol: string }).protocol; } finally { db.close(); } });
}

test("#136: a policy-declined Kimi metadata record never lends its version to the cursor or the receipt", async () => {
  const f = fixture(), session = join(f.root,"kimi-session"), main = join(session,"agents","main"); mkdirSync(main,{recursive:true});
  writeFileSync(join(session,"state.json"),JSON.stringify({ cwd: f.cwd })); const file=join(main,"wire.jsonl");
  writeFileSync(file,line({type:"metadata",protocol_version:"1.6",marker:"decline-me"}) + line({type:"context.append_message",time:Date.parse(at),message:{role:"assistant",content:[{type:"text",text:"answer"}]}}));
  const policy = { host: { async screen(value: unknown) { return !JSON.stringify(value).includes("decline-me"); } } };
  const receipt = await ingestTranscript("kimi",{...f,files:[file],policy});
  expect(receipt.reason).toBe("schema_or_time"); expect(receipt.version).toBeUndefined(); expect(JSON.stringify(receipt)).not.toContain("1.6");
  const protocols = kimiCursorProtocols(f).filter(protocol => protocol !== "rotation-v1");   // the discovery tour keeps its own cursor row
  expect(protocols).toEqual(["unknown"]);
});
