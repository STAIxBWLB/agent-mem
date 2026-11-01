import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { drainHookCaptures, stageHookCapture } from "../src/hook-spool.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { assertFormatFloor, FORMAT_SURFACES, FORMATS_FILE, readFormatFloors } from "../src/memory/formats.ts";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

// #199 AC5: a reader below a floor recorded in the home refuses with a named reason and writes nothing.
const fixtures: ReturnType<typeof hookFixture>[] = [], originalHome = process.env.HOME;
afterEach(() => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; for (const f of fixtures.splice(0)) f.close(); });
function fixture() { const f = hookFixture(); fixtures.push(f); process.env.HOME = f.env.HOME; mkdirSync(f.base, { recursive: true }); return f; }
function snapshot(dir: string): string[] {
  const rows: string[] = [];
  const walk = (at: string) => { for (const name of readdirSync(at).sort()) { const file = join(at, name), stat = lstatSync(file);
    rows.push(`${file} ${stat.mode} ${stat.isDirectory() ? "dir" : `${stat.size} ${stat.mtimeMs} ${readFileSync(file).toString("base64")}`}`); if (stat.isDirectory()) walk(file); } };
  walk(dir); return rows;
}
const floor = (base: string, records: unknown) => writeFileSync(join(base, FORMATS_FILE), JSON.stringify(records));
const note = (project: string) => ({ op: "note" as const, project, scope: "project" as const, tier: "long" as const, kind: "finding" as const, peer: "person", text: "floor fixture", about: [], source: "person" as const });
const input = (cwd: string) => ({ cwd, hook_event_name: "PostToolUse", prompt: "floor", tool_name: "Read", tool_input: { file_path: "a.ts" } });

test("every surface below its floor refuses with format_floor and leaves the home byte for byte as it was", async () => {
  const f = fixture(), project = memoryProjectKey(f.cwd);
  const seed = new MemoryStore({ memoryDir: f.base, screen: () => "keep" }); seed.note(note(project));
  const open = seed; // a handle opened before the floor existed: sync still checks at its own start
  expect(await stageHookCapture("PostToolUse", input(f.cwd), { cwd: f.cwd, base: f.base })).toBeDefined();
  floor(f.base, [{ surface: "home", minReader: "99.0.0", since: "2026-11-01" }]);
  const before = snapshot(f.base);
  const refusals: [string, () => unknown][] = [
    ["curated", () => new MemoryStore({ memoryDir: f.base })],
    ["curated", () => openShardStore({ memoryDir: f.base, project })],
    ["capture", () => new CaptureStore({ memoryDir: f.base, project })],
    ["candidates", () => new CandidateStore({ memoryDir: f.base })],
    ["work-lists", () => new WorkListStore({ base: f.base, project, policy: () => true })],
  ];
  for (const [surface, run] of refusals) {
    let error: unknown; try { run(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "format_floor", floor: { surface: "home", minReader: "99.0.0", since: "2026-11-01" } });
    expect((error as Error).message).toContain(`below the ${surface} format floor 99.0.0 (since 2026-11-01)`);
  }
  await expect(syncMemory(open, { remote: join(f.base, "no-remote") })).rejects.toMatchObject({ code: "format_floor" });
  // Hooks never deny: below the floor they stage, drain and maintain nothing.
  expect(await stageHookCapture("PostToolUse", input(f.cwd), { cwd: f.cwd, base: f.base })).toBeUndefined();
  expect(await drainHookCaptures({ cwd: f.cwd, base: f.base, project }, () => { throw Error("nothing is drained below the floor"); })).toEqual({ captured: [], blocked: 1 });
  expect(snapshot(f.base)).toEqual(before);
  open.close();
});

test("a floor names one surface; at or below this version, or for another surface, it does not refuse", () => {
  const f = fixture(), version = (JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;
  floor(f.base, [{ surface: "candidates", minReader: "99.0.0", since: "2026-11-01" }, { surface: "curated", minReader: version, since: "2026-11-01" }, { surface: "a-future-surface", minReader: "99.0.0", since: "2026-11-01" }]);
  expect(() => assertFormatFloor(f.base, "candidates")).toThrow("below the candidates format floor 99.0.0");
  for (const surface of FORMAT_SURFACES.filter(name => name !== "candidates")) expect(() => assertFormatFloor(f.base, surface)).not.toThrow();
  new MemoryStore({ memoryDir: f.base }).close();
  expect(readFormatFloors(f.base)).toHaveLength(3); // this package reads the file and never rewrites it
});

test("a floor file this version cannot read refuses as format_floor_unreadable", () => {
  const f = fixture();
  for (const text of ["not json", "{}", JSON.stringify([{ surface: "curated", minReader: "next", since: "x" }]), JSON.stringify([{ surface: "curated" }])]) {
    writeFileSync(join(f.base, FORMATS_FILE), text);
    expect(() => assertFormatFloor(f.base, "curated")).toThrow(expect.objectContaining({ code: "format_floor_unreadable" }));
  }
});

test("no source file writes formats.json: raising a floor is a person's step", () => {
  const src = resolve(import.meta.dir, "../src"), offenders: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file); else if (/\.ts$/.test(entry.name) && entry.name !== "formats.ts" && /formats\.json|FORMATS_FILE/.test(readFileSync(file, "utf8"))) offenders.push(file);
  } };
  walk(src);
  expect(offenders).toEqual([]);
  expect(readFileSync(join(src, "memory", "formats.ts"), "utf8")).not.toMatch(/writeFileSync|writeSync|appendFileSync|renameSync|linkSync/);
});
