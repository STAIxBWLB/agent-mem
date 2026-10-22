import * as fs from "node:fs";
import { join, basename } from "node:path";
import { mock } from "bun:test";

// Test-process-only transparent FS barriers. No timing assumptions or production hooks.
const native = { ...fs };
const [root, mode, barrier] = process.argv.slice(2) as [string, string, string];
let stopped = false;
const descriptors = new Map<number, string>();
function pause() {
  native.writeFileSync(join(root, `${barrier}.ready`), "ready");
  const limit = Date.now() + 10000;
  while (!native.existsSync(join(root, `${barrier}.go`))) {
    if (Date.now() > limit) throw new Error("FS barrier was not released");
    Bun.sleepSync(2);
  }
}
const isSpool = (value: unknown): value is string => typeof value === "string" && basename(value).startsWith("spool");
mock.module("node:fs", () => ({ ...native,
  rmSync(...args: Parameters<typeof fs.rmSync>) {
    if (mode === "ack" && !stopped && String(args[0]).includes("draining")) { stopped = true; pause(); }
    return native.rmSync(...args);
  },
  openSync(...args: Parameters<typeof fs.openSync>) {
    const fd = native.openSync(...args); descriptors.set(fd, String(args[0])); return fd;
  },
  readSync(...args: Parameters<typeof fs.readSync>) {
    const value = native.readSync(...args);
    if (mode === "drain" && !stopped && descriptors.get(args[0])?.includes("draining")) { stopped = true; pause(); }
    return value;
  },
  // readFileSync/appendFileSync retain the old shared-spool baseline for red-first race proofs.
  readFileSync(...args: Parameters<typeof fs.readFileSync>) {
    const value = native.readFileSync(...args);
    if (mode === "drain" && !stopped && isSpool(args[0]) && String(args[0]).includes("draining")) { stopped = true; pause(); }
    return value;
  },
  appendFileSync(file: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) {
    if (mode !== "writer" || stopped || !isSpool(file)) return native.appendFileSync(file, data, options);
    stopped = true;
    const fd = native.openSync(file, "a", 0o600);
    try { pause(); native.writeFileSync(fd, data, options); } finally { native.closeSync(fd); }
  },
  writeFileSync(file: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) {
    if (mode !== "writer" || stopped || !isSpool(file)) return native.writeFileSync(file, data, options);
    stopped = true;
    const fd = native.openSync(file, "w", 0o600);
    try { pause(); native.writeFileSync(fd, data, options); } finally { native.closeSync(fd); }
  },
}));
const { CaptureStore } = await import("../../src/memory/capture.ts");
const store = new CaptureStore({ home: root, project: "proj", machine: "race-machine", busyTimeoutMs: 1 });
try {
  if (mode === "writer" || mode === "publish") store.append({ project: "proj", agent: "race", event: "Stop", excerpt: "open writer row" });
  else store.drain();
} finally { store.close(); }
