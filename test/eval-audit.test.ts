import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { AUDIT_KINDS, AUDIT_LABELS, MAX_AUDIT_NOTES, auditAge, cohenKappa, foldAnchorStatus } from "../src/memory/eval.ts";
import { appendAlias } from "../src/memory/aliases.ts";
import { auditSample, auditScore, auditScoreText, readAuditSheet, writeAuditSheet, type AuditNote, type AuditSheet } from "../src/memory/eval-audit.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { realPath } from "../src/memory/platform.ts";
import { MemoryStore, type Kind, type View } from "../src/memory/store.ts";

// agent-mem#326: a correctness audit that leaves judging outside amem. No model and no network here: the only outside read is the project's own git history.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = () => { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-audit-"))); roots.push(dir); return dir; };

const DAY = 86_400_000, NOTE = Date.parse("2026-01-05T00:00:00.000Z"), NOW = Date.parse("2026-02-01T00:00:00.000Z");

/** A real work tree with one path untouched since the note, one changed after it, and one removed after it. */
function rig() {
  const root = temp(), repo = join(root, "repo"), memory = join(root, "memory");
  mkdirSync(join(repo, "src"), { recursive: true }); mkdirSync(memory, { recursive: true });
  const git = (args: string[], at = "2026-01-01T00:00:00.000Z") => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git(["init", "-q"]);
  for (const name of ["present", "changed", "gone"]) writeFileSync(join(repo, "src", `${name}.ts`), `export const ${name} = 1;\n`);
  git(["add", "-A"]); git(["commit", "-qm", "one"]);
  writeFileSync(join(repo, "src", "changed.ts"), "export const changed = 2;\n");
  git(["add", "-A"]); git(["commit", "-qm", "two"], "2026-01-10T00:00:00.000Z");
  git(["rm", "-q", "src/gone.ts"]); git(["commit", "-qm", "three"], "2026-01-10T00:00:00.000Z");
  return { root, repo, memory, project: memoryProjectKey(repo) };
}

interface Seed { text: string; kind?: Kind; at?: number; about?: string[]; title?: string }

/** Curated notes written at a fixed clock, so every id and age is the fixture's, not the run's. */
function seeded(r: ReturnType<typeof rig>, seeds: readonly Seed[]): MemoryStore {
  let current = NOTE;
  const store = new MemoryStore({ memoryDir: r.memory, now: () => current, screen: () => "keep" });
  for (const seed of seeds) {
    current = seed.at ?? NOTE;
    store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: seed.kind ?? "finding", peer: "fixture", source: "person", text: seed.text, about: seed.about ?? [], ...(seed.title ? { title: seed.title } : {}) });
  }
  return store;
}
const sample = (r: ReturnType<typeof rig>, store: MemoryStore, seed: string, n = 6, now = NOW) => auditSample({ store, project: r.project, n, seed, root: r.repo, now });

test("AC1: the same seed and store draw the same stratified sample, and a different seed draws another one", () => {
  const r = rig(), kinds: Kind[] = ["decision", "finding", "contract", "fail"], ages = [5, 50, 120];
  const store = seeded(r, Array.from({ length: 12 }, (_, index) => ({ text: `note ${index} about the parcel routing rules`, kind: kinds[index % 4]!, at: NOW - ages[index % 3]! * DAY, about: [] })));
  try {
    const first = sample(r, store, "seed-a"), again = sample(r, store, "seed-a"), other = sample(r, store, "seed-b");
    expect(first.frame).toBe(12); expect(first.drawn).toBe(6); expect(first.truncated).toBe(false);
    expect(new Set(first.notes.map(note => note.id)).size).toBe(6);
    expect(again.notes.map(note => note.id)).toEqual(first.notes.map(note => note.id));
    expect(other.notes.map(note => note.id)).not.toEqual(first.notes.map(note => note.id));
    // Every kind/age cell in this frame is represented before any cell gets a second note: 12 cells, so 6 notes are 6 distinct cells.
    expect(new Set(first.notes.map(note => `${note.kind}/${note.age}`)).size).toBe(6);
    expect(new Set(first.notes.map(note => note.age))).toEqual(new Set(["lt30", "d30to90", "gt90"]));
    // n larger than the frame draws the frame, and n outside 1..MAX is refused.
    expect(sample(r, store, "seed-a", 99).drawn).toBe(12);
    expect(() => sample(r, store, "seed-a", 0)).toThrow("1 to"); expect(() => sample(r, store, "seed-a", MAX_AUDIT_NOTES + 1)).toThrow("1 to");
  } finally { store.close(); }
});

