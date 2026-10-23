import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON_ONLY, runCli } from "../src/cli.ts";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { rawMemoryCommand } from "../src/memory/commands.ts";
import { realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { appendRepoLine, parseRepoLine, planRepoPromotion, readRepoScope, REPO_SCHEMA, repoEntryId, repoReadPolicy, repoVisibility, type RepoLine } from "../src/memory/repo-scope.ts";
import { createStandalonePolicy, type MemoryPolicy } from "../src/memory/policy.ts";
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
  expect(await refusal(promote(r, pii, "--confirm"))).toContain("pii.paths entry");
  expect(r.log()).toBe("");
  expect(await promote(r, fine, "--confirm")).toContain("appended");
});

test("pii.paths and local.deny are matched with the hub's glob and subtree semantics on promote and on read, not as substrings", async () => {
  const r = rig();
  mkdirSync(join(r.repo, ".agenthub"));
  writeFileSync(join(r.repo, ".agenthub", "config.json"), JSON.stringify({ pii: { paths: ["data/**/*.csv", "hr/*", "secrets"] }, local: { deny: ["internal-vault"] } }));
  const refused = ["the export is data/2025/customers.csv", "payroll is in hr/payroll.xlsx", "the keys sit under secrets/prod/k", "see Secrets/Prod/K (case differs)"];
  for (const text of refused) { const message = await refusal(promote(r, r.note(text), "--confirm")); expect(message, text).toContain("pii.paths entry"); }
  expect(await refusal(promote(r, r.note("link only", { about: ["path:data/q/z.csv"] }), "--confirm"))).toContain("pii.paths entry");
  expect(r.log()).toBe("");
  const fine = r.note("data pipelines run nightly; HR reviews are quarterly; the csv writer is in src/csv.ts");
  expect(await promote(r, fine, "--confirm")).toContain("appended");
  // read side: a valid line a pull request added is withheld by the same matcher, whatever its author thought
  writeLog(r, [repoLine("the export is data/2025/customers.csv"), repoLine("payroll is in hr/payroll.xlsx"), repoLine("keys under secrets/prod/k"), repoLine("clean line about src/csv.ts")]);
  const read = await readRepoScope(r.repo, (repoReadPolicy(r.repo) as { policy: MemoryPolicy }).policy);
  expect(read.views.map(v => v.text)).toEqual(["clean line about src/csv.ts"]);
  expect(read.skipped.withheld).toBe(3);
  // and through the recall surfaces: the person's own private note still shows in their own list (it is theirs, unscreened), the repo section does not carry the withheld lines
  const listed = await runCli(["search", "export"], r.person), repoPart = listed.slice(listed.indexOf("repo scope (.amem/log.jsonl):") >= 0 ? listed.indexOf("repo scope (.amem/log.jsonl):") : listed.length);
  expect(repoPart).not.toContain("customers.csv"); expect(listed).toContain("3 withheld by the screen");
  const mcp = createMemoryMcp({ cwd: r.repo, base: r.base, project: r.project });
  try {
    const hits = (await mcp.tools.amem_search({ query: "payroll" }) as { hits: { source: string }[] }).hits;
    expect(hits.filter(h => h.source === "repo")).toEqual([]);       // the planted repo line is withheld; the person's own private note (source curated) is theirs and not in question here
  } finally { mcp.close(); }
});

test("an invalid pii.paths entry (absolute, .., brackets, a mixed ** segment, more than 64) refuses by name, as the hub's own loader does", async () => {
  for (const bad of [["/etc/x"], ["../x"], ["a[1]"], ["a**b"], Array.from({ length: 65 }, (_, i) => `p${i}`), "data"]) {
    const r = rig(); mkdirSync(join(r.repo, ".agenthub")); writeFileSync(join(r.repo, ".agenthub", "config.json"), JSON.stringify({ pii: { paths: bad } }));
    expect(await refusal(promote(r, r.note("we keep one writer per shard"), "--confirm")), JSON.stringify(bad).slice(0, 30)).toContain("pii.paths");
    expect(existsSync(join(r.repo, ".amem"))).toBe(false);
  }
});

