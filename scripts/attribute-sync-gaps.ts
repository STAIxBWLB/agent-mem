/**
 * #470 AC1: attribute each event-loop gap the opt-in placement fixture recorded to the functions that filled it.
 *
 * `measure-sync-placement-yield.ts --run-large --attribute --gaps-out=<file>` writes the gap windows with absolute
 * timestamps; this reads them beside a `bun --cpu-prof` profile of the same run and counts the profile's samples
 * inside each window. A progress report names the phase whose mark preceded the gap, not the work inside it, so the
 * phase column is only a label: each sample is charged to its call stack of `src/memory` frames, and the native leaf
 * under it (`JSON.stringify`, a hash update) is kept as the detail of what those functions spent the gap on.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Frame { functionName: string; url: string; lineNumber: number }
interface RawNode { id: number; callFrame: Frame; children?: number[] }
interface Profile { startTime: number; samples?: number[]; timeDeltas?: number[]; nodes: RawNode[] }
interface Gap { phase: string; ms: number; startEpochMs: number; endEpochMs: number }

const value = (name: string): string | undefined => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const gapsFile = value("gaps"), profileInput = value("profile");
if (!gapsFile || !profileInput) throw Error("Pass --gaps=<file> and --profile=<file-or-directory>.");

const profiles: Profile[] = (lstatSync(profileInput).isDirectory()
  ? readdirSync(profileInput).filter(name => name.endsWith(".cpuprofile")).map(name => join(profileInput, name))
  : [profileInput]).map(file => JSON.parse(readFileSync(file, "utf8")) as Profile);

const gaps = (JSON.parse(readFileSync(gapsFile, "utf8")) as { gaps: Gap[] }).gaps;
const frames = new Map<number, Frame>(), parent = new Map<number, number>();
for (const profile of profiles) {
  for (const node of profile.nodes) frames.set(node.id, node.callFrame);
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
}
const file = (frame: Frame): string => frame.url ? frame.url.slice(frame.url.lastIndexOf("/") + 1) : "";
const where = (frame: Frame): string => `${frame.functionName || "(anonymous)"}${file(frame) ? ` (${file(frame)}:${frame.lineNumber + 1})` : ""}`;
const inLibrary = (frame: Frame): boolean => file(frame).length > 0 && frame.url.includes("/src/memory/");
const MAX_DEPTH = 6;

/** The sample's `src/memory` stack (innermost first, at most MAX_DEPTH, each frame once) and the innermost frame of any kind. */
function stacks(id: number): { chain: string[]; leaf: string } {
  const chain: string[] = []; let leaf: string | undefined, at: number | undefined = id;
  for (let hops = 0; at !== undefined && hops < 64; hops++) {
    const frame = frames.get(at);
    if (frame) {
      leaf ??= where(frame);
      // A recursive frame repeats deeper in its own stack; counting it once keeps an inclusive share at or below 100%.
      const named = where(frame);
      if (inLibrary(frame) && chain.length < MAX_DEPTH && !chain.includes(named)) chain.push(named);
    }
    at = parent.get(at);
  }
  return { chain: chain.length ? chain : [leaf ?? "(unknown)"], leaf: leaf ?? "(unknown)" };
}

/** Every sample as (epoch µs, node id); a missing timeDeltas array means the profiler's own fixed interval. */
function timeline(profile: Profile, intervalUs: number, start: number, end: number): { at: number; node: number }[] {
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  let at = profile.startTime; const kept: { at: number; node: number }[] = [];
  for (const [index, node] of samples.entries()) { at += deltas[index] ?? intervalUs; if (at >= start && at <= end) kept.push({ at, node }); }
  return kept;
}
const intervalUs = Number(value("interval-us") ?? 1000);
const round = (ms: number): number => Math.round(ms * 100) / 100;
const ms = (hits: number): number => round(hits * intervalUs / 1000);
const total = (hits: Map<string, number>): number => [...hits.values()].reduce((sum, count) => sum + count, 0);
const top = (hits: Map<string, number>, limit: number): { leaf: string; ms: number }[] =>
  [...hits].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([leaf, count]) => ({ leaf, ms: ms(count) }));

let sampled = 0;
const rows = gaps.map(gap => {
  const start = gap.startEpochMs * 1000, end = gap.endEpochMs * 1000;
  const inside = profiles.flatMap(profile => timeline(profile, intervalUs, start, end));
  sampled += inside.length;
  // Inclusive share: a frame nested in the loop owner also appears in its samples, so shares can sum past 100%;
  // the innermost frame that is present in every sample is the function that held the gap.
  const byFrame = new Map<string, number>(), byLeaf = new Map<string, number>(), chains = new Map<string, number>(), reversed: string[][] = [];
  for (const { node } of inside) {
    const { chain, leaf } = stacks(node);
    for (const frame of chain) byFrame.set(frame, (byFrame.get(frame) ?? 0) + 1);
    byLeaf.set(leaf, (byLeaf.get(leaf) ?? 0) + 1);
    chains.set(chain.join(" < "), (chains.get(chain.join(" < ")) ?? 0) + 1);
    reversed.push([...chain].reverse());
  }
  // The gap's owner is the deepest frame every sample shares at the same depth: the loop that never yields.
  const depth = reversed.length ? Math.min(...reversed.map(chain => chain.length)) : 0;
  let shared = 0;
  while (shared + 1 < depth && reversed.every(chain => chain[shared + 1] === reversed[0]![shared + 1])) shared++;
  const count = inside.length || 1, frames = [...byFrame].map(([fn, hits]) => ({ function: fn, share: Math.round(hits / count * 1000) / 10, ms: ms(hits) }));
  const owner = reversed.length && depth > 0 ? { function: reversed[0]![shared]!, share: 100,
    ms: ms(reversed.filter(chain => chain[shared] === reversed[0]![shared]).length) } : null;
  return { phase: gap.phase, gapMs: round(gap.ms), sampledMs: ms(inside.length), owner,
    frames: frames.sort((a, b) => b.share - a.share || b.ms - a.ms).slice(0, 8),
    nativeLeaves: top(byLeaf, 4), dominantChain: [...chains].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null };
});
console.log(JSON.stringify({ profiles: profiles.length, samples: sampled, intervalUs, gapsOver250Ms: rows.length, attribution: rows }, null, 2));
