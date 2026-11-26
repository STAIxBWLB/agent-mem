import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAmemCommand } from "../src/commands-table.ts";
import { CLIS, captureHint, DOCTOR_SCHEMA, type DoctorReport } from "../src/memory/doctor.ts";
import { captureFinding, DOCTOR_HINTS, doctorText, hintFinding, writerFinding } from "../src/memory/doctor-text.ts";
import { statusText, type StatusView } from "../src/memory/status-text.ts";
import { style } from "../src/memory/style.ts";

// #590 AC8-AC10 for `amem status` and `amem doctor`: color-off 80-column goldens and the content rules they must keep.
const PLAIN = style(false, false), NOW = Date.parse("2026-11-23T12:00:00.000Z");
const ok = { status: "ok" as const };

const statusView = (overrides: Partial<StatusView> = {}): StatusView => ({ home: { path: "/h/memory", source: "default" },
  config: { machine: "/h/memory/amem.config.json", repo: null, denyPaths: 2, piiPatterns: 1, briefBytes: 6000 },
  candidates: { count: 203, oldestExpiresInDays: 3, dueWithin7Days: 21, unshown: 202 }, active: true, generation: "abcdef0123456789",
  pending: { rows: 0, skippedRows: 0, byShard: {} }, deadLeasesRemoved: [{ lease: "a", at: "2026-10-17T00:00:00.000Z" }, { lease: "b", at: "2026-10-17T00:00:00.000Z" }], ...overrides });

function doctorReport(sections: Partial<DoctorReport["sections"]> = {}): DoctorReport {
  const all: DoctorReport["sections"] = {
    duplicates: { ...ok, notes: 1088, identicalGroups: 0, importedGroups: 0 }, stale: { ...ok, checked: 1088, missingReferences: 0 },
    candidates: { ...ok, count: 4, oldestExpiresInDays: 30, dueWithin7Days: 0, unshown: 1 },
    capture: { ...ok, clis: { claude: { hook: "registered", capture: "fresh", lastCaptureAt: "2026-11-23T09:00:00.000Z", rows: 12, machineCapture: "fresh", machineLastCaptureAt: "2026-11-23T11:00:00.000Z", machineRows: 40 } } },
    brief: { ...ok, tokens: 400, budget: 2000, coverage: {} }, index: { status: "skipped", reason: "a curated split or generation home builds and seals its index when it is created; amem rebuild repeats it" },
    readers: { ...ok, live: 1, stale: 0, unreadable: 0 }, policy: { ...ok, machine: null, repo: null, denyPaths: 0, piiPatterns: 0 },
    cadence: { ...ok, ingest: { claude: "hooks", codex: "session end" }, sync: { remote: "configured", lastAttemptAt: "2026-11-23T10:00:00.000Z", lastOkAt: "2026-11-23T10:00:00.000Z", failures: 0, nextAttemptAt: null, due: false } },
    drops: { ...ok, window: "recent metrics tail", total: 0, counts: {} },
    spool: { ...ok, active: { files: 1, bytes: 5814, maxFiles: 256, maxBytes: 2097152 }, reserve: { files: 0, bytes: 0, maxFiles: 32, maxBytes: 2097152 },
      kinds: { native: 1, summaries: 0, unclassified: 0, complete: true }, fill: "pending", claimed: 0, complete: true, coverage: "complete", classificationCoverage: "complete" },
    setup: { ...ok, checked: 5, entries: [] }, ...sections };
  const statuses = Object.values(all).map(section => section.status);
  return { schema: DOCTOR_SCHEMA, status: statuses.includes("attention") ? "attention" : statuses.includes("unavailable") ? "unavailable" : "ok", home: { path: "/h/memory", source: "AMEM_HOME" }, project: "repo@1234abcd", sections: all };
}
const writersRefusal = { status: "attention" as const, category: "declared writer", cause: "missing", phase: "active",
  reason: "Sync placement writer proof is missing (declared writer category); restore the inventoried install, or renew it through the checkpoint while sessions keep running: save the preview with (umask 077; set -C; amem migrate --sync-placement --checkpoint --writer-root <install root> --json > checkpoint-plan.json), repeating --writer-root for every install root, then run amem migrate --sync-placement --checkpoint --confirm --plan checkpoint-plan.json with the same --writer-root list. Only if the checkpoint preview refuses (an open obligation, no headroom, or a home floor below 0.30.0), close every amem session (agent sessions, hub peers and their amem mcp servers), then, if needed, preview amem formats raise home 0.22.0 and add --confirm after the exact command is approved; then run amem migrate --sync-placement --dry-run with the complete --writer-root inventory, and run --apply after the exact apply command is approved." };

