import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export interface HookNativeUsage { rssKB: number; rawRssKB: number }
// One native supervisor, with a native sleep watchdog rather than another Bun boot.
// The leader waits for its watchdog even after stdin EOF, so losing the calling CLI
// cannot let the owned command outlive the same remaining per-call deadline.
const SUPERVISOR = [
  'marker=$1; seconds=$2; shift 2; leader=$$',
  // Fixed ps plus the unguessable invocation marker guards an externally killed/reused
  // leader too. Normal completion never exits the leader before its group is reaped.
  'owned() { identity=$(/bin/ps -ww -p "$leader" -o pgid=,command=) || return 1; case "$identity" in *"$marker"*) ;; *) return 1 ;; esac; set -f; set -- $identity; [ "$1" = "$leader" ]; }',
  'reap() { if owned; then kill -KILL "-$leader"; fi; }',
  '[ -x /bin/sleep ] && [ -x /bin/ps ] && owned || exit 125',
  'trap reap EXIT HUP INT TERM',
  '( /bin/sleep "$seconds" & sleeper=$!; kill -0 "$sleeper" 2>/dev/null || { reap; exit 125; }; printf "\\n%s:ARMED\\n" "$marker"; wait "$sleeper"; reap ) & watchdog=$!',
  'kill -0 "$watchdog" 2>/dev/null || { reap; exit 125; }',
  '"$@" </dev/null; code=$?; printf "\\n%s:%s\\n" "$marker" "$code"',
  'read -r ignored || :',
  'wait "$watchdog"',
].join("; ");

export async function hookNative(argv: readonly string[], env: NodeJS.ProcessEnv, timeRemaining: () => number, usage: HookNativeUsage): Promise<{ status: number; stdout: string }> {
  const remaining = timeRemaining();
  if (!Number.isFinite(remaining) || remaining <= 1) throw new Error("native metadata deadline");
  const marker = `AMEM_META_${randomBytes(16).toString("hex")}`, prefix = `\n${marker}:`, armedFrame = `${prefix}ARMED\n`;
  const child = Bun.spawn(["/bin/sh", "-c", SUPERVISOR, "amem-hook-native", marker, String(remaining / 1000), ...argv],
    { env, detached: true, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  let exited = false, ownPeak = 0;
  const exit = child.exited.then(code => { exited = true; return code; });
  const stop = () => {
    if (exited) return;
    if (process.platform === "linux") try {
      const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${child.pid}/status`, "utf8"));
      if (match && Number.isSafeInteger(Number(match[1]))) ownPeak = Number(match[1]);
    } catch { /* Fall back conservatively to reaped rusage. */ }
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
  };
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      let text = "", bytes = 0, armed = false;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (;;) {
        const next = await reader.read();
        if (next.done) throw new Error("native metadata incomplete");
        bytes += next.value.byteLength;
        if (bytes > 64 * 1024 + 128) throw new Error("native metadata bound");
        text += decoder.decode(next.value, { stream: true });
        if (text.includes(armedFrame)) { text = text.replace(armedFrame, ""); armed = true; }
        const at = text.indexOf(prefix);
        if (at < 0) continue;
        const code = /^(\d{1,3})\n/.exec(text.slice(at + prefix.length));
        if (!code || !armed) continue;
        const status = Number(code[1]);
        if (status > 255 || Buffer.byteLength(text.slice(0, at)) >= 64 * 1024) throw new Error("native metadata invalid");
        return { status, stdout: text.slice(0, at) };
      }
    };
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { stop(); reject(new Error("native metadata deadline")); }, remaining);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    stop();
    // SIGKILL was delivered to every member before waiting for our owned leader.
    // Init can briefly retain zombie grandchildren; they cannot execute, and only
    // their adopting reaper can remove those PIDs (we cannot waitpid a non-child).
    await exit;
    try { child.stdin.end(); } catch { /* pipe closed with the owned leader */ }
    await reader.cancel().catch(() => {}); reader.releaseLock();
    const raw = (child.resourceUsage()?.maxRSS ?? 0) / 1024;
    usage.rawRssKB = Math.max(usage.rawRssKB, raw);
    usage.rssKB = Math.max(usage.rssKB, process.platform === "linux" ? ownPeak || raw : Math.max(ownPeak, raw));
  }
}

/** Same pinned ps format/hash as the shared process identity helper, with bounded owned native work. */
export async function hookProcessSignature(timeRemaining: () => number, usage: HookNativeUsage): Promise<string> {
  const result = await hookNative(["/bin/ps", "-p", String(process.pid), "-o", "lstart=,comm="],
    { PATH: process.env.PATH ?? "", LC_ALL: "C", TZ: "UTC" }, timeRemaining, usage);
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("native process identity unavailable");
  return createHash("sha256").update(result.stdout.trim()).digest("hex");
}
