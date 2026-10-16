import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MEMORY_SCHEMA, MemoryStore, entryId, type Entry, type Filter, type Kind, type NoteEntry, type NoteInput, type OpEntry, type View } from "../src/memory/store.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { rawMemoryCommand } from "../src/memory/commands.ts";

const DAY = 24 * 3600_000, START = Date.parse("2026-10-16T00:00:00.000Z");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amem-sql-views-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const clock = { now: START };
  const store = new MemoryStore({ home, now: () => clock.now, screen: () => "promote" });
  cleanup.push(() => store.close());
  return { home, store, clock };
}
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
const pick = <T>(rng: () => number, values: readonly T[]): T => values[Math.floor(rng() * values.length)]!;
function shuffled<T>(rng: () => number, values: readonly T[]): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}
const signed = <T extends Omit<NoteEntry, "id"> | Omit<OpEntry, "id">>(row: T) => ({ ...row, id: entryId(row) });

/** Frozen pre-optimization list semantics, using only the unfiltered derived-state path as the oracle. */
function oldSelection(store: MemoryStore, f: Filter = {}): View[] {
  const all = (store as unknown as { live(): View[] }).live();
  const words = f.q?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return all.filter(v => (!f.project || v.project === f.project || v.scope === "shared") && (!f.tier || v.tier === f.tier) && (!f.kind || v.kind === f.kind)
    && (!f.peer || v.peer === f.peer) && (!f.machine || v.machine === f.machine) && (!f.since || Date.parse(v.at) >= Date.parse(f.since))
    && (f.includeSuperseded || !v.supersededBy) && words.every(word => `${v.title ?? ""}\n${v.text}\n${v.about.join(" ")}`.toLowerCase().includes(word)))
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, f.limit ?? 200);
}
function allTables(dir: string): Record<string, unknown[]> {
  const db = new Database(join(dir, "index.db"), { readonly: true });
  db.run("PRAGMA busy_timeout = 3000");
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
  } finally { db.close(); }
}
function segmentBytes(store: MemoryStore): Record<string, string> {
  return Object.fromEntries(["log", "local"].flatMap(sub => readdirSync(join(store.dir, sub)).sort().map(file => [`${sub}/${file}`, createHash("sha256").update(readFileSync(join(store.dir, sub, file))).digest("hex")])));
}
function randomizedRows(seed: number, count = 84): NoteEntry[] {
  const rng = random(seed), kinds: Kind[] = ["decision", "finding", "contract", "fail"];
  const words = ["alpha", "BETA", "한국어", "ÉCOLE", "İSTANBUL", "ΣΟΣ", "😀", "50%", "a_b", "%_"];
  return Array.from({ length: count }, (_, i) => signed({ schema: MEMORY_SCHEMA, op: "note", machine: `fixture-${i % 3}`, project: pick(rng, ["project/a", "project/b", "project/c"]),
    scope: pick(rng, ["project", "shared"] as const), tier: i % 4 === 0 ? "short" : "long", kind: pick(rng, kinds), peer: pick(rng, ["codex", "claude", "pi"]),
    at: new Date(START - Math.floor(rng() * 20) * DAY + (i % 4) * 1000).toISOString(), title: `${pick(rng, words)} title ${i}`,
    text: `${pick(rng, words)} ${pick(rng, words)} body ${i}`, about: [`path:src/${pick(rng, words)}/${i % 6}.ts`], source: "hub",
    ...(i % 4 === 0 ? { expires: new Date(START + (i % 8 === 0 ? -1 : 3) * DAY).toISOString() } : {}),
  }));
}

