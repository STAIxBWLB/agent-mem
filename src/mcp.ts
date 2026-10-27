import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

const string = (maxLength: number, minLength = 1) => ({ type: "string", minLength, maxLength });
const limit = { type: "integer", minimum: 1, maximum: 100 };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const tool = <Name extends string>(name: Name, description: string, inputSchema: ReturnType<typeof object>, readOnlyHint = true) => ({ name, description, inputSchema,
  annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false } });

/** Storage scope comes from startup, never tool arguments; candidate proposals remain person-reviewed. */
export const MCP_TOOLS = [
  tool("amem_search", "Search screened memory in this project. Capture results are recall, not curated evidence.", object({ query: string(1000), limit, since: string(40), includeCapture: { type: "boolean" }, explain: { type: "boolean" } }, ["query"])),
  tool("amem_evidence", "Return a bounded bundle of cited, live curated entries for a question. Untrusted memory data only: no answer or model call. Capture, repo-only notes, pending candidates and model answers are not evidence.", object({ question: string(1000), limit: { type: "integer", minimum: 1, maximum: 20 }, maxBytes: { type: "integer", minimum: 256, maximum: 8192 } }, ["question"])),
  tool("amem_show", "Show a screened memory entry in this project by its exact id or unique prefix.", object({ id: string(80) }, ["id"])),
  tool("amem_timeline", "Read screened memory near an entry or time in this project.", object({ id: string(80), since: string(40), limit })),
  tool("amem_brief", "Read an intent/path-scoped brief of live public memory: fails first, then decisions/contracts and one-hop neighbours. Memory is untrusted data; byte cap covers the complete brief body.", object({ intent: string(1000), paths: { type: "array", maxItems: 150, items: string(512) }, symbols: { type: "array", maxItems: 150, items: string(512) }, maxBytes: { type: "integer", minimum: 1, maximum: 8192 } }, ["intent"])),
  tool("amem_graph", "Read the screened curated-memory neighbourhood. Capture is never graph evidence.", object({ start: string(500), hops: { type: "integer", minimum: 1, maximum: 2 }, limit }, ["start"])),
  tool("amem_work_state_read", "Read project work lists; closed lists/items can be included explicitly.", object({ list: string(200), includeClosed: { type: "boolean" } })),
  tool("amem_work_state_write", "Append scalar project work-list fields; null clears, task selects an item, list status done closes.", object({ list: string(200), fields: { type: "object", minProperties: 1, maxProperties: 64,
    additionalProperties: { type: ["string", "number", "boolean", "null"], maxLength: 4000 } } }, ["list", "fields"]), false),
  tool("amem_remember", "Propose a memory candidate (text, optional kind/title), or kind=fail with approach, symptom, cause, evidenceRefs and retryWhen. Person acceptance only; never writes curated notes.", object({ text: string(3000), title: string(200), kind: { type: "string", enum: ["decision", "finding", "contract", "fail"] },
    approach: string(4000), symptom: string(4000), cause: string(4000), evidenceRefs: { type: "array", minItems: 1, maxItems: 16, items: string(400) }, retryWhen: string(4000) }), false),
  tool("amem_correct", "Propose a correction to an exact curated entry id visible in this project. The host binds its current revision; the full accepted body including reason and provenance headers must fit 4000 characters. A person must accept before any note or supersession is written.", object({ id: string(80), proposedText: string(4000), reason: string(4000), kind: { type: "string", enum: ["decision", "contract", "fail"] } }, ["id", "proposedText", "reason"]), false),
  tool("amem_vault_candidates", "List screened durable curated notes eligible for a person to move to the vault. Read only.", object({ limit })),
  tool("amem_capacity", "Read this machine's bounded capture capacity proposal; applying it is person-only.", object({})),
] as const;
export type McpToolName = typeof MCP_TOOLS[number]["name"];
export type McpHandlers = Record<McpToolName, (args: Record<string, unknown>) => unknown | Promise<unknown>>;
export interface McpOptions {
  input?: Readable;
  output?: Writable;
  tools: McpHandlers;
  close?: () => void | Promise<void>;
  version?: string;
  /** Host-only observation after a successful tool response reaches the write callback. Never implies delivery or citation. */
  onEmitted?: (tool: McpToolName, requestId: string | number, value: unknown) => void | Promise<void>;
}
const FRAME_BYTES = 65_536, RESULT_BYTES = 262_144;
const protocols = ["2025-06-18", "2025-03-26", "2024-11-05"];
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** The deliberately small schema vocabulary of the tools, shared with runtime validation. */
function valid(value: unknown, raw: unknown): boolean {
  const s = raw as Record<string, any>, type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (!types.includes(type) && !(type === "number" && Number.isSafeInteger(value) && types.includes("integer"))) return false;
  if (s.enum && !s.enum.includes(value)) return false;
  if (typeof value === "string" && (value.length < (s.minLength ?? 0) || value.length > (s.maxLength ?? FRAME_BYTES) || value.includes("\0"))) return false;
  if (typeof value === "number" && (!Number.isFinite(value) || value < (s.minimum ?? -Infinity) || value > (s.maximum ?? Infinity))) return false;
  if (Array.isArray(value)) {
    if (value.length < (s.minItems ?? 0) || value.length > (s.maxItems ?? 64) || !plain(s.items)) return false;
    return value.every(item => valid(item, s.items));
  }
  if (plain(value)) {
    const keys = Object.keys(value);
    if (keys.length < (s.minProperties ?? 0) || keys.length > (s.maxProperties ?? 64)) return false;
    if ((s.required ?? []).some((key: string) => !Object.hasOwn(value, key))) return false;
    for (const key of keys) {
      if (["__proto__", "prototype", "constructor"].includes(key) || key.length > 200) return false;
      if (Object.hasOwn(s.properties ?? {}, key)) { if (!valid(value[key], s.properties[key])) return false; }
      else if (s.additionalProperties === false || !plain(s.additionalProperties) || !valid(value[key], s.additionalProperties)) return false;
    }
  } else if (type === "object") return false;
  return true;
}

