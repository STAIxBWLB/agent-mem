import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { processSignature } from "../src/memory/platform.ts";

function fixture(count = 140) {
  const root = mkdtempSync(join(tmpdir(), "amem-brief-capture-window-")), base = join(root, "memory"), project = "capture-window";
  const writer = new CaptureStore({ memoryDir: base, project });
  for (let n = 0; n < count; n++) writer.append({ project, agent: "fixture", event: "PostToolUse", at: new Date(Date.UTC(2026, 9, 23, 0, 0, n)).toISOString(), excerpt: `public row ${n}` });
  const dir = writer.dir; writer.close();
  return { root, base, project, dir, close: () => rmSync(root, { recursive: true, force: true }) };
}
function authoredFiles(base: string): Record<string, { sha: string; mode: number }> {
  const out: Record<string, { sha: string; mode: number }> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(base, rel))) {
      const entry = join(rel, name), stat = statSync(join(base, entry));
      if (stat.isDirectory()) walk(entry);
      else out[entry] = { sha: entry.endsWith(".db-shm") ? "sqlite read marks" : createHash("sha256").update(readFileSync(join(base, entry))).digest("hex"), mode: stat.mode };
    }
  }; walk(""); return out;
}

test("native capture brief reads newest 128 rows across bounded pages without refusing older history or authoring indexes", async () => {
  const f = fixture(), db = new Database(join(f.dir, "capture.db"));
  let reader: CaptureStore | undefined;
  try {
    for (const trigger of ["rows_ai", "rows_ad", "rows_au"]) db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
    db.run("DROP TABLE IF EXISTS fts"); db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const plan = db.query("EXPLAIN QUERY PLAN SELECT id FROM rows ORDER BY at DESC, id DESC LIMIT 129").all() as { detail: string }[];
    expect(plan.some(row => row.detail.includes("rows_at"))).toBe(true);
    expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
    const before = authoredFiles(f.base);
    reader = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, maxReadRows: 128, recentReadRows: true });
    expect(reader.recentReadTruncated).toBe(true);
    const ids: number[] = []; let after: { position: number; id: string } | undefined;
    for (let page = 0; page < 5; page++) {
      const value = reader.readPage({ project: f.project, limit: 32, after });
      ids.push(...value.rows.map(row => row.id));
      if (!value.next) break;
      after = value.next;
    }
    expect(ids).toHaveLength(128); expect(new Set(ids).size).toBe(128);
    expect(Math.min(...ids)).toBe(13); expect(Math.max(...ids)).toBe(140);
    expect(reader.readPage({ project: f.project, limit: 32 }).rows[0]?.excerpt).toBe("public row 139");
    expect(() => reader!.readPage({ project: f.project, limit: 32, query: "public" })).toThrow("query indexes");
    reader.close(); reader = undefined;
    expect(authoredFiles(f.base)).toEqual(before);
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('fts','mcp_fts')").all()).toEqual([]);
    const signature = processSignature(process.pid); expect(signature).toBeDefined();
    const brief = await sessionStartBrief({ cwd: f.root, base: f.base, project: f.project, nativeSession: { signature: signature! }, timeRemaining: () => 2000 });
    expect(brief.context).toContain("public row 139");
    expect(brief.coverage.capture).toBe("partial"); expect(brief.context).not.toContain("capture history deferred");
    expect(brief.tokens).toBeLessThanOrEqual(1200);
  } finally { reader?.close(); db.close(); f.close(); }
});

test("standalone capture and brief keep the full source while native recent selection is opt-in", async () => {
  const f = fixture();
  try {
    const capture = new CaptureStore({ memoryDir: f.base, project: f.project });
    try { expect(capture.rows()).toHaveLength(140); } finally { capture.close(); }
    expect(() => new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, maxReadRows: 128 })).toThrow("row bound exceeded");
    const small = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, maxReadRows: 256, recentReadRows: true });
    try { expect(small.recentReadTruncated).toBe(false); expect(small.rows()).toHaveLength(140); } finally { small.close(); }
    const brief = await sessionStartBrief({ cwd: f.root, base: f.base, project: f.project, policy: { host: { screen: async row => !JSON.stringify(row).includes('public row 139') } } });
    expect(brief.context).toContain("public row 138");
  } finally { f.close(); }
});


test("recent native capture refuses a missing time index without repairing it or scanning old history", () => {
  const f = fixture(), db = new Database(join(f.dir, "capture.db"));
  try {
    db.run("DROP INDEX rows_at");
    expect(() => new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, recentReadRows: true })).toThrow();
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'rows_at'").get()).toBeNull();
    const full = new CaptureStore({ memoryDir: f.base, project: f.project });
    try { expect(full.rows()).toHaveLength(140); } finally { full.close(); }
  } finally { db.close(); f.close(); }
});