test("a local.deny list longer than the screen holds refuses by name instead of a generic invalid-policy error", async () => {
  const r = rig(); mkdirSync(join(r.repo, ".agenthub"));
  writeFileSync(join(r.repo, ".agenthub", "config.json"), JSON.stringify({ local: { deny: Array.from({ length: 65 }, (_, i) => `deny-${i}`) } }));
  expect(await refusal(promote(r, r.note("we keep one writer per shard"), "--confirm"))).toContain("local.deny names more than 64");
  writeFileSync(join(r.repo, ".agenthub", "config.json"), JSON.stringify({ local: { deny: ["x".repeat(300)] } }));
  expect(await refusal(promote(r, r.note("we keep one writer per shard"), "--confirm"))).toContain("at most 256 bytes");
});

for (const [label, content] of [["does not parse", "{not json"], ["is not an object", "[]"], ["has a non-list deny", JSON.stringify({ local: { deny: "x" } })], ["has a non-object local", JSON.stringify({ local: 5 })]] as const) test(`a repository config that ${label} refuses the promotion instead of skipping the deny list`, async () => {
  const r = rig(); mkdirSync(join(r.repo, ".agenthub")); writeFileSync(join(r.repo, ".agenthub", "config.json"), content);
  const id = r.note("we keep one writer per shard");
  expect(await refusal(promote(r, id, "--confirm"))).toContain("fix it before using the repo scope");
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

test("effective URLs count: url.<base>.insteadOf and pushInsteadOf rewrite where git really pushes, and several pushurls are all checked", async () => {
  const answers = async (url: string): Promise<Visibility> => url.includes("public-one") ? "public" : url.startsWith("https://github.com/") ? "private" : "unknown";
  const viaPush = rig("https://github.com/o/private-one.git");
  git(viaPush.repo, "config", "url.https://github.com/o/public-one.git.pushInsteadOf", "https://github.com/o/private-one.git");
  const pushed = await repoVisibility(viaPush.repo, answers);
  expect(pushed.state).toBe("public");
  expect(pushed.remotes.find(r => r.kind === "push")?.url).toContain("public-one");
  const viaBoth = rig("https://github.com/o/a.git");
  git(viaBoth.repo, "config", "url.https://github.com/o/public-one.git/.insteadOf", "https://github.com/o/a.git/");
  git(viaBoth.repo, "config", "url.https://github.com/o/public-one.git.insteadOf", "https://github.com/o/a.git");
  expect((await repoVisibility(viaBoth.repo, answers)).state).toBe("public");
  const manyPush = rig("https://github.com/o/a.git");
  git(manyPush.repo, "remote", "set-url", "--push", "origin", "https://github.com/o/a.git"); git(manyPush.repo, "remote", "set-url", "--add", "--push", "origin", "https://github.com/o/public-one.git");
  expect((await repoVisibility(manyPush.repo, answers)).state).toBe("public");
  // a rewrite onto a host gh cannot judge is unknown, never private
  const toUnknown = rig("https://github.com/o/a.git");
  const noteId = toUnknown.note("we chose sqlite for the index");           // stored under the project key as it is BEFORE the rewrite: insteadOf on origin changes the key git reports
  git(toUnknown.repo, "config", "url.https://git.example.com/mirror/.insteadOf", "https://github.com/o/");
  expect((await repoVisibility(toUnknown.repo, answers)).state).toBe("unknown");
  // end to end through the CLI with the injected check: the person is told it is not verified private
  toUnknown.person.visibility = answers;
  const rewrittenKey = memoryProjectKey(toUnknown.repo);
  expect(rewrittenKey).not.toBe(toUnknown.project);                          // the premise of the note above
  const store = new MemoryStore({ home: toUnknown.dir, deferPromotions: true });
  let moved: string;
  try { moved = store.note({ op: "note", project: rewrittenKey, scope: "project", tier: "long", kind: "decision", peer: "person", text: "we chose sqlite for the index", about: [], source: "person" }); } finally { store.close(); }
  void noteId;
  const preview = await promote(toUnknown, moved);
  expect(preview).toContain("NOT a verified private repository");
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

test("a file larger than the read cap keeps its NEWEST lines (the tail), as whole lines only, and reports partial", async () => {
  const r = rig(); const lines = Array.from({ length: 400 }, (_, i) => JSON.stringify(repoLine(`decision number ${i} ${"y".repeat(3000)}`)));
  writeLog(r, lines);
  const read = await readRepoScope(r.repo, policy);
  expect(read.partial).toBe(true); expect(read.views.length).toBeGreaterThan(0); expect(read.views.length).toBeLessThan(400);
  expect(read.views[0]!.text).toContain("decision number 399");                      // the last appended line survives the cap
  expect(read.views.at(-1)!.text).not.toContain("decision number 0 ");               // the oldest do not
  expect(read.skipped.malformed).toBe(0);                                              // the cut first piece is dropped, never parsed
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

test("the hub's raw command refuses --to, --confirm and --confirm-public instead of promoting privately and ignoring them", async () => {
  const r = rig(); const id = r.note("we chose sqlite for the index");
  const store = new MemoryStore({ home: r.dir, deferPromotions: true });
  try {
    for (const flags of [["--to", "repo"], ["--confirm"], ["--confirm-public", "abcdef01"]]) {
      await expect(rawMemoryCommand(["promote", id, ...flags], r.repo, { project: r.project, store, open: () => store, readable: notes => notes, importPolicy: () => () => false })).rejects.toThrow("amem promote <id> --to repo");
    }
  } finally { store.close(); }
  expect(existsSync(join(r.repo, ".amem"))).toBe(false);
});

test("a shared-scope note written under another project is returned by get() but cannot be promoted into this repository", async () => {
  const r = rig(); const store = new MemoryStore({ home: r.dir, deferPromotions: true });
  let foreign: string;
  try { foreign = store.note({ op: "note", project: "github.com/o/other", scope: "shared", tier: "long", kind: "decision", peer: "person", text: "another project's shared decision", about: [], source: "person" }); } finally { store.close(); }
  // The premise: a plain project-bound read DOES surface it, which is why the promotion needs its own project check.
  expect(await runCli(["show", foreign], r.person)).toContain("another project's shared decision");
  expect(await refusal(promote(r, foreign, "--confirm"))).toContain("belongs to another project");
  expect(r.log()).toBe("");
});

test("appendRepoLine itself refuses a symlinked or non-regular .amem and log.jsonl, even when the planner is bypassed", () => {
  const dirLink = rig(null, "dirlink"), outside = join(dirLink.dir, "outside"); mkdirSync(outside); symlinkSync(outside, join(dirLink.repo, ".amem"));
  expect(() => appendRepoLine(dirLink.repo, repoLine("through a directory link"))).toThrow(/not a plain directory|resolves outside/);
  expect(existsSync(join(outside, "log.jsonl"))).toBe(false);
  const fileLink = rig(null, "filelink"); mkdirSync(join(fileLink.repo, ".amem")); const target = join(fileLink.dir, "target.jsonl"); writeFileSync(target, "kept\n"); symlinkSync(target, fileLink.logPath);
  expect(() => appendRepoLine(fileLink.repo, repoLine("through a file link"))).toThrow("not a regular file");
  expect(readFileSync(target, "utf8")).toBe("kept\n");
  const asDir = rig(null, "asdir"); mkdirSync(join(asDir.repo, ".amem", "log.jsonl"), { recursive: true });
  expect(() => appendRepoLine(asDir.repo, repoLine("into a directory"))).toThrow("not a regular file");
});

// ---- found while exercising the installed package

test("the native hook's brief (nativeSession) includes the repo section when a .amem exists, and none when it does not or the repository is another project's", async () => {
  const { processSignature } = await import("../src/memory/platform.ts");
  const native = { signature: processSignature(process.pid)! };
  const a = rig("https://github.com/o/a.git", "repo-a"), b = rig("https://github.com/o/b.git", "repo-b", a.dir);
  process.env.AMEM_HOME = a.base;
  const brief = (cwd: string, project: string) => sessionStartBrief({ cwd, base: a.base, project, nativeSession: native, timeRemaining: () => 2000 });
  expect((await brief(a.repo, a.project)).coverage).not.toHaveProperty("repo");           // no .amem anywhere above: no section, no git call needed
  writeLog(a, [repoLine("a native-session shared decision about quartz")]);
  const withLog = await brief(a.repo, a.project);
  expect(withLog.context).toContain("repo=complete"); expect(withLog.context).toContain("quartz");
  const sub = join(a.repo, "src", "deep"); mkdirSync(sub, { recursive: true });
  expect((await brief(sub, a.project)).context).toContain("quartz");                       // a subdirectory finds the root's file
  const other = await brief(b.repo, b.project);                                             // AC3 on the native path
  expect(other.context).not.toContain("quartz"); expect(other.coverage).not.toHaveProperty("repo");
  expect((await brief(a.repo, b.project)).context).not.toContain("quartz");                 // project B started inside repository A
});

test("repoLogNearby is lstat-only and looks for the LOG: an empty .amem directory does not count, a log at or above the cwd does, a symlinked .amem counts so the reader can refuse it", async () => {
  const { repoLogNearby } = await import("../src/memory/repo-scope.ts");
  const r = rig(null); const deep = join(r.repo, "a", "b"); mkdirSync(deep, { recursive: true });
  expect(repoLogNearby(deep)).toBe(false);
  mkdirSync(join(r.repo, ".amem")); expect(repoLogNearby(deep)).toBe(false);          // the directory alone is not a repo scope
  writeFileSync(r.logPath, ""); expect(repoLogNearby(deep)).toBe(true);
  const s = rig(null, "linked"); const target = join(r.dir, "elsewhere"); mkdirSync(target); writeFileSync(join(target, "log.jsonl"), ""); symlinkSync(target, join(s.repo, ".amem")); expect(repoLogNearby(s.repo)).toBe(true);
});

test("promoting into a repository that git ignores says so, because git status will never show the file; a tracked or unignored log gets no warning", async () => {
  const r = rig(); writeFileSync(join(r.repo, ".gitignore"), ".amem/\n");
  const first = await promote(r, r.note("we chose sqlite for the index"), "--confirm");
  expect(first).toContain("WARNING: git ignores .amem/log.jsonl");
  expect(Bun.spawnSync(["git", "-C", r.repo, "status", "--porcelain", "--", ".amem"]).stdout.toString()).toBe("");
  const clean = rig("https://github.com/o/clean.git", "clean"); // a remote, so the injected "private" answer applies and --confirm alone writes
  const second = await promote(clean, clean.note("we chose sqlite for the index"), "--confirm");
  expect(second).toContain("appended"); expect(second).not.toContain("WARNING");
});

test("a git worktree of the repository (same project key) reads its own checkout of .amem, and concurrent promotions of different entries append intact lines", async () => {
  const r = rig(); const ids = [1, 2, 3, 4, 5, 6].map(i => r.note(`concurrent decision number ${i}`));
  const prefixes = await Promise.all(ids.map(async id => (JSON.parse((await promote(r, id)).split("\n")[1]!) as RepoLine).id.slice(0, 8)));
  await Promise.all(ids.map((id, i) => promote(r, id, "--confirm", "--confirm-public", prefixes[i]!)));
  const lines = r.log().trim().split("\n");
  expect(lines).toHaveLength(6); for (const line of lines) expect(parseRepoLine(line)).toHaveProperty("view");
  expect(new Set(lines.map(l => (JSON.parse(l) as RepoLine).id)).size).toBe(6);
  git(r.repo, "-c", "user.email=a@b", "-c", "user.name=n", "add", "-A"); git(r.repo, "-c", "user.email=a@b", "-c", "user.name=n", "commit", "-q", "-m", "base");
  const wt = join(r.dir, "wt"); git(r.repo, "worktree", "add", "-q", wt, "-b", "side");
  expect((await runCli(["search", "concurrent"], { ...r.person, cwd: wt })).match(/repo:[a-f0-9]{8}/g)).toHaveLength(6);
  rmSync(join(wt, ".amem", "log.jsonl"));
  expect(await runCli(["search", "concurrent"], { ...r.person, cwd: wt })).not.toContain("repo scope (.amem/log.jsonl):");
});

// ---- review findings (codex-connector, round 0)

test("the writer and the reader agree on limits: a multibyte title over the BYTE limit is refused at promotion, and whatever is appended is read back", async () => {
  const r = rig("https://github.com/o/a.git");
  const wide = r.note("body is fine", { title: "한".repeat(100) });       // 100 characters, 300 UTF-8 bytes: over the 200-byte reader limit
  const message = await refusal(promote(r, wide, "--confirm"));
  expect(message).toContain("title 200 bytes");
  expect(r.log()).toBe("");
  const edge = r.note("body is fine", { title: "한".repeat(66) });         // 198 bytes: allowed, and must be readable
  await promote(r, edge, "--confirm");
  const read = await readRepoScope(r.repo, policy);
  expect(read.views).toHaveLength(1); expect(read.skipped.malformed).toBe(0);
  // the planner also refuses anything the reader's own parser rejects, even when no single named limit was crossed: one over-long link (reader limit 300 bytes) has no check of its own
  const store = new MemoryStore({ home: r.dir, deferPromotions: true });
  try {
    const id = store.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "decision", peer: "person", text: "x", about: [`path:${"d/".repeat(200)}f.ts`], source: "person" });
    const plan = await planRepoPromotion(r.repo, store.get(id, r.project)!);
    expect("error" in parseRepoLine(plan.text)).toBe(true);                          // the premise: this line is one the reader rejects
    expect(plan.refusals.join(" ")).toContain("repo reader's own validation");
  } finally { store.close(); }
});

test("MCP search on the FTS engine lets FTS pick repo candidates, like curated ones: punctuation and extra words do not drop a repo entry", async () => {
  const r = rig(); writeLog(r, [repoLine("sqlite writer lease per shard")]);
  const mcp = createMemoryMcp({ cwd: r.repo, base: r.base, project: r.project });
  try {
    const engine = (await mcp.tools.amem_search({ query: "sqlite" }) as { engine: string }).engine;
    for (const query of ["sqlite?", "sqlite concurrency", "sqlite writer", "Sqlite, WRITER!"]) {
      const out = await mcp.tools.amem_search({ query }) as { hits: { source: string }[] };
      expect(out.hits.filter(h => h.source === "repo"), `query ${JSON.stringify(query)} on ${engine}`).toHaveLength(1);
    }
    expect((await mcp.tools.amem_search({ query: "zzz" }) as { hits: unknown[] }).hits).toHaveLength(0);
  } finally { mcp.close(); }
});

// ---- review round 1 (claude): hook deadline, terminal escapes, forged dates, private-path spellings

test("brief: without a .amem/log.jsonl the repo section costs NO git process, on the plain path and on the native path", async () => {
  const { processSignature } = await import("../src/memory/platform.ts");
  const r = rig(); r.note("we chose sqlite for the index");
  const real = Bun.spawnSync(["which", "git"]).stdout.toString().trim(), shim = join(r.dir, "shim"), seen = join(r.dir, "git-calls.log");
  mkdirSync(shim); writeFileSync(join(shim, "git"), `#!/bin/sh\nprintf 'GIT %s\\n' "$*" >> '${seen}'\nexec '${real}' "$@"\n`); chmodSync(join(shim, "git"), 0o755);
  process.env.PATH = `${shim}:${oldPath}`;
  const calls = () => existsSync(seen) ? readFileSync(seen, "utf8").split("\n").filter(Boolean) : [];
  // The shim sees every git call; the brief's OTHER sections may call git (project identity). Measure the repo section by the delta against an identical brief whose repo probe is positive.
  await sessionStartBrief({ cwd: r.repo, base: r.base, project: r.project });
  const without = calls().length;
  rmSync(seen, { force: true });
  writeLog(r, [repoLine("a shared decision")]);
  await sessionStartBrief({ cwd: r.repo, base: r.base, project: r.project });
  const withLog = calls().length;
  expect(withLog, "a repository WITH a log pays the root resolution (git rev-parse and remote get-url)").toBeGreaterThan(without);
  rmSync(seen, { force: true }); rmSync(join(r.repo, ".amem"), { recursive: true });
  const native = { signature: processSignature(process.pid)! };
  await sessionStartBrief({ cwd: r.repo, base: r.base, project: r.project, nativeSession: native, timeRemaining: () => 2000 });
  expect(calls().filter(line => /rev-parse --show-toplevel/.test(line)), "no root resolution for a repo scope that is not there").toEqual([]);
});

test("brief: a 1 MiB log is read as the newest handful only and never past the deadline; a spent deadline reads nothing and marks the section partial", async () => {
  const r = rig();
  const big = Array.from({ length: 330 }, (_, i) => repoLine(`decision number ${i} ${"y".repeat(3100)}`, { at: `2026-10-20T10:${String(i % 60).padStart(2, "0")}:00.000Z` }));
  writeLog(r, big);
  const size = readFileSync(r.logPath).length; expect(size).toBeGreaterThan(1_000_000);
  const started = performance.now();
  const brief = await sessionStartBrief({ cwd: r.repo, base: r.base, project: r.project, timeRemaining: () => 140 - (performance.now() - started) });
  expect(performance.now() - started).toBeLessThan(140);
  expect(brief.context).toContain("repo=partial");
  const rows = brief.context.split("\n").slice(1).map(line => JSON.parse(line) as { section: string; data: { text: string } }).filter(row => row.section === "repo");
  expect(rows.length).toBeLessThanOrEqual(4); expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]!.data.text).toContain("decision number 329");                       // the LAST line of the file is the newest
  // the read itself, bounded by its own deadline
  const { readRepoScope } = await import("../src/memory/repo-scope.ts");
  const spent = await readRepoScope(r.repo, policy, { remainingMs: () => 0 });
  expect(spent.views).toEqual([]); expect(spent.partial).toBe(true);
  const limited = await readRepoScope(r.repo, policy, { limit: 3 });
  expect(limited.views).toHaveLength(3); expect(limited.partial).toBe(true);
  const midway = (() => { let calls = 0; return () => (calls++ < 20 ? 50 : 0); })();
  const cut = await readRepoScope(r.repo, policy, { remainingMs: midway });
  expect(cut.views).toHaveLength(20); expect(cut.partial).toBe(true);                // the 21st check saw the deadline: 20 rows, not the ~270 the window holds
});

test("control characters are refused on read: a pull request cannot carry a terminal escape into list, search or show", async () => {
  const r = rig();
  const esc = "\u001b[2J\u001b]0;pwned\u0007", csi = "\u009b31m", nul = "a\u0000b", bell = "ring\u0007";
  writeLog(r, [repoLine(`before ${esc} after`), repoLine(`c1 ${csi} here`), repoLine(nul), repoLine(bell), repoLine("tab\tand newline\nare fine"), repoLine("clean", { title: `ti${esc}tle` }), repoLine("a clean line")]);
  const read = await readRepoScope(r.repo, policy);
  expect(read.views.map(v => v.text)).toEqual(["a clean line", "tab\tand newline\nare fine"]);
  expect(read.skipped.malformed).toBe(5);
  const out = [await runCli(["list"], r.person), await runCli(["search", "line"], r.person), await runCli(["repo", "status"], r.person)].join("\n");
  expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

test("a line dated in the future cannot pin the brief or the list: order is file position (newest appended first), and a future `at` is shown as now", async () => {
  const r = rig();
  writeLog(r, [repoLine("the oldest line", { at: "2026-10-01T00:00:00.000Z" }), repoLine("pinned by a forged date", { at: "2999-01-01T00:00:00.000Z" }), repoLine("the newest appended line", { at: "2026-10-02T00:00:00.000Z" })]);
  const read = await readRepoScope(r.repo, policy);
  expect(read.views.map(v => v.text)).toEqual(["the newest appended line", "pinned by a forged date", "the oldest line"]);
  expect(read.views.every(v => Date.parse(v.at) <= Date.now())).toBe(true);
  const brief = await sessionStartBrief({ cwd: r.repo, base: r.base, project: r.project });
  const order = brief.context.split("\n").slice(1).map(line => JSON.parse(line) as { section: string; data: { text: string; at: string } }).filter(row => row.section === "repo");
  expect(order[0]!.data.text).toBe("the newest appended line");
  expect(brief.context).not.toContain("2999");
});

test("a duplicate line (merge=union repeats) collapses to its newest copy", async () => {
  const r = rig(); const dup = repoLine("shared once"); const other = repoLine("something between");
  writeLog(r, [dup, other, dup]);
  const read = await readRepoScope(r.repo, policy);
  expect(read.views.map(v => v.text)).toEqual(["shared once", "something between"]); expect(read.skipped.duplicate).toBe(1);
});

test("private paths are caught in every spelling a person or a platform writes: folded case and width, split with zero-width characters, backslashes, $HOME and %USERPROFILE%", async () => {
  const { namesPrivatePath } = await import("../src/memory/repo-scope.ts");
  for (const text of ["see /Users/alice/x", "see /USERS/Alice/x", "see /users/alice/x", "see /home/bob/x", "see C:\\Users\\bob\\x", "see c:/Users/bob/x", "see /Us\u200bers/alice/x", "see \uff0fUsers\uff0falice\uff0fx".normalize("NFKC"),
    "copy ~/.ssh/id_work", "copy ~/.AWS/credentials", "copy ~/.kube/config", "run $HOME/bin/tool", "run ${HOME}/bin/tool", "set %USERPROFILE%\\x", "set %AppData%\\x", "set %LOCALAPPDATA%\\x"]) expect(namesPrivatePath(text), text).toBe(true);
  for (const text of ["the users table is documented", "home page of the project", "see src/users/model.ts", "a user home screen", "use $HOMEPAGE_URL", "50% of users"]) expect(namesPrivatePath(text), text).toBe(false);
});

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
