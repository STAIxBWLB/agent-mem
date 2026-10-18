import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_SCHEMA, entryId, type NoteEntry } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { shardDir } from "../src/memory/shard.ts";
import { fts5Available } from "../src/memory/search-fts.ts";

const PROJECTS = 20, ENTRIES = 200_000, PER_PROJECT = ENTRIES / PROJECTS, MACHINE = "ac8ac8ac8ac8ac8a";
const mb = (bytes: number) => Math.round(bytes / 1048576 * 100) / 100;
const round = (value: number) => Math.round(value * 100) / 100;
const home = mkdtempSync(join(tmpdir(), "amem-shard-ac8-")), memoryDir = join(home, "memory");
try {
  mkdirSync(join(memoryDir, "log"), { recursive: true });
  mkdirSync(join(memoryDir, "local"), { recursive: true });
  writeFileSync(join(memoryDir, "machine.json"), JSON.stringify({ id: MACHINE, label: "shard-ac8" }) + "\n");
  const log = join(memoryDir, "log", `${MACHINE}.jsonl`), local = join(memoryDir, "local", `${MACHINE}.jsonl`);
  writeFileSync(local, "");
  let chunk = "";
  for (let i = 0; i < ENTRIES; i++) {
    const project = `github.com/acme/p${i % PROJECTS}`;
    const row: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note", at: new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * 1000).toISOString(), machine: MACHINE,
      project, scope: "project", tier: "long", kind: "finding", peer: "bench", text: `entry ${i} needle${i}`, about: [], source: "person" };
    chunk += JSON.stringify({ ...row, id: entryId(row) }) + "\n";
    if ((i + 1) % 1000 === 0) { appendFileSync(log, chunk); chunk = ""; }
  }
  const migration = await migrateShards({ memoryDir, mode: "apply", generation: "a".repeat(32), authorizedPerson: true, tty: true });
  const target = "github.com/acme/p0", needle = `needle${ENTRIES - PROJECTS}`;
  for (let i = 1; i < PROJECTS; i++) writeFileSync(join(shardDir(memoryDir, `github.com/acme/p${i}`), "index.db"), "poison: sibling must not be opened");
  const child = spawnSync(process.execPath, [join(import.meta.dir, "shard-ac8-child.ts")], { env: { ...process.env, AMEM_AC8_HOME: home, AMEM_AC8_PROJECT: target, AMEM_AC8_NEEDLE: needle }, encoding: "utf8", timeout: 120_000 });
  if (child.status !== 0) throw new Error(`AC8 child exited ${child.status}: ${child.stderr?.slice(0, 500)}`);
  const measured = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { openMs: number; idle: number; maxRSS: number; p95Ms: number; hits: number; siblings: number; engine: string; fts5: boolean };
  const idleRssMB = mb(measured.idle), peakRssMB = mb(measured.maxRSS * 1024);
  const pass = idleRssMB < 100 && peakRssMB < 200 && measured.hits === 1 && measured.siblings === 0 && measured.fts5;
  console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, fts5Available: fts5Available(), projects: PROJECTS, entries: ENTRIES,
    selected: { project: target, entries: PER_PROJECT, openMs: round(measured.openMs), searchP95Ms: round(measured.p95Ms), idleRssMB, peakRssMB, hits: measured.hits, siblingHits: measured.siblings, engine: measured.engine },
    migration: { generation: migration.generation, rows: migration.counts.rows, poisonedSiblingIndexes: PROJECTS - 1, logSha256: createHash("sha256").update(readFileSync(log)).digest("hex") },
    baseline: { name: "#412 E9 single store", openMs: 3900, indexMB: 405, comparison: "reference only, not a direct speedup claim" },
    budgets: { idleRssMB: 100, peakRssMB: 200 }, pass }, null, 2));
  if (!pass) process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
