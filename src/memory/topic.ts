/**
 * #580: a caller-chosen key naming the subject a note states, carried as the `about` node `topic:<key>` (owner ruling
 * 2026-11-28: no NoteEntry field and no format floor, since every reader already keeps and indexes `about` nodes).
 */
export const TOPIC_FORM = "[a-z0-9][a-z0-9/-]{0,63}";
const TOPIC = new RegExp(`^${TOPIC_FORM}$`);
export const TOPIC_PREFIX = "topic:";
export const validTopic = (value: unknown): value is string => typeof value === "string" && TOPIC.test(value);
export const topicNode = (topic: string): string => `${TOPIC_PREFIX}${topic}`;
/** The note's topic, or null. A note carries at most one when written through amem; the first valid one wins otherwise. */
export function topicOf(view: { about: readonly string[] }): string | null {
  for (const node of view.about) if (node.startsWith(TOPIC_PREFIX) && validTopic(node.slice(TOPIC_PREFIX.length))) return node.slice(TOPIC_PREFIX.length);
  return null;
}
