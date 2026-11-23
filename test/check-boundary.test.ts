import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { dependencyReach } from "../scripts/boundary-graph.ts";
import { realPath } from "../src/memory/platform.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Builds a throwaway src/ tree from relative path -> source text. */
function tree(files: Record<string, string>): string {
  const dir = realPath(mkdtempSync(join(tmpdir(), "amem-boundary-")));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return dir;
}
const WRITER = 'import { writeFileSync } from "node:fs";\nexport function save(): void { writeFileSync("x", "y"); }\n';

describe("write-path dependency reach (#592)", () => {
  test("a writer importing a runtime package directly fails", () => {
    const src = tree({ "memory/store.ts": `import { Report } from "@staix/cli-output";\n${WRITER}export const r = Report;\n` });
    const reach = dependencyReach(src);
    expect(reach.roots).toBe(1);
    expect(reach.chains).toEqual([["memory/store.ts", "@staix/cli-output"]]);
    expect(reach.failures[0]).toContain("src/memory/store.ts reaches @staix/cli-output");
    expect(reach.failures[0]).toContain("#592");
  });

  test("a writer reaching the package through a presentation module fails and names the chain", () => {
    const src = tree({
      "memory/store.ts": `import { show } from "./show.ts";\n${WRITER}export const s = show;\n`,
      "memory/show.ts": 'import { Report } from "@staix/cli-output";\nexport const show = Report;\n',
    });
    const reach = dependencyReach(src);
    expect(reach.chains).toEqual([["memory/store.ts", "memory/show.ts", "@staix/cli-output"]]);
    expect(reach.failures[0]).toContain("memory/store.ts -> memory/show.ts -> @staix/cli-output");
  });

  test("a type-only import does not count as reach", () => {
    const src = tree({
      "memory/store.ts": `import type { Shown } from "./show.ts";\nimport { type Other } from "./show.ts";\n${WRITER}export type S = Shown | Other;\n`,
      "memory/show.ts": 'import { Report } from "@staix/cli-output";\nexport type Shown = Report;\nexport type Other = string;\n',
    });
    expect(dependencyReach(src)).toEqual({ roots: 1, failures: [], chains: [] });
  });

  test("a presentation module that writes nothing may import the package", () => {
    const src = tree({
      "memory/store-text.ts": 'import { Report } from "@staix/cli-output";\nexport const text = Report;\n',
      "memory/store.ts": WRITER,
      "cli.ts": 'import { writeFileSync } from "node:fs";\nimport { text } from "./memory/store-text.ts";\nwriteFileSync("x", String(text));\n',
    });
    expect(dependencyReach(src)).toEqual({ roots: 1, failures: [], chains: [] });
  });

  test.each([
    ["memory/pending.ts", 'import { Database } from "bun:sqlite";\nexport const open = (p: string) => new Database(p).run("UPDATE t SET shown_at = 1");\n'],
    ["memory/aliased.ts", 'import { writeFileSync as write } from "node:fs";\nexport const save = () => write("x", "y");\n'],
    ["memory/namespace.ts", 'import * as fs from "node:fs/promises";\nexport const save = () => fs.writeFile("x", "y");\n'],
    ["memory/bunwrite.ts", 'export const save = () => Bun.write("x", "y");\n'],
    ["sync-placement-writer-context.ts", 'export const decide = () => true;\n'],
  ])("%s is a write-path root however it writes or decides", (name, body) => {
    const src = tree({ [name]: `import { Report } from "@staix/cli-output";\n${body}export const r = Report;\n` });
    const reach = dependencyReach(src);
    expect(reach.roots).toBe(1);
    expect(reach.chains).toEqual([[name, "@staix/cli-output"]]);
  });

  test.each([
    ["memory/pure.ts", 'import { join } from "node:path";\nexport const at = join("a", "b");\n'],
    ["memory/typed.ts", 'import type { Stats } from "node:fs";\nimport type { Database } from "bun:sqlite";\nexport type T = Stats | Database;\n'],
    ["sync-placement-progress.ts", 'export const step = 1;\n'],
    ["cli-writer.ts", 'import { writeFileSync } from "node:fs";\nexport const save = () => writeFileSync("x", "y");\n'],
  ])("%s is not a root and may import the package", (name, body) => {
    const src = tree({ [name]: `import { Report } from "@staix/cli-output";\n${body}export const r = Report;\n` });
    expect(dependencyReach(src)).toEqual({ roots: 0, failures: [], chains: [] });
  });

  test("the real source tree keeps every write-path root off runtime dependencies", () => {
    const reach = dependencyReach(realPath(resolve(import.meta.dir, "../src")));
    expect(reach.roots).toBeGreaterThan(50);
    expect(reach.failures).toEqual([]);
  });
});
