import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, configuredHome, configuredPolicy, loadAmemConfig, repoConfigPath, repoConfigRoot } from "../src/memory/config.ts";
import { resolveMemoryHome } from "../src/memory/home.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { realPath } from "../src/memory/platform.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { syncMemory, type Visibility } from "../src/memory/sync.ts";
import { runCli } from "../src/cli.ts";

// agent-mem#40 F4 (AC3): a deny path and a PII pattern set in the configuration file are enforced by capture, MCP, brief and sync; a repository
// configuration can narrow the policy and never widen it. Fixtures only: every home and repository here is a temporary directory.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const privately = { visibility: async (): Promise<Visibility> => "private" };

function rig(config?: unknown) {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-config-"))); roots.push(root);
  const base = join(root, "memory"), cwd = join(root, "repo");
  mkdirSync(base, { recursive: true }); mkdirSync(cwd, { recursive: true }); mkdirSync(join(cwd, ".git"));
  if (config !== undefined) writeFileSync(join(base, CONFIG_FILE), JSON.stringify(config));
  const project = memoryProjectKey(cwd);
  const repoConfig = (value: unknown) => { mkdirSync(join(cwd, ".amem"), { recursive: true }); writeFileSync(repoConfigPath(cwd), JSON.stringify(value)); };
  return { root, base, cwd, project, repoConfig };
}
const SECRET_WORD = "zebra-project-codename", PRIVATE_DIR = "confidential-vault";

test("the configuration loads from the memory home, and a missing file is no policy rather than an error", () => {
  const none = rig();
  expect(loadAmemConfig(none.base)).toMatchObject({ config: { denyPaths: [], piiPatterns: [] }, source: { machine: null, repo: null } });
  const r = rig({ denyPaths: [PRIVATE_DIR], piiPatterns: [SECRET_WORD], briefBytes: 400, excerptBytes: 100, capturePaths: 3, capture: { capMb: 8, retentionDays: 7 } });
  const { config, source } = loadAmemConfig(r.base);
  expect(config).toEqual({ denyPaths: [PRIVATE_DIR], piiPatterns: [SECRET_WORD], briefBytes: 400, excerptBytes: 100, capturePaths: 3, capture: { capMb: 8, retentionDays: 7 } });
  expect(source.machine).toBe(join(r.base, CONFIG_FILE));
});

test("a malformed configuration is an error that names the file, never a silent default", () => {
  const bad: unknown[] = ["[]", { denyPaths: "x" }, { piiPatterns: [1] }, { denyPaths: ["a\nb"] }, { denyPaths: Array.from({ length: 65 }, (_, i) => `p${i}`) }, { briefBytes: 0 },
    { briefBytes: 1.5 }, { excerptBytes: -1 }, { surprise: true }, { capture: { capMb: 0 } }, { capture: { unknown: 1 } }, { home: "relative/path" }];
  for (const value of bad) {
    const r = rig(); writeFileSync(join(r.base, CONFIG_FILE), typeof value === "string" ? value : JSON.stringify(value));
    expect(() => loadAmemConfig(r.base), JSON.stringify(value)).toThrow(join(r.base, CONFIG_FILE));
  }
  const notJson = rig(); writeFileSync(join(notJson.base, CONFIG_FILE), "{ not json");
  expect(() => loadAmemConfig(notJson.base)).toThrow("does not parse");
  const big = rig(); writeFileSync(join(big.base, CONFIG_FILE), JSON.stringify({ denyPaths: ["x"], pad: "y".repeat(70_000) }));
  expect(() => loadAmemConfig(big.base)).toThrow("within");
  const linked = rig(); writeFileSync(join(linked.root, "real.json"), "{}"); symlinkSync(join(linked.root, "real.json"), join(linked.base, CONFIG_FILE));
  expect(() => loadAmemConfig(linked.base)).toThrow("symbolic link");
});

test("a configured PII pattern and deny path decline a value; with no configuration the same value passes", async () => {
  const plain = rig(), set = rig({ denyPaths: [PRIVATE_DIR], piiPatterns: [SECRET_WORD] });
  for (const value of [{ text: `notes about ${SECRET_WORD}` }, { text: `see ${PRIVATE_DIR}/plan.md` }, { about: [`path:${PRIVATE_DIR}/x.ts`] }]) {
    expect(await configuredPolicy(plain.base).screen(value)).toBe(true);
    expect(await configuredPolicy(set.base).screen(value)).toBe(false);
    expect(configuredPolicy(set.base).screenStandalone(value)).toBe(false);
  }
  expect(await configuredPolicy(set.base).screen({ text: "an ordinary finding" })).toBe(true);
});

