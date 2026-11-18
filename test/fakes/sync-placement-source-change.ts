import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { entryId, type NoteEntry } from "../../src/memory/store.ts";

/** #462: the authored inputs of a curated shard realm, changed the way another writer running beside the sync would. */
export function authoredSegment(dir: string): string {
  const name = readdirSync(join(dir, "log")).find(entry => entry.endsWith(".jsonl"));
  if (!name) throw Error("synthetic fixture has no authored segment to change"); return join(dir, "log", name);
}
/** The next row this machine would author: the file's own template with new text and its recomputed id. */
export function appendedAuthoredLine(dir: string, text = "synthetic row written during the preflight yield"): string {
  const template = JSON.parse(readFileSync(authoredSegment(dir), "utf8").split("\n")[0]!) as NoteEntry;
  const { id: _id, ...body } = template, row = { ...body, text };
  return JSON.stringify({ ...row, id: entryId(row) }) + "\n";
}
export function appendAuthoredLine(dir: string, text?: string): void {
  appendFileSync(authoredSegment(dir), appendedAuthoredLine(dir, text));
}
