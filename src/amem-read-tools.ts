/** #540: amem's own read tools, as hosts name them. Zero imports: the capture path loads only this table, never the MCP schemas.
 * test/own-read-capture.test.ts keeps it equal to the readOnlyHint tools in src/mcp.ts. */
export const AMEM_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "amem_search", "amem_evidence", "amem_show", "amem_timeline", "amem_brief", "amem_graph", "amem_work_state_read", "amem_vault_candidates", "amem_capacity",
]);
/** Every `amem setup` target registers server key `amem`; the Claude plugin registers server `agent-mem`. Exact prefixes only. */
export const AMEM_MCP_TOOL_PREFIXES = ["mcp__amem__", "mcp__plugin_agent-mem_agent-mem__"] as const;
export function isOwnAmemReadTool(toolName: unknown): boolean {
  if (typeof toolName !== "string") return false;
  for (const prefix of AMEM_MCP_TOOL_PREFIXES) if (toolName.startsWith(prefix)) return AMEM_READ_TOOL_NAMES.has(toolName.slice(prefix.length));
  return false;
}
