/** One diagnostic invocation; descendant readings never enter an R2 verdict. */
import { basename } from "node:path";
import { HOOK_RSS_COVERAGE } from "../src/hook-resources.ts";
import { hookBin, hookFixture } from "../test/fakes/hooks-fixture.ts";
import { hookProcessObserver } from "../test/fakes/hooks-process-observer.ts";

const f = hookFixture(), observer = hookProcessObserver(f.root);
let owned: ReturnType<typeof Bun.spawn> | undefined, exited = false;
try {
  await f.seed();
  const child = Bun.spawn([hookBin, "hook", "PostToolUse"], {
    cwd: f.cwd, env: { ...f.env, BUN_OPTIONS: `--preload=${observer.preload}` }, detached: true,
    stdin: Buffer.from(JSON.stringify({ cwd: f.cwd, hook_event_name: "PostToolUse", session_id: "descendant-characterization",
      tool_name: "Read", tool_input: { file_path: "src/public.ts" }, tool_response: "public descendant characterization" })),
    stdout: "pipe", stderr: "pipe", timeout: 3000,
  });
  owned = child;
  const [code, stdout, stderr] = await Promise.all([child.exited.then(value => { exited = true; return value; }), new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0 || stdout.length) throw new Error(`characterization hook failed: ${code}, stderr bytes ${Buffer.byteLength(stderr)}`);
  const images = observer.read(), supervisors = images.filter(row => row.kind === "native");
  // ponytail: PID observation gives no completed descendant rusage handle. An independently
  // authorized per-descendant observer is the upgrade, never an inferred tree total.
  const reason = "resourceUsage() belongs to a Bun-spawned handle after exit. The harness owns the CLI handle; Git and watchdog sleep are spawned natively below supervisors and have no separate Bun handles.";
  console.log(JSON.stringify({ characterization: "hook-descendants/v1", platform: process.platform, bun: Bun.version,
    invocations: 1, includedInGate: false, gateCoverage: HOOK_RSS_COVERAGE,
    cliRawMaxRssBytes: child.resourceUsage()?.maxRSS ?? null, cliUsageScope: "outer CLI handle only; raw rusage is not a process-tree maximum",
    observedOwnedImages: { supervisors: supervisors.length, workers: images.filter(row => row.kind === "worker").length },
    nativeCommandsInSupervisorArgv: [...new Set(supervisors.map(row => basename(row.argv[6]!)))],
    descendants: ["git", "sleep"].map(command => ({ command, maxRssBytes: null, status: "not measured", reason })) }, null, 2));
} finally {
  if (owned) { if (!exited) owned.kill("SIGKILL"); await owned.exited; }
  f.close();
}
