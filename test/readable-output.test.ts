import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, ingestText } from "../src/cli.ts";
import type { IngestReceipt } from "../src/ingest.ts";
import { migrationText, type MigrationResult } from "../src/memory/migrate.ts";
import { shardMigrationText, type ShardMigrationResult } from "../src/memory/shard-migration.ts";
import { pruneText, type PrunePlan } from "../src/memory/prune.ts";
import { capacityApplyText, capacitySplitText } from "../src/memory/capacity.ts";
import { vaultCandidatesText, vaultCandidatesAllText } from "../src/memory/vault.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { doctorText, DOCTOR_SCHEMA, type DoctorReport } from "../src/memory/doctor.ts";
import { realPath } from "../src/memory/platform.ts";
import { statusText, type StatusView } from "../src/memory/status-text.ts";
import { colorEnabled, PLAIN, style } from "../src/memory/style.ts";
import { setupConfirmationText, setupPlanText, type SetupPlan } from "../src/setup.ts";

const ANSI = /\x1b\[/, COLOR = style(true), WIDTH = 160;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const strip = (text: string) => text.replace(/\x1b\[\d+m/g, "");

test("color is on only for a TTY without NO_COLOR or TERM=dumb", () => {
  expect(colorEnabled({}, true)).toBe(true);
  expect(colorEnabled({}, false)).toBe(false);
  expect(colorEnabled({}, undefined)).toBe(false);
  expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(false);
  expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
  expect(colorEnabled({ TERM: "dumb" }, true)).toBe(false);
  expect(colorEnabled({ TERM: "xterm-256color" }, true)).toBe(true);
});

const ok = { status: "ok" as const };
function report(overrides: Partial<DoctorReport["sections"]> = {}, clis = 4): DoctorReport {
  const cliRows = Object.fromEntries(["claude", "codex", "kimi", "pi"].slice(0, clis).map(cli => [cli, { hook: "registered", capture: "fresh", lastCaptureAt: "2026-10-27T00:00:00.000Z", rows: 12 }]));
  const sections: DoctorReport["sections"] = { duplicates: { ...ok, notes: 3, identicalGroups: 0, importedGroups: 0 }, stale: { ...ok, checked: 3, missingReferences: 0 },
    candidates: { ...ok, count: 0, oldestExpiresInDays: null, dueWithin7Days: 0, unshown: 0 }, capture: { ...ok, clis: cliRows }, brief: { ...ok, tokens: 400, budget: 2000, coverage: {} },
    index: { ...ok, liveIndex: "absent" }, readers: { ...ok, live: 0, stale: 0, unreadable: 0 }, policy: { ...ok, machine: null, repo: null, denyPaths: 0, piiPatterns: 0 },
    cadence: { ...ok, ingest: { claude: "hooks", codex: "session end", kimi: "session end", pi: "session end" }, sync: { remote: "none", lastAttemptAt: null, lastOkAt: null, failures: 0, nextAttemptAt: null, due: false } },
    drops: { ...ok, window: "recent metrics tail", total: 0, counts: {} }, ...overrides };
  const statuses = Object.values(sections).map(section => section.status);
  return { schema: DOCTOR_SCHEMA, status: statuses.includes("attention") ? "attention" : statuses.includes("unavailable") ? "unavailable" : "ok", home: { path: "/h/memory", source: "AMEM_HOME" }, project: "p", sections };
}

test("doctor healthy: concise overall state, labelled rows, no raw JSON, no next action", () => {
  const text = doctorText(report());
  expect(text.split("\n")[0]).toBe("amem doctor: ok  (all 10 checks ok)");
  expect(text).not.toMatch(ANSI); expect(text).not.toContain("{\"");
  for (const name of ["duplicates", "stale", "candidates", "capture", "brief", "index", "readers", "policy", "cadence"]) expect(text).toMatch(new RegExp(`^OK +${name}:`, "m"));
  expect(text).toContain("Next actions: none");
  expect(text).toMatch(/claude +hook registered, capture fresh/);
});

test("doctor attention, skipped and unavailable are distinct labels; registered hooks and never capture stay separate facts", () => {
  const r = report({
    capture: { status: "attention", clis: { claude: { hook: "registered", hookEvidence: "setup receipt", capture: "never", lastCaptureAt: null, rows: 0, hint: "the claude hook is registered but its capture is never: open a session" },
      codex: { hook: "manual", capture: "never", lastCaptureAt: null, rows: 0, hint: "run amem setup codex --apply, or amem ingest codex by hand" } } },
    stale: { status: "skipped", reason: "run doctor from inside this project's repository" },
    index: { status: "unavailable", reason: "copy failed" },
  });
  for (const s of [PLAIN, COLOR]) {
    const text = strip(doctorText(r, s));
    expect(text.split("\n")[0]).toBe("amem doctor: attention  (attention 1, unavailable 1, skipped 1)");
    expect(text).toMatch(/^ATTENTION +capture:/m); expect(text).toMatch(/^SKIPPED +stale:/m); expect(text).toMatch(/^UNAVAILABLE +index:/m);
    expect(text).toMatch(/claude +hook registered, capture never, 0 rows/); expect(text).toMatch(/codex +hook manual, capture never/);
    expect(text).toContain("reason: copy failed");
    expect(text).toContain("Next actions:\n  - capture claude: the claude hook is registered but its capture is never");
  }
  expect(doctorText(r, COLOR)).toMatch(ANSI);
  expect(doctorText(r, PLAIN)).not.toMatch(ANSI);
});

test("doctor large output keeps one bounded row per fact", () => {
  const examples = Array.from({ length: 5 }, (_, i) => [`aaaaaaa${i}`, `bbbbbbb${i}`]);
  const text = doctorText(report({ duplicates: { status: "attention", notes: 100000, identicalGroups: 5000, importedGroups: 0, examples, truncated: "only the newest 100000 notes were read", hint: "amem dedupe previews" } }));
  expect(text).toContain("examples aaaaaaa0=bbbbbbb0");
  for (const line of text.split("\n")) if (!line.includes("/h/memory")) expect(line.length).toBeLessThanOrEqual(WIDTH);
});

const status = (overrides: Partial<StatusView> = {}): StatusView => ({ home: { path: "/h/memory", source: "default" }, config: { machine: null, repo: null, denyPaths: 0, piiPatterns: 0 },
  candidates: { count: 0, oldestExpiresInDays: null, dueWithin7Days: 0, unshown: 0 }, active: false, pending: { rows: 0, skippedRows: 0, byShard: {}, danglingIds: [] }, ...overrides });

test("status empty: home, policy and summarized zero counters, nothing to do", () => {
  const text = statusText(status());
  expect(text.split("\n")[0]).toBe("amem status: ok");
  expect(text).toContain("home     /h/memory (default)");
  expect(text).toMatch(/^OK +policy: machine none \(defaults\), repo none; 0 deny paths, 0 PII patterns$/m);
  expect(text).toMatch(/^OK +candidates: none pending$/m);
  expect(text).toContain("no pending old-layout appends");
  expect(text).not.toContain("skippedRows"); expect(text).toContain("Next actions: none"); expect(text).not.toMatch(ANSI);
});

test("status attention and error surface warnings and actions with text labels", () => {
  const due = statusText(status({ candidates: { count: 3, oldestExpiresInDays: 2, dueWithin7Days: 1, unshown: 1, warning: "1 candidate within 7 days of expiry: run `amem review walk`" },
    pending: { rows: 7, skippedRows: 0, byShard: { p: 7 } }, refusals: ["dangling prune"] }), COLOR);
  const plain = strip(due);
  expect(plain.split("\n")[0]).toBe("amem status: attention");
  expect(plain).toMatch(/^ATTENTION +candidates: 3 pending \(1 never shown\), oldest expires in 2 days$/m);
  expect(plain).toMatch(/^ATTENTION +layout: single home; pending rows 7, byShard \{"p":7\}$/m);
  expect(plain).toContain("Warnings:\n  - migration refusal: dangling prune");
  expect(plain).toContain("  - 1 candidate within 7 days of expiry");
  expect(due).toMatch(ANSI);
  const broken = statusText(status({ candidates: { unavailable: "candidates.db exists but cannot be read" } }));
  expect(broken.split("\n")[0]).toBe("amem status: unavailable");
  expect(broken).toMatch(/^UNAVAILABLE +candidates: candidates.db exists but cannot be read$/m);
});

function plan(mode: SetupPlan["mode"], count = 2): SetupPlan {
  const targets = (["claude", "codex", "kimi", "pi", "qwen", "jcode"] as const).slice(0, count);
  return { targets: [...targets], mode, notes: ["WARNING: something to see", "Preview only unless --apply or --undo is confirmed in a person's terminal."],
    actions: targets.map((target, i) => ({ target, files: [`/h/.${target}/config.json`], receipt: `/h/memory/setup/${target}.json`, registration: [target, "mcp", "add", "amem"], lifecycle: "session end ingest",
      available: i !== 1, hooks: target === "claude" ? [{ event: "PostToolUse", command: "bun amem hook PostToolUse", timeout: 5 }] : [], mcpChange: i === 0 ? "add" : "unchanged", commands: [], state: "not installed" })) };
}

test("setup plan shows targets, files, MCP and hook changes, skipped clients and warnings once", () => {
  const text = setupPlanText(plan("preview"));
  expect(text.split("\n")[0]).toBe("amem setup preview: 2 targets, 1 with MCP changes, 1 skipped");
  expect(text).toMatch(/^ATTENTION +claude: MCP add \(not installed\)$/m);
  expect(text).toMatch(/^SKIPPED +codex: CLI not installed$/m);
  expect(text).toContain("file     /h/.claude/config.json"); expect(text).toContain("receipt  /h/memory/setup/claude.json");
  expect(text).toContain("hook     PostToolUse: bun amem hook PostToolUse (timeout 5)");
  expect(text).toContain("Skipped clients: codex (not installed)");
  expect(text).toContain("Warnings:\n  - WARNING: something to see");
  expect(text.split("/h/.claude/config.json").length).toBe(2);
  expect(text).not.toMatch(ANSI); expect(text).not.toContain("\"actions\"");
  const large = setupPlanText(plan("apply", 6), COLOR);
  expect(strip(large).split("\n")[0]).toBe("amem setup apply: 6 targets, 1 with MCP changes, 1 skipped");
});

test("setup versions are advisory, explicit in plain and color output, and additive in JSON", () => {
  const shown = plan("preview", 4);
  for (const action of shown.actions) action.available = true;
  shown.actions[0]!.version = { output: "claude 1.2.3", verified: "1.2.3", matches: true };
  shown.actions[1]!.version = { output: "codex-cli 9.8.7", verified: "9.8.6", matches: false };
  shown.actions[2]!.version = { output: null, verified: "0.26.1", matches: null };
  shown.actions[3]!.version = { output: "Pi 0.51.0", verified: null, matches: null };
  shown.notes.push("WARNING: codex version codex-cli 9.8.7; layout verified on 9.8.6.");

  const plain = setupPlanText(shown, PLAIN), colored = setupPlanText(shown, COLOR);
  expect(plain).not.toMatch(ANSI);
  expect(colored).toMatch(ANSI);
  expect(strip(colored)).toBe(plain);
  expect(plain).toContain("version claude 1.2.3");
  expect(plain).toContain("verified 1.2.3");
  const mismatch = plain.split("\n").find(row => row.includes("WARNING") && row.includes("codex"));
  expect(mismatch).toContain("codex-cli 9.8.7"); expect(mismatch).toContain("verified on 9.8.6");
  expect(plain).toContain("version unknown; verified 0.26.1");
  expect(plain).toContain("version Pi 0.51.0; unverified (no verified version recorded)");
  expect(JSON.parse(setupConfirmationText(shown, true, COLOR))).toEqual(shown);
  expect(setupConfirmationText(shown, true, COLOR)).not.toMatch(ANSI);
});

function home() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-readable-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "repo"); mkdirSync(cwd); return { root, cwd, memory: join(root, "memory") };
}
async function run(args: string[], env: Record<string, string>, stdoutTTY: boolean) {
  const h = home(), saved = process.env.AMEM_HOME; process.env.AMEM_HOME = h.memory;
  try { return await runCli(args, { cwd: h.cwd, env, stdinTTY: false, stdoutTTY }); }
  finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}

