/** Isolated public-handler latency probe. Run with a checkout path and optional sample count, never a real HOME. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const checkout = resolve(process.argv[2] ?? "."), runs = Number(process.argv[3] ?? 3), count = 3000;
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw Error("samples must be 1..10");
const core = await import(pathToFileURL(join(checkout, "src/memory/store.ts")).href);
const api = await import(pathToFileURL(join(checkout, "src/mcp-memory.ts")).href);
const platform = await import(pathToFileURL(join(checkout, "src/memory/platform.ts")).href);
const revision = platform.memoryGitSync(["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const dirty = !!platform.memoryGitSync(["-C", checkout, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim();
const root = mkdtempSync(join(tmpdir(), "amem-recall-latency-")), base = join(root, "memory"), project = "recall-latency-fixture", now = Date.now();
let memory: ReturnType<typeof api.createMemoryMcp> | undefined;
try {
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src/bench.ts"), "public benchmark path\n");
  const store = new core.MemoryStore({ memoryDir: base, deferPromotions: true });
  try {
    let segment = "";
    for (let n = 0; n < count; n++) {
      const body = { schema: core.MEMORY_SCHEMA, op: "note", at: new Date(now - (count - n) * 1000).toISOString(), machine: store.machine.id, project, scope: "project", tier: "long", kind: ["fail", "decision", "contract"][n % 3], peer: "benchmark", source: "person", text: `screeningneedle public writer boundary ${n}`, about: ["path:src/bench.ts"] };
      segment += JSON.stringify({ ...body, id: core.entryId(body) }) + "\n";
    }
    writeFileSync(join(store.dir, "log", `${store.machine.id}.jsonl`), segment, { mode: 0o600 }); store.rebuild();
  } finally { store.close(); }
  memory = api.createMemoryMcp({ cwd: root, base, project });
  const measure = async (name: string, args: Record<string, unknown>) => {
    const handler = memory!.tools[name]; if (typeof handler !== "function") return null;
    const values: number[] = [];
    for (let sample = 0; sample < runs; sample++) {
      const start = performance.now(), result = await handler(args); values.push(Number((performance.now() - start).toFixed(2)));
      if (name === "amem_search" && result.hits?.length !== 10 || name === "amem_brief" && (result.state !== "known" || !result.brief || result.bytes > 2048)) throw Error("timed read did not return seeded public evidence");
    }
    return { ms: values, medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] };
  };
  console.log(JSON.stringify({ schema: "amem.recall-latency/v1", platform: process.platform, bun: Bun.version, checkout, revision, dirty, count, runs,
    search: await measure("amem_search", { query: "screeningneedle", includeCapture: false, limit: 10 }),
    brief: await measure("amem_brief", { intent: "writer boundary", paths: ["src/bench.ts"], maxBytes: 2048 }) }, null, 2));
} finally { try { memory?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
