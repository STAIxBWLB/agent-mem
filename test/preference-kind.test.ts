import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { PREFERENCE_MIN_READER } from "../src/memory/formats.ts";
import { realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore, type NoteInput } from "../src/memory/store.ts";

// #370: a curated `preference` is person-owned, long-term, and gated on the memory home's person-recorded format floor: a released reader
// sharing the home drops an unknown kind, then refuses its own machine's whole sync publish over that row.
//
// A floor at `PREFERENCE_MIN_READER` is above this build's own version until the release PR that ships the kind, and a floor above the
// reader refuses at store open by design (formats.ts). So the write itself is exercised by a reader at 99.0.0 beside its own copy of `src`,
// and this build is used here for the refusals and for that open-time refusal.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function rig() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-preference-"))); roots.push(root);
  const memory = join(root, "memory"), cwd = join(root, "repo");
  mkdirSync(memory, { recursive: true }); mkdirSync(join(cwd, ".git"), { recursive: true });
  return { root, memory, cwd, project: memoryProjectKey(cwd) };
}
async function cli(r: ReturnType<typeof rig>, args: string[]): Promise<string> {
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = r.memory;
  try { return await runCli(args, { cwd: r.cwd, env: {}, stdinTTY: true }); } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}
const message = (promise: Promise<string>) => promise.then(() => "ok", error => (error as Error).message);
/** A person records the floor by hand: amem never writes formats.json. */
const floor = (memory: string, minReader: string, surface: "curated" | "home") =>
  writeFileSync(join(memory, "formats.json"), JSON.stringify([{ surface, minReader, since: "2026-11-11" }]) + "\n");
const open = (r: ReturnType<typeof rig>) => new MemoryStore({ memoryDir: r.memory, deferPromotions: true });
const preference = (project: string, text: string, over: Partial<NoteInput> = {}): NoteInput =>
  ({ op: "note", project, scope: "project", tier: "long", kind: "preference", peer: "person", source: "person", text, about: [], ...over });
/** Every authored byte on the home, so a refusal can be shown to have written nothing (and to have created no segment directory). */
function authored(r: ReturnType<typeof rig>): Record<string, string> {
  const files: Record<string, string> = {};
  for (const folder of ["log", "local"]) {
    const dir = join(r.memory, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) files[`${folder}/${name}`] = readFileSync(join(dir, name), "utf8");
  }
  return files;
}

test("a preference note is refused below the home's floor, naming the cause, the record and the contract, and writes nothing", async () => {
  const r = rig();
  const empty = authored(r);
  const refusal = await message(cli(r, ["note", "add", "--kind", "preference", "always answer in Korean"]));
  expect(refusal).toContain(PREFERENCE_MIN_READER);
  expect(refusal).toContain("formats.json");
  expect(refusal).toContain('"surface":"curated"');
  expect(refusal).toContain("Versions on one machine (#199)");
  expect(refusal).toContain("sync publish");
  // The refusal wrote nothing at all, not even an empty segment directory.
  expect(authored(r)).toEqual(empty);
  // A floor naming an older reader is refused the same way, on either surface the check reads. Both stay at or below this build's own
  // version, so the refusal under test is the kind gate rather than the open-time floor of a home written by a newer release.
  for (const [surface, minReader] of [["curated", "0.24.0"], ["home", "0.23.1"]] as const) {
    floor(r.memory, minReader, surface);
    expect(await message(cli(r, ["note", "add", "--kind", "preference", "always answer in Korean"]))).toContain(PREFERENCE_MIN_READER);
    expect(authored(r)).toEqual(empty);
  }
  // Another kind on the same home is unaffected: the gate is the kind's, not the writer's.
  expect(await cli(r, ["note", "add", "--kind", "decision", "an ordinary decision"])).toContain("added decision note");
});

test("the second own-segment writer, importNote, obeys the same floor", () => {
  const r = rig(), at = "2026-11-11T00:00:00.000Z";
  floor(r.memory, "0.24.0", "curated");
  const store = open(r);
  try {
    expect(() => store.importNote(preference(r.project, "imported rule", { source: "claude-mem" }), at)).toThrow(PREFERENCE_MIN_READER);
    expect(store.list({ project: r.project })).toEqual([]);
  } finally { store.close(); }
});

test("amem_remember queues a preference candidate without a floor, and its acceptance is refused until the floor is raised", async () => {
  const r = rig();
  const mcp = createMemoryMcp({ cwd: r.cwd, base: r.memory, project: r.project });
  let id: string;
  try { id = ((await mcp.tools.amem_remember!({ kind: "preference", text: "prefer terse answers" })) as { id: string }).id; } finally { mcp.close(); }
  // Queueing wrote no curated row: the note exists only after the person accepts it.
  expect(open(r).list({ project: r.project })).toEqual([]);
  const candidates = new CandidateStore({ memoryDir: r.memory });
  try {
    expect(candidates.get(id, r.project)).toMatchObject({ status: "pending", input: { kind: "memory", noteKind: "preference" } });
    const accept = () => { const store = open(r); try { return candidates.accept(id, { project: r.project, actor: "person", verdict: "public", store, policy: () => true }); } finally { store.close(); } };
    expect(accept).toThrow(PREFERENCE_MIN_READER);
    // The refusal lands before the sidecar marks the candidate accepting, so it stays replayable rather than stranded.
    expect(candidates.get(id, r.project)!.status).toBe("pending");
    expect(open(r).list({ project: r.project })).toEqual([]);
  } finally { candidates.close(); }
});

