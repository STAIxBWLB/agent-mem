import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, entryId, MEMORY_SCHEMA, type NoteEntry } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { realPath } from "../src/memory/platform.ts";
import type { SegmentReader } from "../src/memory/bridge.ts";

// Synthetic review receipt, not a latency target or a live-home benchmark.
const NOW = Date.parse("2030-01-01T00:00:00.000Z"), MACHINE = "0123456789abcdef", G = "c".repeat(32);
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const root = realPath(mkdtempSync(join(tmpdir(), "amem-generation-read-bench-")));
const results: unknown[] = [];
function summarize(samplesMs: number[]) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return { samplesMs, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] };
}
try {
  for (const size of [2000, 20000]) {
    const home = join(root, String(size)), memoryDir = join(home, "memory"), segment = join(memoryDir, "log", `${MACHINE}.jsonl`);
    mkdirSync(join(memoryDir, "log"), { recursive: true }); mkdirSync(join(memoryDir, "local"));
    writeFileSync(join(memoryDir, "machine.json"), JSON.stringify({ id: MACHINE, label: "synthetic-review" }) + "\n");
    const line = (i: number) => {
      const body: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note", at: new Date(NOW + i).toISOString(), machine: MACHINE,
        project: "agent-hub", scope: "project", tier: "long", kind: "finding", peer: "person", source: "person",
        text: `synthetic generation read receipt ${i}`, about: ["path:public.ts"] };
      return JSON.stringify({ ...body, id: entryId(body) }) + "\n";
    };
    writeFileSync(segment, Array.from({ length: size }, (_, i) => line(i)).join(""));
    await migrate({ memoryDir, generation: G, mode: "apply", authorizedPerson: true, tty: true, now: () => NOW });
    let store: MemoryStore | undefined;
    const open = () => new MemoryStore({ home, now: () => NOW, deferPromotions: true });
    try {
      store = open(); store.list({ project: "agent-hub", limit: 50 });
      for (const workload of ["warm_unchanged", "reopen_unchanged", "live_append", "cold_changed"] as const) {
        if (workload === "live_append") (store ??= open()).rebuild(); // Seed live SHA state outside the measured samples.
        const samples: number[] = [];
        const ioSamples: ReturnType<SegmentReader["metrics"]>[] = [];
        for (let repeat = 0; repeat < 10; repeat++) {
          if (workload === "reopen_unchanged" || workload === "cold_changed") { store?.close(); store = undefined; }
          if (workload === "live_append" || workload === "cold_changed") appendFileSync(segment, line(size + repeat + (workload === "cold_changed" ? 10 : 0)));
          const reader = (value: MemoryStore) => (value as unknown as { generationIndex: { reader: SegmentReader } }).generationIndex.reader;
          if (store) reader(store).resetMetrics();
          const start = performance.now(); store ??= open();
          const rows = store.list({ project: "agent-hub", limit: 50 });
          samples.push(performance.now() - start);
          ioSamples.push(reader(store).metrics());
          if (rows.length !== 50) throw new Error("generation read benchmark returned unexpected rows");
        }
        results.push({ size, workload, repeats: samples.length, ...summarize(samples), ioSamples });
      }
    } finally { store?.close(); }
  }
  const memorySource = join(import.meta.dir, "../src/memory");
  console.log(JSON.stringify({ schema: "agent-mem.generation-read-bench/v1", bun: Bun.version, os: platform(), release: release(), arch: arch(),
    harnessSha256: sha(readFileSync(import.meta.path)), sourceSha256: sha(readdirSync(memorySource).filter(name => name.endsWith(".ts")).sort().map(name => `${name}:${sha(readFileSync(join(memorySource, name)))}`).join("\n")),
    notes: "Synthetic homes only. Reopen samples include constructor+list; warm/live samples include list+refresh. Live SHA state is seeded by an untimed rebuild. IO metrics count segment-reader data/prefix hashing, excluding small metadata and parsed row validation. Live growth still reads/compares prefix bytes but hashes only suffix; cold changed seeds prefix once. P95 with 10 samples is the maximum. No before/after speedup claim.", results }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
