import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
const root = new URL("../", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), "utf8"));

test("installable marketplace resolves agent-mem to the full package root", () => {
  const marketplace = read(".claude-plugin/marketplace.json"), plugin = read(".claude-plugin/plugin.json"), pkg = read("package.json");
  expect(marketplace.name).toBe("agent-mem"); expect(marketplace.owner.name).toBe("STAIxBWLB");
  expect(marketplace.plugins).toHaveLength(1);
  expect(marketplace.plugins[0]).toMatchObject({ name: plugin.name, source: "./" });
  expect(plugin.version).toBe(pkg.version);
  expect(pkg.files).toEqual(expect.arrayContaining([".claude-plugin/", "hooks/", "bin/", "src/"]));
  for (const name of [".claude-plugin/plugin.json", "hooks/hooks.json", "bin/amem.js", "src/cli.ts"]) expect(existsSync(new URL(name, root))).toBe(true);
});

test("plugin MCP uses portable exec argv and the bounded Bun entry without a second declaration", () => {
  const plugin = read(".claude-plugin/plugin.json");
  expect(Object.keys(plugin.mcpServers)).toEqual(["agent-mem"]);
  expect(plugin.mcpServers["agent-mem"]).toEqual({ command: "bun", args: ["--smol", "${CLAUDE_PLUGIN_ROOT}/bin/amem.js", "mcp"] });
  const defaultMcp = new URL(".mcp.json", root);
  if (existsSync(defaultMcp)) expect(readFileSync(defaultMcp, "utf8")).not.toContain('"agent-mem"');
  expect(read(".claude-plugin/marketplace.json").plugins[0].mcpServers).toBeUndefined();
});

test("default hook discovery is the single seven-event registration", () => {
  const plugin = read(".claude-plugin/plugin.json"), marketplace = read(".claude-plugin/marketplace.json"), hooks = read("hooks/hooks.json").hooks;
  expect(plugin.hooks).toBeUndefined(); expect(marketplace.plugins[0].hooks).toBeUndefined();
  const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"];
  expect(Object.keys(hooks).sort()).toEqual([...events].sort());
  for (const event of events) {
    expect(hooks[event]).toHaveLength(1); expect(hooks[event][0].hooks).toHaveLength(1);
    expect(hooks[event][0].hooks[0]).toMatchObject({ type: "command", command: `bun --smol "${"${CLAUDE_PLUGIN_ROOT}"}/bin/amem.js" hook ${event}` });
  }
});
