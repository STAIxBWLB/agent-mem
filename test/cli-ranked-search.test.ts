import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { rawMemoryCommand } from "../src/memory/commands.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { fts5Available, setFts5AvailableForTest } from "../src/memory/search-fts.ts";
import { MemoryStore, type View } from "../src/memory/store.ts";

const roots: string[] = [], savedHome = process.env.AMEM_HOME;
afterEach(() => {
  setFts5AvailableForTest(undefined);
  if (savedHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = savedHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-ranked-cli-")); roots.push(root);
  process.env.AMEM_HOME = join(root, "memory");
  const project = memoryProjectKey(root), displayNow = Date.now(); let at = displayNow - 120000;
  const store = new MemoryStore({ home: root, now: () => at, screen: () => "keep" });
  const note = (text: string, fields: Partial<Pick<View, "kind" | "peer" | "tier" | "about">> & { task?: string } = {}) => {
    at += 1000;
    return store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "writer", text, about: [], source: "person", ...fields }, fields.tier === "short");
  };
  const context = { cwd: root, env: {}, stdinTTY: false, now: () => displayNow };
  const search = async (...args: string[]) => JSON.parse(await runCli(["search", ...args, "--json"], context)) as View[];
  return { root, project, store, note, context, search };
}

test("person CLI uses curated store.search ranking and keeps the legacy --filter", async () => {
  if (!fts5Available()) return;
  const f = fixture();
  try {
    const strong = f.note("needle needle needle"), recent = f.note("needle " + "ordinary filler ".repeat(40));
    const expected = f.store.search("needle", { project: f.project, includeCapture: false }).hits.map(hit => hit.view!);
    expect(expected[0]!.id).toBe(strong);
    expect(await f.search("needle")).toEqual(expected);
    const explained = await f.search("needle", "--explain");
    expect(explained.map(row => row.id)).toEqual(expected.map(row => row.id));
    expect(explained.every(row => "scoreDetails" in row)).toBe(true);
    const repeatedExplain = await f.search("needle", "--explain", "--explain");
    expect(repeatedExplain.map(row => row.id)).toEqual(explained.map(row => row.id));
    expect(repeatedExplain.every(row => "scoreDetails" in row)).toBe(true);
    const plainText = await runCli(["search", "needle"], f.context), explainedText = await runCli(["search", "needle", "--explain"], f.context);
    expect(plainText).not.toContain("Scores"); expect(explainedText).toContain("Scores");
    expect(explainedText.split("\n\n> Scores")[0]).toBe(plainText);
    expect((await f.search("needle", "--filter")).map(row => row.id)).toEqual([recent, strong]);
    expect((await f.search("needle", "--filter", "--filter")).map(row => row.id)).toEqual([recent, strong]);
    f.note("lighthouse"); f.note("beacon");
    expect((await f.search("lighthouse", "beacon")).length).toBe(2);
    expect(await f.search("lighthouse", "beacon", "--filter")).toEqual([]);
  } finally { f.store.close(); }
});

test("long folded hits keep their count and screened capture is marked not evidence", async () => {
  const f = fixture();
  try {
    f.note(`foldmarker ${"long text ".repeat(30)}`, { task: "fixture-task", about: ["path:missing-fixture.ts"] });
    f.note(`foldmarker ${"another text ".repeat(30)}`, { task: "fixture-task", about: ["path:missing-fixture.ts"] });
    const capture = new CaptureStore({ memoryDir: join(f.root, "memory"), project: f.project });
    let id: number;
    try { const row = capture.append({ project: f.project, agent: "codex", event: "Stop", excerpt: "capturemarker public", paths: [], subagent: true }); if (!("id" in row)) throw Error("fixture capture was spooled"); id = row.id; } finally { capture.close(); }
    const marked = { cwd: f.root, env: { CODEX_THREAD_ID: "fixture", AMEM_HOME: join(f.root, "memory"), COLUMNS: "80" }, stdinTTY: false };
    for (const context of [f.context, marked]) {
      const output = await runCli(["search", "foldmarker"], context);
      expect(output).toContain("+1 same task");
    }
    const captured = await runCli(["search", "capturemarker"], marked);
    expect(captured).toContain("not evidence"); expect(captured).toContain("subagent");
    const shown = await runCli(["show", `capture:${id}`], marked);
    expect(shown).toMatch(/Evidence:\s+no/); expect(shown).toMatch(/Subagent:\s+yes/);
  } finally { f.store.close(); }
});

