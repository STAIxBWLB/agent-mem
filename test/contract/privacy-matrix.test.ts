import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, type CandidateInput, type CandidateVerdict, type CounterKey } from "../../src/memory/candidates.ts";
import { runCli } from "../../src/cli.ts";
import { createMemoryMcp } from "../../src/mcp-memory.ts";
import { CONFIG_FILE } from "../../src/memory/config.ts";
import { rawMemoryCommand } from "../../src/memory/commands.ts";
import { importClaudeMem } from "../../src/memory/import.ts";
import { memoryProjectKey } from "../../src/memory/project.ts";
import { MemoryStore, type NoteInput, type PromotionScreen, type View } from "../../src/memory/store.ts";
import { COMMANDS, type CommandDefinition } from "../../src/commands-table.ts";

const MARKER = "SYNTHETIC-PRIVATE-MARKER", START = Date.parse("2026-10-16T00:00:00.000Z");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(screen: PromotionScreen = () => "skip") {
  const root = mkdtempSync(join(tmpdir(), "amem-c3-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ home: root, now: () => START, screen }); cleanup.push(() => store.close());
  const project = memoryProjectKey(root);
  const note = (extra: Partial<NoteInput> = {}) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "synthetic-peer", text: `${MARKER} stored content`, title: MARKER, about: [`path:${MARKER}/fixture.ts`], task: `${MARKER}#1@1`, source: "person", ...extra });
  return { root, store, project, note };
}
const fail = (project: string): CandidateInput => ({ project, kind: "fail", approach: "ordinary approach", symptom: "ordinary symptom", cause: "ordinary cause", evidenceRefs: ["test:ordinary"], retryWhen: "ordinary retry condition" });

type MarkedOutcome = "mcp-tool" | "static" | "capture" | "admin-screened" | "refused";
interface MarkedReadInventoryRow { path: string; mode: string; outcome: MarkedOutcome; detail: string }

