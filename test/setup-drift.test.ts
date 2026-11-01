import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SetupTarget } from "../src/setup.ts";
import { readSetupDrift } from "../src/setup-drift.ts";
import { resolveSetupPaths } from "../src/setup-paths.ts";
import { HOOK_EVENTS } from "../src/hook-contract.ts";
import { doctorReport } from "../src/memory/doctor.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });

function put(file: string, contents: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, contents); chmodSync(file, mode);
}
const encoded = (contents: string | null, mode = 0o600) => ({ bytes: contents === null ? null : Buffer.from(contents).toString("base64"), mode });
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture(extra: Record<string, string | undefined> = {}) {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-setup-drift-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const userHome = join(root, "user home"); mkdirSync(userHome, { recursive: true });
  const memory = join(root, "memory"), env = { HOME: userHome, AMEM_HOME: memory, ...extra };
  const resolved = resolveSetupPaths(env);
  const bun = join(root, "runtime", "bun"), entry = join(root, "installed package", "bin", "amem.js");
  return { root, userHome, memory, env, paths: resolved.paths, legacyPaths: resolved.legacyPaths, bun, entry };
}

function receipt(f: ReturnType<typeof fixture>, target: SetupTarget, changes: { path: string; before: string | null; after: string | null }[], phase = "applied"): void {
  const directory = join(f.memory, "setup"); mkdirSync(directory, { recursive: true });
  const body = {
    version: 1, target, intent: "a".repeat(64), phase,
    changes: changes.map((change, index) => ({ key: `${target}:${index}`, path: change.path, before: encoded(change.before), after: encoded(change.after) })),
  };
  writeFileSync(join(directory, `${target}.json`), json(body));
}

function claudePayload(f: ReturnType<typeof fixture>) {
  const mcp = json({ mcpServers: { amem: { command: f.bun, args: ["--smol", f.entry, "mcp"] } } });
  const launch = `${quote(f.bun)} --smol ${quote(f.entry)}`;
  const hooks = Object.fromEntries(HOOK_EVENTS.map(event => [event, [{ hooks: [{ type: "command", command: `${launch} hook ${event}`, timeout: 1 }] }] ]));
  const settings = json({ hooks });
  return { mcp, settings };
}

function appliedClaude(f: ReturnType<typeof fixture>, options: { beforeSettings?: string | null; currentSettings?: string } = {}) {
  const [mcpPath, settingsPath] = f.paths.claude;
  const { mcp, settings } = claudePayload(f);
  put(mcpPath!, mcp); put(settingsPath!, options.currentSettings ?? settings);
  receipt(f, "claude", [
    { path: mcpPath!, before: null, after: mcp },
    { path: settingsPath!, before: options.beforeSettings ?? null, after: settings },
  ]);
  return { mcpPath: mcpPath!, settingsPath: settingsPath!, mcp, settings };
}

function inspect(f: ReturnType<typeof fixture>) { return readSetupDrift({ home: f.memory, env: f.env }); }
function allText(value: unknown): string { return JSON.stringify(value); }

test("applied Claude MCP and hook registrations report missing entries and return clean when restored", () => {
  const f = fixture(), config = appliedClaude(f);
  expect(inspect(f)).toMatchObject({ status: "ok", checked: 1, entries: [] });

  put(config.settingsPath, json({ hooks: {} }));
  const hookMissing = inspect(f);
  expect(hookMissing.status).toBe("attention");
  expect(hookMissing.entries).toContainEqual(expect.objectContaining({ target: "claude", file: config.settingsPath, entry: "hooks.SessionStart", kind: "drift" }));

  put(config.settingsPath, config.settings);
  put(config.mcpPath, json({ mcpServers: { other: { command: "keep", args: [] } } }));
  const mcpMissing = inspect(f);
  expect(mcpMissing.status).toBe("attention");
  expect(mcpMissing.entries).toContainEqual(expect.objectContaining({ target: "claude", file: config.mcpPath, entry: "mcpServers.amem", kind: "drift" }));

  put(config.mcpPath, config.mcp);
  expect(inspect(f)).toMatchObject({ status: "ok", entries: [] });
});

