import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CandidateStore, type CandidateInput } from "../src/memory/candidates.ts";
import { EXTERNAL_IMPORT_LIMITS, importExternalMemory } from "../src/memory/external-import.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";

const PROJECT = "fixture/project";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function temp(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `amem-external-${name}-`));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(path: string, text: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
/** Fixture reference for the shipped Claude encoder, including long macOS temporary paths. */
function claudeDirectory(cwd: string): string {
  const physical = realpathSync(cwd), encoded = physical.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let i = 0; i < physical.length; i++) hash = ((hash << 5) - hash + physical.charCodeAt(i)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
function candidates(base: string) {
  const store = new CandidateStore({ memoryDir: base });
  try { return store.list({ project: PROJECT, status: "all", kind: "memory", limit: 500 }); }
  finally { store.close(); }
}
const allow = () => true;

test("claude-auto imports only direct project memory Markdown, preserves bytes and replays without additions", async () => {
  const root = temp("claude"), source = join(root, "source"), base = join(root, "memory");
  const memory = join(source, "-Users-fixture-project", "memory");
  const note = join(memory, "one.md");
  put(note, "Claude finding\nwith two lines\n");
  put(join(memory, "ignored.txt"), "not Markdown");
  put(join(memory, "nested", "ignored.md"), "not direct");
  put(join(memory, "CLAUDE.md"), "rule");
  put(join(memory, "AGENTS.md"), "rule");
  put(join(source, "root.md"), "outside a project memory directory");
  const before = readFileSync(note);
  const opts = { base, project: PROJECT, source: "claude-auto" as const, from: source, policy: allow };
  const first = await importExternalMemory(opts);
  expect(first).toMatchObject({ source: "claude-auto", project: PROJECT, files: 1, read: 1, added: 1, skipped: { rules: 2, policy: 0, invalid: 0, truncated: 0 }, pending: { count: 1, unshown: 1 } });
  const stored = candidates(base);
  expect(stored).toHaveLength(1);
  expect(stored[0]!.input).toMatchObject({ project: PROJECT, kind: "memory", noteKind: "finding", text: "Claude finding\nwith two lines" });
  if (stored[0]!.input.kind !== "memory") throw new Error("fixture candidate kind");
  expect(stored[0]!.input.title).toContain("claude-auto: -Users-fixture-project/memory/one.md");
  expect(readFileSync(note)).toEqual(before);
  expect((await importExternalMemory(opts)).added).toBe(0);
  expect(candidates(base).map(row => row.id)).toEqual(stored.map(row => row.id));
  expect(readFileSync(note)).toEqual(before);
});

test("default source roots honor Claude and Codex environment configuration and Claude stays on the bound project", async () => {
  const root = temp("configured"), base = join(root, "memory"), repo = join(root, "repo.with.dot_and_underscore");
  mkdirSync(repo, { recursive: true });
  const claude = join(root, "claude-profile"), codex = join(root, "codex-home");
  const encoded = claudeDirectory(repo);
  put(join(claude, "projects", encoded, "memory", "own.md"), "bound project memory");
  put(join(claude, "projects", "-Users-other-project", "memory", "other.md"), "OTHER-PROJECT-PRIVATE");
  put(join(codex, "memories", "codex.md"), "configured Codex memory");
  const env = { HOME: join(root, "unused-home"), CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
  const first = await importExternalMemory({ base, project: PROJECT, source: "claude-auto", cwd: repo, env, policy: allow });
  expect(first).toMatchObject({ files: 1, read: 1, added: 1 });
  expect(JSON.stringify(candidates(base))).toContain("bound project memory");
  expect(JSON.stringify(candidates(base))).not.toContain("OTHER-PROJECT-PRIVATE");
  expect(await importExternalMemory({ base, project: PROJECT, source: "codex", cwd: repo, env, policy: allow })).toMatchObject({ files: 1, added: 1 });
});

test("Claude default project selection uses non-alphanumeric encoding for spaces, punctuation and Unicode", async () => {
  const root = temp("encoded"), repo = join(root, "repo.with space_and한글"), claude = join(root, "claude");
  mkdirSync(repo);
  const physical = realpathSync(repo), encoded = claudeDirectory(repo);
  put(join(claude, "projects", encoded, "memory", "own.md"), "encoded path memory");
  // Deliberately obsolete encoding: the importer must never select this negative fixture.
  put(join(claude, "projects", physical.replace(/[/.]/g, "-"), "memory", "old.md"), "WRONG-PROJECT-PRIVATE");
  const base = join(root, "memory");
  expect(await importExternalMemory({ base, project: PROJECT, source: "claude-auto", cwd: repo, env: { CLAUDE_CONFIG_DIR: claude }, policy: allow })).toMatchObject({ files: 1, added: 1 });
  expect(JSON.stringify(candidates(base))).toContain("encoded path memory");
  expect(JSON.stringify(candidates(base))).not.toContain("WRONG-PROJECT-PRIVATE");
});

test("Claude project selection uses its 200-character prefix and signed path hash for long paths", async () => {
  const root = temp("long-encoded"), repo = join(root, "a".repeat(80), "b".repeat(80), "with space"), claude = join(root, "claude");
  mkdirSync(repo, { recursive: true });
  const physical = realpathSync(repo), encoded = physical.replace(/[^a-zA-Z0-9]/g, "-");
  expect(encoded.length).toBeGreaterThan(200);
  put(join(claude, "projects", claudeDirectory(repo), "memory", "own.md"), "long path memory");
  const base = join(root, "memory");
  expect(await importExternalMemory({ base, project: PROJECT, source: "claude-auto", cwd: repo, env: { CLAUDE_CONFIG_DIR: claude }, policy: allow })).toMatchObject({ files: 1, added: 1 });
  expect(JSON.stringify(candidates(base))).toContain("long path memory");
});

test("codex imports recursive Markdown and JSONL strings/objects while skipping malformed records", async () => {
  const root = temp("codex"), source = join(root, "source"), base = join(root, "memory");
  const note = join(source, "nested", "note.md"), records = join(source, "records.jsonl");
  put(note, "Markdown finding");
  put(records, '"string record"\n{"title":"Named title","text":"object record"}\nnot json\n{"title":"missing text"}\n""\n');
  put(join(source, "ignored.yaml"), "not useful");
  const before = [note, records].map(path => [path, readFileSync(path)] as const);
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: allow });
  expect(result).toMatchObject({ files: 2, read: 6, added: 3, skipped: { invalid: 3, policy: 0, truncated: 0 } });
  const stored = candidates(base);
  expect(stored.map(row => row.input.kind === "memory" ? row.input.text : "").sort()).toEqual(["Markdown finding", "object record", "string record"]);
  expect(stored.some(row => row.input.kind === "memory" && row.input.title?.includes("codex: records.jsonl#2: Named title"))).toBe(true);
  for (const [path, bytes] of before) expect(readFileSync(path)).toEqual(bytes);
});

test("rule files, rules directories and symlink files/directories are never imported or followed", async () => {
  const root = temp("links"), source = join(root, "source"), outside = join(root, "outside"), base = join(root, "memory");
  put(join(source, "keep.md"), "safe");
  put(join(source, "claude.MD"), "rule");
  put(join(source, "sub", "agents.md"), "rule");
  put(join(source, "agents.override.md"), "rule");
  put(join(source, "settings.local.md"), "rule");
  put(join(source, "rules", "nested.md"), "rule");
  put(join(outside, "secret.md"), "outside file");
  put(join(outside, "directory", "secret.md"), "outside directory");
  symlinkSync(join(outside, "secret.md"), join(source, "linked.md"));
  symlinkSync(join(outside, "directory"), join(source, "linked-directory"), "dir");
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: allow });
  expect(result).toMatchObject({ files: 1, read: 1, added: 1, skipped: { rules: 7, policy: 0, invalid: 0 } });
  expect(JSON.stringify(candidates(base))).not.toContain("outside");
});

