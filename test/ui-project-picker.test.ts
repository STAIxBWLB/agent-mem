import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore } from "../src/memory/candidates.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import * as fs from "node:fs";
import { catalogKeys, readCatalogFresh } from "../src/memory/catalog.ts";
import { appendLifecycle, projectState } from "../src/memory/lifecycle.ts";
import { appendAlias, ensureShardDescriptor } from "../src/memory/shard.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { realPath } from "../src/memory/platform.ts";
import { plugin } from "../src/ui/plugin.ts";

// #359: the console picker lists the same projects as before without opening every shard, and every panel reuses it behind snapshotRevision.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture() {
  const family = realPath(mkdtempSync(join(tmpdir(), "amem-picker-"))), base = join(family, "memory");
  cleanup.push(() => rmSync(family, { recursive: true, force: true }));
  const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = base;
  cleanup.push(() => { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; });
  const note = (project: string, text: string) => {
    const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
    try { ensureShardDescriptor(base, project); store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text, about: [] }); } finally { store.close(); }
  };
  const capture = (project: string) => { const c = new CaptureStore({ memoryDir: base, project }); try { c.append({ project, agent: "fixture", event: "Stop", excerpt: "x" }); } finally { c.close(); } };
  // Notes, capture-only, archived, forgotten, an alias and a candidate-only project, created out of order.
  note("fixture/zeta", "z"); note("fixture/alpha", "a"); capture("fixture/capture-only"); note("fixture/archived", "r"); note("fixture/forgotten", "f");
  appendLifecycle(base, { op: "archive", key: "fixture/archived", actor: "person", machine: "m" });
  appendLifecycle(base, { op: "forget", key: "fixture/forgotten", actor: "person", machine: "m" });
  appendAlias(base, { alias: "fixture/old-alpha", key: "fixture/alpha", actor: "person", machine: "m" });
  const candidates = new CandidateStore({ memoryDir: base });
  try { candidates.put({ project: "fixture/candidate-only", kind: "memory", text: "pending proposal" }, "public"); } finally { candidates.close(); }
  return { family, base, note };
}
const open = async (family: string) => { const provider = await plugin.open({ home: family, log: () => {} }); cleanup.push(() => { void provider.close(); }); return provider; };

test("catalogKeys returns readCatalogFresh's keys in the same order without per-shard stats", () => {
  const { base } = fixture();
  expect(catalogKeys(base)).toEqual(readCatalogFresh(base).map(project => project.key));
});

test("the picker lists the same projects, order and states as the readCatalogFresh-derived list", async () => {
  const { family, base } = fixture();
  const provider = await open(family);
  const listed = (await provider.snapshot({ panel: "goals", after: 0 })).projects as string[];
  // The previous derivation: catalog keys plus candidate projects (first), active only, then by key.
  const waiting = new Set(["fixture/candidate-only"]);
  const expected = [...new Set([...readCatalogFresh(base).map(p => p.key), ...waiting])].filter(key => projectState(base, key) === "active")
    .sort((a, b) => Number(waiting.has(b)) - Number(waiting.has(a)) || a.localeCompare(b));
  expect(listed).toEqual(expected);
  expect(listed).not.toContain("fixture/archived"); expect(listed).not.toContain("fixture/forgotten");
});

test("every panel reuses the cached picker while the revision holds, and a revision change rebuilds it", async () => {
  const { family, note } = fixture();
  const provider = await open(family);
  // A picker build walks projects/ once (walkShards); panels themselves never list that directory.
  const projectsDir = join(realPath(family), "memory", "projects");
  const scans = spyOn(fs, "readdirSync");
  const walks = () => scans.mock.calls.filter(call => call[0] === projectsDir).length;
  try {
    for (const panel of ["goals", "capacity", "find", "goals"]) await provider.snapshot({ panel, after: 0 });
    expect(walks()).toBe(1);
    note("fixture/new-project", "n");
    const before = walks(), after = (await provider.snapshot({ panel: "goals", after: 0 })).projects as string[];
    expect(walks() - before).toBe(1);
    expect(after).toContain("fixture/new-project");
  } finally { scans.mockRestore(); }
});
