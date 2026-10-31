import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";
import { evalText, MAX_QUESTIONS, parseEvalSet, parseKs, runEval, type EvalSet } from "../src/memory/eval.ts";
import { evalSeeded, evalStore, FIXTURE_PATH, KO_FIXTURE_PATH, readEvalSet } from "../src/memory/eval-fixture.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { realPath } from "../src/memory/platform.ts";

// agent-mem#40 F13 / AC7: `amem eval` reports recall@k and MRR on a committed fixture question set. No model judge, no network.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = () => { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-eval-test-"))); roots.push(dir); return dir; };
const rows = (ids: string[]) => (_: string) => ids;
/** A resolver for tests: each expected name stands for itself, except those listed as missing. */
const names = (missing: string[] = []) => (question: { expect: string[] }) => question.expect.map(name => missing.includes(name) ? undefined : name);
const one = (expect: string[]) => ({ schema: "amem.eval/v1", questions: [{ q: "q", expect }] }) as unknown as EvalSet;

test("MRR, recall@k and hit@k are the textbook values on a hand-scored ranking", () => {
  // Three questions. Q1 expects {a}: found at rank 1. Q2 expects {b, c}: b at rank 2, c at rank 4. Q3 expects {d}: absent.
  const ranking: Record<string, string[]> = { q1: ["a", "x", "y"], q2: ["x", "b", "y", "c"], q3: ["x", "y", "z"] };
  const set = { schema: "amem.eval/v1", questions: [{ q: "q1", expect: ["a"] }, { q: "q2", expect: ["b", "c"] }, { q: "q3", expect: ["d"] }] } as EvalSet;
  const report = runEval(question => ranking[question]!, names(), set, "fts5", [1, 3, 5]);
  // MRR = (1/1 + 1/2 + 0) / 3
  expect(report.all.mrr).toBe(0.5);
  // hit@1 = 1/3, hit@3 = 2/3, hit@5 = 2/3
  expect(report.all.hit).toEqual({ 1: 0.3333, 3: 0.6667, 5: 0.6667 });
  // recall@1: Q1 1/1, Q2 0/2, Q3 0/1 = 1/3. recall@3: 1, 1/2, 0 = 0.5. recall@5: 1, 2/2, 0 = 2/3.
  expect(report.all.recall).toEqual({ 1: 0.3333, 3: 0.5, 5: 0.6667 });
  expect(report.perQuestion.map(row => row.rank)).toEqual([1, 2, null]);
});

test("a result list is scored only to the largest cutoff, and a repeated id counts once", () => {
  const report = runEval(rows(["x", "x", "a", "a"]), names(), one(["a"]), "fts5", [1, 2, 3]);
  expect(report.perQuestion[0]!.rank).toBe(2);                                          // the repeat of x does not push a down
  expect(report.all.hit).toEqual({ 1: 0, 2: 1, 3: 1 });
  const late = runEval(rows(["x", "y", "z", "a"]), names(), one(["a"]), "fts5", [3]);
  expect(late.perQuestion[0]!.rank).toBeNull();                                         // beyond the window is a miss, not rank 4
  expect(late.all.mrr).toBe(0);
});

test("a question whose expected entry is not in the store scores 0 in 'all' and is left out of 'answerable'", () => {
  const set = { schema: "amem.eval/v1", questions: [{ q: "present", expect: ["a"] }, { q: "absent", expect: ["gone"] }] } as EvalSet;
  const report = runEval(() => ["a"], names(["gone"]), set, "fts5", [1]);
  expect(report.all.questions).toBe(2); expect(report.answerable.questions).toBe(1);
  expect(report.all.hit[1]).toBe(0.5); expect(report.answerable.hit[1]).toBe(1);
  expect(report.perQuestion.map(row => row.answerable)).toEqual([true, false]);
  expect(evalText(report, "x")).toContain("1 question(s) name an entry this store does not hold");
});

test("answerable recall is over the entries the store holds: a name it does not hold never halves it (review finding 2)", () => {
  // expect [a, ghost] with a at rank 1: the ranking found everything it could, so answerable recall is 1, while 'all' still counts the ghost as a miss.
  const set = { schema: "amem.eval/v1", questions: [{ q: "q", expect: ["a", "ghost"] }] } as EvalSet;
  const report = runEval(() => ["a", "x"], names(["ghost"]), set, "fts5", [1, 5]);
  expect(report.answerable.recall).toEqual({ 1: 1, 5: 1 }); expect(report.answerable.hit).toEqual({ 1: 1, 5: 1 });
  expect(report.all.recall).toEqual({ 1: 0.5, 5: 0.5 });                                    // what a person experiences: one of the two things they wanted
  expect(report.perQuestion[0]).toMatchObject({ named: 2, present: 1, missing: 1, answerable: true });
});

test("two names for the same entry count once, in recall and in the denominator (review nit)", () => {
  const set = { schema: "amem.eval/v1", questions: [{ q: "q", expect: ["a", "a-prefix"] }] } as EvalSet;
  const same = (question: { expect: string[] }) => question.expect.map(() => "id-a");      // both names resolve to the one entry
  const report = runEval(() => ["id-a"], same, set, "fts5", [1]);
  expect(report.all.recall).toEqual({ 1: 1 }); expect(report.answerable.recall).toEqual({ 1: 1 });
  expect(report.perQuestion[0]).toMatchObject({ named: 2, present: 1, missing: 0 });
});

