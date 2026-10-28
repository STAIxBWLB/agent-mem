import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
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
    cadence: { ...ok, ingest: { claude: "hooks", codex: "session end", kimi: "session end", pi: "session end" }, sync: { remote: "none", lastAttemptAt: null, lastOkAt: null, failures: 0, nextAttemptAt: null, due: false } }, ...overrides };
  const statuses = Object.values(sections).map(section => section.status);
  return { schema: DOCTOR_SCHEMA, status: statuses.includes("attention") ? "attention" : statuses.includes("unavailable") ? "unavailable" : "ok", home: { path: "/h/memory", source: "AMEM_HOME" }, project: "p", sections };
}

test("doctor healthy: concise overall state, labelled rows, no raw JSON, no next action", () => {
  const text = doctorText(report());
  expect(text.split("\n")[0]).toBe("amem doctor: ok  (all 9 checks ok)");
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

test("person/agent refusal text is unchanged for the reformatted commands", async () => {
  for (const command of ["status", "doctor"]) await expect(run([command], { CODEX_THREAD_ID: "x" }, true)).rejects.toThrow(/amem is for the person/);
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
