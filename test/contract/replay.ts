import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { MemoryStore } from "../../src/memory/store.ts";
import { realPath } from "../../src/memory/platform.ts";
import { GOLDEN_NOW, type GoldenFixture } from "./fixtures.ts";

export type DerivedTables = Record<string, Record<string, unknown>[]>;
/** Every derived table, including complete-prefix hashes and byte offsets. No user-view-only equality. */
export function derivedTables(dir: string): DerivedTables {
  const db = new Database(join(dir, "index.db"), { readonly: true });
  db.run("PRAGMA busy_timeout = 3000");
  try {
    const names = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(names.map(({ name }) => [name, (db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Record<string, unknown>[]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
  } finally { db.close(); }
}

export function authoredLogs(dir: string): Record<string, string> {
  return Object.fromEntries(["log", "local"].flatMap(folder => readdirSync(join(dir, folder)).sort().filter(name => name.endsWith(".jsonl")).map(name => [`${folder}/${name}`, readFileSync(join(dir, folder, name), "utf8")])));
}
export const fixturePath = (fixture: GoldenFixture) => `${fixture.placement}/${fixture.entry.machine}.jsonl`;
export const fixtureLine = (fixture: GoldenFixture) => JSON.stringify(fixture.entry) + "\n";

export class Replay {
  readonly home = realPath(mkdtempSync(join(tmpdir(), "amem-contract-replay-")));
  now = GOLDEN_NOW;
  store: MemoryStore;
  constructor() { this.store = this.open(); }
  private open(): MemoryStore { return new MemoryStore({ home: this.home, now: () => this.now, deferPromotions: true, screen: () => "keep" }); }
  append(fixture: GoldenFixture): void { this.appendBytes(fixturePath(fixture), fixtureLine(fixture)); }
  appendBytes(path: string, bytes: string): void { appendFileSync(join(this.store.dir, path), bytes); }
  /** A crash after an authored append but before index refresh: construction must derive it from the log. */
  reopen(): void { this.store.close(); this.store = this.open(); }
  verify(): DerivedTables {
    const bytes = authoredLogs(this.store.dir);
    this.store.refresh();
    const incremental = derivedTables(this.store.dir);
    this.store.rebuild();
    expect(derivedTables(this.store.dir)).toEqual(incremental);
    expect(authoredLogs(this.store.dir)).toEqual(bytes);
    return incremental;
  }
  close(): void { this.store.close(); rmSync(this.home, { recursive: true, force: true }); }
}
