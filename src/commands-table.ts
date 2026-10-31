import { HOOK_EVENTS } from "./hook-contract.ts";
import { GOAL_STATES, KINDS } from "./memory/store.ts";

export interface OptionDefinition { description: string; value?: "text" | "path" | readonly string[] }
export interface ArgumentDefinition { name: string; values?: readonly string[]; path?: boolean; variadic?: boolean }
export interface CommandDefinition {
  description: string;
  options?: Record<string, OptionDefinition>;
  args?: readonly ArgumentDefinition[];
  commands?: Record<string, CommandDefinition>;
  /** `confirm`: previews without `--confirm` (a read), and mutates with it (#15 T5: gc, project forget, capacity apply). */
  mutates?: boolean | "apply" | "label" | "confirm";
  policyFree?: boolean;
  defaultCommand?: string;
}
const flag = (description: string): OptionDefinition => ({ description });
const text = (description: string): OptionDefinition => ({ description, value: "text" });
const json = { "--json": flag("Print JSON where supported") };
const history = { "--history": flag("Read retained supersession/expiry history; forgotten text stays hidden"), "--as-of": text("Past canonical UTC date or timestamp; current forget/prune masks still apply") };
const policy = { "--policy-free": flag("Accepted and ignored: the configured privacy policy always applies") };
const filters = { ...json, "--tier": { description: "Memory tier", value: ["short", "long"] } as OptionDefinition,
  "--kind": { description: "Note kind", value: KINDS }, "--peer": text("Author peer"), "--machine": text("Machine ID"),
  "--since": text("ISO date or time"), "--limit": text("Maximum results") };