test("AC1: the age bucket is the spec's <30, 30-90 and >90 days, and the anchor fold prefers missing over changed", () => {
  expect(auditAge(new Date(NOW - 1 * DAY).toISOString(), NOW)).toBe("lt30");
  expect(auditAge(new Date(NOW - 30 * DAY).toISOString(), NOW)).toBe("d30to90");
  expect(auditAge(new Date(NOW - 90 * DAY).toISOString(), NOW)).toBe("d30to90");
  expect(auditAge(new Date(NOW - 91 * DAY).toISOString(), NOW)).toBe("gt90");
  expect(auditAge("not a date", NOW)).toBeUndefined();
  expect(foldAnchorStatus([])).toBe("none");
  expect(foldAnchorStatus(["present", "present"])).toBe("present");
  expect(foldAnchorStatus(["present", "changed"])).toBe("changed");
  expect(foldAnchorStatus(["changed", "missing"])).toBe("missing");
});

test("#326: anchor status is present, changed since note time, missing, or none when the note names no path", () => {
  const r = rig();
  const store = seeded(r, [
    { text: "the parcel router keeps its retry budget in src/present.ts", about: ["path:src/present.ts"] },
    { text: "the parcel router rewrote src/changed.ts after this note", about: ["path:src/changed.ts"] },
    { text: "the parcel router used to read src/gone.ts", about: ["path:src/gone.ts"] },
    { text: "the parcel router has no anchor at all", about: [] },
    // An absolute path and a `..` segment are dropped rather than read: the audit never leaves the work tree it names.
    { text: "the parcel router names two anchors outside its work tree", about: ["path:/etc/passwd", "path:../outside.ts"] },
  ]);
  try {
    const sheet = sample(r, store, "anchors", 5), byText = new Map(sheet.notes.map(note => [note.text, note]));
    expect(byText.get("the parcel router keeps its retry budget in src/present.ts")!.anchor).toBe("present");
    expect(byText.get("the parcel router rewrote src/changed.ts after this note")!.anchor).toBe("changed");
    expect(byText.get("the parcel router used to read src/gone.ts")!.anchor).toBe("missing");
    expect(byText.get("the parcel router has no anchor at all")!.anchor).toBe("none");
    const escaped = byText.get("the parcel router names two anchors outside its work tree")!;
    expect(escaped.anchors).toEqual([]); expect(escaped.anchor).toBe("none");
    expect(sheet.root).toBe(r.repo);
  } finally { store.close(); }
});

test("AC2: the score carries counts and kappa only - no note text, title, anchor path or id", () => {
  const r = rig();
  const store = seeded(r, [
    { text: "the parcel router keeps its idempotency key in the header", title: "routing idempotency", kind: "decision", about: ["path:src/present.ts"] },
    { text: "the parcel router rejects a duplicate consignment", kind: "contract", about: ["path:src/changed.ts"] },
    { text: "the parcel sorter never retries a rejected label", kind: "fail", about: [] },
  ]);
  try {
    const sheet = sample(r, store, "leak", 3);
    for (const [index, note] of sheet.notes.entries()) { note.judge_a = AUDIT_LABELS[index % 2]!; note.judge_b = AUDIT_LABELS[(index + 1) % 2]!; }
    const text = JSON.stringify(auditScore(sheet));
    for (const note of sheet.notes) {
      expect(text).not.toContain(note.text); expect(text).not.toContain(note.id);
      if (note.title) expect(text).not.toContain(note.title);
      for (const anchor of note.anchors) expect(text).not.toContain(anchor.path);
    }
    expect(text).not.toContain(r.repo);
    const rendered = auditScoreText(auditScore(sheet));
    expect(rendered).toContain("audit score:"); expect(rendered).toContain("kappa");
    expect(rendered).not.toContain("parcel router");
  } finally { store.close(); }
});

