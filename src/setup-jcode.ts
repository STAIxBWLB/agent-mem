import type { ConfigImage } from "./setup-owned.ts";
import { createJsonMcpCodec } from "./setup-json.ts";

const codec = createJsonMcpCodec({ canonicalKey: "servers", aliases: ["mcpServers"], label: "Jcode" });
export function readJcodeMcp(image: ConfigImage): unknown { return codec.read(image); }
export function putJcodeMcp(image: ConfigImage, value: unknown): ConfigImage { return codec.put(image, value); }
export function restoreJcodeMcp(before: ConfigImage, after: ConfigImage, current: ConfigImage): ConfigImage { return codec.restore(before, after, current); }
