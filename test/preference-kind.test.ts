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
// At or after the release that ships the kind, this build opens a home at `PREFERENCE_MIN_READER`; the older reader's open-time refusal
// is proven against the published N-1 in test/previous-release.test.ts. The write itself is exercised by a reader at 99.0.0 beside its own
// copy of `src`, so these proofs never depend on the released version string.

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

test("this build ships the kind, so it opens a home at the introducing release's floor", () => {
  const r = rig();
  floor(r.memory, PREFERENCE_MIN_READER, "curated");
  // The open is the proof: it succeeds at or after the release that ships the kind, and `test/previous-release.test.ts` proves the older
  // reader's refusal. Pinning equality here would fail the next patch release, which still opens the home.
  new MemoryStore({ memoryDir: r.memory, deferPromotions: true }).close();
});

// A reader whose own version is above the floor: the release that ships the kind. Its `src` copy sits beside a fake package.json, because
// formats.ts reads this release's version from that file when the module loads.
/** An isolated copy of this build's `src` beside a 99.0.0 manifest, so a home carrying the kind's floor can be written and read. */
function futureReader(r: ReturnType<typeof rig>, source: string) {
  const isolated = join(r.root, "future"), job = join(r.root, "job.json"), out = join(r.root, "probe.json");
  cpSync(join(import.meta.dir, "../src"), join(isolated, "src"), { recursive: true });
  // A fake manifest only: these proofs are about the kind, its floor and its readers, never about a released version string.
  writeFileSync(join(isolated, "package.json"), JSON.stringify({ name: "amem-preference-probe", version: "99.0.0", type: "module" }));
  writeFileSync(join(isolated, "probe.ts"), source);
  return (payload: unknown) => {
    writeFileSync(job, JSON.stringify({ ...(payload as object), memory: r.memory, cwd: r.cwd, project: r.project, out }));
    const child = Bun.spawnSync([process.execPath, join(isolated, "probe.ts"), job], { cwd: isolated, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    return JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
  };
}

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
  const result = futureReader(r, PROBE)({}) as unknown as { ids: string[]; kinds: string[]; supersededBy: string | null; imported: boolean; indexEqual: boolean; dumpEqual: boolean; rows: number; accepted: { status?: string; kind: string | null; tier: string | null } };
  expect(result.supersededBy).toBe(result.ids[1]!);
  expect(result.kinds).toEqual(["preference", "preference"]);
  expect(result.imported).toBe(true);
  expect(result.accepted).toEqual({ status: "accepted", kind: "preference", tier: "long" });
  // Four preference rows: three written directly (one superseded) and one accepted from the queue.
  expect(result.rows).toBe(4);
  expect(result.indexEqual).toBe(true);
  expect(result.dumpEqual).toBe(true);
});

// #370 review I1: liveness cannot be decided in SQL — supersession folds from a newer row's `supersedes`, and a forgotten successor
// releases its target again — so the read pages by `at` and resolves liveness before it takes the newest `limit`.
const READ_PROBE = `
import { readFileSync, writeFileSync } from "node:fs";
import { MemoryStore } from "./src/memory/store.ts";
const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
const row = (text, at, over = {}) => ({ op: "note", project: job.project, scope: "project", tier: "long", kind: "preference", peer: "person", source: "person", text, about: [], ...over });
const store = new MemoryStore({ memoryDir: job.memory, deferPromotions: true });
try {
  // Five rules that stay live, then a six-deep supersede chain written after them: the newest rows are all dead but the last, so a
  // slice taken before liveness is filled by the chain and the live rules never reach the slot.
  for (let n = 1; n <= 5; n++) store.importNote(row("live rule " + n, "2026-11-11T00:0" + n + ":00.000Z"), "2026-11-11T00:0" + n + ":00.000Z");
  let previous;
  for (let n = 1; n <= 6; n++) {
    const at = "2026-11-11T00:1" + n + ":00.000Z";
    previous = store.importNote(row("chain rule " + n, at, previous ? { supersedes: previous } : {}), at).id;
  }
  const page = store.readPreferences(job.project, 5), all = store.readPreferences(job.project, 32);
  writeFileSync(job.out, JSON.stringify({ texts: page.rows.map(view => view.text), truncated: page.truncated, everyLive: all.rows.map(view => view.text), everyTruncated: all.truncated }));
} finally { store.close(); }
`;

test("the slot holds the newest live rules even behind a longer supersede chain than its own width", () => {
  const r = rig();
  floor(r.memory, PREFERENCE_MIN_READER, "curated");
  const result = futureReader(r, READ_PROBE)({});
  // Newest first, dead chain rows skipped, the fifth live rule cut off by the slot's width and reported as truncated.
  expect(result.texts).toEqual(["chain rule 6", "live rule 5", "live rule 4", "live rule 3", "live rule 2"]);
  expect(result.truncated).toBe(true);
  // A limit wide enough to hold every live rule returns all six and truncates nothing.
  expect(result.everyLive).toEqual(["chain rule 6", "live rule 5", "live rule 4", "live rule 3", "live rule 2", "live rule 1"]);
  expect(result.everyTruncated).toBe(false);
});

// #370 review N1: a preference is long-term by definition, so the command refuses a short tier instead of writing an expiring rule.
test("a preference refuses a short tier, which would expire the kind that never expires", async () => {
  const r = rig(), empty = authored(r);
  const refusal = await message(cli(r, ["note", "add", "--kind", "preference", "--tier", "short", "always answer in Korean"]));
  expect(refusal).toContain("long-term");
  expect(refusal).toContain("--tier takes long only");
  expect(authored(r)).toEqual(empty);
  // An ordinary kind keeps both tiers: the rule is the preference's, not the command's.
  expect(await cli(r, ["note", "add", "--kind", "finding", "--tier", "short", "a local observation"])).toContain("added finding note");
});

// #370: decay never demotes a preference. The scan needs the kind's floor, so it runs in the introducing release's copy like the write proof.
const DECAY_PROBE = `
import { readFileSync, writeFileSync } from "node:fs";
import { MemoryStore } from "./src/memory/store.ts";
import { decayPreview } from "./src/memory/decay-review.ts";
const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
const row = (kind, text, at) => ({ op: "note", project: job.project, scope: "project", tier: "long", kind, peer: "person", source: "person", text, about: [] });
const store = new MemoryStore({ memoryDir: job.memory, deferPromotions: true });
try {
  const old = "2026-01-01T00:00:00.000Z";
  const preference = store.importNote(row("preference", "always answer in Korean", old), old).id;
  store.importNote(row("finding", "an ordinary old finding", old), old);
  const plan = decayPreview(store, job.project, { days: 90, now: () => Date.parse("2026-11-11T00:00:00.000Z") });
  let requested = null;
  try { decayPreview(store, job.project, { days: 90, now: () => Date.parse("2026-11-11T00:00:00.000Z"), ids: [preference] }); } catch (error) { requested = String(error.message); }
  writeFileSync(job.out, JSON.stringify({ kinds: plan.entries.map(entry => entry.view.kind), requested }));
} finally { store.close(); }
`;

test("decay never demotes a preference, and naming one is refused like any other ineligible target", () => {
  const r = rig();
  floor(r.memory, PREFERENCE_MIN_READER, "curated");
  const result = futureReader(r, DECAY_PROBE)({});
  expect(result.kinds).toEqual(["finding"]);
  expect(result.requested).toBe("requested entry is not eligible for decay");
});

