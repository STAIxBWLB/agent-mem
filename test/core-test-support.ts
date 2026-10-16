import { rawMemoryCommand, rawGoalCommand, type MemoryCommandOptions, type GoalCommandOptions } from "../src/memory/commands.ts";
import { MemoryStore } from "../src/memory/store.ts";

/** Fixtures inject policy explicitly; agent-hub policy/config and shell authority are outside this package. */
export const memoryCommand = (args: string[], cwd: string, opts: Partial<MemoryCommandOptions> = {}) => rawMemoryCommand(args, cwd, {
  open: () => new MemoryStore(), readable: rows => rows, importPolicy: () => () => false, ...opts,
});
export const goalCommand = (args: string[], cwd: string, opts: Partial<GoalCommandOptions> = {}) => rawGoalCommand(args, cwd, {
  open: () => new MemoryStore(), clean: () => true, ...opts,
});
