import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { realPath } from "../src/memory/platform.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const name of ["ordinary", "back\\slash"]) {
  for (const target of ["absolute", "relative"]) {
    test(`realPath resolves '..' after a ${target} symlink target under ${name}`, () => {
      const temp = mkdtempSync(join(tmpdir(), "amem-realpath-"));
      roots.push(temp);
      const root = join(realPath(temp), name);
      mkdirSync(join(root, "d", "e"), { recursive: true });
      symlinkSync(target === "absolute" ? join(root, "d", "e") : join("d", "e"), join(root, "dl"));
      expect(realPath(`${root}/dl/..`)).toBe(join(root, "d"));
      const input = `${relative(process.cwd(), root)}/dl/..`;
      expect(realPath(input)).toBe(join(root, "d"));
      expect(realPath(relative(process.cwd(), join(root, "d", "e")))).toBe(join(root, "d", "e"));
    });
  }

  test(`realPath refuses missing and dangling paths before '..' under ${name}`, () => {
    const temp = mkdtempSync(join(tmpdir(), "amem-realpath-"));
    roots.push(temp);
    const root = join(realPath(temp), name);
    mkdirSync(root);
    symlinkSync(join(root, "missing"), join(root, "dangling"));
    expect(() => realPath(`${root}/missing/..`)).toThrow();
    expect(() => realPath(`${root}/dangling/..`)).toThrow();
  });
}