for (const seed of [0xc0ffee, 0x5eed1234]) test(`SQL view selection equals the old list oracle for randomized filters and lifecycle operations (seed ${seed})`, () => {
  const { store, clock } = fixture(), rng = random(seed), rows = randomizedRows(seed);
  for (const machine of [0, 1, 2]) appendFileSync(join(store.dir, "log", `fixture-${machine}.jsonl`), rows.filter(row => row.machine === `fixture-${machine}`).map(row => JSON.stringify(row)).join("\n") + "\n");
  store.refresh();
  expect(oldSelection(store, { includeSuperseded: true, limit: Number.MAX_SAFE_INTEGER })).toHaveLength(rows.filter(row => !row.expires || Date.parse(row.expires) > START).length);
  const input = (text: string, extra: Partial<NoteInput> = {}): NoteInput => ({ op: "note", project: "project/a", scope: "project", tier: "long", kind: "contract", peer: "codex", text, about: ["path:src/lifecycle.ts"], source: "person", ...extra });
  const superseded = store.note(input("old lifecycle contract")), replacement = store.note(input("new lifecycle contract"));
  expect(store.supersede(superseded, replacement, "user", "project/a")).toBe(true);
  const promoted = store.note(input("promoted lifecycle fail", { tier: "short", kind: "fail" }));
  expect(store.promote(promoted, "user", "project/a")).toBeDefined();
  const demoted = store.note(input("demoted lifecycle decision", { kind: "decision" })); store.demote(demoted, "user", "project/a");
  const forgotten = store.note(input("forgotten lifecycle note")); store.forget(forgotten, "user", "project/a");
  const settled = "project/a#7@1";
  store.note(input("settled lifecycle contract", { tier: "short", task: settled })); expect(store.settle(settled, "user")).toBe(1);

  for (const advance of [0, 30 * DAY]) {
    clock.now = START + advance;
    const visible = oldSelection(store, { includeSuperseded: true, limit: Number.MAX_SAFE_INTEGER });
    const filters: Filter[] = [{}, { project: "project/a" }, { project: "missing" }, { project: "" }, { includeSuperseded: true }];
    for (const limit of [0, 1, 7, 200, Number.MAX_SAFE_INTEGER, -1, -3, 2.75, Number.NaN]) filters.push({ limit }, { project: "project/a", includeSuperseded: true, limit });
    for (const q of ["", " ", "ALPHA", "école", "İSTANBUL", "σός", "한국어", "😀", "50%", "a_b", "%_", "alpha  BETA", "src/"]) filters.push({ q });
    for (const since of ["", "bad-date", "2026-10-01T00:00:00.000Z", "2026-10-15T19:00:00-05:00", "2027-01-01T00:00:00Z"]) filters.push({ since });
    for (const kind of ["decision", "finding", "contract", "fail"] as const) filters.push({ kind });
    for (const tier of ["short", "long"] as const) filters.push({ tier });
    for (const peer of ["codex", "claude", "pi", "missing"]) filters.push({ peer });
    for (const machine of [...new Set(visible.map(row => row.machine)), "missing"]) filters.push({ machine });
    for (let i = 0; i < 160; i++) {
      const row = pick(rng, visible);
      filters.push({ ...(rng() < 0.7 ? { project: pick(rng, [row.project, "project/a", "missing"]) } : {}),
        ...(rng() < 0.5 ? { tier: row.tier } : {}), ...(rng() < 0.5 ? { kind: row.kind } : {}), ...(rng() < 0.4 ? { peer: row.peer } : {}),
        ...(rng() < 0.4 ? { machine: row.machine } : {}), ...(rng() < 0.5 ? { q: pick(rng, [row.text.split(" ")[0]!, row.title ?? "", row.about[0]!, "%", "_"]) } : {}),
        ...(rng() < 0.4 ? { since: pick(rng, [row.at, "2026-10-01T00:00:00Z"]) } : {}), limit: pick(rng, [0, 1, 3, 25, Number.MAX_SAFE_INTEGER]), includeSuperseded: rng() < 0.5 });
    }
    for (const filter of filters) expect(store.list(filter)).toEqual(oldSelection(store, filter));
    const ids = store.list({ project: "project/a", limit: Number.MAX_SAFE_INTEGER }).map(row => row.id);
    expect(ids).not.toContain(forgotten); expect(ids).not.toContain(superseded); expect(ids).not.toContain(promoted);
    const allIds = store.list({ includeSuperseded: true, limit: Number.MAX_SAFE_INTEGER }).map(row => row.id);
    for (const expired of rows.filter(row => row.expires && Date.parse(row.expires) <= clock.now)) expect(allIds).not.toContain(expired.id);
    if (advance) expect(allIds).not.toContain(demoted);
    expect(store.list({ project: "project/a", includeSuperseded: true, limit: Number.MAX_SAFE_INTEGER }).map(row => row.id)).toContain(superseded);
  }
});

