import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CandidateStore, type CandidateInput } from "../src/memory/candidates.ts";
import { EXTERNAL_IMPORT_LIMITS, importExternalMemory } from "../src/memory/external-import.ts";

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

test("codex imports recursive Markdown and JSONL strings/objects while skipping malformed records", async () => {
  const root = temp("codex"), source = join(root, "source"), base = join(root, "memory");
  put(join(source, "nested", "note.md"), "Markdown finding");
  put(join(source, "records.jsonl"), '"string record"\n{"title":"Named title","text":"object record"}\nnot json\n{"title":"missing text"}\n""\n');
  put(join(source, "ignored.yaml"), "not useful");
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: allow });
  expect(result).toMatchObject({ files: 2, read: 6, added: 3, skipped: { invalid: 3, policy: 0, truncated: 0 } });
  const stored = candidates(base);
  expect(stored.map(row => row.input.kind === "memory" ? row.input.text : "").sort()).toEqual(["Markdown finding", "object record", "string record"]);
  expect(stored.some(row => row.input.kind === "memory" && row.input.title?.includes("codex: records.jsonl#2: Named title"))).toBe(true);
});

test("rule files and symlink files/directories are never imported or followed", async () => {
  const root = temp("links"), source = join(root, "source"), outside = join(root, "outside"), base = join(root, "memory");
  put(join(source, "keep.md"), "safe");
  put(join(source, "claude.MD"), "rule");
  put(join(source, "sub", "agents.md"), "rule");
  put(join(outside, "secret.md"), "outside file");
  put(join(outside, "directory", "secret.md"), "outside directory");
  symlinkSync(join(outside, "secret.md"), join(source, "linked.md"));
  symlinkSync(join(outside, "directory"), join(source, "linked-directory"), "dir");
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: allow });
  expect(result).toMatchObject({ files: 1, read: 1, added: 1, skipped: { rules: 4, policy: 0, invalid: 0 } });
  expect(JSON.stringify(candidates(base))).not.toContain("outside");
});

test("secret-looking and policy-refused candidates are not written and secrets do not reach policy", async () => {
  const root = temp("policy"), source = join(root, "source"), base = join(root, "memory");
  put(join(source, "good.md"), "public finding");
  put(join(source, "policy.md"), "policy refused finding");
  put(join(source, "secret.md"), "token: abcdefgh12345678");
  const seen: CandidateInput[] = [];
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: (value) => {
    const record = value as CandidateInput;
    seen.push(record);
    return record.kind === "memory" && !record.text.includes("policy refused");
  } });
  expect(result).toMatchObject({ files: 3, read: 3, added: 1, skipped: { policy: 2, invalid: 0 } });
  expect(seen).toHaveLength(2);
  expect(JSON.stringify(seen)).not.toContain("abcdefgh");
  expect(candidates(base).map(row => row.input.kind === "memory" ? row.input.text : "")).toEqual(["public finding"]);
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

test("discovery stops at the documented file cap", async () => {
  const root = temp("file-cap"), source = join(root, "source"), base = join(root, "memory");
  for (let index = 0; index <= EXTERNAL_IMPORT_LIMITS.maxFiles; index++) put(join(source, `${String(index).padStart(4, "0")}.md`), `finding ${index}`);
  const result = await importExternalMemory({ base, project: PROJECT, source: "codex", from: source, policy: allow });
  expect(result).toMatchObject({ files: EXTERNAL_IMPORT_LIMITS.maxFiles, read: EXTERNAL_IMPORT_LIMITS.maxFiles, added: EXTERNAL_IMPORT_LIMITS.maxFiles, pending: { count: EXTERNAL_IMPORT_LIMITS.maxFiles } });
  expect(candidates(base)).toHaveLength(EXTERNAL_IMPORT_LIMITS.maxFiles);
});
