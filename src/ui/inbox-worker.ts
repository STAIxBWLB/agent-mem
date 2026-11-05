/** One-shot, owned background process. Never imported by the console request handler. */
import { processSignature } from "../memory/platform.ts";
import { computeInbox, inboxSources, type CapacityMemo } from "./inbox.ts";

process.once("disconnect", () => process.exit());
process.once("message", (message: unknown) => {
  try {
    const input = message as { type?: unknown; base?: unknown; capacity?: CapacityMemo };
    if (input.type !== "run" || typeof input.base !== "string") throw Error("invalid inbox job");
    const before = inboxSources(input.base), computation = computeInbox(input.base, input.capacity), after = inboxSources(input.base);
    const result = before.version === after.version ? { type: "result", computation, sources: after } : { type: "changed" };
    process.send?.(result, () => process.disconnect());
  } catch {
    // No source text, paths, literal patterns or caller error messages cross the error channel.
    process.send?.({ type: "failed" }, () => process.disconnect());
  }
});
process.send?.({ type: "ready", pid: process.pid, signature: processSignature(process.pid) });
