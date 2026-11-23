import { noteDisplayActor } from "./memory/cli-attribution.ts";
import { memoryDetailText, memoryRecordText, memoryScoresText, memoryTableText, PLAIN, type HumanMemoryRow, type Style } from "./memory/style.ts";
import type { View } from "./memory/store.ts";
import { capacityText, type CapacityReport } from "./memory/capacity.ts";
import { createMemoryMcp } from "./mcp-memory.ts";
import { safeProfileLockMessage } from "./memory/profile-lock-diagnostic.ts";
import { memoryHome } from "./memory/home.ts";
import type { ParsedCommand } from "./commands-table.ts";

const UNAVAILABLE = "Memory operation unavailable or refused; no partial result is shown.";
export const READ_FAILURE = "Memory read failed [cause: read_failed]; no partial result is shown. Ask the person to inspect the command and memory state.";
export class AgentReadFailure extends Error { constructor() { super(READ_FAILURE); this.name = "AgentReadFailure"; } }
export class AgentReadAmbiguous extends Error {
  constructor() { super("Memory read unavailable [cause: unavailable]; failure and policy withholding cannot be distinguished. Ask the person to run the same command from their own shell."); this.name = "AgentReadAmbiguous"; }
}
const RESULT_BYTES = 262_144;

/** A refusal decided from the parsed command alone, before any store or file is opened: safe to show as is. */
export class AgentUsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) { super(message); this.name = "AgentUsageError"; }
}
const accepts = (command: string, allowed: readonly string[]) => new AgentUsageError(allowed.length
  ? `agent-marked ${command} accepts only ${allowed.length === 1 ? allowed[0] : `${allowed.slice(0, -1).join(", ")} and ${allowed.at(-1)}`}.`
  : `agent-marked ${command} accepts no options.`);

type ReadCall = { tool: keyof ReturnType<typeof createMemoryMcp>["tools"]; args: Record<string, unknown> };

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** Convert only values already returned by the screened MCP handler. */
function screenedRow(value: unknown): HumanMemoryRow {
  const entry = object(value) ?? {}, run = object(entry.run), capture = object(entry.capture), view = object(entry.view) ?? entry;
  const evidence = entry.evidence === false ? ["not evidence"] : entry.evidence === true ? ["evidence"] : [];
  const score = typeof entry.score === "number" ? [`score ${entry.score}`] : [];
  if (run) {
    if (typeof run.first !== "string" || typeof run.to !== "string" || typeof run.count !== "number") throw new Error(UNAVAILABLE);
    return { id: run.first, kind: "tool run", at: run.to, text: `${run.count} tool events`, ...(typeof run.agent === "string" ? { peer: run.agent } : {}), flags: [...evidence, ...score] };
  }
  if (capture) {
    if (typeof capture.id !== "number" || typeof capture.at !== "string" || typeof capture.event !== "string" || typeof capture.excerpt !== "string") throw new Error(UNAVAILABLE);
    return { id: `capture:${capture.id}`, kind: "capture", at: capture.at, text: `${capture.event}: ${capture.excerpt}`, ...(typeof capture.agent === "string" ? { peer: capture.agent } : {}), flags: [...evidence, ...(capture.subagent === true ? ["subagent"] : []), ...score] };
  }
  if (typeof view.id !== "string" || typeof view.kind !== "string" || typeof view.at !== "string" || typeof view.text !== "string") throw new Error(UNAVAILABLE);
  const id = text(view.id), title = text(view.title), body = text(view.text);
  const stale = view.stale === true ? `(stale${view.staleReason === "missing_in_checkout" ? ": missing" : view.staleReason === "mtime_newer_than_note" ? ": newer" : ""})` : "";
  const folded = typeof entry.folded === "number" && entry.folded > 0 ? `+${entry.folded} same task` : "";
  return { id: entry.source === "repo" ? `repo:${id}` : id, kind: text(view.kind) || "entry", at: text(view.at), text: `${title ? `${title}: ` : ""}${body}`, ...(typeof view.tier === "string" ? { tier: view.tier } : {}), ...(typeof view.peer === "string" ? { peer: view.peer } : {}), ...(typeof view.scope === "string" ? { scope: view.scope } : {}), flags: [...evidence, ...(stale ? [stale] : []), ...(folded ? [folded] : []), ...score] };
}