test("with no answerable question the 'answerable' row reports null, never a measured zero (review nit)", () => {
  const set = { schema: "amem.eval/v1", questions: [{ q: "q", expect: ["gone"] }] } as EvalSet;
  const report = runEval(() => ["x"], names(["gone"]), set, "fts5", [1]);
  expect(report.answerable).toEqual({ questions: 0, recall: { 1: null }, hit: { 1: null }, mrr: null });
  expect(report.all.mrr).toBe(0);
  expect(evalText(report, "x")).toContain("n/a");
});

test("the report identifies the default CLI ranked engine and explicit legacy filter", () => {
  const report = runEval(() => [], names(), one(["a"]), "fts5", [1]);
  const text = evalText(report, "x");
  expect(text).toContain("ranked store.search"); expect(text).toContain("same ranked search path as default `amem search`");
  expect(text).toContain("`--filter` keeps legacy substring matching");
  expect(evalText({ ...report, engine: "substring" }, "x")).toContain("substring fallback");
});

test("the parser accepts the committed fixture and refuses every malformed set by name, never silently", () => {
  const base = { schema: "amem.eval/v1", entries: [{ key: "a", text: "alpha" }], questions: [{ q: "alpha", expect: ["a"] }] };
  expect(parseEvalSet(base).questions).toHaveLength(1);
  const bad = (change: (set: any) => void, message: string) => { const copy = JSON.parse(JSON.stringify(base)); change(copy); expect(() => parseEvalSet(copy), message).toThrow(message); };
  bad(set => { set.schema = "amem.eval/v2"; }, "schema must be");
  bad(set => { set.extra = 1; }, "unknown key");
  bad(set => { set.entries[0].colour = "x"; }, "unknown key");
  bad(set => { set.questions[0].extra = 1; }, "unknown key");
  bad(set => { set.entries.push({ key: "a", text: "again" }); }, "repeats");
  bad(set => { set.entries[0].key = "bad key"; }, "may use letters");
  bad(set => { set.entries[0].kind = "weird"; }, "kind must be");
  bad(set => { set.entries[0].text = ""; }, "non-empty string");
  bad(set => { set.entries[0].text = "a\u0000b"; }, "non-empty string");
  bad(set => { set.questions = []; }, "questions must hold");
  bad(set => { set.questions[0].expect = []; }, "expect must hold");
  bad(set => { set.questions[0].expect = ["nope"]; }, "not an entry key");
  bad(set => { set.questions = Array.from({ length: MAX_QUESTIONS + 1 }, () => ({ q: "q", expect: ["a"] })); }, "questions must hold");
  expect(() => parseEvalSet(null)).toThrow("must be an object");
  expect(() => parseEvalSet([])).toThrow("must be an object");
  // Without entries, expect holds ids: an arbitrary word is refused, an id or an 8+ hex prefix is accepted.
  expect(() => parseEvalSet({ schema: "amem.eval/v1", questions: [{ q: "q", expect: ["notanid"] }] })).toThrow("entry id, optionally written mem:<id>");
  expect(parseEvalSet({ schema: "amem.eval/v1", questions: [{ q: "q", expect: ["0123abcd"] }] }).questions).toHaveLength(1);
  expect(parseEvalSet({ schema: "amem.eval/v1", questions: [{ q: "q", expect: ["mem:0123abcdef"] }] }).questions).toHaveLength(1);   // as a brief prints it
  expect(() => parseEvalSet({ schema: "amem.eval/v1", questions: [{ q: "q", expect: ["mem:xyz"] }] })).toThrow("entry id");
});

test("--k parsing: ascending, unique, bounded", () => {
  expect(parseKs(undefined)).toEqual([1, 5, 10]);
  expect(parseKs("10, 1,5,5")).toEqual([1, 5, 10]);
  for (const value of ["", "0", "101", "a", "1,,2", "-1", "1.5", "1e2"]) expect(() => parseKs(value), value).toThrow("--k must be");
});

test("the committed fixture is synthetic, self-contained and parses; its measured scores are pinned so a search change moves them on purpose", () => {
  const set = readEvalSet(FIXTURE_PATH);
  expect(set.entries!.length).toBeGreaterThanOrEqual(20); expect(set.questions.length).toBeGreaterThanOrEqual(25);
  expect(set.entries!.some(entry => entry.tier === "short")).toBe(true);                    // the short-tier weight and expiry are exercised, not only long-tier notes
  // Synthetic: invented harbour entries only. Nothing here may look like a person's memory (a home path, an address, a secret).
  const flat = JSON.stringify(set);
  expect(flat).not.toMatch(/\/Users\/|\/home\/|@[a-z0-9-]+\.[a-z]{2,}|agent-hub|AKIA|sk-[A-Za-z0-9]{10}|BEGIN [A-Z ]*PRIVATE KEY/);
  const report = evalSeeded(set);
  expect(report.engine).toBe("fts5");
  // Pin the numbers of the current search (BM25 over title, text and about). A lexical change (F14) lands with a gain recorded here: raise these in that PR.
  expect({ questions: report.all.questions, mrr: report.all.mrr, hit10: report.all.hit[10], recall1: report.all.recall[1] }).toEqual({ questions: 32, mrr: 0.9063, hit10: 0.9375, recall1: 0.8281 });
  expect(report.perQuestion.filter(row => row.rank === null).map(row => row.q)).toEqual(["vessel arrival prediction model", "who approves overtime"]);
  expect(report.answerable.questions).toBe(32);                                              // every question names a note the seeded store holds
});

