import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { entryId, KINDS, MEMORY_SCHEMA, MemoryStore, type Graph, type NoteEntry, type View } from "../src/memory/store.ts";
import { memoryGitSync } from "../src/memory/platform.ts";

const ROOT = resolve(import.meta.dir, "..");
const PROJECT = "bench/project-1", MACHINE = "0123456789abcdef", FANOUT = "path:bench/fanout.ts";
const NOW = Date.parse("2026-07-01T00:00:00.000Z");
const SIZES = [2_000, 20_000, 200_000];
const OPERATIONS = ["cold_open", "warm_open", "write", "read", "search", "fanout_graph_2"] as const;
type Operation = typeof OPERATIONS[number];
interface Sample { repeat: number; ms: number; resultCount: number; resultSha256: string }
interface Measurement { operation: Operation; samples: Sample[]; repeats: number; p50Ms: number; p95Ms: number; maxMs: number; stopReason?: string }
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const percentile = (sorted: number[], fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;

function options(argv: string[]): { sizes: number[]; repeats: number } {
  const result = { sizes: SIZES, repeats: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sizes") result.sizes = (argv[++i] ?? "").split(",").map(Number);
    else if (arg === "--repeats") result.repeats = Number(argv[++i]);
    else throw new Error("usage: bun scripts/bench.ts [--sizes 2000,20000,200000] [--repeats N>=10]");
  }
  assert(result.sizes.length > 0 && result.sizes.every(n => SIZES.includes(n)) && new Set(result.sizes).size === result.sizes.length, "sizes must be unique members of 2000,20000,200000");
  assert(Number.isSafeInteger(result.repeats) && result.repeats >= 10, "at least 10 repeats are required");
  return result;
}

function sourceSha(): string {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) entries.push(`${relative(ROOT, path)}\0${sha(readFileSync(path))}\n`);
      else throw new Error("source tree contains a non-regular file");
    }
  };
  walk(join(ROOT, "src"));
  return sha(entries.join(""));
}

interface Fixture { home: string; expectedLong: number; expectedQuery: number; logSha256: string; localSha256: string }
function fixture(root: string, n: number): Fixture {
  const home = join(root, `size-${n}`), dir = join(home, "memory");
  mkdirSync(join(dir, "log"), { recursive: true }); mkdirSync(join(dir, "local"));
  writeFileSync(join(dir, "machine.json"), JSON.stringify({ id: MACHINE, label: "synthetic-benchmark" }) + "\n");
  const log = join(dir, `log/${MACHINE}.jsonl`), local = join(dir, `local/${MACHINE}.jsonl`);
  writeFileSync(log, ""); writeFileSync(local, "");
  let longChunk = "", shortChunk = "", expectedLong = 0, expectedQuery = 0;
  for (let i = 0; i < n; i++) {
    const project = `bench/project-${i % 5}`, shared = i % 10 === 0, short = i % 4 === 0;
    const query = i % 13 === 0;
    const row: Omit<NoteEntry, "id"> = {
      schema: MEMORY_SCHEMA, op: "note", at: new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * 1_000).toISOString(), machine: MACHINE,
      project, scope: shared ? "shared" : "project", tier: short ? "short" : "long", kind: KINDS[Math.floor(i / 4) % KINDS.length]!,
      peer: `bench-peer-${i % 3}`, title: `Synthetic note ${i}`, text: `Synthetic benchmark row ${i}. ${query ? "needle cohort" : "ordinary cohort"}. Preserve deterministic fixture data.`,
      about: [`path:bench/group-${i % 100}.ts`, ...(i % 20 === 0 ? [FANOUT] : [])], source: "person",
      ...(short ? { expires: "2099-01-01T00:00:00.000Z" } : {}),
    };
    const line = JSON.stringify({ ...row, id: entryId(row) }) + "\n";
    if (short) shortChunk += line; else longChunk += line;
    const visible = project === PROJECT || shared;
    if (visible && !short) expectedLong++;
    if (visible && query) expectedQuery++;
    if ((i + 1) % 1_000 === 0 || i + 1 === n) {
      appendFileSync(log, longChunk); appendFileSync(local, shortChunk); longChunk = ""; shortChunk = "";
    }
  }
  return { home, expectedLong, expectedQuery, logSha256: sha(readFileSync(log)), localSha256: sha(readFileSync(local)) };
}

const open = (home: string) => new MemoryStore({ home, now: () => NOW, screen: () => "skip" });
function discardIndex(home: string): void {
  for (const file of ["index.db", "index.db-wal", "index.db-shm"]) rmSync(join(home, "memory", file), { force: true });
}
function views(rows: View[], expected: number): { count: number; digest: string } {
  assert(rows.length === Math.min(50, expected) && rows.length > 0, "read/search returned an unexpected count");
  return { count: rows.length, digest: sha(JSON.stringify(rows.map(row => row.id))) };
}
function graphResult(graph: Graph): { count: number; digest: string } {
  assert(graph.nodes.length > 10 && graph.edges.length > 0, "fanout graph returned no meaningful workload");
  const ids = new Set(graph.nodes.map(node => node.id));
  assert(graph.edges.every(edge => ids.has(edge.from) && ids.has(edge.to)), "fanout graph contains a dangling endpoint");
  return { count: graph.nodes.length, digest: sha(JSON.stringify({ nodes: graph.nodes.map(node => node.id).sort(), edges: graph.edges.map(edge => `${edge.from}\0${edge.rel}\0${edge.to}`).sort() })) };
}

