import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { memoryGitSync } from "../src/memory/platform.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { runCli } from "../src/cli.ts";

test("MCP and CLI expose fixed metadata reasons for marked stale hints", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "amem-stale-output-")), base = join(cwd, "memory");
  expect(memoryGitSync(["-C", cwd, "init", "-q"], { encoding: "utf8" }).status).toBe(0);
  const project = memoryProjectKey(cwd);
  const oldHome = process.env.AMEM_HOME; process.env.AMEM_HOME = base;
  try {
    const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
    const write = (text: string, path: string) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text, about: [`path:${path}`] });
    const missing = write("missing-marker", "branch-only.ts"), newer = write("mtime-marker", "same.ts"), blocked = write("blocked-marker", "hidden/private.ts");
    for (const suffix of ["a", "b"]) store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: `foldstale ${suffix} ${"long content ".repeat(15)}`, task: "fixture-task", about: ["path:branch-only.ts"] });
    store.close();
    writeFileSync(join(cwd, "same.ts"), "same synthetic content\n"); const future = new Date(Date.now() + 60_000); utimesSync(join(cwd, "same.ts"), future, future);
    const mcp = createMemoryMcp({ cwd, base, project, policy: { denyPaths: ["hidden"] } });
    try {
      expect(await mcp.tools.amem_show({ id: blocked })).toBeNull();
      const one = await mcp.tools.amem_show({ id: missing }); expect(one).toMatchObject({ stale: true, staleReason: "missing_in_checkout" });
      const two = await mcp.tools.amem_show({ id: newer }); expect(two).toMatchObject({ stale: true, staleReason: "mtime_newer_than_note" });
      const found = await mcp.tools.amem_search({ query: "marker", limit: 10 }) as { hits: Array<{ view?: { id: string; stale?: boolean; staleReason?: string } }> };
      expect(found.hits.some(hit => hit.view?.id === blocked)).toBe(false);
      expect(found.hits.find(hit => hit.view?.id === missing)?.view).toMatchObject({ stale: true, staleReason: "missing_in_checkout" });
      expect(found.hits.find(hit => hit.view?.id === newer)?.view).toMatchObject({ stale: true, staleReason: "mtime_newer_than_note" });
      const timeline = await mcp.tools.amem_timeline({}) as Array<{ id?: string; staleReason?: string }>;
      expect(timeline.find(row => row.id === missing)).toMatchObject({ staleReason: "missing_in_checkout" });
      expect(timeline.find(row => row.id === newer)).toMatchObject({ staleReason: "mtime_newer_than_note" });
    } finally { mcp.close(); }
    const context = { cwd, env: {} };
    const rows = JSON.parse(await runCli(["list", "--json"], context)) as Array<{ id: string; stale?: boolean; staleReason?: string }>;
    // list --json never had stale annotations: retain the ahub parity shape.
    expect(rows.find(row => row.id === missing)?.staleReason).toBeUndefined();
    expect(rows.find(row => row.id === newer)?.staleReason).toBeUndefined();
    const history = JSON.parse(await runCli(["list", "--history", "--json"], context)) as { entries: Array<{ id: string; stale?: boolean; staleReason?: string }> };
    expect(history.entries.find(row => row.id === missing)).toMatchObject({ stale: true, staleReason: "missing_in_checkout" });
    expect(history.entries.find(row => row.id === newer)).toMatchObject({ stale: true, staleReason: "mtime_newer_than_note" });
    const human = await runCli(["list"], context); expect(human).toContain("(stale? missing)"); expect(human).toContain("(stale? mtime)");
    const marked = { cwd, env: { AMEM_HOME: base, CODEX_THREAD_ID: "fixture", COLUMNS: "80" } };
    for (const args of [["list"], ["search", "marker"]]) {
      const text = await runCli(args, marked);
      expect(text).toContain("(stale: missing)"); expect(text).toContain("(stale: newer)");
    }
    const detail = await runCli(["show", missing], marked);
    expect(detail).toContain("Stale:"); expect(detail).toContain("missing in checkout");
    const folded = await runCli(["search", "foldstale"], marked);
    expect(folded).toContain("(stale: missing)"); expect(folded).toContain("+1 same task");
    const personFolded = await runCli(["search", "foldstale"], context);
    expect(personFolded).toContain("(stale? missing)"); expect(personFolded).toContain("+1 same task");
  } finally {
    if (oldHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldHome;
    rmSync(cwd, { recursive: true, force: true });
  }
});