// CLI read contract for an agent-marked process. MCP-tool rows are parity checked below; admin-screened means the
// CLI validates the complete receipt against standalone policy; refused means the read exceeds the MCP surface.
const MARKED_READ_INVENTORY: readonly MarkedReadInventoryRow[] = [
  { path: "list", mode: "project timeline; --limit/--since", outcome: "mcp-tool", detail: "amem_timeline" },
  { path: "search", mode: "current query; --limit/--since/--explain", outcome: "mcp-tool", detail: "amem_search" },
  { path: "show", mode: "one project note", outcome: "mcp-tool", detail: "amem_show" },
  { path: "brief", mode: "intent/path brief", outcome: "mcp-tool", detail: "amem_brief" },
  { path: "graph", mode: "one- or two-hop graph", outcome: "mcp-tool", detail: "amem_graph" },
  { path: "vault-candidates", mode: "current project screened candidates", outcome: "mcp-tool", detail: "amem_vault_candidates" },
  { path: "capacity", mode: "capture capacity proposal", outcome: "mcp-tool", detail: "amem_capacity" },
  { path: "mcp", mode: "start MCP server", outcome: "mcp-tool", detail: "unchanged server and tool set" },
  { path: "completion", mode: "emit shell completion", outcome: "static", detail: "no memory home access" },
  { path: "help", mode: "print help", outcome: "static", detail: "no memory home access" },
  { path: "version", mode: "print version", outcome: "static", detail: "no memory home access" },
  { path: "hook", mode: "context-only event", outcome: "capture", detail: "unchanged fail-open capture hook" },
  { path: "ingest", mode: "native transcript capture", outcome: "capture", detail: "unchanged capture-only intake" },

  { path: "setup", mode: "preview; --apply/--undo", outcome: "admin-screened", detail: "screen complete setup receipt; flags retain explicit behavior" },
  { path: "migrate", mode: "default/--dry-run preview; --apply/--resume/--deactivate", outcome: "admin-screened", detail: "screen receipt; apply remains explicit" },
  { path: "prune", mode: "--dry-run preview; --apply --plan", outcome: "admin-screened", detail: "screen exact plan and result" },
  { path: "decay", mode: "default/--apply preview; --apply --confirm", outcome: "admin-screened", detail: "screen complete target views and write receipt" },
  { path: "capacity apply", mode: "preview; --confirm; --split preview/confirm", outcome: "admin-screened", detail: "screen complete configuration receipt" },
  { path: "gc", mode: "default preview; --confirm", outcome: "admin-screened", detail: "screen complete retention receipt" },
  { path: "project import", mode: "preview; --confirm", outcome: "admin-screened", detail: "screen import provenance, skipped counts, and receipt" },
  { path: "project forget", mode: "preview; --confirm", outcome: "admin-screened", detail: "screen project lifecycle receipt" },
  { path: "project archive", mode: "explicit lifecycle write", outcome: "admin-screened", detail: "screen append-only receipt" },
  { path: "project unarchive", mode: "explicit lifecycle write", outcome: "admin-screened", detail: "screen append-only receipt" },
  { path: "dedupe", mode: "default preview; --apply", outcome: "admin-screened", detail: "screen reconciliation report and receipt" },
  { path: "promote", mode: "--to repo preview; --confirm/--confirm-public", outcome: "admin-screened", detail: "screen exact promotion text and write receipt" },
  { path: "repo attributes", mode: "preview; --confirm", outcome: "admin-screened", detail: "screen repository path receipt" },
  { path: "machine", mode: "read without --label", outcome: "refused", detail: "machine metadata read is outside MCP" },
  { path: "machine", mode: "--label write", outcome: "admin-screened", detail: "explicit label write receipt is screened" },

  { path: "projects", mode: "default/--all", outcome: "refused", detail: "cross-project administrative metadata" },
  { path: "usage", mode: "default/--all", outcome: "refused", detail: "cross-project storage totals" },
  { path: "status", mode: "migration, policy, and candidate status", outcome: "refused", detail: "administrative status outside MCP" },
  { path: "doctor", mode: "health and policy report", outcome: "refused", detail: "administrative diagnostics outside MCP" },
  { path: "eval", mode: "local evaluation and ranking report", outcome: "refused", detail: "project read outside MCP" },
  { path: "goal list", mode: "default/list", outcome: "refused", detail: "goal records outside MCP" },
  { path: "goal show", mode: "one goal", outcome: "refused", detail: "goal records outside MCP" },
  { path: "suggestions", mode: "pending suggestions", outcome: "refused", detail: "suggestion metadata outside MCP" },
  { path: "review list", mode: "candidate records", outcome: "refused", detail: "review candidates outside MCP" },
  { path: "review walk", mode: "marked in any TTY mode", outcome: "refused", detail: "pending-candidate bodies have no MCP equivalent; never expose them as an admin receipt" },
  { path: "repo status", mode: "repository log status", outcome: "refused", detail: "repository scope crosses the current MCP surface" },
  { path: "project export", mode: "write bundle outside home", outcome: "refused", detail: "cross-project export is outside MCP" },
  { path: "alias list", mode: "alias history", outcome: "refused", detail: "alias metadata outside MCP" },
  { path: "list", mode: "--history/--as-of/filters beyond MCP", outcome: "refused", detail: "only the MCP timeline argument subset is exposed" },
  { path: "search", mode: "--history/--as-of/--all-projects/--include-archived/--filter and local kind/peer/machine/tier filters", outcome: "refused", detail: "history and out-of-contract read flags exceed MCP search" },
  { path: "show", mode: "--history/--as-of", outcome: "refused", detail: "history reads exceed MCP show" },
  { path: "graph", mode: "--history/--as-of", outcome: "refused", detail: "history reads exceed MCP graph" },
  { path: "vault-candidates", mode: "--all-projects/--project", outcome: "refused", detail: "cross-project candidate reads exceed MCP" },
  { path: "project export", mode: "all-projects/crossing-scope request", outcome: "refused", detail: "export cannot cross project scope for marked CLI" },
];

function leafCommandPaths(commands: Record<string, CommandDefinition>, prefix: string[] = [], inheritedMutates?: CommandDefinition["mutates"]): string[] {
  return Object.entries(commands).flatMap(([name, command]) => {
    const path = [...prefix, name], mutates = command.mutates ?? inheritedMutates;
    return command.commands ? leafCommandPaths(command.commands, path, mutates) : mutates === undefined ? [path.join(" ")] : [];
  });
}