test("status and doctor: TTY colors, plain stays plain, --json never carries ANSI", async () => {
  for (const command of ["status", "doctor"]) {
    expect(await run([command], {}, true)).toMatch(ANSI);
    expect(await run([command], { NO_COLOR: "1" }, true)).not.toMatch(ANSI);
    expect(await run([command], { TERM: "dumb" }, true)).not.toMatch(ANSI);
    const plain = await run([command], {}, false);
    expect(plain).not.toMatch(ANSI); expect(plain).toStartWith(`amem ${command}: `);
    const json = await run([command, "--json"], {}, true);
    expect(json).not.toMatch(ANSI); expect(() => JSON.parse(json)).not.toThrow();
  }
  expect(Object.keys(JSON.parse(await run(["status", "--json"], {}, true)))).toEqual(["home", "config", "candidates", "active", "pending"]);
}, 30_000);

test("status and doctor keep their bounded refusal for agent reads", async () => {
  for (const command of ["status", "doctor"]) await expect(run([command], { CODEX_THREAD_ID: "x" }, true)).rejects.toThrow(/is not available to an agent-marked session\. Agent reads: search, list, show, brief, graph, vault-candidates, capacity\./);
});

test("setup confirmation shows the raw plan under --json and the readable plan otherwise", () => {
  const shown = plan("apply");
  expect(JSON.parse(setupConfirmationText(shown, true, COLOR))).toEqual(shown);
  expect(setupConfirmationText(shown, true, COLOR)).not.toMatch(ANSI);
  expect(setupConfirmationText(shown, false)).toBe(setupPlanText(shown));
});

