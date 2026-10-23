import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Machine { id: string; label: string }
/** Random per `~/.agenthub`, with a person-given label; created on first use. */
export function machineId(dir: string): Machine {
  const file = join(dir, "machine.json");
  const read = (): Machine | undefined => {
    try {
      const m = JSON.parse(readFileSync(file, "utf8")) as Machine;
      if (/^[0-9a-f]{16}$/.test(m?.id)) return { id: m.id, label: typeof m.label === "string" ? m.label : m.id };
    } catch { /* none, or unreadable */ }
    return undefined;
  };
  const found = read();
  if (found) return found;
  // Hubs of several projects can start at once on a fresh home: each writes its own temp file and links it into place,
  // which fails if another got there first; then everyone reads the one identity that won.
  const id = randomBytes(8).toString("hex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ id, label: id }) + "\n", { mode: 0o600 });
  try { linkSync(tmp, file); } catch { /* another process created it: its identity wins */ } finally { rmSync(tmp, { force: true }); }
  // A file that is there but holds no valid id is never overwritten (another process may be reading it): the store
  // fails to open, so the hub says hub memory is unavailable instead of filing notes under no machine.
  const won = read();
  if (!won) throw new Error(`${file} holds no valid machine id; remove it and a new one is made`);
  return won;
}

