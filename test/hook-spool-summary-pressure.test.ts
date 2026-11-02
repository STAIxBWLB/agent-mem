import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, opendirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HookSpoolFull, stageHookCapture, stageTranscriptCapture } from "../src/hook-spool.ts";
import { normalizeCaptureFields } from "../src/memory/capture-input.ts";
import { readCaptureDrops } from "../src/memory/metrics.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [], originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) f.close();
});
function fixture() {
  const f = hookFixture(); fixtures.push(f); process.env.HOME = f.env.HOME;
  return { ...f, options: { cwd: f.cwd, base: f.base } };
}
type Fixture = ReturnType<typeof fixture>;
interface Publication { name: string; file: string; bytes: string; cwd: string; event: string }
function pending(base: string): Publication[] {
  const dir = join(base, "hook-spool");
  const rows = [dir, join(dir, ".capacity")].flatMap(folder => (existsSync(folder) ? readdirSync(folder) : [])
    .filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name)).map(name => {
      const file = join(folder, name), bytes = readFileSync(file, "utf8"), record = JSON.parse(bytes) as { cwd: string; capture: { event: string } };
      return { name, file, bytes, cwd: record.cwd, event: record.capture.event };
    }));
  expect(new Set(rows.map(row => row.name)).size).toBe(rows.length);
  return rows;
}
function drops(base: string) {
  const result = readCaptureDrops(base);
  expect(result.readable).toBe(true);
  if (!result.readable) throw new Error("fixture capture drops unavailable");
  return result.counts;
}
function foreignCwd(f: Fixture, label: string): string {
  const cwd = join(f.root, label); mkdirSync(cwd);
  const result = Bun.spawnSync(["git", "init", "--quiet", cwd], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return cwd;
}
function unchanged(rows: Publication[]): void {
  for (const row of rows) { expect(existsSync(row.file), row.name).toBe(true); expect(readFileSync(row.file, "utf8"), row.name).toBe(row.bytes); }
}
async function title(f: Fixture, cwd: string, index: number, at: number) {
  const staged = await stageTranscriptCapture({ agent: "claude", event: "Title", at: new Date(at).toISOString(), excerpt: `accepted title ${index}` }, { cwd, base: f.base });
  expect(staged).toBeDefined();
  return staged!;
}
/** Move only synthetic accepted publications to represent a pre-quota reserve. */
function reserve(f: Fixture, entries: { name: string }[], at: number): void {
  const dir = join(f.base, "hook-spool"), destination = join(dir, ".capacity"); mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const [index, row] of entries.entries()) {
    const file = join(destination, row.name); renameSync(join(dir, row.name), file);
    utimesSync(file, new Date(at + index), new Date(at + index));
  }
}

test("an own-cwd summary share refuses the 65th Title and defers native intake without evicting accepted summaries", async () => {
  const f = fixture(), at = Date.now() - 120_000;
  for (let index = 0; index < 64; index++) await title(f, f.cwd, index, at + index);
  const accepted = pending(f.base); expect(accepted).toHaveLength(64);
  await expect(stageTranscriptCapture({ agent: "claude", event: "Title", at: new Date(at + 64).toISOString(), excerpt: "unaccepted sixty-fifth title" }, f.options)).rejects.toBeInstanceOf(HookSpoolFull);
  unchanged(accepted); expect(pending(f.base)).toHaveLength(64);
  const native = await stageHookCapture("PostToolUse", { prompt: "native admitted beside own summaries" }, { ...f.options, deferAtCapacity: true });
  expect(native?.deferred).toBe(true); expect(native && existsSync(join(f.base, "hook-spool", ".capacity", native.name))).toBe(true);
  unchanged(accepted); expect(pending(f.base)).toHaveLength(65);
  expect(drops(f.base).scope_capacity ?? 0).toBe(0); expect(drops(f.base).summary_capacity ?? 0).toBe(0);
});

