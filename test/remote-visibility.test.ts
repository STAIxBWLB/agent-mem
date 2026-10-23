import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { githubRepoOf, remoteVisibility } from "../src/memory/sync.ts";
import { realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";

// #121 review round 1: the remote visibility check must anchor the host. It guards `amem promote --to repo` AND `amem sync` / generation sync's private-remote guard.
const cleanup: (() => void)[] = [];
const oldPath = process.env.PATH, oldHost = process.env.GH_HOST;
afterEach(() => {
  process.env.PATH = oldPath; if (oldHost === undefined) delete process.env.GH_HOST; else process.env.GH_HOST = oldHost; delete process.env.AMEM_HOME;
  for (const close of cleanup.splice(0).reverse()) close();
});
/** A fake `gh` first on PATH: it records argv and GH_HOST, and answers `answer` for any repo. */
function fakeGh(answer: string): { log: () => string[] } {
  const dir = realPath(mkdtempSync(join(tmpdir(), "amem-fakegh-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf 'ARGS=%s GH_HOST=%s ENT=%s/%s\\n' "$*" "\${GH_HOST-unset}" "\${GH_ENTERPRISE_TOKEN-unset}" "\${GITHUB_ENTERPRISE_TOKEN-unset}" >> '${log}'\necho ${answer}\n`); chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${oldPath}`;
  return { log: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
}

const github: [string, string][] = [
  ["https://github.com/acme/notes.git", "acme/notes"], ["https://github.com/acme/notes", "acme/notes"], ["https://github.com/acme/notes/", "acme/notes"], ["https://GitHub.com/Acme/Notes", "Acme/Notes"],
  ["git@github.com:acme/notes.git", "acme/notes"], ["github.com:acme/notes", "acme/notes"], ["ssh://git@github.com/acme/notes.git", "acme/notes"], ["https://user@github.com/acme/notes", "acme/notes"],
  ["https://user:token@github.com/acme/notes.git", "acme/notes"], ["  https://github.com/acme/notes.git  ", "acme/notes"], ["https://github.com/acme/my.repo-2_x", "acme/my.repo-2_x"],
];
const notGithub = [
  "https://notgithub.com/acme/notes", "git@evil-github.com:acme/notes.git", "https://git.example.org/mirror/github.com/acme/notes", "https://github.com.evil.org/acme/notes",
  "https://evil.org/github.com/acme/notes", "https://github.com@evil.org/acme/notes", "https://evil.org\\@github.com/acme/notes", "git@github.com.evil.org:acme/notes.git", "evil@github.com:acme/notes.git",
  "ssh://deploy@github.com/acme/notes", "ssh://github.com/acme/notes", "https://github.com:8443/acme/notes", "http://github.com/acme/notes", "git://github.com/acme/notes", "ftp://github.com/acme/notes",
  "https://api.github.com/acme/notes", "https://gist.github.com/acme/notes", "https://www.github.com/acme/notes", "https://github.com/acme/notes/extra", "https://github.com/acme", "https://github.com/",
  "https://github.com/acme/notes?x=1", "https://github.com/acme/notes#frag", "https://github.com/-acme/..", "https://github.com/acme/.", "https://github.com/a cme/notes", "file:///srv/github.com/acme/notes", "", "   ", "not a url",
  "https://github.com/" + "a".repeat(600),
];
for (const [url, repo] of github) test(`githubRepoOf accepts ${JSON.stringify(url)} as ${repo}`, () => expect(githubRepoOf(url)).toBe(repo));
for (const url of notGithub) test(`githubRepoOf refuses ${JSON.stringify(url.slice(0, 60))}`, () => expect(githubRepoOf(url)).toBeUndefined());

test("a URL whose host is not exactly github.com is unknown and gh is never asked, even when gh would answer private", async () => {
  const gh = fakeGh("private");
  for (const url of notGithub) expect(await remoteVisibility(url), url.slice(0, 60)).toBe("unknown");
  expect(gh.log()).toEqual([]);
  expect(await remoteVisibility("https://github.com/acme/notes.git")).toBe("private");
  expect(gh.log()).toHaveLength(1);
});

test("gh is pinned to github.com: an inherited GH_HOST never redirects the answer to another server", async () => {
  const gh = fakeGh("private");
  process.env.GH_HOST = "attacker.example";
  expect(await remoteVisibility("git@github.com:acme/notes.git")).toBe("private");
  expect(gh.log()).toEqual(["ARGS=repo view acme/notes --json visibility --jq .visibility GH_HOST=github.com ENT=unset/unset"]);
});

test("gh never receives an enterprise token: it would be sent to github.com as a credential for another server", async () => {
  const gh = fakeGh("private");
  process.env.GH_ENTERPRISE_TOKEN = "ghe-secret-1"; process.env.GITHUB_ENTERPRISE_TOKEN = "ghe-secret-2";
  try { expect(await remoteVisibility("https://github.com/acme/notes.git")).toBe("private"); } finally { delete process.env.GH_ENTERPRISE_TOKEN; delete process.env.GITHUB_ENTERPRISE_TOKEN; }
  expect(gh.log()).toEqual(["ARGS=repo view acme/notes --json visibility --jq .visibility GH_HOST=github.com ENT=unset/unset"]);
});

test("gh answers map: public is public, private and internal are private, anything else, a failure or a missing gh is unknown", async () => {
  for (const [answer, expected] of [["public", "public"], ["PUBLIC", "public"], ["private", "private"], ["internal", "private"], ["secret", "unknown"], ["", "unknown"]] as const) {
    fakeGh(answer); expect(await remoteVisibility("https://github.com/acme/notes.git"), answer).toBe(expected);
  }
  process.env.PATH = join(tmpdir(), "amem-no-gh-here"); expect(await remoteVisibility("https://github.com/acme/notes.git")).toBe("unknown");
});

test("`amem sync`'s private-remote guard (syncMemory, the 0.6.0 path) asks gh about a real github.com remote and never about a look-alike host", async () => {
  const gh = fakeGh("private");                                           // gh would call any acme/notes private: only the host check decides whether it is asked at all
  const dir = realPath(mkdtempSync(join(tmpdir(), "amem-vis-sync-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const open = (name: string) => { const store = new MemoryStore({ home: join(dir, name), deferPromotions: true }); cleanup.push(() => store.close()); store.note({ op: "note", project: "work/app", scope: "project", tier: "long", kind: "decision", peer: "codex", text: `a decision to sync from ${name}`, about: [], source: "person" }); return store; };
  // No network here: both pushes fail at the transport, after the visibility guard ran. What the guard decided is what gh was (not) asked, and that no "public" refusal fired.
  const lookalike = await syncMemory(open("a"), { remote: "https://notgithub.com/acme/notes.git" });
  expect(lookalike.ok ? "" : lookalike.error).not.toContain("is public");
  expect(gh.log(), "a look-alike host must not be resolved to acme/notes").toEqual([]);
  const real = await syncMemory(open("b"), { remote: "https://github.com/acme/notes.git" });
  expect(real.ok ? "" : real.error).not.toContain("is public");
  expect(gh.log()).toEqual(["ARGS=repo view acme/notes --json visibility --jq .visibility GH_HOST=github.com ENT=unset/unset"]);
});

test("end to end: a public push target whose URL merely contains github.com cannot make `amem promote --to repo --confirm` skip --confirm-public", async () => {
  fakeGh("private");                                                       // a private github.com repo named acme/notes exists
  const dir = realPath(mkdtempSync(join(tmpdir(), "amem-vis-e2e-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"); mkdirSync(repo);
  const git = (...args: string[]) => { const done = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" }); if (done.exitCode !== 0) throw new Error(done.stderr.toString()); };
  git("init", "--quiet"); git("remote", "add", "origin", "https://github.com/acme/notes.git"); git("remote", "set-url", "--push", "origin", "https://notgithub.com/acme/notes");
  const base = join(dir, "memory"); process.env.AMEM_HOME = base;
  const project = memoryProjectKey(repo);
  const store = new MemoryStore({ home: dir, deferPromotions: true });
  let id: string;
  try { id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", text: "we keep one writer per shard", about: [], source: "person" }); } finally { store.close(); }
  const person = { cwd: repo, env: {}, stdinTTY: true };                   // NO injected visibility: the real remoteVisibility, through the fake gh
  const message = await runCli(["promote", id, "--to", "repo", "--policy-free", "--confirm"], person).then(() => "WROTE", error => (error as Error).message);
  expect(message).toContain("confirmation of this entry");
  expect(existsSync(join(repo, ".amem"))).toBe(false);
});
