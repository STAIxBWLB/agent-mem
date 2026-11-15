import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { readFormatFloors } from "../src/memory/formats.ts";
import { runningAmemRoots, versionBelow } from "../src/memory/formats-raise.ts";

const cleanup: (() => void)[] = [], savedHome = process.env.AMEM_HOME;
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); if (savedHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = savedHome; });
const own = join(import.meta.dir, ".."), ownVersion = (JSON.parse(readFileSync(join(own, "package.json"), "utf8")) as { version: string }).version;
function rig() {
  const root = mkdtempSync(join(tmpdir(), "amem-formats-raise-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "memory"); mkdirSync(home, { mode: 0o700 }); process.env.AMEM_HOME = home;
  const install = (version: string) => { const dir = join(root, `amem-${version}`); mkdirSync(join(dir, "bin"), { recursive: true }); writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version })); return dir; };
  const context = (table = "", marked = true) => ({ cwd: root, env: { HOME: root, AMEM_HOME: home, ...(marked ? { CLAUDECODE: "1" } : {}) }, stdinTTY: false, stdoutTTY: false,
    processTable: () => table, now: () => Date.parse("2026-11-16T03:00:00Z") });
  return { root, home, install, context };
}
const [major, minor] = ownVersion.split(".").map(Number);
const floor = `${major}.${minor}.0`, above = `${major}.${minor! + 1}.0`;

test("#431 AC6: an agent-marked preview names the record and the writers; --confirm appends exactly that record", async () => {
  const r = rig(), current = r.install(ownVersion);
  const table = `  4242 bun ${join(current, "bin", "amem.js")} mcp\n  4243 /usr/bin/vim notes.txt\n`;
  const preview = JSON.parse(await runCli(["formats", "raise", "curated", floor, "--json"], r.context(table)));
  expect(preview.record).toEqual({ surface: "curated", minReader: floor, since: "2026-11-16" });
  expect(preview.writers.map((w: { source: string }) => w.source).sort()).toEqual(["running", "self"]);
  expect(preview.refusal).toBeNull(); expect(existsSync(join(r.home, "formats.json"))).toBe(false);
  expect(await runCli(["formats", "raise", "curated", floor, "--confirm"], r.context(table))).toContain(`appended {"surface":"curated","minReader":"${floor}","since":"2026-11-16"}`);
  expect(readFormatFloors(r.home)).toEqual([{ surface: "curated", minReader: floor, since: "2026-11-16" }]);
  // Append-only: a second surface keeps the first record, and the same or a lower floor is refused as nothing to raise.
  await runCli(["formats", "raise", "capture", floor, "--confirm"], r.context(table));
  expect(readFormatFloors(r.home)!.map(row => row.surface)).toEqual(["curated", "capture"]);
  await expect(runCli(["formats", "raise", "curated", floor, "--confirm"], r.context(table, false))).rejects.toThrow("nothing to raise");
});

test("#431 AC6: a raise refuses while a running writer or this install is below the floor, and names it", async () => {
  const r = rig(), old = r.install("0.20.0");
  const table = `  777 bun ${join(old, "bin", "amem.js")} hook session-start\n`;
  const preview = await runCli(["formats", "raise", "home", floor], r.context(table, false));
  expect(preview).toContain(`refused: writers below ${floor}: running ${old} (pid 777) at 0.20.0`);
  await expect(runCli(["formats", "raise", "home", floor, "--confirm"], r.context(table, false))).rejects.toThrow(`running ${old} (pid 777) at 0.20.0`);
  await expect(runCli(["formats", "raise", "home", above, "--confirm"], r.context("", false))).rejects.toThrow(`self ${own}`);
  expect(existsSync(join(r.home, "formats.json"))).toBe(false);
});

test("#431 AC6: a running writer whose install cannot be read counts as below; bad input is refused", async () => {
  const r = rig(), table = `  91 bun ${join(r.root, "gone", "bin", "amem.js")} mcp\n`;
  await expect(runCli(["formats", "raise", "sync", floor, "--confirm"], r.context(table, false))).rejects.toThrow("at unknown version");
  await expect(runCli(["formats", "raise", "nope", floor], r.context("", false))).rejects.toThrow();
  await expect(runCli(["formats", "raise", "sync", "latest"], r.context("", false))).rejects.toThrow("plain release version");
  expect(runningAmemRoots(() => " 1 bun /a/b/bin/amem.js mcp\n 2 bun /c/src/cli.ts\n 3 ls -la\n").map(row => row.root)).toEqual(["/a/b", "/c"]);
  expect(versionBelow("0.26.3", "0.27.0")).toBe(true); expect(versionBelow("0.27.0", "0.27.0")).toBe(false);
});
