import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/store.ts";

/**
 * A note authored on ANOTHER machine, delivered the way a sync pull delivers it: one more `log/<machine id>.jsonl` segment in the home, with this machine's index not told.
 * The row is written by a real store of a throwaway home (so it is a valid, correctly hashed row for a different machine id), then its segment is copied in.
 */
export function machineSegment(home: string, project: string, text: string): void {
  const other = mkdtempSync(join(tmpdir(), "amem-foreign-machine-"));
  try {
    const store = new MemoryStore({ memoryDir: other, deferPromotions: true });
    try { store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "other", source: "person", text, about: [] } as never); } finally { store.close(); }
    for (const name of readdirSync(join(other, "log"))) {
      mkdirSync(join(home, "log"), { recursive: true });
      writeFileSync(join(home, "log", name), readFileSync(join(other, "log", name)));
    }
  } finally { rmSync(other, { recursive: true, force: true }); }
}
