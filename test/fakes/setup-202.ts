import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../../src/memory/platform.ts";
import type { SetupContext } from "../../src/setup.ts";

export function setup202Rig(bun = process.execPath) {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-setup-202-")));
  const env: Record<string, string | undefined> = { HOME: home, AMEM_HOME: join(home, "memory"), PATH: "" };
  const entry = join(home, "package with space", "bin", "amem.js");
  const put = (file: string, value: string) => { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, value, { mode: 0o600 }); chmodSync(file, 0o600); };
  const text = (file: string) => readFileSync(file, "utf8");
  const calls: string[][] = [];
  const native: NonNullable<SetupContext["native"]> = (argv, staged) => {
    calls.push([...argv]);
    const target = argv[0], remove = argv[2] === "remove", marker = argv.indexOf("--");
    if (target !== "claude" && target !== "codex") throw Error("unexpected fixture target");
    const file = target === "claude" ? staged.CLAUDE_CONFIG_DIR ? join(staged.CLAUDE_CONFIG_DIR, ".claude.json") : join(staged.HOME!, ".claude.json") : join(staged.CODEX_HOME!, "config.toml");
    const doc: Record<string, any> = existsSync(file) ? target === "claude" ? JSON.parse(text(file)) : Bun.TOML.parse(text(file)) : {};
    const key = target === "claude" ? "mcpServers" : "mcp_servers";
    doc[key] ??= {};
    if (remove) delete doc[key].amem;
    else doc[key].amem = { command: argv[marker + 1], args: argv.slice(marker + 2) };
    put(file, target === "claude" ? JSON.stringify(doc, null, 2) + "\n" : Bun.TOML.stringify(doc));
  };
  const options: SetupContext = { env, entry, bun, native, stdinTTY: false };
  const normalize = (value: string) => value.replaceAll(home, "<HOME>").replaceAll(bun, "<BUN>").replaceAll(realPath(tmpdir()), "<TMP>");
  return { home, env, entry, bun, options, calls, put, text, normalize, close: () => rmSync(home, { recursive: true, force: true }) };
}
