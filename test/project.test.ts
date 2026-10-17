import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(dir: string, args: string[]): void {
  const result = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function separateRepo(worktree: string, gitDir: string): string {
  mkdirSync(worktree, { recursive: true });
  git(worktree, ["init", "-q", "--separate-git-dir", gitDir]);
  git(worktree, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return worktree;
}

test("N4: separate git dirs do not merge unrelated repositories or their parent directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-project-test-"));
  cleanup.push(dir);
  const gitDirs = join(dir, "gitdirs");
  mkdirSync(gitDirs, { recursive: true });
  const alpha = separateRepo(join(dir, "alpha"), join(gitDirs, "alpha.git"));
  const beta = separateRepo(join(dir, "beta"), join(gitDirs, "beta.git"));
  const alphaKey = memoryProjectKey(alpha), betaKey = memoryProjectKey(beta);
  const parentKey = memoryProjectKey(gitDirs);

  expect(alphaKey).not.toBe(betaKey);
  expect(alphaKey).not.toBe(parentKey);
  expect(betaKey).not.toBe(parentKey);
  const rootHash = createHash("sha256").update(realPath(alpha)).digest("hex").slice(0, 8);
  expect(alphaKey).toBe(`alpha@${rootHash}`); // root-invoked pre-#15 history keeps its key
  mkdirSync(join(alpha, "src", "deep"), { recursive: true });
  expect(memoryProjectKey(join(alpha, "src", "deep"))).toBe(alphaKey);
});
