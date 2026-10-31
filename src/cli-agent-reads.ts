import { noteDisplayActor } from "./memory/cli-attribution.ts";
import { singleLine } from "./memory/style.ts";
import { createMemoryMcp } from "./mcp-memory.ts";
import { memoryHome } from "./memory/home.ts";
import type { ParsedCommand } from "./commands-table.ts";

const UNAVAILABLE = "Memory operation unavailable or refused; no partial result is shown.";
const RESULT_BYTES = 262_144;
const AGENT_READS = "Agent reads: search, list, show, brief, graph, vault-candidates, capacity.";

/** A refusal decided from the parsed command alone, before any store or file is opened: safe to show as is. */
export class AgentUsageError extends Error {
  constructor(message: string) { super(message); this.name = "AgentUsageError"; }
}
const accepts = (command: string, allowed: readonly string[]) => new AgentUsageError(allowed.length
  ? `agent-marked ${command} accepts only ${allowed.length === 1 ? allowed[0] : `${allowed.slice(0, -1).join(", ")} and ${allowed.at(-1)}`}.`
  : `agent-marked ${command} accepts no options.`);

type ReadCall = { tool: keyof ReturnType<typeof createMemoryMcp>["tools"]; args: Record<string, unknown> };

function values(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === name) {
      const value = argv[++i];
      if (value !== undefined && !value.startsWith("--")) out.push(value);
    } else if (token.startsWith(`${name}=`)) out.push(token.slice(name.length + 1));
  }
  return out;
}

function positiveLimit(value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : undefined;
}

function route(parsed: ParsedCommand, argv: readonly string[]): ReadCall | undefined {
  const { path, options, positionals, definition } = parsed;

  if (path[0] === "machine" && options["--label"] === undefined) throw new AgentUsageError(`amem machine without --label is not available to an agent-marked session. ${AGENT_READS}`);
  // Write/preview/confirmation paths continue through the guarded administrative handlers.
  if (definition.mutates !== undefined) return undefined;
  if (path[0] === "project" && path[1] === "export") throw new AgentUsageError(`amem project export is not available to an agent-marked session. ${AGENT_READS}`);
  if (path[0] === "setup") return undefined;

  const flags = Object.keys(options).filter(key => key !== "--json" && key !== "--policy-free");
  const only = (...allowed: string[]) => flags.every(flag => allowed.includes(flag));
  const limit = positiveLimit(options["--limit"]);
  if (options["--limit"] !== undefined && limit === undefined) throw new AgentUsageError("--limit takes a whole number from 1 to 100.");

  if (path[0] === "search") {
    if (!only("--limit", "--since", "--explain")) throw accepts("search", ["--limit", "--since", "--explain"]);
    if (!positionals.join(" ").trim()) throw new AgentUsageError("agent-marked search needs a query.");
    return { tool: "amem_search", args: { query: positionals.join(" "), ...(limit === undefined ? {} : { limit }), ...(options["--since"] !== undefined ? { since: options["--since"] } : {}), ...(options["--explain"] === true ? { explain: true } : {}) } };
  }
  if (path[0] === "list") {
    if (!only("--limit", "--since")) throw accepts("list", ["--limit", "--since"]);
    return { tool: "amem_timeline", args: { ...(limit === undefined ? {} : { limit }), ...(options["--since"] !== undefined ? { since: options["--since"] } : {}) } };
  }
  if (path[0] === "show") {
    if (!only()) throw accepts("show", []);
    if (positionals.length !== 1 || !positionals[0]!.trim()) throw new AgentUsageError("agent-marked show takes exactly one id.");
    return { tool: "amem_show", args: { id: positionals[0] } };
  }
  if (path[0] === "brief") {
    if (!only("--for", "--paths", "--symbols", "--bytes")) throw accepts("brief", ["--for", "--paths", "--symbols", "--bytes"]);
    if (typeof options["--for"] !== "string") throw new AgentUsageError("agent-marked brief needs --for.");
    const rawBytes = options["--bytes"];
    if (rawBytes !== undefined && !/^[1-9][0-9]*$/.test(String(rawBytes))) throw new AgentUsageError("--bytes takes a positive whole number.");
    return { tool: "amem_brief", args: { intent: options["--for"], paths: values(argv, "--paths"), symbols: values(argv, "--symbols"), ...(rawBytes === undefined ? {} : { maxBytes: Number(rawBytes) }) } };
  }
  if (path[0] === "graph") {
    if (!only("--hops")) throw accepts("graph", ["--hops"]);
    if (positionals.length !== 1) throw new AgentUsageError("agent-marked graph takes exactly one start id.");
    const hops = options["--hops"] === undefined ? 1 : Number(options["--hops"]);
    if (hops !== 1 && hops !== 2) throw new AgentUsageError("--hops takes 1 or 2.");
    return { tool: "amem_graph", args: { start: positionals[0], ...(options["--hops"] === undefined ? {} : { hops }) } };
  }
  if (path[0] === "vault-candidates") {
    if (!only("--limit") || options["--all-projects"] !== undefined || options["--project"] !== undefined) throw accepts("vault-candidates", ["--limit"]);
    return { tool: "amem_vault_candidates", args: limit === undefined ? {} : { limit } };
  }
  if (path[0] === "capacity" && path.length === 1) {
    if (!only()) throw accepts("capacity", []);
    return { tool: "amem_capacity", args: {} };
  }
  throw new AgentUsageError(`amem ${path.join(" ")} is not available to an agent-marked session. ${AGENT_READS}`);
}

/** Route marked-agent read commands through the same startup-bound MCP policy and handlers. */
export async function agentCliRead(
  parsed: ParsedCommand,
  argv: readonly string[],
  context: { cwd?: string; env?: Readonly<Record<string, string | undefined>> },
): Promise<string | undefined> {
  const call = route(parsed, argv);
  if (!call) return undefined;

  let memory: ReturnType<typeof createMemoryMcp> | undefined;
  try {
    const env = context.env ?? process.env;
    memory = createMemoryMcp({ cwd: context.cwd ?? process.cwd(), base: memoryHome({ ...process.env, ...env }) });
    const value = await memory.tools[call.tool](call.args);
    const output = JSON.stringify(value);
    if (output === undefined || Buffer.byteLength(output) > RESULT_BYTES) throw new Error(UNAVAILABLE);
    if (parsed.path[0] === "show" && parsed.options["--json"] !== true && value && typeof value === "object" && "peer" in value && typeof value.peer === "string") {
      const shown = `actor: ${noteDisplayActor(value.peer)}, peer: ${singleLine(value.peer)}\n${output}`;
      if (Buffer.byteLength(shown) > RESULT_BYTES) throw new Error(UNAVAILABLE);
      return shown;
    }
    return output;
  } catch {
    throw new Error(UNAVAILABLE);
  } finally {
    try { memory?.close(); } catch { /* close failures do not expose partial reads */ }
  }
}