export const GLOBAL_OPTIONS = { "--help": flag("Show help") };
export const ROOT_OPTIONS = { "--version": flag("Show version"), ...json };
export const COMMANDS: Record<string, CommandDefinition> = {
  consolidate: { description: "Queue deterministic project-local consolidation candidates; curated notes change only after explicit acceptance", mutates: true, options: { ...json, "--project": text("The current project's key; another project is refused (run from its directory)") } },
  setup: { description: "Preview reversible MCP setup and supported capture hooks for native coding CLIs, or the acon console plugin manifest (console); apply and undo use explicit flags", options: { ...json, "--apply": flag("Apply the previewed setup"), "--undo": flag("Restore the original configuration") }, args: [{ name: "target", values: ["claude", "codex", "kimi", "pi", "qwen", "jcode", "opencode", "gemini", "agy", "all", "console"] }] },
  mcp: { description: "Run the project-bound MCP stdio server for this session" },
  hook: { description: "Run a fail-open, context-only Claude Code hook", args: [{ name: "event", values: [...HOOK_EVENTS] }] },
  ingest: { description: "Incrementally capture native session transcripts without a watcher", options: { ...json, "--since": text("ISO date or time") }, args: [{ name: "kind", values: ["codex", "kimi", "pi", "qwen"] }] },
  "vault-candidates": { description: "List screened durable curated vault candidates (per project, or across projects)", options: { ...json, "--limit": text("Maximum candidates per project (1..100)"),
    "--all-projects": flag("List every active project's candidates; the reply says it crossed projects"), "--project": text("List one named project's candidates") } },
  list: { description: "List memory", options: { ...filters, ...history } },
  search: { description: "Rank current curated project notes; history/as-of and empty queries retain newest-first filtering", options: { ...filters, ...history,
    "--filter": flag("Current-project curated notes: match every word as a substring, newest first; not with --all-projects"), "--explain": flag("Include the score factors for ranked project-local results"), "--all-projects": flag("Search every active project; the reply says it crossed projects"),
    "--include-archived": flag("With --all-projects, also read archived projects") }, args: [{ name: "words", variadic: true }] },
  brief: { description: "Read intent/path memory: fails first, then decisions and contracts; untrusted data within a UTF-8 byte cap", options: { ...json,
    "--for": text("Explicit intent"), "--paths": text("Repeatable named path"), "--symbols": text("Repeatable named symbol"), "--bytes": text("Complete brief-body byte cap (1..8192, default 2048)") } },
  projects: { description: "List the project shards of this memory home (#15 D3)", options: { ...json, "--all": flag("Include forgotten projects (archived ones are always listed)") } },
  usage: { description: "Totals and the largest project shards", options: { ...json, "--limit": text("Largest shards to list (1..100)"), "--all": flag("Include forgotten projects") } },
  eval: { description: "Replay a local question set against ranked store.search and report recall@k and MRR (no model, no network; the built-in synthetic set without --set, `--set ko` for the built-in Korean one)", options: { ...json,
    "--set": { description: "`ko` (the built-in Korean set) or a question set file (amem.eval/v1); with entries it is self-contained, without them its ids name entries of this project", value: "path" }, "--k": text("Cutoffs, comma separated (default 1,5,10; each 1..100)") } },
  gc: { description: "Apply each shard's retention and cap across shards in bounded batches (preview without --confirm)", mutates: "confirm", options: {
    ...json, "--confirm": flag("Evict now; without it, preview only"), "--batches": text("evict() windows per shard in this run (1..1000, default 1)") } },
  project: { description: "Per-project lifecycle and portable import/export (#15 D3, F17): one project only", options: json, commands: {
    export: { description: "Write one project's capture, curated notes, goals and work lists to a new JSON, JSONL or Markdown file (never overwrites)", options: { "--to": { description: "Destination file, outside the memory home", value: "path" }, "--format": { description: "Portable format (default json)", value: ["json", "jsonl", "markdown"] }, ...policy },
      args: [{ name: "key" }] },
    import: { description: "Preview or re-import curated notes from a JSONL project export with their original entry ids", options: { "--from": { description: "JSONL project export", value: "path" }, "--confirm": flag("Write after the preview; without it, preview only"), "--allow-shared": flag("Explicitly permit shared-scope notes from this file"), ...policy }, args: [{ name: "key" }], mutates: "confirm", policyFree: true },
    archive: { description: "Take a cold project out of recall (append-only op; unarchive brings it back)", args: [{ name: "key" }], mutates: true },
    unarchive: { description: "Bring an archived project back into recall (append-only op)", args: [{ name: "key" }], mutates: true },
    forget: { description: "Forget one project for good (append-only op; preview without --confirm)", options: { "--confirm": flag("Record the forget after the preview") }, args: [{ name: "key" }], mutates: "confirm" },
  } },
  show: { description: "Show a note", options: { ...json, ...history }, args: [{ name: "id" }] },
  graph: { description: "Show a graph", options: { ...json, ...history, "--hops": { description: "Graph depth", value: ["1", "2"] } }, args: [{ name: "id-or-node" }] },
  suggestions: { description: "List pending suggestions", options: json },
  confirm: { description: "Confirm a suggestion", options: json, args: [{ name: "id" }], mutates: true },
  reject: { description: "Reject a suggestion", options: json, args: [{ name: "id" }], mutates: true },
  promote: { description: "Promote a note (--to repo: append its screened line to this repository's .amem/log.jsonl)", options: { ...json, ...policy, "--to": { description: "Promote into the repository scope", value: ["repo"] },
    "--confirm": flag("With --to repo: append the previewed line"), "--confirm-public": text("With --to repo, unless the repository is verified private: the first 8 characters of the entry id") }, args: [{ name: "id" }], mutates: true, policyFree: true },
  repo: { description: "The repository scope (#15 D6): this repository's .amem/log.jsonl", options: json, defaultCommand: "status", commands: {
    status: { description: "Show the repository log, its entries and what the screen withheld" },
    attributes: { description: "Add the merge=union entry for .amem/log.jsonl to .gitattributes (preview without --confirm; never committed)", mutates: "confirm", options: { "--confirm": flag("Write after the preview") } },
  } },
  demote: { description: "Demote a note", options: json, args: [{ name: "id" }], mutates: true },
  forget: { description: "Forget a note", options: json, args: [{ name: "id" }], mutates: true },
  note: { description: "Write curated notes through the configured policy (F6)", options: json, commands: {
    add: { description: "Add one curated note: text as arguments, `-` to type it on the terminal until end of input, or no text to open $EDITOR. A fail note takes --approach, --symptom, --cause, --evidence (repeatable) and --retry-when", mutates: true, options: {
      "--kind": { description: "Note kind (default finding)", value: KINDS }, "--tier": { description: "Memory tier (default long)", value: ["short", "long"] },
      "--scope": { description: "Scope (default project)", value: ["project", "shared"] }, "--title": text("One-line title"),
      "--approach": text("fail: what was tried"), "--symptom": text("fail: what went wrong"), "--cause": text("fail: why"), "--evidence": text("fail: a reference (repeatable)"), "--retry-when": text("fail: what would make the approach worth retrying") },
      args: [{ name: "text", variadic: true }] },
  } },
  supersede: { description: "Replace a note", options: json, args: [{ name: "old-id" }, { name: "new-id" }], mutates: true },
  rebuild: { description: "Rebuild the derived index", options: json, mutates: true },
  dedupe: { description: "Preview duplicate reconciliation", options: { ...json, "--apply": flag("Append reconciliation operations") }, mutates: "apply" },
  sync: { description: "Sync a private remote (--if-due: only when the schedule and the failure backoff allow it; --force ignores both)", options: { ...json, ...policy, "--remote": text("Private git URL"),
    "--if-due": flag("Sync only when due (hourly after a success, 15 minutes doubling to a day after failures); stops after 30 seconds"), "--force": flag("With --if-due: ignore the schedule and the backoff") }, mutates: true, policyFree: true },
  machine: { description: "Show or label this machine", options: { ...json, "--label": text("Machine label") }, mutates: "label" },
  import: { description: "Import external memory", options: { ...json, ...policy, "--db": { description: "SQLite database file", value: "path" }, "--limit": text("Maximum observations"), "--restart": flag("Restart import cursor"), "--capture-days": text("Import recent claude-mem observations and summaries into capture") }, mutates: true, policyFree: true,
    commands: {
      "claude-mem": { description: "Import claude-mem observations", options: { "--db": { description: "SQLite database file", value: "path" }, "--limit": text("Maximum observations"), "--restart": flag("Restart import cursor"), "--capture-days": text("Import recent observations and summaries into capture") } },
      "claude-auto": { description: "Import Claude Code auto memory as review candidates; CLAUDE.md and AGENTS.md stay excluded", options: { "--from": { description: "Claude projects directory (default ~/.claude/projects)", value: "path" } } },
      codex: { description: "Import Codex memories as review candidates; originals stay unchanged", options: { "--from": { description: "Codex memories directory (default ~/.codex/memories)", value: "path" } } },
    } },
  goal: { description: "Long-term goals", options: json, defaultCommand: "list", commands: {
    list: { description: "List goals", options: { "--all": flag("Include completed goals") } },
    show: { description: "Show a goal", args: [{ name: "id" }] },
    new: { description: "Create a goal", options: { "--milestone": text("Milestone"), "--depends": text("Dependency goal ID"), "--shared": flag("Share across projects") }, args: [{ name: "title", variadic: true }], mutates: true },
    link: { description: "Link a goal to a task of a host that has a task board (not available in amem alone)", args: [{ name: "id" }, { name: "task-id" }], mutates: true },
    state: { description: "Set goal state", args: [{ name: "id" }, { name: "state", values: GOAL_STATES }], mutates: true },
    done: { description: "Complete a goal", args: [{ name: "id" }], mutates: true },
    take: { description: "Take a goal lease", options: { "--force": flag("Override the prior lease") }, args: [{ name: "id" }], mutates: true },
  } },
  review: { description: "Review machine-local non-evidentiary candidates", options: json, defaultCommand: "list", commands: {
    list: { description: "List review candidates", options: {
      "--status": { description: "Candidate status", value: ["pending", "accepting", "accepted", "rejected", "all"] },
      "--kind": { description: "Candidate kind", value: ["correction", "fail", "decay", "memory", "promotion", "consolidation", "model-answer"] }, "--limit": text("Maximum candidates (1..500)"),
    } },
    accept: { description: "Accept one candidate through the current memory policy", options: { ...policy, "--kind": { description: "Require the selected candidate kind", value: ["correction", "fail", "decay", "memory", "promotion", "consolidation", "model-answer"] } }, args: [{ name: "full-candidate-id" }], mutates: true, policyFree: true },
    reject: { description: "Reject one candidate", args: [{ name: "full-candidate-id" }], mutates: true },
    walk: { description: "Walk the pending candidates one by one: accept, edit (as a new note), reject, skip or quit", mutates: true, options: { "--kind": { description: "Candidate kind", value: ["correction", "fail", "decay", "memory", "promotion", "consolidation", "model-answer"] } } },
  } },
  decay: { description: "Preview old live long-term notes unprotected by open goals; apply only with --apply --confirm", mutates: "apply", options: {
    ...json, "--days": text("Age in whole days (default 90)"), "--apply": flag("Preview exact revisions; combine with --confirm to apply"), "--confirm": flag("Apply the exact revision preview with --apply"), "--forget": flag("Explicitly forget instead of demoting; confirmation names this action") }, args: [{ name: "id", variadic: true }] },
  migrate: { description: "Preview a generation migration; apply only with --apply, or deactivate it explicitly", mutates: "apply", options: {
    ...json, "--apply": flag("Apply the previewed migration"), "--dry-run": flag("Read-only migration receipt (default; kept as an alias)"), "--generation": text("Explicit 32-hex generation ID"),
    "--resume": flag("Resume the recorded migration"), "--deactivate": flag("Select shared v1 without deleting a generation"),
    "--shards": flag("Migrate the curated home into project and user shards"),
    "--public-prune-view": flag("Enable the forward-only v2 public prune view on an active split"),
  } },
  status: { description: "Report shard migration and pending old-layout appends", options: json },
  doctor: { description: "One read-only report (F15): duplicates and stale notes, pending candidates, capture freshness per CLI, the brief's token cost, index equals rebuild, reader leases, the policy in effect, ingest and sync cadence", options: json },
  prune: { description: "Plan or apply exact-entry durable expiry in a generation", mutates: true, options: {
    ...json, "--cutoff": text("Canonical UTC expiry cutoff"), "--dry-run": flag("Print a local sealed plan without writes"),
    "--user": flag("Select the user shard explicitly after a curated split (default: current project)"),
    "--apply": flag("Apply the exact local plan"), "--plan": { description: "Sealed local plan JSON file", value: "path" },
  } },
  capacity: { description: "Report capture use and propose R6 bounds (R7)", options: { ...json, "--disk-share": text("Disk-share bound for the proposal (default 0.02)") }, commands: {
    apply: { description: "Write the proposed (or given) bounds to the home capture config, or with --split each shard's share of the global budget", mutates: true, options: {
      ...json, "--cap-mb": text("Capture cap in MB"), "--retention-days": text("Capture retention in days"), "--confirm": flag("Write after the preview"),
      "--split": flag("Write the per-shard split of the global budget to each shard's own config") } },
  } },
  alias: { description: "Explicit project key aliases (#15 D2)", options: json, defaultCommand: "list", commands: {
    list: { description: "List alias ops" },
    add: { description: "Map one key onto its canonical key (append-only op)", args: [{ name: "from-key" }, { name: "to-key" }], mutates: true },
    remove: { description: "Remove an alias so the key resolves to itself again (append-only op, the latest wins)", args: [{ name: "alias-key" }], mutates: true },
  } },
  completion: { description: "Print static shell completion", args: [{ name: "shell", values: ["zsh", "bash", "fish"] }] },
  help: { description: "Show help" }, version: { description: "Show version" },
};

