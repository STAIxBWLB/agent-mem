import type { ConfigImage } from "./setup-owned.ts";
import { createJsonMcpCodec } from "./setup-json.ts";

// OpenCode v1.18.35 keeps MCP servers under `mcp.<name>` in its global config
// (packages/opencode/src/config/config.ts loadGlobal; docs/opencode.md).
// ponytail: strict JSON only. A global opencode.jsonc is refused because its later merge could
// override the entry; a comment-aware lexical view is the upgrade path.
const codec = createJsonMcpCodec({ canonicalKey: "mcp", label: "OpenCode strict JSON" });
export function readOpencodeMcp(image: ConfigImage): unknown { return codec.read(image); }
export function putOpencodeMcp(image: ConfigImage, value: unknown): ConfigImage { return codec.put(image, value); }
export function restoreOpencodeMcp(before: ConfigImage, after: ConfigImage, current: ConfigImage): ConfigImage { return codec.restore(before, after, current); }
/** The local stdio server record OpenCode starts in the session's project directory (no `cwd`). */
export function opencodeServer(bun: string, entry: string): Record<string, unknown> {
  return { type: "local", command: [bun, "--smol", entry, "mcp"], enabled: true };
}