test("a stricter host policy passed through the library still wins over the configuration", async () => {
  const r = rig({ piiPatterns: [SECRET_WORD] });
  const host = { screen: async (value: unknown) => !JSON.stringify(value).includes("host-only-word") };
  const policy = configuredPolicy(r.base, r.cwd, { host });
  expect(await policy.screen({ text: "fine" })).toBe(true);
  expect(await policy.screen({ text: "host-only-word" })).toBe(false);       // the host declines what the configuration allows
  expect(await policy.screen({ text: SECRET_WORD })).toBe(false);            // the configuration declines what the host allows
  expect(policy.screenStandalone({ text: "host-only-word" })).toBe(true);    // the synchronous part never asks the host
});

test("capture: a configured PII pattern redacts the excerpt, a deny path drops the path, and the caps lower what is stored", () => {
  const r = rig({ denyPaths: [PRIVATE_DIR], piiPatterns: [SECRET_WORD], excerptBytes: 40, capturePaths: 2 });
  const capture = new CaptureStore({ memoryDir: r.base, project: r.project });
  try {
    capture.append({ project: r.project, agent: "t", event: "PostToolUse", excerpt: `work on ${SECRET_WORD} today`, paths: ["src/a.ts"] });
    capture.append({ project: r.project, agent: "t", event: "PostToolUse", excerpt: "x".repeat(200), paths: [`${PRIVATE_DIR}/plan.md`, "src/a.ts", "src/b.ts", "src/c.ts"] });
    const rows = capture.rows({ project: r.project });
    const flat = JSON.stringify(rows);
    expect(flat).not.toContain(SECRET_WORD);
    expect(rows.some(row => row.excerpt === "[secret-screened]")).toBe(true);
    expect(flat).not.toContain(PRIVATE_DIR);
    const capped = rows.find(row => row.excerpt.startsWith("xxx"))!;
    expect(capped.excerpt.length).toBe(40); expect(capped.paths).toEqual(["src/a.ts", "src/b.ts"]);
  } finally { capture.close(); }
  // The configured size cap and retention are the machine layer of the capture bounds.
  const sized = new CaptureStore({ memoryDir: r.base, project: r.project });
  try { expect(sized).toBeDefined(); } finally { sized.close(); }
});

test("capture bounds: the machine configuration is the lowest layer, a shard or home file still overrides it", async () => {
  const { readCaptureConfig } = await import("../src/memory/capture.ts");
  const r = rig({ capture: { capMb: 8, retentionDays: 7 } });
  const shard = join(r.root, "shard"); mkdirSync(shard);
  expect(readCaptureConfig(shard, r.base)).toEqual({ capMb: 8, retentionDays: 7 });
  writeFileSync(join(r.base, "capture-config.json"), JSON.stringify({ cap_mb: 32, retention_days: 30 }));
  expect(readCaptureConfig(shard, r.base)).toEqual({ capMb: 32, retentionDays: 30 });
  writeFileSync(join(shard, "config.json"), JSON.stringify({ cap_mb: 64 }));
  expect(readCaptureConfig(shard, r.base)).toEqual({ capMb: 64, retentionDays: 30 });
});

test("<private> spans are never stored: not in capture, not in the spooled hook record, and an unclosed span drops the rest", async () => {
  const { stripPrivateSpans } = await import("../src/memory/private-spans.ts");
  expect(stripPrivateSpans("a <private>b</private> c")).toBe("a  c");
  expect(stripPrivateSpans("a <PRIVATE>b</Private> c")).toBe("a  c");
  expect(stripPrivateSpans("a <private>b <private>x</private> y</private> c")).toBe("a  c");
  expect(stripPrivateSpans("a <private>b never closed")).toBe("a ");
  expect(stripPrivateSpans("a </private> stray closer stays")).toBe("a </private> stray closer stays");
  expect(stripPrivateSpans("a <privateer>kept</privateer>")).toBe("a <privateer>kept</privateer>");
  expect(stripPrivateSpans("no tags")).toBe("no tags");
  const r = rig();
  const capture = new CaptureStore({ memoryDir: r.base, project: r.project });
  try {
    capture.append({ project: r.project, agent: "t", event: "UserPromptSubmit", excerpt: "keep this <private>token-free but secret plan alpha</private> and this" });
    capture.append({ project: r.project, agent: "t", event: "UserPromptSubmit", excerpt: "visible start <private>never closed secret plan beta" });
    const flat = JSON.stringify(capture.rows({ project: r.project }));
    expect(flat).toContain("keep this  and this"); expect(flat).toContain("visible start ");
    expect(flat).not.toMatch(/plan alpha|plan beta/);
  } finally { capture.close(); }
});

