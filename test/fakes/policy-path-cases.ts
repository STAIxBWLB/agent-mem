/** Frozen synthetic corpus for the path-candidate optimization, including the original policy bounds. */
export function policyPathCases(): { name: string; value: unknown }[] {
  const publicTokens = "ordinary fixture context ".repeat(70), chunks = Array.from({ length: 16 }, () => "x".repeat(16384));
  return [
    { name: "public-repeated-prose", value: { excerpt: publicTokens } },
    { name: "denied-token-repeated", value: { excerpt: "hidden.ts ".repeat(150) } },
    { name: "one-denied-among-duplicates", value: { excerpt: `${publicTokens}hidden.ts` } },
    { name: "longer-prefix-existing-denial", value: { excerpt: "hidden.tsx hidden.tsx" } },
    { name: "shorter-prefix-alone", value: { excerpt: "hidden.t hidden.t" } },
    { name: "denied-after-shorter-prefix", value: { excerpt: "hidden.t hidden.ts" } },
    { name: "denied-after-public-prefix", value: { excerpt: "hidden.tsx hidden.ts" } },
    { name: "denied-case-variant", value: { excerpt: `${publicTokens}HIDDEN.TS` } },
    { name: "denied-fold-variant", value: { excerpt: `${publicTokens}ｈｉｄｄｅｎ.ts` } },
    { name: "default-denied-fold-variant", value: { excerpt: `${publicTokens}.ＥＮＶ` } },
    { name: "normalized-dot-path", value: { excerpt: `${publicTokens}public/../hidden.ts` } },
    { name: "pii-literal-repeated", value: { excerpt: `${publicTokens}restricted-marker restricted-marker` } },
    { name: "hangul-public-prose", value: { excerpt: "일반 문장 공개 기록 ".repeat(70) } },
    { name: "hangul-one-denied-token", value: { excerpt: `${"일반 문장 ".repeat(70)}hidden.ts` } },
    { name: "string-at-16384-bytes", value: "x".repeat(16384) },
    { name: "string-over-16384-bytes", value: "x".repeat(16385) },
    { name: "total-at-262144-bytes", value: chunks },
    { name: "total-over-262144-bytes", value: [...chunks, "x"] },
    { name: "nodes-at-4096", value: Array.from({ length: 4095 }, () => null) },
    { name: "nodes-over-4096", value: Array.from({ length: 4096 }, () => null) },
  ];
}
