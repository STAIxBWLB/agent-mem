import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { delimiter, dirname, join } from "node:path";
import { realPath } from "../src/memory/platform.ts";
import { allowlistedSmokeEnv, assertHookEvidence, assertHookMetric, assertHomeUnchanged, assertInstalledAlias, assertInstalledEntry, assertInstalledModule, assertMcpResult, assertNoHubBranding, assertPostToolUseOutput, assertSetupPreview, assertSmokeCliArgs, createReapWaiter, probeSmokeLauncher, snapshotPrivateHome } from "../scripts/smoke-installed-package.ts";
const HOME = "/isolated/home", APP = join(HOME, "app"), ROOT = join(APP, "node_modules", "@staix", "agent-mem"), ENTRY = join(ROOT, "bin", "amem.js"), CHECKOUT = "/workspace/agent-mem", TMP = join(HOME, "tmp");
const plan = () => ({ mode: "preview", targets: ["claude", "codex", "kimi", "pi"], actions: ["claude", "codex", "kimi", "pi"].map(target => ({ target, files: [join(HOME, "clients", target, "config")], receipt: join(HOME, "memory", "setup", `${target}.json`), registration: target === "kimi" ? null : [target, "mcp", "add", "amem", "--", "/runtime/bun", ENTRY, "mcp"], ...(target === "kimi" ? { hooks: [{ command: `bun ${ENTRY} ingest kimi` }] } : {}) })) });