test("an unchanged pre-existing amem hook is still checked after removal", () => {
  const f = fixture(), { settings } = claudePayload(f);
  const current = json({ permissions: { allow: ["Read"] } });
  const config = appliedClaude(f, { beforeSettings: settings, currentSettings: current });
  const report = inspect(f);
  expect(report.status).toBe("attention");
  expect(report.entries.some(row => row.file === config.settingsPath && row.entry === "hooks.SessionStart" && row.kind === "drift")).toBe(true);
});

test("managed Claude hook identity includes handler type, matcher, and timeout", () => {
  for (const change of ["type", "matcher", "timeout"] as const) {
    const f = fixture(), config = appliedClaude(f), live = JSON.parse(config.settings);
    const group = live.hooks.SessionStart[0], handler = group.hooks[0];
    if (change === "type") handler.type = "prompt";
    if (change === "matcher") group.matcher = "Bash";
    if (change === "timeout") handler.timeout = 30;
    put(config.settingsPath, json(live));
    const report = inspect(f);
    expect(report.status, change).toBe("attention");
    expect(report.entries.some(row => row.entry === "hooks.SessionStart" && row.kind === "drift"), change).toBe(true);
  }
});

test("normal Claude manifests match the resolver and Orca legacy paths are reported without opening them", () => {
  const normal = fixture(), normalConfig = appliedClaude(normal);
  expect(inspect(normal)).toMatchObject({ status: "ok", entries: [] });
  expect(normalConfig.settingsPath).toBe(join(normal.userHome, ".claude", "settings.json"));

  const orcaData = join(normal.root, "orca data"), profile = join(orcaData, "claude-profiles", "profile-a", "home");
  const f = fixture({ ORCA_USER_DATA_PATH: orcaData, CLAUDE_CONFIG_DIR: profile });
  const redirected = appliedClaude(f);
  expect(redirected.settingsPath).toBe(join(f.userHome, ".claude", "settings.json"));
  const declaredLegacy = f.legacyPaths.claude[1]!;
  const canary = join(f.root, "private config canary"); put(canary, "PRIVATE_CONFIG_CANARY");
  mkdirSync(dirname(declaredLegacy), { recursive: true }); symlinkSync(canary, declaredLegacy);
  const [mcpChange, hooksChange] = JSON.parse(readFileSync(join(f.memory, "setup", "claude.json"), "utf8")).changes;
  hooksChange.path = declaredLegacy;
  writeFileSync(join(f.memory, "setup", "claude.json"), json({ version: 1, target: "claude", intent: "a".repeat(64), phase: "applied", changes: [mcpChange, hooksChange] }));

  const mismatch = inspect(f);
  expect(mismatch.status).toBe("attention");
  expect(mismatch.entries).toContainEqual(expect.objectContaining({ target: "claude", file: declaredLegacy, expectedFile: redirected.settingsPath, kind: "drift" }));
  expect(mismatch.entries.every(row => row.kind !== "unavailable")).toBe(true);
  expect(allText(mismatch)).not.toContain("PRIVATE_CONFIG_CANARY");
});

test("unsafe and malformed setup inputs fail closed without exposing configuration text", () => {
  const secret = "PRIVATE_CONFIG_CANARY_48D1";
  const symlinked = fixture(), symlinkConfig = appliedClaude(symlinked), target = join(symlinked.root, "private source");
  put(target, secret); rmSync(symlinkConfig.settingsPath); symlinkSync(target, symlinkConfig.settingsPath);
  const symlinkReport = inspect(symlinked);
  expect(symlinkReport.status).toBe("unavailable"); expect(allText(symlinkReport)).not.toContain(secret);

  const malformedConfig = fixture(), malformed = appliedClaude(malformedConfig);
  put(malformed.settingsPath, `{"token":"${secret}`);
  const malformedConfigReport = inspect(malformedConfig);
  expect(malformedConfigReport.status).toBe("unavailable"); expect(allText(malformedConfigReport)).not.toContain(secret);

  const malformedReceipt = fixture();
  const receiptDir = join(malformedReceipt.memory, "setup"); mkdirSync(receiptDir, { recursive: true });
  put(join(receiptDir, "claude.json"), `{"target":"claude","private":"${secret}"`);
  const malformedReceiptReport = inspect(malformedReceipt);
  expect(malformedReceiptReport.status).toBe("unavailable"); expect(allText(malformedReceiptReport)).not.toContain(secret);
});

