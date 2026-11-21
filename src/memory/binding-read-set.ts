/**
 * Records the paths a binding read consults, so a cheap fence can be checked against the reader's own set instead of a
 * condition kept beside it (#396). A leaf module with no imports, so every reader can report into it without a cycle.
 *
 * The recorder is module-local and saves the previous one, so a nested collection restores its caller. It is a no-op
 * for every read outside a collection: nothing changes for callers that do not ask for the set.
 */
let collector: ((path: string) => void) | undefined;

/** Report one path a binding read consulted. */
export function reportBindingRead(path: string): void { collector?.(path); }

/** Run `work`, collecting the paths it reported, in first-seen order. */
export function collectBindingReads<T>(work: () => T): { value: T; paths: string[] } {
  const previous = collector, paths: string[] = [];
  collector = path => { if (!paths.includes(path)) paths.push(path); };
  try { return { value: work(), paths }; } finally { collector = previous; }
}
