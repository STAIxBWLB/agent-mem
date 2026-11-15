import type { View } from "./store.ts";

/**
 * #423: the task a curated note belongs to, for grouping. A note's own `task` wins; otherwise the first `task:` node in
 * `about` (sorted, so every reader picks the same one). The `@<created>` suffix is dropped so a note written with a task
 * and a note that only mentions "task #N" in the same project fold together. Notes without a task never group, and a
 * `shared` note never folds with a project note.
 */
export function taskGroupKey(view: Pick<View, "task" | "about" | "project"> & { scope?: View["scope"] }): string | undefined {
  const raw = view.task ?? view.about.find(node => node.startsWith("task:"))?.slice(5);
  if (!raw) return undefined;
  const task = raw.includes("#") ? raw.replace(/@\d+$/, "") : `${view.project}#${raw.replace(/@\d+$/, "")}`;
  // A shared note and a project note of one task are different audiences: never fold one into the other.
  return view.scope === "shared" ? `shared:${task}` : task;
}

/**
 * #423: keep the first item of each task group, in input order (callers pass items best first), and count the items
 * it folded in. Items with no curated view or no task are kept as they are with `folded: 0`. Read-time only: rows and
 * the derived index are untouched.
 */
export function groupByTask<T>(items: readonly T[], view: (item: T) => (Pick<View, "task" | "about" | "project"> & { scope?: View["scope"] }) | undefined): { item: T; folded: number }[] {
  const out: { item: T; folded: number }[] = [], leader = new Map<string, { item: T; folded: number }>();
  for (const item of items) {
    const v = view(item), key = v ? taskGroupKey(v) : undefined;
    const head = key === undefined ? undefined : leader.get(key);
    if (head) { head.folded++; continue; }
    const entry = { item, folded: 0 };
    if (key !== undefined) leader.set(key, entry);
    out.push(entry);
  }
  return out;
}
