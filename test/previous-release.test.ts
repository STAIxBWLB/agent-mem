import { createHash } from "node:crypto";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { PLACEMENT_FORMAT, PLACEMENT_PROFILE_SCHEMA, PLACEMENT_SHARDS_SCHEMA, validatePlacementProfile, validatePlacementShards } from "../src/memory/sync-placement-format.ts";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, cpSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PREFERENCE_MIN_READER } from "../src/memory/formats.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { drainHookCaptures, stageHookCapture, stageTranscriptCapture } from "../src/hook-spool.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { indexFileName } from "../src/memory/index-file.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { previousRelease } from "../scripts/previous-release.ts";
import { readEffectiveSyncPlacementWriters } from "../src/memory/sync-placement-effective-writers.ts";
import { readWriterHistory } from "../src/memory/sync-placement-writer-history.ts";
import { readPlacementJournal } from "../src/memory/sync-placement-journal-storage.ts";
import { readPlacementProjection } from "../src/memory/sync-placement-journal.ts";
import { activePlacementWriterContext } from "../src/sync-placement-writer-context.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { openShardStore } from "../src/memory/store.ts";
import { createPlacementInspectionFixture, createInspectionRemote, inspectionGit, inspectionNote, reachableInspectionRowIds, inspectionFilesystemSnapshot } from "./fakes/sync-placement-inspection.ts";

// #199 AC6 / #249: this build and the previous minor line on one shared home. The CI job `previous-release` resolves
// its latest published plain release with scripts/previous-release.ts and sets AMEM_PREV_ROOT; locally the suite skips without it, and
// AMEM_PREV_REQUIRED=1 (set by the job) turns a missing root into a failure instead of a skip.
const root = process.env.AMEM_PREV_ROOT, required = process.env.AMEM_PREV_REQUIRED === "1";
const currentVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