test("setup command lines quote paths with spaces and skipped clients take one line", () => {
  const shown = plan("preview"); shown.actions[0]!.registration = ["claude", "mcp", "add", "amem", "--", "/opt/my bun/bun"];
  const text = setupPlanText(shown);
  expect(text).toContain("command  'claude' 'mcp' 'add' 'amem' '--' '/opt/my bun/bun'");
  expect(text).toMatch(/^SKIPPED +codex: CLI not installed$/m);
  expect(text).not.toContain("/h/.codex/config.json");
});

test("undo of an uninstalled client with a receipt still shows its files and restore, and counts it", () => {
  const undo: SetupPlan = { targets: ["codex"], mode: "undo", notes: [], actions: [{ target: "codex", files: ["/h/.codex/config.toml"], receipt: "/h/memory/setup/codex.json", registration: null,
    lifecycle: "restore original MCP/hook files", available: false, hooks: [], mcpChange: "restore", commands: [], state: "applied" }] };
  const text = setupPlanText(undo);
  expect(text.split("\n")[0]).toBe("amem setup undo: 1 target, 1 with restores");
  expect(text).toMatch(/^ATTENTION +codex: restore original MCP\/hook files \(CLI not installed\)/m);
  expect(text).toContain("file     /h/.codex/config.toml"); expect(text).toContain("receipt  /h/memory/setup/codex.json");
  expect(text).not.toContain("SKIPPED");
});

