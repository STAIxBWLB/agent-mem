import { expect, test } from "bun:test";
import { attributeGaps, type Frame, type Gap, type Profile, type RawNode } from "../scripts/attribute-sync-gaps.ts";

/** The gap window these fixtures sit in: 1,000,000 to 1,010,000 µs, with samples one millisecond apart. */
const gap: Gap = { phase: "fixture", ms: 10, startEpochMs: 1000, endEpochMs: 1010 };
const frame = (functionName: string, name: string, line = 0): Frame => ({ functionName, url: `file:///v/r/src/memory/${name}.ts`, lineNumber: line });
const nodes = (...list: RawNode[]): RawNode[] => list;
const profile = (start: number, samples: number[], list: RawNode[]): Profile => ({ startTime: start, samples, timeDeltas: samples.map(() => 1000), nodes: list });

test("#470: two profiles that reuse node ids keep each sample on its own frame", () => {
  // Both profiles number their nodes 7 and 8, and both call their outer frame "base"; only the leaves differ, so a
  // shared id table would charge the first profile's sample to the second profile's function.
  const first = profile(1_000_000, [7], nodes({ id: 8, callFrame: frame("base", "b"), children: [7] }, { id: 7, callFrame: frame("alpha", "a") }));
  const second = profile(1_000_000, [7], nodes({ id: 8, callFrame: frame("base", "b"), children: [7] }, { id: 7, callFrame: frame("beta", "d") }));
  const { owner, frames, sampledMs } = attributeGaps([gap], [first, second]).rows[0]!;
  expect(sampledMs).toBe(2);
  expect(frames).toEqual([{ function: "base (b.ts:1)", share: 100, ms: 2 }, { function: "alpha (a.ts:1)", share: 50, ms: 1 }, { function: "beta (d.ts:1)", share: 50, ms: 1 }]);
  // The positive side of the owner check: one outer frame that every sample really shares.
  expect(owner).toEqual({ function: "base (b.ts:1)", share: 100, ms: 2 });
});

test("#470: samples that share no frame have no owner instead of the first sample's frame", () => {
  const disjoint = profile(1_000_000, [1, 2], nodes({ id: 1, callFrame: frame("left", "l") }, { id: 2, callFrame: frame("right", "r") }));
  const { owner, frames } = attributeGaps([gap], [disjoint]).rows[0]!;
  expect(owner).toBeNull();
  expect(frames.map(value => value.function)).toEqual(["left (l.ts:1)", "right (r.ts:1)"]);
});

test("#470: the gap's samples are counted once per profile and only inside its window", () => {
  const inside = profile(1_000_000, [1, 1, 1], nodes({ id: 1, callFrame: frame("only", "o") }));
  const outside = profile(2_000_000, [1], nodes({ id: 1, callFrame: frame("later", "z") }));
  const { samples, rows } = attributeGaps([gap], [inside, outside]);
  expect(samples).toBe(3);
  expect(rows[0]!.frames).toEqual([{ function: "only (o.ts:1)", share: 100, ms: 3 }]);
  expect(attributeGaps([gap], []).rows[0]).toMatchObject({ owner: null, sampledMs: 0, dominantChain: null });
});
