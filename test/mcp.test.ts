import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { MCP_FRAME_BYTES, MCP_PROPERTY_NAME_LENGTH } from "../src/mcp-bounds.ts";
import { MCP_TOOLS, serveMcp, type McpHandlers } from "../src/mcp.ts";

const expectedTools = ["amem_brief", "amem_capacity", "amem_correct", "amem_evidence", "amem_graph", "amem_remember", "amem_search", "amem_show", "amem_timeline", "amem_vault_candidates", "amem_work_state_read", "amem_work_state_write"];

const request = (id: number | string, method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n";
const initialize = request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-client", version: "1" } }) + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
async function session(lines: string, handlers: Partial<McpHandlers> = {}) {
  const input = new PassThrough(), output = new PassThrough();
  let text = "", closed = 0, calls = 0;
  output.on("data", chunk => { text += chunk.toString(); });
  const tools = Object.fromEntries(MCP_TOOLS.map(t => [t.name, async () => { calls++; return { ok: true }; }])) as unknown as McpHandlers;
  const done = serveMcp({ input, output, tools: { ...tools, ...handlers }, close: () => { closed++; } });
  input.end(lines);
  await done;
  return { replies: text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), closed, calls };
}

type InputSchema = {
  type: string | string[]; properties?: Record<string, InputSchema>; additionalProperties?: InputSchema | boolean;
  items?: InputSchema; enum?: unknown[]; maxLength?: number; minLength?: number;
  maxProperties?: number; maxItems?: number; minimum?: number; maximum?: number;
};
const escapedControl = String.fromCharCode(1);
const longestJsonValue = (values: unknown[]) => values.reduce((a, b) => Buffer.byteLength(JSON.stringify(a)) >= Buffer.byteLength(JSON.stringify(b)) ? a : b);
function largestArgument(schema: InputSchema): unknown {
  if (schema.enum) return longestJsonValue(schema.enum);
  const types = [schema.type].flat();
  if (types.includes("string") && schema.maxLength !== undefined) return escapedControl.repeat(schema.maxLength);
  if (schema.type === "object") {
    const fields = Object.entries(schema.properties ?? {}).map(([key, child]) => [key, largestArgument(child)]);
    if (typeof schema.additionalProperties === "object" && schema.maxProperties !== undefined) {
      const value = largestArgument(schema.additionalProperties);
      for (let i = fields.length; i < schema.maxProperties; i++) {
        const digits = i.toString(2).replaceAll("0", escapedControl).replaceAll("1", String.fromCharCode(2));
        fields.push([digits.padStart(MCP_PROPERTY_NAME_LENGTH, escapedControl), value]);
      }
    } else if (schema.additionalProperties !== false) throw Error("unbounded object schema");
    return Object.fromEntries(fields);
  }
  if (schema.type === "array" && schema.items && schema.maxItems !== undefined) return Array.from({ length: schema.maxItems }, () => largestArgument(schema.items!));
  if (schema.type === "integer" && schema.minimum !== undefined && schema.maximum !== undefined) return longestJsonValue([schema.minimum, schema.maximum]);
  if (schema.type === "boolean") return false;
  throw Error(`unbounded or unsupported input schema type: ${schema.type}`);
}

test("#646: every advertised tool accepts its maximal compact JSON frame", async () => {
  const listed = await session(initialize + request(2, "tools/list"));
  const tools = listed.replies[1].result.tools as { name: string; inputSchema: InputSchema }[];
  expect(tools).toHaveLength(MCP_TOOLS.length);
  const id = escapedControl.repeat(200);
  const frames = tools.map(tool => {
    const encoded = request(id, "tools/call", { name: tool.name, arguments: largestArgument(tool.inputSchema) });
    expect(Buffer.byteLength(encoded), tool.name).toBeLessThanOrEqual(MCP_FRAME_BYTES);
    return encoded;
  });
  const replied = await session(initialize + frames.join(""));
  expect(replied.calls).toBe(tools.length);
  expect(replied.replies.slice(1).every(reply => reply.id === id && !reply.error && !reply.result.isError)).toBe(true);
});