test("a run is deterministic and leaves no memory home behind", async () => {
  const set = readEvalSet(FIXTURE_PATH);
  const before = (await import("node:fs")).readdirSync(tmpdir()).filter(name => name.startsWith("amem-eval-"));
  expect(JSON.stringify(evalSeeded(set))).toBe(JSON.stringify(evalSeeded(set)));
  expect((await import("node:fs")).readdirSync(tmpdir()).filter(name => name.startsWith("amem-eval-"))).toEqual(before);
});

test("evalStore scores real ids against the bound project's store, by full id and by 8-character prefix", () => {
  const dir = temp(), project = "example.test/eval/real";
  const store = new MemoryStore({ memoryDir: join(dir, "memory"), screen: () => "keep" });
  try {
    const note = (text: string) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "p", source: "person", text, about: [] });
    const a = note("the lighthouse lamp is replaced every spring"), b = note("pelican feeding schedule changed in autumn");
    const set = { schema: "amem.eval/v1", questions: [{ q: "lighthouse lamp", expect: [a] }, { q: "pelican feeding", expect: [b.slice(0, 8)] }, { q: "lighthouse lamp", expect: ["0123456789abcdef"] }] } as EvalSet;
    const report = evalStore(store, project, set, [1, 5]);
    expect(report.all.hit).toEqual({ 1: 0.6667, 5: 0.6667 });                           // the third names an id the store does not hold
    expect(report.answerable.hit).toEqual({ 1: 1, 5: 1 }); expect(report.answerable.mrr).toBe(1);
    expect(report.perQuestion.map(row => row.answerable)).toEqual([true, true, false]);
  } finally { store.close(); }
});

test("readEvalSet refuses a missing file, a directory, an oversized file and invalid JSON, naming the problem", () => {
  const dir = temp();
  expect(() => readEvalSet(join(dir, "none.json"))).toThrow("ENOENT");
  expect(() => readEvalSet(dir)).toThrow("regular file");
  writeFileSync(join(dir, "bad.json"), "{ not json");
  expect(() => readEvalSet(join(dir, "bad.json"))).toThrow("not valid JSON");
  writeFileSync(join(dir, "big.json"), "x".repeat(1024 * 1024 + 1));
  expect(() => readEvalSet(join(dir, "big.json"))).toThrow("regular file within");
});

// ---- the command ----

function home() {
  const root = temp(), memory = join(root, "memory"), cwd = join(root, "repo");
  mkdirSync(memory, { recursive: true }); mkdirSync(join(cwd, ".git"), { recursive: true });
  return { root, memory, cwd, project: memoryProjectKey(cwd) };
}
async function cli(h: ReturnType<typeof home>, args: string[]): Promise<string> {
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = h.memory;
  try { return await runCli(args, { cwd: h.cwd, env: {}, stdinTTY: true }); } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}

test("amem eval with no set scores the built-in fixture, as text and as JSON, and never writes the memory home", async () => {
  const h = home();
  const text = await cli(h, ["eval"]);
  expect(text).toContain("eval: built-in fixture (ranked store.search, engine fts5;"); expect(text).toContain("MRR"); expect(text).toContain("miss: who approves overtime");
  const json = JSON.parse(await cli(h, ["eval", "--json", "--k", "1,3"])) as { engine: string; ks: number[]; all: { questions: number; mrr: number; hit: Record<string, number> }; answerable: { questions: number } };
  expect(json.engine).toBe("fts5"); expect(json.ks).toEqual([1, 3]); expect(json.all.questions).toBe(32); expect(json.all.mrr).toBe(0.9063);
  expect(Object.keys(json.all.hit)).toEqual(["1", "3"]);
  expect((await import("node:fs")).readdirSync(h.memory)).toEqual([]);                  // the person's home is untouched: the fixture ran in a throwaway store
});

test("amem eval --set scores a person's own set against the bound project's real entries", async () => {
  const h = home();
  const store = new MemoryStore({ memoryDir: h.memory, screen: () => "keep" });
  let id: string;
  try { id = store.note({ op: "note", project: h.project, scope: "project", tier: "long", kind: "decision", peer: "p", source: "person", text: "the quay lights switch to amber at dusk", about: [] }); } finally { store.close(); }
  const file = join(h.root, "mine.json");
  writeFileSync(file, JSON.stringify({ schema: "amem.eval/v1", questions: [{ q: "quay lights amber", expect: [id.slice(0, 12)] }, { q: "something never written", expect: [id] }] }));
  const json = JSON.parse(await cli(h, ["eval", "--set", file, "--json", "--k", "1,5"])) as { all: { questions: number; hit: Record<string, number> }; answerable: { questions: number } };
  expect(json.all.questions).toBe(2); expect(json.all.hit).toEqual({ 1: 0.5, 5: 0.5 });   // the second question expects a real note that its query cannot reach
  expect(json.answerable.questions).toBe(2);
});

