import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON_ONLY, runCli } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { parseRepoLine, planRepoPromotion, readRepoScope, REPO_SCHEMA, repoEntryId, repoVisibility, type RepoLine } from "../src/memory/repo-scope.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { MemoryStore, type Kind } from "../src/memory/store.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import type { Visibility } from "../src/memory/sync.ts";

// #15 T4 (D6, AC3, AC6): the repo scope, through the real `runCli`, a real git repository and a real `.amem/log.jsonl`.
const cleanup: (() => void)[] = [];
const oldPath = process.env.PATH;
afterEach(() => { delete process.env.AMEM_HOME; process.env.PATH = oldPath; for (const close of cleanup.splice(0).reverse()) close(); });

const GH_TOKEN = `ghp_${"a".repeat(36)}`;
const isoAt = "2026-10-20T10:00:00.000Z";
function git(cwd: string, ...args: string[]): void {
  const done = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
}
interface Rig { dir: string; repo: string; base: string; project: string; person: { cwd: string; env: Record<string, string>; stdinTTY: boolean; visibility: (url: string) => Promise<Visibility> };
  note(text: string, opts?: { kind?: Kind; tier?: "short" | "long"; about?: string[]; project?: string; title?: string }): string; log(): string; logPath: string }
function rig(remote: string | null = "https://github.com/o/a.git", name = "repo", dir?: string): Rig {
  dir ??= realPath(mkdtempSync(join(tmpdir(), "amem-repo-scope-")));
  if (!cleanup.length || dir) cleanup.push(() => rmSync(dir!, { recursive: true, force: true }));
  const repo = join(dir, name); mkdirSync(repo, { recursive: true }); git(repo, "init", "--quiet");
  if (remote) git(repo, "remote", "add", "origin", remote);
  const base = join(dir, "memory"); process.env.AMEM_HOME = base;
  const project = memoryProjectKey(repo);
  const logPath = join(repo, ".amem", "log.jsonl");
  return { dir, repo, base, project, logPath,
    person: { cwd: repo, env: {}, stdinTTY: true, visibility: async () => "private" },
    note(text, opts = {}) {
      const store = new MemoryStore({ home: dir!, deferPromotions: true });
      try { return store.note({ op: "note", project: opts.project ?? project, scope: "project", tier: opts.tier ?? "long", kind: opts.kind ?? "decision", peer: "person", text, about: opts.about ?? [], source: "person", ...(opts.title ? { title: opts.title } : {}) }); } finally { store.close(); }
    },
    log() { return existsSync(logPath) ? readFileSync(logPath, "utf8") : ""; },
  };
}
const promote = (r: Rig, id: string, ...extra: string[]) => runCli(["promote", id, "--to", "repo", "--policy-free", ...extra], r.person);
const refusal = async (run: Promise<string>): Promise<string> => { try { await run; } catch (error) { return (error as Error).message; } throw new Error("expected a refusal"); };
function repoLine(text: string, extra: Partial<RepoLine> = {}): RepoLine {
  const body: Omit<RepoLine, "id"> = { schema: REPO_SCHEMA, op: "note", at: isoAt, kind: "decision", text, about: [], actor: "person", ...extra };
  return { ...body, id: repoEntryId(body) };
}
function writeLog(r: Rig, lines: (string | RepoLine)[]): void {
  mkdirSync(join(r.repo, ".amem"), { recursive: true });
  writeFileSync(r.logPath, lines.map(line => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n");
}
const policy = createStandalonePolicy();

// ---- authority: agents and non-terminals are refused before anything is read or written

for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) test(`an agent (${key}) can never promote to repo scope: refused, nothing written`, async () => {
  const r = rig(); const id = r.note("we chose sqlite");
  for (const value of ["", "1", "codex"]) await expect(runCli(["promote", id, "--to", "repo", "--policy-free", "--confirm"], { ...r.person, env: { [key]: value } })).rejects.toThrow(PERSON_ONLY);
  expect(existsSync(join(r.repo, ".amem"))).toBe(false);
});

test("promote --to repo needs a terminal on stdin, even for the preview, and --policy-free", async () => {
  const r = rig(); const id = r.note("we chose sqlite");
  await expect(runCli(["promote", id, "--to", "repo", "--policy-free"], { ...r.person, stdinTTY: false })).rejects.toThrow("terminal");
  await expect(runCli(["promote", id, "--to", "repo", "--policy-free", "--confirm"], { ...r.person, stdinTTY: false })).rejects.toThrow("terminal");
  await expect(runCli(["promote", id, "--to", "repo"], r.person)).rejects.toThrow("--policy-free");
  expect(existsSync(join(r.repo, ".amem"))).toBe(false);
});

test("--confirm and --confirm-public mean nothing without --to repo, and --to takes only repo", async () => {
  const r = rig(); const id = r.note("we chose sqlite");
  expect(await refusal(runCli(["promote", id, "--policy-free", "--confirm"], r.person))).toContain("only apply with --to repo");
  expect(await refusal(runCli(["promote", id, "--to", "team", "--policy-free"], r.person))).toContain("repo");
});

// ---- the full screen, one regression per refusal

const screened: [string, string, { about?: string[]; kind?: Kind; tier?: "short" | "long" }?][] = [
  ["a secret", `the deploy token is ${GH_TOKEN} for ci`],
  ["a secret split across a key and value", "password: hunter2hunter2"],
  ["personal data (an email address)", "ask jane.doe@example.com about the schema"],
  ["a home-directory path", "the notes live in /Users/alice/private/plan.md"],
  ["a credential location", "copy it from ~/.ssh/id_work first"],
  ["a denied file", "the key is stored there", { about: ["path:config/.env"] }],
];
for (const [label, text, opts] of screened) test(`the screen refuses ${label}, names the reason and writes nothing`, async () => {
  const r = rig(); const id = r.note(text, opts);
  const message = await refusal(promote(r, id, "--confirm"));
  expect(message).toContain("not promoted to repo scope");
  expect(r.log()).toBe("");
  expect(existsSync(join(r.repo, ".amem"))).toBe(false);
});

test("local.deny and pii.paths of the repository's own agent-hub config refuse an entry that names them", async () => {
  const r = rig();
  mkdirSync(join(r.repo, ".agenthub"));
  writeFileSync(join(r.repo, ".agenthub", "config.json"), JSON.stringify({ local: { deny: ["internal-vault"] } }));
  writeFileSync(join(r.repo, ".agenthub", "config.local.json"), JSON.stringify({ pii: { paths: ["customers/"] } }));
  const denied = r.note("the plan is in internal-vault/roadmap.md"), pii = r.note("export customers/acme.csv monthly"), fine = r.note("we keep one writer per shard");
  expect(await refusal(promote(r, denied, "--confirm"))).toContain("local.deny");
  expect(await refusal(promote(r, pii, "--confirm"))).toContain("local.deny");
  expect(r.log()).toBe("");
  expect(await promote(r, fine, "--confirm")).toContain("appended");
});

for (const [label, content] of [["does not parse", "{not json"], ["is not an object", "[]"], ["has a non-list deny", JSON.stringify({ local: { deny: "x" } })], ["has a non-object local", JSON.stringify({ local: 5 })]] as const) test(`a repository config that ${label} refuses the promotion instead of skipping the deny list`, async () => {
  const r = rig(); mkdirSync(join(r.repo, ".agenthub")); writeFileSync(join(r.repo, ".agenthub", "config.json"), content);
  const id = r.note("we keep one writer per shard");
  expect(await refusal(promote(r, id, "--confirm"))).toContain("fix it before promoting");
  expect(existsSync(join(r.repo, ".amem"))).toBe(false);
});

test("only a long-term decision, contract or fail enters repo scope: a finding, a short-term note and a superseded one do not", async () => {
  const r = rig();
  expect(await refusal(promote(r, r.note("a finding", { kind: "finding" }), "--confirm"))).toContain("finding stays private");
  expect(await refusal(promote(r, r.note("short lived", { tier: "short" }), "--confirm"))).toContain("long-term");
  for (const kind of ["decision", "contract", "fail"] as const) expect(await promote(r, r.note(`a ${kind} to share`, { kind }), "--confirm")).toContain("appended");
  expect(r.log().trim().split("\n")).toHaveLength(3);
});

test("a note of another project cannot be promoted into this repository", async () => {
  const r = rig(); const foreign = r.note("another project's private decision", { project: "github.com/o/other" });
  const message = await refusal(promote(r, foreign, "--confirm"));
  expect(message).toMatch(/belongs to another project|no memory entry/);
  expect(r.log()).toBe("");
});

test("private references (task, goal, memory links and absolute or escaping paths) never reach the committed line", async () => {
  const r = rig(); const id = r.note("the cache is per shard", { about: ["path:src/cache.ts", "symbol:open@src/cache.ts", "task:github.com/o/a#7@123", "mem:abcdef012345", "path:/etc/hosts", "path:../../outside.ts", "issue:o/a#12"] });
  const out = await promote(r, id);
  const line = JSON.parse(out.split("\n")[1]!) as RepoLine;
  expect(line.about).toEqual(["path:src/cache.ts", "symbol:open@src/cache.ts", "issue:o/a#12"]);
  expect(out).toContain("left out, private references");
  expect(r.log()).toBe("");
  await promote(r, id, "--confirm");
  expect(r.log()).not.toMatch(/task:|mem:|\/etc\/hosts|\.\.\//);
});

test("the committed line carries no machine, peer, task, project or source-entry id", async () => {
  const r = rig(); const id = r.note("the cache is per shard", { title: "cache" });
  await promote(r, id, "--confirm");
  const line = JSON.parse(r.log().trim()) as Record<string, unknown>;
  expect(Object.keys(line).sort()).toEqual(["about", "actor", "at", "id", "kind", "op", "schema", "text", "title"]);
  expect(r.log()).not.toContain(id);
  expect(line.schema).toBe("amem.repo/v1");
});

// ---- the exact line, and the public-repository guard (AC6)

test("the preview prints the exact line and writes nothing; --confirm appends exactly that line", async () => {
  const r = rig(); const id = r.note("we chose sqlite for the index");
  const preview = await promote(r, id);
  const shown = preview.split("\n")[1]!;
  expect(JSON.parse(shown).text).toBe("we chose sqlite for the index");
  expect(preview).toContain("nothing written");
  expect(existsSync(join(r.repo, ".amem"))).toBe(false);
  const done = await promote(r, id, "--confirm");
  expect(done).toContain("amem does not commit or push");
  expect(r.log()).toBe(`${shown}\n`);
  expect(parseRepoLine(shown)).toHaveProperty("view");
});

test("promoting the same entry twice is a no-op that says so", async () => {
  const r = rig(); const id = r.note("we chose sqlite for the index");
  await promote(r, id, "--confirm");
  const before = r.log();
  expect(await promote(r, id, "--confirm")).toContain("already in the file");
  expect(r.log()).toBe(before);
});

const notPrivate: [string, string | null, (url: string) => Promise<Visibility>][] = [
  ["public", "https://github.com/o/a.git", async () => "public"],
  ["unknown (gh cannot answer)", "https://github.com/o/a.git", async () => "unknown"],
  ["unknown (gh throws)", "https://github.com/o/a.git", async () => { throw new Error("gh missing"); }],
  ["unknown (no remote)", null, async () => "private"],
  ["unknown (a host gh does not know)", "https://git.example.com/o/a.git", async () => "unknown"],
];
for (const [label, remote, visibility] of notPrivate) test(`in a ${label} repository --confirm alone is refused, a wrong or short prefix is refused, and only this entry's prefix writes`, async () => {
  const r = rig(remote); r.person.visibility = visibility;
  const id = r.note("we chose sqlite for the index"), other = r.note("a second public-safe decision");
  const preview = await promote(r, id);
  const prefix = (JSON.parse(preview.split("\n")[1]!) as RepoLine).id.slice(0, 8);
  expect(preview).toContain(`--confirm-public ${prefix}`);
  expect(await refusal(promote(r, id, "--confirm"))).toContain(`--confirm-public ${prefix}`);
  expect(await refusal(promote(r, id, "--confirm", "--confirm-public", "deadbeef"))).toContain("confirmation of this entry");
  expect(await refusal(promote(r, id, "--confirm", "--confirm-public", prefix.slice(0, 4)))).toContain("confirmation of this entry");
  expect(await refusal(promote(r, id, "--confirm", "--confirm-public", "true"))).toContain("confirmation of this entry");
  expect(r.log()).toBe("");
  expect(await promote(r, id, "--confirm", "--confirm-public", prefix)).toContain("appended");
  // Per entry: the first entry's prefix does not confirm a second one.
  const secondPrefix = (JSON.parse((await promote(r, other)).split("\n")[1]!) as RepoLine).id.slice(0, 8);
  expect(await refusal(promote(r, other, "--confirm", "--confirm-public", prefix))).toContain("confirmation of this entry");
  expect(r.log().trim().split("\n")).toHaveLength(1);
  expect(await promote(r, other, "--confirm", "--confirm-public", secondPrefix)).toContain("appended");
});

test("every remote counts: a public push URL or a second public remote makes the repository public", async () => {
  const r = rig("https://github.com/o/private-one.git");
  git(r.repo, "remote", "add", "mirror", "https://github.com/o/public-one.git");
  const answers = async (url: string): Promise<Visibility> => url.includes("public-one") ? "public" : "private";
  expect((await repoVisibility(r.repo, answers)).state).toBe("public");
  git(r.repo, "remote", "remove", "mirror"); git(r.repo, "remote", "set-url", "--push", "origin", "https://github.com/o/public-one.git");
  const seen = await repoVisibility(r.repo, answers);
  expect(seen.state).toBe("public");
  expect(seen.remotes.map(x => x.name)).toContain("origin");
  const mixed = rig("https://github.com/o/a.git", "mixed"); git(mixed.repo, "remote", "add", "x", "https://git.example.com/o/x.git");
  expect((await repoVisibility(mixed.repo, async url => url.includes("github") ? "private" : "unknown")).state).toBe("unknown");
  expect((await repoVisibility(mixed.repo, async () => "private")).state).toBe("private");
});

test("a remote URL with embedded credentials is never printed", async () => {
  const r = rig("https://user:s3cretpass@github.com/o/a.git");
  const seen = await repoVisibility(r.repo, async () => "private");
  expect(JSON.stringify(seen)).not.toContain("s3cretpass");
  const out = await promote(r, r.note("we chose sqlite for the index"));
  expect(out).not.toContain("s3cretpass");
});

// ---- amem never commits, never follows a symlink

test("amem runs no git add, commit, push or fetch while promoting", async () => {
  const r = rig(); const id = r.note("we chose sqlite for the index");
  const real = Bun.spawnSync(["which", "git"]).stdout.toString().trim(), shim = join(r.dir, "shim"), seen = join(r.dir, "git-calls.log");
  mkdirSync(shim); writeFileSync(join(shim, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${seen}'\nexec '${real}' "$@"\n`); chmodSync(join(shim, "git"), 0o755);
  process.env.PATH = `${shim}:${oldPath}`;
  await promote(r, id, "--confirm");
  process.env.PATH = oldPath;
  const calls = readFileSync(seen, "utf8");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls).not.toMatch(/(^|\s)(add|commit|push|fetch|pull|checkout|reset|stash|update-index)(\s|$)/m);
  expect(Bun.spawnSync(["git", "-C", r.repo, "status", "--porcelain"]).stdout.toString()).toContain("?? .amem/");
  expect(Bun.spawnSync(["git", "-C", r.repo, "log", "--oneline"], { stderr: "pipe" }).exitCode).not.toBe(0); // still no commit at all
});

test("a symlinked .amem directory is refused for writing, reading and status", async () => {
  const r = rig(); const outside = join(r.dir, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(r.repo, ".amem"));
  const id = r.note("we chose sqlite for the index");
  expect(await refusal(promote(r, id, "--confirm"))).toMatch(/not a plain directory|resolves outside/);
  expect(existsSync(join(outside, "log.jsonl"))).toBe(false);
  writeFileSync(join(outside, "log.jsonl"), `${JSON.stringify(repoLine("planted through a symlink"))}\n`);
  expect((await readRepoScope(r.repo, policy)).state).toBe("unsafe");
  expect(await runCli(["repo", "status"], r.person)).toContain("unsafe");
});

test("a symlinked log.jsonl is refused: nothing is appended through it and its target is not read", async () => {
  const r = rig(); mkdirSync(join(r.repo, ".amem")); const target = join(r.dir, "elsewhere.jsonl"); writeFileSync(target, `${JSON.stringify(repoLine("planted"))}\n`);
  symlinkSync(target, r.logPath);
  const id = r.note("we chose sqlite for the index");
  expect(await refusal(promote(r, id, "--confirm"))).toContain("not a regular file");
  expect(readFileSync(target, "utf8")).toBe(`${JSON.stringify(repoLine("planted"))}\n`);
  const read = await readRepoScope(r.repo, policy);
  expect(read.state).toBe("unsafe"); expect(read.views).toEqual([]);
});

test(".amem as a regular file, not a directory, is refused", async () => {
  const r = rig(); writeFileSync(join(r.repo, ".amem"), "not a directory");
  expect(await refusal(promote(r, r.note("we chose sqlite for the index"), "--confirm"))).toContain("not a plain directory");
});

test("a log.jsonl without a final newline gets its line on a fresh line, and the old line survives", async () => {
  const r = rig(); const first = repoLine("an older shared decision");
  mkdirSync(join(r.repo, ".amem")); writeFileSync(r.logPath, JSON.stringify(first));
  await promote(r, r.note("we chose sqlite for the index"), "--confirm");
  const lines = r.log().trim().split("\n");
  expect(lines).toHaveLength(2); expect(lines[0]).toBe(JSON.stringify(first));
  expect((await readRepoScope(r.repo, policy)).views).toHaveLength(2);
});

// ---- the file is untrusted input on every read

test("a hostile .amem/log.jsonl: forged ids, unknown fields, wrong schema, oversize and malformed lines are skipped and counted; a secret-bearing valid line is withheld", async () => {
  const r = rig(); const good = repoLine("a reviewed shared decision");
  const forged = { ...repoLine("a forged entry"), text: "tampered after the id was computed" };
  const extra = { ...repoLine("has an extra field"), machine: "mac-1" };
  const wrongSchema = { ...repoLine("wrong schema"), schema: "agent-hub.memory/v1" };
  const wrongKind = { ...repoLine("a finding"), kind: "finding" };
  const secret = repoLine(`rotate ${GH_TOKEN} monthly`);
  const huge = repoLine("x".repeat(20_000));
  writeLog(r, [JSON.stringify(good), JSON.stringify(forged), JSON.stringify(extra), JSON.stringify(wrongSchema), JSON.stringify(wrongKind), "{not json", "[]", JSON.stringify(secret), JSON.stringify(huge), JSON.stringify(good)]);
  const read = await readRepoScope(r.repo, policy);
  expect(read.views.map(v => v.id)).toEqual([good.id]);
  expect(read.skipped).toEqual({ malformed: 6, mismatched: 1, duplicate: 1, withheld: 1 });
  expect(read.partial).toBe(true);
  expect(JSON.stringify(read)).not.toContain(GH_TOKEN);
});

test("a file larger than the read cap is read as whole lines only and reported partial", async () => {
  const r = rig(); const lines = Array.from({ length: 400 }, (_, i) => JSON.stringify(repoLine(`decision number ${i} ${"y".repeat(3000)}`)));
  writeLog(r, lines);
  const read = await readRepoScope(r.repo, policy);
  expect(read.partial).toBe(true); expect(read.views.length).toBeGreaterThan(0); expect(read.views.length).toBeLessThan(400);
});

test("a valid-JSON line naming a home path, a credential location, a denied file, a secret or an email is withheld at read time, whoever wrote it", async () => {
  const r = rig(); writeLog(r, [repoLine("see /Users/alice/private/plan.md for it"), repoLine("copy it from ~/.ssh/id_work"), repoLine("fine one", { about: ["path:keys/id_rsa"] }), repoLine("password: hunter2hunter2"), repoLine("ask jane.doe@example.com"), repoLine("clean line")]);
  const read = await readRepoScope(r.repo, policy);
  expect(read.views.map(v => v.text)).toEqual(["clean line"]);
  expect(read.skipped.withheld).toBe(5);
});

// ---- recall: the current repository's file, never another project's (AC3)

test("list and search on the CLI include this repository's entries, labelled repo, after the project's own", async () => {
  const r = rig(); r.note("we chose sqlite for the index");
  writeLog(r, [repoLine("a shared sqlite decision for the team", { title: "storage" })]);
  const listed = await runCli(["list"], r.person), searched = await runCli(["search", "sqlite"], r.person);
  for (const out of [listed, searched]) { expect(out).toContain("we chose sqlite"); expect(out).toContain("repo scope (.amem/log.jsonl):"); expect(out).toMatch(/repo:[a-f0-9]{8}\s.*storage: a shared sqlite decision/); }
  const json = JSON.parse(await runCli(["search", "sqlite", "--json"], r.person)) as { scope?: string; source?: string }[];
  expect(json.filter(row => row.scope === "repo")).toHaveLength(1);
  const miss = await runCli(["search", "nonexistentword"], r.person);
  expect(miss).not.toContain("repo scope (.amem/log.jsonl):");
});

test("amem show repo:<id> reads one entry, an unknown or ambiguous one is refused", async () => {
  const r = rig(); const line = repoLine("a shared sqlite decision for the team");
  writeLog(r, [line]);
  expect(await runCli(["show", `repo:${line.id}`], r.person)).toContain("a shared sqlite decision");
  expect(await runCli(["show", `repo:${line.id.slice(0, 8)}`], r.person)).toContain("repo scope");
  await expect(runCli(["show", "repo:ffffffffffffffffffffffffffffffff"], r.person)).rejects.toThrow("no repo entry");
});

test("AC3: project B never sees repository A's entries, by default, through the CLI, the MCP server or the brief", async () => {
  const a = rig("https://github.com/o/a.git", "repo-a"), b = rig("https://github.com/o/b.git", "repo-b", a.dir);
  process.env.AMEM_HOME = a.base;
  writeLog(a, [repoLine("alpha only decision about quartz")]);
  b.note("beta own decision about basalt", { project: b.project });
  // CLI inside repository B
  const cliB = { ...b.person }; const out = await runCli(["search", "quartz"], cliB);
  expect(out).not.toContain("quartz");
  expect(await runCli(["list"], cliB)).not.toContain("quartz");
  // MCP server bound to B, started in B, and one bound to project B but started inside repository A
  for (const cwd of [b.repo, a.repo]) {
    const mcp = createMemoryMcp({ cwd, base: a.base, project: b.project });
    try { expect(JSON.stringify(await mcp.tools.amem_search({ query: "quartz" }))).not.toContain("quartz"); } finally { mcp.close(); }
  }
  // Brief for project B, from either directory
  for (const cwd of [b.repo, a.repo]) {
    const brief = await sessionStartBrief({ cwd, base: a.base, project: b.project });
    expect(brief.context).not.toContain("quartz"); expect(brief.coverage.repo).toBeUndefined();
  }
  // Inside A, with A's own project, the entry IS there (the guard is the project binding, not a blanket block).
  const mcpA = createMemoryMcp({ cwd: a.repo, base: a.base, project: a.project });
  try { expect(JSON.stringify(await mcpA.tools.amem_search({ query: "quartz" }))).toContain("quartz"); } finally { mcpA.close(); }
});

test("--all-projects keeps saying it crossed projects and adds no repository rows", async () => {
  const r = rig(); r.note("we chose sqlite for the index"); writeLog(r, [repoLine("a shared sqlite decision for the team")]);
  const out = await runCli(["search", "--all-projects", "sqlite"], r.person);
  expect(out).toContain("crossed projects");
  expect(out).not.toContain("repo scope (.amem/log.jsonl):");
});

test("a subdirectory of the repository finds the same .amem at the repository root", async () => {
  const r = rig(); writeLog(r, [repoLine("a shared sqlite decision for the team")]);
  const sub = join(r.repo, "src", "deep"); mkdirSync(sub, { recursive: true });
  expect(await runCli(["search", "sqlite"], { ...r.person, cwd: sub })).toContain("repo scope (.amem/log.jsonl):");
});

test("MCP: amem_search and amem_show return repo rows as not-evidence, screened by the repository's own deny list; a broken config withholds them", async () => {
  const r = rig(); const keep = repoLine("a shared sqlite decision for the team"), hidden = repoLine("the vault path is internal-vault/plan.md for sqlite");
  writeLog(r, [keep, hidden]);
  mkdirSync(join(r.repo, ".agenthub")); writeFileSync(join(r.repo, ".agenthub", "config.json"), JSON.stringify({ local: { deny: ["internal-vault"] } }));
  let mcp = createMemoryMcp({ cwd: r.repo, base: r.base, project: r.project });
  try {
    const found = await mcp.tools.amem_search({ query: "sqlite" }) as { hits: { source: string; evidence: boolean; view: { id: string } }[] };
    expect(found.hits.map(h => [h.source, h.evidence, h.view.id])).toEqual([["repo", false, keep.id]]);
    expect(await mcp.tools.amem_show({ id: `repo:${keep.id}` })).toMatchObject({ source: "repo", evidence: false });
    expect(await mcp.tools.amem_show({ id: `repo:${hidden.id}` })).toBeNull();
  } finally { mcp.close(); }
  writeFileSync(join(r.repo, ".agenthub", "config.json"), "{broken");
  mcp = createMemoryMcp({ cwd: r.repo, base: r.base, project: r.project });
  try { expect(JSON.stringify(await mcp.tools.amem_search({ query: "sqlite" }))).not.toContain(keep.id); } finally { mcp.close(); }
});

test("MCP: a host policy narrows repo rows as it narrows curated ones", async () => {
  const r = rig(); const line = repoLine("a shared decision mentioning zebra-marker");
  writeLog(r, [line, repoLine("a shared decision that is fine")]);
  const mcp = createMemoryMcp({ cwd: r.repo, base: r.base, project: r.project, policy: { piiPatterns: ["zebra-marker"] } });
  try { const out = JSON.stringify(await mcp.tools.amem_search({ query: "decision" })); expect(out).not.toContain("zebra-marker"); expect(out).toContain("that is fine"); } finally { mcp.close(); }
});

test("brief: a repository without .amem is byte-identical to before (no repo token); with one it adds a repo section and coverage, labelled not-evidence, and withholds hostile lines", async () => {
  const r = rig(); r.note("we chose sqlite for the index");
  const before = await sessionStartBrief({ cwd: r.repo, base: r.base, project: r.project });
  expect(before.context).not.toContain("repo="); expect(before.coverage).not.toHaveProperty("repo");
  writeLog(r, [repoLine("a shared sqlite decision for the team"), repoLine(`rotate ${GH_TOKEN}`), "{garbage"]);
  const after = await sessionStartBrief({ cwd: r.repo, base: r.base, project: r.project });
  expect(after.context).toMatch(/coverage work=\w+ curated=\w+ capture=\w+ repo=partial\./);
  const rows = after.context.split("\n").slice(1).map(line => JSON.parse(line) as { section: string; evidence: boolean; data: { id: string; text: string } });
  const repoRows = rows.filter(row => row.section === "repo");
  expect(repoRows).toHaveLength(1); expect(repoRows[0]!.evidence).toBe(false); expect(repoRows[0]!.data.id).toMatch(/^repo:/);
  expect(after.context).not.toContain(GH_TOKEN);
  expect(after.partial).toBe(true);
});

test("brief: an unsafe or policy-broken repo log is reported unavailable, never shown", async () => {
  const r = rig(); const outside = join(r.dir, "outside"); mkdirSync(outside); writeFileSync(join(outside, "log.jsonl"), `${JSON.stringify(repoLine("planted"))}\n`);
  symlinkSync(outside, join(r.repo, ".amem"));
  const unsafe = await sessionStartBrief({ cwd: r.repo, base: r.base, project: r.project });
  expect(unsafe.context).toContain("repo=unavailable"); expect(unsafe.context).not.toContain("planted");
  rmSync(join(r.repo, ".amem")); writeLog(r, [repoLine("a shared decision")]);
  mkdirSync(join(r.repo, ".agenthub")); writeFileSync(join(r.repo, ".agenthub", "config.json"), "{broken");
  const broken = await sessionStartBrief({ cwd: r.repo, base: r.base, project: r.project });
  expect(broken.context).toContain("repo=unavailable"); expect(broken.context).not.toContain("a shared decision");
});

// ---- .gitattributes, only on request

test("promotion never writes .gitattributes; amem repo attributes previews, then writes only with --confirm, once, and never commits", async () => {
  const r = rig();
  await promote(r, r.note("we chose sqlite for the index"), "--confirm");
  expect(existsSync(join(r.repo, ".gitattributes"))).toBe(false);
  const preview = await runCli(["repo", "attributes"], r.person);
  expect(preview).toContain("preview"); expect(existsSync(join(r.repo, ".gitattributes"))).toBe(false);
  expect(await runCli(["repo", "attributes", "--confirm"], r.person)).toContain("added");
  expect(readFileSync(join(r.repo, ".gitattributes"), "utf8")).toBe(".amem/log.jsonl merge=union\n");
  expect(await runCli(["repo", "attributes", "--confirm"], r.person)).toContain("already has");
  expect(readFileSync(join(r.repo, ".gitattributes"), "utf8")).toBe(".amem/log.jsonl merge=union\n");
  expect(Bun.spawnSync(["git", "-C", r.repo, "log", "--oneline"], { stderr: "pipe" }).exitCode).not.toBe(0);
});

test("amem repo attributes keeps existing lines, adds a newline when missing, refuses a symlink, and needs a person at a terminal", async () => {
  const r = rig(); writeFileSync(join(r.repo, ".gitattributes"), "*.png binary");
  await runCli(["repo", "attributes", "--confirm"], r.person);
  expect(readFileSync(join(r.repo, ".gitattributes"), "utf8")).toBe("*.png binary\n.amem/log.jsonl merge=union\n");
  await expect(runCli(["repo", "attributes", "--confirm"], { ...r.person, stdinTTY: false })).rejects.toThrow("terminal");
  await expect(runCli(["repo", "attributes", "--confirm"], { ...r.person, env: { CLAUDECODE: "1" } })).rejects.toThrow(PERSON_ONLY);
  const s = rig(null, "sym"); const target = join(s.dir, "target-attrs"); writeFileSync(target, "x\n"); symlinkSync(target, join(s.repo, ".gitattributes"));
  await expect(runCli(["repo", "attributes", "--confirm"], s.person)).rejects.toThrow("not a regular file");
  expect(readFileSync(target, "utf8")).toBe("x\n");
});

test("amem repo status is a read: no terminal needed; outside the project's repository it refuses", async () => {
  const r = rig(); writeLog(r, [repoLine("a shared sqlite decision for the team")]);
  expect(await runCli(["repo", "status"], { ...r.person, stdinTTY: false })).toContain("entries: 1");
  const status = JSON.parse(await runCli(["repo", "status", "--json"], { ...r.person, stdinTTY: false })) as { entries: number; state: string };
  expect(status).toMatchObject({ entries: 1, state: "ok" });
  const elsewhere = mkdtempSync(join(tmpdir(), "amem-not-a-repo-")); cleanup.push(() => rmSync(elsewhere, { recursive: true, force: true }));
  await expect(runCli(["repo", "status"], { ...r.person, cwd: elsewhere })).rejects.toThrow("not inside the working tree");
});

// ---- plan: pure of effects

test("planRepoPromotion asks no remote and writes nothing; the plan's line id is the hash of its content", async () => {
  const r = rig(); const store = new MemoryStore({ home: r.dir, deferPromotions: true });
  try {
    const id = store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "contract", peer: "person", text: "writers hold the lease", about: ["path:src/a.ts"], source: "person" });
    const view = store.get(id, r.project)!;
    const plan = await planRepoPromotion(r.repo, view);
    expect(plan.refusals).toEqual([]);
    const { id: lineId, ...rest } = plan.line;
    expect(repoEntryId(rest)).toBe(lineId);
    expect(existsSync(join(r.repo, ".amem"))).toBe(false);
  } finally { store.close(); }
});
