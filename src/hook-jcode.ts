import { dirname, isAbsolute, join } from "node:path";
import { lstatSync } from "node:fs";

// Jcode v0.99.1 lifecycle observers (crates/jcode-base/src/hooks.rs apply_event_env; docs/HOOKS.md). Observers get no
// stdin and their stdout is discarded; every field arrives in the environment. Only post_tool and turn_end are captured:
// post_tool carries TOOL_NAME, TOOL_INPUT (16 KiB, may be cut mid-JSON), TOUCHED_PATHS, STATUS and ERROR (1000 chars);
// turn_end carries STATUS and LAST_ASSISTANT_TEXT (4000 chars). JCODE_HOOK_CWD is the session working directory at event
// time, the per-event origin that saved sessions lack (docs/jcode.md).
type Env = Readonly<Record<string, string | undefined>>;
export const JCODE_HOOK_EVENTS = ["post_tool", "turn_end"] as const;
const FIELD_BYTES = 16 * 1024 + 64, TOUCHED_PATHS = 32;

export interface JcodeHookCapture { event: "PostToolUse" | "PostToolUseFailure" | "Stop"; cwd: string; input: Record<string, unknown> }

const bounded = (value: string | undefined): value is string => typeof value === "string" && Buffer.byteLength(value) <= FIELD_BYTES;
/** A jcode session may sit in $HOME or /tmp. Without an enclosing `.git` (directory or worktree file) there is no project to
 * scope by, so the event is skipped rather than keyed by a directory name. No Git process: the hook resolver decides the key. */
function insideRepository(cwd: string): boolean {
  for (let dir = cwd, depth = 0; depth < 64; depth++) {
    if (lstatSync(join(dir, ".git"), { throwIfNoEntry: false })) return true;
    const parent = dirname(dir); if (parent === dir) return false; dir = parent;
  }
  return false;
}

/** Maps one jcode observer environment onto the Claude-shaped hook input the spool already screens and normalizes.
 * Anything missing, oversized or inconsistent returns undefined: the event is skipped, never guessed. */
export function jcodeHookCapture(env: Env): JcodeHookCapture | undefined {
  const event = env.JCODE_HOOK_EVENT, cwd = env.JCODE_HOOK_CWD, session = env.JCODE_HOOK_SESSION_ID, status = env.JCODE_HOOK_STATUS;
  if (event !== "post_tool" && event !== "turn_end") return undefined;
  if (!bounded(cwd) || !cwd || !isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd)) return undefined;
  try { if (!lstatSync(cwd).isDirectory()) return undefined; } catch { return undefined; }
  if (!insideRepository(cwd)) return undefined;
  if (session !== undefined && (!bounded(session) || session.length > 256)) return undefined;
  if (status !== "ok" && status !== "error") return undefined;
  const base: Record<string, unknown> = { cwd, ...(session ? { session_id: session } : {}) };
  if (event === "turn_end") {
    const text = env.JCODE_HOOK_LAST_ASSISTANT_TEXT;
    if (text !== undefined && !bounded(text)) return undefined;
    // A turn without assistant text (tool-only, or an error before any text) has nothing to recall.
    if (!text?.trim()) return undefined;
    return { event: "Stop", cwd, input: { ...base, hook_event_name: "Stop", last_assistant_message: text } };
  }
  const tool = env.JCODE_HOOK_TOOL_NAME, raw = env.JCODE_HOOK_TOOL_INPUT, touched = env.JCODE_HOOK_TOUCHED_PATHS, error = env.JCODE_HOOK_ERROR;
  if (!bounded(tool) || !tool || tool.length > 128 || /[\x00-\x1f]/.test(tool)) return undefined;
  if ([raw, touched, error].some(value => value !== undefined && !bounded(value))) return undefined;
  // TOOL_INPUT is cut at 16 KiB, so a long input is not valid JSON; keep the call with its touched paths only.
  let parsed: Record<string, unknown> = {};
  if (raw) try { const value: unknown = JSON.parse(raw); if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>; } catch { /* truncated */ }
  // The spool reads file_path, path and paths; touched paths already name those inputs, so keep only the ones not present.
  const named = new Set([parsed.file_path, parsed.path, ...(Array.isArray(parsed.paths) ? parsed.paths : [])].filter((p): p is string => typeof p === "string"));
  const paths = [...new Set((touched ?? "").split("\n").filter(path => path && isAbsolute(path) && !named.has(path)))].slice(0, TOUCHED_PATHS);
  const toolInput = { ...parsed, ...(paths.length ? { paths: [...(Array.isArray(parsed.paths) ? parsed.paths : []), ...paths] } : {}) };
  const failed = status === "error", name = failed ? "PostToolUseFailure" : "PostToolUse";
  return { event: name, cwd, input: { ...base, hook_event_name: name, tool_name: tool, tool_input: toolInput, ...(failed ? { error: error ?? "" } : { tool_response: "" }) } };
}