test("amem eval refuses a bad set, a bad --k and an unknown flag; marked reads fail closed before evaluation", async () => {
  const h = home();
  const file = join(h.root, "bad.json"); writeFileSync(file, JSON.stringify({ schema: "amem.eval/v1", questions: [{ q: "q", expect: ["nope"] }] }));
  await expect(cli(h, ["eval", "--set", file])).rejects.toThrow("invalid eval set");
  await expect(cli(h, ["eval", "--k", "0"])).rejects.toThrow("--k must be");
  await expect(cli(h, ["eval", "--bogus"])).rejects.toThrow("--bogus");
  await expect(cli(h, ["eval", "--set", join(h.root, "missing.json")])).rejects.toThrow("ENOENT");
  await expect(runCli(["eval"], { cwd: h.cwd, env: { CLAUDECODE: "1", HOME: h.root, AMEM_HOME: h.memory }, stdinTTY: true })).rejects.toThrow(/is not available to an agent-marked session\. Agent reads: search, list, show, brief, graph, vault-candidates, capacity\./);
});

test("amem eval is listed in help and completion, and takes no --policy-free", async () => {
  const h = home();
  expect(await cli(h, ["--help"])).toContain("eval");
  expect(await cli(h, ["completion", "zsh"])).toContain("eval");
  expect(await cli(h, ["completion", "bash"])).toContain("--set");
});

test("a symlinked --set file is followed (the person named it) and still bounded", () => {
  const dir = temp(), target = join(dir, "real.json"), link = join(dir, "link.json");
  writeFileSync(target, JSON.stringify({ schema: "amem.eval/v1", entries: [{ key: "a", text: "alpha beta" }], questions: [{ q: "alpha", expect: ["a"] }] }));
  symlinkSync(target, link);
  const report = evalSeeded(readEvalSet(link), [1]);
  expect(report.all.hit[1]).toBe(1);
});

// ---- claude's round 1 on #421 ----

test("plain `amem eval` works from an install path with a space and non-ASCII characters (review finding 1)", async () => {
  const dir = temp(), odd = join(dir, "sp ace", "한글 dir"); mkdirSync(odd, { recursive: true });
  // A file URL with escapes: `.pathname` of it stays percent-encoded and statSync looks for a literal "%20".
  const file = join(odd, "eval-set.json"), url = new URL(`file://${encodeURI(file)}`);
  expect(url.pathname).toContain("%20");
  writeFileSync(file, JSON.stringify({ schema: "amem.eval/v1", entries: [{ key: "a", text: "alpha beta" }], questions: [{ q: "alpha", expect: ["a"] }] }));
  expect(readEvalSet(url).questions).toHaveLength(1);
  expect(evalSeeded(readEvalSet(url), [1]).all.hit[1]).toBe(1);
  const { fileURLToPath } = await import("node:url");
  expect(fileURLToPath(FIXTURE_PATH)).toMatch(/eval-set\.json$/); expect(fileURLToPath(FIXTURE_PATH)).not.toContain("%");
});

test("a real-store name resolves through store.get: a promoted short-term id, a mem: prefix and an old id all count (review finding 3)", () => {
  const dir = temp(), project = "example.test/eval/promoted";
  const store = new MemoryStore({ memoryDir: join(dir, "memory"), screen: () => "promote" });
  try {
    const short = store.note({ op: "note", project, scope: "project", tier: "short", kind: "finding", peer: "p", source: "person", text: "the beacon lens is cleaned on Tuesdays", about: [] }, true);
    const promoted = store.promote(short, "person", project);
    expect(promoted).toBeDefined(); expect(promoted).not.toBe(short);                       // promotion makes a new long-term copy with a different id
    expect(store.get(short, project)?.id).toBe(promoted);                                   // and `get` still resolves the old short id to it
    const set = { schema: "amem.eval/v1", questions: [{ q: "beacon lens cleaned", expect: [short] }, { q: "beacon lens cleaned", expect: [`mem:${promoted!.slice(0, 10)}`] }] } as EvalSet;
    const report = evalStore(store, project, set, [1]);
    expect(report.perQuestion.map(row => row.answerable)).toEqual([true, true]);           // before: the promoted short id resolved to nothing
    expect(report.all.hit[1]).toBe(1);
  } finally { store.close(); }
});