test("marked CLI read inventory covers every nonmutating command leaf", () => {
  const leaves = leafCommandPaths(COMMANDS).sort(), covered = [...new Set(MARKED_READ_INVENTORY.map(row => row.path))].sort();
  expect(leaves.filter(path => !covered.includes(path))).toEqual([]);
  expect(MARKED_READ_INVENTORY.map(row => row.outcome)).toContain("mcp-tool");
  expect(MARKED_READ_INVENTORY.map(row => row.outcome)).toContain("static");
  expect(MARKED_READ_INVENTORY.map(row => row.outcome)).toContain("capture");
  expect(MARKED_READ_INVENTORY.map(row => row.outcome)).toContain("admin-screened");
  expect(MARKED_READ_INVENTORY.map(row => row.outcome)).toContain("refused");
});

// This is an injected host policy, not a privacy classifier supplied by agent-mem.
test("C3 raw readable policy receives every View field for list search and show", async () => {
  const f = fixture(), id = f.note(), view = f.store.get(id, f.project)!;
  for (const field of Object.keys(view) as (keyof View)[]) {
    const marker = JSON.stringify(view[field]);
    let observed = false;
    const readable = (rows: View[]) => rows.filter(row => {
      expect(Object.keys(row).sort()).toEqual(Object.keys(view).sort());
      if (JSON.stringify(row[field]) === marker) { observed = true; return false; }
      return true;
    });
    const options = { store: f.store, open: () => f.store, readable, importPolicy: () => () => false };
    expect(JSON.parse(await rawMemoryCommand(["list", "--json"], f.root, options))).toEqual([]);
    expect(JSON.parse(await rawMemoryCommand(["search", MARKER, "--json"], f.root, options))).toEqual([]);
    await expect(rawMemoryCommand(["show", id, "--json"], f.root, options)).rejects.toThrow("withheld");
    expect(observed).toBe(true);
  }
});

test("C3 core reads remain unscreened and raw graph is an explicit person-only host ceiling", async () => {
  const f = fixture(() => "keep"), id = f.note();
  expect(f.store.list({ project: f.project })[0]?.text).toContain(MARKER);
  expect(f.store.get(id, f.project)?.title).toBe(MARKER);
  let calls = 0;
  const graph = await rawMemoryCommand(["graph", id, "--json"], f.root, { store: f.store, open: () => f.store, readable: () => { calls++; return []; }, importPolicy: () => () => false });
  expect(calls).toBe(0); expect(graph).toContain(MARKER);
});

test("C3 promotion screen receives complete views and refuses private markers in every textual input field", () => {
  for (const field of ["title", "text", "peer", "project", "task", "about"] as const) {
    let checked: View | undefined;
    const f = fixture(view => { checked = structuredClone(view); return JSON.stringify(view).includes(MARKER) ? "keep" : "promote"; });
    const extra: Partial<NoteInput> = { tier: "short", title: "ordinary", text: "ordinary", peer: "synthetic-peer", project: "synthetic/project", task: "synthetic/project#1@1", about: [] };
    if (field === "about") extra.about = [`path:${MARKER}/fixture.ts`]; else extra[field] = MARKER;
    const id = f.note(extra);
    expect(f.store.promote(id, "person")).toBeUndefined();
    expect(JSON.stringify(checked)).toContain(MARKER); expect(f.store.get(id)?.tier).toBe("short");
  }
});

test("C3 import policy screens title and body and secret screen skips both without changing source bytes", () => {
  const f = fixture(), file = join(f.root, "synthetic-claude-mem.db"), db = new Database(file);
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  const rows = [[MARKER, "ordinary body"], ["ordinary title", MARKER], ["password: synthetic-title-only", "ordinary body"], ["ordinary title", "password: synthetic-body-only"], ["ordinary title", "ordinary body"]];
  for (const [i, row] of rows.entries()) db.query("INSERT INTO observations VALUES (?, 'fixture', ?, ?, NULL, ?, ?)").run(i + 1, row[0]!, row[1]!, START, JSON.stringify({ peer: "synthetic-peer", kind: "contract" }));
  db.query("INSERT INTO observations VALUES (6, 'fixture', 'ordinary title', NULL, ?, ?, ?)").run(MARKER, START, JSON.stringify({ peer: "synthetic-peer", kind: "contract" }));
  db.query("INSERT INTO observations VALUES (7, 'fixture', 'ordinary title', NULL, ?, ?, ?)").run("password: synthetic-narrative-only", START, JSON.stringify({ peer: "synthetic-peer", kind: "contract" }));
  db.close(); const bytes = readFileSync(file), seen: string[] = [];
  const result = importClaudeMem(f.store, { project: f.project, chain: ["fixture"], db: file, isPii: text => { seen.push(text); return text.includes(MARKER); } });
  expect(result).toMatchObject({ added: 1, skipped: { pii: 3, secret: 3, model: 0 } });
  expect(seen.some(text => text.startsWith(MARKER))).toBe(true); expect(seen.some(text => text.endsWith(MARKER))).toBe(true);
  expect(readFileSync(file)).toEqual(bytes); expect(JSON.stringify(f.store.list())).not.toContain(MARKER);
});