test("status flags a shard migration stopped after capture with the resume action", () => {
  const text = statusText(status({ active: false, phase: "captured", generation: "0123456789abcdef" }));
  expect(text.split("\n")[0]).toBe("amem status: attention");
  expect(text).toMatch(/^ATTENTION +layout: shard migration captured, not active; no pending old-layout appends$/m);
  expect(text).toContain("amem migrate --shards --resume");
  expect(text).not.toContain("Next actions: none");
});

test("pending old-layout rows point to the resume that carries them", () => {
  const text = statusText(status({ pending: { rows: 4, byShard: { p: 4 } } }));
  expect(text).toContain("4 old-layout rows wait for the shard migration: amem migrate --shards --resume carries them");
});

test("undo of a target without a receipt says there is nothing to restore", () => {
  const undo: SetupPlan = { targets: ["kimi"], mode: "undo", notes: [], actions: [{ target: "kimi", files: ["/h/.kimi/config.json"], receipt: "/h/memory/setup/kimi.json", registration: null,
    lifecycle: "restore original MCP/hook files", available: true, hooks: [], mcpChange: "unchanged", commands: [], state: "not installed" }] };
  expect(setupPlanText(undo)).toMatch(/^OK +kimi: no setup receipt; nothing to restore/m);
  expect(setupPlanText(undo)).not.toContain("already set up");
  expect(setupPlanText({ ...undo, mode: "apply" })).toMatch(/^OK +kimi: already set up; no change/m);
});

