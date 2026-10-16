#!/usr/bin/env bun
// Plain JavaScript: refuse Node before it can load TypeScript or bun:sqlite.
const version = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.bun ?? "");
if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && (Number(version[2]) < 4 || (Number(version[2]) === 4 && Number(version[3]) < 2)))) {
  console.error("amem: Bun >=1.4.2 is required. Install Bun: https://bun.sh");
  process.exit(1);
}
const { main } = await import("../src/cli.ts");
await main();
