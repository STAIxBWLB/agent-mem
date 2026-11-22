import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/memory/platform.ts";
import { exportSkills, installSkills, SKILL_NAMES, skillRoot } from "../src/skills-install.ts";

const dirs: string[] = [];
function fixture() {
  const base = mkdtempSync(join(realPath(tmpdir()), "amem-skills-")); dirs.push(base);
  const pkg = join(base, "package"), root = join(base, "home", "skills");
  mkdirSync(join(pkg, "skills", "_shared"), { recursive: true });
  writeFileSync(join(pkg, "skills", "_shared", "amem-adapter.md"), "adapter");
  for (const name of SKILL_NAMES) { mkdirSync(join(pkg, "skills", name)); writeFileSync(join(pkg, "skills", name, "SKILL.md"), name); }
  return { base, pkg, root };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("skill installer", () => {
  test("preview, apply, version and content replacement, undo", () => {
    const { pkg, root } = fixture();
    expect(installSkills(root, "preview", pkg, "1").actions.every(a => a.change === "install")).toBe(true);
    expect(() => readdirSync(root)).toThrow();
    expect(installSkills(root, "apply", pkg, "1").actions.every(a => a.change === "install")).toBe(true);
    expect(readFileSync(join(root, SKILL_NAMES[0], "references", "amem-adapter.md"), "utf8")).toBe("adapter");
    expect(installSkills(root, "apply", pkg, "1").actions.every(a => a.change === "unchanged")).toBe(true);
    expect(installSkills(root, "apply", pkg, "2").actions.every(a => a.change === "replace")).toBe(true);
    writeFileSync(join(pkg, "skills", SKILL_NAMES[0], "SKILL.md"), "changed");
    expect(installSkills(root, "apply", pkg, "2").actions[0]?.change).toBe("replace");
    expect(installSkills(root, "undo").actions.every(a => a.change === "remove")).toBe(true);
    expect(installSkills(root, "undo").actions.every(a => a.change === "absent")).toBe(true);
  });
  test("preserves foreign and modified trees including empty directories", () => {
    const { pkg, root } = fixture(); installSkills(root, "apply", pkg, "1");
    writeFileSync(join(root, SKILL_NAMES[0], "SKILL.md"), "local");
    mkdirSync(join(root, SKILL_NAMES[1], "empty"));
    rmSync(join(root, SKILL_NAMES[2], ".amem-skill.json"));
    const actions = installSkills(root, "undo").actions;
    expect(actions.slice(0, 3).map(a => a.change)).toEqual(["modified", "modified", "foreign"]);
    expect(readFileSync(join(root, SKILL_NAMES[0], "SKILL.md"), "utf8")).toBe("local");
  });
  test("recovers a verified interrupted backup and export rejects foreign entries", () => {
    const { pkg, root } = fixture(); installSkills(root, "apply", pkg, "1");
    renameSync(join(root, SKILL_NAMES[0]), join(root, `.amem-skill-${SKILL_NAMES[0]}-backup-interrupted`));
    expect(exportSkills(root, { packageRoot: pkg, packageVersion: "2" }).actions[0]?.change).toBe("replace");
    writeFileSync(join(root, "foreign"), "data");
    expect(exportSkills(root, { packageRoot: pkg, packageVersion: "2" }).actions.every(a => a.change === "refused")).toBe(true);
    expect(exportSkills(" ").actions[0]?.change).toBe("refused");
  });
  test("restores the backup when post-swap verification fails", () => {
    const { pkg, root } = fixture(); installSkills(root, "apply", pkg, "1");
    const original = fs.renameSync, target = join(root, SKILL_NAMES[0]);
    let injected = false;
    const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      original(from, to);
      if (!injected && String(from).includes("-stage-") && String(to) === target) {
        injected = true;
        const originalRead = fs.readFileSync;
        const reader = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
          if (String(args[0]) === join(target, ".amem-skill.json")) { reader.mockRestore(); throw new Error("injected verification failure"); }
          return originalRead(...args);
        }) as typeof fs.readFileSync);
      }
    }) as typeof fs.renameSync);
    try {
      expect(installSkills(root, "apply", pkg, "2").actions[0]?.change).toBe("refused");
      expect(JSON.parse(readFileSync(join(target, ".amem-skill.json"), "utf8")).version).toBe("1");
    } finally { spy.mockRestore(); }
  });
  test("refuses symlinks and oversized packaged files", () => {
    const { pkg, root, base } = fixture();
    rmSync(join(pkg, "skills", SKILL_NAMES[0], "SKILL.md"));
    symlinkSync(join(pkg, "skills", "_shared", "amem-adapter.md"), join(pkg, "skills", SKILL_NAMES[0], "SKILL.md"));
    writeFileSync(join(pkg, "skills", SKILL_NAMES[1], "SKILL.md"), Buffer.alloc(1024 * 1024 + 1));
    expect(spawnSync("mkfifo", [join(pkg, "skills", SKILL_NAMES[2], "pipe")]).status).toBe(0);
    expect(installSkills(root, "preview", pkg, "1").actions.slice(0, 3).map(a => a.change)).toEqual(["refused", "refused", "refused"]);
    symlinkSync(base, join(base, "link"));
    expect(exportSkills(join(base, "link", "output"), { packageRoot: pkg, packageVersion: "1" }).actions[0]?.change).toBe("refused");
  });
  test("host roots share setup resolution and Orca redirect", () => {
    const { base } = fixture();
    const env = { HOME: base, QWEN_HOME: "~/qwen", CODEX_HOME: join(base, "Library/Application Support/orca/codex-accounts/id/home") };
    expect(skillRoot("claude", env, base)).toBe(join(base, ".claude/skills"));
    expect(skillRoot("codex", env, base)).toBe(join(base, ".codex/skills"));
    expect(skillRoot("kimi", env, base)).toBe(join(base, ".kimi-code/skills"));
    expect(skillRoot("qwen", env, base)).toBe(join(base, "qwen/skills"));
    for (const target of ["pi", "jcode", "opencode", "gemini", "agy"] as const) expect(skillRoot(target, env, base)).toBeUndefined();
  });
});