test("metadata filters precede the effective limit, capture stays out, and reads do not promote", async () => {
  const f = fixture();
  try {
    const wanted = f.note("needle weak " + "public context ".repeat(20), { kind: "contract", peer: "reader", tier: "short" });
    for (let index = 0; index < 55; index++) f.note(`needle needle needle leader ${index}`);
    const args = ["needle", "--kind", "contract", "--peer", "reader", "--tier", "short", "--machine", f.store.machine.id, "--limit", "1"];
    const rows = await f.search(...args);
    expect(rows.map(row => row.id)).toEqual([wanted]); expect(rows[0]!.tier).toBe("short");
    const explained = await f.search(...args, "--explain");
    expect(explained.map(row => row.id)).toEqual([wanted]);
    expect(explained[0]).toHaveProperty("scoreDetails");
    expect(await f.search(...args, "--since", new Date(Date.now()).toISOString())).toEqual([]);
    expect(await f.search("needle", "--machine", "not-this-machine")).toEqual([]);
    const capture = new CaptureStore({ home: f.root, project: f.project });
    try { capture.append({ project: f.project, agent: "fixture", event: "PostToolUse", excerpt: "captureonly" }); }
    finally { capture.close(); }
    expect(await f.search("captureonly")).toEqual([]);
    const check = new MemoryStore({ home: f.root, deferPromotions: true });
    try { expect(check.get(wanted, f.project)?.tier).toBe("short"); }
    finally { check.close(); }
  } finally { f.store.close(); }
});

test("legacy empty/history modes, fallback and unscreened person fields remain compatible", async () => {
  const f = fixture();
  try {
    const first = f.note("password: synthetic-fixture needle"), second = f.note("needle current");
    expect((await f.search()).map(row => row.id)).toEqual([second, first]);
    expect((await f.search("password")).map(row => row.id)).toEqual([first]);
    const history = await runCli(["search", "needle", "--history", "--json"], f.context);
    expect(JSON.parse(history).entries.map((row: View) => row.id)).toEqual([second, first]);
    const filteredHistory = JSON.parse(await runCli(["search", "needle", "--history", "--filter", "--json"], f.context));
    expect(filteredHistory.entries).toEqual(JSON.parse(history).entries);
    expect(filteredHistory.notices).toEqual(JSON.parse(history).notices);
    const past = JSON.parse(await runCli(["search", "needle", "--as-of", f.store.get(first, f.project)!.at, "--json"], f.context));
    expect(past.entries.map((row: View) => row.id)).toEqual([first]);
  } finally { f.store.close(); }
  setFts5AvailableForTest(false);
  const fallback = fixture();
  try {
    const first = fallback.note("needle older"), second = fallback.note("needle newer");
    expect((await fallback.search("needle")).map(row => row.id)).toEqual([second, first]);
  } finally { fallback.store.close(); }
});