test("a complete 32-record all-summary foreign reserve retires only its oldest summary with one counted summary_capacity receipt", async () => {
  const f = fixture(), foreign = foreignCwd(f, "summary-only"), at = Date.now() - 120_000, staged: { name: string }[] = [];
  for (let index = 0; index < 32; index++) staged.push(await title(f, foreign, index, at + index));
  reserve(f, staged, at);
  const before = pending(f.base); expect(before).toHaveLength(32);
  const admitted = await stageHookCapture("SessionStart", { prompt: "new cwd startup" }, f.options);
  expect(admitted?.deferred).toBe(true);
  expect(existsSync(join(f.base, "hook-spool", ".capacity", staged[0]!.name))).toBe(false);
  unchanged(before.filter(row => row.name !== staged[0]!.name));
  const after = pending(f.base), loss = drops(f.base);
  expect(after.filter(row => row.cwd === foreign)).toHaveLength(31); expect(after.filter(row => row.cwd === f.cwd)).toHaveLength(1);
  expect(loss.summary_capacity).toBe(1); expect(loss.scope_capacity ?? 0).toBe(0);
  expect(32 + 1).toBe(after.length + (loss.summary_capacity ?? 0));
});

test("a newest native in a 31-summary foreign reserve is preferred over every older summary", async () => {
  const f = fixture(), foreign = foreignCwd(f, "mixed-reserve"), at = Date.now() - 120_000, staged: { name: string }[] = [];
  for (let index = 0; index < 31; index++) staged.push(await title(f, foreign, index, at + index));
  const native = await stageHookCapture("PostToolUse", { prompt: "newest foreign native victim" }, { cwd: foreign, base: f.base });
  expect(native).toBeDefined(); staged.push(native!); reserve(f, staged, at);
  const acceptedSummaries = pending(f.base).filter(row => row.event === "Title"); expect(acceptedSummaries).toHaveLength(31);
  const admitted = await stageHookCapture("SessionStart", { prompt: "new cwd mixed startup" }, f.options);
  expect(admitted?.deferred).toBe(true);
  expect(existsSync(join(f.base, "hook-spool", ".capacity", native!.name))).toBe(false);
  unchanged(acceptedSummaries);
  const after = pending(f.base), loss = drops(f.base);
  expect(after).toHaveLength(32); expect(loss.scope_capacity).toBe(1); expect(loss.summary_capacity ?? 0).toBe(0);
  expect(32 + 1).toBe(after.length + (loss.scope_capacity ?? 0));
});

test("a cooperative 33-record reserve overshoot cannot prove native absence from its first 32 summaries", async () => {
  const f = fixture(), foreign = foreignCwd(f, "overshot-reserve"), at = Date.now() - 120_000;
  const source = await title(f, foreign, 0, at), dir = join(f.base, "hook-spool"), destination = join(dir, ".capacity");
  const template = JSON.parse(readFileSync(join(dir, source.name), "utf8")) as Record<string, unknown>; rmSync(join(dir, source.name));
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  // Cooperative admission can race past the cap. The real directory iteration,
  // rather than lexical order, determines which publication lies beyond the bound.
  for (let index = 0; index < 33; index++) {
    const nonce = index.toString(16).padStart(32, "0"), name = source.name.replace(/[a-f0-9]{32}\.json$/, nonce + ".json");
    const capture = normalizeCaptureFields({ agent: "claude", event: "Title", at: new Date(at + index).toISOString(), excerpt: `overshot summary ${index}` });
    writeFileSync(join(destination, name), JSON.stringify({ ...template, nonce, capture }), { mode: 0o600, flag: "wx" });
  }
  const lastEntry = () => {
    const reader = opendirSync(destination);
    try {
      let name: string | undefined;
      for (let index = 0; index < 33; index++) { const entry = reader.readSync(); expect(entry).not.toBeNull(); name = entry!.name; }
      expect(reader.readSync()).toBeNull();
      return name!;
    } finally { reader.closeSync(); }
  };
  const hiddenName = lastEntry(), hiddenFile = join(destination, hiddenName), hidden = JSON.parse(readFileSync(hiddenFile, "utf8")) as Record<string, unknown>;
  const capture = normalizeCaptureFields({ agent: "jcode", event: "PostToolUse", at: new Date(at + 33).toISOString(), excerpt: "native beyond reserve inventory bound" });
  // Keep the same valid v3 name/nonce and inode: no rename can change enumeration order.
  writeFileSync(hiddenFile, JSON.stringify({ ...hidden, capture }), { mode: 0o600 });
  expect(lastEntry()).toBe(hiddenName);
  const before = pending(f.base); expect(before).toHaveLength(33); expect(before.filter(row => row.event === "Title")).toHaveLength(32);
  await expect(stageHookCapture("SessionStart", { prompt: "refuse incomplete all-summary proof" }, f.options)).rejects.toBeInstanceOf(HookSpoolFull);
  unchanged(before); expect(pending(f.base)).toHaveLength(33);
  expect(drops(f.base).summary_capacity ?? 0).toBe(0); expect(drops(f.base).scope_capacity ?? 0).toBe(0);
});