test("AC2: a sheet that would leak free text is refused, whether in a judge cell, an unknown key or a field parsed into a bucket name", () => {
  const r = rig(), store = seeded(r, [{ text: "the parcel router keeps its retry budget in src/present.ts", about: ["path:src/present.ts"] }]);
  try {
    const sheet = sample(r, store, "refuse", 1), file = join(r.root, "sheet.json");
    // A hand-written verdict is free text: only the four labels are read.
    const handwritten = JSON.parse(JSON.stringify(sheet)) as { notes: { judge_a: string }[] };
    handwritten.notes[0]!.judge_a = "looks right to me";
    writeFileSync(file, JSON.stringify(handwritten));
    expect(() => readAuditSheet(file)).toThrow("judge_a must be one of correct, stale, wrong, unverifiable");
    // An added field with a sentence in it is refused by name rather than silently ignored.
    const extra = JSON.parse(JSON.stringify(sheet)) as { notes: Record<string, unknown>[] };
    extra.notes[0]!.comment = "the parcel router keeps its retry budget in src/present.ts";
    writeFileSync(file, JSON.stringify(extra));
    expect(() => readAuditSheet(file)).toThrow('has an unknown key "comment"');
    // A kind becomes a `byKind` key and the seed is copied into the score, so both are the closed sets `sample` draws with, not free strings from the file.
    const oddKind = JSON.parse(JSON.stringify(sheet)) as { notes: { kind: string }[] };
    oddKind.notes[0]!.kind = "the parcel router keeps its retry budget";
    writeFileSync(file, JSON.stringify(oddKind));
    expect(() => readAuditSheet(file)).toThrow("kind must be one of decision, finding, contract, fail");
    writeFileSync(file, JSON.stringify({ ...sheet, seed: "my seed" }));
    expect(() => readAuditSheet(file)).toThrow("seed must be 1 to 64 letters, digits");
    writeFileSync(file, JSON.stringify({ ...sheet, truncated: "yes" }));
    expect(() => readAuditSheet(file)).toThrow("truncated must be true or false");
    // The project key stays in the sheet: the score names the project only by digest, because a key can be built from a local checkout path.
    const polluted = { ...sheet, project: sheet.notes[0]!.text } as AuditSheet;
    const scored = auditScore(polluted);
    expect(scored.project).toBe(`sha256:${createHash("sha256").update(polluted.project).digest("hex").slice(0, 16)}`);
    expect(JSON.stringify(scored)).not.toContain(polluted.project);
    // And the honest sheet scores.
    expect(auditScore(sheet).labelled).toBe(0);
  } finally { store.close(); }
});

test("AC3: kappa matches a hand-worked fixture", () => {
  // 10 notes: 4x (correct, correct), 2x (correct, stale), 2x (stale, stale), 2x (wrong, wrong).
  // Observed agreement 0.8; chance term (6*4 + 2*4 + 2*2) / 100 = 0.36; kappa = 0.44 / 0.64 = 0.6875.
  const pairs: [string, string][] = [
    ...Array.from({ length: 4 }, (): [string, string] => ["correct", "correct"]), ...Array.from({ length: 2 }, (): [string, string] => ["correct", "stale"]),
    ...Array.from({ length: 2 }, (): [string, string] => ["stale", "stale"]), ...Array.from({ length: 2 }, (): [string, string] => ["wrong", "wrong"]),
  ];
  expect(cohenKappa(pairs, AUDIT_LABELS)).toBe(0.6875);
  // Nothing to measure is null, never 0: no pair, or both judges on one label throughout (chance agreement is 1, kappa undefined).
  expect(cohenKappa([], AUDIT_LABELS)).toBeNull();
  expect(cohenKappa(Array.from({ length: 5 }, (): [string, string] => ["correct", "correct"]), AUDIT_LABELS)).toBeNull();
  // The same arithmetic through a scored sheet: the note-level counts and the kappa come from the same pairs.
  const notes: AuditNote[] = pairs.map(([judge_a, judge_b], index) => ({
    id: String(index).padStart(32, "0"), kind: "finding", at: new Date(NOTE).toISOString(), age: "lt30", anchor: "present", anchors: [{ path: `src/${index}.ts`, status: "present" }],
    text: `synthetic note ${index}`, judge_a: judge_a as AuditNote["judge_a"], judge_b: judge_b as AuditNote["judge_b"],
  }));
  const score = auditScore({ schema: "amem.audit/v1", project: "fixture/project", seed: "s", drawnAt: new Date(NOW).toISOString(), root: "/fixture", frame: 10, drawn: 10, truncated: false, rubric: { correct: "c", stale: "s", wrong: "w", unverifiable: "u" }, notes });
  expect(score.byLabel).toEqual({ correct: 6, stale: 2, wrong: 2, unverifiable: 0 });
  expect(score.agreement).toEqual({ pairs: 10, agreed: 8, kappa: 0.6875 });
  expect(score.byAge).toEqual({ lt30: { correct: 6, stale: 2, wrong: 2 } });
  expect(score.unlabelled).toBe(0);
});

