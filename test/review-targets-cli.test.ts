import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { realPath } from "../src/memory/platform.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { createHash } from "node:crypto";
import { loadAmemConfig } from "../src/memory/config.ts";

test("review targets is deterministic and does not write the memory home", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-review-targets-"))), base = join(root, "memory"), project = memoryProjectKey(root), previous = process.env.AMEM_HOME;
  process.env.AMEM_HOME = base;
  try {
    const store = new MemoryStore({ memoryDir: base, deferPromotions: true, now: () => Date.now() - 60 * 86400_000 });
    const id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "fixture NEVER_PUBLIC_", about: [] });
    store.close();
    writeFileSync(join(base, "amem.config.json"), JSON.stringify({ piiPatterns: ["NEVER_PUBLIC_"] }));
    const counters = new CandidateStore({ memoryDir: base });
    counters.recordCounter({ entryId: id, project, deliveryId: "read-only" }, { rendered: 5, delivered: 1, cited: 0 }, "public"); counters.close();
    const snapshot = () => readdirSync(base, { recursive: true, withFileTypes: true }).filter(row => row.isFile() && !row.name.endsWith("-shm")).flatMap(row => {
      const file = join(row.parentPath, row.name), bytes = readFileSync(file);
      return row.name.endsWith("-wal") && bytes.length === 0 ? [] : [[file, createHash("sha256").update(bytes).digest("hex")]];
    }).sort((a, b) => a[0]!.localeCompare(b[0]!));
    const before = snapshot();
    const first = await runCli(["review", "targets", "--json"], { cwd: root, env: {} });
    const second = await runCli(["review", "targets", "--json"], { cwd: root, env: {} });
    expect(JSON.parse(first)).toMatchObject([{ id, reason: "rendered", counts: { rendered: 5, delivered: 1, cited: 0 } }]);
    expect(first).toBe(second);
    expect(JSON.parse(await runCli(["review", "targets", "--json"], { cwd: root, env: { CODEX_THREAD_ID: "fixture" } }))).toEqual([]);
    expect(JSON.parse(await runCli(["review", "targets", "--limit", "101", "--json"], { cwd: root, env: { CODEX_THREAD_ID: "fixture" } }))).toEqual([]);
    expect(snapshot()).toEqual(before);
  } finally { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; rmSync(root, { recursive: true, force: true }); }
});

test("review settings are validated and loaded from the machine configuration", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-review-config-")));
  try {
    const file = join(root, "amem.config.json");
    writeFileSync(file, JSON.stringify({ review: { recheck_days: 45, unused_rendered: 10, unused_days: 20 } }));
    expect(loadAmemConfig(root).config.review).toEqual({ recheck_days: 45, unused_rendered: 10, unused_days: 20 });
    writeFileSync(file, JSON.stringify({ review: { unused_days: 91 } }));
    expect(() => loadAmemConfig(root)).toThrow("review.unused_days");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("decay proposals are accepted through review and do not demote before acceptance", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-review-decay-"))), base = join(root, "memory"), project = memoryProjectKey(root), previous = process.env.AMEM_HOME;
  process.env.AMEM_HOME = base;
  try {
    const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
    const id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "fixture", about: [] });
    store.close();
    const candidates = new CandidateStore({ memoryDir: base });
    candidates.recordCounter({ entryId: id, project, deliveryId: "fixture" }, { rendered: 20, delivered: 20, cited: 0 }, "public"); candidates.close();
    const cli = (args: string[]) => runCli(args, { cwd: root, env: {}, stdinTTY: false });
    expect(JSON.parse(await cli(["decay", "--propose", "--json"]))).toEqual({ unusedInjection: 1 });
    const pending = new CandidateStore({ memoryDir: base });
    const [candidate] = pending.list({ project, kind: "decay" }); pending.close();
    const before = new MemoryStore({ memoryDir: base, deferPromotions: true }); expect(before.get(id, project)?.tier).toBe("long"); before.close();
    const changed = new CandidateStore({ memoryDir: base });
    changed.recordCounter({ entryId: id, project, deliveryId: "fixture" }, { cited: 1 }, "public"); changed.close();
    await expect(cli(["review", "accept", candidate!.id, "--json"])).rejects.toThrow("no longer eligible");
    const unchanged = new MemoryStore({ memoryDir: base, deferPromotions: true }); expect(unchanged.get(id, project)?.tier).toBe("long"); unchanged.close();
    const restored = new CandidateStore({ memoryDir: base });
    restored.recordCounter({ entryId: id, project, deliveryId: "fixture" }, { cited: 0 }, "public"); restored.close();
    await cli(["review", "accept", candidate!.id, "--json"]);
    const after = new MemoryStore({ memoryDir: base, deferPromotions: true }); expect(after.get(id, project)?.tier).toBe("short"); after.close();
  } finally { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; rmSync(root, { recursive: true, force: true }); }
});


test("decay proposals advance past existing candidates", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-review-batch-"))), base = join(root, "memory"), project = memoryProjectKey(root), previous = process.env.AMEM_HOME;
  process.env.AMEM_HOME = base;
  try {
    const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
    const candidates = new CandidateStore({ memoryDir: base });
    for (let i = 0; i < 65; i++) {
      const id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: `fixture ${i}`, about: [] });
      candidates.recordCounter({ entryId: id, project, deliveryId: `fixture-${i}` }, { rendered: 20, delivered: 20, cited: 0 }, "public");
    }
    candidates.close(); store.close();
    const cli = (args: string[]) => runCli(args, { cwd: root, env: {}, stdinTTY: false });
    expect(JSON.parse(await cli(["decay", "--propose", "--json"]))).toEqual({ unusedInjection: 64 });
    const first = new CandidateStore({ memoryDir: base });
    for (const candidate of first.list({ project, kind: "decay" })) first.reject(candidate.id, { project, actor: "person", verdict: "public" });
    first.close();
    expect(JSON.parse(await cli(["decay", "--propose", "--json"]))).toEqual({ unusedInjection: 1 });
    const next = new CandidateStore({ memoryDir: base });
    expect(next.list({ project, kind: "decay" })).toHaveLength(1); next.close();
  } finally { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; rmSync(root, { recursive: true, force: true }); }
});
