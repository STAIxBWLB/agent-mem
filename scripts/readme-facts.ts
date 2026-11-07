// Renders the README's mechanical facts between `<!-- facts:<name> -->` and `<!-- /facts:<name> -->` from this package's
// own sources. `bun scripts/readme-facts.ts` exits 1 when a block differs; `--write` rewrites the blocks. No network.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MCP_TOOLS } from "../src/mcp.ts";

const root = resolve(import.meta.dir, "..");
const readmePath = resolve(root, "README.md");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version: string; engines: { bun: string }; dependencies?: Record<string, string>; devDependencies: Record<string, string>;
};

const bunFloor = /^>=(\S+)$/.exec(pkg.engines.bun)?.[1];
if (!bunFloor) throw new Error(`readme-facts: package.json engines.bun must be ">=<version>", found ${pkg.engines.bun}`);
const console_ = pkg.devDependencies["@staix/agent-console"];
if (!console_) throw new Error("readme-facts: package.json devDependencies has no @staix/agent-console pin");
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
const firstSentence = (text: string) => /^.*?\.(?=\s|$)/.exec(text)?.[0] ?? text;

const facts: Record<string, string> = {
  version: `Version: ${pkg.version}. Requires Bun ${bunFloor} or later; ${runtimeDeps.length ? `runtime dependencies: ${runtimeDeps.join(", ")}` : "no runtime dependencies"}.`,
  "console-pin": `\`@staix/agent-console\` ${console_}`,
  "mcp-tools": [
    `${MCP_TOOLS.length} tools, generated from \`MCP_TOOLS\` in \`src/mcp.ts\`:`,
    "",
    "| Tool | Read-only | Purpose |",
    "| --- | --- | --- |",
    ...MCP_TOOLS.map((t) => `| \`${t.name}\` | ${t.annotations.readOnlyHint ? "yes" : "no"} | ${firstSentence(t.description).replaceAll("|", "\\|")} |`),
  ].join("\n"),
};

const readme = readFileSync(readmePath, "utf8");
const seen = new Set<string>();
const drift: string[] = [];
const diff: string[] = [];
// A block on one line stays inline; a block on its own lines keeps its content on separate lines.
const next = readme.replace(/<!-- facts:([\w-]+) -->([\s\S]*?)<!-- \/facts:\1 -->/g, (_all, name: string, body: string) => {
  const fact = facts[name];
  if (fact === undefined) throw new Error(`readme-facts: README.md has an unknown block facts:${name}; add it to scripts/readme-facts.ts or remove the markers`);
  seen.add(name);
  const rendered = body.includes("\n") ? `\n${fact}\n` : fact;
  if (rendered !== body) {
    drift.push(name);
    const was = body.split("\n"), now = rendered.split("\n");
    diff.push(`facts:${name}`, ...was.filter((l) => !now.includes(l)).map((l) => `- ${l}`), ...now.filter((l) => !was.includes(l)).map((l) => `+ ${l}`));
  }
  return `<!-- facts:${name} -->${rendered}<!-- /facts:${name} -->`;
});
const missing = Object.keys(facts).filter((name) => !seen.has(name));
if (missing.length) throw new Error(`readme-facts: README.md lacks the blocks ${missing.join(", ")}; restore their <!-- facts:<name> --> markers`);

if (process.argv.includes("--write")) {
  if (drift.length) writeFileSync(readmePath, next);
  console.log(drift.length ? `readme-facts: rewrote ${drift.join(", ")}` : "readme-facts: OK");
} else if (drift.length) {
  console.error(diff.join("\n"));
  console.error(`readme-facts: README.md blocks differ from their sources: ${drift.join(", ")}. Run \`bun scripts/readme-facts.ts --write\` and commit README.md.`);
  process.exitCode = 1;
} else console.log("readme-facts: OK");