test("Codex missing trust state is review-needed; a present state record is left byte-for-byte untouched", () => {
  const f = fixture(), [configPath, hooksPath] = f.paths.codex;
  const command = `${quote(f.bun)} --smol ${quote(f.entry)} ingest codex --json`;
  const config = Bun.TOML.stringify({ mcp_servers: { amem: { command: f.bun, args: ["--smol", f.entry, "mcp"] } } });
  const hookFile = json({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command, timeout: 3 }] }] } });
  put(configPath!, config); put(hooksPath!, hookFile);
  receipt(f, "codex", [
    { path: configPath!, before: null, after: config },
    { path: hooksPath!, before: null, after: hookFile },
  ]);
  const beforeMissing = readFileSync(configPath!);
  const missing = inspect(f);
  expect(missing.status).toBe("attention");
  expect(missing.entries.some(row => row.kind === "review-needed" && row.entry.includes("hooks.state") && row.reason.includes("untrusted"))).toBe(true);
  expect(missing.entries.find(row => row.kind === "review-needed")?.file).toBe(configPath);
  expect(readFileSync(configPath!)).toEqual(beforeMissing);

  const current = Bun.TOML.parse(readFileSync(configPath!, "utf8")) as Record<string, any>;
  const key = `${hooksPath}:session_end:0:0`;
  current.hooks = { state: { [key]: { trusted_hash: "fixture-only" } } };
  put(configPath!, Bun.TOML.stringify(current));
  const before = readFileSync(configPath!);
  const present = inspect(f);
  expect(present.status).toBe("ok");
  expect(present.entries.some(row => row.kind === "review-needed")).toBe(false);
  expect(readFileSync(configPath!)).toEqual(before);
});