test("#326: the sheet file is private, never overwritten, and scores from disk", () => {
  const r = rig(), store = seeded(r, [{ text: "the parcel router keeps its retry budget in src/present.ts", about: ["path:src/present.ts"] }]);
  try {
    const sheet = sample(r, store, "file", 1), file = join(r.memory, "eval", "audit.json");
    expect(writeAuditSheet(file, sheet)).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => writeAuditSheet(file, sheet)).toThrow();
    const reread = readAuditSheet(file);
    expect(reread.notes.map(note => note.id)).toEqual(sheet.notes.map(note => note.id));
    expect(reread.notes[0]!.judge_a).toBe("");
    // Not JSON, a directory and an oversized file are refused by the bounded reader.
    expect(() => readAuditSheet(r.memory)).toThrow("regular file within");
    writeFileSync(join(r.memory, "bad.json"), "{ not json"); expect(() => readAuditSheet(join(r.memory, "bad.json"))).toThrow("not valid JSON");
    writeFileSync(join(r.memory, "big.json"), "x".repeat(4 * 1024 * 1024 + 1)); expect(() => readAuditSheet(join(r.memory, "big.json"))).toThrow("regular file within");
  } finally { store.close(); }
});

test("#326: a frame cut by the store's listing bound says so rather than reporting the bound as the whole frame", () => {
  const r = rig();
  // The bound is 20,000 rows, so a synthetic listing reaches it without writing that many notes.
  const views = Array.from({ length: 20_000 }, (_, index) => ({ id: String(index).padStart(32, "0"), kind: "finding", at: "not a date", about: [], text: "", title: null }) as unknown as View);
  const sheet = auditSample({ store: { list: () => views } as unknown as MemoryStore, project: "fixture/project", n: 1, seed: "cap", root: r.repo, now: NOW });
  expect(sheet.truncated).toBe(true); expect(sheet.frame).toBe(0);
  const score = auditScore(sheet);
  expect(score.truncated).toBe(true);
  expect(auditScoreText(score)).toContain("the store listing hit its cap, so the frame is a floor");
});

test("AC4: the audit adds no model or network surface, and `preference` stays out of the frame", async () => {
  const source = readFileSync(new URL("../src/memory/eval-audit.ts", import.meta.url), "utf8") + readFileSync(new URL("../src/memory/eval.ts", import.meta.url), "utf8");
  for (const forbidden of ["fetch(", "node:http", "node:https", "node:net", "Bun.spawn", "Bun.$", "XMLHttpRequest", "WebSocket"]) expect(source, forbidden).not.toContain(forbidden);
  // The one process the audit runs is the repository's own read-only history, through the hardened runner.
  expect(source).toContain("memoryGitSync("); expect(source).toContain("readOnlyDiagnostic: true");
  expect(AUDIT_KINDS).toEqual(["decision", "finding", "contract", "fail"]);
  expect(AUDIT_KINDS.includes("preference")).toBe(false);
  // A model or network call would have to go through fetch; a run with fetch poisoned still audits and scores.
  const r = rig(), store = seeded(r, [{ text: "the parcel router keeps its retry budget in src/present.ts", about: ["path:src/present.ts"] }]);
  const fetchBefore = globalThis.fetch;
  try {
    globalThis.fetch = (() => { throw new Error("the audit must not reach the network"); }) as unknown as typeof fetch;
    const sheet = sample(r, store, "boundary", 1);
    expect(auditScore(sheet).drawn).toBe(1);
  } finally { globalThis.fetch = fetchBefore; store.close(); }
});

// ---- the command ----

async function cli(r: ReturnType<typeof rig>, args: string[]): Promise<string> {
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = r.memory;
  try { return await runCli(args, { cwd: r.repo, env: {}, stdinTTY: true }); } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}

