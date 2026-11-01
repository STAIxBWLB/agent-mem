import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { realPath } from "../src/memory/platform.ts";
import { jcodeHookCapture } from "../src/hook-jcode.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const fixture = () => { const f = hookFixture(); fixtures.push(f); return f; };

// jcode v0.99.1 observers: no stdin, stdout discarded, everything in the environment (crates/jcode-base/src/hooks.rs).
const postTool = (cwd: string, extra: Record<string, string> = {}) => ({ JCODE_HOOK_EVENT: "post_tool", JCODE_HOOK_SESSION_ID: "session_jcode_fixture", JCODE_HOOK_CWD: cwd,
  JCODE_HOOK_TOOL_NAME: "edit", JCODE_HOOK_TOOL_INPUT: JSON.stringify({ file_path: join(cwd, "src", "a.ts"), old_string: "x", new_string: "y" }),
  JCODE_HOOK_TOUCHED_PATHS: join(cwd, "src", "a.ts"), JCODE_HOOK_STATUS: "ok", JCODE_HOOK_DURATION_MS: "3", JCODE_HOOKS_DISABLED: "1", ...extra });
const turnEnd = (cwd: string, text: string, extra: Record<string, string> = {}) => ({ JCODE_HOOK_EVENT: "turn_end", JCODE_HOOK_SESSION_ID: "session_jcode_fixture", JCODE_HOOK_CWD: cwd,
  JCODE_HOOK_STATUS: "ok", JCODE_HOOK_LAST_ASSISTANT_TEXT: text, JCODE_HOOK_MODEL: "fixture", JCODE_HOOKS_DISABLED: "1", ...extra });

function runJcode(f: ReturnType<typeof hookFixture>, env: Record<string, string>, cwd = f.cwd) {
  // Functional transport (the real hookMain with a 2 s deadline), as the Claude hook tests use; budgets are measured separately.
  // The first call writes the fixture's functional entry; jcode observers then get no stdin, only the environment.
  const entry = join(f.root, "functional-hook.ts");
  if (!existsSync(entry)) f.runFunctional("SessionEnd", "not json");   // writes the entry; invalid input captures nothing
  return Bun.spawnSync([process.execPath, "--smol", entry, "jcode"], { cwd, env: { ...f.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3000 });
}
const rowsOf = (f: ReturnType<typeof hookFixture>, project: string) => { const c = new CaptureStore({ home: f.root, project }); try { return c.rows({ project }); } finally { c.close(); } };
const spooled = (f: ReturnType<typeof hookFixture>) => [join(f.base, "hook-spool"), join(f.base, "hook-spool", ".capacity")].flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith("hook-")) : []);