export interface CompletionDefinition { path: string[]; options: Record<string, OptionDefinition>; args: ArgumentDefinition[]; children: string[] }
export function completionDefinitions(): CompletionDefinition[] {
  const rows: CompletionDefinition[] = [{ path: [], options: { ...GLOBAL_OPTIONS, ...ROOT_OPTIONS, ...COMMANDS.list!.options }, args: [], children: Object.keys(COMMANDS) }];
  const walk = (commands: Record<string, CommandDefinition>, path: string[], inherited: Record<string, OptionDefinition>) => {
    for (const [name, command] of Object.entries(commands)) {
      const next = [...path, name], ownOptions = { ...inherited, ...command.options };
      const options = { ...ownOptions, ...(command.defaultCommand ? command.commands?.[command.defaultCommand]?.options : {}) };
      rows.push({ path: next, options, args: [...command.args ?? []], children: Object.keys(command.commands ?? {}) });
      if (command.commands) walk(command.commands, next, ownOptions);
    }
  };
  walk(COMMANDS, [], GLOBAL_OPTIONS); return rows;
}
export interface ParsedCommand { path: string[]; definition: CommandDefinition; options: Record<string, string | boolean>; positionals: string[]; rawArgs: string[] }

/** Pure validation, shared definitions with help/completion; no store, files or network. */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const tokens = argv.flatMap(token => {
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    return equals >= 0 ? [token.slice(0, equals), token.slice(equals + 1)] : [token];
  });
  const path: string[] = [], options: Record<string, string | boolean> = {}, positionals: string[] = [];
  let definition: CommandDefinition = { description: "amem", commands: COMMANDS };
  let available: Record<string, OptionDefinition> = { ...GLOBAL_OPTIONS, ...ROOT_OPTIONS, ...COMMANDS.list!.options };
  const commandIndexes = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("--")) {
      const option = available[token];
      if (!option) throw new Error(`unknown option ${token}`);
      if (option.value !== undefined) {
        const value = tokens[++i];
        if (value === undefined || value.startsWith("--")) throw new Error(`${token} needs a value`);
        if (Array.isArray(option.value) && !option.value.includes(value)) throw new Error(`${token} takes ${option.value.join(" or ")}`);
        options[token] = value;
      } else options[token] = true;
    } else if (definition.commands) {
      const child: CommandDefinition | undefined = Object.hasOwn(definition.commands, token) ? definition.commands[token] : undefined;
      if (!child) throw new Error(`unknown command ${[...path, token].join(" ")}`);
      commandIndexes.add(i);
      definition = { ...definition, ...child }; path.push(token);
      // Child metadata inherits policy, but its command children belong only to that child.
      definition.commands = child.commands;
      available = completionDefinitions().find(row => row.path.join(" ") === path.join(" "))!.options;
    } else positionals.push(token);
  }
  if (!path.length) {
    const name = options["--version"] === true ? "version" : "list";
    path.push(name); definition = COMMANDS[name]!;
  }
  if (definition.defaultCommand && definition.commands) {
    const name = definition.defaultCommand; definition = { ...definition, ...definition.commands[name]!, commands: undefined }; path.push(name);
  }
  if (positionals.length > (definition.args?.length ?? 0) && !definition.args?.at(-1)?.variadic) throw new Error(`too many arguments for ${path.join(" ")}`);
  for (let i = 0; i < positionals.length; i++) {
    const argument = definition.args?.[i];
    if (argument?.values && !argument.values.includes(positionals[i]!)) throw new Error(`${argument.name} takes ${argument.values.join(" or ")}`);
  }
  const allowed = path[0] === "version" && options["--version"] === true ? completionDefinitions()[0]!.options : completionDefinitions().find(row => row.path.join(" ") === path.join(" "))!.options;
  for (const name of Object.keys(options)) if (!allowed[name]) throw new Error(`unknown option ${name} for ${path.join(" ")}`);
  const rawArgs = [...(path[0] === "goal" ? path.slice(1) : path), ...tokens.filter((arg, index) => arg !== "--policy-free" && !commandIndexes.has(index))];
  return { path, definition, options, positionals, rawArgs };
}

