/** Compatibility pin for the on-disk worker/control code, not an authentication credential. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// ponytail: this pins the worker/control/policy modules and package metadata. Same-version edits to other
// dependencies retain the host's module-loader trust ceiling; a host-attested immutable package graph is the upgrade.
export function inboxWorkerHash(): string | undefined {
  try {
    const files = ["./inbox-worker.ts", "./inbox-cache.ts", "./inbox.ts", "./inbox-worker-version.ts", "../memory/candidates.ts", "../memory/policy.ts", "../memory/config.ts", "../memory/platform.ts", "../../package.json"];
    const hash = createHash("sha256");
    for (const file of files) hash.update(JSON.stringify([file, createHash("sha256").update(readFileSync(new URL(file, import.meta.url))).digest("hex")]));
    return hash.digest("hex");
  } catch { return undefined; }
}