test("a real-store name older than store.list's default page still resolves, and the resolver asks list for everything, not a cap (review finding 3, bot thread)", () => {
  const dir = temp(), project = "example.test/eval/many";
  let tick = 0;
  const store = new MemoryStore({ memoryDir: join(dir, "memory"), now: () => Date.parse("2026-01-01T00:00:00.000Z") + tick++ * 1000, screen: () => "keep" });
  try {
    const first = store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "p", source: "person", text: "the oldest unique zeppelin hangar note", about: [] });
    for (let i = 0; i < 230; i++) store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "p", source: "person", text: `filler ${i}`, about: [] });
    expect(store.list({ project }).some(view => view.id === first)).toBe(false);                 // beyond list's default 200: the old shape of the bug
    const limits: unknown[] = [], realList = store.list.bind(store);
    store.list = (filter = {}) => { limits.push(filter.limit); return realList(filter); };
    // A prefix shorter than the 6 characters `get` places, but unique among every entry: only the full-list fallback can resolve it.
    const everyId = realList({ project, limit: Number.MAX_SAFE_INTEGER }).map(view => view.id);
    const short = [1, 2, 3, 4, 5].map(length => first.slice(0, length)).find(prefix => everyId.filter(id => id.startsWith(prefix)).length === 1);
    expect(short, "a unique prefix of at most 5 characters exists among 231 ids").toBeDefined();
    limits.length = 0;
    const set = { schema: "amem.eval/v1", questions: [{ q: "zeppelin hangar", expect: [first] }, { q: "zeppelin hangar", expect: [first.slice(0, 12)] }, { q: "zeppelin hangar", expect: [short!] }] } as EvalSet;
    const report = evalStore(store, project, set, [1, 5]);
    expect(report.perQuestion.map(row => row.answerable)).toEqual([true, true, true]);
    expect(report.all.hit[1]).toBe(1);
    // Whatever the page size of the day, the full-list fallback (reached for a prefix `get` cannot place) must not pass a small cap: 5000 was the review's example.
    expect(limits.length).toBeGreaterThan(0);
    for (const limit of limits) expect(limit === undefined ? Infinity : Number(limit)).toBeGreaterThan(1_000_000);
  } finally { store.close(); }
});

test("an ambiguous prefix is refused with an error, never credited to whichever entry matched (review finding 3)", () => {
  const dir = temp(), project = "example.test/eval/ambiguous";
  const store = new MemoryStore({ memoryDir: join(dir, "memory"), screen: () => "keep" });
  try {
    // Find two ids that share a prefix by writing notes until two collide on 2 hex characters (they do within a few dozen), then ask with that prefix.
    const byPrefix = new Map<string, string[]>();
    for (let i = 0; i < 200 && ![...byPrefix.values()].some(list => list.length > 1); i++) {
      const id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "p", source: "person", text: `note number ${i}`, about: [] });
      byPrefix.set(id.slice(0, 2), [...(byPrefix.get(id.slice(0, 2)) ?? []), id]);
    }
    const shared = [...byPrefix.entries()].find(([, list]) => list.length > 1)![0];
    // The parser demands 8 hex characters without entries, so the set is built past it: this is the resolver's own guard.
    const set = { schema: "amem.eval/v1", questions: [{ q: "note number", expect: [shared] }] } as EvalSet;
    expect(() => evalStore(store, project, set, [1])).toThrow("is the start of");
  } finally { store.close(); }
});

test("readEvalSet reads through one bounded descriptor: it refuses a directory, a growing file and an oversized file (review nit)", () => {
  const dir = temp();
  expect(() => readEvalSet(dir)).toThrow("regular file");
  writeFileSync(join(dir, "big.json"), "x".repeat(1024 * 1024 + 1));
  expect(() => readEvalSet(join(dir, "big.json"))).toThrow("regular file within");
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ schema: "amem.eval/v1", questions: [{ q: "q", expect: ["0123abcd"] }] }));
  expect(readEvalSet(join(dir, "ok.json")).questions).toHaveLength(1);
  writeFileSync(join(dir, "binary.json"), Buffer.from([0xff, 0xfe, 0x7b]));
  expect(() => readEvalSet(join(dir, "binary.json"))).toThrow("not valid JSON");           // invalid UTF-8 is refused, not replaced
});

test("evalSeeded leaves no temp directory behind when it fails after creating it (review nit)", () => {
  const before = (name: string) => name.startsWith("amem-eval-") && !name.startsWith("amem-eval-test-");
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const was = readdirSync(tmpdir()).filter(before);
  const set = { schema: "amem.eval/v1", entries: [{ key: "a", text: "alpha" }], questions: [{ q: "alpha", expect: ["a"] }] } as EvalSet;
  // `ks` that is not iterable throws inside evalSeeded after the directory and the store exist.
  expect(() => evalSeeded(set, {} as unknown as number[])).toThrow();
  expect(readdirSync(tmpdir()).filter(before)).toEqual(was);
});

test("a short-tier entry and the day-spread clock are exercised: the fixture ranks a newer note above an older twin, and a short note stays live", () => {
  const report = evalSeeded(readEvalSet(FIXTURE_PATH), [1, 3]);
  const row = (q: string) => report.perQuestion.find(item => item.q === q)!;
  expect(row("where is the shift handover done").rank).toBe(1);                              // the newer short-tier twin outranks the older long-tier one on recency
  expect(row("where is the shift handover done").answerable).toBe(true);
  expect(row("dock sensor timeout").answerable).toBe(true);                                  // a short-tier entry is still live when searched
});

test("the entry tier is part of the set format: short or long only", () => {
  const base = { schema: "amem.eval/v1", entries: [{ key: "a", text: "alpha", tier: "short" }], questions: [{ q: "alpha", expect: ["a"] }] };
  expect(parseEvalSet(base).entries![0]!.tier).toBe("short");
  expect(() => parseEvalSet({ ...base, entries: [{ key: "a", text: "alpha", tier: "forever" }] })).toThrow("tier must be short or long");
});

