import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { appendAlias } from "../src/memory/shard.ts";
import { readCatalog, rebuildCatalog, scanCatalog } from "../src/memory/catalog.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "amem-catalog-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function capture(dir: string, project: string, rows: [string, string][]): void {
  const store = new CaptureStore({ home: dir, project });
  cleanup.push(() => store.close());
  for (const [at, excerpt] of rows) store.append({ project, agent: "kimi", event: "PostToolUse", excerpt, at });
}

test("catalog.db is derived only from the shards and rebuilds to the same rows (#15 D3)", () => {
  const dir = home(), base = join(dir, "memory");
  capture(dir, "github.com/owner/a", [["2026-10-16T00:00:00.000Z", "alpha row one"], ["2026-10-17T00:00:00.000Z", "alpha row two"]]);
  capture(dir, "local-project@a1b2c3d4", [["2026-10-15T00:00:00.000Z", "local row"]]);
  appendAlias(base, { alias: "old-a", key: "github.com/owner/a", actor: "person", machine: "m1" });
  const first = rebuildCatalog({ home: dir });
  expect(first).toHaveLength(2);
  const alpha = first.find((p) => p.key === "github.com/owner/a")!;
  expect(alpha).toMatchObject({ local: false, aliases: ["old-a"], captureRows: 2, captureLastAt: "2026-10-17T00:00:00.000Z", capMb: 512, retentionDays: 90 });
  expect(alpha.captureBytes).toBeGreaterThan(0);
  expect(first.find((p) => p.key === "local-project@a1b2c3d4")).toMatchObject({ local: true, captureRows: 1 });
  // The stored read matches the scan, and a rebuild after deleting the database reproduces it exactly.
  expect(readCatalog({ home: dir })).toEqual(first);
  rmSync(join(base, "catalog.db"));
  expect(rebuildCatalog({ home: dir })).toEqual(first);
  expect(readCatalog({ home: dir })).toEqual(scanCatalog(base));
  // A later shard appears on the next rebuild; the stored catalog is honest about lagging.
  capture(dir, "github.com/owner/b", [["2026-10-17T01:00:00.000Z", "beta row"]]);
  expect(readCatalog({ home: dir })).toHaveLength(2);
  expect(rebuildCatalog({ home: dir })).toHaveLength(3);
});
