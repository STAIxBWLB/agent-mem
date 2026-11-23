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
const o = { columns: 80, now: f.NOW }, ASCII = style(false, true);
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
      expect(line, `${name}: ISO time`).not.toMatch(/\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/);
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

test("#590 task 429: marked reads screen the previous and the new text and refuse a denial of either", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { execFileSync } = await import("node:child_process");
  const { runCli } = await import("../src/cli.ts");
  const root = mkdtempSync(join(tmpdir(), "amem-429-")), repo = join(root, "repo"), home = join(root, "memory");
  mkdirSync(repo); execFileSync("git", ["init", "-q"], { cwd: repo });
  const before = process.env.AMEM_HOME; process.env.AMEM_HOME = home;
  const env = { HOME: root, AGENTHUB_HOME: root, AMEM_HOME: home, NO_COLOR: "1" };
  const person = { cwd: repo, env, stdinTTY: false }, agent = { cwd: repo, env: { ...env, CODEX_THREAD_ID: "fixture" }, stdinTTY: false };
  const deny = (pattern?: string) => { mkdirSync(home, { recursive: true }); writeFileSync(join(home, "amem.config.json"), JSON.stringify(pattern ? { piiPatterns: [pattern] } : {})); };
  try {
    // [args, a token only the previous text prints, a token only the new report prints, the new report's header]
    const cases: [string[], string, string, string][] = [
      [["projects"], "no project shards yet", "Projects", " amem Projects"],
      [["usage"], "project shard(s):", "Totals", " amem Usage"],
      [["repo", "status"], "repo scope of", "Repository log", " amem Repository log"],
      [["sync", "--status"], "no placement sync operation recorded", "Sync status", " amem Sync status"],
    ];
    for (const [args, legacyOnly, formattedOnly, header] of cases) {
      const name = args.join(" ");
      deny();
      const shown = await runCli(args, person);
      expect(shown, name).toStartWith(header); expect(shown, name).not.toContain(legacyOnly);
      expect(await runCli(args, agent), name).toBe(shown);
      for (const pattern of [legacyOnly, formattedOnly]) {
        deny(pattern);
        // A fixed refusal that names neither text: policy_withheld for reads, the generic refusal where the command is not a read (sync).
        const refused = await runCli(args, agent).then(text => `shown: ${text}`, (error: Error) => error.message);
        expect(refused, `${name} denied by ${pattern}`).toMatch(/policy_withheld|^Memory operation unavailable or refused; no partial result is shown\.$/);
        expect(refused).not.toContain(pattern);
        expect(await runCli(args, person), name).toStartWith(header);
      }
    }
  } finally { if (before === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = before; rmSync(root, { recursive: true, force: true }); }
});

test("#590 task 429: the sync report keeps the native prune count, pending when unknown", () => {
  const base = { ok: true, pushed: false, entries: 2 } as const;
  const proof = (nativeApplied: number | null) => ({ transport: "durable", proofComplete: 1, projectionActive: 2, nativeApplied, held: 0, phase: "preflight" });
  expect(r.syncReportText({ ...base, pruneApplication: proof(3) } as never, PLAIN, o)).toContain("2 foreign projections active, 3 native applied");
  expect(r.syncReportText({ ...base, pruneApplication: proof(null) } as never, PLAIN, o)).toMatch(/pending native\s+applied/);
});

test("#590 task 429: every CLI call of a new renderer goes through the two-step marked screen", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8"), commands = readFileSync(join(import.meta.dir, "../src/memory/commands.ts"), "utf8");
  const calls = [...cli.matchAll(/reports\.(\w+)\(/g)];
  expect(new Set(calls.map(call => call[1])).size).toBe(10);
  for (const call of calls) expect(cli.slice(Math.max(0, call.index! - 400), call.index!), call[1]).toMatch(/(?:screenedReadPair|screenedReceipt)\)?\((?:(?!screenedLegacy\()[\s\S])*$/);
  expect(cli.slice(cli.indexOf("reports."), cli.lastIndexOf("reports.")).match(/screenedLegacy\([^)]*reports\./g)).toBeNull();
  // rawMemoryCommand sync renders only for the CLI, through the private render hook and its renderLegacy screen.
  expect(commands).toMatch(/internal \? rendered\(legacy, syncReportText\(/);
});

test("#590 task 429: a marked sync that completed keeps the withheld-receipt line when either text is denied", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { execFileSync } = await import("node:child_process");
  const { runCli } = await import("../src/cli.ts"), { MemoryStore } = await import("../src/memory/store.ts"), { memoryProjectKey } = await import("../src/memory/project.ts");
  const before = process.env.AMEM_HOME;
  try {
    // legacyOnly appears only in the host line ("synced and pushed: ..."), formattedOnly only in the new report.
    for (const pattern of ["long-term entries visible here", "amem Sync"]) {
      const root = mkdtempSync(join(tmpdir(), "amem-429-sync-")), repo = join(root, "repo"), home = join(root, "memory"), remote = join(root, "remote.git");
      try {
        mkdirSync(repo); execFileSync("git", ["init", "-q"], { cwd: repo }); execFileSync("git", ["init", "-q", "--bare", remote]);
        process.env.AMEM_HOME = home;
        const store = new MemoryStore({ memoryDir: home, screen: () => "keep" });
        try { store.note({ op: "note", project: memoryProjectKey(repo), scope: "project", tier: "long", kind: "decision", peer: "fixture", text: "a public decision", about: [], source: "person" }); }
        finally { store.close(); }
        writeFileSync(join(home, "amem.config.json"), JSON.stringify({ piiPatterns: [pattern] }));
        const env = { HOME: root, AGENTHUB_HOME: root, AMEM_HOME: home, NO_COLOR: "1", CODEX_THREAD_ID: "fixture" };
        const out = await runCli(["sync", "--remote", remote], { cwd: repo, env, stdinTTY: false });
        expect(out, pattern).toBe("Operation completed; receipt withheld by policy. Run amem status to inspect state.");
        // The sync really completed: the bare remote now has a branch.
        expect(execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim(), pattern).not.toBe("");
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  } finally { if (before === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = before; }
}, 60_000);