const emptyIngest: IngestReceipt = { files: 0, read: 0, imported: 0, skipped: 0, spooled: 0, remaining: false, errors: 0 };
const migrationView = (mode: MigrationResult["mode"] = "dry-run", active = false): MigrationResult => ({
  mode, profile: { kind: active ? "generation" : "shared-v1", home: "/h/memory", dir: active ? "/h/memory/generations/g" : "/h/memory", selectorRevision: "revision", ...(active ? { generation: "a".repeat(32) } : {}) },
  counts: { validRows: 2, skippedRows: 0, byOp: { note: 2 }, byTier: { long: 2 }, tailBytes: 200, expiredRows: 0, eligibleRows: 2 }, consequence: "History stays available.",
});
const shardView = (): ShardMigrationResult => ({ mode: "dry-run", generation: "b".repeat(32), active: false, consequence: "Curated projects are routed to shards.",
  counts: { rows: 2, skippedRows: 0, byShard: { project: 2 }, userRows: 0, byProject: { repo: 2 }, tailBytes: 100, legacyRows: 2, generationRows: 0, generationLocalRows: 0,
    pruneRows: 0, translatedPruneRows: 0, refusedRows: 0, sharedSupersededByPrivate: 0, sharedSupersededByPrivateIds: [], crossPrivateReplacement: 0, crossPrivateReplacementIds: [],
    danglingRows: 0, danglingIds: [], legacyLocalRows: 0, legacyMainRows: 2 } });
const pruneView = (): PrunePlan => ({ schema: "agent-mem.prune-plan/v1", generation: "a".repeat(32), selectorRevision: "revision", project: "repo", policyRevision: "policy",
  counts: { eligible: 2, selected: 1, local: 1, synced: 0 }, hasMore: true, seal: "sealed-not-human-output", rows: [{ placement: "local", payload: {
    schema: "agent-mem.prune/v1", op: "prune", generation: "a".repeat(32), at: "2026-10-28T00:00:00.000Z", machine: "m", actor: "person", placement: "local", cutoff: "2026-10-27T00:00:00.000Z", id: "b".repeat(32),
    targets: [{ id: "c".repeat(32), rowHash: "d".repeat(64), expiredAt: "2026-10-26T00:00:00.000Z", basis: { kind: "note", id: "c".repeat(32), rowHash: "d".repeat(64) } }] } }] });
const capacityView = () => ({ preview: { file: "/h/memory/capture-config.json", current: { capMb: 512, retentionDays: 90 }, target: { capMb: 256, retentionDays: 30 }, reason: "observed resource bound" }, confirm: "re-run with --confirm to write" });

test("ingest receipts distinguish complete, remaining, spooled, errors and no source", () => {
  expect(ingestText("codex", emptyIngest)).toStartWith("amem ingest codex: skipped\n");
  const complete = { ...emptyIngest, files: 1, read: 3, imported: 2, skipped: 1 };
  expect(ingestText("kimi", complete)).toStartWith("amem ingest kimi: complete\n");
  expect(ingestText("pi", { ...complete, remaining: true })).toContain("run the same ingest command again");
  const spooled = ingestText("qwen", { ...complete, spooled: 1 });
  expect(spooled).toContain("the next capture write replays"); expect(spooled).not.toContain("amem doctor");
  for (const reason of ["source_bound", "source_unavailable", "schema_or_time", "cursor_busy", "scope_changed"] as const) {
    const text = ingestText("codex", { ...emptyIngest, errors: 1, reason });
    expect(text).toStartWith("amem ingest codex: attention\n"); expect(text).toContain("reason: " + reason); expect(text).toContain("Next action:");
  }
});

