import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { runCli, writeCliOutput, type CliContext, type CliOutputReceipt } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { serveMcp } from "../src/mcp.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { memoryGitEnv, memoryGitSync, realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { createIntentBriefSource } from "../src/memory/recall.ts";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
type Mode = "legacy" | "generation" | "shards";
async function fixture(mode: Mode = "legacy") {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-brief-cli-mcp-"))), base = join(root, "memory"), project = memoryProjectKey(root); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const initial = new MemoryStore({ memoryDir: base, deferPromotions: true }); initial.close();
  if (mode === "generation") await migrate({ memoryDir: base, generation: "e".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  if (mode === "shards") await migrateShards({ memoryDir: base, mode: "apply", authorizedPerson: true, tty: true });
  let clock = Date.now() - 20 * 86400_000;
  const use = <T>(work: (store: MemoryStore) => T): T => { const opts = { memoryDir: base, now: () => clock, deferPromotions: true }; const store = mode === "shards" ? openShardStore({ ...opts, project }) : new MemoryStore(opts); try { return work(store); } finally { store.close(); } };
  const note = (text: string, extra: Partial<NoteInput> = {}) => { clock += 1000; return use(store => store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text, about: ["path:public.ts"], ...extra })); };
  const bound = async <T>(work: () => Promise<T>): Promise<T> => { const beforeHome = process.env.HOME, beforeBase = process.env.AMEM_HOME; process.env.HOME = root; process.env.AMEM_HOME = base; try { return await work(); } finally { if (beforeHome === undefined) delete process.env.HOME; else process.env.HOME = beforeHome; if (beforeBase === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = beforeBase; } };
  const cli = (args: string[], extra: Partial<CliContext> = {}) => bound(() => runCli(args, { cwd: root, env: {}, stdinTTY: true, ...extra }));
  const counters = () => { const port = new CandidateStore({ memoryDir: base }); try { return port.counters(project); } finally { port.close(); } };
  const mcp = () => { const session = createMemoryMcp({ cwd: root, base, project }); cleanup.push(() => session.close()); return session; };
  const bytes = () => Object.fromEntries(readdirSync(base, { recursive: true, withFileTypes: true }).filter(row => row.isFile() && row.name.endsWith(".jsonl")).map(row => { const file = join(row.parentPath, row.name); return [file, readFileSync(file, "utf8")]; }));
  return { root, base, project, use, note, bound, cli, counters, mcp, bytes, iso: () => new Date(clock).toISOString(), advance: () => { clock += 1000; } };
}
async function briefFixture(mode: Mode) {
  const f = await fixture(mode); writeFileSync(join(f.root, "public.ts"), "original"); utimesSync(join(f.root, "public.ts"), 1, 1);
  const direct = f.note("직접 public boundary failure", { kind: "fail", about: ["path:public.ts", "issue:public#7"] }), decision = f.note("public boundary decision", { kind: "decision" }), neighbour = f.note("one hop contract", { about: ["issue:public#7", "issue:public#8"] });
  const far = f.note("second hop must stay out", { about: ["issue:public#8"] }), finding = f.note("finding must stay out", { kind: "finding" }), hidden = f.note("private wording must stay out", { kind: "fail" }), foreign = f.note("foreign shared must stay out", { project: "foreign-project", scope: "shared", kind: "fail" });
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["private wording"] })); writeFileSync(join(f.root, "public.ts"), "changed after the entry was written");
  return { ...f, direct, decision, neighbour, far, finding, hidden, foreign };
}
function briefRows(brief: string): Array<{ id: string; kind: string; text: string }> { return brief.split("\n").slice(1).map(line => JSON.parse(line)); }
for (const mode of ["legacy", "generation", "shards"] as const) {
  test(`${mode}: CLI/MCP intent brief has identical public fail-first one-hop output and UTF8 accounting`, async () => {
    const f = await briefFixture(mode), before = f.bytes(), cli = JSON.parse(await f.cli(["brief", "--for", "repair boundary", "--paths", "public.ts", "--bytes", "1100", "--json"])), session = f.mcp(), mcp = await session.tools.amem_brief({ intent: "repair boundary", paths: ["public.ts"], maxBytes: 1100 });
    expect(mcp).toEqual(cli); expect(cli.bytes).toBe(Buffer.byteLength(cli.brief)); expect(cli.bytes).toBeLessThanOrEqual(1100);
    const rows = briefRows(cli.brief); expect(rows.map(row => row.id)).toEqual([f.direct, f.decision, f.neighbour].map(id => `mem:${id}`)); expect(rows.map(row => row.kind)).toEqual(["fail", "decision", "contract"]); expect(rows[0]!.text).toContain("(stale?)");
    for (const id of [f.far, f.finding, f.hidden, f.foreign]) expect(cli.brief).not.toContain(id); expect(f.bytes()).toEqual(before); expect(f.counters()).toEqual([]);
  });
  test(`${mode}: default CLI/MCP recall hides superseded/expired, person history keeps retained chain and current forget revives source`, async () => {
    const f = await fixture(mode), old = f.note("recallboundary original"), past = f.iso(), replacement = f.note("recallboundary replacement"), replacementPast = f.iso(); f.advance(); f.use(store => store.supersede(old, replacement, "person", f.project));
    const expired = f.note("recallboundary expired", { tier: "short", expires: new Date(Date.now() - 86400_000).toISOString() }), session = f.mcp();
    expect(f.use(store => store.get(old, f.project)?.supersededBy)).toBe(replacement);
    const search = JSON.parse(await f.cli(["search", "recallboundary", "--json"])); expect(search.map((row: any) => row.id)).toEqual([replacement]);
    for (const id of [old, expired]) { await expect(f.cli(["show", id, "--json"])).rejects.toThrow("no memory entry"); expect(await session.tools.amem_show({ id })).toBeNull(); }
    const hits = await session.tools.amem_search({ query: "recallboundary", includeCapture: false }) as { hits: Array<{ view: { id: string } }> }; expect(hits.hits.map(hit => hit.view.id)).toEqual([replacement]);
    const history = JSON.parse(await f.cli(["search", "recallboundary", "--history", "--json"])); expect(history.entries.map((row: any) => row.id).sort()).toEqual([old, replacement, expired].sort());
    const chain = JSON.parse(await f.cli(["show", old, "--history", "--json"])); expect(chain.views.map((row: any) => row.id).sort()).toEqual([old, replacement].sort());
    const asOf = JSON.parse(await f.cli(["search", "recallboundary", "--as-of", past, "--json"])); expect(asOf.entries.map((row: any) => row.id)).toEqual([old]);
    await expect(f.cli(["search", "recallboundary", "--history"], { env: { CLAUDECODE: "", HOME: f.root, AMEM_HOME: f.base } })).rejects.toThrow("Memory operation unavailable or refused; no partial result is shown.");
    for (const args of [{ id: old, history: true }, { id: old, asOf: past }]) await expect(session.tools.amem_show(args)).rejects.toThrow("unavailable");
    f.advance(); f.use(store => store.forget(replacement, "person", f.project));
    expect(JSON.parse(await f.cli(["search", "recallboundary", "--json"])).map((row: any) => row.id)).toEqual([old]); expect(JSON.parse(await f.cli(["show", old, "--json"])).id).toBe(old);
    expect((await session.tools.amem_show({ id: old }) as { id: string }).id).toBe(old);
    for (const flags of [["--history"], ["--as-of", replacementPast], ["--history", "--as-of", replacementPast]]) expect(await f.cli(["show", replacement, ...flags, "--json"])).not.toContain("recallboundary replacement");
  });
}
test("CLI output preparation is uncounted; only confirmed write followed by receipt records rendered and never delivered/cited", async () => {
  const f = await briefFixture("legacy"); await f.bound(async () => {
    const receipts: CliOutputReceipt[] = [], output = await f.cli(["brief", "--for", "boundary", "--paths", "public.ts", "--json"], { onOutputReady: receipt => receipts.push(receipt) });
    expect(receipts).toHaveLength(1); expect(receipts[0]!.project).toBe(f.project); expect(receipts[0]!.ids).toEqual([f.direct, f.decision, f.neighbour]); expect(f.counters()).toEqual([]);
    let written = ""; await writeCliOutput(output, new Writable({ write(chunk, _encoding, callback) { written += chunk.toString(); callback(); } })); expect(written).toBe(output); expect(f.counters()).toEqual([]);
    expect(receipts[0]!.rendered()).toBe(true); expect(receipts[0]!.rendered()).toBe(true);
    const rows = f.counters(); expect(rows).toHaveLength(3); expect(rows.every(row => row.rendered === 1 && row.delivered === null && row.cited === null)).toBe(true);
  });
});
test("failed CLI output leaves receipt uncalled and records no rendered counters", async () => {
  const f = await briefFixture("legacy"); await f.bound(async () => {
    const receipts: CliOutputReceipt[] = [], text = await f.cli(["brief", "--for", "boundary", "--paths", "public.ts"], { onOutputReady: receipt => receipts.push(receipt) });
    expect(receipts).toHaveLength(1);
    const failed = new Writable({ write(_chunk, _encoding, callback) { callback(Error("fixture broken pipe")); } });
    await expect(writeCliOutput(text, failed)).rejects.toThrow("broken pipe"); expect(f.counters()).toEqual([]);
  });
});
test("MCP handler return does not count; original result emission is idempotent, reused rpc id with new result counts anew", async () => {
  const f = await briefFixture("legacy"), session = f.mcp(), first = await session.tools.amem_brief({ intent: "boundary", paths: ["public.ts"] }); expect(f.counters()).toEqual([]);
  await session.onEmitted("amem_brief", 7, first); await session.onEmitted("amem_brief", 7, first); expect(f.counters()).toHaveLength(3);
  await session.onEmitted("amem_brief", 7, JSON.parse(JSON.stringify(first))); expect(f.counters()).toHaveLength(3);
  const second = await session.tools.amem_brief({ intent: "boundary", paths: ["public.ts"] }); await session.onEmitted("amem_brief", 7, second);
  const rows = f.counters(); expect(rows).toHaveLength(6); expect(rows.every(row => row.rendered === 1 && row.delivered === null && row.cited === null)).toBe(true);
});
test("actual stdio transport wires session emission observer and closes once at EOF", async () => {
  const f = await briefFixture("legacy"), session = f.mcp(), input = new PassThrough(), output = new PassThrough(); let encoded = "", closes = 0;
  output.on("data", chunk => { encoded += chunk.toString(); });
  const done = serveMcp({ input, output, tools: session.tools, onEmitted: session.onEmitted, close: () => { closes++; session.close(); } });
  input.end([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "brief-integration", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "amem_brief", arguments: { intent: "boundary", paths: ["public.ts"] } } }].map(row => JSON.stringify(row)).join("\n") + "\n");
  await done; expect(closes).toBe(1); const replies = encoded.trim().split("\n").map(line => JSON.parse(line)); expect(replies.map(row => row.id)).toEqual([1, 2]); expect(replies[1].result.isError).toBeUndefined(); expect(f.counters()).toHaveLength(3); expect(f.counters().every(row => row.delivered === null && row.cited === null)).toBe(true);
});
test("MCP host admission and late-call fences remain; marked CLI brief uses its configured PII screen", async () => {
  const f = await fixture(), missing = join(f.root, "never-created"); expect(() => createMemoryMcp({ cwd: f.root, base: missing, project: f.project, allowed: () => false })).toThrow("unavailable"); expect(existsSync(missing)).toBe(false);
  f.note("public PII fence fixture", { kind: "fail" });
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["public PII fence fixture"] }));
  const cli = JSON.parse(await f.cli(["brief", "--for", "fixture", "--paths", "public.ts", "--json"], { env: { CODEX_THREAD_ID: "", HOME: f.root, AMEM_HOME: f.base } }));
  expect(cli.brief).not.toContain("public PII fence fixture");
  let allowed = true;
  const session = createMemoryMcp({ cwd: f.root, base: f.base, project: f.project, allowed: () => allowed }); cleanup.push(() => session.close());
  for (const extra of [{ project: "other" }, { home: missing }, { history: true }, { asOf: "2020-01-01" }]) await expect(session.tools.amem_brief({ intent: "fixture", ...extra })).rejects.toThrow("unavailable");
  const result = await session.tools.amem_brief({ intent: "fixture", paths: ["public.ts"] }); allowed = false;
  await expect(session.tools.amem_brief({ intent: "fixture" })).rejects.toThrow("unavailable"); await session.onEmitted("amem_brief", 4, result); expect(f.counters()).toEqual([]);
});
test("bounded intent snapshot source prepares once and preserves unknown-coverage truncation", () => {
  let calls = 0, checks = 0;
  const rows: import("../src/memory/store.ts").View[] = [];
  const fake = { intentSnapshot: (project: string) => { calls++; expect(project).toBe("project"); return { rows, truncated: true, assertCurrent: () => { checks++; } }; } } as unknown as MemoryStore;
  const source = createIntentBriefSource(fake, "project"); expect(source.notes()).toBe(rows); expect(source.notes()).toBe(rows); expect(calls).toBe(1); expect(source.truncated()).toBe(true); source.assertCurrent(); expect(checks).toBe(1);
});
test("CLI output closed while its write callback is pending rejects promptly without rendering its prepared receipt", async () => {
  const f = await briefFixture("legacy"); await f.bound(async () => {
    const receipts: CliOutputReceipt[] = [], text = await f.cli(["brief", "--for", "boundary", "--paths", "public.ts"], { onOutputReady: receipt => receipts.push(receipt) });
    expect(receipts).toHaveLength(1); let callbackCalls = 0, ready!: () => void;
    const writing = new Promise<void>(resolve => { ready = resolve; });
    const output = new Writable({ write(_chunk, _encoding, _callback) { ready(); } });
    const attempt = writeCliOutput(text, output).then(() => { callbackCalls++; receipts[0]!.rendered(); return "written"; }, () => "rejected");
    await writing; output.destroy(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { expect(await Promise.race([attempt, new Promise<string>(resolve => { timer = setTimeout(() => resolve("hung"), 100); })])).toBe("rejected"); }
    finally { if (timer) clearTimeout(timer); output.destroy(); }
    expect(callbackCalls).toBe(0); expect(f.counters()).toEqual([]);
  });
});

test("CLI human and MCP show from a real Git subdirectory use root-relative path staleness", async () => {
  const f = await fixture(); await f.bound(async () => {
    expect(memoryProjectKey(f.root)).toBe(f.project);
    const env = { ...memoryGitEnv(process.env, { repositoryIsolation: true }), HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    expect(memoryGitSync(["init", "--quiet", f.root], { encoding: "utf8", env }).status).toBe(0);
    const subdir = join(f.root, "nested", "work"), file = join(f.root, "src", "file.ts"); mkdirSync(subdir, { recursive: true }); mkdirSync(join(f.root, "src")); writeFileSync(file, "original source");
    expect(memoryProjectKey(f.root)).toBe(f.project); expect(memoryProjectKey(subdir)).toBe(f.project);
    const id = f.note("root relative path evidence", { about: ["path:src/file.ts"] }), at = Date.parse(f.use(store => store.get(id, f.project)!.at)); utimesSync(file, new Date(at - 1000), new Date(at - 1000));
    const session = createMemoryMcp({ cwd: subdir, base: f.base }); cleanup.push(() => session.close());
    const human = await f.cli(["show", id], { cwd: subdir }); expect(human).toContain("root relative path evidence"); expect(human).not.toContain("(stale?)");
    expect(await session.tools.amem_show({ id })).toMatchObject({ id }); expect(await session.tools.amem_show({ id })).not.toHaveProperty("stale");
    writeFileSync(file, "changed source"); utimesSync(file, new Date(at + 1000), new Date(at + 1000));
    expect(await f.cli(["show", id], { cwd: subdir })).toContain("(stale?)"); expect(await session.tools.amem_show({ id })).toMatchObject({ id, stale: true });
  });
});
test("missing paths at an unconfirmed non-repository root remain unknown in CLI and MCP", async () => {
  const f = await fixture(), id = f.note("unconfirmed missing path evidence", { about: ["path:missing-root/file.ts"] }), session = f.mcp();
  expect(existsSync(join(f.root, ".git"))).toBe(false); expect(await f.cli(["show", id])).not.toContain("(stale?)"); expect(await session.tools.amem_show({ id })).not.toHaveProperty("stale");
});
