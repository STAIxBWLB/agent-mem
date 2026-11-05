import { createHash } from "node:crypto";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { PLACEMENT_FORMAT, PLACEMENT_PROFILE_SCHEMA, PLACEMENT_SHARDS_SCHEMA, validatePlacementProfile, validatePlacementShards } from "../src/memory/sync-placement-format.ts";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { drainHookCaptures, stageHookCapture } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { indexFileName } from "../src/memory/index-file.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { previousRelease } from "../scripts/previous-release.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { openShardStore } from "../src/memory/store.ts";
import { createPlacementInspectionFixture, createInspectionRemote, inspectionGit, inspectionNote, reachableInspectionRowIds } from "./fakes/sync-placement-inspection.ts";

// #199 AC6 / #249: this build and the previous minor line on one shared home. The CI job `previous-release` resolves
// its latest published plain release with scripts/previous-release.ts and sets AMEM_PREV_ROOT; locally the suite skips without it, and
// AMEM_PREV_REQUIRED=1 (set by the job) turns a missing root into a failure instead of a skip.
const root = process.env.AMEM_PREV_ROOT, required = process.env.AMEM_PREV_REQUIRED === "1";

test("previousRelease keeps patches and minor releases on the latest patch of the preceding minor line", () => {
  const published = ["0.19.2", "0.20.0", "0.18.9", "0.19.10", "0.20.3", "0.19.0", "0.21.0", "1.19.99"];
  expect(previousRelease("0.20.3", published)).toBe("0.19.10");
  expect(previousRelease("0.20.0", published)).toBe("0.19.10");
  expect(previousRelease("0.21.0", published)).toBe("0.20.3");
  expect(previousRelease("0.21.9", published)).toBe("0.20.3");
});

test("previousRelease skips prereleases and non-plain versions without jumping across a missing minor line", () => {
  const published = ["0.18.99", "0.19.0-rc.1", "0.19.4+build.1", "v0.19.9", "0.20.0", "1.19.2"];
  expect(previousRelease("0.20.3", published)).toBeUndefined();
  expect(previousRelease("0.20.3", [...published, "0.19.1", "0.19.9-beta.1"])).toBe("0.19.1");
  expect(previousRelease("0.20.3", [])).toBeUndefined();
  expect(() => previousRelease("next", published)).toThrow("plain semver");
  expect(() => previousRelease("0.20.0-rc.1", published)).toThrow("plain semver");
});

test("previousRelease uses the highest plain release of the preceding major only at minor zero", () => {
  const published = ["0.19.99", "0.20.3", "0.21.2", "0.21.10", "0.22.0-rc.1", "1.0.0", "1.1.3", "1.9.4", "1.10.0", "2.0.0"];
  expect(previousRelease("1.0.0", published)).toBe("0.21.10");
  expect(previousRelease("1.0.8", published)).toBe("0.21.10");
  expect(previousRelease("2.0.0", published)).toBe("1.10.0");
  expect(previousRelease("2.1.0", published)).toBe("2.0.0");
  expect(previousRelease("3.0.0", published)).toBe("2.0.0");
  expect(previousRelease("4.0.0", published)).toBeUndefined();
  expect(previousRelease("0.0.0", published)).toBeUndefined();
});

test("the previous-release job has its release", () => { if (required) expect(root, "AMEM_PREV_ROOT").toBeTruthy(); });