test("migration text covers preview, already active, deactivation, shard refusals and pending rows", () => {
  for (const s of [PLAIN, COLOR]) {
    const preview = strip(migrationText(migrationView(), s));
    expect(preview).toStartWith("amem migrate: preview\n"); expect(preview).toMatch(/^OK +profile shared-v1/m);
    expect(preview).toContain("Next action: apply migration: amem migrate --apply");
    const active = strip(migrationText({ ...migrationView("apply", true), alreadyActive: true, counts: undefined }, s));
    expect(active).toContain("already active"); expect(active).toContain("Next action: none");
    expect(strip(migrationText({ ...migrationView("deactivate"), counts: undefined }, s))).toContain("Next action: none");
    const shards = shardView(), before = JSON.stringify(shards), routed = strip(shardMigrationText(shards, s));
    expect(routed).toStartWith("amem migrate --shards: preview\n"); expect(routed).toMatch(/^OK +shard rows project 2/m); expect(JSON.stringify(shards)).toBe(before);
    expect(routed).toContain("Next action: apply shard migration: amem migrate --shards --apply");
    expect(strip(shardMigrationText({ ...shards, active: true, counts: { ...shards.counts, rows: 0 } }, s))).toContain("Next action: none");
    const refused = strip(shardMigrationText({ ...shards, refusals: ["witness not current"] }, s));
    expect(refused).toContain("Refusals:"); expect(refused).toContain("resolve the listed refusals");
  }
});

test("prune text is not a sealed plan and identifies completed prune rows", () => {
  const plan = pruneView(), before = JSON.stringify(plan);
  for (const s of [PLAIN, COLOR]) {
    const text = strip(pruneText(plan, s));
    expect(text).toStartWith("amem prune: preview\n"); expect(text).toContain("eligible 2, selected 1, local 1, synced 0");
    expect(text).toContain("--json"); expect(text).toContain("--plan <file>"); expect(text).toContain("keep --user");
    expect(text).not.toContain(plan.seal); expect(text).toContain("not a sealed JSON plan");
    const applied = strip(pruneText({ completed: ["row-id"] }, s));
    expect(applied).toContain("completed prune rows: 1"); expect(applied).toContain("row-id"); expect(applied).toContain("Next action: none");
    expect(strip(pruneText({ ...plan, rows: [], counts: { eligible: 0, selected: 0, local: 0, synced: 0 }, hasMore: false }, s))).toContain("Next action: none");
  }
  expect(JSON.stringify(plan)).toBe(before);
});

test("capacity text keeps confirmation arguments and visible shard skips", () => {
  const preview = capacityView(), before = JSON.stringify(preview);
  const split = { at: 1, split: [{ key: "repo", dir: "/h/shard", current: {}, target: { capMb: 50, retentionDays: 7 }, reason: "share" }], skipped: ["foreign"], confirm: "confirm" };
  for (const s of [PLAIN, COLOR]) {
    const text = strip(capacityApplyText(preview, s));
    expect(text).toStartWith("amem capacity apply: preview\n"); expect(text).toContain("keeping all other arguments");
    expect(text).toContain("cap_mb 256, retention_days 30"); expect(text).not.toContain('{"');
    expect(strip(capacityApplyText({ preview: preview.preview, written: { cap_mb: 256, retention_days: 30 } }, s))).toContain("Next action: none");
    const shares = strip(capacitySplitText(split, s));
    expect(shares).toStartWith("amem capacity apply --split: preview\n"); expect(shares).toContain("SKIPPED"); expect(shares).toContain("foreign");
    expect(shares).toContain("--split command with --confirm, keeping all other arguments");
    expect(strip(capacitySplitText({ split: split.split, written: [{ key: "repo", cap_mb: 50, retention_days: 7 }] }, s))).toContain("Next action: none");
  }
  expect(JSON.stringify(preview)).toBe(before);
});

