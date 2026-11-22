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
    expect(actions[1]?.reason).toContain("empty directory: empty");
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
    const actions = installSkills(root, "preview", pkg, "1").actions;
    expect(actions.slice(0, 3).map(a => a.change)).toEqual(["refused", "refused", "refused"]);
    expect(actions[0]?.reason).toContain("symlink refused: SKILL.md");
    expect(actions[1]?.reason).toContain("skill file size limit 1048576 bytes exceeded: SKILL.md");
    expect(actions[2]?.reason).toContain("non-regular file refused: pipe");

  });
  test("tree errors identify nested paths, root and file count limits", () => {
    const { pkg, root } = fixture(), first = join(pkg, "skills", SKILL_NAMES[0]), second = join(pkg, "skills", SKILL_NAMES[1]), third = join(pkg, "skills", SKILL_NAMES[2]);
    mkdirSync(join(first, "nested", "empty"), { recursive: true });
    rmSync(second, { recursive: true }); writeFileSync(second, "not a directory");
    for (let i = 0; i < 256; i++) writeFileSync(join(third, `entry-${String(i).padStart(3, "0")}`), "x");
    const actions = installSkills(root, "preview", pkg, "1").actions;
    expect(actions[0]?.reason).toContain("empty directory: nested/empty");
    expect(actions[1]?.reason).toContain("not a real directory: .");
    expect(actions[2]?.reason).toContain("skill file count limit 256 exceeded: entry-255");
  });
  test("modified owned trees report the unsafe relative path and remain intact", () => {
    const { pkg, root, base } = fixture(); installSkills(root, "apply", pkg, "1");
    const path = join(root, SKILL_NAMES[0], "references", "extra-link"); symlinkSync(join(base, "missing"), path);
    const action = installSkills(root, "undo").actions[0];
    expect(action?.change).toBe("modified"); expect(action?.reason).toContain("symlink refused: references/extra-link");
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
  });
  test("linked ancestors and roots work while linked skill targets are refused", () => {
    const { base, pkg, root } = fixture();
    const link = join(base, "link"); symlinkSync(base, link);
    expect(exportSkills(join(link, "output"), { packageRoot: join(link, "package"), packageVersion: "1" }).actions.every(a => a.change === "install")).toBe(true);
    const linkedRoot = join(base, "linked-root"); symlinkSync(join(base, "output"), linkedRoot);
    const report = exportSkills(linkedRoot, { packageRoot: pkg, packageVersion: "1" });
    expect(report.linkedFrom).toBe(linkedRoot); expect(report.root).toBe(join(base, "output"));
    expect(report.actions.every(a => a.change === "unchanged")).toBe(true);
    mkdirSync(root, { recursive: true }); symlinkSync(join(base, "output", SKILL_NAMES[0]), join(root, SKILL_NAMES[0]));
    const foreign = installSkills(root, "apply", pkg, "1").actions[0];
    expect(foreign?.change).toBe("foreign"); expect(foreign?.reason).toContain("symlink"); expect(foreign?.reason).toContain("move it aside");
  });
  test("linked root installs, re-applies and undoes without touching the link or foreign skills", () => {
    const { base, pkg } = fixture(), target = join(base, "shared"), link = join(base, "skills-link"), env = { AMEM_HOME: join(base, "memory") };
    mkdirSync(target); mkdirSync(join(target, "other-tool")); symlinkSync(target, link);
    const preview = installSkills(link, "preview", pkg, "1", undefined, env);
    expect(preview.root).toBe(target); expect(preview.linkedFrom).toBe(link); expect(readdirSync(target)).toEqual(["other-tool"]);
    expect(installSkills(link, "apply", pkg, "1", undefined, env).actions.every(a => a.change === "install")).toBe(true);
    expect(installSkills(link, "apply", pkg, "1", undefined, env).actions.every(a => a.change === "unchanged")).toBe(true);
    expect(installSkills(link, "undo", pkg, "1", undefined, env).actions.every(a => a.change === "remove")).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true); expect(readdirSync(target)).toEqual(["other-tool"]);
  });
  test("retargeting during staging refuses before swap and never writes the new target", () => {
    const { base, pkg } = fixture(), first = join(base, "first"), second = join(base, "second"), link = join(base, "link"), env = { AMEM_HOME: join(base, "memory") };
    mkdirSync(first); mkdirSync(second); symlinkSync(first, link);
    const original = fs.writeFileSync; let swapped = false;
    const spy = spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      original(file, data, options);
      if (!swapped && String(file).includes("-stage-") && String(file).endsWith(".amem-skill.json")) { swapped = true; rmSync(link); symlinkSync(second, link); }
    }) as typeof fs.writeFileSync);
    try {
      const report = installSkills(link, "apply", pkg, "1", undefined, env);
      expect(swapped).toBe(true); expect(report.actions.every(a => a.change === "refused")).toBe(true);
      expect(readdirSync(second)).toEqual([]); expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    } finally { spy.mockRestore(); }
  });
  test("unsafe linked roots identify link, target and recovery", () => {
    const { base, pkg } = fixture(), memory = join(base, "memory"), env = { AMEM_HOME: memory };
    mkdirSync(memory); const file = join(base, "file"); writeFileSync(file, "x");
    for (const [name, target] of [["missing", join(base, "missing")], ["file-link", file], ["memory-link", memory], ["source-link", join(pkg, "skills")]]) {
      const link = join(base, name!); symlinkSync(target!, link);
      const result = installSkills(link, "apply", pkg, "1", undefined, env);
      expect(result.actions.every(a => a.change === "refused")).toBe(true);
      expect(result.actions[0]?.reason).toContain(link); expect(result.actions[0]?.reason).toContain(target!); expect(result.actions[0]?.reason).toContain("retry");
      expect(exportSkills(link, { packageRoot: pkg, packageVersion: "1", env }).actions[0]?.change).toBe("refused");
    }
  });
  test("preview of installed skills is read-only", () => {
    const { pkg, root } = fixture(); installSkills(root, "apply", pkg, "1");
    const marker = join(root, SKILL_NAMES[0], ".amem-skill.json");
    const before = fs.statSync(marker); const bytes = readFileSync(marker);
    expect(installSkills(root, "preview", pkg, "2").actions.every(a => a.change === "replace")).toBe(true);
    expect(readFileSync(marker)).toEqual(bytes); expect(fs.statSync(marker).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(root).sort()).toEqual([...SKILL_NAMES].sort());
  });
  test("unverified interrupted stage identifies the leftover and recovery action", () => {
    const { pkg, root } = fixture(); mkdirSync(root, { recursive: true });
    const stage = join(root, `.amem-skill-${SKILL_NAMES[0]}-stage-incomplete`); mkdirSync(stage);
    const action = installSkills(root, "apply", pkg, "1").actions[0];
    expect(action?.change).toBe("refused"); expect(action?.reason).toContain(stage); expect(action?.reason).toContain("remove");
    const exportAction = exportSkills(root, { packageRoot: pkg, packageVersion: "1" }).actions[0];
    expect(exportAction?.reason).toContain(stage); expect(exportAction?.reason).toContain("remove");
  });
  test("verified leftover kind is determined from the entry name", () => {
    const { pkg, base } = fixture(); const root = join(base, "stage-backup-container");
    installSkills(root, "apply", pkg, "1");
    renameSync(join(root, SKILL_NAMES[0]), join(root, `.amem-skill-${SKILL_NAMES[0]}-backup-test`));
    expect(installSkills(root, "apply", pkg, "2").actions[0]?.change).toBe("replace");
  });
  test("backup removal failure keeps the verified replacement", () => {
    const { pkg, root } = fixture(); installSkills(root, "apply", pkg, "1");
    const original = fs.rmSync; let injected = false;
    const spy = spyOn(fs, "rmSync").mockImplementation(((path: fs.PathLike, options?: fs.RmOptions) => {
      if (!injected && String(path).includes(`.amem-skill-${SKILL_NAMES[0]}-backup-`)) { injected = true; throw new Error("removal failure"); }
      return original(path, options);
    }) as typeof fs.rmSync);
    try {
      const action = installSkills(root, "apply", pkg, "2").actions[0];
      expect(action?.change).toBe("refused"); expect(action?.reason).toContain("backup removal failed");
      expect(JSON.parse(readFileSync(join(root, SKILL_NAMES[0], ".amem-skill.json"), "utf8")).version).toBe("2");
    } finally { spy.mockRestore(); }
  });
  test("host roots share setup resolution and Orca redirect", () => {
    const { base } = fixture();
    const env = { HOME: base, QWEN_HOME: "~/qwen", CODEX_HOME: join(base, "Library/Application Support/orca/codex-accounts/id/home") };
    expect(skillRoot("claude", env, base)).toBe(join(base, ".claude/skills"));
    expect(skillRoot("claude", { ...env, CLAUDE_CONFIG_DIR: join(base, "Library/Application Support/orca/claude-profiles/id/home") }, base)).toBe(join(base, ".claude/skills"));
    expect(skillRoot("codex", env, base)).toBe(join(base, ".codex/skills"));
    expect(skillRoot("kimi", env, base)).toBe(join(base, ".kimi-code/skills"));
    expect(skillRoot("qwen", env, base)).toBe(join(base, "qwen/skills"));
    for (const target of ["pi", "jcode", "opencode", "gemini", "agy"] as const) expect(skillRoot(target, env, base)).toBeUndefined();
  });
});

