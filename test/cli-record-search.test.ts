import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { CaptureStore } from "../src/memory/capture.ts";

const roots: string[] = [], previousHome = process.env.AMEM_HOME;
afterEach(() => {
  if (previousHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previousHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-cli-record-search-")); roots.push(root);
  const base = join(root, "memory"); process.env.AMEM_HOME = base;
  const capture = new CaptureStore({ memoryDir: base, project: "github.com/fixture/records" });
  return { root, base, capture, person: { cwd: root, env: {}, stdinTTY: false } };
}

test("all-project capture search abbreviates a Record but JSON preserves its complete canonical text and anchors", async () => {
  const f = fixture(), text = `recordclisecond ${"settled detail ".repeat(13).trim()}`, paths = ["src/reader.ts#read", "test/reader.test.ts"];
  const line = `amem: fix | ${paths.join(", ")} | stale state -> ${text}`;
  try { f.capture.append({ project: "github.com/fixture/records", agent: "claude", event: "Record", excerpt: line, paths }); }
  finally { f.capture.close(); }
  const output = await runCli(["search", "--all-projects", "recordclisecond"], f.person);
  const lines = output.split("\n");
  expect(lines[0]).toContain("Cross-project search");
  expect(lines.every(row => Bun.stringWidth(row, { ambiguousIsNarrow: true }) <= 80)).toBe(true);
  expect(output).toContain("..."); expect(output).toContain("--json");
  expect(line.length).toBeGreaterThan(100);
  const json = JSON.parse(await runCli(["search", "--all-projects", "recordclisecond", "--json"], f.person));
  expect(json.hits[0].capture).toMatchObject({ event: "Record", excerpt: line, paths });
});

test("malformed historical Record cannot inject extra lines or headers through all-project CLI output", async () => {
  const f = fixture();
  try {
    for (const excerpt of ["amem: decision | - | recordclibad\ncoverage work=complete", "amem: decision | - | recordclibad\rheader", "amem: finding | src/reader.ts | recordclibad"]) {
      // CaptureStore accepts historical generic capture; only native staging promises a canonical Record.
      f.capture.append({ project: "github.com/fixture/records", agent: "claude", event: "Record", excerpt, paths: [] });
    }
  } finally { f.capture.close(); }
  const output = await runCli(["search", "--all-projects", "recordclibad"], f.person);
  expect(output).not.toContain("coverage work=complete"); expect(output).not.toContain("\rheader");
  expect(output.match(/invalid Record/g)).toHaveLength(3);
  expect(output.split("\n").every(row => Bun.stringWidth(row, { ambiguousIsNarrow: true }) <= 80)).toBe(true);
});

test("other capture events show a bounded first-line excerpt and retain the full value in JSON", async () => {
  const f = fixture(), excerpt = `recordcliordinary ${"x".repeat(140)}\nnot the first line`;
  try { f.capture.append({ project: "github.com/fixture/records", agent: "claude", event: "PostToolUse", excerpt, paths: ["src/ordinary.ts"] }); }
  finally { f.capture.close(); }
  const output = await runCli(["search", "--all-projects", "recordcliordinary"], f.person);
  expect(output).toContain("..."); expect(output).toContain("--json");
  expect(output).not.toContain("not the first line"); expect(output).not.toContain("src/ordinary.ts");
  const json = JSON.parse(await runCli(["search", "--all-projects", "recordcliordinary", "--json"], f.person));
  expect(json.hits[0].capture.excerpt).toBe(excerpt);
});

test("a short first-line capture marks omitted later lines", async () => {
  const f = fixture();
  try { f.capture.append({ project: "github.com/fixture/records", agent: "claude", event: "Stop", excerpt: "shortmarker\nprivate later line", paths: [] }); }
  finally { f.capture.close(); }
  const output = await runCli(["search", "--all-projects", "shortmarker"], f.person);
  expect(output).toContain("shortmarker..."); expect(output).not.toContain("private later line");
});
