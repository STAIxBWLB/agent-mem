import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { CaptureStore } from "../src/memory/capture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mcp-memory-")); roots.push(root);
  const base = join(root, "memory"), project = "project-a", store = new MemoryStore({ home: root, deferPromotions: true });
  const note = (text: string, p = project, about = ["path:public.ts"]) => store.note({ op: "note", project: p, scope: "project", tier: "long", kind: "decision", peer: "person", text, about, source: "person" });
  return { root, base, project, store, note };
}

test("policy removes rows before limits, prefixes and graph construction; scope cannot escape", async () => {
  const f = fixture();
  const safe = f.note("public choice"); const denied = f.note("hidden choice", f.project, ["path:hidden.ts"]); f.note("public sibling", "project-b"); f.store.close();
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, policy: { denyPaths: ["hidden.ts"] } });
  try {
    const search = await mcp.tools.amem_search({ query: "choice", limit: 1 }) as { hits: { view: { id: string } }[] };
    expect(search.hits.map(hit => hit.view.id)).toEqual([safe]);
    expect(await mcp.tools.amem_show({ id: denied })).toBeNull();
    expect(JSON.stringify(await mcp.tools.amem_graph({ start: "path:hidden.ts" }))).not.toContain(denied);
    expect(JSON.stringify(await mcp.tools.amem_timeline({}))).not.toContain("sibling");
    await expect(mcp.tools.amem_search({ query: "public", project: "project-b" })).rejects.toThrow();
  } finally { mcp.close(); }
  await expect(mcp.tools.amem_show({ id: safe })).rejects.toThrow();
});

test("capture is labelled recall, never graph evidence; remember creates only a candidate", async () => {
  const f = fixture(); f.store.close();
  const capture = new CaptureStore({ home: f.root, project: f.project }); capture.append({ project: f.project, agent: "test", event: "tool", excerpt: "public capture choice" }); capture.close();
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
  try {
    const found = await mcp.tools.amem_search({ query: "capture" }) as { hits: { source: string; evidence: boolean }[] };
    expect(found.hits).toHaveLength(1); expect(found.hits[0]).toMatchObject({ source: "capture", evidence: false });
    expect(await mcp.tools.amem_show({ id: "capture:1" })).toMatchObject({ source: "capture", evidence: false });
    expect(await mcp.tools.amem_timeline({ id: "capture:1" })).toMatchObject([{ source: "capture", evidence: false }]);
    expect(await mcp.tools.amem_graph({ start: "capture:1" })).toEqual({ nodes: [], edges: [] });
    const result = await mcp.tools.amem_remember({ text: "public candidate", kind: "finding" }) as { id: string };
    const candidates = new CandidateStore({ home: f.root });
    try { expect(candidates.get(result.id, f.project)?.input.kind).toBe("memory"); } finally { candidates.close(); }
    expect(await mcp.tools.amem_search({ query: "candidate" })).toMatchObject({ hits: [] });
    await expect(mcp.tools.amem_remember({ text: "contact person@example.com" })).rejects.toThrow();
  } finally { mcp.close(); }
});

test("host policy narrows defaults and work-state writes are screened", async () => {
  const f = fixture(); f.store.close();
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, policy: { host: { screen: async value => !JSON.stringify(value).includes("host-blocked") } } });
  try {
    await mcp.tools.amem_work_state_write({ list: "queue", fields: { task: "public work", status: "todo" } });
    await expect(mcp.tools.amem_work_state_write({ list: "queue", fields: { secret: "host-blocked" } })).rejects.toThrow();
    expect(JSON.stringify(await mcp.tools.amem_work_state_read({}))).toContain("public work");
    expect(JSON.stringify(await mcp.tools.amem_work_state_read({}))).not.toContain("host-blocked");
  } finally { mcp.close(); }
});

test("MCP EOF closes the facade and refuses subsequent access", async () => {
  const { Readable, Writable } = await import("node:stream");
  const { serveMcp } = await import("../src/mcp.ts");
  const f = fixture(); const id = f.note("public note"); f.store.close();
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "amem_show", arguments: { id } } },
  ];
  let output = "";
  await serveMcp({ input: Readable.from(frames.map(frame => JSON.stringify(frame) + "\n")), output: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }), ...mcp });
  expect(output).toContain("public note");
  await expect(mcp.tools.amem_show({ id })).rejects.toThrow();
});

test("policy errors fail closed without returning partial results", async () => {
  const f = fixture(); const id = f.note("public choice"); f.store.close();
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, policy: { host: { screen: async () => { throw new Error("private failure"); } } } });
  try {
    expect(await mcp.tools.amem_show({ id })).toBeNull();
    await expect(mcp.tools.amem_search({ query: "choice" })).rejects.toThrow();
    expect(await mcp.tools.amem_graph({ start: "path:public.ts" })).toEqual({ nodes: [], edges: [] });
  } finally { mcp.close(); }
});

test("startup home remains pinned after environment changes", async () => {
  const f = fixture(); const id = f.note("public pinned home"); f.store.close();
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project });
  const previous = process.env.AMEM_HOME;
  try {
    process.env.AMEM_HOME = join(f.root, "other-home");
    expect(await mcp.tools.amem_show({ id })).toMatchObject({ id, text: "public pinned home" });
    await mcp.tools.amem_work_state_write({ list: "pinned", fields: { status: "doing" } });
    expect(await mcp.tools.amem_work_state_read({ list: "pinned" })).toHaveLength(1);
  } finally { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; mcp.close(); }
});

test("work-state read screens materialized views before closed-item filtering", async () => {
  const f = fixture(); f.store.close();
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, policy: { host: { screen: async value => {
    const encoded = JSON.stringify(value);
    return !(encoded.includes("host-left") && encoded.includes("host-right"));
  } } } });
  try {
    await mcp.tools.amem_work_state_write({ list: "private-union", fields: { left: "host-left" } });
    await mcp.tools.amem_work_state_write({ list: "private-union", fields: { task: "closed item", status: "done", right: "host-right" } });
    await mcp.tools.amem_work_state_write({ list: "allowed", fields: { status: "doing" } });
    expect(await mcp.tools.amem_work_state_read({ list: "private-union", includeClosed: true })).toEqual([]);
    // Filtering the closed item first would hide the combination from policy and leak the surviving list.
    expect(await mcp.tools.amem_work_state_read({ list: "private-union" })).toEqual([]);
    expect(await mcp.tools.amem_work_state_read({ includeClosed: true })).toMatchObject([{ list: "allowed" }]);
  } finally { mcp.close(); }
});
