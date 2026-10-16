import { GOAL_STATES, KINDS } from "./memory/store.ts";

export interface OptionDefinition { description: string; value?: "text" | "path" | readonly string[] }
export interface ArgumentDefinition { name: string; values?: readonly string[]; path?: boolean; variadic?: boolean }
export interface CommandDefinition {
  description: string;
  options?: Record<string, OptionDefinition>;
  args?: readonly ArgumentDefinition[];
  commands?: Record<string, CommandDefinition>;
  mutates?: boolean | "apply" | "label";
  policyFree?: boolean;
  defaultCommand?: string;
}
const flag = (description: string): OptionDefinition => ({ description });
const text = (description: string): OptionDefinition => ({ description, value: "text" });
const json = { "--json": flag("Print JSON where supported") };
const policy = { "--policy-free": flag("Explicitly bypass host privacy policy") };
const filters = { ...json, "--tier": { description: "Memory tier", value: ["short", "long"] } as OptionDefinition,
  "--kind": { description: "Note kind", value: KINDS }, "--peer": text("Author peer"), "--machine": text("Machine ID"),
  "--since": text("ISO date or time"), "--limit": text("Maximum results") };
export const GLOBAL_OPTIONS = { "--help": flag("Show help") };
export const ROOT_OPTIONS = { "--version": flag("Show version"), ...json };
export const COMMANDS: Record<string, CommandDefinition> = {
  list: { description: "List memory", options: filters },
  search: { description: "Search memory", options: filters, args: [{ name: "words", variadic: true }] },
  show: { description: "Show a note", options: json, args: [{ name: "id" }] },
  graph: { description: "Show a graph", options: { ...json, "--hops": { description: "Graph depth", value: ["1", "2"] } }, args: [{ name: "id-or-node" }] },
  suggestions: { description: "List pending suggestions", options: json },
  confirm: { description: "Confirm a suggestion", options: json, args: [{ name: "id" }], mutates: true },
  reject: { description: "Reject a suggestion", options: json, args: [{ name: "id" }], mutates: true },
  promote: { description: "Promote a note", options: { ...json, ...policy }, args: [{ name: "id" }], mutates: true, policyFree: true },
  demote: { description: "Demote a note", options: json, args: [{ name: "id" }], mutates: true },
  forget: { description: "Forget a note", options: json, args: [{ name: "id" }], mutates: true },
  supersede: { description: "Replace a note", options: json, args: [{ name: "old-id" }, { name: "new-id" }], mutates: true },
  rebuild: { description: "Rebuild the derived index", options: json, mutates: true },
  dedupe: { description: "Preview duplicate reconciliation", options: { ...json, "--apply": flag("Append reconciliation operations") }, mutates: "apply" },
  sync: { description: "Sync a private remote", options: { ...json, ...policy, "--remote": text("Private git URL") }, mutates: true, policyFree: true },
  machine: { description: "Show or label this machine", options: { ...json, "--label": text("Machine label") }, mutates: "label" },
  import: { description: "Import external memory", options: { ...json, ...policy, "--db": { description: "SQLite database file", value: "path" }, "--limit": text("Maximum observations"), "--restart": flag("Restart import cursor") }, mutates: true, policyFree: true,
    commands: { "claude-mem": { description: "Import claude-mem observations" } } },
  goal: { description: "Long-term goals", options: json, defaultCommand: "list", commands: {
    list: { description: "List goals", options: { "--all": flag("Include completed goals") } },
    show: { description: "Show a goal", args: [{ name: "id" }] },
    new: { description: "Create a goal", options: { "--milestone": text("Milestone"), "--depends": text("Dependency goal ID"), "--shared": flag("Share across projects") }, args: [{ name: "title", variadic: true }], mutates: true },
    link: { description: "Link through ahub goal link", args: [{ name: "id" }, { name: "task-id" }], mutates: true },
    state: { description: "Set goal state", args: [{ name: "id" }, { name: "state", values: GOAL_STATES }], mutates: true },
    done: { description: "Complete a goal", args: [{ name: "id" }], mutates: true },
    take: { description: "Take a goal lease", options: { "--force": flag("Override the prior lease") }, args: [{ name: "id" }], mutates: true },
  } },
  review: { description: "Review machine-local non-evidentiary candidates", options: json, defaultCommand: "list", commands: {
    list: { description: "List review candidates", options: {
      "--status": { description: "Candidate status", value: ["pending", "accepting", "accepted", "rejected", "all"] },
      "--kind": { description: "Candidate kind", value: ["correction", "fail", "decay"] }, "--limit": text("Maximum candidates (1..500)"),
    } },
    accept: { description: "Accept one candidate through the current memory policy", options: policy, args: [{ name: "full-candidate-id" }], mutates: true, policyFree: true },
    reject: { description: "Reject one candidate", args: [{ name: "full-candidate-id" }], mutates: true },
  } },
  migrate: { description: "Select a person-approved generation or deactivate it", mutates: true, options: {
    ...json, "--dry-run": flag("Read-only migration receipt"), "--generation": text("Explicit 32-hex generation ID"),
    "--resume": flag("Resume the recorded migration"), "--deactivate": flag("Select shared v1 without deleting a generation"),
  } },
  prune: { description: "Plan or apply exact-entry durable expiry in a generation", mutates: true, options: {
    ...json, "--cutoff": text("Canonical UTC expiry cutoff"), "--dry-run": flag("Print a local sealed plan without writes"),
    "--apply": flag("Apply the exact local plan"), "--plan": { description: "Sealed local plan JSON file", value: "path" },
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
      const child: CommandDefinition | undefined = definition.commands[token];
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

export function commandHelp(): string {
  return ["usage: amem <command> [options]", "  [--help] [--version] [--json]", ...completionDefinitions().filter(row => row.path.length).map(row => {
    const names = [...row.path, ...row.args.map(arg => `<${arg.name}>`)].join(" ");
    return `  ${names}${Object.entries(row.options).map(([name, option]) => ` [${name}${option.value === undefined ? "" : ` <${Array.isArray(option.value) ? option.value.join("|") : option.value}>`}]`).join("")}`;
  }), "--policy-free: use ahub memory for the host's privacy policy.", "Mutating commands require a terminal on stdin. Agents use the hub's hub_memory_* tools."].join("\n");
}