test("vault text bounds metadata and never emits note bodies or data terminal controls", () => {
  const h = home(), store = new MemoryStore({ memoryDir: h.memory, deferPromotions: true });
  try {
    const id = store.note({ op: "note", project: "repo", scope: "project", tier: "long", kind: "contract", peer: "person", source: "person",
      title: COLOR.error("bounded title") + "\nextra" + " " + "forged" + " " + "row", text: "BODY_NOT_FOR_LISTING", about: [] });
    const row = store.get(id)!, text = vaultCandidatesText([row]);
    expect(text).toStartWith("amem vault-candidates: attention\n"); expect(text).toContain(id); expect(text).toContain("bounded title");
    expect(text).not.toContain("BODY_NOT_FOR_LISTING"); expect(text).not.toMatch(ANSI);
    expect(text).not.toContain(" "); expect(text).not.toContain(" "); expect(text.split("\n")).toHaveLength(4);
    const cross = vaultCandidatesAllText({ crossedProjects: true, projects: [{ project: "repo", candidates: [row] }] });
    expect(cross).toContain("source repository"); expect(cross).not.toContain("BODY_NOT_FOR_LISTING");
    expect(vaultCandidatesText([])).toContain("Next action:"); expect(vaultCandidatesText([])).toContain("candidates: 0");
  } finally { store.close(); }
});

async function readableCommand(h: ReturnType<typeof home>, args: string[], stdoutTTY = false, extraEnv: Record<string, string | undefined> = {}, stdinTTY = true) {
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = h.memory;
  try { return await runCli(args, { cwd: h.cwd, env: { HOME: h.root, AMEM_HOME: h.memory, ...extraEnv }, stdoutTTY, stdinTTY }); }
  finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}

test("ingest JSON keeps exact compact bytes and agent capture entry remains allowed", async () => {
  const h = home(), saved = process.env.CODEX_HOME; process.env.CODEX_HOME = join(h.root, "native-codex"); mkdirSync(join(process.env.CODEX_HOME, "sessions"), { recursive: true });
  try {
    const nonTTY = await readableCommand(h, ["ingest", "codex"]);
    expect(nonTTY).toBe(JSON.stringify(emptyIngest)); expect(nonTTY).not.toMatch(ANSI);
    const plain = await readableCommand(h, ["ingest", "codex"], true, { NO_COLOR: "" });
    expect(plain).toStartWith("amem ingest codex: skipped\n"); expect(plain).not.toMatch(ANSI);
    expect(await readableCommand(h, ["ingest", "codex"], true)).toMatch(ANSI);
    expect(await readableCommand(h, ["ingest", "codex"], true, { NO_COLOR: "" })).toBe(plain);
    expect(await readableCommand(h, ["ingest", "codex"], true, { TERM: "dumb" })).toBe(plain);
    const json = await readableCommand(h, ["ingest", "codex", "--json"], true, { CODEX_THREAD_ID: "agent" }, false);
    expect(json).toBe(JSON.stringify(emptyIngest)); expect(json).not.toMatch(ANSI);
    expect(await readableCommand(h, ["ingest", "codex", "--json"], false)).toBe(json);
  } finally { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; }
}, 30_000);

test("capacity apply CLI has readable two-step plans and the previous pretty JSON", async () => {
  const h = home(), args = ["capacity", "apply", "--cap-mb", "64", "--retention-days", "7"];
  const human = await readableCommand(h, args);
  expect(human).toStartWith("amem capacity apply: preview\n"); expect(human).toContain("keeping all other arguments"); expect(human).not.toMatch(ANSI);
  expect(await readableCommand(h, args, true)).toMatch(ANSI);
  const json = await readableCommand(h, [...args, "--json"], true), preview = JSON.parse(readFileSync(join(h.memory, "capture-config.preview.json"), "utf8"));
  expect(json).toBe(JSON.stringify({ preview, confirm: "re-run with --confirm to write" }, null, 2));
  const written = await readableCommand(h, [...args, "--confirm", "--json"], true), result = JSON.parse(written);
  expect(written).toBe(JSON.stringify({ preview: result.preview, written: { cap_mb: 64, retention_days: 7 } }, null, 2)); expect(written).not.toMatch(ANSI);
}, 30_000);

