import { featureMasks } from "./search-profile-fixture.ts";

export { featureMasks };
export const MCP_VOLUME_ROWS = 84_765;
export const MCP_VOLUME_EXCERPT_BYTES = 1154;
const WORDS = 178, SHARED_TERMS = 10_400;
const publicPaths = ["src/memory/public.ts", "src/features/reader.ts", "src/tests/fixture.ts"];

/** Aggregate-only calibration: ~95K terms, ~185 body tokens, mostly ASCII with tiny Unicode inserts. */
export function mcpVolumeRow(index: number, mask: number, bestIndex = 0): { excerpt: string; paths: string[] } {
  const words = Array.from({ length: WORDS }, (_, token) => `w${((index * 181 + token * 43) % SHARED_TERMS).toString(36).padStart(4, "0")}`);
  words[0] = "rankneedle"; words[1] = `r${index.toString(36).padStart(4, "0")}`;
  if (index === bestIndex) { words[2] = "exactanchor"; words[3] = "preciseanchor"; }
  if (mask & 1) words[4] = index % 2 ? "공개자료처리검증정상확인" : "공개자료처리검증정상확";
  if (mask & 2) words[5] = `src/./public-${index % 97}.ts`;
  if (mask & 4) words[6] = `src//reader-${index % 89}.ts`;
  if (mask & 8) words[7] = "@ordinary-marker";
  if (mask & 16) words[8] = publicPaths.join(" ");
  let excerpt = words.join(" ");
  // Preserve token boundaries and rare query anchors when feature combinations need more bytes.
  for (let i = words.length - 1; Buffer.byteLength(excerpt) > MCP_VOLUME_EXCERPT_BYTES && i >= 9; i--) {
    words[i] = "ok"; excerpt = words.join(" ");
  }
  const remaining = MCP_VOLUME_EXCERPT_BYTES - Buffer.byteLength(excerpt);
  if (remaining < 0) throw Error("volume fixture byte bound");
  return { excerpt: excerpt + " ".repeat(remaining), paths: mask & 16 ? [...publicPaths] : [] };
}
