import * as fs from "node:fs";
import { join, basename } from "node:path";
import { mock } from "bun:test";

// Test-process-only transparent FS barriers. No timing assumptions or production hooks.
const [root, mode, barrier] = process.argv.slice(2) as [string, string, string];
let stopped = false;
function pause() {
  fs.writeFileSync(join(root, `${barrier}.ready`), "ready");
  const limit = Date.now() + 10000;
  while (!fs.existsSync(join(root, `${barrier}.go`))) {
    if (Date.now() > limit) throw new Error("FS barrier was not released");
    Bun.sleepSync(2);
  }
}
const isSpool = (value: unknown) => typeof value === "string" && basename(value).startsWith("spool");
mock.module("node:fs", () => ({ ...fs,
  readFileSync(...args: Parameters<typeof fs.readFileSync>) {
    const value = fs.readFileSync(...args);
    if (mode === "drain" && !stopped && isSpool(args[0]) && String(args[0]).includes("draining")) { stopped = true; pause(); }
    return value;
  },
  appendFileSync(file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) {
    if (mode !== "writer" || stopped || !isSpool(file)) return fs.appendFileSync(file, data, options);
    stopped = true;
    const fd = fs.openSync(file, "a", 0o600);
    try { pause(); fs.writeFileSync(fd, data, options); } finally { fs.closeSync(fd); }
  },
  writeFileSync(file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) {
    if (mode !== "writer" || stopped || !isSpool(file)) return fs.writeFileSync(file, data, options);
    stopped = true;
    const fd = fs.openSync(file, "w", 0o600);
    try { pause(); fs.writeFileSync(fd, data, options); } finally { fs.closeSync(fd); }
  },
}));
const { CaptureStore } = await import("../../src/memory/capture.ts");
const store = new CaptureStore({ home: root, project: "proj", machine: "race-machine", busyTimeoutMs: 1 });
try {
  if (mode === "writer") store.append({ project: "proj", agent: "race", event: "Stop", excerpt: "open writer row" });
  else store.drain();
} finally { store.close(); }
