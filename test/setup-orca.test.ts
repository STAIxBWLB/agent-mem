import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applySetup, planSetup, setupPlanText, undoSetup } from "../src/setup.ts";
import { resolveSetupPaths } from "../src/setup-paths.ts";
import { setup202Rig } from "./fakes/setup-202.ts";

const rigs: ReturnType<typeof setup202Rig>[] = [];
afterEach(() => { for (const rig of rigs.splice(0)) rig.close(); });
const rig = () => { const r = setup202Rig(); rigs.push(r); return r; };

for (const target of ["claude", "codex"] as const) test(`Orca ${target} publishes the durable personal source and undo restores exact bytes`, () => {
  const r = rig(), data = join(r.home, "Library", "Application Support", "orca");
  const managed = join(data, target === "claude" ? "claude-profiles" : "codex-accounts", "account", "home");
  r.env[target === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = managed;
  const personal = join(r.home, target === "claude" ? ".claude" : ".codex");
  const source = join(personal, target === "claude" ? "settings.json" : "config.toml");
  const original = target === "claude" ? '{\n\t"unrelated": "keep", "hooks": {}\n}\n' : '# personal bytes\nmodel = "keep"\n[hooks.state.existing]\ntrusted_hash = "user-owned"\n';
  r.put(source, original);
  const managedSettings = join(managed, target === "claude" ? "settings.json" : "config.toml");
  r.put(managedSettings, target === "claude" ? '{"managed":"copy"}\n' : 'model = "managed-copy"\n');
  const beforeManaged = r.text(managedSettings), plan = planSetup(target, "preview", r.options);
  expect(plan.actions[0]!.files).toEqual(target === "claude" ? [join(managed, ".claude.json"), source] : [source, join(personal, "hooks.json")]);
  expect(setupPlanText(plan)).toContain("Orca re-syncs");
  expect(setupPlanText(plan)).toContain(source);
  expect(r.text(source)).toBe(original); expect(r.text(managedSettings)).toBe(beforeManaged); expect(r.calls).toHaveLength(0);
  applySetup(plan, r.options);
  expect(r.text(managedSettings)).toBe(beforeManaged);
  const hookFile = target === "claude" ? source : join(personal, "hooks.json");
  expect(r.text(hookFile)).toContain(target === "claude" ? "SessionStart" : "SessionEnd");
  if (target === "codex") {
    const config = Bun.TOML.parse(r.text(source)) as Record<string, any>;
    expect(config.hooks.state).toEqual({ existing: { trusted_hash: "user-owned" } });
    expect(r.text(hookFile)).not.toContain("trusted_hash");
  }
  expect(applySetup(planSetup(target, "apply", r.options), r.options).unchanged).toEqual([target]);
  undoSetup(planSetup(target, "undo", r.options), r.options);
  expect(r.text(source)).toBe(original); expect(r.text(managedSettings)).toBe(beforeManaged);
  if (target === "codex") expect(existsSync(join(personal, "hooks.json"))).toBe(false);
});

test("Orca custom user-data roots and Codex runtime home redirect, lookalike paths do not", () => {
  const r = rig(), root = join(r.home, "custom Orca data"); r.env.ORCA_USER_DATA_PATH = root;
  for (const suffix of [["codex-accounts", "id", "home"], ["codex-runtime-home", "home"]]) {
    r.env.CODEX_HOME = join(root, ...suffix);
    expect(resolveSetupPaths(r.env).paths.codex).toEqual([join(r.home, ".codex", "config.toml"), join(r.home, ".codex", "hooks.json")]);
  }
  for (const candidate of [join(r.home, "other", "orca", "codex-accounts", "id", "home"), join(root, "codex-accounts", "id", "home", "nested"), join(root, "codex-accounts", "home")]) {
    r.env.CODEX_HOME = candidate;
    expect(resolveSetupPaths(r.env).paths.codex[0]).toBe(join(candidate, "config.toml"));
    expect(resolveSetupPaths(r.env).redirects).toHaveLength(0);
  }
});

for (const target of ["claude", "codex"] as const) test(`old Orca ${target} receipts migrate only their declared redirect and retain personal undo bytes`, () => {
  const r = rig(), root = join(r.home, "Library", "Application Support", "orca"), managed = join(root, target === "claude" ? "claude-profiles" : "codex-accounts", "id", "home");
  r.env[target === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = managed;
  // Simulate the previous writer with a different app data root, so it owns the managed copy.
  r.env.ORCA_USER_DATA_PATH = join(r.home, "other-app-data");
  applySetup(planSetup(target, "apply", r.options), r.options);
  const oldReceipt = JSON.parse(r.text(join(r.home, "memory", "setup", `${target}.json`)));
  expect(oldReceipt.changes[1].path).toBe(join(managed, target === "claude" ? "settings.json" : "hooks.json"));
  const personalFile = join(r.home, target === "claude" ? ".claude" : ".codex", target === "claude" ? "settings.json" : "config.toml");
  const original = target === "claude" ? '{ "personal": "before" }\n' : '# personal before\nmodel="before"\n';
  r.put(personalFile, original); r.env.ORCA_USER_DATA_PATH = root;
  const undo = planSetup(target, "undo", r.options);
  expect(undo.actions[0]!.files).toEqual(oldReceipt.changes.map((row: { path: string }) => row.path));
  applySetup(planSetup(target, "apply", r.options), r.options);
  const migrated = JSON.parse(r.text(join(r.home, "memory", "setup", `${target}.json`)));
  expect(migrated.changes.map((row: { path: string }) => row.path)).toEqual(resolveSetupPaths(r.env).paths[target]);
  undoSetup(planSetup(target, "undo", r.options), r.options);
  expect(r.text(personalFile)).toBe(original);
});

test("ordinary Claude/Codex setup plans and file bytes match the pre-redirect golden", () => {
  const golden = JSON.parse(readFileSync(new URL("./fixtures/setup-non-orca-202.json", import.meta.url), "utf8"));
  for (const target of ["claude", "codex"] as const) for (const custom of [false, true]) {
    const r = rig();
    if (custom) r.env[target === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = join(r.home, "custom config");
    const plan = planSetup(target, "preview", r.options), normalized = JSON.parse(r.normalize(JSON.stringify(plan)));
    expect({ plan: normalized, text: r.normalize(setupPlanText(plan)) }).toEqual(golden[`${target}-${custom ? "custom" : "default"}`].preview);
    applySetup(plan, r.options);
    const files = plan.actions[0]!.files.map(file => ({ file: r.normalize(file), bytes: r.normalize(r.text(file)) }));
    expect(files).toEqual(golden[`${target}-${custom ? "custom" : "default"}`].appliedFiles);
    undoSetup(planSetup(target, "undo", r.options), r.options);
    expect(plan.actions[0]!.files.every(file => !existsSync(file))).toBe(true);
  }
});