test("previousRelease keeps patches and minor releases on the latest patch of the preceding minor line", () => {
  const published = ["0.19.2", "0.20.0", "0.18.9", "0.19.10", "0.20.3", "0.19.0", "0.21.0", "0.22.1", "1.19.99"];
  expect(previousRelease("0.20.3", published)).toBe("0.19.10");
  expect(previousRelease("0.20.0", published)).toBe("0.19.10");
  expect(previousRelease("0.21.0", published)).toBe("0.20.3");
  expect(previousRelease("0.21.9", published)).toBe("0.20.3");
  expect(previousRelease("0.22.0", published)).toBe("0.21.0");
  expect(previousRelease("0.22.9", published)).toBe("0.21.0");
  expect(previousRelease("0.23.0", published)).toBe("0.22.1");
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

  const previousVersion = root ? (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version : "not configured";
  const previousAtLeast = (minimum: string) => {
    const reader = previousVersion.split(".").map(Number), floor = minimum.split(".").map(Number);
    if (reader.length !== 3 || floor.length !== 3 || ![...reader, ...floor].every(value => Number.isSafeInteger(value) && value >= 0)) throw Error("N-1 capability checks require plain published versions");
    for (let index = 0; index < 3; index++) if (reader[index] !== floor[index]) return reader[index]! > floor[index]!;
    return true;
  };
  const nativeRecordsSupported = !!root && previousAtLeast("0.25.0");
  const preferenceSupported = !!root && previousAtLeast(PREFERENCE_MIN_READER);
  test(`hook-v4: previous ${previousVersion} maintenance/drain preserves non-Claude Records and still drains v2/v3`, async () => {
    const f = fixture(), line = "amem: decision | src/a.ts | retain native transport proof";
    const staged = [];
    for (const agent of ["codex", "kimi", "pi", "qwen", "jcode"]) {
      const record = (await stageTranscriptCapture({ agent, event: "Record", at: new Date().toISOString(), excerpt: line, paths: ["src/a.ts"] }, f.options))!;
      expect(record.name).toStartWith("hook-v4-");
      staged.push({ record, bytes: readFileSync(join(spool(f.base), record.name)) });
    }
    await stageHookCapture("Stop", { last_assistant_message: "v2 native control" }, f.options);
    await stageTranscriptCapture({ agent: "claude", event: "Recap", excerpt: "v3 summary control" }, f.options);
    await stageTranscriptCapture({ agent: "jcode", event: "Title", excerpt: "v3 jcode control" }, f.options);
    const appended = prevHook(f, "old maintenance barrier");
    expect(appended).toContain("claude:old maintenance barrier");
    expect(appended).toContain("claude:v2 native control");
    expect(appended).toContain("claude:v3 summary control");
    expect(appended).toContain("jcode:v3 jcode control");
    if (nativeRecordsSupported) {
      for (const agent of ["codex", "kimi", "pi", "qwen", "jcode"]) expect(appended).toContain(`${agent}:${line}`);
      expect(pending(f.base)).toEqual([]);
    } else {
      expect(appended.some(value => value.includes(line))).toBe(false);
      expect(pending(f.base)).toEqual(staged.map(value => value.record.name).sort());
      for (const value of staged) expect(readFileSync(join(spool(f.base), value.record.name))).toEqual(value.bytes);
    }
    const rows = await drain(f);
    for (const agent of ["codex", "kimi", "pi", "qwen", "jcode"]) expect([...appended, ...rows].filter(value => value === `${agent}:${line}`)).toHaveLength(1);
    expect(pending(f.base)).toEqual([]);
    // AMEM_PREV_ROOT may point explicitly at published 0.24.0 for this upgrade proof;
    // ordinary CI still resolves its actual N-1. Never relabel the old package or current manifest.
    expect(JSON.parse(readFileSync(resolve(root!, "package.json"), "utf8"))).toHaveProperty("version", previousVersion);
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

  // #370 AC4: compare the published reader's capability with the introducing release. Keep the0.24 refusal proof
  // available through AMEM_PREV_ROOT, while0.25+ must read/sync preferences and accept the introducing floor.
  // The writer uses the introducing version's manifest; the authored row/format must not depend on this release's version.
  const preferenceWriter = (f: ReturnType<typeof fixture>, text: string) => {
    const isolated = mkdtempSync(join(tmpdir(), "amem-n1-preference-"));
    try {
      cpSync(join(import.meta.dir, "../src"), join(isolated, "src"), { recursive: true });
      writeFileSync(join(isolated, "package.json"), JSON.stringify({ name: "amem-preference-writer", version: PREFERENCE_MIN_READER, type: "module" }));
      // The person's record: without it this writer refuses as well, and with it the write is the shipping configuration's.
      writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "curated", minReader: PREFERENCE_MIN_READER, since: "2026-11-11" }]) + "\n");
      const child = Bun.spawnSync([process.execPath, "-e", `const { MemoryStore } = await import(${JSON.stringify(pathToFileURL(join(isolated, "src/memory/store.ts")).href)});
const store = new MemoryStore({ memoryDir: ${JSON.stringify(f.base)}, deferPromotions: true });
try { store.note({ op: "note", project: ${JSON.stringify(f.project)}, scope: "project", tier: "long", kind: "preference", peer: "person", source: "person", text: ${JSON.stringify(text)}, about: [] }); } finally { store.close(); }`],
        { cwd: isolated, env: { ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      // Non-vacuity: every arm below is about this row, so prove it reached this machine's own segment.
      const machine = (JSON.parse(readFileSync(join(f.base, "machine.json"), "utf8")) as { id: string }).id;
      expect(readFileSync(join(f.base, "log", `${machine}.jsonl`), "utf8")).toContain('"kind":"preference"');
    } finally { rmSync(isolated, { recursive: true, force: true }); }
  };
  /** An ordinary note from this build: no floor needed, so a preference home keeps rows a read must still return. */
  const ordinaryNote = (f: ReturnType<typeof fixture>, text: string) => {
    const store = new MemoryStore({ memoryDir: f.base, screen: () => "keep" });
    try { store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text, about: [] }); } finally { store.close(); }
  };
  const prevSync = (f: ReturnType<typeof fixture>, remote: string) => JSON.parse(run(f, `const { MemoryStore } = await import(${JSON.stringify(prev("src/memory/store.ts"))});
const { syncMemory } = await import(${JSON.stringify(prev("src/memory/sync.ts"))});
const store = new MemoryStore({ memoryDir: ${JSON.stringify(f.base)} });
try { const result = await syncMemory(store, { remote: ${JSON.stringify(remote)}, visibility: async () => "private" });
  console.log(JSON.stringify({ ok: result.ok, pushed: result.pushed, entries: result.entries, error: result.error ?? null })); } finally { store.close(); }`)) as { ok: boolean; pushed: boolean; entries: number; error: string | null };

  test("#370 (a): previous sync follows its preference capability, and an ordinary control publishes", async () => {
    const f = fixture(), remote = createInspectionRemote(f.root, "n1-preference-sync.git");
    ordinaryNote(f, "a rule the person keeps");
    preferenceWriter(f, "always answer in Korean");
    // The refusal under test is the own-segment screen, so this arm drops the person's floor record: what is left is a home this older
    // release would otherwise publish.
    rmSync(join(f.base, "formats.json"));
    const observed = prevSync(f, remote);
    if (preferenceSupported) expect(observed).toMatchObject({ ok: true, pushed: true, entries: 2, error: null });
    else {
      expect(observed).toMatchObject({ ok: false, pushed: false, entries: 0 });
      expect(observed.error).toContain("not readable as complete valid rows");
    }
    // Control: the same home shape carrying only the ordinary note publishes, so the refusal is the preference row's.
    const control = fixture();
    ordinaryNote(control, "a rule the person keeps");
    const published = prevSync(control, createInspectionRemote(control.root, "n1-preference-control.git"));
    expect(published.ok).toBe(true); expect(published.error).toBeNull(); expect(published.entries).toBeGreaterThan(0);
  });

  test("#370 (b): the introducing preference floor is accepted exactly by capable previous readers", () => {
    const f = fixture();
    ordinaryNote(f, "a rule the person keeps");
    preferenceWriter(f, "always answer in Korean");
    const observed = JSON.parse(run(f, `const { MemoryStore } = await import(${JSON.stringify(prev("src/memory/store.ts"))});
let error = null;
try { new MemoryStore({ memoryDir: ${JSON.stringify(f.base)} }).close(); } catch (caught) { error = { code: caught.code ?? null, message: String(caught.message) }; }
console.log(JSON.stringify({ error }));`)) as { error: { code: string | null; message: string } | null };
    if (preferenceSupported) expect(observed.error).toBeNull();
    else {
      expect(observed.error?.code).toBe("format_floor");
      expect(observed.error?.message).toContain(PREFERENCE_MIN_READER);
    }
  });

  test("#370 (c): previous incremental and rebuilt indexes agree with its preference capability", () => {
    const f = fixture(), expected = ["an ordinary decision", "another ordinary decision", ...(preferenceSupported ? ["always answer in Korean"] : [])].sort();
    ordinaryNote(f, "an ordinary decision"); ordinaryNote(f, "another ordinary decision");
    preferenceWriter(f, "always answer in Korean");
    rmSync(join(f.base, "formats.json"));
    const listed = () => JSON.parse(run(f, `const { MemoryStore } = await import(${JSON.stringify(prev("src/memory/store.ts"))});
const store = new MemoryStore({ memoryDir: ${JSON.stringify(f.base)} });
try { const incremental = store.list({ project: ${JSON.stringify(f.project)} }).map(view => view.text);
  store.rebuild();
  console.log(JSON.stringify({ incremental, rebuilt: store.list({ project: ${JSON.stringify(f.project)} }).map(view => view.text) })); } finally { store.close(); }`)) as { incremental: string[]; rebuilt: string[] };
    const first = listed();
    // Capable readers retain the rule; older readers drop it. Both must agree with a full rebuild.
    expect([...first.incremental].sort()).toEqual(expected);
    expect([...first.rebuilt].sort()).toEqual(expected);
    // A rebuild from a deleted index returns the same rows: every state is folded from the segments, never from the index.
    const previousIndex = run(f, `const { indexFileName } = await import(${JSON.stringify(prev("src/memory/index-file.ts"))}); console.log(indexFileName(false));`);
    expect(previousIndex).toMatch(/^index(?:-[a-z0-9-]+)?[.]db$/);
    rmSync(join(f.base, previousIndex));
    expect([...listed().incremental].sort()).toEqual(expected);
    // The index read the whole segment and stopped at its size, preference line included.
    const machine = (JSON.parse(readFileSync(join(f.base, "machine.json"), "utf8")) as { id: string }).id;
    const db = new Database(join(f.base, previousIndex), { readonly: true });
    try {
      const offset = (db.query("SELECT offset FROM segments WHERE file = ?").get(`log/${machine}.jsonl`) as { offset: number } | null)?.offset;
      expect(offset).toBe(statSync(join(f.base, "log", `${machine}.jsonl`)).size);
    } finally { db.close(); }
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
  test("incomplete sync placement v3 markers are refused before effects; a person-authored floor requests upgrade", () => {
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

  test("a person-authored current-release home floor refuses previous-release v3 read, write and sync before effects", async () => {
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
    // N-1 understands v3. This fake-home test acts as the person excluding older readers with the current release floor.
    writeFileSync(join(active.home,"formats.json"),canonicalJSON([{surface:"home",minReader:currentVersion,since:"2026-11-06"}])+"\n",{mode:0o600});
    const before = active.snapshot(), observed = probe();
    expect(observed.results.map(value=>({operation:value.operation,refused:value.refused}))).toEqual([
      {operation:"read",refused:true},{operation:"write",refused:true},{operation:"sync",refused:true},
    ]);
    expect(observed.effects).toBe(0); expect(observed.admitted).toBe(0);
    for(const value of observed.results){expect(value.code).toBe("format_floor");expect(value.message).toContain(`Upgrade amem to ${currentVersion} or later.`);}
    expect(active.snapshot()).toEqual(before);
    expect(inspectionGit(active.remote,"for-each-ref","--format=%(refname)")).toBe(""); expect(active.reachableIds()).toEqual([]);
  },30_000);

  test("actual same-epoch writer renewal is fenced from N-1 read, write and sync by the person current-release floor",async()=>{
    const runner=fixture(),active=await placementActivationFixture();clean.push(active.close);
    const extra=join(active.root,"N1 measured writer");for(const dir of [extra,join(extra,"src"),join(extra,"bin")])mkdirSync(dir,{mode:0o755});
    writeFileSync(join(extra,"package.json"),canonicalJSON({name:"@staix/agent-mem",version:currentVersion})+"\n",{mode:0o644});
    writeFileSync(join(extra,"src","index.ts"),"// initial measured pin\n",{mode:0o644});writeFileSync(join(extra,"bin","amem.js"),"// isolated fixture, never executed\n",{mode:0o755});
    const initial=active.options("apply");initial.writerRoots=[activationOwnRoot,extra];await activateSyncPlacement(initial);
    const epoch=(JSON.parse(readFileSync(join(active.base,"profile.json"),"utf8")) as {placementHead:string}).placementHead;
    // Only the fake-home test person writes the floor; neither initial activation nor renewal may write it.
    writeFileSync(join(active.base,"formats.json"),canonicalJSON([{surface:"home",minReader:currentVersion,since:"2026-11-06"}])+"\n",{mode:0o600});
    writeFileSync(join(extra,"src","index.ts"),"// upgraded measured pin\n",{mode:0o644});
    const renewal=active.options("apply");renewal.writerRoots=[activationOwnRoot,extra];
    expect(await activateSyncPlacement(renewal)).toMatchObject({active:true,renewed:true,epochHash:epoch,sequence:1});
    const remote=createInspectionRemote(active.root,"renewed-n1.git"),before=inspectionFilesystemSnapshot(active.root);
    const native={...runner,env:{...runner.env,AMEM_HOME:active.base,AGENTHUB_HOME:active.root}};
    const result=JSON.parse(run(native,`const {openShardStore}=await import(${JSON.stringify(prev("src/memory/store.ts"))});
const {syncMemory}=await import(${JSON.stringify(prev("src/memory/sync.ts"))});
let effects=0,admitted=0;Bun.spawn=()=>{effects++;throw Error('unexpected process');};Bun.spawnSync=()=>{effects++;throw Error('unexpected process');};globalThis.fetch=()=>{effects++;throw Error('unexpected fetch');};
const results=[];for(const operation of ['read','write','sync']){let store;try{store=openShardStore({memoryDir:${JSON.stringify(active.base)},project:${JSON.stringify(active.project)}});admitted++;
if(operation==='read')store.list({project:${JSON.stringify(active.project)}});else if(operation==='write')store.note(${JSON.stringify(inspectionNote("N1 must not append after writer renewal",active.project))});else await syncMemory(store,{remote:${JSON.stringify(remote)},visibility:async()=>{effects++;return 'private';}});
results.push({operation,refused:false});}catch(error){results.push({operation,refused:true,code:error.code,message:error.message});}finally{store?.close();}}
console.log(JSON.stringify({results,effects,admitted}));`));
    expect(result.results).toHaveLength(3);for(const value of result.results){expect(value.refused).toBe(true);expect(value.code).toBe("format_floor");expect(value.message).toContain(`Upgrade amem to ${currentVersion} or later.`);}
    expect(result.effects).toBe(0);expect(result.admitted).toBe(0);expect(inspectionFilesystemSnapshot(active.root)).toEqual(before);
    expect(inspectionGit(remote,"for-each-ref","--format=%(refname)")).toBe("");expect(reachableInspectionRowIds(remote)).toEqual([]);
  },60_000);

  test("N-1 reads genuine renewed writer history and journal under the unchanged 0.22 home floor",async()=>{
    const runner=fixture(),active=await placementActivationFixture();clean.push(active.close);
    const extra=join(active.root,"compatible renewed writer");for(const dir of [extra,join(extra,"src"),join(extra,"bin")])mkdirSync(dir,{mode:0o755});
    writeFileSync(join(extra,"package.json"),canonicalJSON({name:"@staix/agent-mem",version:currentVersion})+"\n",{mode:0o644});
    writeFileSync(join(extra,"src","index.ts"),"// original measured writer\n",{mode:0o644});writeFileSync(join(extra,"bin","amem.js"),"// measured only, never executed\n",{mode:0o755});
    const initial=active.options("apply");initial.writerRoots=[activationOwnRoot,extra];await activateSyncPlacement(initial);
    const profile=JSON.parse(readFileSync(join(active.base,"profile.json"),"utf8")),epoch=profile.placementHead as string;
    const remote=createInspectionRemote(active.root,"compatible-renewal.git"),store=openShardStore({memoryDir:active.base,project:active.project,deferPromotions:true});
    try{
      const result=await syncMemory(store,{remote,visibility:async()=>"private",placementAttestation:()=>activePlacementWriterContext(active.base,activationOwnRoot).attest()});
      expect(result.ok,JSON.stringify(result)).toBe(true);expect(result.placementPublication).toMatchObject({exported:1,withheld:1});
    }finally{store.close();}
    // The test person appends the renewal prerequisite only, never a current-release exclusion floor.
    writeFileSync(join(active.base,"formats.json"),canonicalJSON([{surface:"home",minReader:"0.21.0",since:"2026-11-06"},{surface:"home",minReader:"0.22.0",since:"2026-11-06"}])+"\n",{mode:0o600});
    const floorBefore=readFileSync(join(active.base,"formats.json"),"utf8");
    writeFileSync(join(extra,"src","index.ts"),"// genuinely renewed measured writer\n",{mode:0o644});
    const renew=active.options("apply");renew.writerRoots=[activationOwnRoot,extra];expect(await activateSyncPlacement(renew)).toMatchObject({active:true,renewed:true,epochHash:epoch,sequence:1});
    const effective=readEffectiveSyncPlacementWriters(active.base),journal=readPlacementJournal(active.base,epoch);
    const history=readWriterHistory(active.base,{epochHash:epoch,activationHash:journal.activation.seal,homeHash:journal.epoch.homeHash,generation:journal.epoch.generation});
    const projection=readPlacementProjection(active.base,epoch);effective.assertCurrent();history.assertCurrent();
    expect(history.sequence).toBe(1);expect(effective.revisionSequence).toBe(1);expect(journal.sequence).toBeGreaterThan(0);
    expect(projection.states.find(state=>state.key.id===active.declined)?.held).toBe(true);
    const expected={epochHash:epoch,sequence:effective.revisionSequence,headHash:effective.revisionHash,roots:effective.roots,writers:effective.writers,
      current:history.current,commits:history.commits,anchors:history.anchors,journalSequence:journal.sequence,journalHead:journal.headHash,records:journal.records,projection};
    const native={...runner,env:{...runner.env,AMEM_HOME:active.base,AGENTHUB_HOME:active.root}},before=inspectionFilesystemSnapshot(active.base);
    const observed=JSON.parse(run(native,`const {readEffectiveSyncPlacementWriters}=await import(${JSON.stringify(prev("src/memory/sync-placement-effective-writers.ts"))});
const {readWriterHistory}=await import(${JSON.stringify(prev("src/memory/sync-placement-writer-history.ts"))});
const {readPlacementJournal}=await import(${JSON.stringify(prev("src/memory/sync-placement-journal-storage.ts"))});
const {readPlacementProjection}=await import(${JSON.stringify(prev("src/memory/sync-placement-journal.ts"))});
const home=${JSON.stringify(active.base)},epoch=${JSON.stringify(epoch)};
let effects=0;Bun.spawn=()=>{effects++;throw Error('unexpected child');};Bun.spawnSync=()=>{effects++;throw Error('unexpected child');};globalThis.fetch=()=>{effects++;throw Error('unexpected fetch');};
const effective=readEffectiveSyncPlacementWriters(home),journal=readPlacementJournal(home,epoch);
const history=readWriterHistory(home,{epochHash:epoch,activationHash:journal.activation.seal,homeHash:journal.epoch.homeHash,generation:journal.epoch.generation});
const projection=readPlacementProjection(home,epoch);effective.assertCurrent();history.assertCurrent();
console.log(JSON.stringify({epochHash:epoch,sequence:effective.revisionSequence,headHash:effective.revisionHash,roots:effective.roots,writers:effective.writers,
current:history.current,commits:history.commits,anchors:history.anchors,journalSequence:journal.sequence,journalHead:journal.headHash,records:journal.records,projection,effects}));`));
    expect(observed).toEqual({...expected,effects:0});expect(inspectionFilesystemSnapshot(active.base)).toEqual(before);
    expect(readFileSync(join(active.base,"formats.json"),"utf8")).toBe(floorBefore);
    // Ordinary admission is allowed under the old floor. Reader leases/derived housekeeping are not confused with placement writes.
    const placementBefore=inspectionFilesystemSnapshot(join(active.base,"sync-placement"));
    const readable=JSON.parse(run(native,`const {openShardStore}=await import(${JSON.stringify(prev("src/memory/store.ts"))});
let network=0;globalThis.fetch=()=>{network++;throw Error('unexpected fetch');};
const store=openShardStore({memoryDir:${JSON.stringify(active.base)},project:${JSON.stringify(active.project)},deferPromotions:true});
try{console.log(JSON.stringify({allowed:store.get(${JSON.stringify(active.allowed)},${JSON.stringify(active.project)})?.id,declined:store.get(${JSON.stringify(active.declined)},${JSON.stringify(active.project)})?.id,network}));}finally{store.close();}`));
    expect(readable).toEqual({allowed:active.allowed,declined:active.declined,network:0});
    expect(inspectionFilesystemSnapshot(join(active.base,"sync-placement"))).toEqual(placementBefore);expect(reachableInspectionRowIds(remote)).toEqual([active.allowed]);
  },120_000);

  test("without a new floor, N-1 may read unrenewed v3 but refuses an unknown future epoch member before publication",async()=>{
    const runner=fixture(),active=await createPlacementInspectionFixture();clean.push(active.close);
    const native={...runner,env:{...runner.env,AMEM_HOME:active.home,AGENTHUB_HOME:active.root}};
    const result=JSON.parse(run(native,`const {openShardStore}=await import(${JSON.stringify(prev("src/memory/store.ts"))});
const {readPlacementJournal}=await import(${JSON.stringify(prev("src/memory/sync-placement-journal-storage.ts"))});
const {syncMemory}=await import(${JSON.stringify(prev("src/memory/sync.ts"))});
const {writeFileSync,existsSync}=await import('node:fs');
const {inspectionFilesystemSnapshot}=await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir,"fakes/sync-placement-inspection.ts")).href)});
const store=openShardStore({memoryDir:${JSON.stringify(active.home)},project:${JSON.stringify(active.project)},deferPromotions:true});
try{
const readable=store.get(${JSON.stringify(active.ids.project)},${JSON.stringify(active.project)})?.id===${JSON.stringify(active.ids.project)};
writeFileSync(${JSON.stringify(join(active.home,"sync-placement","epochs",active.epochHash,"future-placement-history-v99.json"))},'{}',{mode:0o600});
const before=inspectionFilesystemSnapshot(${JSON.stringify(active.root)});let effects=0,journalRefused=false;
Bun.spawn=()=>{effects++;throw Error('unexpected process');};Bun.spawnSync=()=>{effects++;throw Error('unexpected process');};globalThis.fetch=()=>{effects++;throw Error('unexpected fetch');};
try{readPlacementJournal(${JSON.stringify(active.home)},${JSON.stringify(active.epochHash)});}catch{journalRefused=true;}
const synced=await syncMemory(store,{remote:${JSON.stringify(active.remote)},visibility:async()=>{effects++;return 'private';},placementAttestation:()=>({legacySyncQuiesced:true,writers:${JSON.stringify(active.port.attest().writers)}})});
const unchanged=JSON.stringify(inspectionFilesystemSnapshot(${JSON.stringify(active.root)}))===JSON.stringify(before);
console.log(JSON.stringify({readable,journalRefused,ok:synced.ok,pushed:synced.pushed,effects,unchanged,cache:existsSync(${JSON.stringify(join(active.home,"shard-sync-placement"))})}));
}finally{store.close();}`));
    expect(result).toEqual({readable:true,journalRefused:true,ok:false,pushed:false,effects:0,unchanged:true,cache:false});
    expect(inspectionGit(active.remote,"for-each-ref","--format=%(refname)")).toBe("");expect(active.reachableIds()).toEqual([]);
  },30_000);

  for(const version of ["v1","v2"] as const)test(`inactive ${version} shards preserve previous-release reads, writes and ordinary local Git sync`,async()=>{
    const f = fixture(), original = new MemoryStore({memoryDir:f.base,deferPromotions:true});
    let initial:string;
    try{initial=original.note(inspectionNote(`ordinary ${version} initial source`,f.project));}finally{original.close();}
    const generation=createHash("sha256").update(f.root).digest("hex").slice(0,32);
    expect((await migrateShards({memoryDir:f.base,generation,mode:"apply",authorizedPerson:true,tty:true})).active).toBe(true);
    if(version==="v2")await activatePublicPruneView({memoryDir:f.base,mode:"apply",authorizedPerson:true,tty:true});
    const markerBytes=()=>["profile.json","shards.json"].map(name=>existsSync(join(f.base,name))?readFileSync(join(f.base,name),"utf8"):null);
    const remote=createInspectionRemote(f.root,"ordinary-n1.git"),markers=markerBytes();
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
    expect(markerBytes()).toEqual(markers);
    expect(existsSync(join(f.base,"sync-placement"))).toBe(false);
    const current=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});
    try{expect(current.list({project:f.project}).map(value=>value.id).sort()).toEqual([initial!,observed.written].sort());}finally{current.close();}
  },30_000);

  test("#185 AC3: the previous release reads local doi:/arxiv:/run: nodes and a repo line carrying doi:/arxiv: nodes", async () => {
    const f = fixture();
    const about = ["doi:10.1000/xyz", "arxiv:2401.01234", "run:abc"];
    const store = new MemoryStore({ memoryDir: f.base, deferPromotions: true });
    let id: string;
    try { id = store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", text: "n1 identifier nodes", about, source: "person" }); } finally { store.close(); }
    const { planRepoPromotion } = await import("../src/memory/repo-scope.ts");
    const view = (() => { const s = new MemoryStore({ memoryDir: f.base }); try { return s.get(id, f.project)!; } finally { s.close(); } })();
    const plan = await planRepoPromotion(f.cwd, view);
    expect(plan.line.about).toEqual(["doi:10.1000/xyz", "arxiv:2401.01234"]);
    mkdirSync(join(f.cwd, ".amem"), { recursive: true }); writeFileSync(join(f.cwd, ".amem", "log.jsonl"), plan.text + "\n");
    const observed = JSON.parse(run(f, `const {MemoryStore}=await import(${JSON.stringify(prev("src/memory/store.ts"))});
const {readRepoScope}=await import(${JSON.stringify(prev("src/memory/repo-scope.ts"))});
const {createStandalonePolicy}=await import(${JSON.stringify(prev("src/memory/policy.ts"))});
const s=new MemoryStore({memoryDir:${JSON.stringify(f.base)}});
let local;try{local=s.get(${JSON.stringify(id)},${JSON.stringify(f.project)})?.about;}finally{s.close();}
const repo=await readRepoScope(${JSON.stringify(f.cwd)},createStandalonePolicy());
console.log(JSON.stringify({local,repo:repo.views.map(e=>e.about)}));`)) as { local: string[]; repo: string[][] };
    expect(observed.local).toEqual(about);
    expect(observed.repo).toEqual([["doi:10.1000/xyz", "arxiv:2401.01234"]]);
  });

  test("#216: jcode Title and Compact rows staged by this build are drained once or left pending for it by the previous release", async () => {
    const f = fixture();
    const title = (await stageTranscriptCapture({ agent: "jcode", event: "Title", excerpt: "n1 jcode title", at: "2026-11-08T05:00:00.000Z", session: "0123456789abcdef" }, f.options, "title:n1"))!;
    const compact = (await stageTranscriptCapture({ agent: "jcode", event: "Compact", excerpt: "n1 jcode compact", at: "2026-11-08T05:00:01.000Z", session: "0123456789abcdef" }, f.options, "compact:n1"))!;
    expect(title && compact).toBeTruthy();
    const appended = prevHook(f, "old barrier 216");
    const left = pending(f.base);
    for (const [record, text] of [[title, "jcode:n1 jcode title"], [compact, "jcode:n1 jcode compact"]] as const) {
      expect(appended.includes(text) || left.includes(record.name), `${text} drained or still pending`).toBe(true);
      expect(appended.includes(text) && left.includes(record.name)).toBe(false);
    }
    const rows = await drain(f);
    for (const [record, text] of [[title, "jcode:n1 jcode title"], [compact, "jcode:n1 jcode compact"]] as const) if (left.includes(record.name)) expect(rows).toContain(text);
    expect(pending(f.base)).toEqual([]);
  });

});