test("CLI exports skills and reports exit status for an untouched foreign destination", async () => {
  const { base } = fixture();
  const { runCli } = await import("../src/cli.ts");
  const out = join(base, "export");
  const report = JSON.parse(await runCli(["skills", "export", out, "--json"], { cwd: base }));
  expect(report.actions.every((row: { change: string }) => row.change === "install")).toBe(true);
  writeFileSync(join(out, "foreign"), "x"); let code = 0;
  const refused = JSON.parse(await runCli(["skills", "export", out, "--json"], { cwd: base, onExitCode: n => { code = n; } }));
  expect(code).toBe(1); expect(refused.actions.every((row: { change: string }) => row.change === "refused")).toBe(true);
});

test("export appears in manifest and completion and its refusal exits nonzero", async () => {
  const { base } = fixture();
  const { runCli } = await import("../src/cli.ts");
  expect(JSON.parse(await runCli(["manifest", "--json"])).commands).toContain("skills");
  expect(await runCli(["--help"])).toContain("skills");
  for (const shell of ["zsh", "bash", "fish"]) expect(await runCli(["completion", shell])).toContain("export");
  const root = join(base, "foreign"); mkdirSync(root); writeFileSync(join(root, "user-file"), "kept");
  const cli = join(import.meta.dir, "../bin/amem.js");
  const result = spawnSync(process.execPath, [cli, "skills", "export", root, "--json"], { env: { ...process.env, HOME: base, AMEM_HOME: join(base, "memory"), AGENTHUB_PEER_ID: "fixture" }, encoding: "utf8" });
  expect(result.status).toBe(1); expect(JSON.parse(result.stdout).actions[0].change).toBe("refused");
  expect(readFileSync(join(root, "user-file"), "utf8")).toBe("kept");
});
