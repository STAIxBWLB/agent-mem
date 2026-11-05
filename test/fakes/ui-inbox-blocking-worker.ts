/** Isolated lifecycle proof: one owned descendant, no real memory reads. The test must close this group. */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { processSignature } from "../../src/memory/platform.ts";

let child: ReturnType<typeof spawn> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const stop = () => {
  if (timer) clearInterval(timer);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.once("close", () => process.exit()); child.kill("SIGTERM");
  } else process.exit();
};
process.once("SIGTERM", stop); process.once("disconnect", stop);
process.once("message", (message: unknown) => {
  const input = message as { type?: unknown; base?: unknown };
  if (input.type !== "run" || typeof input.base !== "string") process.exit(1);
  child = spawn(process.execPath, ["--smol", "-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(join(input.base, "ui-inbox-worker.json"), JSON.stringify({ pid: process.pid, child: child.pid }), { mode: 0o600 });
  timer = setInterval(() => {}, 1000);
});
process.send?.({ type: "ready", pid: process.pid, signature: processSignature(process.pid) });
