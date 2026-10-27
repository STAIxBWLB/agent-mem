import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEvalSet, runEval, type EvalQuestion, type EvalReport, type EvalSet, MAX_SET_BYTES } from "./eval.ts";
import { MemoryStore, type View } from "./store.ts";
import { realPath } from "./platform.ts";

/**
 * The committed synthetic question set: no person's memory, only invented entries about a made-up project. It lives under `src/` because the package ships
 * `src/` and not `test/`, so a plain `amem eval` works from an installed copy. A file URL, converted with `fileURLToPath` wherever a path is needed: a plain
 * `.pathname` stays percent-encoded and breaks under an install path with a space or non-ASCII characters.
 */
export const FIXTURE_PATH = new URL("./eval-set.json", import.meta.url);
/** The second committed set (agent-mem#62): invented Korean entries, shipped like the first. Selected with `amem eval --set ko`. */
export const KO_FIXTURE_PATH = new URL("./eval-set-ko.json", import.meta.url);
/** Built-in set names `--set` accepts instead of a path; a file literally named `ko` is reached as `./ko`. */
export const BUILTIN_SETS: Readonly<Record<string, URL>> = { ko: KO_FIXTURE_PATH };
/** The built-in set a `--set` argument names, or undefined when it is a path. Own keys only, so `--set constructor` is a path. */
export function builtinSet(name: string): URL | undefined {
  return Object.hasOwn(BUILTIN_SETS, name) ? BUILTIN_SETS[name] : undefined;
}
const PROJECT = "example.test/eval/fixture";
const DAY = 86400_000;
/** A fixed clock: entry ids hash their `at`, and recency weights the ranking, so a clock that only moves when the seeder moves it makes every run identical. */
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");

/**
 * Read and parse a set file. One descriptor does everything: it must be a regular file, its size is bounded before and after the read, and the bytes read are bounded
 * too, so a file that grows or is swapped between a size check and a read cannot slip a larger set through. A symlink is followed (the person named the path).
 */
export function readEvalSet(path: string | URL): EvalSet {
  const file = typeof path === "string" ? path : fileURLToPath(path), label = typeof path === "string" ? path : "the built-in fixture";
  const tooBig = () => new Error(`invalid eval set: ${label} is not a regular file within ${MAX_SET_BYTES} bytes`);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_SET_BYTES) throw tooBig();
    const buffer = Buffer.alloc(MAX_SET_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, length);
      if (n === 0) break;
      length += n;
    }
    const after = fstatSync(fd);
    if (length > MAX_SET_BYTES || after.size !== before.size || length !== before.size) throw tooBig();
    bytes = buffer.subarray(0, length);
  } finally { closeSync(fd); }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("invalid eval set: not valid JSON"); }
  return parseEvalSet(raw);
}

/** The ranked ids of `store.search` for one question, curated tier only (a question set names notes, and the capture tier is machine-local recall, never an answer key). */
function ranker(store: MemoryStore, project: string, window: number): { rank: (question: string) => string[]; engine: () => string } {
  let engine = "unknown";
  return {
    rank: question => {
      const result = store.search(question, { project, limit: window, includeCapture: false });
      engine = result.engine;
      return result.hits.flatMap(hit => hit.view ? [hit.view.id] : []);
    },
    engine: () => engine,
  };
}

/** A ranking under test: the ids it returns for a question, best first, up to `window` of them. `amem eval` scores `store.search`; F14 candidates are scored by passing another one. */
export type RankFn = (store: MemoryStore, question: string, window: number) => string[];