test("#326: `amem eval audit sample` writes the private sheet and prints a content-free summary; `score` reads it back", async () => {
  const r = rig(), store = seeded(r, [
    { text: "the parcel router keeps its retry budget in src/present.ts", about: ["path:src/present.ts"] },
    { text: "the parcel router rewrites src/changed.ts without telling the sorter", about: ["path:src/changed.ts"] },
  ]);
  store.close();
  const json = JSON.parse(await cli(r, ["eval", "audit", "sample", "--seed", "cli", "--n", "2", "--json"])) as { file: string; frame: number; drawn: number; project: string };
  expect(json).toMatchObject({ frame: 2, drawn: 2, project: r.project });
  expect(existsSync(json.file)).toBe(true); expect(statSync(json.file).mode & 0o777).toBe(0o600);
  expect(json.file.startsWith(join(r.memory, "eval"))).toBe(true);
  const text = await cli(r, ["eval", "audit", "sample", "--seed", "cli-2", "--n", "2"]);
  expect(text).toContain("audit sample: 2 of 2"); expect(text).toContain("(0600, local only"); expect(text).not.toContain("parcel router");
  // The same seed draws the same notes from the same store: a second sample of a fresh file repeats the ids.
  const sheet = readAuditSheet(json.file), second = JSON.parse(await cli(r, ["eval", "audit", "sample", "--seed", "cli", "--n", "2", "--out", join(r.root, "again.json"), "--json"])) as { file: string };
  expect(readAuditSheet(second.file).notes.map(note => note.id)).toEqual(sheet.notes.map(note => note.id));
  for (const [index, note] of sheet.notes.entries()) { note.judge_a = index === 0 ? "correct" : "stale"; note.judge_b = "correct"; }
  writeFileSync(join(r.root, "filled.json"), JSON.stringify(sheet, null, 2));
  const scored = JSON.parse(await cli(r, ["eval", "audit", "score", join(r.root, "filled.json"), "--json"])) as { byLabel: Record<string, number>; agreement: { pairs: number; agreed: number; kappa: number | null } };
  expect(scored.byLabel).toEqual({ correct: 1, stale: 1, wrong: 0, unverifiable: 0 });
  expect(scored.agreement).toEqual({ pairs: 2, agreed: 1, kappa: 0 });
  expect(await cli(r, ["eval", "audit", "score", join(r.root, "filled.json")])).toContain("kappa 0.000 over 2");
}, 60_000);

test("#326: `eval audit sample --project` refuses a project the cwd's work tree does not own, naming the checkout to run from", async () => {
  const r = rig(), other = join(r.root, "elsewhere"); mkdirSync(other, { recursive: true });
  const store = seeded(r, [{ text: "the parcel router keeps its retry budget in src/present.ts", about: ["path:src/present.ts"] }]);
  store.close();
  const elsewhere = memoryProjectKey(other);
  expect(elsewhere).not.toBe(r.project);
  // Anchors are read in this cwd's tree, so another project's key would silently check them against the wrong repository.
  await expect(cli(r, ["eval", "audit", "sample", "--seed", "away", "--n", "1", "--project", elsewhere])).rejects.toThrow("run `amem eval audit sample` from that project's checkout");
  // The project bound here is sampled when named explicitly, and so is an alias that resolves to it.
  const own = JSON.parse(await cli(r, ["eval", "audit", "sample", "--seed", "own", "--n", "1", "--project", r.project, "--json"])) as { project: string; drawn: number };
  expect(own).toMatchObject({ project: r.project, drawn: 1 });
  appendAlias(r.memory, { alias: "parcel/legacy", key: r.project, actor: "fixture", machine: "fixture" });
  const aliased = JSON.parse(await cli(r, ["eval", "audit", "sample", "--seed", "aliased", "--n", "1", "--project", "parcel/legacy", "--json"])) as { project: string };
  expect(aliased.project).toBe(r.project);
}, 60_000);

test("#326: the audit command refuses a missing seed, an out-of-range n and a missing sheet, naming the next step", async () => {
  const r = rig();
  await expect(cli(r, ["eval", "audit", "sample", "--n", "2"])).rejects.toThrow("--seed is required");
  await expect(cli(r, ["eval", "audit", "sample", "--seed", "s", "--n", "0"])).rejects.toThrow("--n must be an integer from 1 to");
  await expect(cli(r, ["eval", "audit", "score"])).rejects.toThrow("usage: amem eval audit score <sheet>");
  await expect(cli(r, ["eval", "audit"])).rejects.toThrow("usage: amem eval audit sample");
  // A sheet whose judge cell holds a sentence is refused before any score is printed.
  const store = seeded(r, [{ text: "a note about the parcel router" }]);
  try {
    const sheet = auditSample({ store, project: r.project, n: 1, seed: "s", root: r.repo, now: NOW });
    const bad = JSON.parse(JSON.stringify(sheet)) as { notes: { judge_a: string }[] }; bad.notes[0]!.judge_a = "mostly right";
    writeFileSync(join(r.root, "bad.json"), JSON.stringify(bad));
    await expect(cli(r, ["eval", "audit", "score", join(r.root, "bad.json")])).rejects.toThrow("judge_a must be one of");
  } finally { store.close(); }
}, 60_000);
