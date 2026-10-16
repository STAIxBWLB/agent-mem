import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, type CandidateInput, type CandidateVerdict, type CounterKey } from "../../src/memory/candidates.ts";
import { rawMemoryCommand } from "../../src/memory/commands.ts";
import { importClaudeMem } from "../../src/memory/import.ts";
import { memoryProjectKey } from "../../src/memory/project.ts";
import { MemoryStore, type NoteInput, type PromotionScreen, type View } from "../../src/memory/store.ts";

const MARKER = "SYNTHETIC-PRIVATE-MARKER", START = Date.parse("2026-10-16T00:00:00.000Z");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(screen: PromotionScreen = () => "skip") {
  const root = mkdtempSync(join(tmpdir(), "amem-c3-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ home: root, now: () => START, screen }); cleanup.push(() => store.close());
  const project = memoryProjectKey(root);
  const note = (extra: Partial<NoteInput> = {}) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "synthetic-peer", text: `${MARKER} stored content`, title: MARKER, about: [`path:${MARKER}/fixture.ts`], task: `${MARKER}#1@1`, source: "person", ...extra });
  return { root, store, project, note };
}
const fail = (project: string): CandidateInput => ({ project, kind: "fail", approach: "ordinary approach", symptom: "ordinary symptom", cause: "ordinary cause", evidenceRefs: ["test:ordinary"], retryWhen: "ordinary retry condition" });

// This is an injected host policy, not a privacy classifier supplied by agent-mem.
test("C3 raw readable policy receives every View field for list search and show", async () => {
  const f = fixture(), id = f.note(), view = f.store.get(id, f.project)!;
  for (const field of Object.keys(view) as (keyof View)[]) {
    const marker = JSON.stringify(view[field]);
    let observed = false;
    const readable = (rows: View[]) => rows.filter(row => {
      expect(Object.keys(row).sort()).toEqual(Object.keys(view).sort());
      if (JSON.stringify(row[field]) === marker) { observed = true; return false; }
      return true;
    });
    const options = { store: f.store, open: () => f.store, readable, importPolicy: () => () => false };
    expect(JSON.parse(await rawMemoryCommand(["list", "--json"], f.root, options))).toEqual([]);
    expect(JSON.parse(await rawMemoryCommand(["search", MARKER, "--json"], f.root, options))).toEqual([]);
    await expect(rawMemoryCommand(["show", id, "--json"], f.root, options)).rejects.toThrow("withheld");
    expect(observed).toBe(true);
  }
});

test("C3 core reads remain unscreened and raw graph is an explicit person-only host ceiling", async () => {
  const f = fixture(() => "keep"), id = f.note();
  expect(f.store.list({ project: f.project })[0]?.text).toContain(MARKER);
  expect(f.store.get(id, f.project)?.title).toBe(MARKER);
  let calls = 0;
  const graph = await rawMemoryCommand(["graph", id, "--json"], f.root, { store: f.store, open: () => f.store, readable: () => { calls++; return []; }, importPolicy: () => () => false });
  expect(calls).toBe(0); expect(graph).toContain(MARKER);
});

test("C3 promotion screen receives complete views and refuses private markers in every textual input field", () => {
  for (const field of ["title", "text", "peer", "project", "task", "about"] as const) {
    let checked: View | undefined;
    const f = fixture(view => { checked = structuredClone(view); return JSON.stringify(view).includes(MARKER) ? "keep" : "promote"; });
    const extra: Partial<NoteInput> = { tier: "short", title: "ordinary", text: "ordinary", peer: "synthetic-peer", project: "synthetic/project", task: "synthetic/project#1@1", about: [] };
    if (field === "about") extra.about = [`path:${MARKER}/fixture.ts`]; else extra[field] = MARKER;
    const id = f.note(extra);
    expect(f.store.promote(id, "person")).toBeUndefined();
    expect(JSON.stringify(checked)).toContain(MARKER); expect(f.store.get(id)?.tier).toBe("short");
  }
});

