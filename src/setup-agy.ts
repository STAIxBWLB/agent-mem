import type { ConfigImage } from "./setup-owned.ts";
import { createJsonMcpCodec } from "./setup-json.ts";

// ponytail: Antigravity setup supports strict JSON only. JSONC needs a comment-aware
// lexical view and trailing-comma ownership before byte-preserving edits can support it.
const codec = createJsonMcpCodec({ canonicalKey: "mcpServers", label: "Antigravity strict JSON" });
export function readAgyMcp(image: ConfigImage): unknown { return codec.read(image); }
export function putAgyMcp(image: ConfigImage, value: unknown): ConfigImage { return codec.put(image, value); }
export function restoreAgyMcp(before: ConfigImage, after: ConfigImage, current: ConfigImage): ConfigImage { return codec.restore(before, after, current); }
