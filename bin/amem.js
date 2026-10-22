#!/usr/bin/env bun
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
    const started = performance.now() - process.uptime() * 1000;
    const { hookMain } = await import("../src/hooks.ts");
    const output = await hookMain(args.slice(1), started);
    if (output) console.log(output);
  } catch { /* Context-only hooks never deny a native action. */ }
} else {
  const { main } = await import("../src/cli.ts");
  await main(args);
}
