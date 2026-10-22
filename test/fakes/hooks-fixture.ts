import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryStore } from "../../src/memory/store.ts";
import { WorkListStore } from "../../src/memory/work-lists.ts";
import { CaptureStore } from "../../src/memory/capture.ts";
import { memoryProjectKey } from "../../src/memory/project.ts";
import { realPath } from "../../src/memory/platform.ts";

export const hookEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"] as const;
export const hookBin = resolve(import.meta.dir, "../../bin/amem.js");
export const workMarker = "p3-work-marker";
export function hookFixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-hooks-"))), cwd = join(root, "project"), base = join(root, "memory");
  const home = join(root, "home"); mkdirSync(cwd); mkdirSync(home);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, AMEM_HOME: base, AGENTHUB_HOME: root, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", CLAUDECODE: "1", CODEX_HOME: join(home, ".codex") };
  const git = Bun.spawnSync(["git", "init", "--quiet", cwd], { env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  if (git.exitCode !== 0) throw new Error("fixture git init failed");
  const project = memoryProjectKey(cwd);
  return { root, cwd, base, env, project,
    close: () => rmSync(root, { recursive: true, force: true }),
    run(event: string, payload: unknown = {}, extra: NodeJS.ProcessEnv = {}) {
      return Bun.spawnSync([process.execPath, hookBin, "hook", event], { cwd, env: { ...env, ...extra }, stdin: typeof payload === "string" ? Buffer.from(payload) : Buffer.from(JSON.stringify({ session_id: "p3-fixture", hook_event_name: event, cwd, ...payload as object })), stdout: "pipe", stderr: "pipe", timeout: 3000 });
    },
    rows() { const capture = new CaptureStore({ home: root, project }); try { return capture.rows({ project }); } finally { capture.close(); } },
    async seed() {
      const store = new MemoryStore({ home: root, screen: () => "keep" });
      try { store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "fixture", text: "p3 curated public fixture", about: [], source: "person" }); } finally { store.close(); }
      const work = new WorkListStore({ base, project, policy: () => true });
      try { await work.write("p3-budget-work", { task: workMarker, status: "doing" }); } finally { work.close(); }
      const capture = new CaptureStore({ home: root, project });
      try { capture.append({ project, agent: "fixture", event: "PostToolUse", excerpt: "p3 public capture fixture" }); } finally { capture.close(); }
    },
  };
}