/** Raw immutable clones represent a previously accepted N-1 backlog, not new quota admission. */
async function seedGroup(f: Fixture, cwd: string, group: number, at: number, nativeLast = false): Promise<string | undefined> {
  const source = await title(f, cwd, group, at), dir = join(f.base, "hook-spool"), file = join(dir, source.name);
  const template = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; rmSync(file);
  let nativeName: string | undefined;
  for (let index = 0; index < 64; index++) {
    const ordinal = group * 64 + index, native = nativeLast && index === 63, nonce = ordinal.toString(16).padStart(32, "0");
    const capture = normalizeCaptureFields({ agent: "claude", event: native ? "PostToolUse" : "Title", at: new Date(at + ordinal).toISOString(), excerpt: `pre-quota ${native ? "native" : "summary"} ${ordinal}` });
    const name = source.name.replace(/^hook-v3-/, native ? "hook-v2-" : "hook-v3-").replace(/[a-f0-9]{32}\.json$/, nonce + ".json"), target = join(dir, name);
    writeFileSync(target, JSON.stringify({ ...template, format: native ? 2 : 3, nonce, capture }), { mode: 0o600, flag: "wx" });
    utimesSync(target, new Date(at + ordinal), new Date(at + ordinal));
    if (native) nativeName = name;
  }
  return nativeName;
}

test("bounded rotating pressure scans find a newest native beyond the first 32 records without losing summaries", async () => {
  const f = fixture(), at = Date.now() - 120_000; let nativeName: string | undefined;
  for (let group = 0; group < 4; group++) nativeName = await seedGroup(f, foreignCwd(f, `foreign-${group}`), group, at, group === 3) ?? nativeName;
  expect(nativeName).toBeDefined();
  const before = pending(f.base), summaries = before.filter(row => row.event === "Title"); expect(before).toHaveLength(256); expect(summaries).toHaveLength(255);
  const probe = join(f.root, "bounded-summary-pressure.ts"), source = resolve(import.meta.dir, "../src/hook-spool.ts");
  writeFileSync(probe, `import {readFileSync,readdirSync} from 'node:fs';
(globalThis as any).__pressureReads={files:0,bytes:0};
Bun.plugin({name:'bounded-pressure-body-reads',setup(builder){builder.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='function decoded(file: OwnedFile): { value: Record; bytes: Buffer; unknown?: true } | undefined {';
 if(source.split(anchor).length!==2)throw Error('pressure body-read anchor changed');
 return {loader:'ts',contents:source.replace(anchor,anchor+'(globalThis as any).__pressureReads.files++;(globalThis as any).__pressureReads.bytes+=file.initial.size;')};
});}});
const {stageHookCapture}=await import(${JSON.stringify(source)}),base=${JSON.stringify(f.base)},cwd=${JSON.stringify(f.cwd)},target=${JSON.stringify(nativeName)};
const held=()=>readdirSync(base+'/hook-spool').some(name=>name===target||name.startsWith(target+'.draining-'));
const samples=[];
for(let index=0;index<32&&held();index++){
 (globalThis as any).__pressureReads={files:0,bytes:0};
 const publication=await stageHookCapture('PostToolUse',{prompt:'bounded native admission '+index},{base,cwd,deferAtCapacity:true});
 if(!publication)throw Error('current native was not admitted');
 samples.push({...((globalThis as any).__pressureReads),deferred:publication.deferred===true});
}
console.log(JSON.stringify({found:!held(),samples}));
`);
  const result = Bun.spawnSync([process.execPath, "--smol", probe], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const report = JSON.parse(result.stdout.toString()) as { found: boolean; samples: { files: number; bytes: number; deferred: boolean }[] };
  expect(report.found).toBe(true); expect(report.samples.length).toBeGreaterThan(1); expect(report.samples.length).toBeLessThanOrEqual(32);
  for (const sample of report.samples) { expect(sample.files).toBeLessThanOrEqual(32); expect(sample.bytes).toBeLessThanOrEqual(256 * 1024); }
  unchanged(summaries);
  const after = pending(f.base), loss = drops(f.base);
  expect(after.filter(row => row.event === "Title")).toHaveLength(255); expect(loss.summary_capacity ?? 0).toBe(0);
  expect(loss.scope_capacity ?? 0).toBeGreaterThan(0);
  expect(256 + report.samples.length).toBe(after.length + (loss.scope_capacity ?? 0));
});
