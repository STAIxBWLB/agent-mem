/**
 * #462: cooperative slicing for long synchronous placement-sync loops. A library caller (the hub daemon, the MCP
 * server, the CLI) shares its event loop with `syncMemory`; every loop that can run per row, per object or per file
 * awaits this between items so the caller's loop gets control back at least every `PLACEMENT_SLICE_MS` of work.
 *
 * Yielding never changes a result: every fence and proof check that guarded the next item still runs after the
 * yield, exactly as before. Only scheduling changes.
 *
 * ponytail: the slice is checked between items, so one item's own cost (one complete writer proof, one Git history
 * tree) is the floor of the longest stretch. Moving per-item proofs off the caller's thread is the upgrade path.
 */
export const PLACEMENT_SLICE_MS = 50;

/** A time-budgeted yield point: cheap when the slice has room left, one macrotask turn when it has run out. */
export type CooperativeYield = () => Promise<void>;

export function cooperativeYield(budgetMs = PLACEMENT_SLICE_MS, now: () => number = () => performance.now()): CooperativeYield {
  let started = now();
  return async () => {
    if (now() - started < budgetMs) return;
    await new Promise<void>(resolve => setImmediate(resolve));
    started = now();
  };
}

/** One unconditional macrotask turn, placed between discrete heavy steps (a journal read, a writer proof, a capture). */
export const yieldTurn = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

/** Journal records per atomic batch append before the next turn; the on-disk layout is the same as one batch (greedy chunk fill). */
export const PLACEMENT_APPEND_SLICE = 50;

/**
 * #470: a heavy pure function is written once as a step generator and driven two ways, so the synchronous API keeps its
 * signature and the placement sync awaits a turn between steps. `drainSteps` ignores the step boundaries;
 * `drainStepsAsync` hands the caller's loop back at each one. A fence or proof inside the function runs in the same order
 * either way, because only the scheduling between steps differs.
 */
export function drainSteps<T>(steps: Generator<void, T, void>): T {
  let next = steps.next(); while (!next.done) next = steps.next(); return next.value;
}

export async function drainStepsAsync<T>(steps: Generator<void, T, void>, pause: CooperativeYield = cooperativeYield()): Promise<T> {
  let next = steps.next(); while (!next.done) { await pause(); next = steps.next(); } return next.value;
}