test("stdio client initializes, lists the twelve startup-bound tools, calls one and closes on EOF", async () => {
  const s = await session(initialize + request(2, "tools/list", {}) + request(3, "tools/call", { name: "amem_search", arguments: { query: "policy", limit: 1 } }));
  expect(s.replies.map(r => r.id)).toEqual([1, 2, 3]);
  expect(s.replies[0].result.protocolVersion).toBe("2025-06-18");
  expect(s.replies[1].result.tools).toHaveLength(12);
  expect(s.replies[1].result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(expectedTools);
  expect(s.replies[1].result.tools.every((t: any) => t.inputSchema.additionalProperties === false && !t.inputSchema.properties.project && !t.inputSchema.properties.home && !t.inputSchema.properties.cwd)).toBe(true);
  expect(s.replies[2].result.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
  expect(s.closed).toBe(1);
  expect(s.calls).toBe(1);
});

test("pre-initialization tools, unknown methods and model-selected project are refused before backend effects", async () => {
  const s = await session(request(7, "tools/list") + initialize + request(2, "other/method") + request(3, "tools/call", { name: "amem_search", arguments: { query: "a", project: "other/repo" } }));
  expect(s.replies[0].error.code).toBe(-32002);
  expect(s.replies.find(r => r.id === 2).error.code).toBe(-32601);
  expect(s.replies.find(r => r.id === 3).error.code).toBe(-32602);
  expect(s.calls).toBe(0);
});

test("malformed frames and tools/call notifications never perform writes, later requests still get their rid", async () => {
  const s = await session(initialize + "{broken}\n" + JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "amem_remember", arguments: { text: "hidden write" } } }) + "\n" + request(9, "ping"));
  expect(s.replies.find(r => r.error?.code === -32700).id).toBeNull();
  expect(s.replies.find(r => r.id === 9).result).toEqual({});
  expect(s.calls).toBe(0);
});

test("tool failures do not leak storage paths or private exception text", async () => {
  const s = await session(initialize + request(2, "tools/call", { name: "amem_show", arguments: { id: "abcdef123456" } }), { amem_show: async () => { throw new Error("private path /secret/data"); } });
  const r = s.replies.find(r => r.id === 2);
  expect(r.result.isError).toBe(true);
  expect(JSON.stringify(r)).not.toContain("/secret/data");
  expect(s.closed).toBe(1);
});

test("an overlong request is refused without buffering it into a tool invocation", async () => {
  const s = await session(initialize + request(2, "tools/call", { name: "amem_remember", arguments: { text: "x".repeat(70_000) } }) + request(3, "ping"));
  expect(s.calls).toBe(0);
  expect(s.replies.some(r => r.error?.code === -32600)).toBe(true);
  expect(s.replies.find(r => r.id === 3)?.result).toEqual({});
  expect(s.closed).toBe(1);
});

test("tool result overflow refuses explicitly instead of truncating JSON", async () => {
  const s = await session(initialize + request(2, "tools/call", { name: "amem_capacity", arguments: {} }), { amem_capacity: async () => ({ text: "a".repeat(300_000) }) });
  expect(s.replies.find(r => r.id === 2).result.isError).toBe(true);
  expect(JSON.stringify(s.replies)).not.toContain("a".repeat(1000));
});

test("a fake client uses a real stdio child, whose EOF closes once and exits without a daemon", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fakes/mcp-stdio.ts", import.meta.url).pathname], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
  const timeout = setTimeout(() => child.kill(), 3000);
  try {
    child.stdin.write(initialize + request(2, "tools/list", {}) + request(3, "tools/call", { name: "amem_show", arguments: { id: "abcdef123456" } }));
    child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(stderr).toBe("closed\n");
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(replies.map(row => row.id)).toEqual([1, 2, 3]);
    expect(replies[1].result.tools).toHaveLength(12);
    expect(replies[1].result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(expectedTools);
    expect(JSON.parse(replies[2].result.content[0].text)).toEqual({ args: { id: "abcdef123456" } });
  } finally { clearTimeout(timeout); if (child.exitCode === null) { child.kill(); await child.exited; } }
});

test("tools/list accepts MCP null cursor and metadata forms without widening tool arguments", async () => {
  const accepted = [null, { cursor: null }, { _meta: {} }];
  for (const params of accepted) {
    const s = await session(initialize + request(2, "tools/list", params));
    expect(s.replies.find(r => r.id === 2)?.result.tools).toHaveLength(12);
    expect(s.replies.find(r => r.id === 2)?.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(expectedTools);
    expect(s.calls).toBe(0);
  }
  for (const params of [{ cursor: "next" }, { _meta: { unexpected: true } }, { extra: true }, [], 1]) {
    const s = await session(initialize + request(2, "tools/list", params));
    expect(s.replies.find(r => r.id === 2)?.error.code).toBe(-32602);
    expect(s.calls).toBe(0);
  }
});
