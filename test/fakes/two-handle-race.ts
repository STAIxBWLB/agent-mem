// #466 AC2(b) child: a second MemoryStore handle on the parent's home, racing note(), settle() and refresh().
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openShardStore, type NoteInput } from "../../src/memory/store.ts";

const [memoryDir, project, task, barrier, roundsText] = process.argv.slice(2) as [string, string, string, string, string];
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const store = openShardStore({ memoryDir, project, now: () => NOW, screen: () => "promote", deferPromotions: true, ttlMs: 1000 });
const note = (text: string): NoteInput => ({ op: "note", project, scope: "project", tier: "short", kind: "decision", peer: "person", source: "person", task, text, about: [] });
const failures: string[] = [];
writeFileSync(`${barrier}.ready`, "ready");
while (!existsSync(`${barrier}.go`)) await Bun.sleep(1);
for (let round = 0; round < Number(roundsText); round++) {
  for (const step of [() => store.note(note(`child row ${round}`)), () => store.settle(task, "person"), () => store.refresh()]) {
    try { step(); } catch (error) { failures.push(String((error as Error)?.stack ?? error)); }
  }
}
store.close();
writeFileSync(join(`${barrier}.done`), JSON.stringify({ failures }));
