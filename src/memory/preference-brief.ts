/**
 * #370: the brief's preference slot. A preference is a standing instruction from the person, so it is shown by its own slot instead of
 * competing with intent- or path-scoped rows it has no anchor for. Both briefs share the row count; each keeps its own byte share, because
 * their budgets differ (`amem_brief` defaults to 2048 bytes, the SessionStart brief to 1200).
 */
export const PREFERENCE_SLOT = 5;
/** Reserved ahead of the ranked items and capped at half the brief's budget, so a full slot cannot starve them. */
export const INTENT_PREFERENCE_SHARE = 1000;
/** Reserved ahead of the SessionStart brief's curated section, out of the same 1200-byte budget. */
export const SESSION_PREFERENCE_SHARE = 480;

export interface PreferenceLineView { id: string; kind: string; tier: string; title: string | null; text: string }

/**
 * One `amem_brief` slot line, emitted whole or not at all: the ranked lines clip with a fetch marker, but a clipped standing instruction
 * reads as a rule the person never stated, so an over-long preference is dropped and the brief reports itself truncated.
 */
export function preferenceLine(view: PreferenceLineView, maximum: number): string | undefined {
  const text = `${view.title ? `${view.title}: ` : ""}${view.text}`;
  const line = JSON.stringify({ id: `mem:${view.id}`, kind: view.kind, tier: view.tier, text });
  return Buffer.byteLength(line) > maximum ? undefined : line;
}
