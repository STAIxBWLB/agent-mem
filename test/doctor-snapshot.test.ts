import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { applySetup, planSetup } from "../src/setup.ts";

/**
 * AC8: `amem doctor --json` is stable. A note id and a time change on every run, so the snapshot fixes what a consumer can rely on: every key, the type of every value,
 * and the fixed vocabulary (the schema string, the three statuses, the hook and capture states, the remote states). Arrays are described by their first element.
 * `UPDATE_DOCTOR_SNAPSHOT=1 bun test test/doctor-snapshot.test.ts` rewrites the fixture; a reviewer reads the diff of the fixture.
 */
const FIXTURE = new URL("./fixtures/doctor-snapshot.json", import.meta.url);
const VOCABULARY = new Set(["ok", "attention", "skipped", "unavailable", "amem.doctor/v1", "setup receipt", "snapshotted", "absent", "registered", "manual", "fresh", "stale", "never", "configured", "none", "hooks", "session end", "AMEM_HOME"]);
export function shape(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, shape(inner)]));
  return typeof value === "string" && VOCABULARY.has(value) ? value : typeof value;
}

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function rig() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-doctor-snap-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const memory = join(root, "memory"), cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true }); expect(memoryGitSync(["init", "-q", cwd], { encoding: "utf8" }).status).toBe(0);
  return { root, memory, cwd, project: memoryProjectKey(cwd) };
}
async function report(r: ReturnType<typeof rig>): Promise<unknown> {
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = r.memory;
  try { return JSON.parse(await runCli(["doctor", "--json"], { cwd: r.cwd, env: {}, stdinTTY: false })); }
  finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}
const note = (r: ReturnType<typeof rig>, text: string, about: string[] = [], peer = "me") => { const s = new MemoryStore({ memoryDir: r.memory, deferPromotions: true }); try { s.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "finding", peer, source: "person", text, about } as never); } finally { s.close(); } };

function rich() {
  const r = rig(); writeFileSync(join(r.cwd, "keep.ts"), "x");
  note(r, "duplicate words"); note(r, "Duplicate  words", [], "other"); note(r, "points nowhere", ["path:gone.ts"]);
  const c = new CaptureStore({ memoryDir: r.memory, project: r.project, cwd: r.cwd, now: () => Date.now() - 10 * 86400_000 }); c.append({ project: r.project, agent: "codex", event: "Stop", excerpt: "old" }); c.close();
  const pending = new CandidateStore({ memoryDir: r.memory }); pending.put({ project: r.project, kind: "memory", text: "candidate" } as never, "public"); pending.close();
  const env = { HOME: r.root, AMEM_HOME: r.memory, CODEX_HOME: join(r.root, ".codex"), KIMI_CODE_HOME: join(r.root, ".kimi-code"), PI_CODING_AGENT_DIR: join(r.root, ".pi", "agent") };
  const native = (argv: string[], staged: Record<string, string | undefined>) => { const launch = argv.slice(argv.indexOf("--") + 1); mkdirSync(staged.CODEX_HOME!, { recursive: true }); writeFileSync(join(staged.CODEX_HOME!, "config.toml"), Bun.TOML.stringify({ mcp_servers: { amem: { command: launch[0], args: launch.slice(1) } } })); };
  const options = { env, entry: join(r.root, "installed", "bin", "amem.js"), native } as never; applySetup(planSetup("codex", "apply", options), options);
  mkdirSync(join(r.memory, ".git"), { recursive: true }); writeFileSync(join(r.memory, ".git", "config"), '[remote "origin"]\n\turl = x\n');
  const old = new Date(Date.now() - 10 * 86400_000).toISOString(); writeFileSync(join(r.memory, "sync-state.json"), JSON.stringify({ lastAttemptAt: old, lastOkAt: old, failures: 0 }));
  return r;
}

test("doctor --json keeps its documented shape (snapshot of keys, types and vocabulary)", async () => {
  const snapshot = { schema: "amem.doctor/v1", populated: shape(await report(rich())), unused: shape(await report(rig())) };
  if (process.env.UPDATE_DOCTOR_SNAPSHOT === "1") writeFileSync(FIXTURE, JSON.stringify(snapshot, null, 2) + "\n");
  expect(existsSync(FIXTURE)).toBe(true);
  expect(snapshot).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
});

test("every section a consumer reads is present with a status, in a fixed order", async () => {
  const body = await report(rich()) as { schema: string; status: string; sections: Record<string, { status: string }> };
  expect(body.schema).toBe("amem.doctor/v1");
  expect(Object.keys(body.sections)).toEqual(["duplicates", "stale", "candidates", "capture", "brief", "index", "readers", "policy", "cadence"]);
  for (const section of Object.values(body.sections)) expect(["ok", "attention", "unavailable"]).toContain(section.status);
  expect(body.status).toBe("attention");
});
