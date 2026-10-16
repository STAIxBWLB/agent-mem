import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON_ONLY, runCli } from "../src/cli.ts";
import { commandHelp, completionDefinitions, parseCommand } from "../src/commands-table.ts";
import { completionScript } from "../src/completion.ts";
import { CandidateStore, candidateTargetRevision } from "../src/memory/candidates.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";

const homes: string[] = [];
const oldHome = process.env.AGENTHUB_HOME, oldAmem = process.env.AMEM_HOME;
afterEach(() => {
  if (oldHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = oldHome;
  if (oldAmem === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldAmem;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-candidate-cli-")); homes.push(root);
  const home = join(root, "memory"); process.env.AMEM_HOME = home;
  const project = memoryProjectKey(root);
  return { root, home, project, context: { cwd: root, env: {}, stdinTTY: true } };
}
function put(project: string, cause = "a reproducible synthetic cause"): string {
  const candidates = new CandidateStore();
  try { return candidates.put({ project, kind: "fail", approach: "synthetic approach", symptom: "retained fixture symptom", cause, evidenceRefs: ["test:synthetic"], retryWhen: "the regression passes" }, "public"); }
  finally { candidates.close(); }
}

test("review refuses all agent markers before opening either memory store", async () => {
  const f = fixture();
  for (const marker of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) {
    for (const args of [["review"], ["review", "--help"], ["review", "accept", "a".repeat(64), "--policy-free"], ["review", "reject", "a".repeat(64)]]) {
      await expect(runCli(args, { ...f.context, env: { [marker]: "" } })).rejects.toThrow(PERSON_ONLY);
    }
  }
  expect(existsSync(f.home)).toBe(false);
});

test("review defaults to list, supports filters and JSON, and opens no ordinary index or log", async () => {
  const f = fixture(), id = put(f.project);
  const other = put("bench/other-project");
  const rows = JSON.parse(await runCli(["review", "--json"], f.context));
  expect(rows).toHaveLength(1); expect(rows[0].id).toBe(id); expect(rows[0].id).not.toBe(other);
  expect(JSON.parse(await runCli(["review", "list", "--status", "all", "--kind", "decay", "--json"], f.context))).toEqual([]);
  expect(await runCli(["review"], f.context)).toContain(id);
  for (const path of ["index.db", "log", "local", "machine.json"]) expect(existsSync(join(f.home, path))).toBe(false);
});

test("review acceptance and rejection require TTY, acceptance also requires policy-free, before store access", async () => {
  const f = fixture(), id = "a".repeat(64);
  await expect(runCli(["review", "accept", id, "--policy-free"], { ...f.context, stdinTTY: false })).rejects.toThrow("terminal on stdin");
  await expect(runCli(["review", "reject", id], { ...f.context, stdinTTY: false })).rejects.toThrow("terminal on stdin");
  await expect(runCli(["review", "accept", id], f.context)).rejects.toThrow("use ahub memory");
  await expect(runCli(["review", "reject", "a".repeat(8)], f.context)).rejects.toThrow("full 64-character");
  expect(existsSync(f.home)).toBe(false);
});

test("review accept writes a provenance-bound long-term fail without promoting unrelated held notes", async () => {
  const f = fixture(), task = `${f.project}#7@1`;
  const store = new MemoryStore({ screen: () => "skip" });
  const held = store.note({ op: "note", project: f.project, scope: "project", tier: "short", kind: "contract", peer: "codex", task, text: "an unrelated held contract", about: [], source: "person" });
  expect(store.settle(task, "person")).toBe(0); store.close();
  const id = put(f.project);
  const accepted = JSON.parse(await runCli(["review", "accept", id, "--policy-free", "--json"], f.context));
  expect(accepted.candidateId).toBe(id); expect(accepted.alreadyAccepted).toBe(false);
  const check = new MemoryStore({ screen: () => "skip" });
  try {
    const note = check.get(accepted.noteId, f.project)!;
    expect(note).toMatchObject({ tier: "long", scope: "project", kind: "fail", peer: "person", source: "person" });
    expect(note.text).toContain(`Accepted candidate: ${id}`); expect(note.text).toContain("Target revision: none");
    expect(note.text).toContain("Target entry: none"); expect(check.get(held, f.project)?.tier).toBe("short");
    expect(check.counts(f.project).long).toBe(1);
  } finally { check.close(); }
  const candidates = new CandidateStore();
  try { expect(candidates.get(id, f.project)?.status).toBe("accepted"); } finally { candidates.close(); }
});

test("review accepts a correction with its target tier and scope through ordinary supersede", async () => {
  const f = fixture(), store = new MemoryStore({ screen: () => "skip" });
  const target = store.note({ op: "note", project: f.project, scope: "shared", tier: "long", kind: "contract", peer: "person", text: "original synthetic contract", about: [], source: "person" });
  const revision = candidateTargetRevision(store.get(target, f.project)!); store.close();
  const candidates = new CandidateStore();
  const id = candidates.put({ project: f.project, kind: "correction", target: { id: target, revision }, proposedText: "corrected synthetic contract", reason: "retained test evidence" }, "public"); candidates.close();
  const result = JSON.parse(await runCli(["review", "accept", id, "--policy-free", "--json"], f.context));
  const check = new MemoryStore({ screen: () => "skip" });
  try {
    expect(check.get(result.noteId, f.project)).toMatchObject({ tier: "long", scope: "shared", kind: "contract" });
    expect(check.get(target, f.project)?.supersededBy).toBe(result.noteId);
    expect(check.list({ project: f.project }).map(note => note.id)).toEqual([result.noteId]);
  } finally { check.close(); }
});

test("review accept refuses secret-looking candidate input and leaves it pending", async () => {
  const f = fixture(), id = put(f.project, "password: synthetic-fixture-only");
  await expect(runCli(["review", "accept", id, "--policy-free"], f.context)).rejects.toThrow("current host policy");
  const store = new MemoryStore({ screen: () => "skip" });
  try { expect(store.list({ project: f.project })).toEqual([]); } finally { store.close(); }
  const candidates = new CandidateStore();
  try { expect(candidates.get(id, f.project)?.status).toBe("pending"); } finally { candidates.close(); }
});

test("review reject changes only the sidecar and accepts no prefix, while decay stays listing-only", async () => {
  const f = fixture(), id = put(f.project);
  expect(JSON.parse(await runCli(["review", "reject", id, "--json"], f.context))).toEqual({ candidateId: id, status: "rejected" });
  expect(JSON.parse(await runCli(["review", "--json"], f.context))).toEqual([]);
  expect(JSON.parse(await runCli(["review", "--status", "rejected", "--json"], f.context))[0].id).toBe(id);
  expect(existsSync(join(f.home, "index.db"))).toBe(false);
  const candidates = new CandidateStore();
  const decay = candidates.put({ project: f.project, kind: "decay", target: { id: "b".repeat(32), revision: "c".repeat(64) }, reason: "synthetic stale hint" }, "public"); candidates.close();
  await expect(runCli(["review", "accept", decay, "--policy-free"], f.context)).rejects.toThrow("listing-only");
  expect(existsSync(join(f.home, "index.db"))).toBe(false);
});

test("review command definitions feed parser, help and static completion together", () => {
  expect(parseCommand(["review", "--kind", "fail", "--status", "all"]).path).toEqual(["review", "list"]);
  expect(() => parseCommand(["review", "--kind", "contract"])).toThrow();
  const definitions = completionDefinitions();
  for (const path of ["review", "review list", "review accept", "review reject"]) expect(definitions.some(row => row.path.join(" ") === path)).toBe(true);
  expect(commandHelp()).toContain("review accept <full-candidate-id>");
  for (const shell of ["zsh", "bash", "fish"]) {
    const script = completionScript(shell);
    expect(script).toContain("children:review:"); expect(script).toContain("accept"); expect(script).toContain("reject");
    expect(script).not.toContain("candidates.db");
  }
});