test("the hook path drops <private> spans and applies the configured pattern before anything is spooled", async () => {
  const { stageHookCapture } = await import("../src/hook-spool.ts");
  const r = rig({ piiPatterns: [SECRET_WORD] });
  const base = { cwd: r.cwd, base: r.base };
  const input = (text: string) => ({ hook_event_name: "UserPromptSubmit", cwd: r.cwd, prompt: text });
  const kept = await stageHookCapture("UserPromptSubmit", input("keep <private>hidden plan gamma</private> visible"), base);
  expect(kept).toBeDefined();
  const declined = await stageHookCapture("UserPromptSubmit", input(`talk about ${SECRET_WORD}`), base);
  expect(declined).toBeUndefined();
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = join(r.base, "hook-spool");
  const spooled = readdirSync(dir, { recursive: true }).map(String).filter(name => name.endsWith(".json")).map(name => { try { return readFileSync(join(dir, name), "utf8"); } catch { return ""; } }).join("\n");
  expect(spooled).not.toContain("plan gamma"); expect(spooled).not.toContain(SECRET_WORD);
});

test("MCP: a configured pattern and deny path withhold curated notes, capture rows and the query itself", async () => {
  const r = rig({ denyPaths: [PRIVATE_DIR], piiPatterns: [SECRET_WORD] });
  const store = new MemoryStore({ memoryDir: r.base, screen: () => "keep" });
  try {
    store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", text: `we chose sqlite for ${SECRET_WORD}`, about: [], source: "person" });
    store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", text: "we chose sqlite for the index", about: [], source: "person" });
    store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "contract", peer: "fixture", text: `contract notes in ${PRIVATE_DIR}/spec.md`, about: [], source: "person" });
  } finally { store.close(); }
  const capture = new CaptureStore({ memoryDir: r.base, project: r.project });
  try { capture.append({ project: r.project, agent: "t", event: "PostToolUse", excerpt: "sqlite capture row", paths: ["src/ok.ts"] }); } finally { capture.close(); }
  const mcp = createMemoryMcp({ cwd: r.cwd, base: r.base });
  try {
    const found = JSON.stringify(await mcp.tools.amem_search!({ query: "sqlite" }));
    expect(found).toContain("the index"); expect(found).toContain("sqlite capture row");
    expect(found).not.toContain(SECRET_WORD); expect(found).not.toContain(PRIVATE_DIR);
    await expect(mcp.tools.amem_search!({ query: SECRET_WORD })).rejects.toThrow();   // a query that names the pattern is itself declined
    await expect(mcp.tools.amem_remember!({ text: `remember ${SECRET_WORD}` })).rejects.toThrow();
  } finally { mcp.close(); }
});

const briefNotes = (base: string, project: string, count: number, withSecret: boolean) => {
  const store = new MemoryStore({ memoryDir: base, screen: () => "keep" });
  try {
    if (withSecret) store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "fixture", text: `a decision about ${SECRET_WORD}`, about: [], source: "person" });
    for (let i = 0; i < count; i++) store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "fixture", text: `an ordinary public finding number ${i} about the index layout and its tests`, about: [], source: "person" });
  } finally { store.close(); }
};

test("brief: a configured pattern keeps a curated note out of SessionStart (and it is shown without the pattern)", async () => {
  // Few notes and no budget set: everything fits, so the only thing that can hide the secret note is the configured policy.
  const withPattern = rig({ piiPatterns: [SECRET_WORD] }), without = rig();
  for (const r of [withPattern, without]) briefNotes(r.base, r.project, 2, true);
  const hidden = await sessionStartBrief({ cwd: withPattern.cwd, base: withPattern.base, project: withPattern.project, maxTokens: 1200 });
  const shown = await sessionStartBrief({ cwd: without.cwd, base: without.base, project: without.project, maxTokens: 1200 });
  expect(shown.context).toContain(SECRET_WORD); expect(shown.coverage.curated).toBe("complete");   // proves the note would otherwise be in the brief
  expect(hidden.context).not.toContain(SECRET_WORD); expect(hidden.context).toContain("ordinary public finding");
});

test("brief: the configured byte budget lowers the brief below what the same notes take without it", async () => {
  const capped = rig({ briefBytes: 700 }), wide = rig();
  for (const r of [capped, wide]) briefNotes(r.base, r.project, 12, false);
  const small = await sessionStartBrief({ cwd: capped.cwd, base: capped.base, project: capped.project, maxTokens: 1200 });
  const big = await sessionStartBrief({ cwd: wide.cwd, base: wide.base, project: wide.project, maxTokens: 1200 });
  expect(Buffer.byteLength(small.context)).toBeLessThanOrEqual(700); expect(small.tokens).toBeLessThanOrEqual(700); expect(small.partial).toBe(true);
  expect(Buffer.byteLength(big.context)).toBeGreaterThan(700);
  // A caller's own lower budget still wins over a higher configured one.
  const high = rig({ briefBytes: 1000 }); briefNotes(high.base, high.project, 12, false);
  expect(Buffer.byteLength((await sessionStartBrief({ cwd: high.cwd, base: high.base, project: high.project, maxTokens: 500 })).context)).toBeLessThanOrEqual(500);
});

