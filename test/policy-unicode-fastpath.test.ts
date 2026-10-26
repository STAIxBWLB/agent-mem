import { expect, test } from "bun:test";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { createStandalonePolicy as before } from "./fakes/policy-before-g1f.ts";
import { DENY_NAMES, DENY_SEGMENTS } from "../src/memory/platform.ts";

// Intentional literal ZERO WIDTH SPACE between e/acute and Hangul leading/vowel Jamo.
// NFKC runs before its removal, so the resulting folded string can still need NFC.
const splitCafe = "cafe​́", splitHangul = "ᄀ​ᅡ";
const decomposedCafe = "café", decomposedHangul = "가";
const names = [...DENY_NAMES], segments = [...DENY_SEGMENTS];
const restore = () => {
  DENY_NAMES.splice(0, DENY_NAMES.length, ...names);
  DENY_SEGMENTS.splice(0, DENY_SEGMENTS.length, ...segments);
};

async function compare(values: readonly unknown[], denyPaths: string[], mutate?: (index: number) => void): Promise<void> {
  const oldCalls: number[] = [], nextCalls: number[] = []; let current = -1;
  const old = before({ denyPaths, host: { screen: async () => { oldCalls.push(current); return current % 19 !== 0; } } });
  const next = createStandalonePolicy({ denyPaths, host: { screen: async () => { nextCalls.push(current); return current % 19 !== 0; } } });
  for (let index = 0; index < values.length; index++) {
    current = index; mutate?.(index);
    const expected = await old.screen(values[index]), actual = await next.screen(values[index]);
    if (actual !== expected) throw new Error(`Unicode policy mismatch at sample ${index}`);
  }
  expect(nextCalls).toEqual(oldCalls);
}

test("both folded and NFC forms retain canonical-composition denials", async () => {
  for (const factory of [before, createStandalonePolicy]) {
    // The composed configured deny occurs only after pathCandidates applies NFC.
    expect(factory({ denyPaths: ["café"] }).screenStandalone(`${splitCafe}/public.ts`)).toBe(false);
    expect(factory({ denyPaths: ["가"] }).screenStandalone(`${splitHangul}/public.ts`)).toBe(false);
    // An ignorable in the configured deny leaves its own folded value decomposed.
    expect(factory({ denyPaths: [splitCafe] }).screenStandalone(`${splitCafe}/public.ts`)).toBe(false);
    expect(factory({ denyPaths: [splitHangul] }).screenStandalone(`${splitHangul}/public.ts`)).toBe(false);
    expect(factory().screenStandalone("공개 한국어 기록 → 다음 단계 — 일반 설명")).toBe(true);
  }
  const texts = [splitCafe, splitHangul, decomposedCafe, decomposedHangul, "café", "가", "İ", "i̇", "ạ́", "ạ́", "학생 공개 기록", "공개→다음", "공개—설명", "ｓｒｃ／．ｅｎｖ", "src＼credentials", "공개/../비공개/자료", "공개//비공개/자료", "./공개/자료/", "공개 file.secretlongword"];
  const values = texts.flatMap(text => [text, `${text}/public.ts`, `path:${text}/public.ts`, `symbol:f@${text}/public.ts`, { excerpt: "공개", paths: [text], metadata: { note: text } }]);
  for (const deny of [["café", "가"], [splitCafe, splitHangul], ["비공개/자료"], ["İ", "ạ́"], []]) await compare(values, deny);
});

test("30000 seeded Unicode, dense-mark and path samples retain verdicts and host-call order", async () => {
  let seed = 0x87c0ffee;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const atoms = ["공개", "학생", "자료", "비공개", "café", splitCafe, decomposedCafe, "가", splitHangul, decomposedHangul, "İ", "i̇", "ạ́", "ạ́", "̣́".repeat(24), "→", "—", "ｓｒｃ", "．ｅｎｖ", "credentials", "file.secretlongword", "공개.pem", "일반.key", "private", "records"];
  const joins = [" ", "/", "//", "/./", "/../", "／", "＼", "→", "—", ".", ":", "@", "'", '"', "(", ")", "[", "]", "\n", "_", "-"];
  const values: unknown[] = [];
  for (let index = 0; index < 30000; index++) {
    let text = atoms[random() % atoms.length]!;
    for (let part = 0, length = random() % 6; part < length; part++) text += joins[random() % joins.length]! + atoms[random() % atoms.length]!;
    switch (random() % 5) {
      case 0: values.push(text); break;
      case 1: values.push(`path:${text}/공개.ts`); break;
      case 2: values.push(`symbol:함수@${text}/공개.ts`); break;
      case 3: values.push({ excerpt: "공개 기록", paths: [text], agent: "fixture", id: index }); break;
      default: values.push({ excerpt: text, metadata: { title: text }, paths: ["공개/자료.ts"], private: false });
    }
  }
  try {
    await compare(values, ["café", splitHangul, "비공개/자료", "private/records"], index => {
      if (index % 500 === 0) {
        restore();
        switch (Math.floor(index / 500) % 6) {
          case 1: DENY_NAMES.push("secretlong\\b"); break;
          case 2: DENY_SEGMENTS.push("비공개", "가"); break;
          case 3: DENY_NAMES.push("^자료"); break;
          case 4: DENY_SEGMENTS.push(splitCafe, "private/records"); break;
          case 5: DENY_NAMES.push("[가-힣]+", "*");
        }
      }
    });
  } finally { restore(); }
});
