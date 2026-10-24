/**
 * `<private>...</private>` spans (the claude-mem convention) are dropped before anything else reads the text, so they are never screened, counted or
 * stored. A leaf module with no imports: capture shaping, the candidate and work-list boundaries, notes, goals and imports all use it.
 *
 * Tags match the way an HTML reader would, so a variant cannot slip a span through: the name is case-insensitive, an opening tag may carry attributes
 * (`<private class="x">`), whitespace before the name (`< private>`) and a self-closing slash (`<private/>`, which opens a span like any other opening
 * tag, since a person who typed it meant what follows to stay private). A closing tag is `</private>` with the same latitude. Nested spans close from the
 * inside out. An unclosed span drops everything to the end of the text. A stray closing tag is kept as plain text. `<privateer>` is not a tag.
 */
const TAG = /<\s*(\/?)\s*private(?=[\s/>])[^<>]*>/gi;

export function stripPrivateSpans(text: string): string {
  if (!/<\s*\/?\s*private(?=[\s/>])/i.test(text)) return text;
  let out = "", depth = 0, last = 0, match: RegExpExecArray | null;
  TAG.lastIndex = 0;
  while ((match = TAG.exec(text))) {
    const closing = match[1] === "/", stray = closing && depth === 0;
    if (depth === 0) out += text.slice(last, stray ? match.index + match[0].length : match.index);   // a stray closer is plain text: keep it
    if (closing) { if (depth > 0) depth--; } else depth++;
    last = match.index + match[0].length;
  }
  if (depth === 0) out += text.slice(last);
  return out;
}

/** The same strip over every string inside a plain value (one level of arrays and objects, as the callers' inputs are), leaving other values as they are. */
export function stripPrivateDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return stripPrivateSpans(value) as T;
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => stripPrivateDeep(item, depth + 1)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, stripPrivateDeep(item, depth + 1)])) as T;
}
