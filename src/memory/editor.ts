import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Launch the person's editor on a private temporary file and return what they wrote. Import-light on purpose (node built-ins only).
 *
 * - `$VISUAL` then `$EDITOR`; an EMPTY `VISUAL` does not hide a set `EDITOR` (`||`, not `??`).
 * - The command is run without a shell. A value that names an existing file is one command (so an editor path with a space works unquoted); otherwise it is split like a shell
 *   would for quotes and backslashes only (`"/path with space/code" --wait`), with no expansion of variables, globs or substitutions.
 * - SIGINT is ignored in this process while the editor runs (as git does), so Ctrl-C reaches the editor and not us: we are still here afterwards to remove the note text. A SIGKILL or
 *   a power cut can still leave it, in a 0700 directory as a 0600 file, under the person's own temporary directory.
 * - An editor that is killed by a signal, or exits non-zero, writes nothing.
 */
export interface EditorSpawn { (argv: string[]): { exitCode: number | null; signalCode?: string | number | null } }
const spawnReal: EditorSpawn = argv => { const done = Bun.spawnSync(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); return { exitCode: done.exitCode, signalCode: done.signalCode ?? null }; };

export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let current = "", started = false, quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && (command[i + 1] === '"' || command[i + 1] === "\\")) current += command[++i];
      else current += c;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === "\\" && i + 1 < command.length) { current += command[++i]; started = true; }
    else if (/\s/.test(c)) { if (started || current) { out.push(current); current = ""; started = false; } }
    else { current += c; started = true; }
  }
  if (quote) throw new Error("the editor command has an unclosed quote");
  if (started || current) out.push(current);
  return out;
}

export function editorArgv(env: Readonly<Record<string, string | undefined>>, file: string): string[] {
  const editor = (env.VISUAL?.trim() || env.EDITOR?.trim() || "");
  if (!editor) throw new Error("no editor: set $VISUAL or $EDITOR, or pass the text as an argument");
  const argv = existsSync(editor) ? [editor] : splitCommand(editor);
  if (!argv.length) throw new Error("no editor: $VISUAL or $EDITOR names no command");
  return [...argv, file];
}

export function runEditor(env: Readonly<Record<string, string | undefined>>, initial: string, spawn: EditorSpawn = spawnReal): string {
  const dir = mkdtempSync(join(tmpdir(), "amem-note-")), file = join(dir, "note.txt");
  const ignore = () => { /* Ctrl-C belongs to the editor while it runs */ };
  try {
    const argv = editorArgv(env, file);
    writeFileSync(file, initial, { mode: 0o600 });
    process.on("SIGINT", ignore);
    let done: ReturnType<EditorSpawn>;
    try { done = spawn(argv); } finally { process.off("SIGINT", ignore); }
    if (done.signalCode !== null && done.signalCode !== undefined) throw new Error(`the editor was stopped by ${done.signalCode}; nothing was written`);
    if (done.exitCode !== 0) throw new Error(`the editor exited with status ${done.exitCode ?? "unknown"}; nothing was written`);
    return readFileSync(file, "utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
