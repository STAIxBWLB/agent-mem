/**
 * Argument vector that runs `command` (a plain shell command line) with a pseudo-terminal as its stdin and stdout. The two `script` implementations take different
 * arguments: BSD/macOS `script -q /dev/null sh -c CMD` and util-linux `script -q -e -c CMD /dev/null` (`-e` returns the child's exit status, `-c` names the command; the BSD
 * form on Linux silently runs nothing useful). Undefined when `script` is not installed, so a caller can skip with a stated reason; a platform this does not know fails loudly.
 */
export function ptyArgv(command: string, platform: string = process.platform, which: (name: string) => string | null = name => Bun.which(name)): string[] | undefined {
  if (which("script") === null) return undefined;
  if (platform === "darwin") return ["script", "-q", "/dev/null", "sh", "-c", command];
  if (platform === "linux") return ["script", "-q", "-e", "-c", command, "/dev/null"];
  throw new Error(`no known \`script\` argument form for platform ${platform}`);
}