test("C3 candidate verdicts reject private pii and unknown payloads before any sidecar row", () => {
  const f = fixture(), sidecar = new CandidateStore({ home: f.root, now: () => START }); cleanup.push(() => sidecar.close());
  for (const verdict of ["private", "pii", "unknown"] as CandidateVerdict[]) {
    for (const field of ["project", "approach", "symptom", "cause", "evidenceRefs", "retryWhen"] as const) {
      const input = fail(f.project); if (input.kind !== "fail") throw new Error("fixture kind");
      if (field === "evidenceRefs") input.evidenceRefs = [MARKER]; else input[field] = MARKER;
      expect(() => sidecar.put(input, verdict)).toThrow("privacy verdict");
    }
    for (const kind of ["correction", "decay"] as const) for (const field of ["project", "reason", ...(kind === "correction" ? ["proposedText"] : [])]) {
      const input = { project: f.project, kind, target: { id: "a".repeat(32), revision: "b".repeat(64) }, reason: "ordinary reason", ...(kind === "correction" ? { proposedText: "ordinary proposal" } : {}), [field]: MARKER } as CandidateInput;
      expect(() => sidecar.put(input, verdict)).toThrow("privacy verdict");
    }
  }
  expect(sidecar.list({ project: f.project, status: "all" })).toEqual([]); expect(sidecar.list({ project: MARKER, status: "all" })).toEqual([]);
});

test("C3 counters require a public verdict for every valid contextual field and keep unknown distinct from zero", () => {
  const f = fixture(), sidecar = new CandidateStore({ home: f.root, now: () => START }); cleanup.push(() => sidecar.close());
  for (const verdict of ["private", "pii", "unknown"] as CandidateVerdict[]) for (const field of ["project", "task", "turn", "session", "deliveryId"] as const) {
    const key: CounterKey = { entryId: "a".repeat(32), project: f.project, deliveryId: "synthetic-delivery", [field]: MARKER };
    expect(() => sidecar.recordCounter(key, { rendered: 0, delivered: null, cited: null }, verdict)).toThrow("privacy verdict");
  }
  expect(sidecar.counters(f.project)).toEqual([]); expect(sidecar.counters(MARKER)).toEqual([]);
  const key = { entryId: "a".repeat(32), project: f.project, deliveryId: "public-synthetic-delivery" };
  sidecar.recordCounter(key, { rendered: 0, delivered: null }, "public");
  expect(sidecar.counters(f.project)[0]).toMatchObject({ rendered: 0, delivered: null, cited: null });
});