/** AC8/AC9 rules every human line of these two reports keeps. */
function conforms(text: string): void {
  const lines = text.split("\n");
  for (const line of lines) {
    expect(Bun.stringWidth(line, { ambiguousIsNarrow: true }), line).toBeLessThanOrEqual(80);
    expect(line, "camelCase fact key").not.toMatch(/\b[a-z]+[A-Z][a-zA-Z]*\b/);
    expect(line, "JSON fragment").not.toMatch(/[{}]|":/);
    expect(line, "millisecond ISO time").not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(line, "Markdown backtick").not.toContain("`");
    expect(line, "addresses the person").not.toMatch(/\bthe person\b/i);
    expect(line).not.toMatch(/Next actions?:|Full report/);
  }
  for (const line of lines.filter(line => /^ +(->|→) /.test(line))) expect(isAmemCommand(line.replace(/^ +(->|→) +/, "")), line).toBe(true);
  // A wrapped continuation never starts left of its row's text (S1): row text starts after the name column.
  lines.forEach((line, index) => {
    const row = /^( {2}\S+ +\S+ +\S+: +)/.exec(line);
    if (!row) return;
    for (let next = index + 1; next < lines.length && /^ {6,}\S/.test(lines[next]!) && !/^ +(->|→) /.test(lines[next]!); next++)
      expect(/^ */.exec(lines[next]!)![0].length, lines[next]).toBe(row[1]!.length);
  });
}

test("#590: status golden at 80 columns, color off", () => {
  const text = statusText(statusView(), PLAIN, { columns: 80, version: "0.37.0" });
  expect(text).toBe([
    " amem status  warning",
    "  amem 0.37.0, home /h/memory (default)",
    "",
    "▸ Attention (1)",
    "  ⚠  21 candidates expire within 7 days",
    "    →  amem review walk",
    "",
    "▸ Memory",
    "  ✓  ok       policy:      machine /h/memory/amem.config.json, repo none, 2 deny",
    "                           paths, 1 PII pattern, brief bytes 5.9 KiB",
    "  ⚠  warning  candidates:  203 pending, 202 never shown, oldest expires in 3 d",
    "  ✓  ok       layout:      shards active, generation abcdef01; no pending",
    "                           old-layout appends",
  ].join("\n"));
  conforms(text);
});

test("#590: doctor golden at 80 columns, color off, with a writer refusal", () => {
  const text = doctorText(doctorReport({ writers: writersRefusal }), PLAIN, { columns: 80, version: "0.37.0", now: NOW });
  expect(text).toBe([
    " amem doctor  warning",
    "  amem 0.37.0, home /h/memory (AMEM_HOME)",
    "  project repo@1234abcd",
    "",
    "▸ Attention (1)",
    "  ⚠  placement writer proof is missing (declared writer category)",
    "    →  amem migrate --sync-placement --writers",
    "    →  amem migrate --sync-placement --checkpoint",
    "    →  amem formats raise home 0.22.0",
    "    →  amem migrate --sync-placement --dry-run",
    "",
    "▸ Checks (13)",
    "  ⚠  warning  writers:     missing (declared writer category); see Attention",
    "  -  skipped  index:       a curated split or generation home builds and seals",
    "                           its index when it is created; amem rebuild repeats it",
    "  ✓  ok       duplicates:  1088 notes, 0 identical groups, 0 imported groups",
    "  ✓  ok       stale:       1088 checked, 0 missing",
    "  ✓  ok       candidates:  4 pending, 1 never shown, oldest expires in 30 d",
    "  ✓  ok       capture:     claude hook registered, capture fresh 3 h ago, 12",
    "                           rows; machine-wide fresh 1 h ago",
    "  ✓  ok       brief:       400 of 2000 tokens",
    "  ✓  ok       readers:     1 live, 0 stale, 0 unreadable",
    "  ✓  ok       policy:      machine none (defaults), repo none, 0 deny paths, 0",
    "                           PII patterns",
    "  ✓  ok       cadence:     ingest claude hooks, codex session end; sync remote",
    "                           configured, last ok 2 h ago, 0 failures",
    "  ✓  ok       drops:       none in the recent metrics tail",
    "  ✓  ok       spool:       pending; active 1 of 256 files, 5.7 KiB of 2.0 MiB;",
    "                           reserve 0 of 32 files, 0 B of 2.0 MiB; 0 claimed;",
    "                           native 1, summaries 0, unclassified 0; classification",
    "                           complete",
    "  ✓  ok       setup:       5 registrations match their receipts",
    "",
    "  1 skipped: nothing to check here",
    "",
    "⚠ 1 warning  ✓ 11 ok",
  ].join("\n"));
  conforms(text);
  // C6: the writer refusal is one finding, never the fixed refusal paragraph.
  expect(text).not.toContain("exact command is approved");
});

test("#590 AC10: a no-change run prints no historical line unless --verbose", () => {
  const quiet = statusText(statusView({ candidates: { count: 0, oldestExpiresInDays: null, dueWithin7Days: 0, unshown: 0 } }), PLAIN, { columns: 80 });
  expect(quiet).not.toContain("dead reader leases"); expect(quiet).not.toContain("Attention");
  expect(statusText(statusView(), PLAIN, { columns: 80, verbose: true })).toContain("2 dead reader leases removed during the last migration");
  const doctor = doctorText(doctorReport(), PLAIN, { columns: 80, now: NOW });
  expect(doctor).not.toContain("Attention"); expect(doctor.split("\n").at(-1)).toBe("✓ 11 ok");
  conforms(quiet); conforms(doctor);
});

test("#590 C4: every hint a doctor section can emit maps to a finding, and every mapped command parses", () => {
  const source = readFileSync(join(import.meta.dir, "../src/memory/doctor.ts"), "utf8");
  // Every literal hint in a section producer (the renderer's own table excluded).
  const producers = source.slice(0, source.indexOf("export const DOCTOR_HINTS"));
  const literals = [...producers.matchAll(/hint: (?:[^"\n]*\?\s*)?"([^"]+)"(?:\s*:\s*"([^"]+)")?/g)].flatMap(match => [match[1]!, ...(match[2] ? [match[2]] : [])]);
  expect(literals.length).toBeGreaterThanOrEqual(11);
  for (const hint of literals) {
    expect(Object.hasOwn(DOCTOR_HINTS, hint), `unmapped doctor hint: ${hint}`).toBe(true);
    const finding = DOCTOR_HINTS[hint]!({ examples: ["abcdef12"], missingReferences: 1, dueWithin7Days: 2 });
    expect(finding.text).not.toMatch(/\bamem [a-z]/);
    for (const command of finding.next) expect(isAmemCommand(command), command).toBe(true);
  }
  // Every capture hint branch, for every CLI.
  for (const cli of CLIS) for (const registered of [true, false]) for (const state of ["never", "stale", "fresh"] as const)
    for (const trigger of ["machine", "project", "setup"] as const) for (const roots of [[], ["sessions"]] as const) {
      const finding = captureFinding(cli, captureHint(cli, registered, state, trigger, roots as never));
      expect(finding.text).not.toMatch(/\bamem [a-z]/);
      for (const command of finding.next) expect(isAmemCommand(command), command).toBe(true);
    }
  // A hint missing from the table is a finding with no command, never raw text with an embedded command.
  const fallback = hintFinding("index", "something new: run amem frobnicate --now", {});
  expect(fallback).toEqual({ text: "index equals rebuild: something new", next: [] });
  expect(writerFinding(writersRefusal).next.every(isAmemCommand)).toBe(true);
});

test("#590 AC9: the command resolver accepts complete commands and refuses prose or unknown flags", () => {
  for (const ok of ["amem review walk", "amem show <id>", "amem migrate --sync-placement --dry-run", "amem formats raise home 0.22.0", "amem setup codex --apply", "amem doctor --json", "amem status --verbose"])
    expect(isAmemCommand(ok), ok).toBe(true);
  for (const bad of ["run amem review walk", "amem", "amem nosuch", "amem status --nosuch", "amem review walk: then decide"])
    expect(isAmemCommand(bad), bad).toBe(false);
});
