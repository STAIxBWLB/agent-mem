import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAmemCommand } from "../src/commands-table.ts";
import * as r from "../src/memory/report-text.ts";
import { PLAIN, style } from "../src/memory/style.ts";
import { migrationText } from "../src/memory/migrate.ts";
import { pruneText } from "../src/memory/prune.ts";
import { usageText } from "../src/memory/usage.ts";
import { vaultCandidatesText } from "../src/memory/vault.ts";
import * as f from "./report-renderers-fixtures.ts";

// #590 task 429: color-off 80-column ASCII goldens for every remaining report family (AC8), and the content rules (AC9).
const o = { columns: 80 }, ASCII = style(false, true);
const families = (s = PLAIN): Record<string, string> => ({
  migrate: r.migrateReportText(f.migration, s, o), "migrate-shards": r.shardMigrateReportText(f.shardMigration, s, o),
  prune: r.pruneReportText(f.prune, s, o), "prune-applied": r.pruneReportText({ completed: ["a".repeat(32)] }, s, o),
  decay: r.decayReportText({ kind: "preview", plan: f.decay, action: "demote" }, s, o), "decay-empty": r.decayReportText({ kind: "empty" }, s, o),
  "decay-applied": r.decayReportText({ kind: "applied", action: "demote", ids: ["x", "y"], expiresAt: "2026-12-23" }, s, o),
  "spool-replay": r.spoolReplayReportText(f.replay, s, o), sync: r.syncReportText(f.sync, s, o), "sync-status": r.syncStatusReportText(f.syncStatus, f.NOW, s, o),
  projects: r.projectsReportText(f.projects, true, s, o), usage: r.usageReportText(f.usage, s, o), "repo-status": r.repoStatusReportText(f.repoStatus, "repo@1234abcd", s, o),
  vault: r.vaultReportText(f.vault, false, s, o), "vault-all": r.vaultReportText(f.vault, true, s, o),
});
const golden = (name: string) => join(import.meta.dir, "fixtures/report-renderers", `${name}.txt`);

test("#590 task 429: 80-column ASCII goldens per report family, color off", () => {
  for (const [name, text] of Object.entries(families(ASCII))) {
    if (process.env.UPDATE_GOLDENS === "1") writeFileSync(golden(name), text + "\n");
    expect(text + "\n", name).toBe(readFileSync(golden(name), "utf8"));
  }
});

test("#590 task 429: content rules hold for every family, glyph and ASCII", () => {
  for (const s of [PLAIN, ASCII]) for (const [name, text] of Object.entries(families(s))) {
    const lines = text.split("\n");
    expect(lines[0], name).toMatch(/^ amem [A-Z]/);
    expect(text, name).not.toMatch(/\x1b\[/);
    for (const line of lines) {
      expect(Bun.stringWidth(line, { ambiguousIsNarrow: true }), `${name}: ${line}`).toBeLessThanOrEqual(80);
      expect(line, `${name}: JSON`).not.toMatch(/[{}]|":/);
      expect(line, `${name}: Next action`).not.toMatch(/Next actions?:/);
      expect(line, `${name}: backtick`).not.toContain("`");
    }
    for (const line of lines.filter(line => /^ +(->|→) /.test(line))) expect(isAmemCommand(line.replace(/^ +(->|→) +/, "")), `${name}: ${line}`).toBe(true);
  }
  // The wide-character title wraps under its own column, never past 80 cells.
  expect(families(ASCII).decay).toContain("한글 제목");
});

test("#590 task 429: exported host renderers stay byte-identical", () => {
  // The frozen host-API renderers keep their v1 shapes; the CLI-only module is never re-exported.
  expect(migrationText(f.migration).split("\n")[0]).toBe("amem migrate: preview");
  expect(pruneText(f.prune).split("\n")[0]).toBe("amem prune: preview");
  expect(usageText(f.usage).split("\n")[0]).toStartWith("2 project shard(s): 4212 capture rows");
  expect(vaultCandidatesText(f.vault[0]!.candidates).split("\n")[0]).toBe("amem vault-candidates: attention");
  const index = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
  expect(index).not.toContain("report-text");
});

test("#590 task 429: marked sessions screen the previous text first, then show the same report as a person", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { execFileSync } = await import("node:child_process");
  const { runCli } = await import("../src/cli.ts");
  const root = mkdtempSync(join(tmpdir(), "amem-429-")), repo = join(root, "repo"), home = join(root, "memory");
  mkdirSync(repo); execFileSync("git", ["init", "-q"], { cwd: repo });
  const before = process.env.AMEM_HOME; process.env.AMEM_HOME = home;
  const env = { HOME: root, AGENTHUB_HOME: root, AMEM_HOME: home, NO_COLOR: "1" };
  const person = { cwd: repo, env, stdinTTY: false }, agent = { cwd: repo, env: { ...env, CODEX_THREAD_ID: "fixture" }, stdinTTY: false };
  try {
    // Each family that runs on a fresh home: the legacy text names a token the new report does not print.
    const cases: [string[], string, string][] = [[["projects"], "no project shards yet", " amem Projects"], [["usage"], "project shard(s):", " amem Usage"],
      [["repo", "status"], "repo scope of", " amem Repository log"], [["sync", "--status"], "no placement sync operation recorded", " amem Sync status"]];
    for (const [args, legacyToken, header] of cases) {
      rmSync(join(home, "amem.config.json"), { force: true });
      const shown = await runCli(args, person);
      expect(shown, args.join(" ")).toStartWith(header);
      expect(await runCli(args, agent), args.join(" ")).toBe(shown);
      // A denial on the previous text keeps the previous (withheld) path: the new report is never shown.
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "amem.config.json"), JSON.stringify({ piiPatterns: [legacyToken] }));
      const marked = await runCli(args, agent).catch((error: Error) => `refused: ${error.message}`);
      expect(marked, args.join(" ")).not.toStartWith(header);
      expect(await runCli(args, person), args.join(" ")).toStartWith(header);
    }
  } finally { if (before === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = before; rmSync(root, { recursive: true, force: true }); }
});

test("#590 task 429: every CLI call of a new renderer goes through the two-step marked screen", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8"), commands = readFileSync(join(import.meta.dir, "../src/memory/commands.ts"), "utf8");
  const calls = [...cli.matchAll(/reports\.(\w+)\(/g)];
  expect(new Set(calls.map(call => call[1])).size).toBe(10);
  for (const call of calls) expect(cli.slice(Math.max(0, call.index! - 400), call.index!), call[1]).toMatch(/screenedLegacy\((?:(?!screenedLegacy\()[\s\S])*$/);
  // rawMemoryCommand sync renders only for the CLI, through the private render hook and its renderLegacy screen.
  expect(commands).toMatch(/internal \? rendered\(legacy, syncReportText\(/);
});