test("an ambiguous prefix among entries older than list's default page is still refused: the fallback reads every visible id (review finding 3, bot thread)", () => {
  const dir = temp(), project = "example.test/eval/old-ambiguous";
  let tick = 0;
  const store = new MemoryStore({ memoryDir: join(dir, "memory"), now: () => Date.parse("2026-01-01T00:00:00.000Z") + tick++ * 1000, screen: () => "keep" });
  try {
    const note = (text: string) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "p", source: "person", text, about: [] });
    const seen = new Map<string, string>(); let pair: string[] | undefined;
    for (let i = 0; i < 400 && !pair; i++) { const id = note(`old ${i}`), key = id.slice(0, 2); if (seen.has(key)) pair = [seen.get(key)!, id]; else seen.set(key, id); }
    for (let i = 0; i < 230; i++) note(`filler ${i}`);
    const prefix = pair![0]!.slice(0, 2);
    expect(store.list({ project }).some(view => pair!.includes(view.id))).toBe(false);          // both really are beyond list's default page
    expect(store.get(prefix, project)).toBeUndefined();                                          // so `get` cannot place the short prefix and the fallback decides
    const set = { schema: "amem.eval/v1", questions: [{ q: "old", expect: ["placeholder"] }] } as EvalSet;
    set.questions[0]!.expect = [prefix];
    expect(() => evalStore(store, project, set, [1])).toThrow("is the start of");
  } finally { store.close(); }
});

test("the short-tier weight is exercised: with identical text a long-tier note outranks a newer short-tier twin, and a short tier ignored at seeding would flip that", () => {
  // Seeding writes long entries first (day 0) and short ones after (day 1), the clock stops on day 2. Both are live. The newer short note has the better recency
  // (1/(1+1/30) against 1/(1+2/30)) but the short tier weighs 0.9, which is not enough to overtake: the long note ranks first. If tier were ignored both would weigh 1, the newer
  // one would win, and the expected note would drop to rank 2.
  const set = { schema: "amem.eval/v1", entries: [
    { key: "durable", tier: "long", text: "the harbour pilot boat refuels at the north pier every evening" },
    { key: "transient", tier: "short", text: "the harbour pilot boat refuels at the north pier every evening" },
  ], questions: [{ q: "pilot boat refuels north pier", expect: ["durable"] }] } as EvalSet;
  expect(evalSeeded(set, [1, 2]).perQuestion[0]).toMatchObject({ rank: 1, present: 1 });
});

test("a superseded expected id stands for the live replacement at the head of its chain, never for an entry search cannot return (review round 2)", () => {
  const dir = temp(), project = "example.test/eval/superseded";
  const store = new MemoryStore({ memoryDir: join(dir, "memory"), screen: () => "keep" });
  try {
    const note = (text: string) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "p", source: "person", text, about: [] });
    const old = note("the beacon lamp is amber"), mid = note("the beacon lamp is now green"), head = note("the beacon lamp is now blue");
    expect(store.supersede(old, mid, "person", project)).toBe(true); expect(store.supersede(mid, head, "person", project)).toBe(true);
    expect(store.search("beacon lamp", { project, includeCapture: false }).hits.map(hit => hit.view!.id)).toEqual([head]);   // search never returns a superseded entry
    const set = { schema: "amem.eval/v1", questions: [{ q: "beacon lamp", expect: [old] }, { q: "beacon lamp", expect: [mid.slice(0, 10)] }, { q: "beacon lamp", expect: [head] }, { q: "beacon lamp", expect: [old, head] }] } as EvalSet;
    const report = evalStore(store, project, set, [1, 5]);
    expect(report.perQuestion.map(row => ({ answerable: row.answerable, rank: row.rank, present: row.present }))).toEqual([
      { answerable: true, rank: 1, present: 1 },    // the old id follows its chain to the head: answerable and found (before: answerable but rank null, a coverage gap charged to ranking)
      { answerable: true, rank: 1, present: 1 },    // a prefix of the middle entry too
      { answerable: true, rank: 1, present: 1 },
      { answerable: true, rank: 1, present: 1 },    // old and head are one entry now: counted once
    ]);
    expect(report.answerable.hit).toEqual({ 1: 1, 5: 1 }); expect(report.answerable.recall).toEqual({ 1: 1, 5: 1 });
  } finally { store.close(); }
});

test("when the replacement of a superseded entry is forgotten the store makes the old entry live again, and eval then finds it (the store's own rule, not a gap)", () => {
  const dir = temp(), project = "example.test/eval/forgotten";
  const store = new MemoryStore({ memoryDir: join(dir, "memory"), screen: () => "keep" });
  try {
    const note = (text: string) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "p", source: "person", text, about: [] });
    const old = note("the harbour bell rings at noon"), replacement = note("the harbour bell rings at one");
    expect(store.supersede(old, replacement, "person", project)).toBe(true);
    expect(store.forget(replacement, "person", project)).toBeDefined();
    expect(store.get(old, project)?.supersededBy).toBeNull();                                    // the pointer died with its target: the old entry is the live one again
    const report = evalStore(store, project, { schema: "amem.eval/v1", questions: [{ q: "harbour bell", expect: [old] }, { q: "harbour bell", expect: [replacement] }] } as EvalSet, [1]);
    expect(report.perQuestion[0]).toMatchObject({ answerable: true, rank: 1, present: 1, missing: 0 });
    expect(report.perQuestion[1]).toMatchObject({ answerable: false, present: 0, missing: 1 });   // the forgotten entry itself is not in the store
  } finally { store.close(); }
});