test("generation/prune CLI keeps sealed JSON artifacts and a readable apply receipt", async () => {
  const h = home(), store = new MemoryStore({ memoryDir: h.memory, deferPromotions: true, now: () => Date.now() - 20000 }), project = memoryProjectKey(h.cwd);
  try { store.note({ op: "note", project, scope: "project", tier: "short", kind: "finding", peer: "person", text: "synthetic expiry fixture", about: [], expires: new Date(Date.now() - 10000).toISOString(), source: "person" }); }
  finally { store.close(); }
  expect(await readableCommand(h, ["migrate", "--dry-run"])).toStartWith("amem migrate: preview\n");
  const migrated = await readableCommand(h, ["migrate", "--generation", "a".repeat(32), "--apply", "--json"], true);
  expect(migrated).toBe(JSON.stringify(JSON.parse(migrated), null, 2)); expect(migrated).not.toMatch(ANSI);
  const selectedPreview = await readableCommand(h, ["migrate"]);
  expect(selectedPreview).toContain("profile generation"); expect(selectedPreview).toContain("Next action: none");
  const args = ["prune", "--dry-run", "--cutoff", new Date().toISOString()];
  expect(await readableCommand(h, args)).toStartWith("amem prune: preview\n");
  const plan = await readableCommand(h, [...args, "--json"], true);
  expect(plan).toBe(JSON.stringify(JSON.parse(plan), null, 2));
  const file = join(h.root, "prune.json"); writeFileSync(file, plan, { mode: 0o600 });
  expect(await readableCommand(h, ["prune", "--apply", "--plan", file])).toStartWith("amem prune: complete\n");
}, 30_000);

test("vault and migration previews remain available without person/TTY gates", async () => {
  const h = home();
  expect(await readableCommand(h, ["vault-candidates"])).toStartWith("amem vault-candidates: complete\n");
  expect(await readableCommand(h, ["vault-candidates", "--json"], true)).toBe("[]");
  await readableCommand(h, ["migrate", "--apply"], false);
  const previews: [string[], string][] = [
    [["migrate", "--dry-run"], "amem migrate: preview\n"],
    [["prune", "--dry-run", "--cutoff", "2026-10-28T00:00:00.000Z"], "amem prune: preview\n"],
  ];
  for (const [args, prefix] of previews) {
    expect(await readableCommand(h, args, false, { CODEX_THREAD_ID: "agent" })).toStartWith(prefix);
    expect(await readableCommand(h, args, false, {}, false)).toStartWith(prefix);
  }
}, 30_000);


test("split capacity CLI previews in text and confirms the same JSON plan", async () => {
  const h = home(), project = memoryProjectKey(h.cwd), capture = new CaptureStore({ memoryDir: h.memory, project, cwd: h.cwd });
  try { capture.append({ project, agent: "fixture", event: "message", excerpt: "synthetic capture", paths: [] }); } finally { capture.close(); }
  const args = ["capacity", "apply", "--split"];
  const human = await readableCommand(h, args);
  expect(human).toStartWith("amem capacity apply --split: preview\n");
  expect(human).toContain("--split command with --confirm, keeping all other arguments");
  const json = await readableCommand(h, [...args, "--json"], true);
  const saved = JSON.parse(readFileSync(join(h.memory, "capacity-split.preview.json"), "utf8"));
  expect(json).toBe(JSON.stringify({ ...saved, confirm: "re-run with --confirm to write each shard's share" }, null, 2));
  expect(json).not.toMatch(ANSI);
  const confirmed = await readableCommand(h, [...args, "--confirm"]);
  expect(confirmed).toStartWith("amem capacity apply --split: complete\n"); expect(confirmed).toContain("Next action: none");
}, 30_000);

test("all new human renderers use the shared color contract without mutating their result objects", () => {
  const migration = migrationView(), shards = shardView(), plan = pruneView(), capacity = capacityView();
  const before = JSON.stringify([migration, shards, plan, capacity]);
  const outputs = [
    (s: typeof PLAIN) => migrationText(migration, s),
    (s: typeof PLAIN) => shardMigrationText(shards, s),
    (s: typeof PLAIN) => pruneText(plan, s),
    (s: typeof PLAIN) => capacityApplyText(capacity, s),
    (s: typeof PLAIN) => vaultCandidatesText([], s),
    (s: typeof PLAIN) => ingestText("codex", { ...emptyIngest, remaining: true }, s),
  ];
  for (const render of outputs) {
    expect(render(PLAIN)).not.toMatch(ANSI);
    expect(render(COLOR)).toMatch(ANSI);
    expect(strip(render(COLOR))).toBe(render(PLAIN));
    expect(render(PLAIN)).toContain("Next action:");
  }
  expect(JSON.stringify([migration, shards, plan, capacity])).toBe(before);
});
