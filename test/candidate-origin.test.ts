import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, withPendingCandidates, type CandidateInput } from "../src/memory/candidates.ts";
import { originLine, validOrigin } from "../src/memory/candidate-origin.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { realPath } from "../src/memory/platform.ts";
import { runCli } from "../src/cli.ts";
import { CaptureStore } from "../src/memory/capture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const SESSION = "0123456789abcdef", AT = "2026-11-16T07:00:00.000Z";
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-origin-"))), base = join(root, "memory"), project = "origin-project";
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true, screen: () => "promote" }); cleanup.push(() => store.close());
  const candidates = new CandidateStore({ memoryDir: base }); cleanup.push(() => candidates.close());
  const put = (text: string, origin?: Parameters<CandidateStore["put"]>[2]) => candidates.put({ project, kind: "memory", text } as CandidateInput, "public", origin);
  const accept = (id: string) => candidates.accept(id, { project, actor: "person", verdict: "public", store, policy: () => true, policyVersion: () => "fixed" });
  return { root, base, project, store, candidates, put, accept };
}

test("#323 AC1: full, partial and absent origin are stored as ids beside the row and read back", () => {
  const f = fixture();
  const full = f.put("full origin", { session: SESSION, peer: "codex", at: AT, turn: "turn-7" });
  const partial = f.put("partial origin", { peer: "claude" });
  const none = f.put("no origin");
  expect(f.candidates.get(full, f.project)).toMatchObject({ originKnown: true, origin: { session: SESSION, peer: "codex", at: AT, turn: "turn-7" } });
  expect(f.candidates.get(partial, f.project)).toMatchObject({ originKnown: true, origin: { peer: "claude" } });
  const absent = f.candidates.get(none, f.project)!; expect(absent.originKnown).toBe(true); expect(absent.origin).toBeUndefined();
  expect(originLine(absent.origin)).toBe("origin: unavailable");
  expect(originLine(f.candidates.get(partial, f.project)!.origin)).toBe("origin: session unavailable, peer claude, at unavailable");
  // The id is content-addressed and unchanged by origin: the same text from another session is the same candidate, keeping its first origin.
  expect(f.put("full origin", { session: "fedcba9876543210" })).toBe(full);
  expect(f.candidates.get(full, f.project)!.origin?.session).toBe(SESSION);
  // The inbox read port sees origin too.
  expect(withPendingCandidates(f.base, reader => reader.list([f.project])).find(row => row.id === full)?.origin?.peer).toBe("codex");
});

test("#323 AC1: acceptance carries origin into the accepted note as session and peer graph edges; no origin adds none", () => {
  const f = fixture();
  const withOrigin = f.accept(f.put("accepted with origin", { session: SESSION, peer: "codex", at: AT }));
  const without = f.accept(f.put("accepted without origin"));
  expect(f.store.get(withOrigin.noteId, f.project)!.about).toEqual(expect.arrayContaining([`session:${SESSION}`, "peer:codex"]));
  expect(f.store.get(without.noteId, f.project)!.about.some(node => node.startsWith("session:") || node.startsWith("peer:"))).toBe(false);
});

test("#323: a pre-0.28 row (no origin column, or a NULL origin) reads as unknown, never a guessed origin", () => {
  const f = fixture(), id = f.put("written by the new store");
  f.candidates.close();
  const db = new Database(join(f.base, "candidates.db"));
  try { db.run("UPDATE candidates SET origin = NULL WHERE id = ?", [id]); } finally { db.close(); }
  const reopened = new CandidateStore({ memoryDir: f.base }); cleanup.push(() => reopened.close());
  const row = reopened.get(id, f.project)!; expect(row.originKnown).toBe(false); expect(row.origin).toBeUndefined();
  expect(originLine(row.origin, row.originKnown)).toContain("unknown");
});

test("#323: an older database without the origin column gains it in place; its rows read as unknown", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-origin-old-"))), base = join(root, "memory"); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const first = new CandidateStore({ memoryDir: base }), id = first.put({ project: "p", kind: "memory", text: "old row" } as CandidateInput, "public"); first.close();
  // Rebuild the table as a 0.27 writer left it: no origin column.
  const db = new Database(join(base, "candidates.db"));
  try {
    db.run("CREATE TABLE old AS SELECT id, project, kind, payload, at, status, note_id, shown_at FROM candidates"); db.run("DROP TABLE candidates"); db.run("ALTER TABLE old RENAME TO candidates");
    expect((db.query("PRAGMA table_info(candidates)").all() as { name: string }[]).some(c => c.name === "origin")).toBe(false);
  } finally { db.close(); }
  expect(withPendingCandidates(base, reader => reader.list(["p"]))[0]).toMatchObject({ id, originKnown: false });
  const store = new CandidateStore({ memoryDir: base }); cleanup.push(() => store.close());
  expect(store.get(id, "p")).toMatchObject({ originKnown: false });
});

