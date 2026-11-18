/**
 * #470 AC1: attribute each event-loop gap the opt-in placement fixture recorded to the functions that filled it.
 *
 * `measure-sync-placement-yield.ts --run-large --attribute --gaps-out=<file>` writes the gap windows with absolute
 * timestamps; this reads them beside a `bun --cpu-prof` profile of the same run and counts the profile's samples
 * inside each window. A progress report names the phase whose mark preceded the gap, not the work inside it, so the
 * phase column is only a label: each sample is charged to its call stack of `src/memory` frames, and the native leaf
 * under it (`JSON.stringify`, a hash update) is kept as the detail of what those functions spent the gap on.
 *
 * Node ids are local to one `.cpuprofile`, so each profile keeps its own id tables and every sample carries the
 * profile it came from. `attributeGaps` is exported for the self-check in `test/attribute-sync-gaps.test.ts`.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Frame { functionName: string; url: string; lineNumber: number }
export interface RawNode { id: number; callFrame: Frame; children?: number[] }
export interface Profile { startTime: number; samples?: number[]; timeDeltas?: number[]; nodes: RawNode[] }
export interface Gap { phase: string; ms: number; startEpochMs: number; endEpochMs: number }
export interface AttributedFrame { function: string; share: number; ms: number }
export interface AttributionRow {
  phase: string; gapMs: number; sampledMs: number;
  /** The loop that never yielded, or null when the gap's samples share no frame. */
  owner: AttributedFrame | null;
  frames: AttributedFrame[]; nativeLeaves: { leaf: string; ms: number }[]; dominantChain: string | null;
}

const MAX_DEPTH = 6;
const file = (frame: Frame): string => frame.url ? frame.url.slice(frame.url.lastIndexOf("/") + 1) : "";
const where = (frame: Frame): string => `${frame.functionName || "(anonymous)"}${file(frame) ? ` (${file(frame)}:${frame.lineNumber + 1})` : ""}`;
const inLibrary = (frame: Frame): boolean => file(frame).length > 0 && frame.url.includes("/src/memory/");

interface Index {
  frames: Map<number, Frame>;
  parent: Map<number, number>;
}

/** One profile's own id tables. Never shared across profiles: the ids of two profiles collide without meaning the same node. */
function indexProfile(profile: Profile): Index {
  const frames = new Map<number, Frame>(), parent = new Map<number, number>();
  for (const node of profile.nodes) frames.set(node.id, node.callFrame);
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  return { frames, parent };
}

/** The sample's `src/memory` stack (innermost first, at most MAX_DEPTH, each frame once) and the innermost frame of any kind. */
function stacks(index: Index, id: number): { chain: string[]; leaf: string } {
  const chain: string[] = []; let leaf: string | undefined, at: number | undefined = id;
  for (let hops = 0; at !== undefined && hops < 64; hops++) {
    const frame = index.frames.get(at);
    if (frame) {
      leaf ??= where(frame);
      // A recursive frame repeats deeper in its own stack; counting it once keeps an inclusive share at or below 100%.
      const named = where(frame);
      if (inLibrary(frame) && chain.length < MAX_DEPTH && !chain.includes(named)) chain.push(named);
    }
    at = index.parent.get(at);
  }
  return { chain: chain.length ? chain : [leaf ?? "(unknown)"], leaf: leaf ?? "(unknown)" };
}

/** Every sample of one profile inside [start, end] (µs); a missing timeDeltas array means the profiler's fixed interval. */
function timeline(profile: Profile, intervalUs: number, start: number, end: number): { at: number; node: number }[] {
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  let at = profile.startTime; const kept: { at: number; node: number }[] = [];
  for (const [index, node] of samples.entries()) { at += deltas[index] ?? intervalUs; if (at >= start && at <= end) kept.push({ at, node }); }
  return kept;
}