for (const seed of [0x12345678, 0x87654321]) test(`shuffled partial UTF-8 segment tails keep all derived tables equal to rebuild (seed ${seed})`, () => {
  const { store } = fixture(), rng = random(seed), rows = randomizedRows(seed, 18);
  const { id: _oldId, ...firstRow } = rows[0]!;
  rows[0] = signed({ ...firstRow, tier: "long", text: "A partial 한국어 😀 tail must wait for its newline." });
  const operations: Entry[] = [
    signed({ schema: MEMORY_SCHEMA, op: "supersede", at: new Date(START).toISOString(), machine: "fixture-ops", target: rows[1]!.id, by: rows[2]!.id, actor: "user" }),
    signed({ schema: MEMORY_SCHEMA, op: "forget", at: new Date(START + 1000).toISOString(), machine: "fixture-ops", target: rows[3]!.id, actor: "user" }),
  ];
  const streams = [0, 1, 2].map(machine => ({ path: `log/fixture-${machine}.jsonl`, bytes: Buffer.from(rows.filter(row => row.machine === `fixture-${machine}`).map(row => JSON.stringify(row)).join("\n") + "\n"), offset: 0 }));
  streams.push({ path: "log/fixture-ops.jsonl", bytes: Buffer.from(operations.map(row => JSON.stringify(row)).join("\n") + "\n"), offset: 0 });
  // Force a cut inside one literal three-byte Korean character, independent of random chunk luck.
  const firstStream = streams[0]!, character = firstStream.bytes.indexOf(Buffer.from("한국어"));
  expect(character).toBeGreaterThan(0);
  firstStream.offset = character + 1;
  expect(firstStream.bytes[firstStream.offset]! & 0xc0).toBe(0x80);
  appendFileSync(join(store.dir, firstStream.path), firstStream.bytes.subarray(0, firstStream.offset));
  store.refresh();
  expect(store.get(rows[0]!.id)).toBeUndefined();
  const partialTables = allTables(store.dir), partialAuthored = segmentBytes(store);
  store.rebuild();
  expect(allTables(store.dir)).toEqual(partialTables);
  expect(segmentBytes(store)).toEqual(partialAuthored);
  let partialUnicode = (firstStream.bytes[firstStream.offset]! & 0xc0) === 0x80;
  while (streams.some(stream => stream.offset < stream.bytes.length)) for (const stream of shuffled(rng, streams)) {
    if (stream.offset === stream.bytes.length) continue;
    const next = Math.min(stream.bytes.length, stream.offset + 1 + Math.floor(rng() * 173));
    if (next < stream.bytes.length && (stream.bytes[next]! & 0xc0) === 0x80) partialUnicode = true;
    appendFileSync(join(store.dir, stream.path), stream.bytes.subarray(stream.offset, next)); stream.offset = next;
    store.refresh();
    const incremental = allTables(store.dir), authored = segmentBytes(store);
    store.rebuild();
    expect(allTables(store.dir)).toEqual(incremental);
    expect(segmentBytes(store)).toEqual(authored);
  }
  expect(partialUnicode).toBe(true);
  expect(store.get(rows[0]!.id)?.text).toBe("A partial 한국어 😀 tail must wait for its newline.");
  const before = allTables(store.dir); store.rebuild(); expect(allTables(store.dir)).toEqual(before);
  expect(store.list({ includeSuperseded: true, limit: Number.MAX_SAFE_INTEGER }).map(row => row.id)).not.toContain(rows[3]!.id);
});

test("raw command readable policy runs before selection cap and returned-row count", async () => {
  const { home, store, clock } = fixture(), project = memoryProjectKey(home), seen: string[][] = [];
  const add = (text: string, extra: Partial<NoteInput> = {}) => { clock.now++; return store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "codex", text, about: [], source: "person", ...extra }); };
  const retained = [add("needle public older"), add("needle public newer")];
  add("needle withheld one"); add("needle withheld two"); add("needle withheld three");
  add("needle foreign private", { project: "foreign", scope: "project" });
  const shared = add("needle public shared", { project: "foreign", scope: "shared" });
  const before = segmentBytes(store);
  const options = { store, open: () => { throw new Error("provided store must be used"); }, importPolicy: () => () => false,
    readable: (rows: View[]) => { seen.push(rows.map(row => row.id)); return rows.filter(row => !row.text.includes("withheld")); } };
  const output = JSON.parse(await rawMemoryCommand(["search", "needle", "--limit", "2", "--json"], home, options)) as View[];
  expect(output.map(row => row.id)).toEqual([shared, retained[1]!]);
  expect(output).toHaveLength(2);
  expect(seen[0]).toHaveLength(6);
  expect(JSON.stringify(output)).not.toContain("withheld"); expect(JSON.stringify(output)).not.toContain("foreign private");
  const single = JSON.parse(await rawMemoryCommand(["list", "--limit", "1", "--json"], home, options)) as View[];
  expect(single.map(row => row.id)).toEqual([shared]);
  expect(seen[1]).toHaveLength(6);
  expect(segmentBytes(store)).toEqual(before);
});

test("SQL candidate projection shares lifecycle snapshot with metadata during a second-handle promotion", () => {
  const { home, store, clock } = fixture(), project = "project/snapshot";
  const source = store.note({ op: "note", project, scope: "project", tier: "short", kind: "contract", peer: "codex", text: "promote between projections", about: [], source: "person" });
  const writer = new MemoryStore({ home, now: () => clock.now, screen: () => "promote" });
  cleanup.push(() => writer.close());
  type ProjectionDb = { query(sql: string): { all(...bindings: unknown[]): unknown[] } };
  const db = (store as unknown as { db: ProjectionDb }).db, query = db.query.bind(db);
  let injected = false, copy: string | undefined;
  db.query = (sql: string) => {
    const statement = query(sql);
    // This is the selected full-row fetch, never prune's expired-only projection.
    if (sql.startsWith("SELECT * FROM entries") && sql.includes("(project = ? OR scope = 'shared')")) return {
      all: (...bindings: unknown[]) => {
        if (!injected) { injected = true; copy = writer.promote(source, "user", project); }
        return statement.all(...bindings);
      },
    };
    return statement;
  };
  try {
    const first = store.list({ project, limit: Number.MAX_SAFE_INTEGER }).map(row => row.id);
    expect(injected).toBe(true); expect(copy).toBeDefined();
    expect(first).toHaveLength(1);
    expect(first.every(id => id === source || id === copy)).toBe(true);
    expect(store.list({ project, limit: Number.MAX_SAFE_INTEGER }).map(row => row.id)).toEqual([copy!]);
  } finally { db.query = query; }
});
