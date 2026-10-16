import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// `@staix/agent-mem/platform` is loaded by Node hosts (agent-hub's Pi extension): it may import node: built-ins only.
test("the platform subpath imports only node: built-ins and is exported", () => {
  const source = readFileSync(new URL("../src/memory/platform.ts", import.meta.url), "utf8");
  const specs = [...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)/g)].map(m => m[1] ?? m[2]);
  expect(specs.length).toBeGreaterThan(0);
  expect(specs.filter(s => !s!.startsWith("node:"))).toEqual([]);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.exports["./platform"]).toBe("./src/memory/platform.ts");
});
