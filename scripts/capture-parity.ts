import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { entryId, MEMORY_SCHEMA, type NoteEntry } from "../src/memory/store.ts";
import { memoryGitSync } from "../src/memory/platform.ts";

// Explicitly invoked only: capture installed ahub receipts against synthetic, isolated data.
const fixture = resolve(import.meta.dir, "../test/fixtures/parity");
const project = "github.com/example/amem-parity";
const machine = "0123456789abcdef";
const note = (kind: NoteEntry["kind"], text: string, minute: string, tier: NoteEntry["tier"] = "long"): NoteEntry => {
  const row: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note" as const, at: `2026-10-01T00:${minute}:00.000Z`, machine, project,
    scope: "project" as const, tier, kind, peer: "codex", title: `Fixture ${kind}`, text, about: ["path:src/example.ts"], source: "hub" as const,
    ...(tier === "short" ? { expires: "2099-01-01T00:00:00.000Z" } : {}) };
  return { ...row, id: entryId(row) };
};
const rows = [note("contract", "Preserve the append-only contract.", "01"), note("fail", "Keep the failed approach visible.", "02"), note("finding", "A synthetic short-term finding.", "03", "short")];
mkdirSync(join(fixture, "memory/log"), { recursive: true }); mkdirSync(join(fixture, "memory/local"), { recursive: true });
writeFileSync(join(fixture, "memory/machine.json"), JSON.stringify({ id: machine, label: "fixture-machine" }) + "\n");
writeFileSync(join(fixture, `memory/log/${machine}.jsonl`), rows.filter(r => r.tier === "long").map(r => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(join(fixture, `memory/local/${machine}.jsonl`), rows.filter(r => r.tier === "short").map(r => JSON.stringify(r)).join("\n") + "\n");
const root = mkdtempSync(join(tmpdir(), "amem-parity-capture-"));
const env: NodeJS.ProcessEnv = { ...process.env, AGENTHUB_HOME: join(root, "home") };
for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AMEM_HOME", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID"]) delete env[key];
try {
  const cwd = join(root, "project"); mkdirSync(join(cwd, ".agenthub"), { recursive: true }); writeFileSync(join(cwd, ".agenthub/config.json"), "{}\n");
  for (const args of [["init", "-q", cwd], ["-C", cwd, "remote", "add", "origin", "https://github.com/example/amem-parity.git"]]) {
    const r = memoryGitSync(args, { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr);
  }
  cpSync(join(fixture, "memory"), join(root, "home/memory"), { recursive: true });
  const run = (args: string[]) => {
    const r = Bun.spawnSync(["ahub", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode) throw new Error(r.stderr.toString());
    return r.stdout.toString();
  };
  const version = run(["--version"]).trim();
  const commands = { list: ["list", "--json"], show: ["show", rows[0]!.id, "--json"], graph: ["graph", rows[0]!.id, "--json"] };
  for (const [name, args] of Object.entries(commands)) writeFileSync(join(fixture, `${name}.json`), run(["memory", ...args]));
  writeFileSync(join(fixture, "receipt.json"), JSON.stringify({ source: "installed ahub", version, expectedVersion: "0.12.29", project, remote: "https://github.com/example/amem-parity.git", commands }, null, 2) + "\n");
  console.log(`captured installed ahub ${version}: list/show/graph (synthetic data)`);
} finally { rmSync(root, { recursive: true, force: true }); }