test("sync: a note the configured policy declines refuses the whole sync, names the id and never the text; a clean log syncs", async () => {
  const remote = join(realPath(mkdtempSync(join(tmpdir(), "amem-config-remote-"))), "remote.git"); roots.push(join(remote, ".."));
  const init = Bun.spawnSync(["git", "init", "-q", "--bare", remote]); expect(init.exitCode).toBe(0);
  const r = rig({ piiPatterns: [SECRET_WORD], denyPaths: [PRIVATE_DIR] });
  const store = new MemoryStore({ memoryDir: r.base, screen: () => "keep" });
  try {
    const ok = store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", text: "a public decision", about: [], source: "person" });
    expect(await syncMemory(store, { remote, ...privately })).toMatchObject({ ok: true, pushed: true });
    const bad = store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", text: `a decision about ${SECRET_WORD}`, about: [], source: "person" });
    const refused = await syncMemory(store, { remote, ...privately });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(bad.slice(0, 8)); expect(refused.error).not.toContain(ok.slice(0, 8)); expect(refused.error).not.toContain(SECRET_WORD);
    const viaPath = store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "contract", peer: "fixture", text: "look here", about: [`path:${PRIVATE_DIR}/x.ts`], source: "person" });
    expect((await syncMemory(store, { remote, ...privately })).error).toContain(viaPath.slice(0, 8));
  } finally { store.close(); }
  const clean = rig({ piiPatterns: [SECRET_WORD] });
  const cleanStore = new MemoryStore({ memoryDir: clean.base, screen: () => "keep" });
  try {
    cleanStore.note({ op: "note", project: clean.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", text: "only public words", about: [], source: "person" });
    expect(await syncMemory(cleanStore, { remote, ...privately })).toMatchObject({ ok: true });
  } finally { cleanStore.close(); }
});

test("the repository configuration can only narrow: it adds entries and lowers a budget, and never removes, raises or moves the home", () => {
  const r = rig({ denyPaths: ["machine-deny"], piiPatterns: ["machine-pii"], briefBytes: 600, excerptBytes: 500 });
  r.repoConfig({ denyPaths: ["repo-deny"], piiPatterns: ["repo-pii"], briefBytes: 300, excerptBytes: 900 });
  const { config, source } = loadAmemConfig(r.base, r.cwd);
  expect(config.denyPaths.sort()).toEqual(["machine-deny", "repo-deny"]);
  expect(config.piiPatterns.sort()).toEqual(["machine-pii", "repo-pii"]);
  expect(config.briefBytes).toBe(300);          // lowered by the repository
  expect(config.excerptBytes).toBe(500);        // a higher repository value does not widen the machine's
  expect(source.repo).toBe(repoConfigPath(r.cwd));
  // A repository with no machine value may still set a budget (that is a narrowing from "unbounded to the built-in cap").
  const bare = rig(); bare.repoConfig({ briefBytes: 250 });
  expect(loadAmemConfig(bare.base, bare.cwd).config.briefBytes).toBe(250);
  // It cannot widen the machine's entries away: an empty repository list changes nothing.
  const empty = rig({ denyPaths: ["machine-deny"] }); empty.repoConfig({ denyPaths: [] });
  expect(loadAmemConfig(empty.base, empty.cwd).config.denyPaths).toEqual(["machine-deny"]);
  // Keys that could widen or move things are refused by name: the home, the capture bounds, and anything unknown.
  for (const key of [{ home: join(r.root, "elsewhere") }, { capture: { capMb: 999 } }, { allow: ["x"] }]) {
    const x = rig(); x.repoConfig(key);
    expect(() => loadAmemConfig(x.base, x.cwd), JSON.stringify(key)).toThrow(repoConfigPath(x.cwd));
  }
});

test("the repository configuration reaches capture, MCP and the policy of a command run inside that repository", async () => {
  const r = rig({ piiPatterns: ["machine-pii"] });
  r.repoConfig({ piiPatterns: [SECRET_WORD] });
  expect(await configuredPolicy(r.base, r.cwd).screen({ text: SECRET_WORD })).toBe(false);
  expect(await configuredPolicy(r.base, join(r.cwd, "nested", "deeper")).screen({ text: SECRET_WORD })).toBe(false);   // found from a subdirectory
  expect(await configuredPolicy(r.base).screen({ text: SECRET_WORD })).toBe(true);                                      // no repository named: only the machine file
  expect(repoConfigRoot(join(r.cwd, "nested", "deeper"))).toBe(r.cwd);
  const outside = realPath(mkdtempSync(join(tmpdir(), "amem-config-outside-"))); roots.push(outside);
  expect(repoConfigRoot(outside)).toBeUndefined();
});

