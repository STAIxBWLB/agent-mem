/** Isolated producer benchmark for #359 while agent-console#105's perf-snapshots.ts is unavailable. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "../src/ui/plugin.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { ensureShardDescriptor } from "../src/memory/shard.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";

const root = mkdtempSync(join(tmpdir(), "amem-snapshot-perf-")), family = join(root, "hub"), base = join(family, "memory");
const project = "fixture/console-performance", previousHome = process.env.AMEM_HOME;
let provider: Awaited<ReturnType<typeof plugin.open>> | undefined;
try {
  process.env.AMEM_HOME = base;
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
  try {
    ensureShardDescriptor(base, project);
    for (let n = 0; n < 500; n++) store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person",
      title: `Fixture decision ${n}`, text: `콘솔 성능 측정용 기록 ${n}. Preserve external writes and privacy screening across repeated snapshots.`, about: [] });
  } finally { store.close(); }
  const candidates = new CandidateStore({ memoryDir: base });
  try { candidates.put({ project, kind: "memory", text: "성능 측정용 후보, 같은 revision의 반복 계산 방지" }, "public"); } finally { candidates.close(); }
  const capture = new CaptureStore({ memoryDir: base, project });
  try { capture.append({ project, agent: "fixture", event: "Recap", excerpt: "격리된 콘솔 측정용 대화 요약" }); } finally { capture.close(); }
  const work = new WorkListStore({ base, project, policy: () => true });
  try { await work.write("fixture", { task: "snapshot performance", status: "doing" }); } finally { work.close(); }
  const opening = performance.now();
  provider = await plugin.open({ home: family, log: line => console.error(line) });
  const openMs = performance.now() - opening, rows: { panel: string; firstMs: number; warmMs: number[]; unchangedMs: number; cursor: number }[] = [];
  for (const panel of ["review", "recap", "capacity", "timeline", "work"]) {
    const times: number[] = []; let cursor = 0;
    for (let call = 0; call < 3; call++) {
      const started = performance.now(), result = await provider.snapshot({ panel, project, after: 0 });
      times.push(performance.now() - started);
      if (result.error || !Number.isSafeInteger(result.cursor)) throw Error(`fixture ${panel} unavailable`);
      cursor = Number(result.cursor);
    }
    const started = performance.now(), unchanged = await provider.snapshot({ panel, project, after: cursor });
    const unchangedMs = performance.now() - started;
    if (unchanged.changed !== false || Object.keys(unchanged).sort().join() !== "changed,cursor") throw Error(`fixture ${panel} did not return the unchanged contract`);
    rows.push({ panel, firstMs: times[0]!, warmMs: times.slice(1), unchangedMs, cursor });
  }
  const recap = rows.find(row => row.panel === "recap")!;
  const writer = new MemoryStore({ memoryDir: base });
  try { writer.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text: "new external event after warm polling", about: [] }); }
  finally { writer.close(); }
  const changed = await provider.snapshot({ panel: "recap", project, after: recap.cursor });
  if (changed.error || changed.changed === false || changed.cursor === recap.cursor) throw Error("external event did not invalidate recap");
  console.log(JSON.stringify({ diagnostic: "amem-console-snapshots", runtime: Bun.version, fixtureNotes: 500, openMs, rows, externalWriteInvalidated: true,
    upstreamPerfScript: "not run: agent-console#105 has not supplied scripts/perf-snapshots.ts" }, null, 2));
  if (openMs >= 5000 || recap.warmMs.some(ms => ms >= 200) || recap.unchangedMs >= 100) throw Error("console snapshot fixture budget exceeded");
} finally {
  await provider?.close();
  if (previousHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}