function secondProject(f: ReturnType<typeof hookFixture>): { cwd: string; project: string } {
  const cwd = join(f.root, "project-b");
  const git = Bun.spawnSync(["git", "init", "--quiet", cwd], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(git.exitCode).toBe(0);
  return { cwd: realPath(cwd), project: memoryProjectKey(realPath(cwd)) };
}
// Drain: a later event in the same project replays durable pending records.
function settle(f: ReturnType<typeof hookFixture>, cwd: string, project: string, wanted: (rows: ReturnType<typeof rowsOf>) => boolean) {
  for (let i = 0; i < 6 && !wanted(rowsOf(f, project)); i++) runJcode(f, turnEnd(cwd, `settle barrier ${i}`), cwd);
}

test("AC1: post_tool and turn_end each append one jcode row in the project of JCODE_HOOK_CWD, and a later cwd in B lands only in B", () => {
  const f = fixture(), b = secondProject(f);
  expect(runJcode(f, postTool(f.cwd)).exitCode).toBe(0);
  expect(runJcode(f, turnEnd(f.cwd, "jcode assistant text in project A")).exitCode).toBe(0);
  settle(f, f.cwd, f.project, rows => rows.some(row => row.excerpt === "jcode assistant text in project A") && rows.some(row => row.tool === "edit"));
  const a = rowsOf(f, f.project).filter(row => !row.excerpt.startsWith("settle barrier"));
  const tool = a.filter(row => row.tool === "edit"), text = a.filter(row => row.excerpt === "jcode assistant text in project A");
  expect(tool).toHaveLength(1); expect(text).toHaveLength(1);
  expect(tool[0]!.agent).toBe("jcode"); expect(tool[0]!.event).toBe("PostToolUse"); expect(tool[0]!.status).toBe("ok");
  expect(tool[0]!.paths).toEqual([join(f.cwd, "src", "a.ts")]);
  expect(text[0]!.agent).toBe("jcode"); expect(text[0]!.event).toBe("Stop");
  expect(tool[0]!.session).toMatch(/^[a-f0-9]{16}$/); expect(tool[0]!.session).toBe(text[0]!.session);
  // The same session moves to project B (set_working_dir): later events follow their own cwd, earlier rows stay in A.
  expect(runJcode(f, turnEnd(b.cwd, "jcode assistant text in project B"), f.cwd).exitCode).toBe(0);
  settle(f, b.cwd, b.project, rows => rows.some(row => row.excerpt === "jcode assistant text in project B"));
  expect(rowsOf(f, b.project).filter(row => row.excerpt === "jcode assistant text in project B")).toHaveLength(1);
  expect(rowsOf(f, f.project).some(row => row.excerpt.includes("project B"))).toBe(false);
  expect(rowsOf(f, b.project).some(row => row.excerpt.includes("project A") || row.tool === "edit")).toBe(false);
});

test("AC1: a failed tool call is a PostToolUseFailure row carrying the error, never the tool output", () => {
  const f = fixture();
  runJcode(f, postTool(f.cwd, { JCODE_HOOK_STATUS: "error", JCODE_HOOK_ERROR: "jcode fixture failure message" }));
  settle(f, f.cwd, f.project, rows => rows.some(row => row.event === "PostToolUseFailure"));
  const failed = rowsOf(f, f.project).filter(row => row.event === "PostToolUseFailure");
  expect(failed).toHaveLength(1); expect(failed[0]!.status).toBe("failed"); expect(failed[0]!.excerpt).toBe("jcode fixture failure message");
});

test("AC2: missing, relative or non-directory cwd, unknown events, oversized fields and malformed input append nothing and exit 0 quietly", () => {
  const f = fixture();
  const outside = join(f.root, "not-a-project"); mkdirSync(outside);
  const cases: Record<string, string>[] = [
    { ...postTool(f.cwd), JCODE_HOOK_CWD: "" },
    (() => { const env = postTool(f.cwd); delete (env as Record<string, string | undefined>).JCODE_HOOK_CWD; return env; })(),
    { ...postTool(f.cwd), JCODE_HOOK_CWD: "relative/dir" },
    { ...postTool(f.cwd), JCODE_HOOK_CWD: join(f.cwd, "missing") },
    { ...postTool(f.cwd), JCODE_HOOK_EVENT: "pre_tool" },
    { ...postTool(f.cwd), JCODE_HOOK_EVENT: "session_end" },
    { ...postTool(f.cwd), JCODE_HOOK_STATUS: "maybe" },
    { ...postTool(f.cwd), JCODE_HOOK_TOOL_NAME: "" },
    { ...postTool(f.cwd), JCODE_HOOK_TOOL_INPUT: "x".repeat(17 * 1024) },
    turnEnd(f.cwd, "y".repeat(17 * 1024)),
    turnEnd(f.cwd, "   "),
  ];
  for (const env of cases) {
    const result = runJcode(f, env);
    expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe(""); expect(result.stderr.toString()).toBe("");
  }
  expect(spooled(f)).toEqual([]); expect(rowsOf(f, f.project)).toEqual([]);
  // Truncated (non-JSON) TOOL_INPUT keeps the call with its touched paths; a cwd outside any Git project stays unbound.
  expect(jcodeHookCapture(postTool(f.cwd, { JCODE_HOOK_TOOL_INPUT: '{"file_path":"/tr' }))?.input.tool_input).toEqual({ paths: [join(f.cwd, "src", "a.ts")] });
  expect(runJcode(f, turnEnd(outside, "text from a directory outside any project"), outside).exitCode).toBe(0);
  expect(jcodeHookCapture(turnEnd(outside, "outside"))).toBeUndefined();
  expect(spooled(f)).toEqual([]);
  expect(rowsOf(f, f.project).some(row => row.excerpt.includes("outside any project"))).toBe(false);
});

test("the jcode mapping reads only the environment contract and never a prompt", () => {
  const cwd = realPath(process.cwd());
  const mapped = jcodeHookCapture(turnEnd(cwd, "assistant"))!;
  expect(mapped.event).toBe("Stop"); expect(mapped.cwd).toBe(cwd);
  expect(Object.keys(mapped.input).sort()).toEqual(["cwd", "hook_event_name", "last_assistant_message", "session_id"]);
  const tool = jcodeHookCapture(postTool(cwd))!;
  expect(tool.event).toBe("PostToolUse"); expect(tool.input.prompt).toBeUndefined();
  expect(Object.keys(tool.input).sort()).toEqual(["cwd", "hook_event_name", "session_id", "tool_input", "tool_name", "tool_response"]);
});
