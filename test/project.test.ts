import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { memoryProjectKey, projectChain } from "../src/memory/project.ts";

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


test("relative core.worktree keeps separate-directory project keys equal at root and subdirectory", () => {
  const dir=mkdtempSync(join(tmpdir(),"amem-project-relative-"));cleanup.push(dir);
  const gitDir=join(dir,"metadata","separate.git");mkdirSync(join(dir,"metadata"),{recursive:true});
  const worktree=separateRepo(join(dir,"worktree"),gitDir),before=memoryProjectKey(worktree);
  git(worktree,["config","core.worktree",relative(gitDir,worktree)]);
  const nested=join(worktree,"src","deep");mkdirSync(nested,{recursive:true});
  const rootHash=createHash("sha256").update(realPath(worktree)).digest("hex").slice(0,8);
  expect(memoryProjectKey(worktree)).toBe(`worktree@${rootHash}`);
  expect(memoryProjectKey(worktree)).toBe(before);
  expect(memoryProjectKey(nested)).toBe(before);
});


test("explicit project isolation ignores inherited Git routing while the default preserves it", () => {
  const dir=mkdtempSync(join(tmpdir(),"amem-project-isolated-"));cleanup.push(dir);
  const a=join(dir,"alpha"),b=join(dir,"beta");for(const cwd of [a,b]){mkdirSync(cwd);git(cwd,["init","-q"]);}
  const keyA=memoryProjectKey(a),keyB=memoryProjectKey(b);
  const names=["GIT_DIR","GIT_WORK_TREE","GIT_COMMON_DIR"] as const;
  const previous=names.map(name=>[name,process.env[name]] as const);
  try {
    process.env.GIT_DIR=join(b,".git");process.env.GIT_COMMON_DIR=join(b,".git");process.env.GIT_WORK_TREE=b;
    expect(memoryProjectKey(a)).toBe(keyB);expect(projectChain(a)).toEqual(["beta"]);
    expect(memoryProjectKey(a,{repositoryIsolation:true})).toBe(keyA);expect(projectChain(a,{repositoryIsolation:true})).toEqual(["alpha"]);
    git(b,["remote","add","origin","https://github.com/fixture/foreign"]);
    expect(memoryProjectKey(a)).toBe("github.com/fixture/foreign");expect(memoryProjectKey(a,{repositoryIsolation:true})).toBe(keyA);
  } finally {for(const [name,value] of previous){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});
