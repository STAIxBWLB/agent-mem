import { afterEach, expect, test } from "bun:test";
import { drainHookCaptures, stageHookCapture } from "../src/hook-spool.ts";
import { AMEM_READ_TOOL_NAMES, isOwnAmemReadTool } from "../src/amem-read-tools.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const clean: (() => void)[] = [];
const oldHome = process.env.HOME;
afterEach(() => { process.env.HOME = oldHome; for (const close of clean.splice(0)) close(); });
function fixture() {
  const f = hookFixture(); clean.push(f.close); process.env.HOME = f.env.HOME;
  return { ...f, options: { cwd: f.cwd, base: f.base } };
}
async function drain(f: ReturnType<typeof fixture>) {
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  try { await drainHookCaptures({ ...f.options, project: f.project }, (input, receipt) => store.append(input, { receipt })); return store.rows({ project: f.project }); }
  finally { store.close(); }
}
const QUALIFIED = ["mcp__amem__", "mcp__plugin_agent-mem_agent-mem__"];
const CONTROLS = ["mcp__other__amem_search", "mcp__amem_x__amem_search", "mcp__plugin_x_agent-mem__amem_search", "mcp__amem__amem_search_x", "amem_search",
  "mcp__amem__amem_remember", "mcp__amem__amem_work_state_write", "mcp__amem__amem_correct", "Bash"];

test("the skip table equals the readOnlyHint tools in mcp.ts", () => {
  expect([...AMEM_READ_TOOL_NAMES].sort()).toEqual(MCP_TOOLS.filter(tool => tool.annotations.readOnlyHint).map(tool => tool.name).sort());
});

test("only exact amem-owned read tool names classify; foreign servers, lookalikes, bare names and write tools do not", () => {
  for (const prefix of QUALIFIED) for (const name of AMEM_READ_TOOL_NAMES) expect(isOwnAmemReadTool(prefix + name)).toBe(true);
  for (const name of CONTROLS) expect(isOwnAmemReadTool(name)).toBe(false);
  expect(isOwnAmemReadTool(undefined)).toBe(false); expect(isOwnAmemReadTool(1)).toBe(false);
});

test("an amem read tool's own Pre/PostToolUse rows are not captured; every control still is", async () => {
  const f = fixture();
  for (const prefix of QUALIFIED) for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
    const staged = await stageHookCapture(event, { tool_name: `${prefix}amem_search`, tool_input: { query: "ownechoneedle" }, tool_response: "x", error: "x" }, f.options);
    expect(staged).toBeUndefined();
  }
  for (const name of CONTROLS) expect(await stageHookCapture("PreToolUse", { tool_name: name, tool_input: { query: `controlneedle ${name}` } }, f.options)).toBeDefined();
  const rows = await drain(f);
  expect(rows.some(row => row.excerpt.includes("ownechoneedle"))).toBe(false);
  expect(rows.map(row => row.tool).sort()).toEqual([...CONTROLS].sort());
});

test("search and timeline through MCP never return the running read call's own capture row", async () => {
  const f = fixture(), query = "typescriptversion regenerate signatures";
  await stageHookCapture("PostToolUse", { tool_name: "Bash", tool_input: { command: `echo ${query}` }, tool_response: "other session work" }, f.options);
  for (const tool of ["amem_search", "amem_timeline", "amem_show", "amem_brief"])
    await stageHookCapture("PreToolUse", { tool_name: `mcp__amem__${tool}`, tool_input: { query } }, f.options);
  await drain(f);
  const mcp = createMemoryMcp({ cwd: f.cwd, base: f.base, project: f.project });
  try {
    const search = await mcp.tools.amem_search({ query, includeCapture: true, limit: 20 }) as { hits: { capture?: { tool?: string } }[] };
    const captured = search.hits.flatMap(hit => hit.capture ? [hit.capture.tool] : []);
    expect(captured).toEqual(["Bash"]);
    const timeline = JSON.stringify(await mcp.tools.amem_timeline({ since: "2000-01-01T00:00:00.000Z", limit: 50 }));
    expect(timeline).toContain("Bash"); expect(timeline).not.toContain("mcp__amem__");
  } finally { mcp.close(); }
});
