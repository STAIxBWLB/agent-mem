import { MCP_TOOLS, serveMcp, type McpHandlers } from "../../src/mcp.ts";

const tools = Object.fromEntries(MCP_TOOLS.map(tool => [tool.name, async (args: Record<string, unknown>) => ({ args })])) as McpHandlers;
await serveMcp({ tools, version: "fake-client-fixture", close: () => { process.stderr.write("closed\n"); } });
