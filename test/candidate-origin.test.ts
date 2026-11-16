import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, withPendingCandidates, type CandidateInput } from "../src/memory/candidates.ts";
import { originLine, originNodes, originRecheck, validOrigin } from "../src/memory/candidate-origin.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { proposeModelConsolidations } from "../src/memory/consolidation-model.ts";
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

test("#323 AC1: acceptance keeps every supplied origin field (session, peer, at, turn) as id edges; no origin adds none", () => {
  const f = fixture();
  const withOrigin = f.accept(f.put("accepted with origin", { session: SESSION, peer: "codex", at: AT, turn: "turn-7" }));
  const without = f.accept(f.put("accepted without origin"));
  expect(f.store.get(withOrigin.noteId, f.project)!.about).toEqual(expect.arrayContaining([`session:${SESSION}`, "peer:codex", `origin-at:${AT}`, "turn:turn-7"]));
  expect(originNodes({ session: SESSION, peer: "codex", at: AT, turn: "turn-7" })).toHaveLength(4);
  // Each accepting kind that writes a new note carries it: a fail and a correction too.
  const fail = f.candidates.put({ project: f.project, kind: "fail", approach: "a", symptom: "s", cause: "c", evidenceRefs: ["test:origin"], retryWhen: "r" } as CandidateInput, "public", { peer: "kimi", turn: "t-1" });
  expect(f.store.get(f.accept(fail).noteId, f.project)!.about).toEqual(expect.arrayContaining(["peer:kimi", "turn:t-1"]));
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
  // The unchanged secret screen applies to the ids: an id-shaped token is refused.
  expect(() => validOrigin({ peer: "ghp_" + "a".repeat(36) })).toThrow("secret screen");
  const f = fixture();
  expect(() => f.put("refused origin", { session: "/etc/passwd" } as never)).toThrow();
  // A library caller's configured privacy screen sees the ids before persistence; a declined origin refuses the write.
  // (The MCP path's full async host policy is covered below.)
  const policy = createStandalonePolicy({ piiPatterns: ["blocked-peer"] });
  expect(() => f.candidates.put({ project: f.project, kind: "memory", text: "screened origin" } as CandidateInput, "public", { peer: "blocked-peer" }, origin => policy.screenStandalone(origin))).toThrow("configured privacy policy");
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
  // A configured pattern that matches an origin id drops the origin; the proposal itself still stands.
  const screened = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, policy: { piiPatterns: ["blocked-peer"] }, origin: () => ({ peer: "blocked-peer" }) }); cleanup.push(() => screened.close());
  const third = (await screened.tools.amem_remember({ text: "remembered by a screened peer" }) as { id: string }).id;
  expect(f.candidates.get(third, f.project)!.origin).toBeUndefined();
  // The full asynchronous host policy sees the origin too: a host screen that declines it drops the origin, and the proposal stands.
  const hostScreened = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, origin: () => ({ peer: "host-declined" }),
    policy: { host: { screen: async (value: unknown) => !JSON.stringify(value).includes("host-declined") } } as never }); cleanup.push(() => hostScreened.close());
  const fourth = (await hostScreened.tools.amem_remember({ text: "remembered under a host screen" }) as { id: string }).id;
  expect(f.candidates.get(fourth, f.project)!.origin).toBeUndefined();
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

test("#323 item 4: only a confirmed absence is an expired origin; unreadable, unsupported or withheld capture is unavailable", () => {
  expect(originRecheck({ session: SESSION }, true, () => "present")).toBe("available");
  expect(originRecheck({ session: SESSION }, true, () => "absent")).toBe("origin expired");
  expect(originRecheck({ session: SESSION }, true, () => "unsupported")).toBe("unavailable");
  expect(originRecheck({ session: SESSION }, true, () => "unavailable")).toBe("unavailable");
  expect(originRecheck({ session: SESSION }, true, () => { throw new Error("capture unreadable"); })).toBe("unavailable");
  expect(originRecheck({ peer: "codex" }, true, () => "present")).toBe("unavailable");
  expect(originRecheck(undefined, false, () => "present")).toBe("unknown");
});

test("#323 item 4: review decide shows the re-check state from retained capture", async () => {
  const f = fixture(), saved = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  cleanup.push(() => { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; });
  const project = (await import("../src/memory/project.ts")).memoryProjectKey(f.root);
  const capture = new CaptureStore({ memoryDir: f.base, project, cwd: f.root }); cleanup.push(() => capture.close());
  capture.append({ project, agent: "codex", event: "PostToolUse", excerpt: "retained turn", session: SESSION });
  const kept = f.candidates.put({ project, kind: "memory", text: "kept origin" } as CandidateInput, "public", { session: SESSION });
  const gone = f.candidates.put({ project, kind: "memory", text: "expired origin" } as CandidateInput, "public", { session: "ffffffffffffffff" });
  const ctx = { cwd: f.root, env: {}, stdinTTY: false, stdoutTTY: false };
  expect(JSON.parse(await runCli(["review", "decide", kept, "accept", "--json"], ctx)).originRecheck).toBe("available");
  expect(JSON.parse(await runCli(["review", "decide", gone, "accept", "--json"], ctx)).originRecheck).toBe("origin expired");
  expect(await runCli(["review", "decide", gone, "accept"], ctx)).toContain("(recheck: origin expired)");
  // A retained row the configured policy withholds is neither disclosed as present nor claimed expired.
  capture.append({ project, agent: "codex", event: "PostToolUse", excerpt: "WITHHELD_MARKER turn", session: "aaaaaaaaaaaaaaaa" });
  const hidden = f.candidates.put({ project, kind: "memory", text: "withheld origin" } as CandidateInput, "public", { session: "aaaaaaaaaaaaaaaa" });
  (await import("node:fs")).writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["WITHHELD_MARKER"] }), { mode: 0o600 });
  expect(JSON.parse(await runCli(["review", "decide", hidden, "accept", "--json"], ctx)).originRecheck).toBe("unavailable");
});

test("#323 item 4: the re-check preview never creates capture storage; a home without capture is unavailable, not expired", async () => {
  const f = fixture(), saved = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  cleanup.push(() => { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; });
  const project = (await import("../src/memory/project.ts")).memoryProjectKey(f.root);
  const id = f.candidates.put({ project, kind: "memory", text: "no capture yet" } as CandidateInput, "public", { session: SESSION });
  const before = (await import("node:fs")).readdirSync(f.base, { recursive: true }).map(String).sort();
  expect(JSON.parse(await runCli(["review", "decide", id, "accept", "--json"], { cwd: f.root, env: {}, stdinTTY: false, stdoutTTY: false })).originRecheck).toBe("unavailable");
  const after = (await import("node:fs")).readdirSync(f.base, { recursive: true }).map(String).sort().filter(name => !name.startsWith("candidates.db"));
  expect(after.filter(name => name.includes("capture"))).toEqual(before.filter(name => name.includes("capture")));
});

test("#323 item 1: the model consolidation producer keeps the supplied run origin", async () => {
  const f = fixture();
  const note = f.store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "public model source", about: ["path:public.ts"] });
  const view = f.store.get(note)!;
  const guard = { project: f.project, actor: "agent" as const, check() {}, policy: createStandalonePolicy(), origin: { peer: "codex", session: SESSION } };
  const report = await proposeModelConsolidations(f.store, f.candidates, [view], { enabled: true, run: async () => ({ text: "a summary" }) }, guard);
  expect(report.ids).toHaveLength(1);
  expect(f.candidates.get(report.ids[0]!, f.project)!.origin).toEqual({ peer: "codex", session: SESSION });
});
