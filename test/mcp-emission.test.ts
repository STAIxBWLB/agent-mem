import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { MCP_TOOLS, serveMcp, type McpHandlers, type McpOptions } from "../src/mcp.ts";
const request = (id: string | number, method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n";
const initialized = request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "emission-fixture", version: "1" } }) + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
const call = (id: string | number = 2) => request(id, "tools/call", { name: "amem_show", arguments: { id: "a".repeat(32) } });
const handlers = (handler: () => unknown | Promise<unknown>): McpHandlers => Object.fromEntries(MCP_TOOLS.map(tool => [tool.name, handler])) as unknown as McpHandlers;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function run(lines: string, value: () => unknown | Promise<unknown>, observer: NonNullable<McpOptions["onEmitted"]>) {
  const input = new PassThrough(), replies: any[] = []; let closed = 0;
  const output = new Writable({ write(chunk, _encoding, callback) { replies.push(JSON.parse(chunk.toString())); callback(); } });
  const done = serveMcp({ input, output, tools: handlers(value), onEmitted: observer, close: () => { closed++; } }); input.end(lines); await done;
  return { replies, closed };
}
test("successful tools/call observes the original value only after its actual write callback, then closes once", async () => {
  const input = new PassThrough(), waiting = deferred(), events: string[] = [], value = { hits: [{ id: "curated" }] }; let callback!: (error?: Error | null) => void, closed = 0;
  const output = new Writable({ write(chunk, _encoding, done) { const response = JSON.parse(chunk.toString()); if (response.id === "tool-request") { events.push("write-enqueued"); callback = done; waiting.resolve(); } else done(); } });
  const served = serveMcp({ input, output, tools: handlers(() => value), onEmitted: (tool, id, observed) => { expect(tool).toBe("amem_show"); expect(id).toBe("tool-request"); expect(observed).toBe(value); events.push("observer"); }, close: () => { closed++; events.push("close"); } });
  input.end(initialized + call("tool-request")); await waiting.promise; expect(events).toEqual(["write-enqueued"]); expect(closed).toBe(0);
  events.push("callback-success"); callback(); await served; expect(events).toEqual(["write-enqueued", "callback-success", "observer", "close"]); expect(closed).toBe(1);
});
test("handler failure, oversize and nonserializable values never call emission observer", async () => {
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const handler of [() => { throw Error("private failure"); }, () => ({ text: "x".repeat(262_145) }), () => circular, () => undefined, () => 1n]) {
    let observed = 0; const result = await run(initialized + call(), handler, () => { observed++; });
    expect(observed).toBe(0); expect(result.replies).toHaveLength(2); expect(result.replies[1].result.isError).toBe(true); expect(result.closed).toBe(1);
  }
});
test("schema refusal, tools/list, ping and tools/call notification do not report emitted tool values", async () => {
  let observed = 0, invoked = 0;
  const notification = JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "amem_show", arguments: { id: "a".repeat(32) } } }) + "\n";
  const result = await run(initialized + request(2, "tools/list") + request(3, "ping") + request(4, "tools/call", { name: "amem_show", arguments: { id: "a", project: "foreign" } }) + notification, () => { invoked++; return {}; }, () => { observed++; });
  expect(observed).toBe(0); expect(invoked).toBe(0); expect(result.replies.map(row => row.id)).toEqual([1, 2, 3, 4]); expect(result.replies[3].error.code).toBe(-32602); expect(result.closed).toBe(1);
});
test("actual Writable callback failure rejects transport without observer or a second response and closes once", async () => {
  const input = new PassThrough(), frames: number[] = []; let observed = 0, closed = 0;
  const output = new Writable({ write(chunk, _encoding, callback) { const response = JSON.parse(chunk.toString()); frames.push(response.id); callback(response.id === 2 ? Error("owned output failed") : undefined); } });
  const done = serveMcp({ input, output, tools: handlers(() => ({ ok: true })), onEmitted: () => { observed++; }, close: () => { closed++; } });
  input.end(initialized + call()); await expect(done).rejects.toThrow("owned output failed"); expect(observed).toBe(0); expect(frames).toEqual([1, 2]); expect(closed).toBe(1);
});
test("synchronous output.write throw refuses observation and still closes once", async () => {
  const input = new PassThrough(); let writes = 0, observed = 0, closed = 0;
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } }); const original = output.write.bind(output);
  output.write = ((...args: Parameters<Writable["write"]>) => { if (++writes === 2) throw Error("write threw"); return original(...args); }) as Writable["write"];
  const done = serveMcp({ input, output, tools: handlers(() => ({ ok: true })), onEmitted: () => { observed++; }, close: () => { closed++; } }); input.end(initialized + call()); await expect(done).rejects.toThrow("write threw"); expect(observed).toBe(0); expect(writes).toBe(2); expect(closed).toBe(1);
});
test("throwing async observer fails open after emission, sends no extra response and allows the next request", async () => {
  let observed = 0;
  const result = await run(initialized + call(2) + call(3), () => ({ ok: true }), async () => { observed++; await Promise.resolve(); throw Error("optional telemetry failure"); });
  expect(observed).toBe(2); expect(result.replies.map(row => row.id)).toEqual([1, 2, 3]); expect(result.replies.slice(1).every(row => row.result.isError === undefined)).toBe(true); expect(result.closed).toBe(1);
});

test("a synchronous write throw after a success callback still prevents emission observation", async () => {
  const input = new PassThrough(); let writes = 0, observed = 0, closed = 0;
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } }); const original = output.write.bind(output);
  output.write = ((...args: Parameters<Writable["write"]>) => { const result = original(...args); if (++writes === 2) throw Error("write failed after callback"); return result; }) as Writable["write"];
  const done = serveMcp({ input, output, tools: handlers(() => ({ ok: true })), onEmitted: () => { observed++; }, close: () => { closed++; } }); input.end(initialized + call());
  await expect(done).rejects.toThrow("write failed after callback"); expect(observed).toBe(0); expect(closed).toBe(1);
});