test("a repository configuration does not leak across repositories", async () => {
  const a = rig(), b = rig();
  a.repoConfig({ piiPatterns: [SECRET_WORD] });
  expect(await configuredPolicy(a.base, a.cwd).screen({ text: SECRET_WORD })).toBe(false);
  expect(await configuredPolicy(b.base, b.cwd).screen({ text: SECRET_WORD })).toBe(true);
});

test("the home: AMEM_HOME wins, then the pointer file in the default home, then the default; status prints which", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-home-"))); roots.push(root);
  const parent = join(root, "agenthub"), moved = join(root, "moved");
  mkdirSync(join(parent, "memory"), { recursive: true }); mkdirSync(moved);
  expect(resolveMemoryHome({ AGENTHUB_HOME: parent })).toEqual({ home: join(parent, "memory"), source: "default" });
  writeFileSync(join(parent, "memory", CONFIG_FILE), JSON.stringify({ home: moved }));
  expect(resolveMemoryHome({ AGENTHUB_HOME: parent })).toEqual({ home: moved, source: "config" });
  expect(resolveMemoryHome({ AGENTHUB_HOME: parent, AMEM_HOME: join(root, "env-home") })).toEqual({ home: join(root, "env-home"), source: "AMEM_HOME" });
  expect(configuredHome(join(parent, "memory"))).toBe(moved);
  // The policy lives in the file inside the home it names: a pointer that also carries policy would lose it, so it is refused by name.
  writeFileSync(join(parent, "memory", CONFIG_FILE), JSON.stringify({ home: moved, piiPatterns: ["x"] }));
  expect(() => resolveMemoryHome({ AGENTHUB_HOME: parent })).toThrow("only a pointer");
  writeFileSync(join(parent, "memory", CONFIG_FILE), JSON.stringify({ home: moved }));
  writeFileSync(join(moved, CONFIG_FILE), JSON.stringify({ piiPatterns: [SECRET_WORD] }));
  expect(loadAmemConfig(moved).config.piiPatterns).toEqual([SECRET_WORD]);
  const out = JSON.parse(await runCli(["status"], { cwd: root, env: {}, stdinTTY: false, ...{} } as never).catch(() => "{}")) as { home?: unknown };
  expect(typeof out).toBe("object");
});

test("amem status prints the memory home, where it came from and the configuration in effect", async () => {
  const r = rig({ denyPaths: ["a"], piiPatterns: ["b", "c"], briefBytes: 500 });
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = r.base;
  try {
    const status = JSON.parse(await runCli(["status"], { cwd: r.cwd, env: {}, stdinTTY: false })) as { home: { path: string; source: string }; config: Record<string, unknown>; active: boolean };
    expect(status.home).toEqual({ path: r.base, source: "AMEM_HOME" });
    expect(status.config).toMatchObject({ machine: join(r.base, CONFIG_FILE), repo: null, denyPaths: 1, piiPatterns: 2, briefBytes: 500 });
    expect(status.active).toBe(false);                      // the existing migration fields keep their names
  } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
});

test("a command applies the configured policy instead of requiring --policy-free, and the flag is still accepted", async () => {
  const r = rig({ piiPatterns: [SECRET_WORD] });
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = r.base;
  const store = new MemoryStore({ memoryDir: r.base, screen: () => "keep" });
  let clean: string, flagged: string;
  try {
    clean = store.note({ op: "note", project: r.project, scope: "project", tier: "short", kind: "decision", peer: "fixture", text: "a public decision", about: [], source: "person" });
    flagged = store.note({ op: "note", project: r.project, scope: "project", tier: "short", kind: "decision", peer: "fixture", text: `a decision about ${SECRET_WORD}`, about: [], source: "person" });
  } finally { store.close(); }
  try {
    const person = { cwd: r.cwd, env: {}, stdinTTY: true };
    expect(await runCli(["promote", clean], person)).toContain("promoted to long-term");                 // no --policy-free needed
    expect(await runCli(["promote", flagged], person).then(() => "promoted", error => (error as Error).message)).toContain("stays short-term");   // the configured pattern keeps it local
    expect(await runCli(["promote", flagged, "--policy-free"], person).then(() => "promoted", error => (error as Error).message)).toContain("stays short-term");   // the flag opens nothing
  } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
});

test("nothing here touches the person's real home, the network or a model", () => {
  const r = rig();
  expect(existsSync(r.base)).toBe(true);
  expect(r.base.startsWith(tmpdir()) || r.base.includes("amem-config-")).toBe(true);
});

