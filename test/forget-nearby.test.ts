import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "../src/cli.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { FORGET_NEARBY_CAP } from "../src/memory/forget-nearby.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";

// #188: the forget receipt lists nearby machine-local rows (ids and counts only); doctor reports masked counts.
const cleanup: (() => void)[] = [];
const oldHome = process.env.AMEM_HOME;
afterEach(() => { if (oldHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldHome; for (const fn of cleanup.splice(0).reverse()) fn(); });
const LEAK = "leaked fixture phrase alpha bravo charlie";
function rig() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-forget-nearby-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const memory = join(root, "memory"), cwd = join(root, "repo"), other = join(root, "other");
  for (const dir of [cwd, other]) { mkdirSync(dir, { recursive: true }); expect(memoryGitSync(["init", "-q", dir], { encoding: "utf8" }).status).toBe(0); }
  process.env.AMEM_HOME = memory;
  const project = memoryProjectKey(cwd), otherProject = memoryProjectKey(other);
  const note = (text: string, key = project) => { const s = new MemoryStore({ memoryDir: memory, deferPromotions: true }); try { return s.note({ op: "note", project: key, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] }); } finally { s.close(); } };
  const capture = (excerpt: string, key = project, dir = cwd) => { const c = new CaptureStore({ memoryDir: memory, project: key, cwd: dir }); try { const r = c.append({ project: key, agent: "fixture", event: "PostToolUse", excerpt }); return "id" in r ? r.id : -1; } finally { c.close(); } };
  const candidate = (text: string, key = project) => { const c = new CandidateStore({ memoryDir: memory }); try { return c.put({ project: key, kind: "memory", text, noteKind: "finding" }, "public"); } finally { c.close(); } };
  const work = async (task: string, key = project) => { const w = new WorkListStore({ base: memory, project: key, policy: () => true }); try { await w.write("fixture-list", { task, status: "doing" }); } finally { w.close(); } };
  const cli = (args: string[], env: Record<string, string> = {}) => runCli(args, { cwd, env: { AMEM_HOME: memory, ...env }, stdinTTY: false, stdoutTTY: false });
  return { root, memory, cwd, project, otherProject, other, note, capture, candidate, work, cli };
}

test("forget --json lists same-project capture, candidate and work ids that contain or overlap the text, never the text", async () => {
  const r = rig(), id = r.note(LEAK);
  const capId = r.capture(`tool output mentioned ${LEAK} here`); r.capture("unrelated capture row");
  r.capture(`${LEAK} in another project`, r.otherProject, r.other);
  const candId = r.candidate(`${LEAK} proposed again`); r.candidate("completely different words entirely", r.project);
  r.candidate(`${LEAK} elsewhere`, r.otherProject);
  await r.work(`follow up on ${LEAK}`); await r.work("unrelated task");
  const out = await r.cli(["forget", id, "--json"]), receipt = JSON.parse(out);
  expect(receipt.forgot).toBe(id);
  expect(receipt.nearby.capture).toEqual({ ids: [`capture:${capId}`], total: 1, truncated: false });
  expect(receipt.nearby.candidates).toEqual({ ids: [candId], total: 1, truncated: false });
  expect(receipt.nearby.work).toEqual({ ids: [`work:fixture-list#${createHash("sha256").update(`follow up on ${LEAK}`).digest("hex").slice(0, 12)}`], total: 1, truncated: false });
  expect(out).not.toContain(LEAK);
  expect(out).not.toContain("tool output mentioned"); expect(out).not.toContain("proposed again");
  // The human receipt lists ids and counts and points to the procedure.
  const second = r.note(`second note\n${LEAK}`), text = await r.cli(["forget", second]);
  expect(text).toContain("docs/purge.md step 4"); expect(text).toContain(`capture:${capId}`); expect(text).not.toContain("tool output mentioned");
});

test("the receipt never echoes capture, candidate or work text", async () => {
  const r = rig(), id = r.note(LEAK);
  r.capture(`prefix ${LEAK} suffix-secret-tail`);
  const out = await r.cli(["forget", id, "--json"]);
  expect(out).not.toContain("suffix-secret-tail"); expect(out).not.toContain("prefix ");
});

test("policy-refused rows are neither listed nor counted; the cap holds with a full total", async () => {
  const r = rig(), id = r.note(LEAK);
  writeFileSync(join(r.memory, "amem.config.json"), JSON.stringify({ piiPatterns: ["refusedmarker"] }));
  r.capture(`${LEAK} refusedmarker row`);
  const total = FORGET_NEARBY_CAP + 3;
  for (let i = 0; i < total; i++) r.capture(`${LEAK} public row ${i}`);
  const receipt = JSON.parse(await r.cli(["forget", id, "--json"]));
  expect(receipt.nearby.capture.total).toBe(total);
  expect(receipt.nearby.capture.ids).toHaveLength(FORGET_NEARBY_CAP); expect(receipt.nearby.capture.truncated).toBe(true);
});

test("an agent-marked forget gets the same ids-only receipt", async () => {
  const r = rig(), id = r.note(LEAK); const capId = r.capture(`${LEAK} seen`);
  const receipt = JSON.parse(await r.cli(["forget", id, "--json"], { CLAUDECODE: "1" }));
  expect(receipt.nearby.capture.ids).toEqual([`capture:${capId}`]);
});

test("listing is read-only for capture (no migration or index build) and matches non-ASCII text", async () => {
  const r = rig(), hangul = "비밀 키를 노출한 문장입니다 테스트", id = r.note(hangul);
  const capId = r.capture(`도구 출력: ${hangul}`);
  const shard = new CaptureStore({ memoryDir: r.memory, project: r.project, cwd: r.cwd }), file = join(shard.dir, "capture.db"); shard.close();
  // The WAL shared-memory index (-shm) is touched by any reader, read-only included; the database and WAL must not change.
  const files = () => readdirSync(dirname(file)).filter(name => !name.endsWith("-shm")).sort().map(name => [name, statSync(join(dirname(file), name)).mtimeMs]);
  const before = files();
  const tables = () => { const db = new Database(file, { readonly: true }); try { return JSON.stringify(db.query("SELECT name FROM sqlite_master ORDER BY name").all()); } finally { db.close(); } };
  const schema = tables();
  const receipt = JSON.parse(await r.cli(["forget", id, "--json"]));
  expect(receipt.nearby.capture.ids).toEqual([`capture:${capId}`]);
  expect(tables()).toBe(schema);
  expect(files()).toEqual(before);
});

test("doctor adds an informational masked row only when forget ops exist, and never raises attention", async () => {
  const r = rig(), id = r.note(LEAK);
  const before = JSON.parse(await r.cli(["doctor", "--json"]));
  expect(before.sections.masked).toBeUndefined();
  expect(await r.cli(["doctor"])).not.toContain("masked:");
  await r.cli(["forget", id]);
  const after = JSON.parse(await r.cli(["doctor", "--json"]));
  expect(after.schema).toBe("amem.doctor/v1");
  expect(after.sections.masked).toEqual({ status: "ok", forgets: 1, prunes: 0, note: "masked entries stay in the local log and in sync history; see docs/purge.md" });
  expect(after.status).toBe(before.status);
  const text = await r.cli(["doctor"]);
  expect(text).toContain("masked: forgotten or pruned entries (informational)"); expect(text).toContain("docs/purge.md"); expect(text).not.toContain(LEAK);
  for (const key of Object.keys(before.sections)) expect(Object.keys(after.sections)).toContain(key);
});
