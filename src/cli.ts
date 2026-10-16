import { readFileSync } from "node:fs";
import { MemoryStore, looksSecret } from "./memory/store.ts";
import { MEMORY_USAGE, GOAL_USAGE, rawMemoryCommand, rawGoalCommand } from "./memory/commands.ts";

export const PERSON_ONLY = "amem is for the person; agents read memory through the hub's hub_memory_* tools";
const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const MEMORY_COMMANDS = new Set(["list", "search", "show", "graph", "suggestions", "confirm", "reject", "promote", "demote", "forget", "supersede", "rebuild", "dedupe", "sync", "machine", "import"]);
const READS = new Set(["list", "search", "show", "graph", "suggestions"]);
const usage = () => [MEMORY_USAGE.replace("ahub memory", "amem"), GOAL_USAGE.replace("ahub goal", "amem goal"),
  "--policy-free: explicitly bypass host privacy policy for promote, import claude-mem or sync; ahub memory applies the host policy.",
  "Mutating commands require a terminal on stdin. Agents use the hub's hub_memory_* tools."].join("\n");

export interface CliContext { cwd?: string; env?: Readonly<Record<string, string | undefined>>; stdinTTY?: boolean }

/** Honest native-shell defaults, matching every marker detectCliIdentity treats as non-console (invalid included). */
export function agentMarked(env: Readonly<Record<string, string | undefined>>): boolean {
  return ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].some(key => env[key] !== undefined);
}

export async function runCli(argv: readonly string[], context: CliContext = {}): Promise<string> {
  if (agentMarked(context.env ?? process.env)) throw new Error(PERSON_ONLY);
  if (argv[0] === "--version" || argv[0] === "version") return `amem ${VERSION}`;
  if (argv[0] === "--help" || argv[0] === "help" || argv.includes("--help")) return usage();
  const policyFree = argv.includes("--policy-free");
  const args = argv.filter(arg => arg !== "--policy-free");
  const goal = args[0] === "goal";
  if (goal) args.shift();
  const first = args.find(arg => arg !== "--json");
  const sub = first && !first.startsWith("--") ? first : "list";
  if (!goal && !MEMORY_COMMANDS.has(sub) && !sub.startsWith("--")) throw new Error(usage());
  if (goal && !["list", "show", "new", "link", "state", "done", "take"].includes(sub) && !sub.startsWith("--")) throw new Error(usage());
  const mutating = goal ? !["list", "show"].includes(sub)
    : !READS.has(sub) && !(sub === "machine" && !args.includes("--label")) && !(sub === "dedupe" && !args.includes("--apply"));
  if (mutating && !(context.stdinTTY ?? process.stdin.isTTY)) throw new Error("mutating commands require a terminal on stdin");
  if (!goal && ["promote", "import", "sync"].includes(sub) && !policyFree) {
    throw new Error(`${sub} requires --policy-free; use ahub memory ${sub} to apply the host's privacy policy`);
  }
  // ponytail: board task links need the host's authenticated task boundary; add a host bridge before supporting them here.
  if (goal && sub === "link") throw new Error("goal link needs host integration; use ahub goal link");
  const crosses = !goal && ["promote", "import", "sync"].includes(sub) && policyFree;
  // Reads can trigger held-note reconciliation. Defer it unless this terminal explicitly authorized crossing policy.
  const open = () => new MemoryStore({ screen: note => !crosses ? "skip" : looksSecret(`${note.title ?? ""}\n${note.text}`) ? "keep" : "promote" });
  const cwd = context.cwd ?? process.cwd();
  // A person's reads are unscreened. Writes crossing the boundary remain secret-screened without host policy.
  return goal
    ? rawGoalCommand(args, cwd, { open, clean: (title, milestones) => ["list", "show"].includes(sub) || !looksSecret(`${title}\n${milestones.join("\n")}`) })
    : rawMemoryCommand(args, cwd, { open, readable: notes => notes, importPolicy: () => () => false });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try { console.log(await runCli(argv)); }
  catch (error) { console.error(`amem: ${(error as Error).message}`); process.exitCode = 1; }
}

if (import.meta.main) await main();
