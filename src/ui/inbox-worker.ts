/** One-shot, owned background process. Never imported by the console request handler. */
import { DENY_NAMES, DENY_SEGMENTS, processSignatureAsync, processGroupIdAsync } from "../memory/platform.ts";
import { inboxWorkerHash } from "./inbox-worker-version.ts";
import { memoryPolicySnapshot } from "../memory/policy.ts";
import { computeInbox, createInboxSourceTracker, type CapacityMemo, type InboxDefaults } from "./inbox.ts";

process.once("disconnect", () => process.exit());
// Keep the leader identity while synchronous owned children settle or the parent force-kills the group.
process.on("SIGTERM", () => {});
process.once("message", (message: unknown) => {
  try {
    const input = message as { type?: unknown; base?: unknown; capacity?: CapacityMemo; defaults?: InboxDefaults };
    if (input.type !== "run" || typeof input.base !== "string") throw Error("invalid inbox job");
    const defaults = memoryPolicySnapshot(input.defaults);
    if (!defaults || !Array.isArray(defaults.names) || !Array.isArray(defaults.segments)
      || !defaults.names.every(value => typeof value === "string") || !defaults.segments.every(value => typeof value === "string")) throw Error("invalid inbox policy");
    DENY_NAMES.splice(0, DENY_NAMES.length, ...defaults.names); DENY_SEGMENTS.splice(0, DENY_SEGMENTS.length, ...defaults.segments);
    const tracker = createInboxSourceTracker(input.base);
    const computation = computeInbox(input.base, input.capacity, tracker.beforeProject), before = tracker.before(), after = tracker.after();
    const result = before.version === after.version ? { type: "result", computation, sources: after } : { type: "changed" };
    process.send?.(result, () => process.disconnect?.());
  } catch {
    // No source text, paths, literal patterns or caller error messages cross the error channel.
    process.send?.({ type: "failed" }, () => process.disconnect?.());
  }
});
const workerHash = inboxWorkerHash();
if (!workerHash || workerHash !== process.env.AMEM_UI_WORKER_HASH) {
  process.send?.({ type: "moved" }, () => process.disconnect?.());
} else void Promise.all([processSignatureAsync(process.pid), processGroupIdAsync(process.pid)]).then(([signature, group]) => {
  process.send?.({ type: "ready", pid: process.pid, signature, group, workerHash });
});
