import { noteDisplayActor } from "./memory/cli-attribution.ts";
import { singleLine } from "./memory/style.ts";
import { createMemoryMcp } from "./mcp-memory.ts";
import { safeProfileLockMessage } from "./memory/profile-lock-diagnostic.ts";
import { memoryHome } from "./memory/home.ts";
import type { ParsedCommand } from "./commands-table.ts";

const UNAVAILABLE = "Memory operation unavailable or refused; no partial result is shown.";
const RESULT_BYTES = 262_144;

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

  // #431: an agent-marked session runs every command a person runs. Only reads whose options fit the startup-bound MCP read
  // handlers take that route; every other command, and a read with other options (history, as-of, tier, kind), continues
  // through the person handler with its own preview/--confirm or --apply steps and policy screens.
  if (definition.mutates !== undefined) return undefined;

  const flags = Object.keys(options).filter(key => key !== "--json" && key !== "--policy-free");
  const only = (...allowed: string[]) => flags.every(flag => allowed.includes(flag));
  const limit = positiveLimit(options["--limit"]);
  const checkedLimit = () => {
    if (options["--limit"] !== undefined && limit === undefined) throw new AgentUsageError("--limit takes a whole number from 1 to 100.");
    return limit;
  };

  if (path[0] === "search") {
    if (!only("--limit", "--since", "--explain")) return undefined;
    checkedLimit();
    if (!positionals.join(" ").trim()) throw new AgentUsageError("agent-marked search needs a query.");
    return { tool: "amem_search", args: { query: positionals.join(" "), ...(limit === undefined ? {} : { limit }), ...(options["--since"] !== undefined ? { since: options["--since"] } : {}), ...(options["--explain"] === true ? { explain: true } : {}) } };
  }
  if (path[0] === "list") {
    if (!only("--limit", "--since")) return undefined;
    checkedLimit();
    return { tool: "amem_timeline", args: { ...(limit === undefined ? {} : { limit }), ...(options["--since"] !== undefined ? { since: options["--since"] } : {}) } };
  }
  if (path[0] === "show") {
    if (!only()) return undefined;
    if (positionals.length !== 1 || !positionals[0]!.trim()) throw new AgentUsageError("agent-marked show takes exactly one id.");
    return { tool: "amem_show", args: { id: positionals[0] } };
  }
  // #431 AC2: `brief --for` runs the person handler, which screens with the configured policy and prepares the curated brief cache.
  if (path[0] === "graph") {
    if (!only("--hops")) return undefined;
    if (positionals.length !== 1) throw new AgentUsageError("agent-marked graph takes exactly one start id.");
    const hops = options["--hops"] === undefined ? 1 : Number(options["--hops"]);
    if (hops !== 1 && hops !== 2) throw new AgentUsageError("--hops takes 1 or 2.");
    return { tool: "amem_graph", args: { start: positionals[0], ...(options["--hops"] === undefined ? {} : { hops }) } };
  }
  if (path[0] === "vault-candidates") {
    if (!only("--limit") || options["--all-projects"] !== undefined || options["--project"] !== undefined) return undefined;
    checkedLimit();
    return { tool: "amem_vault_candidates", args: limit === undefined ? {} : { limit } };
  }
  if (path[0] === "capacity" && path.length === 1) {
    if (!only()) return undefined;
    return { tool: "amem_capacity", args: {} };
  }
  return undefined;
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
  } catch (error) {
    if(safeProfileLockMessage(error))throw error;
    throw new Error(UNAVAILABLE);
  } finally {
    try { memory?.close(); } catch { /* close failures do not expose partial reads */ }
  }
}
