#!/usr/bin/env bun
// NONSHIPPING parent. Reuse the existing one-case raw-artifact/recovery probe with only the crash connection factory replaced.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
if (process.argv.includes("--ffi-factory")) throw Error("wrapper selects its own fixture factory");
const here = dirname(fileURLToPath(import.meta.url));
process.argv.push("--ffi-factory", join(here, "cursor-crash-ffi.ts"));
await import(pathToFileURL(join(here, "one-hot-journal-diagnostic.ts")).href);
