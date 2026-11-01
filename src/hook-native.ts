import { createHash, randomBytes } from "node:crypto";
import { combineRssSources, processImageMemory, rssSource, selectHookRss, type HookRssSources } from "./hook-resources.ts";

export interface HookNativeUsage { rssKB: number; rawRssKB: number; rssSources?: HookRssSources }
// One native supervisor, with a native sleep watchdog rather than another Bun boot.
// The leader waits for its watchdog even after stdin EOF, so losing the calling CLI
// cannot let the owned command outlive the same remaining per-call deadline.
const SUPERVISOR = [
  'marker=$1; seconds=$2; shift 2; leader=$$',
  // Fixed ps plus the unguessable invocation marker guards an externally killed/reused
  // leader too. Normal completion never exits the leader before its group is reaped.
  'owned() { identity=$(/bin/ps -ww -p "$leader" -o pgid=,command=) || return 1; case "$identity" in *"$marker"*) ;; *) return 1 ;; esac; set -f; set -- $identity; [ "$1" = "$leader" ]; }',
  "rss() { [ -r \"/proc/$leader/status\" ] || return 0; trap '' PIPE; hwm=0; virtual=0; while read -r key value unit rest; do case \"$key\" in VmPeak:) virtual=$value ;; VmHWM:) hwm=$value; break ;; esac; done < \"/proc/$leader/status\"; printf \"%s:RSS:%s:%s\\n\" \"$marker\" \"$hwm\" \"$virtual\" >&2; trap - PIPE; }",
  'reap() { if owned; then rss; kill -KILL "-$leader"; fi; }',
  '[ -x /bin/sleep ] && [ -x /bin/ps ] && owned || exit 125',
  'trap reap EXIT HUP INT TERM',
  '( /bin/sleep "$seconds" & sleeper=$!; kill -0 "$sleeper" 2>/dev/null || { reap; exit 125; }; printf "\\n%s:ARMED\\n" "$marker"; wait "$sleeper"; reap ) & watchdog=$!',
  'kill -0 "$watchdog" 2>/dev/null || { reap; exit 125; }',
  '"$@" </dev/null 2>/dev/null; code=$?; rss; printf "\\n%s:%s\\n" "$marker" "$code"',
  'read -r ignored || :',
  'wait "$watchdog"',
].join("; ");

export async function hookNative(argv: readonly string[], env: NodeJS.ProcessEnv, timeRemaining: () => number, usage: HookNativeUsage, signal?: AbortSignal): Promise<{ status: number; stdout: string }> {
  if (signal?.aborted) throw new Error("native metadata cancelled");
  const remaining = timeRemaining();
  if (!Number.isFinite(remaining) || remaining <= 1) throw new Error("native metadata deadline");
  const marker = `AMEM_META_${randomBytes(16).toString("hex")}`, prefix = `\n${marker}:`, armedFrame = `${prefix}ARMED\n`;
  const child = Bun.spawn(["/bin/sh", "-c", SUPERVISOR, "amem-hook-native", marker, String(remaining / 1000), ...argv],
    { env, detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let exited = false, ownPeak = 0;
  let reportedPeak = 0, reportedVirtual = 0, ownVirtual = 0, receiptValid = true;
  const rssReader = child.stderr.getReader();
  // A separate numeric channel survives a late parent read after the watchdog exits.
  // Command stderr remains discarded, as before; only the fixed supervisor writes here.
  const rssReceipt = (async () => {
    let pending = "", bytes = 0;
    try {
      for (;;) {
        const next = await rssReader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 4096) { receiptValid = false; break; }
        pending += new TextDecoder("utf-8", { fatal: true }).decode(next.value);
        for (;;) {
          const newline = pending.indexOf("\n"); if (newline < 0) break;
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          const prefix = `${marker}:RSS:`, value = line.startsWith(prefix) ? line.slice(prefix.length) : "";
          const fields = /^(\d+):(\d+)$/.exec(value);
          const peak = fields ? Number(fields[1]) : -1, virtual = fields ? Number(fields[2]) : -1;
          if (Number.isSafeInteger(peak) && peak >= 0 && Number.isSafeInteger(virtual) && virtual >= 0) {
            reportedPeak = Math.max(reportedPeak, peak); reportedVirtual = Math.max(reportedVirtual, virtual);
          } else receiptValid = false;
        }
      }
      if (pending) receiptValid = false;
    } catch { receiptValid = false; }
    finally { await rssReader.cancel().catch(() => {}); rssReader.releaseLock(); }
  })();
  const exit = child.exited.then(code => { exited = true; return code; });
  const stop = () => {
    if (exited) return;
    const image = processImageMemory(child.pid);
    ownPeak = Math.max(ownPeak, image.hwmKB ?? 0); ownVirtual = Math.max(ownVirtual, image.virtualKB ?? 0);
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
  };
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
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
    }), new Promise<never>((_, reject) => {
      aborted = () => { stop(); reject(new Error("native metadata cancelled")); };
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    })]);
  } finally {
    if (aborted) signal?.removeEventListener("abort", aborted);
    if (timer) clearTimeout(timer);
    stop();
    // SIGKILL was delivered to every member before waiting for our owned leader.
    // Init can briefly retain zombie grandchildren; they cannot execute, and only
    // their adopting reaper can remove those PIDs (we cannot waitpid a non-child).
    await exit;
    await rssReceipt;
    try { child.stdin.end(); } catch { /* pipe closed with the owned leader */ }
    await reader.cancel().catch(() => {}); reader.releaseLock();
    const raw = (child.resourceUsage()?.maxRSS ?? 0) / 1024;
    const selected = selectHookRss(process.platform, Math.max(ownPeak, receiptValid ? reportedPeak : 0), raw, Math.max(ownVirtual, receiptValid ? reportedVirtual : 0));
    usage.rawRssKB = Math.max(usage.rawRssKB, raw);
    usage.rssKB = Math.max(usage.rssKB, selected.kb);
    usage.rssSources = combineRssSources(usage.rssSources, rssSource(selected));
  }
}

/** Same pinned ps format/hash as the shared process identity helper, with bounded owned native work. */
export async function hookProcessSignature(timeRemaining: () => number, usage: HookNativeUsage): Promise<string> {
  const result = await hookNative(["/bin/ps", "-p", String(process.pid), "-o", "lstart=,comm="],
    { PATH: process.env.PATH ?? "", LC_ALL: "C", TZ: "UTC" }, timeRemaining, usage);
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("native process identity unavailable");
  return createHash("sha256").update(result.stdout.trim()).digest("hex");
}