test("project export withholds a note the configured policy declines, like sync and promotion do", async () => {
  const r = rig({ piiPatterns: [SECRET_WORD] });
  const store = new MemoryStore({ memoryDir: r.base, screen: () => "keep" });
  try {
    store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", text: "a public decision", about: [], source: "person" });
    store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", text: `a decision about ${SECRET_WORD}`, about: [], source: "person" });
  } finally { store.close(); }
  const capture = new CaptureStore({ memoryDir: r.base, project: r.project });
  try { capture.append({ project: r.project, agent: "t", event: "PostToolUse", excerpt: "an ordinary capture row" }); } finally { capture.close(); }
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = r.base;
  const out = join(realPath(mkdtempSync(join(tmpdir(), "amem-export-"))), "bundle.jsonl"); roots.push(join(out, ".."));
  try {
    const result = JSON.parse(await runCli(["project", "export", r.project, "--to", out, "--json"], { cwd: r.cwd, env: {}, stdinTTY: false })) as { counts: { curated: number }; withheld: number; file: string };
    expect(result.counts.curated).toBe(1); expect(result.withheld).toBeGreaterThanOrEqual(1);
    const { readFileSync } = await import("node:fs");
    const bundle = readFileSync(result.file, "utf8");
    expect(bundle).toContain("a public decision"); expect(bundle).not.toContain(SECRET_WORD);
  } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
});

// ---- claude review round 1 on #416 ----

const TAGS = [["<private>", "</private>"], ["<PRIVATE>", "</PRIVATE>"], ['<private class="x">', "</private>"], ["< private>", "</ private>"], ["<private >", "</private >"]] as const;

test("<private> tag variants: attributes, whitespace and case are all tags; <private/> opens a span; <privateer> is not a tag", async () => {
  const { stripPrivateSpans, stripPrivateDeep } = await import("../src/memory/private-spans.ts");
  for (const [open, close] of TAGS) expect(stripPrivateSpans(`a ${open}hidden${close} z`), open).toBe("a  z");
  expect(stripPrivateSpans("a <private/> hidden rest")).toBe("a ");
  expect(stripPrivateSpans('a <private class="x"/> hidden rest')).toBe("a ");
  expect(stripPrivateSpans("a <privateer>kept</privateer> <privates>kept</privates>")).toBe("a <privateer>kept</privateer> <privates>kept</privates>");
  expect(stripPrivateSpans("a </private> stray")).toBe("a </private> stray");
  expect(stripPrivateDeep({ t: "x <private>y</private>", n: 3, list: ["p <private>q</private>"], deep: { u: "<private>v</private>w" } })).toEqual({ t: "x ", n: 3, list: ["p "], deep: { u: "w" } });
});

test("<private> is stripped at every write boundary, not only capture: candidate, work list, note, goal, promotion and import", async () => {
  const { CandidateStore } = await import("../src/memory/candidates.ts");
  const { WorkListStore } = await import("../src/memory/work-lists.ts");
  const { readFileSync, readdirSync } = await import("node:fs");
  const SECRET = "hidden-plan-delta";
  const r = rig();
  const logs = () => { const out: string[] = []; for (const sub of ["log", "local"]) { try { for (const f of readdirSync(join(r.base, sub))) out.push(readFileSync(join(r.base, sub, f), "utf8")); } catch { /* absent */ } } return out.join("\n"); };
  // the MCP candidate and work-list tools an agent calls
  const mcp = createMemoryMcp({ cwd: r.cwd, base: r.base });
  try {
    const id = (await mcp.tools.amem_remember!({ text: `public start <private>${SECRET}</private> public end`, title: `title <private>${SECRET}</private>` })) as { id: string };
    await mcp.tools.amem_work_state_write!({ list: "queue", fields: { task: `work <private>${SECRET}</private> item`, status: "doing" } });
    const c = new CandidateStore({ memoryDir: r.base });
    try { const got = c.get(id.id, r.project); expect(JSON.stringify(got)).not.toContain(SECRET); expect(JSON.stringify(got)).toContain("public start"); } finally { c.close(); }
    const work = JSON.stringify(await mcp.tools.amem_work_state_read!({ list: "queue" }));
    expect(work).not.toContain(SECRET); expect(work).toContain("item");
  } finally { mcp.close(); }
  // notes, goals and import through the store, the CLI's own boundary
  const store = new MemoryStore({ memoryDir: r.base, screen: () => "keep" });
  try {
    store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "decision", peer: "p", text: `note <private>${SECRET}</private> body`, title: `t <private>${SECRET}</private>`, about: [], source: "person" });
    store.goal({ project: r.project, scope: "project", title: `goal <private>${SECRET}</private> title`, milestones: [`m <private>${SECRET}</private>`], dependsOn: [], actor: "user" });
    store.importNote({ op: "note", project: r.project, scope: "project", tier: "long", kind: "finding", peer: "p", text: `imported <private>${SECRET}</private> text`, about: [], source: "claude-mem" }, "2026-10-01T00:00:00.000Z");
    store.importNote({ op: "note", project: r.project, scope: "project", tier: "long", kind: "finding", peer: "p", text: `imported <private>${SECRET}</private> text`, about: [], source: "claude-mem" }, "2026-10-01T00:00:00.000Z");   // idempotent: the stripped text still matches itself
    expect(store.list({ project: r.project }).filter(v => v.source === "claude-mem")).toHaveLength(1);
    expect(JSON.stringify(store.list({ project: r.project }))).not.toContain(SECRET);
    expect(JSON.stringify(store.goals())).not.toContain(SECRET);
  } finally { store.close(); }
  expect(logs()).not.toContain(SECRET); expect(logs()).toContain("note  body");
  const wl = new WorkListStore({ base: r.base, project: r.project, policy: () => true });
  try { await wl.write("direct", { task: `direct <private>${SECRET}</private> write` }); expect(JSON.stringify(await wl.read("direct"))).not.toContain(SECRET); } finally { wl.close(); }
});

