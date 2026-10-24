import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { realPath } from "../src/memory/platform.ts";
import { allowlistedSmokeEnv, assertHookMetric, assertInstalledAlias, assertInstalledEntry, assertInstalledModule, assertMcpResult, assertNoHubBranding, assertPostToolUseOutput, assertSetupPreview, assertSmokeCliArgs, probeSmokeLauncher } from "../scripts/smoke-installed-package.ts";
const HOME = "/isolated/home", APP = join(HOME, "app"), ROOT = join(APP, "node_modules", "@staix", "agent-mem"), ENTRY = join(ROOT, "bin", "amem.js"), CHECKOUT = "/workspace/agent-mem", TMP = join(HOME, "tmp");
const plan = () => ({ mode: "preview", targets: ["claude", "codex", "kimi", "pi"], actions: ["claude", "codex", "kimi", "pi"].map(target => ({ target, files: [join(HOME, "clients", target, "config")], receipt: join(HOME, "memory", "setup", `${target}.json`) })) });

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
  const env = allowlistedSmokeEnv(HOME, "/runtime/bin:/usr/bin:/bin");
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
  expect(assertSetupPreview(plan(), HOME)).toHaveLength(8);
  expect(() => assertSetupPreview({ ...plan(), mode: "apply" }, HOME)).toThrow();
  expect(() => assertSetupPreview({ ...plan(), actions: plan().actions.slice(1) }, HOME)).toThrow();
  const outside = plan(); outside.actions[0]!.files = ["/real-user/config"];
  expect(() => assertSetupPreview(outside, HOME)).toThrow("escaped");
});
test("installed smoke MCP validation needs matching server version and the exact public seeded evidence", () => {
  const id = "a".repeat(32), project = "project", initialized = { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "amem", version: "0.6.0" } } };
  const result = (hits: unknown[]) => JSON.stringify(initialized) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ hits }) }] } }) + "\n";
  const hit = { source: "curated", evidence: true, view: { id, project, text: "installedpublicsmokeneedle" } };
  expect(() => assertMcpResult(result([hit]), "0.6.0", id, project)).not.toThrow();
  expect(() => assertMcpResult(result([hit]), "wrong-version", id, project)).toThrow();
  for (const hits of [[], [{ ...hit, source: "capture", evidence: false }], [{ ...hit, view: { ...hit.view, project: "other" } }], [{ ...hit, view: { ...hit.view, id: "b".repeat(32) } }], [hit, { ...hit, view: { ...hit.view, id: "b".repeat(32) } }]]) expect(() => assertMcpResult(result(hits), "0.6.0", id, project)).toThrow();
});
test("installed smoke requires native hook load evidence without substituting for separate timing gates", () => {
  expect(() => assertHookMetric(JSON.stringify({ kind: "hook", at: "2026-10-24T00:00:00.000Z", wallMs: 1, rssMB: 1 }) + "\n")).not.toThrow();
  for (const value of ["", '{}\n', JSON.stringify({ kind: "search", at: "2026-10-24T00:00:00.000Z", wallMs: 1, rssMB: 1 }), JSON.stringify({ kind: "hook", at: "invalid", wallMs: 1, rssMB: 1 })]) expect(() => assertHookMetric(value)).toThrow();
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