const round = (ms: number): number => Math.round(ms * 100) / 100;
const ms = (hits: number, intervalUs: number): number => round(hits * intervalUs / 1000);
const top = (hits: Map<string, number>, limit: number, intervalUs: number): { leaf: string; ms: number }[] =>
  [...hits].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([leaf, count]) => ({ leaf, ms: ms(count, intervalUs) }));

export function attributeGaps(gaps: readonly Gap[], profiles: readonly Profile[], intervalUs = 1000): { samples: number; rows: AttributionRow[] } {
  const indexes = profiles.map(indexProfile);
  let samples = 0;
  const rows = gaps.map(gap => {
    const start = gap.startEpochMs * 1000, end = gap.endEpochMs * 1000;
    const inside = profiles.flatMap((profile, index) => timeline(profile, intervalUs, start, end).map(sample => ({ ...sample, index })));
    samples += inside.length;
    // Inclusive share: a frame nested in the loop owner also appears in its samples, so shares can sum past 100%;
    // the innermost frame that is present in every sample is the function that held the gap.
    const byFrame = new Map<string, number>(), byLeaf = new Map<string, number>(), chains = new Map<string, number>(), reversed: string[][] = [];
    for (const { node, index } of inside) {
      const { chain, leaf } = stacks(indexes[index]!, node);
      for (const frame of chain) byFrame.set(frame, (byFrame.get(frame) ?? 0) + 1);
      byLeaf.set(leaf, (byLeaf.get(leaf) ?? 0) + 1);
      chains.set(chain.join(" < "), (chains.get(chain.join(" < ")) ?? 0) + 1);
      reversed.push([...chain].reverse());
    }
    // Reversed stacks run outermost-first, so depth 0 is the outermost frame: it must itself be shared before any
    // deeper frame can be, and a gap whose samples share no frame at all has no owner.
    const depth = reversed.length ? Math.min(...reversed.map(chain => chain.length)) : 0;
    let shared = reversed.length && depth > 0 && reversed.every(chain => chain[0] === reversed[0]![0]) ? 0 : -1;
    while (shared >= 0 && shared + 1 < depth && reversed.every(chain => chain[shared + 1] === reversed[0]![shared + 1])) shared++;
    const count = inside.length || 1;
    let owner: AttributedFrame | null = null;
    if (shared >= 0) {
      const name = reversed[0]![shared]!;
      const hits = reversed.filter(chain => chain[shared] === name).length;
      owner = { function: name, share: Math.round(hits / count * 1000) / 10, ms: ms(hits, intervalUs) };
    }
    const frames = [...byFrame].map(([fn, hits]) => ({ function: fn, share: Math.round(hits / count * 1000) / 10, ms: ms(hits, intervalUs) }));
    return { phase: gap.phase, gapMs: round(gap.ms), sampledMs: ms(inside.length, intervalUs), owner,
      frames: frames.sort((a, b) => b.share - a.share || b.ms - a.ms).slice(0, 8),
      nativeLeaves: top(byLeaf, 4, intervalUs), dominantChain: [...chains].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null };
  });
  return { samples, rows };
}

if (import.meta.main) {
  const value = (name: string): string | undefined => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  const gapsFile = value("gaps"), profileInput = value("profile");
  if (!gapsFile || !profileInput) throw Error("Pass --gaps=<file> and --profile=<file-or-directory>.");
  const profiles = (lstatSync(profileInput).isDirectory()
    ? readdirSync(profileInput).filter(name => name.endsWith(".cpuprofile")).map(name => join(profileInput, name))
    : [profileInput]).map(path => JSON.parse(readFileSync(path, "utf8")) as Profile);
  const gaps = (JSON.parse(readFileSync(gapsFile, "utf8")) as { gaps: Gap[] }).gaps;
  const intervalUs = Number(value("interval-us") ?? 1000);
  const { samples, rows } = attributeGaps(gaps, profiles, intervalUs);
  console.log(JSON.stringify({ profiles: profiles.length, samples, intervalUs, gapsOver250Ms: rows.length, attribution: rows }, null, 2));
}