test("a floor at the introducing release refuses this build at store open, before any read or write", () => {
  const r = rig();
  floor(r.memory, PREFERENCE_MIN_READER, "curated");
  let error: { code?: string; message: string } | undefined;
  try { new MemoryStore({ memoryDir: r.memory, deferPromotions: true }).close(); }
  catch (caught) { error = caught as { code?: string; message: string }; }
  expect(error?.code).toBe("format_floor");
  expect(error?.message).toContain(PREFERENCE_MIN_READER);
  expect(authored(r)).toEqual({});
});

// A reader whose own version is above the floor: the release that ships the kind. Its `src` copy sits beside a fake package.json, because
// formats.ts reads this release's version from that file when the module loads.
const PROBE = `
import { readFileSync, writeFileSync } from "node:fs";
import { MemoryStore } from "./src/memory/store.ts";
import { CandidateStore } from "./src/memory/candidates.ts";
import { createMemoryMcp } from "./src/mcp-memory.ts";
const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pref = (text, over = {}) => ({ op: "note", project: job.project, scope: "project", tier: "long", kind: "preference", peer: "person", source: "person", text, about: [], ...over });
const open = () => new MemoryStore({ memoryDir: job.memory, deferPromotions: true });
const out = {};
let store = open();
try {
  const first = store.note(pref("answer in Korean")), second = store.note(pref("answer in Korean, terse", { supersedes: first }));
  store.note(pref("never rewrite main without asking", { scope: "shared" }));
  out.ids = [first, second];
  out.kinds = store.list({ project: job.project }).map(row => row.kind).sort();
  out.supersededBy = store.get(first, job.project)?.supersededBy ?? null;
  out.imported = store.importNote(pref("imported rule", { source: "claude-mem" }), "2026-11-11T00:00:00.000Z").added;
  const incremental = JSON.stringify(store.derivedTables()), dump = store.dump();
  store.rebuild();
  out.indexEqual = incremental === JSON.stringify(store.derivedTables());
  out.dumpEqual = dump === store.dump();
  out.rows = store.list({ project: job.project, includeSuperseded: true }).length;
} finally { store.close(); }
const mcp = createMemoryMcp({ cwd: job.cwd, base: job.memory, project: job.project });
let queued;
try { queued = (await mcp.tools.amem_remember({ kind: "preference", text: "prefer terse answers" })).id; } finally { mcp.close(); }
const candidates = new CandidateStore({ memoryDir: job.memory });
store = new MemoryStore({ memoryDir: job.memory, deferPromotions: true, screen: () => "promote" });
try {
  const accepted = candidates.accept(queued, { project: job.project, actor: "person", verdict: "public", store, policy: () => true });
  out.accepted = { status: candidates.get(queued, job.project)?.status, kind: store.get(accepted.noteId, job.project)?.kind ?? null, tier: store.get(accepted.noteId, job.project)?.tier ?? null };
} finally { store.close(); candidates.close(); }
writeFileSync(job.out, JSON.stringify(out));
`;

test("a reader at the introducing release writes both own-segment paths, accepts a queued preference and indexes it like a rebuild", async () => {
  const r = rig();
  floor(r.memory, PREFERENCE_MIN_READER, "curated");
  const isolated = join(r.root, "future"), out = join(r.root, "probe.json"), job = join(r.root, "job.json");
  cpSync(join(import.meta.dir, "../src"), join(isolated, "src"), { recursive: true });
  // A fake manifest only: this proof is about the kind's floor and readers, never about a released version string.
  writeFileSync(join(isolated, "package.json"), JSON.stringify({ name: "amem-preference-probe", version: "99.0.0", type: "module" }));
  writeFileSync(join(isolated, "probe.ts"), PROBE);
  writeFileSync(job, JSON.stringify({ memory: r.memory, cwd: r.cwd, project: r.project, out }));
  const child = Bun.spawnSync([process.execPath, join(isolated, "probe.ts"), job], { cwd: isolated, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(readFileSync(out, "utf8")) as { ids: string[]; kinds: string[]; supersededBy: string | null; imported: boolean; indexEqual: boolean; dumpEqual: boolean; rows: number; accepted: { status?: string; kind: string | null; tier: string | null } };
  expect(result.supersededBy).toBe(result.ids[1]!);
  expect(result.kinds).toEqual(["preference", "preference"]);
  expect(result.imported).toBe(true);
  expect(result.accepted).toEqual({ status: "accepted", kind: "preference", tier: "long" });
  // Four preference rows: three written directly (one superseded) and one accepted from the queue.
  expect(result.rows).toBe(4);
  expect(result.indexEqual).toBe(true);
  expect(result.dumpEqual).toBe(true);
});