test("host raw recall stays screened/newest-first and ranked opt-in requires person intent before opening", async () => {
  const f = fixture();
  try {
    const older = f.note("needle needle needle"), newer = f.note("needle later");
    const unfiltered = JSON.parse(await rawMemoryCommand(["search", "needle", "--json"], f.root, {
      project: f.project, store: f.store, open: () => f.store, readable: rows => rows, importPolicy: () => () => false,
    })) as View[];
    expect(unfiltered.map(row => row.id)).toEqual([newer, older]);
    const emitted: string[][] = [];
    const result = JSON.parse(await rawMemoryCommand(["search", "needle", "--limit", "1", "--json"], f.root, {
      project: f.project, store: f.store, open: () => f.store, readable: rows => rows.filter(row => row.id !== newer),
      outputReady: rows => { emitted.push(rows.map(row => row.id)); }, importPolicy: () => () => false,
    })) as View[];
    expect(result.map(row => row.id)).toEqual([older]); expect(emitted).toEqual([[older]]);
    let opens = 0;
    await expect(rawMemoryCommand(["search", "needle"], f.root, { rankedSearch: true, open: () => { opens++; return f.store; }, readable: rows => rows, importPolicy: () => () => false })).rejects.toThrow("person intent");
    await expect(rawMemoryCommand(["search", "needle", "--explain"], f.root, { person: true, open: () => { opens++; return f.store; }, readable: rows => rows, importPolicy: () => () => false })).rejects.toThrow("ranked search and person intent");
    await expect(rawMemoryCommand(["show", "missing"], f.root, { person: true, rankedSearch: true, explainSearch: true, open: () => { opens++; return f.store; }, readable: rows => rows, importPolicy: () => () => false })).rejects.toThrow("applies only to search");
    expect(opens).toBe(0);
  } finally { f.store.close(); }
});

test("marked current-project reads match MCP DTOs; retained history and cross-project reads run (#431)", async () => {
  const f = fixture();
  try {
    const id = f.note("needle current row");
    const env = { CODEX_THREAD_ID: "fixture", HOME: f.root, AMEM_HOME: join(f.root, "memory") };
    const context = { cwd: f.root, env, stdinTTY: false };
    const mcp = createMemoryMcp({ cwd: f.root, base: join(f.root, "memory") });
    try {
      for (const [argv, toolArgs] of [
        [["search", "needle", "--json"], { query: "needle" }],
        [["search", "needle", "--explain", "--json"], { query: "needle", explain: true }],
      ] as const) {
        const actual = JSON.parse(await runCli(argv, context)), expected = await mcp.tools.amem_search(toolArgs);
        const stable = (value: typeof actual) => ({ ...value, hits: value.hits.map(({ score: _score, scoreDetails: _details, ...hit }: Record<string, unknown>) => hit) });
        expect(stable(actual)).toEqual(stable(expected));
        if (toolArgs.explain) expect(actual.hits.every((hit: { scoreDetails?: unknown }) => hit.scoreDetails !== undefined)).toBe(true);
      }
      expect(JSON.parse(await runCli(["show", id, "--json"], context))).toEqual(await mcp.tools.amem_show({ id }));
      // #431: history, as-of and cross-project reads run the person handler for an agent-marked session too.
      for (const argv of [
        ["search", "needle", "--history", "--json"], ["search", "needle", "--as-of", "2026-01-01", "--json"],
        ["search", "needle", "--all-projects", "--json"], ["show", id, "--history", "--json"],
      ]) { let out: string; try { out = await runCli(argv, context); } catch (error) { throw new Error(`${argv.join(" ")}: ${(error as Error).message}`); } expect(JSON.parse(out), argv.join(" ")).toBeTruthy(); }
    } finally { mcp.close(); }
  } finally { f.store.close(); }
});

test("person search keeps cross-project validation and ranked-explanation restrictions", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-ranked-gate-")); roots.push(root);
  await expect(runCli(["search", "needle", "--filter", "--all-projects"], { cwd: root, env: {}, stdinTTY: false })).rejects.toThrow("--filter applies to project-local search");
  for (const args of [["--filter"], ["--history"], ["--as-of", "2026-01-01T00:00:00Z"], ["--all-projects"], []] as string[][]) {
    await expect(runCli(["search", ...(args.length ? ["needle"] : []), "--explain", ...args], { cwd: root, env: {}, stdinTTY: false })).rejects.toThrow("--explain");
  }
  await expect(runCli(["search", "--explain"], { cwd: root, env: {}, stdinTTY: false })).rejects.toThrow("--explain");
});