test("installed smoke guards require the artifact bin outside checkout and child TMPDIR", () => {
  expect(() => assertInstalledEntry(ENTRY, ROOT, CHECKOUT, TMP)).not.toThrow();
  for (const entry of [join(CHECKOUT, "bin", "amem.js"), join(ROOT, "..", "fallback", "bin", "amem.js"), join(ROOT, "src", "cli.ts")]) expect(() => assertInstalledEntry(entry, ROOT, CHECKOUT, TMP)).toThrow();
  expect(() => assertInstalledEntry(join(TMP, "package", "bin", "amem.js"), join(TMP, "package"), CHECKOUT, TMP)).toThrow();
  expect(() => assertInstalledEntry("relative/bin/amem.js", ROOT, CHECKOUT, TMP)).toThrow();
  expect(() => assertInstalledEntry(join(CHECKOUT, "bin", "amem.js"), CHECKOUT, CHECKOUT, TMP)).toThrow();
});
test("installed smoke public API resolution refuses checkout fallback and sibling packages", () => {
  expect(() => assertInstalledModule(join(ROOT, "src", "index.ts"), ROOT, CHECKOUT)).not.toThrow();
  expect(() => assertInstalledModule(join(CHECKOUT, "src", "index.ts"), CHECKOUT, CHECKOUT)).toThrow();
  for (const file of [join(CHECKOUT, "src", "index.ts"), join(ROOT, "..", "other", "index.ts"), "relative/index.ts"]) expect(() => assertInstalledModule(file, ROOT, CHECKOUT)).toThrow();
});
test("installed smoke child environment is an allowlist with isolated config/cache/tmp and no inherited authority", () => {
  const env = allowlistedSmokeEnv(HOME, "/runtime/bin:/usr/bin:/bin"); expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe("0");
  expect(env.HOME).toBe(HOME); expect(env.TMPDIR).toBe(TMP); expect(env.AMEM_HOME).toBe(join(HOME, "memory")); expect(env.XDG_CONFIG_HOME).toBe(join(HOME, ".config")); expect(env.BUN_INSTALL_CACHE_DIR).toBe(join(HOME, ".cache", "bun"));
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "AMEM_HOOK_BOOT_AT", "AGENTHUB_HOME", "AGENTHUB_PEER_ID", "CLAUDECODE", "CODEX_THREAD_ID"]) expect(Object.hasOwn(env, key)).toBe(false);
  expect(join(HOME, "app").startsWith(env.TMPDIR! + "/")).toBe(false);
});
test("installed smoke CLI whitelist permits setup preview and forbids every mutation/native-client shortcut", () => {
  for (const args of [["--help"], ["--version"], ["mcp"], ["setup", "all"], ["hook", "PostToolUse"]]) expect(() => assertSmokeCliArgs(args)).not.toThrow();
  for (const args of [["setup", "all", "--apply"], ["setup", "all", "--undo"], ["setup", "claude"], ["note", "add"], ["hook", "SessionStart"], ["claude", "mcp", "add"], []]) expect(() => assertSmokeCliArgs(args)).toThrow();
});
test("installed smoke rejects legacy output while retaining normal compatible home terminology", () => {
  expect(() => assertNoHubBranding("amem setup; ~/.agenthub/memory")).not.toThrow();
  for (const text of ["usage: ahub memory", "Try AHUB setup", '{"notice":"ahub"}']) expect(() => assertNoHubBranding(text)).toThrow("legacy host command");
});
test("installed smoke setup validation rejects apply, missing targets and escaped config paths", () => {
  expect(assertSetupPreview(plan(), HOME, ENTRY)).toHaveLength(8);
  expect(() => assertSetupPreview({ ...plan(), mode: "apply" }, HOME, ENTRY)).toThrow();
  expect(() => assertSetupPreview({ ...plan(), actions: plan().actions.slice(1) }, HOME, ENTRY)).toThrow();
  const outside = plan(); outside.actions[0]!.files = ["/real-user/config"];
  expect(() => assertSetupPreview(outside, HOME, ENTRY)).toThrow("escaped");
});
test("installed smoke MCP validation needs matching server version and the exact public seeded evidence", () => {
  const id = "a".repeat(32), project = "project", initialized = { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "amem", version: "0.6.0" } } };
  const result = (hits: unknown[]) => JSON.stringify(initialized) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ hits }) }] } }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "amem_search", description: "Search public memory" }, { name: "future_additive_tool", description: "An additive tool" }] } }) + "\n";
  const hit = { source: "curated", evidence: true, view: { id, project, text: "installedpublicsmokeneedle" } };
  expect(() => assertMcpResult(result([hit]), "0.6.0", id, project)).not.toThrow();
  expect(() => assertMcpResult(result([hit]), "wrong-version", id, project)).toThrow();
  for (const hits of [[], [{ ...hit, source: "capture", evidence: false }], [{ ...hit, view: { ...hit.view, project: "other" } }], [{ ...hit, view: { ...hit.view, id: "b".repeat(32) } }], [hit, { ...hit, view: { ...hit.view, id: "b".repeat(32) } }]]) expect(() => assertMcpResult(result(hits), "0.6.0", id, project)).toThrow();
});
test("installed smoke requires native hook load evidence without substituting for separate timing gates", () => {
  expect(() => assertHookMetric("", JSON.stringify({ kind: "hook", at: "2026-10-24T00:00:00.000Z", wallMs: 1, rssMB: 1 }) + "\n")).not.toThrow();
  for (const value of ["", '{}\n', JSON.stringify({ kind: "search", at: "2026-10-24T00:00:00.000Z", wallMs: 1, rssMB: 1 }), JSON.stringify({ kind: "hook", at: "invalid", wallMs: 1, rssMB: 1 })]) expect(() => assertHookMetric("", value)).toThrow();
});
test("installed executable alias must come from app .bin and resolve exactly to the packaged entry", () => {
  const bin = join(APP, "node_modules", ".bin"), alias = join(bin, "amem");
  expect(() => assertInstalledAlias(alias, ENTRY, ENTRY, bin)).not.toThrow();
  expect(() => assertInstalledAlias("/usr/local/bin/amem", ENTRY, ENTRY, bin)).toThrow();
  expect(() => assertInstalledAlias(alias, join(CHECKOUT, "bin", "amem.js"), ENTRY, bin)).toThrow();
});
test("native PostToolUse stays quiet and cannot emit context or control output", () => {
  expect(() => assertPostToolUseOutput("")).not.toThrow(); expect(() => assertPostToolUseOutput(" \n")).not.toThrow();
  for (const output of ['{"decision":"allow"}', '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"unexpected"}}', "diagnostic output"]) expect(() => assertPostToolUseOutput(output)).toThrow("reserved for SessionStart");
});
test("owned Bun eval launcher forwards the fixed argv after -- and reaps without a package install", async () => {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-smoke-argv-"))); mkdirSync(join(home, "tmp"));
  try {
    const env = allowlistedSmokeEnv(home, [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter));
    expect(await probeSmokeLauncher(home, env)).toEqual(["value with spaces", "--literal-option", "*"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 10000);
test("branding guard covers underscore and punctuation boundaries and decoded tool descriptions", () => {
  for (const value of ["mcp_ahub_memory", "_AHUB_", "tool-ahub-search", "ahub/commands"]) expect(() => assertNoHubBranding(value)).toThrow();
  expect(() => assertNoHubBranding("longahubidentifier")).not.toThrow();
  const id = "a".repeat(32), frames = [
    { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "amem", version: "0.6.0" } } },
    { jsonrpc: "2.0", id: 3, result: { tools: [{ name: "amem_search", description: "Use _ahub_ for results" }] } },
    { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ hits: [{ source: "curated", evidence: true, view: { id, project: "p", text: "installedpublicsmokeneedle" } }] }) }] } },
  ];
  expect(() => assertMcpResult(frames.map(row => JSON.stringify(row)).join("\n"), "0.6.0", id, "p")).toThrow("legacy host command");
});
test("preview must register the physical installed entry and keep Kimi ingest on that entry", () => {
  const stale = plan(); stale.actions[0]!.registration = ["claude", "mcp", "add", "/old/version/bin/amem.js"];
  expect(() => assertSetupPreview(stale, HOME, ENTRY)).toThrow("stale package entry");
  const kimi = plan(); kimi.actions[2]!.hooks = [{ command: "bun /old/version/bin/amem.js ingest kimi" }];
  expect(() => assertSetupPreview(kimi, HOME, ENTRY)).toThrow("stale package entry");
});
test("whole HOME snapshot detects undeclared hidden files and unlisted setup locks/receipts", () => {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-home-snapshot-")));
  try {
    writeFileSync(join(home, "keep"), "aa", { mode: 0o600 }); symlinkSync("/nonexistent-outside-home", join(home, "link"));
    const first = snapshotPrivateHome(home); expect(first.find(row => row.path === "link")).toMatchObject({ type: "symlink", link: "/nonexistent-outside-home" }); expect(() => assertHomeUnchanged(first, snapshotPrivateHome(home))).not.toThrow();
    for (const name of [".undeclared", "memory/setup/setup.lock", "memory/setup/claude.json"]) {
      const before = snapshotPrivateHome(home), file = join(home, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "unexpected", { mode: 0o600 });
      expect(() => assertHomeUnchanged(before, snapshotPrivateHome(home))).toThrow("private HOME"); rmSync(file);
    }
    const beforeContent = snapshotPrivateHome(home); writeFileSync(join(home, "keep"), "bb"); expect(() => assertHomeUnchanged(beforeContent, snapshotPrivateHome(home))).toThrow();
    const beforeMode = snapshotPrivateHome(home); chmodSync(join(home, "keep"), 0o640); expect(() => assertHomeUnchanged(beforeMode, snapshotPrivateHome(home))).toThrow();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
const hookMetric = JSON.stringify({ kind: "hook", at: "2026-10-24T00:00:00.000Z", wallMs: 1, rssMB: 1 }) + "\n";
const expectedHook = { project: "project", cwd: "/isolated/project", event: "PostToolUse", agent: "claude", marker: "distinct-hook-marker" };
function hookPending(capacity = false) {
  const cwdHash = createHash("sha256").update(expectedHook.cwd).digest("hex"), scope = "b".repeat(64), nonce = "c".repeat(32);
  return { path: `hook-spool/${capacity ? ".capacity/" : ""}hook-${cwdHash}-${scope}-${nonce}.json`, type: "file", nlink: 1, project: expectedHook.project,
    value: { schema: "agent-mem.hook-capture/v1", cwd: expectedHook.cwd, scope, nonce, capture: { at: "2026-10-24T00:00:00.000Z", agent: expectedHook.agent, event: expectedHook.event, excerpt: expectedHook.marker } } };
}
test("a hook metric alone or an old metric cannot stand in for fresh durable hook evidence", () => {
  const evidence = { rows: [{ project: expectedHook.project, agent: expectedHook.agent, event: expectedHook.event, excerpt: expectedHook.marker }], pending: [] };
  expect(() => assertHookEvidence("", hookMetric, evidence, expectedHook)).not.toThrow();
  expect(() => assertHookEvidence("", hookMetric, { rows: [], pending: [] }, expectedHook)).toThrow("durable");
  expect(() => assertHookEvidence(hookMetric, hookMetric, evidence, expectedHook)).toThrow("exactly one");
  expect(() => assertHookEvidence("", hookMetric + hookMetric, evidence, expectedHook)).toThrow("exactly one");
  expect(() => assertHookEvidence(hookMetric, " " + hookMetric, evidence, expectedHook)).toThrow("history changed");
});
test("hook evidence accepts committed root/capacity pending JSON and refuses wrong event/marker/project or unpublished spool", () => {
  for (const capacity of [false, true]) expect(() => assertHookEvidence("", hookMetric, { rows: [], pending: [hookPending(capacity)] }, expectedHook)).not.toThrow();
  for (const key of ["event", "marker", "project"] as const) {
    const mismatch = { ...expectedHook, [key]: "wrong" };
    expect(() => assertHookEvidence("", hookMetric, { rows: [], pending: [hookPending()] }, mismatch)).toThrow("durable");
    expect(() => assertHookEvidence("", hookMetric, { rows: [{ project: expectedHook.project, agent: expectedHook.agent, event: expectedHook.event, excerpt: expectedHook.marker }], pending: [] }, mismatch)).toThrow("durable");
  }
  for (const path of ["hook-spool/.writing/record.json", "hook-spool/.quarantine/record.json", "elsewhere/record.json"]) expect(() => assertHookEvidence("", hookMetric, { rows: [], pending: [{ ...hookPending(), path }] }, expectedHook)).toThrow("durable");
  expect(() => assertHookEvidence("", hookMetric, { rows: [], pending: [{ ...hookPending(), type: "symlink" }] }, expectedHook)).toThrow("durable");
  const badSchema = hookPending(); badSchema.value.schema = "wrong"; expect(() => assertHookEvidence("", hookMetric, { rows: [], pending: [badSchema] }, expectedHook)).toThrow("durable");
});
test("reap waits are cached and bounded even when the owned close event never resolves", async () => {
  let cleaned = 0; const wait = createReapWaiter(new Promise<void>(() => {}), () => { cleaned++; }, 10), first = wait();
  expect(wait()).toBe(first); await expect(first).rejects.toThrow("not reaped"); await expect(wait()).rejects.toThrow("not reaped"); expect(cleaned).toBe(1);
  let healthy = 0; const done = createReapWaiter(Promise.resolve(), () => { healthy++; }, 10); await done(); expect(done()).toBe(done()); expect(healthy).toBe(0);
});