test("C3 import policy screens title and body and secret screen skips both without changing source bytes", () => {
  const f = fixture(), file = join(f.root, "synthetic-claude-mem.db"), db = new Database(file);
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  const rows = [[MARKER, "ordinary body"], ["ordinary title", MARKER], ["password: synthetic-title-only", "ordinary body"], ["ordinary title", "password: synthetic-body-only"], ["ordinary title", "ordinary body"]];
  for (const [i, row] of rows.entries()) db.query("INSERT INTO observations VALUES (?, 'fixture', ?, ?, NULL, ?, ?)").run(i + 1, row[0]!, row[1]!, START, JSON.stringify({ peer: "synthetic-peer", kind: "contract" }));
  db.query("INSERT INTO observations VALUES (6, 'fixture', 'ordinary title', NULL, ?, ?, ?)").run(MARKER, START, JSON.stringify({ peer: "synthetic-peer", kind: "contract" }));
  db.query("INSERT INTO observations VALUES (7, 'fixture', 'ordinary title', NULL, ?, ?, ?)").run("password: synthetic-narrative-only", START, JSON.stringify({ peer: "synthetic-peer", kind: "contract" }));
  db.close(); const bytes = readFileSync(file), seen: string[] = [];
  const result = importClaudeMem(f.store, { project: f.project, chain: ["fixture"], db: file, isPii: text => { seen.push(text); return text.includes(MARKER); } });
  expect(result).toMatchObject({ added: 1, skipped: { pii: 3, secret: 3, model: 0 } });
  expect(seen.some(text => text.startsWith(MARKER))).toBe(true); expect(seen.some(text => text.endsWith(MARKER))).toBe(true);
  expect(readFileSync(file)).toEqual(bytes); expect(JSON.stringify(f.store.list())).not.toContain(MARKER);
});

test("C3 candidate verdicts reject private pii and unknown payloads before any sidecar row", () => {
  const f = fixture(), sidecar = new CandidateStore({ home: f.root, now: () => START }); cleanup.push(() => sidecar.close());
  for (const verdict of ["private", "pii", "unknown"] as CandidateVerdict[]) {
    for (const field of ["project", "approach", "symptom", "cause", "evidenceRefs", "retryWhen"] as const) {
      const input = fail(f.project); if (input.kind !== "fail") throw new Error("fixture kind");
      if (field === "evidenceRefs") input.evidenceRefs = [MARKER]; else input[field] = MARKER;
      expect(() => sidecar.put(input, verdict)).toThrow("privacy verdict");
    }
    for (const kind of ["correction", "decay"] as const) for (const field of ["project", "reason", ...(kind === "correction" ? ["proposedText"] : [])]) {
      const input = { project: f.project, kind, target: { id: "a".repeat(32), revision: "b".repeat(64) }, reason: "ordinary reason", ...(kind === "correction" ? { proposedText: "ordinary proposal" } : {}), [field]: MARKER } as CandidateInput;
      expect(() => sidecar.put(input, verdict)).toThrow("privacy verdict");
    }
  }
  expect(sidecar.list({ project: f.project, status: "all" })).toEqual([]); expect(sidecar.list({ project: MARKER, status: "all" })).toEqual([]);
});

test("C3 counters require a public verdict for every valid contextual field and keep unknown distinct from zero", () => {
  const f = fixture(), sidecar = new CandidateStore({ home: f.root, now: () => START }); cleanup.push(() => sidecar.close());
  for (const verdict of ["private", "pii", "unknown"] as CandidateVerdict[]) for (const field of ["project", "task", "turn", "session", "deliveryId"] as const) {
    const key: CounterKey = { entryId: "a".repeat(32), project: f.project, deliveryId: "synthetic-delivery", [field]: MARKER };
    expect(() => sidecar.recordCounter(key, { rendered: 0, delivered: null, cited: null }, verdict)).toThrow("privacy verdict");
  }
  expect(sidecar.counters(f.project)).toEqual([]); expect(sidecar.counters(MARKER)).toEqual([]);
  const key = { entryId: "a".repeat(32), project: f.project, deliveryId: "public-synthetic-delivery" };
  sidecar.recordCounter(key, { rendered: 0, delivered: null }, "public");
  expect(sidecar.counters(f.project)[0]).toMatchObject({ rendered: 0, delivered: null, cited: null });
});