function screenedDetail(value: unknown, columns: number, style: Style, now?: number): string {
  const outer = object(value), view = object(outer?.view) ?? outer;
  if (view && ["id", "text", "peer", "kind", "tier", "at", "scope", "project", "machine"].every(key => typeof view[key] === "string") && Array.isArray(view.about)) return memoryDetailText(view as unknown as View, { columns, style, actor: noteDisplayActor(view.peer as string), ...(now === undefined ? {} : { now }) });
  if (!outer) return "No entry.";
  const row = screenedRow(value), capture = object(outer.capture), record = capture ?? view ?? {};
  const fields: [string, string][] = [];
  if (typeof outer.evidence === "boolean") fields.push(["Evidence", outer.evidence ? "yes" : "no"]);
  if (capture?.subagent === true) fields.push(["Subagent", "yes"]);
  for (const [label, key] of [["Agent", "agent"], ["Session", "session"], ["Scope", "scope"]] as const) if (typeof record[key] === "string") fields.push([label, record[key] as string]);
  if (Array.isArray(record.paths)) fields.push(["Paths", record.paths.filter((item): item is string => typeof item === "string").join(", ")]);
  return memoryRecordText(row, { columns, style, ...(now === undefined ? {} : { now }) }, fields);
}

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

  const flags = Object.keys(options).filter(key => key !== "--json" && key !== "--policy-free" && key !== "--color" && key !== "--ascii");
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
  context: { cwd?: string; env?: Readonly<Record<string, string | undefined>>; columns?: number; style?: Style; now?: () => number },
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
    if (parsed.options["--json"] !== true && parsed.path[0] === "capacity" && value && typeof value === "object") {
      const shown = capacityText(value as CapacityReport, { columns: context.columns ?? 80, style: context.style ?? PLAIN });
      if (Buffer.byteLength(shown) > RESULT_BYTES) throw new Error(UNAVAILABLE);
      return shown;
    }
    if (parsed.options["--json"] !== true && ["list", "search", "show"].includes(parsed.path[0] ?? "")) {
      const columns = context.columns ?? 80, style = context.style ?? PLAIN, now = context.now?.();
      const rows = parsed.path[0] === "list" ? value : object(value)?.hits;
      if (parsed.path[0] !== "show" && !Array.isArray(rows)) throw new Error(UNAVAILABLE);
      const render = { columns, style, ...(now === undefined ? {} : { now }) };
      const scores = parsed.path[0] === "search" && parsed.options["--explain"] === true && Array.isArray(rows) ? rows.flatMap(item => { const details = object(object(item)?.scoreDetails); return details ? [{ id: screenedRow(item).id, details }] : []; }) : [];
      const engine = object(value)?.engine;
      const shown = parsed.path[0] === "show" ? screenedDetail(value, columns, style, now) : [memoryTableText(Array.isArray(rows) ? rows.map(screenedRow) : [], parsed.path[0] === "search" ? "Search" : "Memory", render, typeof engine === "string" ? `Engine: ${engine}` : undefined), memoryScoresText(scores, render)].filter(Boolean).join("\n\n");
      if (Buffer.byteLength(shown) > RESULT_BYTES) throw new Error(UNAVAILABLE);
      return shown;
    }
    return output;
  } catch (error) {
    if(safeProfileLockMessage(error))throw error;
    // The MCP handler deliberately uses one refusal for policy and operational guards; do not guess which occurred.
    let ambiguous = false;
    try { ambiguous = error instanceof Error && Object.getOwnPropertyDescriptor(error, "message")?.value === "memory operation unavailable"; } catch { /* An opaque error remains a generic failure. */ }
    if (ambiguous) throw new AgentReadAmbiguous();
    throw new AgentReadFailure();
  } finally {
    try { memory?.close(); } catch { /* close failures do not expose partial reads */ }
  }
}
