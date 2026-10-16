import { readFileSync } from "node:fs";
import { MemoryStore, looksSecret } from "./memory/store.ts";
import { rawMemoryCommand, rawGoalCommand } from "./memory/commands.ts";

import { commandHelp, parseCommand } from "./commands-table.ts";
import { completionScript } from "./completion.ts";

export const PERSON_ONLY = "amem is for the person; agents read memory through the hub's hub_memory_* tools";
const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
export interface CliContext { cwd?: string; env?: Readonly<Record<string, string | undefined>>; stdinTTY?: boolean }

/** Honest native-shell defaults, matching every marker detectCliIdentity treats as non-console (invalid included). */
export function agentMarked(env: Readonly<Record<string, string | undefined>>): boolean {
  return ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].some(key => env[key] !== undefined);
}

export async function runCli(argv: readonly string[], context: CliContext = {}): Promise<string> {
  if (agentMarked(context.env ?? process.env)) throw new Error(PERSON_ONLY);
  if (argv[0] === "--version" || argv[0] === "version") return `amem ${VERSION}`;
  if (argv[0] === "--help" || argv[0] === "help" || argv.includes("--help")) return commandHelp();
  let parsed;
  try {
    parsed = parseCommand(argv);
    if (parsed.path[0] === "version") return `amem ${VERSION}`;
    if (parsed.path[0] === "completion") {
      if (parsed.positionals.length !== 1) throw new Error("usage: amem completion zsh|bash|fish");
      return completionScript(parsed.positionals[0]!);
    }
  } catch (error) {
    if (argv.find(arg => !arg.startsWith("--")) === "completion") Object.assign(error as Error, { exitCode: 2 });
    throw error;
  }
  const { definition, options, rawArgs: args } = parsed;
  const goal = parsed.path[0] === "goal", sub = goal ? parsed.path[1]! : parsed.path[0]!;
  const policyFree = options["--policy-free"] === true;
  const mutating = definition.mutates === true || definition.mutates === "apply" && options["--apply"] === true || definition.mutates === "label" && options["--label"] !== undefined;
  if (mutating && !(context.stdinTTY ?? process.stdin.isTTY)) throw new Error("mutating commands require a terminal on stdin");
  if (definition.policyFree && !policyFree) {
    throw new Error(`${sub} requires --policy-free; use ahub memory ${sub} to apply the host's privacy policy`);
  }
  // ponytail: board task links need the host's authenticated task boundary; add a host bridge before supporting them here.
  if (goal && sub === "link") throw new Error("goal link needs host integration; use ahub goal link");
  const crosses = definition.policyFree === true && policyFree;
  // Reads can trigger held-note reconciliation. Defer it unless this terminal explicitly authorized crossing policy.
  const open = () => new MemoryStore({ screen: note => !crosses ? "skip" : looksSecret(`${note.title ?? ""}\n${note.text}`) ? "keep" : "promote" });
  const cwd = context.cwd ?? process.cwd();
  // A person's reads are unscreened. Writes crossing the boundary remain secret-screened without host policy.
  return goal
    ? rawGoalCommand(args, cwd, { open, clean: (title, milestones) => !mutating || !looksSecret(`${title}\n${milestones.join("\n")}`) })
    : rawMemoryCommand(args, cwd, { open, readable: notes => notes, importPolicy: () => () => false });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try { console.log(await runCli(argv)); }
  catch (error) { console.error(`amem: ${(error as Error).message}`); process.exitCode = (error as { exitCode?: number }).exitCode ?? 1; }
}

if (import.meta.main) await main();