test("#323 AC3: origin takes ids only; text, paths, secrets and unknown fields are refused", () => {
  for (const bad of [{ session: "not hex" }, { session: "/home/me/notes.md" }, { peer: "a peer with spaces" }, { peer: "sk-live sec ret" }, { turn: "../x/y z" },
    { at: "yesterday" }, { at: "2026-11-16" }, { text: "free text" }, { path: "src/a.ts" }, "string", [SESSION]]) expect(() => validOrigin(bad), JSON.stringify(bad)).toThrow();
  const f = fixture();
  expect(() => f.put("refused origin", { session: "/etc/passwd" } as never)).toThrow();
  expect(f.candidates.list({ project: f.project, status: "all" })).toHaveLength(0);
});

test("#323: MCP proposals record the host-supplied origin with its time; an invalid host value records none", async () => {
  const f = fixture();
  let supplied: { session?: string; peer?: string } | undefined = { session: SESSION, peer: "codex" };
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, origin: () => supplied }); cleanup.push(() => mcp.close());
  const first = (await mcp.tools.amem_remember({ text: "remembered with a session" }) as { id: string }).id;
  expect(f.candidates.get(first, f.project)!.origin).toMatchObject({ session: SESSION, peer: "codex" });
  expect(Number.isFinite(Date.parse(f.candidates.get(first, f.project)!.origin!.at!))).toBe(true);
  supplied = { session: "/a/path" };
  const second = (await mcp.tools.amem_remember({ text: "remembered with a bad session" }) as { id: string }).id;
  expect(f.candidates.get(second, f.project)!.origin).toBeUndefined();
});

test("#323 AC2: review list, review decide and review walk show the origin, or unavailable", async () => {
  const f = fixture(), saved = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  cleanup.push(() => { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; });
  const project = (await import("../src/memory/project.ts")).memoryProjectKey(f.root);
  const a = f.candidates.put({ project, kind: "memory", text: "with origin" } as CandidateInput, "public", { session: SESSION, peer: "codex", at: AT });
  const b = f.candidates.put({ project, kind: "memory", text: "without origin" } as CandidateInput, "public");
  const ctx = { cwd: f.root, env: {}, stdinTTY: false, stdoutTTY: false };
  const list = await runCli(["review", "list"], ctx);
  expect(list).toContain(`${a}  memory  pending`); expect(list).toContain(`origin: session ${SESSION}, peer codex, at ${AT}`); expect(list).toContain("origin: unavailable");
  expect(JSON.parse(await runCli(["review", "decide", a, "accept", "--json"], ctx)).origin).toEqual({ session: SESSION, peer: "codex", at: AT });
  expect(await runCli(["review", "decide", b, "reject"], ctx)).toContain("origin: unavailable");
  const lines: string[] = [];
  await runCli(["review", "walk"], { ...ctx, stdinTTY: true, stdoutTTY: true, write: text => lines.push(text), prompt: () => "s" });
  expect(lines.join("\n")).toContain(`origin: session ${SESSION}, peer codex`);
});

test("#323 item 3: amem show capture:<id> prints a capture row's session and row time", async () => {
  const f = fixture(), saved = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  cleanup.push(() => { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; });
  const project = (await import("../src/memory/project.ts")).memoryProjectKey(f.root);
  const capture = new CaptureStore({ memoryDir: f.base, project, cwd: f.root }); cleanup.push(() => capture.close());
  const appended = capture.append({ project, agent: "codex", event: "PostToolUse", excerpt: "kept the origin column nullable", session: "0011223344556677" });
  const id = "id" in appended ? appended.id : 0; expect(id).toBeGreaterThan(0);
  const shown = await runCli(["show", `capture:${id}`], { cwd: f.root, env: {}, stdinTTY: false });
  const row = JSON.parse(await runCli(["show", `capture:${id}`, "--json"], { cwd: f.root, env: {}, stdinTTY: false }));
  expect(row.session).toMatch(/^[a-f0-9]{16}$/); expect(shown).toContain(`session ${row.session}`); expect(row.session).toBe("0011223344556677"); expect(shown).toContain(row.at); expect(shown).toContain("PostToolUse");
});
