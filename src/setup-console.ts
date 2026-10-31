import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export interface ConsoleSetup { file: string; module: string; change: "add" | "replace" | "unchanged" | "remove" | "none"; reason?: string }

/**
 * `amem setup console`: the acon plugin manifest `{api, tool, module, sha256}` at `$AGENTHUB_HOME/console/plugins/amem.json`, in a 0700 directory
 * and a 0600 file, which is what agent-console's scanPlugins accepts. Preview writes nothing; undo removes only a manifest that points at this install.
 */
export function consoleSetup(mode: "preview" | "apply" | "undo", env: Readonly<Record<string, string | undefined>> = process.env,
  module = fileURLToPath(new URL("./ui/plugin.ts", import.meta.url))): ConsoleSetup {
  const family = env.AGENTHUB_HOME?.trim() ? resolve(env.AGENTHUB_HOME) : join(env.HOME?.trim() || homedir(), ".agenthub");
  const dir = join(family, "console", "plugins"), file = join(dir, "amem.json");
  // acon refuses a manifest directory or file that is a link, another kind of entry or another user's; so does setup, before writing anything.
  for (const [path, kind] of [[dir, "directory"], [file, "file"]] as const) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) continue;
    if (kind === "directory" ? !info.isDirectory() : !info.isFile()) throw Error(`${path}: acon needs a real ${kind}, not a link or another entry`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw Error(`${path} is owned by another user; acon would refuse it`);
  }
  const before = lstatSync(file, { throwIfNoEntry: false }) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : undefined;
  if (mode === "undo") {
    if (!before) return { file, module, change: "none", reason: "no console manifest" };
    if (before.module !== module) throw Error(`${file} points at another amem install (${String(before.module)}); left as is`);
    unlinkSync(file);
    return { file, module, change: "remove" };
  }
  const next = { api: 1, tool: "amem", module, sha256: createHash("sha256").update(readFileSync(module)).digest("hex") };
  const mode7 = (path: string, want: number) => (lstatSync(path, { throwIfNoEntry: false })?.mode ?? want) & 0o777;
  const modesOk = mode7(dir, 0o700) === 0o700 && mode7(file, 0o600) === 0o600;
  if (isDeepStrictEqual(before, next) && modesOk) return { file, module, change: "unchanged" };
  const change = before ? "replace" : "add";
  if (mode === "apply") {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
    chmodSync(file, 0o600);
  }
  return { file, module, change, ...(modesOk ? {} : { reason: "permissions: plugin directory 0700, manifest 0600" }) };
}

export const consoleSetupText = (result: ConsoleSetup, mode: "preview" | "apply" | "undo"): string =>
  `console plugin: ${mode === "preview" && result.change !== "unchanged" && result.change !== "none" ? `would ${result.change}` : result.change} ${result.file}${result.change === "remove" || result.change === "none" ? "" : ` -> ${result.module}`}${result.reason ? ` (${result.reason})` : ""}`
  + (mode === "preview" && result.change !== "unchanged" ? "\nPreview only; add --apply to write it, --undo to remove it. Re-run after upgrading amem: acon refuses a module whose hash changed." : "");
