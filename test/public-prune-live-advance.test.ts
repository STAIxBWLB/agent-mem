import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { advancePublicPruneView } from "../src/memory/public-prune-advance.ts";
import { canonicalJSON, hashJSON, PROFILE_LOCK_TIMEOUT_MS, readSelector, withProfileLock, writeProfileJSON } from "../src/memory/generation.ts";
import { resolveShardProfile } from "../src/memory/shard.ts";
import { acquireMutation, type MutationHandle } from "../src/memory/mutation.ts";
import { realPath } from "../src/memory/platform.ts";
import { persistPublicPruneInput, preparePublicPruneInput } from "../src/memory/public-prune-inputs.ts";
import { PUBLIC_PRUNE_INTENT, publicPruneViewHash, type PublicPruneViewV1 } from "../src/memory/public-prune-view.ts";
import { publicPruneGraph } from "./fixtures/public-prune-graph.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const now = () => Date.parse("2026-10-01T12:00:00.000Z"), B = "github.com/fixture/unopened";
async function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-live-prune-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const memoryDir = join(root, "memory"), graph = publicPruneGraph(), project = graph.note.project;
  const old = new MemoryStore({ home: root, now, screen: () => "keep" });
  const { id, at, machine, schema: _schema, ...input } = graph.note;
  old.importNote(input as NoteInput, at, { machine, expectedId: id });
  old.note({ ...input, project: B, text: "UNOPENED-PROJECT-CANARY" } as NoteInput); old.close();
  await migrateShards({ memoryDir, generation: "7".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  await activatePublicPruneView({ memoryDir, mode: "apply", authorizedPerson: true, tty: true });
  const profile = resolveShardProfile(memoryDir, { project });
  const prepare = (proof = graph, key = project, previous: string | null = null) => {
    const target = resolveShardProfile(memoryDir, { project: key }), selected = readSelector(memoryDir);
    const binding = { realm: proof.manifest.realm, receivingGeneration: target.generation!, selectorRevision: selected.revision, inputSetHash: previous };
    return persistPublicPruneInput(preparePublicPruneInput({ dir: target.dir, binding, current: () => binding, input: proof.input }));
  };
  const advance = async (view: PublicPruneViewV1, dirs = [profile.dir]) => {
    const handles: MutationHandle[] = [];
    try {
      for (const dir of [...new Set([memoryDir, ...dirs])].sort()) { const handle = acquireMutation(dir); expect(handle).toBeDefined(); handles.push(handle!); }
      return await advancePublicPruneView({ memoryDir, view, expectedRevision: readSelector(memoryDir).revision, mutations: handles });
    } finally { for (const handle of handles.reverse()) handle(); }
  };
  const view = (realms: Record<string, string>): PublicPruneViewV1 => ({ schema: "agent-mem.public-prune-view/v1", receivingGeneration: profile.generation!, realms });
  return { root, memoryDir, graph, project, profile, prepare, advance, view };
}
async function child(root: string, code: string) {
  const file = join(root, `child-${crypto.randomUUID()}.ts`); writeFileSync(file, code);
  const proc = Bun.spawn([process.execPath, file], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, AMEM_HOME: join(root, "unused-memory"), AGENTHUB_HOME: join(root, "unused-hub") } });
  const lines: any[] = []; let diagnostic = "";
  const output = (async () => { let text = ""; for await (const bytes of proc.stdout) {
    text += Buffer.from(bytes).toString(); let end: number;
    while ((end = text.indexOf("\n")) >= 0) { const line = text.slice(0, end); text = text.slice(end + 1); if (line) lines.push(JSON.parse(line)); }
  } })();
  const errors = (async () => { for await (const bytes of proc.stderr) diagnostic += Buffer.from(bytes).toString(); })();
  cleanup.push(async () => { proc.stdin.end(); const guard = setTimeout(() => proc.kill("SIGKILL"), 1000); try { await proc.exited; await Promise.all([output, errors]); } finally { clearTimeout(guard); } });
  const wait = async (index: number) => { for (let n = 0; n < 1000 && lines.length <= index; n++) await Bun.sleep(5); expect(lines.length, diagnostic).toBeGreaterThan(index); return lines[index]; };
  return { proc, lines, wait };
}

test("a second-process live reader rebinds in place after parent advance and filters get/list/FTS without reopen", async () => {
  const f = await fixture(), source = join(import.meta.dir, "../src/memory/store.ts");
  const reader = await child(f.root, `import {openShardStore} from ${JSON.stringify(source)};
const store=openShardStore({memoryDir:${JSON.stringify(f.memoryDir)},project:${JSON.stringify(f.project)},now:()=>${now()},screen:()=>"keep"});
const identity=store.profile;console.log(JSON.stringify({ready:true,pid:process.pid}));
try{for await(const _ of Bun.stdin.stream()){try{console.log(JSON.stringify({visible:!!store.get(${JSON.stringify(f.graph.note.id)},${JSON.stringify(f.project)}),
ids:store.list({project:${JSON.stringify(f.project)}}).map(row=>row.id),hits:store.search("Independent",{project:${JSON.stringify(f.project)},includeCapture:false}).hits.map(hit=>hit.view?.id),
same:identity===store.profile,revision:store.profile.selectorRevision,map:store.profile.pruneInputSetHash}));}catch(error){console.log(JSON.stringify({error:String(error)}));}}}finally{store.close();}`);
  expect((await reader.wait(0)).pid).not.toBe(process.pid);
  reader.proc.stdin.write("read\n"); const before = await reader.wait(1); expect(before.visible).toBe(true);
  const registration = f.prepare(), committed = await f.advance(f.view({ [`project:${f.project}`]: registration.inputSetHash }));
  reader.proc.stdin.write("read\n"); const after = await reader.wait(2);
  expect(after.error).toBeUndefined(); expect(after.visible).toBe(false); expect(after.same).toBe(true); expect(after.revision).toBe(committed.revision);
  expect(after.ids).not.toContain(f.graph.note.id); expect(after.hits).not.toContain(f.graph.note.id); expect(after.map).toBe(committed.viewHash);
});