test("a name repeated across questions is resolved once per run (the per-name cost ceiling, review round 2)", () => {
  const dir = temp(), project = "example.test/eval/memo";
  const store = new MemoryStore({ memoryDir: join(dir, "memory"), screen: () => "keep" });
  try {
    const id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "p", source: "person", text: "memoised lantern", about: [] });
    const calls: string[] = [], realGet = store.get.bind(store);
    store.get = (name: string, scope?: string) => { calls.push(name); return realGet(name, scope); };
    const set = { schema: "amem.eval/v1", questions: Array.from({ length: 10 }, () => ({ q: "memoised lantern", expect: [id] })) } as EvalSet;
    evalStore(store, project, set, [1]);
    expect(calls.filter(name => name === id)).toHaveLength(1);                                   // ten questions, one lookup of that name
  } finally { store.close(); }
});

test("a short prefix that only the full-list fallback can place also follows a supersede chain to the live head (review round 2)", () => {
  const dir = temp(), project = "example.test/eval/superseded-prefix";
  const store = new MemoryStore({ memoryDir: join(dir, "memory"), screen: () => "keep" });
  try {
    const note = (text: string) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "p", source: "person", text, about: [] });
    const old = note("the quay crane is painted red"), head = note("the quay crane is painted yellow");
    expect(store.supersede(old, head, "person", project)).toBe(true);
    const ids = store.list({ project, includeSuperseded: true }).map(view => view.id);
    const prefix = [1, 2, 3, 4, 5].map(length => old.slice(0, length)).find(candidate => ids.filter(id => id.startsWith(candidate)).length === 1)!;
    expect(prefix).toBeDefined(); expect(store.get(prefix, project)).toBeUndefined();            // too short for `get`: only the fallback places it
    const report = evalStore(store, project, { schema: "amem.eval/v1", questions: [{ q: "quay crane painted", expect: [prefix] }] } as EvalSet, [1]);
    expect(report.perQuestion[0]).toMatchObject({ answerable: true, rank: 1, present: 1 });     // before: the superseded id itself, which search never returns
  } finally { store.close(); }
});

test("a supersede cycle (a store the API refuses to build, but a hand-edited log could hold) is 'not in the store', never an endless loop (review round 2)", () => {
  const view = (id: string, supersededBy: string | null) => ({ id, supersededBy, project: "p" }) as unknown as import("../src/memory/store.ts").View;
  const a = view("aaaaaaaa", "bbbbbbbb"), b = view("bbbbbbbb", "aaaaaaaa");
  const stub = { get: (name: string) => name === "aaaaaaaa" ? a : name === "bbbbbbbb" ? b : undefined, list: () => [a, b],
    search: () => ({ engine: "fts5", hits: [] }) } as unknown as MemoryStore;
  const report = evalStore(stub, "p", { schema: "amem.eval/v1", questions: [{ q: "q", expect: ["aaaaaaaa"] }] } as EvalSet, [1]);
  expect(report.perQuestion[0]).toMatchObject({ answerable: false, present: 0, missing: 1 });
});

// agent-mem#62: the Korean recall set and its pinned baseline. Measure only: a ranking or tokenizer change that moves these numbers fails here until the receipt in docs/contracts.md is updated with it.
const KINDS = ["particle", "spacing", "mixed", "abbreviation", "tier"] as const;

test("the Korean set is synthetic, written as literal Hangul, has at least 30 questions and each of the five kinds at least 4 times (agent-mem#62 AC2)", async () => {
  const raw = await Bun.file(new URL("../src/memory/eval-set-ko.json", import.meta.url)).text();
  expect(raw).not.toMatch(/\\u[0-9a-fA-F]{4}/);                                             // literal characters, not escapes
  expect(raw).toMatch(/[가-힣]/);
  expect(raw).not.toMatch(/\/Users\/|\/home\/|@[a-z0-9-]+\.[a-z]{2,}|agent-hub|AKIA|sk-[A-Za-z0-9]{10}|BEGIN [A-Z ]*PRIVATE KEY/);
  const set = readEvalSet(KO_FIXTURE_PATH);
  expect(set.questions.length).toBeGreaterThanOrEqual(30);
  const counts = Object.fromEntries(KINDS.map(kind => [kind, set.questions.filter(question => question.tag === kind).length]));
  for (const kind of KINDS) expect(counts[kind], kind).toBeGreaterThanOrEqual(4);
  expect(set.questions.every(question => question.tag !== undefined && (KINDS as readonly string[]).includes(question.tag))).toBe(true);   // no untagged or misspelled question
  // The tier kind needs both tiers, written a day apart by the seeder: short-tier entries exist, and every tier question names an entry.
  expect(set.entries!.some(entry => entry.tier === "short")).toBe(true);
  expect(set.entries!.some(entry => entry.tier !== "short")).toBe(true);
  // Mixed and abbreviation questions really carry Latin script, and every question carries Hangul.
  for (const question of set.questions.filter(question => question.tag === "mixed" || question.tag === "abbreviation")) expect(question.q, question.q).toMatch(/[A-Za-z]/);
  for (const question of set.questions) expect(question.q, question.q).toMatch(/[가-힣]/);
});

