#!/usr/bin/env -S bun --smol
// Plain JavaScript: refuse Node before it can load TypeScript or bun:sqlite.
const version = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.bun ?? "");
if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && (Number(version[2]) < 4 || (Number(version[2]) === 4 && Number(version[3]) < 2)))) {
  console.error("amem: Bun >=1.4.2 is required. Install Bun: https://bun.sh");
  process.exit(1);
}
const args = process.argv.slice(2);
if (args[0] === "hook") {
  // This narrow intake must stay fail-open even if loading the optional hook implementation fails.
  try {
    const absoluteStart = performance.timeOrigin + performance.now() - process.uptime() * 1000;
    // Replace this bootstrap before importing stores/policy. One PID, stdin and process group survive;
    // there is no third resident Bun process and the original invocation still owns the wall budget.
    if (!process.execArgv.includes("--smol")) {
      process.execve(process.execPath, [process.execPath, "--smol", ...process.execArgv, import.meta.path, ...args],
        { ...process.env, AMEM_HOOK_BOOT_AT: String(absoluteStart) });
    }
    const inheritedStart = Number(process.env.AMEM_HOOK_BOOT_AT);
    delete process.env.AMEM_HOOK_BOOT_AT;
    const now = performance.timeOrigin + performance.now();
    const started = (Number.isFinite(inheritedStart) && inheritedStart > 0 && inheritedStart <= now ? Math.min(absoluteStart, inheritedStart) : absoluteStart) - performance.timeOrigin;
    const { hookMain } = await import("../src/hooks.ts");
    const output = await hookMain(args.slice(1), started);
    if (output) console.log(output);
  } catch { /* Context-only hooks never deny a native action. */ }
} else {
  const { main } = await import("../src/cli.ts");
  await main(args);
}
