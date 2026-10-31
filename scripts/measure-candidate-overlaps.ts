// Synthetic JSON-list cost check for #174. Run serially after resource admission.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";

const root = mkdtempSync(join(tmpdir(), "amem-overlap-cost-")), base = join(root, "memory"), project = memoryProjectKey(root);
const previousHome = process.env.AMEM_HOME, notes = 5000, candidates = 100;
try {
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
  try {
    for (let i = 0; i < notes; i++) store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "fixture", source: "person",
      text: `transaction leases protect atomic storage writes variant${i}`, about: [] });
  } finally { store.close(); }
  const sidecar = new CandidateStore({ memoryDir: base });
  try {
    for (let i = 0; i < candidates; i++) sidecar.put({ project, kind: "memory", text: `transaction leases protect recovery checkpoints candidate${i}` }, "public");
  } finally { sidecar.close(); }
  process.env.AMEM_HOME = base;
  const listMs: number[] = [];
  for (let sample = 0; sample < 3; sample++) {
    const started = performance.now(), output = await runCli(["review", "list", "--json"], { cwd: root, env: {} });
    listMs.push(Math.round((performance.now() - started) * 100) / 100);
    const rows = JSON.parse(output) as { overlaps: unknown[] }[];
    if (rows.length !== candidates || rows.some(row => row.overlaps.length !== 3)) throw Error("synthetic overlap fixture lost candidates or hints");
  }
  console.log(JSON.stringify({ fixture: "synthetic", platform: process.platform, bun: Bun.version, notes, candidates, listMs,
    processRssMB: Math.round(process.memoryUsage().rss / 1048576 * 100) / 100 }));
} finally {
  if (previousHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}