test("marked and unmarked recall respects screening, cell width and JSON boundaries", async () => {
  const f = fixture(), marker = "WITHHELD_CANARY", content = `needle ${"제주한라대학교인공지능".repeat(10)} end`;
  try {
    const visible = f.note(content), hidden = f.note(`needle ${marker} private row`);
    writeFileSync(join(f.root, "memory", "amem.config.json"), JSON.stringify({ piiPatterns: [marker] }));
    const env = { HOME: f.root, AGENTHUB_HOME: f.root, AMEM_HOME: join(f.root, "memory"), COLUMNS: "80", NO_COLOR: "1", TERM: "dumb" };
    const person = { cwd: f.root, env, stdinTTY: false }, marked = { ...person, env: { ...env, CODEX_THREAD_ID: "fixture" } };
    for (const command of [["list"], ["search", "needle"]]) {
      const ordinary = await runCli(command, person), screened = await runCli(command, marked);
      expect(ordinary).toContain("WITHHELD");
      expect(screened).not.toContain("WITHHELD");
      for (const output of [ordinary, screened]) {
        expect(output.split("\n").every(line => Bun.stringWidth(line, { ambiguousIsNarrow: true }) <= 80)).toBe(true);
        expect(output.match(/amem show <id>/g)).toHaveLength(1);
        const visibleRow = output.split("\n").find(line => line.includes(visible.slice(0, 12)));
        expect(visibleRow).toBeDefined();
        expect(visibleRow).toContain("...");
      }
    }
    for (const context of [person, marked]) {
      const shown = await runCli(["show", visible], context);
      expect(shown.replace(/\s+/g, "")).toContain(content.replace(/\s+/g, ""));
      expect(shown).not.toContain(marker);
      const indents = shown.split("\n").flatMap(line => { const match = line.match(/^  (?:ID|Kind|Tier|When|Peer|Scope|Project|Machine|Actor): +/); return match ? [match[0].length] : []; });
      expect(new Set(indents).size).toBe(1);
    }
    expect(await runCli(["show", hidden], person)).toContain(marker);
    expect(await runCli(["show", hidden], marked)).not.toContain(marker);
    expect(await runCli(["show", visible], marked)).toMatch(/Actor:\s+agent/);
    for (const args of [["list", "--history"], ["search", "needle", "--filter"], ["search", "제주한라대학교인공지능", "--all-projects"]]) {
      for (const context of [person, marked]) expect(await runCli(args, context)).toContain("> Entries");
    }
    await expect(runCli(["search", "needle", "--all-projects"], marked)).rejects.toThrow("policy_withheld");
    const mcp = createMemoryMcp({ cwd: f.root, base: join(f.root, "memory") });
    try {
      expect(await runCli(["list", "--json"], marked)).toBe(JSON.stringify(await mcp.tools.amem_timeline({}), null, 2));
      const noMatch = { query: "nonexistentfixturexyz" };
      expect(await runCli(["search", noMatch.query, "--json"], marked)).toBe(JSON.stringify(await mcp.tools.amem_search(noMatch), null, 2));
      expect(await runCli(["show", visible, "--json"], marked)).toBe(JSON.stringify(await mcp.tools.amem_show({ id: visible }), null, 2));
      expect(JSON.parse(await runCli(["show", hidden, "--json"], marked))).toBeNull();
      expect(JSON.parse(await runCli(["show", hidden, "--json"], person)).text).toContain(marker);
    } finally { mcp.close(); }
  } finally { f.store.close(); }
});

test("marked fallback reads screen both legacy and formatted output", async () => {
  const f = fixture();
  try {
    f.note("screencheck public");
    const home = join(f.root, "memory"), env = { HOME: f.root, AGENTHUB_HOME: f.root, AMEM_HOME: home, COLUMNS: "80", NO_COLOR: "1" };
    const marked = { cwd: f.root, env: { ...env, CODEX_THREAD_ID: "fixture" }, stdinTTY: false };
    for (const [args, pattern] of [
      [["list", "--history"], "retained memory as of 20"],
      [["search", "screencheck", "--filter"], "memory for "],
      [["search", "screencheck", "--all-projects"], "crossed projects:"],
      [["list", "--history"], "Entries"],
    ] as const) {
      writeFileSync(join(home, "amem.config.json"), JSON.stringify({ piiPatterns: [pattern] }));
      await expect(runCli([...args], marked)).rejects.toThrow("policy_withheld");
    }
  } finally { f.store.close(); }
});