test("changed unopened realm checks only set metadata and leaves its descriptor/object bodies unopened", async () => {
  const f = await fixture(), store = openShardStore({ memoryDir: f.memoryDir, project: f.project, now }); cleanup.push(() => store.close());
  const proof = publicPruneGraph({ note: { project: B }, manifest: value => { value.realm = { scope: "project", key: B }; } });
  const registration = f.prepare(proof, B), other = resolveShardProfile(f.memoryDir, { project: B });
  await f.advance(f.view({ [`project:${B}`]: registration.inputSetHash }), [other.dir]);
  // A full reader for B now refuses, while A may rebind from complete set metadata alone.
  rmSync(join(other.dir, "public-prune-objects"), { recursive: true }); rmSync(join(other.dir, "public-prune-inputs"), { recursive: true });
  expect(store.get(f.graph.note.id, f.project)?.id).toBe(f.graph.note.id);
  expect(store.profile.selectorRevision).toBe(readSelector(f.memoryDir).revision);
  expect(() => { const unavailable = openShardStore({ memoryDir: f.memoryDir, project: B, now }); unavailable.close(); }).toThrow();
});

for (const change of ["missing realm", "unrelated chain"] as const) test(`live rebinding rejects ${change} even when the replacement has a valid root-map hash`, async () => {
  const f = await fixture(), first = f.prepare(); await f.advance(f.view({ [`project:${f.project}`]: first.inputSetHash }));
  const store = openShardStore({ memoryDir: f.memoryDir, project: f.project, now }); cleanup.push(() => store.close());
  expect(store.get(f.graph.note.id, f.project)).toBeUndefined();
  const unrelated = change === "unrelated chain" ? f.prepare() : undefined;
  const replacement = f.view(unrelated ? { [`project:${f.project}`]: unrelated.inputSetHash } : {}), hash = publicPruneViewHash(replacement), old = readSelector(f.memoryDir).selector!;
  writeFileSync(join(f.memoryDir, "public-prune-input-sets", hash + ".json"), canonicalJSON(replacement) + "\n", { mode: 0o600 });
  const profile = { ...old, pruneInputSetHash: hash }, shards = JSON.parse(readFileSync(join(f.memoryDir, "shards.json"), "utf8"));
  writeProfileJSON(join(f.memoryDir, "shards.json"), { ...shards, selectorRevision: hashJSON(profile) }); writeProfileJSON(join(f.memoryDir, "profile.json"), profile);
  expect(() => store.list({ project: f.project })).toThrow();
});

test("a healthy second-process writer can finish while a synchronous reader waits for its short intent", async () => {
  const f = await fixture(), generation = f.profile.generation!, files = join(import.meta.dir, "../src/memory/generation.ts");
  const writer = await child(f.root, `import {withProfileLock,writeProfileJSON} from ${JSON.stringify(files)};import {unlinkSync} from "node:fs";
await withProfileLock(${JSON.stringify(f.memoryDir)},async()=>{writeProfileJSON(${JSON.stringify(join(f.memoryDir, PUBLIC_PRUNE_INTENT))},{schema:"agent-mem.public-prune-advance/v1",home:${JSON.stringify(f.memoryDir)},generation:${JSON.stringify(generation)}});
console.log(JSON.stringify({ready:true}));await new Promise(resolve=>process.stdin.once("data",resolve));await Bun.sleep(75);unlinkSync(${JSON.stringify(join(f.memoryDir, PUBLIC_PRUNE_INTENT))});});`);
  await writer.wait(0); writer.proc.stdin.write("finish\n");
  expect(readSelector(f.memoryDir).selector?.schema).toBe("agent-mem.profile/v2");
  expect(existsSync(join(f.memoryDir, PUBLIC_PRUNE_INTENT))).toBe(false);
});

test("stuck healthy intents consume at most the fixed wait budget and malformed intents remain untouched", async () => {
  const f = await fixture(), file = join(f.memoryDir, PUBLIC_PRUNE_INTENT);
  writeProfileJSON(file, { schema: "agent-mem.public-prune-advance/v1", home: f.memoryDir, generation: f.profile.generation });
  let clock = 0, slept = 0; const date = spyOn(Date, "now").mockImplementation(() => clock), sleep = spyOn(Bun, "sleepSync").mockImplementation(ms => { clock += Number(ms); slept += Number(ms); });
  try { expect(() => readSelector(f.memoryDir)).toThrow(); expect(slept).toBe(PROFILE_LOCK_TIMEOUT_MS); }
  finally { date.mockRestore(); sleep.mockRestore(); }
  const original = "MALFORMED-INTENT-CANARY"; writeFileSync(file, original);
  expect(() => readSelector(f.memoryDir)).toThrow(); expect(readFileSync(file, "utf8")).toBe(original);
});

test("synchronous profile callbacks release before a queued reader, while v1 admission behavior stays unchanged", async () => {
  const f = await fixture(); let finished = false;
  const operation = withProfileLock(f.memoryDir, () => { finished = true; return 7; });
  expect(finished).toBe(true); expect(existsSync(join(f.memoryDir, "profile.lock"))).toBe(false); expect(await operation).toBe(7);
  const v1 = mkdtempSync(join(tmpdir(), "amem-v1-wait-control-")); cleanup.push(() => rmSync(v1, { recursive: true, force: true }));
  await withProfileLock(v1, () => { expect(readSelector(v1)).toEqual({ revision: "absent" }); });
});