test("a repository .amem/config reaches a stored capture row: its excerpt cap, path cap, deny paths and PII patterns apply through CaptureStore and the hook staging path", async () => {
  const r = rig({ excerptBytes: 500 });
  r.repoConfig({ excerptBytes: 30, capturePaths: 1, denyPaths: ["repo-private"], piiPatterns: ["repo-codename"] });
  const capture = new CaptureStore({ memoryDir: r.base, project: r.project, cwd: r.cwd });
  try {
    capture.append({ project: r.project, agent: "t", event: "PostToolUse", excerpt: "y".repeat(200), paths: ["repo-private/a.ts", "src/a.ts", "src/b.ts"] });
    capture.append({ project: r.project, agent: "t", event: "PostToolUse", excerpt: "about repo-codename today", paths: [] });
    const rows = capture.rows({ project: r.project });
    const capped = rows.find(row => row.excerpt.startsWith("yyy"))!;
    expect(capped.excerpt.length).toBe(30); expect(capped.paths).toEqual(["src/a.ts"]);
    expect(JSON.stringify(rows)).not.toContain("repo-private"); expect(JSON.stringify(rows)).not.toContain("repo-codename");
  } finally { capture.close(); }
  // Without the working directory only the machine file applies (the same store sees 500, not 30).
  const bare = new CaptureStore({ memoryDir: r.base, project: r.project });
  try { bare.append({ project: r.project, agent: "t", event: "PostToolUse", excerpt: "z".repeat(200) }); expect(bare.rows({ project: r.project }).find(row => row.excerpt.startsWith("zzz"))!.excerpt.length).toBe(200); } finally { bare.close(); }
  // The hook staging path stages the repository's narrowing too.
  const { stageHookCapture, drainHookCaptures } = await import("../src/hook-spool.ts");
  const options = { cwd: r.cwd, base: r.base };
  const staged = await stageHookCapture("UserPromptSubmit", { hook_event_name: "UserPromptSubmit", cwd: r.cwd, prompt: "w".repeat(200) }, options);
  expect(staged).toBeDefined();
  // Read the spooled record itself: the drain re-normalizes and the store caps again, so only the record shows what staging did.
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = join(r.base, "hook-spool");
  const staged_ = readdirSync(dir, { recursive: true }).map(String).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(dir, name), "utf8")) as { capture: { excerpt: string } });
  expect(staged_.map(record => record.capture.excerpt.length)).toEqual([30]);
  const out = new CaptureStore({ memoryDir: r.base, project: r.project, cwd: r.cwd });
  try {
    await drainHookCaptures({ ...options, project: r.project }, (input, receipt) => out.append(input, { receipt }));
    expect(out.rows({ project: r.project }).filter(row => row.excerpt.startsWith("www")).every(row => row.excerpt.length === 30)).toBe(true);
  } finally { out.close(); }
});

test("a library caller can tighten the configured capture caps but never loosen them", () => {
  const r = rig({ excerptBytes: 40, capturePaths: 2 });
  const tighter = new CaptureStore({ memoryDir: r.base, project: r.project, excerptBytes: 10, capturePaths: 1 });
  try {
    tighter.append({ project: r.project, agent: "t", event: "PostToolUse", excerpt: "a".repeat(100), paths: ["p1", "p2", "p3"] });
    const row = tighter.rows({ project: r.project })[0]!; expect(row.excerpt.length).toBe(10); expect(row.paths).toEqual(["p1"]);
  } finally { tighter.close(); }
  const looser = new CaptureStore({ memoryDir: r.base, project: r.project, excerptBytes: 1500, capturePaths: 30 });
  try {
    looser.append({ project: r.project, agent: "t", event: "PostToolUse", excerpt: "b".repeat(100), paths: ["q1", "q2", "q3", "q4"] });
    const row = looser.rows({ project: r.project }).find(x => x.excerpt.startsWith("bbb"))!; expect(row.excerpt.length).toBe(40); expect(row.paths).toEqual(["q1", "q2"]);
  } finally { looser.close(); }
});