test("a symlinked source ancestor is resolved once and never used as a traversal shortcut", async () => {
  const root = temp("ancestor"), actual = join(root, "actual"), alias = join(root, "alias"), base = join(root, "memory");
  put(join(actual, "source", "safe.md"), "canonical source");
  symlinkSync(actual, alias, "dir");
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: join(alias, "source"), policy: allow });
  expect(result).toMatchObject({ files: 1, read: 1, added: 1 });
  expect(candidates(base)[0]!.input).toMatchObject({ text: "canonical source" });
});

test("private spans are stripped before secret and policy screening", async () => {
  const root = temp("policy"), source = join(root, "source"), base = join(root, "memory");
  put(join(source, "good.md"), "public finding");
  put(join(source, "policy.md"), "policy refused finding");
  put(join(source, "secret.md"), "token: abcdefgh12345678");
  put(join(source, "private.md"), "visible <private>token: abcdefgh12345678</private>");
  const seen: CandidateInput[] = [];
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: (value) => {
    const record = value as CandidateInput;
    seen.push(record);
    return record.kind === "memory" && !record.text.includes("policy refused");
  } });
  expect(result).toMatchObject({ files: 4, read: 4, added: 2, skipped: { policy: 2, invalid: 0 } });
  expect(seen).toHaveLength(5);
  expect(JSON.stringify(seen)).not.toContain("abcdefgh");
  expect(candidates(base).map(row => row.input.kind === "memory" ? row.input.text : "").sort()).toEqual(["public finding", "visible"]);
});