function measure(n: number, repeats: number, operation: Operation, before: (repeat: number) => void, work: (repeat: number) => unknown, after: (value: unknown, repeat: number) => { count: number; digest: string }): Measurement {
  const samples: Sample[] = [], coldStart = performance.now();
  let stopReason: string | undefined;
  for (let repeat = 0; repeat < repeats; repeat++) {
    before(repeat);
    const start = performance.now(), value = work(repeat), ms = performance.now() - start;
    const result = after(value, repeat);
    samples.push({ repeat: repeat + 1, ms, resultCount: result.count, resultSha256: result.digest });
    if (n === 200_000 && operation === "cold_open" && samples.length < repeats && performance.now() - coldStart > 600_000) {
      stopReason = "200K cold-open series exceeded 10 minutes; remaining cold repeats not run"; break;
    }
  }
  const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
  if (operation !== "write") assert(new Set(samples.map(sample => sample.resultSha256)).size === 1, `${operation} results changed between repeats`);
  return { operation, samples, repeats: samples.length, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted.at(-1)!, ...(stopReason ? { stopReason } : {}) };
}

function runSize(root: string, n: number, repeats: number) {
  const f = fixture(root, n), measurements: Measurement[] = [];
  const validateOpen = (value: unknown) => {
    const store = value as MemoryStore;
    try { const counts = store.counts(); assert(counts.long + counts.short === n, "open did not index exactly N fixture entries"); return { count: n, digest: sha(`${counts.long}:${counts.short}`) }; }
    finally { store.close(); }
  };
  measurements.push(measure(n, repeats, "cold_open", () => discardIndex(f.home), () => open(f.home), validateOpen));
  // Index setup is outside warm-open timing, including after an early cold-series stop.
  { const initial = open(f.home); initial.close(); }
  measurements.push(measure(n, repeats, "warm_open", () => {}, () => open(f.home), validateOpen));
  const store = open(f.home);
  try {
    measurements.push(measure(n, repeats, "write", () => {}, repeat => store.note({ op: "note", project: "bench/write-isolated", scope: "project", tier: "short", kind: "finding", peer: "bench-writer", text: `Synthetic appended write ${repeat}`, about: [], source: "person" }), (value, repeat) => {
      const id = value as string; assert(store.get(id, "bench/write-isolated")?.text === `Synthetic appended write ${repeat}`, "write did not append and refresh");
      return { count: 1, digest: sha(id) };
    }));
    measurements.push(measure(n, repeats, "read", () => {}, () => store.list({ project: PROJECT, tier: "long", limit: 50 }), value => views(value as View[], f.expectedLong)));
    measurements.push(measure(n, repeats, "search", () => {}, () => store.list({ project: PROJECT, q: "needle cohort", limit: 50 }), value => views(value as View[], f.expectedQuery)));
    measurements.push(measure(n, repeats, "fanout_graph_2", () => {}, () => store.graph(PROJECT, FANOUT, 2, 200), value => graphResult(value as Graph)));
  } finally { store.close(); }
  return { n, fixture: { total: n, projects: 5, sharedEvery: 10, shortEvery: 4, kinds: [...KINDS], queryEvery: 13, fanoutEvery: 20, fanoutCap: 200, expectedLong: f.expectedLong, expectedQuery: f.expectedQuery, logSha256: f.logSha256, localSha256: f.localSha256 }, measurements };
}

function main(): void {
  const args = options(process.argv.slice(2));
  const supplied = process.env.AMEM_BENCH_SOURCE_COMMIT;
  const git = supplied ? undefined : memoryGitSync(["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const sourceCommit = supplied ?? (git?.status === 0 ? git.stdout.toString().trim() : "");
  assert(/^[0-9a-f]{40,64}$/.test(sourceCommit), "cannot identify source commit");
  const cpu = cpus(), root = mkdtempSync(join(tmpdir(), "amem-synthetic-bench-"));
  try {
    const report = {
      schema: "agent-mem.benchmark/v1", protocol: "p6-synthetic-v1", sourceCommit, sourceCommitSource: supplied ? "caller-supplied (remote mirror excludes .git)" : "git", sourceSha256: sourceSha(), harnessSha256: sha(readFileSync(import.meta.path)),
      environment: { cpuModel: cpu[0]?.model ?? "unavailable", logicalCores: cpu.length, architecture: arch(), ramBytes: totalmem(), bun: Bun.version, os: platform(), osRelease: release() },
      caveats: ["Cold means index absent, not cold OS page cache. No cache flush is attempted.", "Same process: JIT and OS caches may warm across repetitions and operations.", "Fixture generation, index deletion, result validation and close are outside timed operations.", "Write appends one isolated project note and refreshes; read/search/graph result cohorts do not include appended notes.", "p50/p95 use nearest-rank on raw milliseconds; fewer than ten samples are allowed only for 200K cold series after ten minutes."],
      requested: args, workloads: args.sizes.map(n => runSize(root, n, args.repeats)),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); }
}
try { main(); } catch { console.error("benchmark failed; synthetic setup, source identity or workload validation failed (no personal paths logged)"); process.exitCode = 1; }
