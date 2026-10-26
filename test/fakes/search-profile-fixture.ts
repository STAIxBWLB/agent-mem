// Fixed synthetic distributions, independent of any implementation's screening gate.
// Separate seeded permutations preserve rounded marginals while allowing overlap.
export const distributions = [
  { name: "nonAscii", probability: 0.80, bit: 1, seed: 0x137ac24d },
  { name: "slashDot", probability: 0.03, bit: 2, seed: 0x59e236ab },
  { name: "doubleSlash", probability: 0.01, bit: 4, seed: 0x6c42a9d1 },
  { name: "atMarker", probability: 0.03, bit: 8, seed: 0x2a7b31e5 },
  { name: "pathHeavy", probability: 0.25, bit: 16, seed: 0x75d41983 },
] as const;

export const EXCERPT_BYTES = 1950;

export function featureMasks(count: number): Uint8Array {
  const masks = new Uint8Array(count), order = new Uint32Array(count);
  for (const feature of distributions) {
    for (let i = 0; i < count; i++) order[i] = i;
    let state: number = feature.seed;
    for (let i = count - 1; i > 0; i--) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      const j = Math.floor(((state >>> 0) / 4294967296) * (i + 1));
      const previous = order[i]!; order[i] = order[j]!; order[j] = previous;
    }
    for (let i = 0; i < Math.round(count * feature.probability); i++) {
      const id = order[i]!; masks[id] = masks[id]! | feature.bit;
    }
  }
  return masks;
}

/** UTF-8 byte volume stays fixed while Hangul/English character density varies. */
export function syntheticRow(index: number, mask: number): { excerpt: string; paths: string[] } {
  const parts = [index === 0 ? "rankneedle exactanchor preciseanchor oldest strongest match" : `rankneedle background ${index}`];
  if (mask & 1) parts.push([
    "메모리 정책과 검색 결과를 검증합니다",
    "public input → screened output",
    "ordinary search — current recall",
    "한국어 검색 → 공개 결과 — 정상 확인",
  ][index % 4]!);
  if (mask & 2) parts.push(`src/./public-${index % 97}.ts`);
  if (mask & 4) parts.push(`src//reader-${index % 89}.ts`);
  // A standalone marker, with no dotted domain or email address shape.
  if (mask & 8) parts.push("@ordinary-marker");
  if (mask & 16) parts.push("src/memory/public.ts src/features/reader.ts src/tests/fixture.ts");
  const filler = mask & 1 ? [
    "검색 결과와 개인정보 경계를 확인하고 공개 자료의 처리 순서를 기록합니다. ",
    "ordinary fixture context and public search results ",
    "공개 메모리 규칙을 확인합니다. ordinary fixture context and current public results ",
    "처리 결과를 검증합니다. public context and ordinary project notes ",
  ][index % 4]! : "ordinary fixture context and public search results ";
  const full = parts.join(" ") + " " + filler.repeat(100);
  // BMP-only fixture: preserve character boundaries and fill any trailing byte gap with spaces.
  let excerpt = "", bytes = 0;
  for (const character of full) {
    const size = Buffer.byteLength(character); if (bytes + size > EXCERPT_BYTES) break;
    excerpt += character; bytes += size;
  }
  excerpt += " ".repeat(EXCERPT_BYTES - bytes);
  return { excerpt, paths: mask & 16 ? ["src/memory/public.ts", "src/features/reader.ts", "src/tests/fixture.ts"] : [] };
}