test("Orca Codex trust is checked in the active runtime copy, without changing source or trust files", () => {
  const f = fixture(), data = join(f.root, "orca data"), managed = join(data, "codex-accounts", "id", "home");
  Object.assign(f.env, { ORCA_USER_DATA_PATH: data, CODEX_HOME: managed });
  const resolved = resolveSetupPaths(f.env), [configPath, hooksPath] = resolved.paths.codex;
  const [runtimeConfig, runtimeHooks] = resolved.legacyPaths.codex;
  const command = `${quote(f.bun)} --smol ${quote(f.entry)} ingest codex --json`;
  const config = Bun.TOML.stringify({ mcp_servers: { amem: { command: f.bun, args: ["--smol", f.entry, "mcp"] } } });
  const handler = { hooks: [{ type: "command", command, timeout: 3 }] }, hookFile = json({ hooks: { SessionEnd: [handler] } });
  put(configPath!, config); put(hooksPath!, hookFile);
  receipt(f, "codex", [{ path: configPath!, before: null, after: config }, { path: hooksPath!, before: null, after: hookFile }]);
  expect(inspect(f).entries.some(row => row.kind === "review-needed" && row.file === runtimeHooks)).toBe(true);
  put(runtimeHooks!, json({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo unrelated", timeout: 3 }] }, handler] } }));
  const key = `${runtimeHooks}:session_end:1:0`;
  put(runtimeConfig!, Bun.TOML.stringify({ hooks: { state: { [key]: { trusted_hash: "fixture-only" } } } }));
  const sourceBefore = readFileSync(configPath!), trustBefore = readFileSync(runtimeConfig!);
  expect(inspect(f)).toMatchObject({ status: "ok", entries: [] });
  expect(readFileSync(configPath!)).toEqual(sourceBefore); expect(readFileSync(runtimeConfig!)).toEqual(trustBefore);
  put(runtimeConfig!, "");
  const missing = inspect(f);
  expect(missing.entries.some(row => row.kind === "review-needed" && row.file === runtimeConfig && row.entry.includes(key))).toBe(true);
  expect(readFileSync(runtimeConfig!, "utf8")).toBe("");
});

test("target-specific MCP registration names are checked for Gemini, Jcode, and OpenCode", () => {
  const cases: { target: SetupTarget; make: (f: ReturnType<typeof fixture>) => string; missingName: string }[] = [
    { target: "gemini", make: f => json({ mcpServers: { amem: { command: f.bun, args: ["--smol", f.entry, "mcp"] } } }), missingName: "mcpServers.amem" },
    { target: "jcode", make: f => json({ servers: { amem: { command: f.bun, args: ["--smol", f.entry, "mcp"] } } }), missingName: "servers.amem" },
    { target: "opencode", make: f => json({ mcp: { amem: { type: "local", command: [f.bun, "--smol", f.entry, "mcp"], enabled: true } } }), missingName: "mcp.amem" },
  ];
  for (const item of cases) {
    const f = fixture(), path = f.paths[item.target][0]!, after = item.make(f);
    put(path, after); receipt(f, item.target, [{ path, before: null, after }]);
    expect(inspect(f).status, item.target).toBe("ok");
    put(path, "{}");
    const report = inspect(f);
    expect(report.status, item.target).toBe("attention");
    expect(report.entries.some(row => row.entry === item.missingName), item.target).toBe(true);
  }
});

test("prepared receipts do not claim that setup was applied", () => {
  const f = fixture(), [mcpPath, settingsPath] = f.paths.claude;
  receipt(f, "claude", [
    { path: mcpPath!, before: null, after: "{}\n" },
    { path: settingsPath!, before: null, after: "{}\n" },
  ], "prepared");
  expect(inspect(f)).toMatchObject({ status: "skipped", checked: 0, entries: [] });
});

test("doctor surfaces setup drift and leaves the memory home unchanged", async () => {
  const f = fixture(), config = appliedClaude(f);
  put(config.settingsPath, json({ hooks: {} }));
  const cwd = join(f.root, "repo"); mkdirSync(cwd, { recursive: true });
  const saved = { HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  const globalConfig = join(f.root, "gitconfig");
  process.env.HOME = f.userHome; process.env.GIT_CONFIG_NOSYSTEM = "1"; process.env.GIT_CONFIG_GLOBAL = globalConfig; put(globalConfig, "");
  try {
    expect(memoryGitSync(["init", "-q", cwd], { encoding: "utf8" }).status).toBe(0);
    const before = tree(f.memory);
    const report = await doctorReport({
      home: f.memory, homeSource: "test", cwd, project: memoryProjectKey(cwd), aliases: [], now: Date.now(), env: f.env,
      openCurated: base => new MemoryStore({ memoryDir: base, deferPromotions: true }),
    });
    expect(report.sections.setup).toBeDefined();
    expect(report.sections.setup!.status).toBe("attention");
    expect((report.sections.setup!.entries as { entry: string }[]).some(row => row.entry === "hooks.SessionStart")).toBe(true);
    expect(tree(f.memory)).toEqual(before);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.GIT_CONFIG_NOSYSTEM;
    if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL;
  }
});

function tree(root: string): Record<string, string> {
  const output: Record<string, string> = {};
  const visit = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name, path = join(directory, name), stat = lstatSync(path);
      if (stat.isDirectory()) { output[relative] = "directory"; visit(path, relative); }
      else if (stat.isSymbolicLink()) output[relative] = `link:${readlinkSync(path)}`;
      else output[relative] = `${stat.mode & 0o777}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  };
  if (existsSync(root)) visit(root);
  return output;
}