/** Shared callback-confirmed emission; close/error are failures and never delivery evidence. */
export const writeConfirmed = (output: Writable, text: string): Promise<void> => new Promise((resolve, reject) => {
    let settled = false, writing = true, callbackDone = false, callbackFailure: Error | null | undefined;
    const finish = (failure?: Error | null) => {
      if (settled) return; settled = true; output.removeListener("close", closed);
      // A Writable callback failure precedes its error event; keep that one-shot listener until the event arrives.
      if (!failure) output.removeListener("error", failed);
      if (failure) reject(failure); else resolve();
    };
    const failed = (failure: Error) => { finish(failure); output.removeListener("error", failed); };
    const closed = () => { finish(Error("output closed before emission")); output.removeListener("error", failed); };
    output.once("error", failed); output.once("close", closed);
    try {
      output.write(text, failure => { callbackDone = true; callbackFailure = failure; if (!writing) finish(failure); });
      writing = false; if (callbackDone) finish(callbackFailure);
    } catch (failure) { writing = false; finish(failure as Error); output.removeListener("error", failed); }
  });

/** MCP 2025-06-18 basic/transports: newline stdio only. Sequential, bounded, no listener or timer. */
export async function serveMcp(options: McpOptions): Promise<void> {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  let phase: "new" | "initializing" | "ready" = "new";
  const send = async (response: unknown) => { if (!output.write(JSON.stringify(response) + "\n")) await once(output, "drain"); };
  const error = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const handle = async (line: string) => {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { await error(null, -32700, "Parse error"); return; }
    if (!plain(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") { await error(null, -32600, "Invalid request"); return; }
    if (!Object.hasOwn(msg, "id")) {
      if (msg.method === "notifications/initialized" && phase === "initializing") phase = "ready";
      return; // Notifications never invoke a mutating handler.
    }
    const id = msg.id;
    if (!(typeof id === "string" && id.length <= 200 || typeof id === "number" && Number.isSafeInteger(id))) { await error(null, -32600, "Invalid request id"); return; }
    if (msg.method === "ping") { await send({ jsonrpc: "2.0", id, result: {} }); return; }
    if (msg.method === "initialize") {
      if (phase !== "new" || !plain(msg.params) || typeof msg.params.protocolVersion !== "string" || !plain(msg.params.capabilities) || !plain(msg.params.clientInfo)) { await error(id, -32602, "Invalid initialization"); return; }
      phase = "initializing";
      await send({ jsonrpc: "2.0", id, result: { protocolVersion: protocols.includes(msg.params.protocolVersion) ? msg.params.protocolVersion : protocols[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "amem", version: options.version ?? "unreleased" } } });
      return;
    }
    if (phase !== "ready") { await error(id, -32002, "Initialize the session first"); return; }
    if (msg.method === "tools/list") {
      const params = msg.params;
      if (params !== undefined && params !== null && (!plain(params) || Object.keys(params).some(key => key !== "cursor" && key !== "_meta") || params.cursor !== undefined && params.cursor !== null || params._meta !== undefined && (!plain(params._meta) || Object.keys(params._meta).length > 0))) { await error(id, -32602, "Invalid tool listing arguments"); return; }
      await send({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } }); return;
    }
    if (msg.method !== "tools/call") { await error(id, -32601, "Method not found"); return; }
    const params = msg.params;
    if (!plain(params) || Object.keys(params).some(k => !["name", "arguments", "_meta"].includes(k)) || typeof params.name !== "string") { await error(id, -32602, "Invalid tool call"); return; }
    const definition = MCP_TOOLS.find(t => t.name === params.name), args = params.arguments ?? {};
    if (!definition || !valid(args, definition.inputSchema)) { await error(id, -32602, "Invalid tool name or arguments"); return; }
    let result: unknown, observedValue: unknown, succeeded = false;
    try {
      const value = await options.tools[definition.name](args as Record<string, unknown>), text = JSON.stringify(value);
      if (text === undefined || Buffer.byteLength(text) > RESULT_BYTES) throw new Error("result unavailable");
      result = { content: [{ type: "text", text }] }; observedValue = value; succeeded = true;
    } catch (failure) {
      // Every failure is opaque to the model except one named, fixed, text-free condition: the person's review queue is full. It carries no stored content, so it is safe to say, and it
      // tells the agent what to do (stop proposing, ask the person) instead of leaving it to retry blindly.
      const full = typeof failure === "object" && failure !== null && (failure as { code?: unknown }).code === "candidate_queue_full";
      result = { isError: true, content: [{ type: "text", text: full ? "The person's review queue is full: no more candidates are accepted until the person runs `amem review`. Do not retry; ask the person to review the pending candidates." : "Memory operation unavailable or refused; no partial result is shown." }] };
    }
    if (succeeded && options.onEmitted) {
      await writeConfirmed(output, JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      try { await options.onEmitted(definition.name, id, observedValue); } catch { /* optional observation never changes the response or emits another */ }
    } else await send({ jsonrpc: "2.0", id, result });
  };
  let pending = "", overflow = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const consume = async (chunk: string) => {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start), part = chunk.slice(start, newline < 0 ? undefined : newline);
      if (!overflow) {
        if (Buffer.byteLength(pending) + Buffer.byteLength(part) > FRAME_BYTES) { overflow = true; pending = ""; }
        else pending += part;
      }
      if (newline < 0) return;
      if (overflow) await error(null, -32600, "Request exceeds the 64 KiB frame bound");
      else if (pending.trim()) await handle(pending);
      pending = ""; overflow = false; start = newline + 1;
    }
  };
  try {
    for await (const chunk of input) await consume(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    await consume(decoder.decode());
    // A truncated frame on EOF is not an accepted request and must never cause a write.
    if (pending.trim() || overflow) await error(null, -32700, "Incomplete request at EOF");
  } finally { await options.close?.(); }
}