describe.skipIf(!root)("N-1: this build and the previous release share a home", () => {
  const prev = (path: string) => pathToFileURL(resolve(root!, path)).href;
  const clean: (() => void)[] = [];
  const oldHome = process.env.HOME;
  afterEach(() => { process.env.HOME = oldHome; for (const close of clean.splice(0)) close(); });
  const fixture = () => { const f = hookFixture(); clean.push(f.close); process.env.HOME = f.env.HOME; return { ...f, options: { cwd: f.cwd, base: f.base } }; };
  const spool = (base: string) => join(base, "hook-spool");
  const pending = (base: string) => existsSync(spool(base)) ? readdirSync(spool(base)).filter(name => name.startsWith("hook-")).sort() : [];
  const run = (f: ReturnType<typeof fixture>, code: string) => {
    const child = Bun.spawnSync([process.execPath, "-e", code], { cwd: f.cwd, env: { ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 15000 });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return child.stdout.toString().trim();
  };
  /** The previous release runs one ordinary hook: home-wide maintenance through stageHookCapture, then its drain for the same cwd. */
  const prevHook = (f: ReturnType<typeof fixture>, excerpt: string) => JSON.parse(run(f, `const { drainHookCaptures, stageHookCapture } = await import(${JSON.stringify(prev("src/hook-spool.ts"))});
const options = { cwd: ${JSON.stringify(f.cwd)}, base: ${JSON.stringify(f.base)} };
await stageHookCapture("PostToolUse", { tool_name: "Read", tool_response: ${JSON.stringify(excerpt)} }, options);
const appended = [];
await drainHookCaptures({ ...options, project: ${JSON.stringify(f.project)} }, (input) => { appended.push(input.agent + ":" + input.excerpt); return { id: 1 }; });
console.log(JSON.stringify(appended));`)) as string[];
  const drain = async (f: ReturnType<typeof fixture>) => {
    const store = new CaptureStore({ memoryDir: f.base, project: f.project });
    try { await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt })); return store.rows({ project: f.project }).map(row => row.agent + ":" + row.excerpt); }
    finally { store.close(); }
  };

  test("hook spool, new to old: the previous release's maintenance and drain keep or drain this build's records, never lose them", async () => {
    const f = fixture();
    const claude = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "claude from new" }, f.options))!;
    const jcode = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "jcode from new" }, { ...f.options, agent: "jcode" }))!;
    const appended = prevHook(f, "old barrier");
    expect(appended).toContain("claude:old barrier");
    // Whatever the previous release drains is drained exactly once; whatever it cannot read stays pending for this build.
    const left = pending(f.base);
    for (const [record, text] of [[claude, "claude:claude from new"], [jcode, "jcode:jcode from new"]] as const) {
      expect(appended.includes(text) || left.includes(record.name), `${text} drained or still pending`).toBe(true);
      expect(appended.includes(text) && left.includes(record.name)).toBe(false);
    }
    const rows = await drain(f);
    for (const [record, text] of [[claude, "claude:claude from new"], [jcode, "jcode:jcode from new"]] as const) if (left.includes(record.name)) expect(rows).toContain(text);
    expect(pending(f.base)).toEqual([]);
  });

  test("hook spool, old to new: a record the previous release left pending is drained by this build", async () => {
    const f = fixture();
    run(f, `const { stageHookCapture } = await import(${JSON.stringify(prev("src/hook-spool.ts"))});
await stageHookCapture("PostToolUse", { tool_name: "Read", tool_response: "old pending" }, { cwd: ${JSON.stringify(f.cwd)}, base: ${JSON.stringify(f.base)} });`);
    expect(pending(f.base)).toHaveLength(1);
    expect(await drain(f)).toContain("claude:old pending");
    expect(pending(f.base)).toEqual([]);
  });

  test("per-version index files: neither build rebuilds the other's index", () => {
    const f = fixture();
    const schema = (file: string) => { const db = new Database(file, { readonly: true }); try { return (db.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version; } finally { db.close(); } };
    const note = (text: string) => ({ op: "note", project: "p", scope: "project", tier: "long", kind: "finding", peer: "person", text, about: [], source: "person" });
    const prevStore = (body: string) => run(f, `const { MemoryStore } = await import(${JSON.stringify(prev("src/memory/store.ts"))}); const s = new MemoryStore({ memoryDir: ${JSON.stringify(f.base)}, screen: () => "keep" }); ${body} s.close();`);
    prevStore(`s.note(${JSON.stringify(note("by previous"))});`);
    const ours = join(f.base, indexFileName(false));
    const mine = new MemoryStore({ memoryDir: f.base, screen: () => "keep" }); try { mine.note(note("by this build") as never); } finally { mine.close(); }
    const files = readdirSync(f.base).filter(name => /^index.*\.db$/.test(name)).sort(), before = Object.fromEntries(files.map(name => [name, schema(join(f.base, name))]));
    expect(existsSync(ours)).toBe(true);
    expect(prevStore(`console.log(s.list({ project: "p" }).length);`)).toBe("2");
    const again = new MemoryStore({ memoryDir: f.base, screen: () => "keep" }); try { expect(again.list({ project: "p" })).toHaveLength(2); } finally { again.close(); }
    // The same index files, each at the schema it had: no rebuild, rename or drop in either direction.
    expect(readdirSync(f.base).filter(name => /^index.*\.db$/.test(name)).sort()).toEqual(files);
    for (const name of files) expect(schema(join(f.base, name)), name).toBe(before[name]!);
  });

  test("candidates: a kind the reader does not know is skipped, both ways", () => {
    const f = fixture();
    const store = new CandidateStore({ memoryDir: f.base });
    let id: string;
    try { id = store.put({ kind: "memory", project: f.project, text: "a known candidate" }, "public"); } finally { store.close(); }
    const db = new Database(join(f.base, "candidates.db"));
    try { db.query("INSERT INTO candidates (id, project, kind, payload, at, status) VALUES (?, ?, 'future-kind', ?, ?, 'pending')").run("f".repeat(64), f.project, JSON.stringify({ kind: "future-kind", project: f.project }), Date.now() + 60_000); }
    finally { db.close(); }
    expect(JSON.parse(run(f, `const { CandidateStore } = await import(${JSON.stringify(prev("src/memory/candidates.ts"))}); const s = new CandidateStore({ memoryDir: ${JSON.stringify(f.base)} });
try { console.log(JSON.stringify({ ids: s.list({ project: ${JSON.stringify(f.project)} }).map(c => c.id), skipped: s.skippedUnknownKinds })); } finally { s.close(); }`))).toEqual({ ids: [id!], skipped: 1 });
    const mine = new CandidateStore({ memoryDir: f.base });
    try { expect(mine.list({ project: f.project }).map(candidate => candidate.id)).toEqual([id!]); expect(mine.skippedUnknownKinds).toBe(1); } finally { mine.close(); }
  });

  test("format floors: a hook-spool floor above both releases stops each from staging or draining, and lifting it drains", async () => {
    const f = fixture();
    const staged = (await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "before floor" }, f.options))!;
    // A person raises the floor (formats.json is never written by amem code); the test plays that person.
    writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "hook-spool", minReader: "99.0.0", since: "2026-11-02" }]));
    // Releases before 0.19.0 predate format floors (#207) and cannot honor one: only a floor-aware release is held to it.
    if (existsSync(resolve(root!, "src/memory/formats.ts"))) { expect(prevHook(f, "old under floor")).toEqual([]); expect(pending(f.base)).toEqual([staged.name]); }
    expect(await stageHookCapture("Stop", { session_id: "s", last_assistant_message: "new under floor" }, f.options)).toBeUndefined();
    expect(await drain(f)).toEqual([]);
    expect(pending(f.base)).toEqual([staged.name]);
    writeFileSync(join(f.base, "formats.json"), "[]");
    expect(await drain(f)).toContain("claude:before floor");
    expect(readFileSync(join(f.base, "formats.json"), "utf8")).toBe("[]");
  });
  test("sync placement v3 markers are refused by the previous reader before effects; a person-authored floor requests upgrade", () => {
    const f = fixture(), mine = new MemoryStore({ memoryDir: f.base }); mine.close();
    const profile = validatePlacementProfile({ schema: PLACEMENT_PROFILE_SCHEMA, kind: "generation", generation: "e".repeat(32),
      foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: "a".repeat(64), publicationFormat: PLACEMENT_FORMAT, placementHead: "b".repeat(64) });
    const shards = validatePlacementShards({ schema: PLACEMENT_SHARDS_SCHEMA, generation: profile.generation, phase: "active", selectorRevision: hashJSON(profile),
      sources: [], machine: { id: "c".repeat(16), label: "synthetic compatibility" }, publicationFormat: PLACEMENT_FORMAT, placementHead: profile.placementHead }, profile);
    // Test-only person action: stage1 core code never writes or activates these markers.
    writeFileSync(join(f.base, "profile.json"), canonicalJSON(profile) + "\n", { mode: 0o600 });
    writeFileSync(join(f.base, "shards.json"), canonicalJSON(shards) + "\n", { mode: 0o600 });
    const snapshot = (): Record<string, string> => {
      const files: Record<string, string> = {};
      const visit = (dir: string, prefix = "") => { for (const item of readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix + item.name, file = join(dir, item.name);
        if (item.isDirectory()) visit(file, relative + "/");
        else files[relative] = createHash("sha256").update(readFileSync(file)).digest("hex");
      } };
      visit(f.base); return files;
    };
    const before = snapshot();
    const observed = JSON.parse(run(f, `const old = await import(${JSON.stringify(prev("src/memory/store.ts"))});
const generation = await import(${JSON.stringify(prev("src/memory/generation.ts"))});
let effects=0;Bun.spawn=()=>{effects++;throw Error('unexpected child');};Bun.spawnSync=()=>{effects++;throw Error('unexpected child');};globalThis.fetch=()=>{effects++;throw Error('unexpected fetch');};
const refused=work=>{try{work();return false;}catch{return true;}};
const memory=${JSON.stringify(f.base)};
const result={selector:refused(()=>generation.readSelector(memory)),store:refused(()=>new old.MemoryStore({memoryDir:memory})),shard:refused(()=>old.openShardStore({memoryDir:memory,project:'placement-guard-project'})),effects};
console.log(JSON.stringify(result));`));
    expect(observed).toEqual({ selector: true, store: true, shard: true, effects: 0 }); expect(snapshot()).toEqual(before);
    // A person may set an existing home-wide floor; implementation code must not create formats.json.
    writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "home", minReader: "99.0.0", since: "2026-11-05" }]), { mode: 0o600 });
    const floored = snapshot();
    expect(JSON.parse(run(f, `const {MemoryStore}=await import(${JSON.stringify(prev("src/memory/store.ts"))});let upgrade=false;try{new MemoryStore({memoryDir:${JSON.stringify(f.base)}});}catch(error){upgrade=String(error.message).includes('Upgrade amem');}console.log(JSON.stringify({upgrade}));`))).toEqual({ upgrade: true });
    expect(() => new MemoryStore({ memoryDir: f.base })).toThrow("Upgrade amem"); expect(snapshot()).toEqual(floored);
  });

  test("an actually activated v3 home refuses previous-release read, write and sync before admission or unfiltered publication", async () => {
    const host = fixture(), active = await createPlacementInspectionFixture(); clean.push(active.close);
    const previous = { ...host, env: { ...host.env, AMEM_HOME: active.home, AGENTHUB_HOME: active.root } };
    const probe = () => JSON.parse(run(previous, `const {openShardStore}=await import(${JSON.stringify(prev("src/memory/store.ts"))});
const {syncMemory}=await import(${JSON.stringify(prev("src/memory/sync.ts"))});
let effects=0,admitted=0;
Bun.spawn=()=>{effects++;throw Error('unexpected child');};Bun.spawnSync=()=>{effects++;throw Error('unexpected child');};globalThis.fetch=()=>{effects++;throw Error('unexpected fetch');};
const results=[];
for(const operation of ['read','write','sync']){
  let store;
  try {
    store=openShardStore({memoryDir:${JSON.stringify(active.home)},project:${JSON.stringify(active.project)}});admitted++;
    if(operation==='read')store.list({project:${JSON.stringify(active.project)}});
    else if(operation==='write')store.note(${JSON.stringify(inspectionNote("N1 must not append to activated placement", active.project))});
    else await syncMemory(store,{remote:${JSON.stringify(active.remote)},visibility:async()=>{effects++;return 'private';}});
    results.push({operation,refused:false});
  } catch(error){results.push({operation,refused:true,message:String(error.message),code:error.code??null});}
  finally{store?.close();}
}
console.log(JSON.stringify({results,effects,admitted}));`)) as {results:{operation:string;refused:boolean;message:string;code:string|null}[];effects:number;admitted:number};
    const before = active.snapshot(), observed = probe();
    expect(observed.results.map(value=>({operation:value.operation,refused:value.refused}))).toEqual([
      {operation:"read",refused:true},{operation:"write",refused:true},{operation:"sync",refused:true},
    ]);
    expect(observed.effects).toBe(0); expect(observed.admitted).toBe(0);
    for (const value of observed.results) expect(value.message).toContain("inspect the local profile before continuing");
    expect(active.snapshot()).toEqual(before);
    expect(inspectionGit(active.remote,"for-each-ref","--format=%(refname)")).toBe(""); expect(active.reachableIds()).toEqual([]);
    // A known old release cannot gain new diagnostics retroactively. The documented existing person-authored
    // home floor supplies its actionable upgrade remedy; activation/runtime code must never install that floor.
    const currentVersion = (JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")) as {version:string}).version;
    writeFileSync(join(active.home,"formats.json"),canonicalJSON([{surface:"home",minReader:currentVersion,since:"2026-11-06"}])+"\n",{mode:0o600});
    const floored = active.snapshot(), floorResult = probe();
    for(const value of floorResult.results){expect(value.refused).toBe(true);expect(value.code).toBe("format_floor");expect(value.message).toContain(`Upgrade amem to ${currentVersion} or later.`);}
    expect(floorResult.effects).toBe(0); expect(floorResult.admitted).toBe(0); expect(active.snapshot()).toEqual(floored);
    expect(inspectionGit(active.remote,"for-each-ref","--format=%(refname)")).toBe("");
  },30_000);

  for(const version of ["v1","v2"] as const)test(`inactive ${version} shards preserve previous-release reads, writes and ordinary local Git sync`,async()=>{
    const f = fixture(), original = new MemoryStore({memoryDir:f.base,deferPromotions:true});
    let initial:string;
    try{initial=original.note(inspectionNote(`ordinary ${version} initial source`,f.project));}finally{original.close();}
    const generation=createHash("sha256").update(f.root).digest("hex").slice(0,32);
    expect((await migrateShards({memoryDir:f.base,generation,mode:"apply",authorizedPerson:true,tty:true})).active).toBe(true);
    if(version==="v2")await activatePublicPruneView({memoryDir:f.base,mode:"apply",authorizedPerson:true,tty:true});
    const remote=createInspectionRemote(f.root,"ordinary-n1.git"),markers=["profile.json","shards.json"].map(name=>readFileSync(join(f.base,name),"utf8"));
    const observed=JSON.parse(run(f,`const {openShardStore}=await import(${JSON.stringify(prev("src/memory/store.ts"))});
const {syncMemory}=await import(${JSON.stringify(prev("src/memory/sync.ts"))});
const store=openShardStore({memoryDir:${JSON.stringify(f.base)},project:${JSON.stringify(f.project)},deferPromotions:true});
try{
const read=store.list({project:${JSON.stringify(f.project)}}).map(value=>value.id);
const written=store.note(${JSON.stringify(inspectionNote(`ordinary ${version} previous-release append`,f.project))});
const synced=await syncMemory(store,{remote:${JSON.stringify(remote)},visibility:async()=> 'private'});
console.log(JSON.stringify({read,written,ok:synced.ok}));
}finally{store.close();}`)) as {read:string[];written:string;ok:boolean};
    expect(observed.read).toContain(initial!); expect(observed.ok).toBe(true);
    expect(reachableInspectionRowIds(remote)).toEqual([initial!,observed.written].sort());
    expect(["profile.json","shards.json"].map(name=>readFileSync(join(f.base,name),"utf8"))).toEqual(markers);
    expect(existsSync(join(f.base,"sync-placement"))).toBe(false);
    const current=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});
    try{expect(current.list({project:f.project}).map(value=>value.id).sort()).toEqual([initial!,observed.written].sort());}finally{current.close();}
  },30_000);

});