test("sync screens every row kind that carries text: a goal's title and milestones, not only notes", async () => {
  const remote = join(realPath(mkdtempSync(join(tmpdir(), "amem-config-remote-"))), "remote.git"); roots.push(join(remote, ".."));
  expect(Bun.spawnSync(["git", "init", "-q", "--bare", remote]).exitCode).toBe(0);
  const r = rig();                                    // no pattern yet: a goal is written under no configured policy
  const store = new MemoryStore({ memoryDir: r.base, screen: () => "keep" });
  try {
    const titled = store.goal({ project: r.project, scope: "project", title: `plan for ${SECRET_WORD}`, milestones: ["ship"], dependsOn: [], actor: "user" });
    const milestone = store.goal({ project: r.project, scope: "project", title: "an ordinary goal", milestones: [`talk to ${SECRET_WORD} owner`], dependsOn: [], actor: "user" });
    writeFileSync(join(r.base, CONFIG_FILE), JSON.stringify({ piiPatterns: [SECRET_WORD] }));   // the pattern is added afterwards
    const refused = await syncMemory(store, { remote, ...privately });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(titled.slice(0, 8)); expect(refused.error).toContain(milestone.slice(0, 8)); expect(refused.error).not.toContain(SECRET_WORD);
    writeFileSync(join(r.base, CONFIG_FILE), JSON.stringify({}));
    expect(await syncMemory(store, { remote, ...privately })).toMatchObject({ ok: true });      // with the pattern gone the same goals sync
  } finally { store.close(); }
});

test("a malformed repository configuration fails closed: it disables the MCP server rather than serving unscreened", () => {
  const r = rig(); r.repoConfig({ unknownKey: 1 });
  expect(() => createMemoryMcp({ cwd: r.cwd, base: r.base })).toThrow(repoConfigPath(r.cwd));
});

test("a host passing names gets its own name in every usage line, including the commands that fall through to the usage text", async () => {
  const { rawMemoryCommand, rawGoalCommand } = await import("../src/memory/commands.ts");
  const r = rig(); const store = new MemoryStore({ memoryDir: r.base });
  const names = { memory: "ahub memory", goal: "ahub goal" };
  const mem = (args: string[]) => rawMemoryCommand(args, r.cwd, { open: () => store, store, readable: rows => rows, importPolicy: () => () => false, project: r.project, names }).then(() => "", e => (e as Error).message);
  const goal = (args: string[]) => rawGoalCommand(args, r.cwd, { open: () => store, store, clean: () => true, project: r.project, names }).then(() => "", e => (e as Error).message);
  try {
    for (const args of [["promote"], ["demote"], ["forget"], ["nonsense"], ["supersede", "a"], ["show"], ["graph"], ["sync", "x"]]) { const m = await mem(args); expect(m, args.join(" ")).toContain("ahub memory"); expect(m, args.join(" ")).not.toContain("usage: amem"); expect(m).not.toContain("${"); }
    for (const args of [["new"], ["nonsense"], ["link", "x"]]) { const m = await goal(args); expect(m, args.join(" ")).not.toContain("usage: amem"); expect(m).not.toContain("${"); }
    expect(await goal(["nonsense"])).toContain("ahub goal");
  } finally { store.close(); }
});

test("<private> in a work-list NAME is never stored: MCP write, direct write, read lookup and claude-mem import share the boundary", async () => {
  const { WorkListStore } = await import("../src/memory/work-lists.ts");
  const { readFileSync, readdirSync } = await import("node:fs");
  const HID = "hid-list-name";
  const r = rig();
  const mcp = createMemoryMcp({ cwd: r.cwd, base: r.base });
  try {
    await mcp.tools.amem_work_state_write!({ list: `queue <private>${HID}</private>`, fields: { task: "t", status: "doing" } });
    expect(JSON.stringify(await mcp.tools.amem_work_state_read!({}))).not.toContain(HID);
    expect(JSON.stringify(await mcp.tools.amem_work_state_read!({ list: "queue" }))).toContain('"queue"');
    // A name that is only a private span names nothing: refused, not stored as an empty list.
    await expect(mcp.tools.amem_work_state_write!({ list: `<private>${HID}</private>`, fields: { task: "t" } })).rejects.toThrow();
  } finally { mcp.close(); }
  const wl = new WorkListStore({ base: r.base, project: r.project, policy: () => true });
  try {
    await wl.write(`direct <private>${HID}</private> list`, { task: "d" }, { source: "claude-mem/work_state", id: "7", machine: "m1", at: 5 });   // the import path passes list_name unchanged
    expect(JSON.stringify(await wl.read(undefined, true))).not.toContain(HID);
    expect((await wl.read(`direct <private>${HID}</private> list`, true)).length).toBeGreaterThan(0);   // a read with the same name finds what the write stored
  } finally { wl.close(); }
  const files: string[] = [];
  const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.(jsonl|json)$/.test(e.name)) files.push(readFileSync(f, "utf8")); } };
  walk(r.base);
  expect(files.join("\n")).not.toContain(HID);
});