/** Score a self-contained set: seed its synthetic entries into a throwaway store, search it, and delete it. Touches no memory home. `rank` replaces `store.search` (an experiment, never the command). */
export function evalSeeded(set: EvalSet, ks?: readonly number[], rank?: RankFn): EvalReport {
  if (!set.entries?.length) throw new Error("this set has no entries; it must be run against a store");
  const dir = realPath(mkdtempSync(join(tmpdir(), "amem-eval-")));
  // The cleanup is armed the moment the directory exists, so a failure while building the store cannot leak it.
  let store: MemoryStore | undefined;
  try {
    const base = join(dir, "memory");
    mkdirSync(base, { recursive: true });
    // One entry per day, so the recency weight (a 30-day scale) is exercised, long-tier entries first and short-tier ones last: a short-term note leaves the index 14 days after it is
    // written, and the undated clock stops a day after the last entry, so the short ones written in that window are live when the set is searched (a set with more short entries than that
    // window holds loses its oldest, and a question naming one is then reported as not in the store, like any other missing entry).
    // Explicit dates override only their entry; undated entries retain their legacy file-order day.
    // Search a day after the latest actual seed time unless the set supplies its own clock.
    let current = EPOCH;
    store = new MemoryStore({ memoryDir: base, now: () => current, screen: () => "keep" });
    const ids = new Map<string, string>();
    const ordered = [...set.entries.filter(entry => entry.tier !== "short"), ...set.entries.filter(entry => entry.tier === "short")];
    let latest = -Infinity;
    for (const [index, entry] of ordered.entries()) {
      current = entry.at === undefined ? EPOCH + index * DAY : Date.parse(entry.at);
      latest = Math.max(latest, current);
      ids.set(entry.key, store.note({ op: "note", project: PROJECT, scope: "project", tier: entry.tier ?? "long", kind: entry.kind ?? "finding", peer: "eval", source: "person",
        ...(entry.title ? { title: entry.title } : {}), text: entry.text, about: entry.about ?? [] }, entry.tier === "short"));
    }
    current = set.now === undefined ? latest + DAY : Date.parse(set.now);
    const window = Math.max(...(ks ?? [10]));
    const search = rank ? { rank: (question: string) => rank(store!, question, window), engine: () => "custom" } : ranker(store, PROJECT, window);
    // Resolved through `store.get`, so a note that has already expired is absent, not silently present: coverage stays separate from ranking.
    const live = (name: string): string | undefined => { const id = ids.get(name); return id !== undefined && store!.get(id, PROJECT) ? id : undefined; };
    const report = runEval(search.rank, question => question.expect.map(live), set, "pending", ks);
    return { ...report, engine: search.engine() };
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Score a set of real entry ids against the bound project's store. Each expected name is resolved through `store.get` (so a promoted short-term id, a `mem:` prefix and an id older
 * than any list cap resolve like they do for `amem show`), then followed to the entry that is LIVE: a superseded entry points at its replacement, and `store.search` only ever returns the
 * replacement, so an expected id that was superseded stands for the head of its chain (a broken or cyclic chain is "not in the store"). A prefix that `get` cannot place is checked against
 * every visible id: more than one distinct live entry is refused with an error, because crediting whichever entry matched would let the ranking pick its own answer key.
 *
 * ponytail: `store.get` rebuilds the live view on every call, so the cost is names x store size. Names repeated across questions are resolved once (memoized for the run); the ceiling is
 * 500 questions x 20 names on a very large store, tens of seconds. Upgrade: one snapshot of the visible views (`list` with `includeSuperseded`) indexed by id, `promotedFrom` and
 * `supersededBy`, if a real set ever meets that.
 */
export function evalStore(store: MemoryStore, project: string, set: EvalSet, ks?: readonly number[]): EvalReport {
  let visible: View[] | undefined;
  const all = () => visible ??= store.list({ project, limit: Number.MAX_SAFE_INTEGER, includeSuperseded: true });
  /** The id of the live entry `view` stands for: itself, or the head of its supersede chain. */
  const live = (view: View): string | undefined => {
    const seen = new Set<string>();
    for (let current: View | undefined = view; current; current = store.get(current.supersededBy, project)) {
      if (!current.supersededBy) return current.id;
      if (seen.has(current.id)) return undefined;
      seen.add(current.id);
    }
    return undefined;
  };
  const known = new Map<string, string | undefined>();
  const resolve = (name: string): string | undefined => {
    if (known.has(name)) return known.get(name);
    let id: string | undefined;
    const found = store.get(name, project);
    if (found) id = live(found);
    else {
      const bare = name.replace(/^mem:/, "");
      const heads = new Set<string>(), seenAny = all().filter(view => view.id.startsWith(bare));
      for (const view of seenAny) { const head = live(view); if (head !== undefined) heads.add(head); }
      if (heads.size > 1) throw new Error(`invalid eval set: "${name.slice(0, 40)}" is the start of ${heads.size} entries; use more characters`);
      id = [...heads][0];
    }
    known.set(name, id);
    return id;
  };
  const search = ranker(store, project, Math.max(...(ks ?? [10])));
  const report = runEval(search.rank, (question: EvalQuestion) => question.expect.map(resolve), set, "pending", ks);
  return { ...report, engine: search.engine() };
}