test("a configured pattern that straddles a candidate boundary is screened as one complete record", async () => {
  const root = temp("whole-policy"), source = join(root, "source"), base = join(root, "memory");
  const marker = "PRIVATE-SPANNING-TOKEN";
  put(join(source, "boundary.md"), `${".".repeat(EXTERNAL_IMPORT_LIMITS.candidateTextChars - 5)}${marker}`);
  const standalone = createStandalonePolicy({ piiPatterns: [marker] });
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: value => standalone.screenStandalone(value) });
  expect(result).toMatchObject({ files: 1, read: 1, added: 0, skipped: { policy: 1, invalid: 0 } });
  expect(candidates(base)).toEqual([]);
});

test("private spans are stripped across chunk boundaries and an emptied record is invalid", async () => {
  const root = temp("whole-private"), source = join(root, "source"), base = join(root, "memory");
  put(join(source, "boundary.md"), `Public intro\n<private>${"x".repeat(EXTERNAL_IMPORT_LIMITS.candidateTextChars + 100)}PRIVATE-MARKER</private>\nPublic ending`);
  put(join(source, "empty.md"), "<private>entirely private</private>");
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: allow });
  expect(result).toMatchObject({ files: 2, read: 2, added: 1, skipped: { policy: 0, invalid: 1 } });
  const stored = candidates(base);
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored)).not.toContain("PRIVATE-MARKER");
  expect(stored[0]!.input).toMatchObject({ text: "Public intro\n\nPublic ending" });
});

test("chunking respects candidate and Unicode bounds, and oversized files are counted and truncated", async () => {
  const root = temp("bounds"), source = join(root, "source"), base = join(root, "memory");
  put(join(source, "unicode.md"), "😀".repeat(EXTERNAL_IMPORT_LIMITS.candidateTextChars / 2 + 1));
  put(join(source, "large.md"), Buffer.concat([Buffer.alloc(EXTERNAL_IMPORT_LIMITS.maxFileBytes, 0x20), Buffer.from("TAIL-MARKER")]));
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: allow });
  expect(result).toMatchObject({ files: 2, read: 2, added: 2, skipped: { invalid: 1, truncated: 1, policy: 0 } });
  const stored = candidates(base);
  expect(stored.map(row => row.input.kind === "memory" ? row.input.text.length : 0).sort((a, b) => a - b)).toEqual([2, EXTERNAL_IMPORT_LIMITS.candidateTextChars]);
  for (const row of stored) {
    if (row.input.kind !== "memory") throw new Error("fixture candidate kind");
    expect(row.input.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    expect(row.input.title).toContain("part ");
    expect(row.input.title!.length).toBeLessThanOrEqual(EXTERNAL_IMPORT_LIMITS.titleChars);
  }
  expect(JSON.stringify(stored)).not.toContain("TAIL-MARKER");
});

test("discovery and candidate writes stop at their documented caps with a complete result", async () => {
  const root = temp("file-cap"), source = join(root, "source"), base = join(root, "memory");
  for (let index = 0; index <= EXTERNAL_IMPORT_LIMITS.maxFiles; index++) put(join(source, `${String(index).padStart(4, "0")}.md`), `finding ${index}`);
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: allow });
  expect(result).toMatchObject({ files: EXTERNAL_IMPORT_LIMITS.maxCandidatesPerRun + 1, read: EXTERNAL_IMPORT_LIMITS.maxCandidatesPerRun + 1,
    added: EXTERNAL_IMPORT_LIMITS.maxCandidatesPerRun, limitReached: true, queueFull: false, pending: { count: EXTERNAL_IMPORT_LIMITS.maxCandidatesPerRun } });
  expect(candidates(base)).toHaveLength(EXTERNAL_IMPORT_LIMITS.maxCandidatesPerRun);
});

test("a full candidate queue returns counts and queueFull instead of throwing", async () => {
  const root = temp("queue-full"), source = join(root, "source"), base = join(root, "memory");
  put(join(source, "new.md"), "one more candidate");
  const seeded = new CandidateStore({ memoryDir: base });
  for (let index = 0; index < 500; index++) seeded.put({ project: PROJECT, kind: "memory", text: `existing ${index}` }, "public");
  seeded.close();
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: allow });
  expect(result).toMatchObject({ files: 1, read: 1, added: 0, queueFull: true, limitReached: false, pending: { count: 500 } });
});
