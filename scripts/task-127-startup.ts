/** Nonshipping trace prefix: numeric entry precedes expensive PID/header observation. */
import { closeSync, constants, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export type StartupStage = "start-record" | "binary-open" | "entry-written" | "header-written";
export function publishStartup(options: { trace: string; callId: string; pid: number; role: string;
  identify(): unknown; afterStage?(stage: StartupStage): void }) {
  const { trace, callId, pid, role } = options, stem = `${callId}-${pid}`;
  const at = performance.timeOrigin + performance.now();
  const prefix = { schema: 1, callId, pid, role, entryAt: at, startupProtocol: 2 };
  writeFileSync(join(trace, stem + ".start.json"), JSON.stringify(prefix) + "\n", { mode: 0o600, flag: "wx" });
  options.afterStage?.("start-record");
  const fd = openSync(join(trace, stem + ".bin"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    options.afterStage?.("binary-open");
    const entry = Buffer.alloc(32); entry.writeUInt32LE(1, 0); entry.writeDoubleLE(at, 8);
    if (writeSync(fd, entry, 0, entry.length, 0) !== entry.length) throw new Error("partial startup entry write");
    options.afterStage?.("entry-written");
    const header = { ...prefix, identity: options.identify(), recordBytes: 32, limit: 512 };
    writeFileSync(join(trace, stem + ".json"), JSON.stringify(header) + "\n", { mode: 0o600, flag: "wx" });
    options.afterStage?.("header-written");
    return { fd, stem, sequence: 1, header };
  } catch (error) { closeSync(fd); throw error; }
}