test("the Korean baseline is pinned exactly: recall@1/5/10, hit, MRR and the answerable split, with no model and no network (agent-mem#62 AC1, AC4)", () => {
  const set = readEvalSet(KO_FIXTURE_PATH);
  const report = evalSeeded(set);
  expect(report.engine).toBe("fts5");
  // The numbers of the current search (BM25, particle-stripped Korean alternative, prefix terms). A ranking change that moves them lands with an updated receipt in docs/contracts.md.
  expect(report.all).toEqual({
    questions: 38,
    recall: { 1: 0.8684, 5: 0.9474, 10: 0.9474 },
    hit: { 1: 0.8684, 5: 0.9474, 10: 0.9474 },
    mrr: 0.8934,
  });
  expect(report.answerable).toEqual(report.all);                                            // every question names a note the seeded store holds: all of the miss is ranking
  const moved = report.perQuestion.filter(row => row.rank !== 1).map(row => [row.q, row.rank]);
  expect(moved).toEqual([
    ["예약된 책은 기간을 늘릴 수 없나요", 4],
    ["개인정보처리방침", null],
    ["열람 실 개방", 5],
    ["도서관리시스템", null],
    ["회의 록", 2],
  ]);
  expect(JSON.stringify(evalSeeded(set))).toBe(JSON.stringify(report));                    // the same on every run
});

test("amem eval --set ko scores the built-in Korean set, as text and JSON, never touches the memory home, and --set <path> still works", async () => {
  const h = home();
  const text = await cli(h, ["eval", "--set", "ko"]);
  expect(text).toContain("eval: built-in fixture ko (ranked store.search, engine fts5;"); expect(text).toContain("miss: 개인정보처리방침");
  const json = JSON.parse(await cli(h, ["eval", "--set", "ko", "--json"])) as { all: { questions: number; mrr: number; hit: Record<string, number> }; answerable: { questions: number } };
  expect(json.all.questions).toBe(38); expect(json.all.mrr).toBe(0.8934); expect(json.all.hit).toEqual({ 1: 0.8684, 5: 0.9474, 10: 0.9474 }); expect(json.answerable.questions).toBe(38);
  expect((await import("node:fs")).readdirSync(h.memory)).toEqual([]);
  // A path to the same file gives the same numbers: the explicit form is unchanged.
  const same = JSON.parse(await cli(h, ["eval", "--set", fileURLToPath(KO_FIXTURE_PATH), "--json"])) as { all: { mrr: number } };
  expect(same.all.mrr).toBe(0.8934);
  // The built-in English set is still the default, and an unknown name is a path (an ENOENT), never a silent fallback.
  expect(JSON.parse(await cli(h, ["eval", "--json"])).all.questions).toBe(32);
  await expect(cli(h, ["eval", "--set", "constructor"])).rejects.toThrow("ENOENT");
  expect(await cli(h, ["--help"])).toContain("eval");
  expect(await cli(h, ["completion", "bash"])).toContain("--set");
});

test("a question tag is optional, lowercase and bounded, and an unknown key is still refused", () => {
  const base = { schema: "amem.eval/v1", entries: [{ key: "a", text: "alpha" }], questions: [{ q: "alpha", expect: ["a"], tag: "particle" }] };
  expect(parseEvalSet(base).questions[0]!.tag).toBe("particle");
  expect(parseEvalSet({ ...base, questions: [{ q: "alpha", expect: ["a"] }] }).questions[0]).toEqual({ q: "alpha", expect: ["a"] });
  for (const tag of ["", "Upper", "a b", 1, "x".repeat(41)]) expect(() => parseEvalSet({ ...base, questions: [{ q: "alpha", expect: ["a"], tag }] }), String(tag)).toThrow("tag must be");
  expect(() => parseEvalSet({ ...base, questions: [{ q: "alpha", expect: ["a"], kind: "particle" }] })).toThrow("unknown key");
});

test("a project's own Korean entries are scored with --set <file>, no entries in the file and nothing published (the receipt's example)", async () => {
  const h = home();
  const store = new MemoryStore({ memoryDir: h.memory, screen: () => "keep" });
  let id: string;
  try { id = store.note({ op: "note", project: h.project, scope: "project", tier: "long", kind: "decision", peer: "p", source: "person", title: "사업계획서는 분기 말까지 낸다", text: "사업 계획서는 분기 말까지 위원회에 제출한다", about: [] }); } finally { store.close(); }
  const file = join(h.root, "mine-ko.json");
  writeFileSync(file, JSON.stringify({ schema: "amem.eval/v1", questions: [{ q: "사업계획서는 언제까지", expect: [id.slice(0, 12)], tag: "spacing" }] }));
  const json = JSON.parse(await cli(h, ["eval", "--set", file, "--json", "--k", "1,5"])) as { all: { questions: number; hit: Record<string, number> } };
  expect(json.all.questions).toBe(1); expect(json.all.hit).toEqual({ 1: 1, 5: 1 });
});
