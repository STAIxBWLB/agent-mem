import { looksSecret } from "./screen.ts";
import { isDenied } from "./platform.ts";
import { stripPrivateSpans } from "./private-spans.ts";

export const CAPTURE_MAX_EXCERPT = 2000;
export const CAPTURE_MAX_PATHS = 32;
const ROW_OVERHEAD_BYTES = 96;

export interface CaptureFields {
  agent: string; event: string;
  tool?: string; paths?: string[]; status?: string; excerpt?: string;
  /** Tests and the spool replay pin the time; hooks leave it to the store clock. */
  at?: string;
}
export interface NormalizedCaptureFields {
  at: string; agent: string; event: string;
  tool: string | null; paths: string[]; status: string | null; excerpt: string; bytes: number;
}

/** Pure capture shaping; no store, project lookup or filesystem operation is loaded or invoked here. */
/** The caps a person's configuration may lower (F4); the built-in caps are the ceiling, so a larger value is ignored. */
export interface CaptureCaps { excerptBytes?: number; paths?: number; denyPaths?: readonly string[] }
export function normalizeCaptureFields(input: CaptureFields, now: () => number = Date.now, screen: (text: string) => boolean = looksSecret, caps: CaptureCaps = {}): NormalizedCaptureFields {
  const maxExcerpt = Math.min(CAPTURE_MAX_EXCERPT, caps.excerptBytes ?? CAPTURE_MAX_EXCERPT), maxPaths = Math.min(CAPTURE_MAX_PATHS, caps.paths ?? CAPTURE_MAX_PATHS);
  const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  // Canonical UTC ISO text, so text order is time order for eviction (`at < cutoff`) and search (`at >= notBefore`).
  const at = new Date(input.at === undefined ? now() : Date.parse(input.at)).toISOString();
  const tool = str(input.tool, 64) ? input.tool! : null;
  const status = str(input.status, 64) ? input.status! : null;
  const paths = (input.paths ?? []).map(String).filter((p) => p && !isDenied(p, caps.denyPaths ? [...caps.denyPaths] : [])).slice(0, maxPaths).map((p) => p.slice(0, 400));
  // `<private>` spans go first: they are never screened, counted or stored. The cap applies to what is left.
  let excerpt = stripPrivateSpans(input.excerpt ?? "").slice(0, maxExcerpt);
  if (excerpt && screen(excerpt)) excerpt = "[secret-screened]";
  return { at, agent: input.agent, event: input.event, tool, paths, status, excerpt,
    bytes: Buffer.byteLength(excerpt) + Buffer.byteLength(JSON.stringify(paths)) + ROW_OVERHEAD_BYTES };
}