const optionLabel = (name: string, option: OptionDefinition) =>
  `${name}${option.value === undefined ? "" : ` <${Array.isArray(option.value) ? option.value.join("|") : option.value}>`}`;
const usageRow = (row: CompletionDefinition) =>
  `${[...row.path, ...row.args.map(arg => `<${arg.name}>`)].join(" ")}${Object.entries(row.options).map(([name, option]) => ` [${optionLabel(name, option)}]`).join("")}`;
const described = (rows: [string, string][]) => {
  // Long enum labels (review --kind) would push every description far right; they overflow instead.
  const width = Math.min(24, Math.max(...rows.map(([label]) => label.length)));
  return rows.map(([label, description]) => `  ${label.padEnd(width)}  ${description}`);
};

/** Full command list, or one command's help when argv names a command path (defaultCommand is not applied). */
export function commandHelp(argv: readonly string[] = []): string {
  const path: string[] = [], rows = completionDefinitions();
  let commands: Record<string, CommandDefinition> | undefined = COMMANDS, command: CommandDefinition | undefined, row = rows[0]!;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      // An option's value is never a command name.
      if (!token.includes("=") && row.options[token]?.value !== undefined) i++;
      continue;
    }
    if (!commands || !Object.hasOwn(commands, token)) break;
    command = commands[token]!; path.push(token); commands = command.commands;
    row = rows.find(candidate => candidate.path.join(" ") === path.join(" "))!;
  }
  if (command && path[0] !== "help") {
    const lines = [`usage: amem ${usageRow(row)}`, "", command.description, "", "options:", ...described(Object.entries(row.options).map(([name, option]) => [optionLabel(name, option), option.description]))];
    if (command.commands) lines.push("", "commands:", ...described(Object.entries(command.commands).map(([name, child]) => [name, child.description])));
    return lines.join("\n");
  }
  return ["usage: amem <command> [options]", "  [--help] [--version] [--json]", ...completionDefinitions().filter(row => row.path.length).map(row => `  ${usageRow(row)}`),
    "--policy-free: accepted and ignored; the configured privacy policy (amem.config.json in the memory home, narrowed by .amem/config) always applies.", "Agent-marked reads use the MCP privacy ceiling. Explicit apply/confirm flags do not require a terminal; review walk and the note editor remain interactive."].join("\n");
}
