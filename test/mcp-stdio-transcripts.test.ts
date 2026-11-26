import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ResultTooLarge, runConformance, runTranscripts, schemaError, type ServeOptions, type TranscriptCase } from "@staix/mcp-stdio";
import { MCP_TOOLS, mcpServeOptions, type McpHandlers } from "../src/mcp.ts";

type RecordedCase = TranscriptCase & { tools?: ServeOptions["tools"]; frameBytes?: number; handlerNames?: string[] };
const load = (file: string): RecordedCase[] => readFileSync(
  new URL(`../fixtures/v1/${file}.jsonl`, import.meta.resolve("@staix/mcp-stdio")), "utf8",
).trimEnd().split("\n").map(line => JSON.parse(line) as RecordedCase);

const handlerTable = (names: readonly string[]) => Object.fromEntries(names.map(name => [name, () => ({})]));
const handlers = handlerTable(MCP_TOOLS.map(tool => tool.name)) as unknown as McpHandlers;
const amem = mcpServeOptions({ tools: handlers, version: "fixture" });
const names = ["echo", "fail", "named", "large"];
const schema = { type: "object", properties: { text: { type: "string" } }, additionalProperties: false };
const core: ServeOptions = {
  name: "fixture", version: "1", tools: names.map(name => ({ name, description: name, inputSchema: schema })),
  handlers: { echo: args => args, fail: () => { throw Error("private"); },
    named: () => { throw { code: "named" }; }, large: () => "x".repeat(200) },
  limits: { frameBytes: 512, resultBytes: 100, toolFrameBytes: name => name === "echo" ? 180 : undefined },
  failureText: error => error instanceof ResultTooLarge ? "too large" : (error as { code?: string })?.code === "named" ? "named failure" : undefined,
};

for (const name of ["core", "agent-mem", "agent-mem-protocol"]) test(`published mcp-stdio ${name} transcript replays exactly`, async () => {
  const base = name === "core" ? core : amem;
  for (const item of load(name)) {
    const [result] = await runTranscripts([item], {
      ...base,
      // Historical recordings carry their own schema snapshot. The current table is checked below.
      tools: item.tools ?? base.tools,
      handlers: item.handlerNames ? handlerTable(item.handlerNames) : base.handlers,
      ...(item.frameBytes === undefined ? {} : { limits: { ...base.limits, frameBytes: item.frameBytes } }),
    });
    expect(result?.actual, item.id).toBe(result?.expected);
  }
});

test("current amem schemas and stdio settings pass the package conformance cases for both eras", async () => {
  for (const tool of MCP_TOOLS) expect(schemaError(tool.inputSchema), tool.name).toBeUndefined();
  const results = await runConformance(amem);
  for (const result of results) expect(result.actual, result.id).toBe(result.expected);
});

test.each(["2025-06-18", "2025-11-25", "2026-07-28"])("amem handler failures and emission observations are stable in %s", async protocol => {
  const encode = (value: unknown) => JSON.stringify(value) + "\n";
  const request = (id: number, method: string, params: Record<string, unknown>) => encode({ jsonrpc: "2.0", id, method, params });
  const modern = protocol === "2026-07-28";
  const ready = modern ? "" : request(1, "initialize", { protocolVersion: protocol, capabilities: {}, clientInfo: {} })
    + encode({ jsonrpc: "2.0", method: "notifications/initialized" });
  const call = (id: number, args: unknown) => request(id, "tools/call", { name: "amem_remember", arguments: args,
    ...(modern ? { _meta: { "io.modelcontextprotocol/protocolVersion": protocol, "io.modelcontextprotocol/clientCapabilities": {} } } : {}) });
  const expectedValue = { ok: true }, seen: unknown[] = [];
  const options = mcpServeOptions({
    tools: { ...handlers, amem_remember: ({ text }) => {
      if (text === "full") throw { code: "candidate_queue_full" };
      if (text === "other") throw Error("private internal path");
      return expectedValue;
    } },
    onEmitted: (tool, id, value) => { seen.push([tool, id, value]); },
  });
  const [wire] = await runTranscripts([{ id: "adapter-failures", input: ready + call(2, { text: "full" }) +
    call(3, { text: "other" }) + call(4, { text: 2 }) + call(5, { text: "ok" }), output: "" }], options);
  const replies = wire!.actual.trimEnd().split("\n").map(line => JSON.parse(line));
  const reply = (id: number) => replies.find(row => row.id === id);
  expect(reply(2).result).toMatchObject({ isError: true, content: [{ type: "text", text: "The review queue is full: no more candidates are accepted. Do not retry; review pending candidates through the screened CLI." }] });
  expect(reply(3).result).toMatchObject({ isError: true, content: [{ type: "text", text: "Memory operation unavailable or refused; no partial result is shown." }] });
  if (protocol === "2025-06-18") expect(reply(4).error).toEqual({ code: -32602, message: "text: expected string" });
  else expect(reply(4).result).toMatchObject({ isError: true, content: [{ type: "text", text: "text: expected string" }] });
  if (modern) expect(reply(5).result.resultType).toBe("complete");
  expect(seen).toEqual([["amem_remember", 5, expectedValue]]);
  expect((seen[0] as unknown[])[2]).toBe(expectedValue);
});