test("C3 marked CLI column equals MCP reads with public controls and complete-field privacy", async () => {
  const now = spyOn(Date, "now").mockReturnValue(START), saved = process.env.AMEM_HOME;
  try {
    for (const field of ["title", "text", "peer", "task", "about"] as const) {
      const f = fixture(() => "keep"), extra: Partial<NoteInput> = { title: "ordinary", text: "ordinary body", peer: "ordinary-peer", task: "synthetic/project#1@1", about: ["path:ordinary.ts"] };
      if (field === "about") extra.about = [`path:${MARKER}/fixture.ts`]; else extra[field] = MARKER;
      const hidden = f.note(extra), visible = f.note({ title: "ordinary public control", text: "ordinary public control", peer: "ordinary-peer", task: "synthetic/project#1@1", about: ["path:ordinary.ts"] });
      writeFileSync(join(f.store.dir, CONFIG_FILE), JSON.stringify({ piiPatterns: [MARKER] }));
      process.env.AMEM_HOME = f.store.dir;
      const env = { HOME: f.root, AMEM_HOME: f.store.dir, CLAUDECODE: "1" }, mcp = createMemoryMcp({ cwd: f.root, base: f.store.dir });
      try {
        expect((await mcp.tools.amem_search({ query: "ordinary" }) as any).hits.some((hit: any) => hit.view?.id === visible)).toBe(true);
        const partialEnv = JSON.parse(await runCli(["search", "ordinary", "--json"], { cwd: f.root, env: { CLAUDECODE: "1" }, stdinTTY: false }));
        expect(partialEnv.hits.some((hit: any) => hit.view?.id === visible)).toBe(true);
        const cases = [
          { argv: ["list", "--limit", "10", "--json"], tool: "amem_timeline" as const, args: { limit: 10 } },
          { argv: ["search", "ordinary", "--json"], tool: "amem_search" as const, args: { query: "ordinary" } },
          { argv: ["search", "ordinary", "--explain", "--json"], tool: "amem_search" as const, args: { query: "ordinary", explain: true } },
          { argv: ["show", hidden, "--json"], tool: "amem_show" as const, args: { id: hidden } },
          { argv: ["show", visible, "--json"], tool: "amem_show" as const, args: { id: visible } },
          { argv: ["brief", "--for", "ordinary intent", "--json"], tool: "amem_brief" as const, args: { intent: "ordinary intent", paths: [], symbols: [] } },
          { argv: ["graph", visible, "--json"], tool: "amem_graph" as const, args: { start: visible } },
          { argv: ["vault-candidates", "--json"], tool: "amem_vault_candidates" as const, args: {} },
        ];
        for (const item of cases) {
          const expected = await mcp.tools[item.tool](item.args), actual = await runCli(item.argv, { cwd: f.root, env, stdinTTY: false, stdoutTTY: false });
          expect(JSON.parse(actual)).toEqual(expected); expect(actual).not.toContain(MARKER);
        }
        const capacity = await runCli(["capacity", "--json"], { cwd: f.root, env, stdinTTY: false });
        expect(JSON.parse(capacity)).toHaveProperty("proposal"); expect(capacity).not.toContain(MARKER);
        const unmarked = await runCli(["show", hidden, "--json"], { cwd: f.root, env: { HOME: f.root, AMEM_HOME: f.store.dir }, stdinTTY: false });
        expect(unmarked).toContain(MARKER);
      } finally { mcp.close(); }
    }
  } finally { now.mockRestore(); if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}, 30_000);

test("marked CLI unsupported reads fail closed before opening a memory home", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-agent-cli-empty-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "not-created");
  const context = { cwd: root, env: { HOME: root, AMEM_HOME: home, CODEX_THREAD_ID: "fixture" }, stdinTTY: false, stdoutTTY: false };
  for (const argv of [
    ["projects"], ["projects", "--all"], ["usage"], ["status"], ["doctor"], ["eval"], ["goal", "list"], ["goal", "show", "synthetic-goal"],
    ["suggestions"], ["review", "list"], ["machine"], ["alias", "list"],
    ["list", "--history"], ["list", "--kind", "contract"], ["search", "private", "--history"], ["search", "private", "--as-of", "2026-01-01"],
    ["search", "private", "--all-projects"], ["search", "private", "--include-archived"], ["show", "a".repeat(32), "--history"],
    ["graph", "a".repeat(32), "--as-of", "2026-01-01"], ["vault-candidates", "--all-projects"], ["repo", "status"],
    ["project", "export", "synthetic/project", "--to", join(root, "out.json")],
  ]) {
    await expect(runCli(argv, context)).rejects.toThrow("Memory operation unavailable or refused; no partial result is shown.");
  }
  await expect(runCli(["review", "walk"], context)).rejects.toThrow("stdout must be a terminal");
  await expect(runCli(["review", "walk"], { ...context, stdinTTY: true, stdoutTTY: true })).rejects.toThrow("Memory operation unavailable or refused; no partial result is shown.");
  await expect(runCli(["review", "walk"], { ...context, env: {}, stdoutTTY: true, stdinTTY: false })).rejects.toThrow("terminal on stdin");
  expect(existsSync(home)).toBe(false);

});
