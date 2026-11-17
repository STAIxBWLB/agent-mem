import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { entryId } from "../src/memory/store.ts";
import { readFormatFloors } from "../src/memory/formats.ts";
import * as journalStorage from "../src/memory/sync-placement-journal-storage.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { createPlacementInspectionFixture, inspectionNote, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";

const homes: PlacementInspectionFixture[] = [];
afterEach(() => { for (const home of homes.splice(0).reverse()) home.close(); });

// The existing #419 scale test has a 600 s test-local limit; do not raise it for this restored workload.
test("#420 AC1: 5,154-row first sync uses the explicitly floor-gated v2 batch path", async () => {
  const total = 5154, pad = "synthetic body ".repeat(150);
  const f = await createPlacementInspectionFixture({
    seed(store, project) {
      const first = store.note(inspectionNote(`first ${pad}`, project));
      const log = join(store.profile.home, "log", readdirSync(join(store.profile.home, "log")).find(name => name.endsWith(".jsonl"))!);
      const { id: _id, ...template } = JSON.parse(readFileSync(log, "utf8").trim());
      let rows = "";
      for (let i = 1; i < total; i++) {
        const body = { ...template, text: `row ${i} ${pad}` };
        rows += JSON.stringify({ ...body, id: entryId(body) }) + "\n";
      }
      appendFileSync(log, rows);
      return { first };
    },
    async beforeMigrate(home) {
      const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = home;
      try {
        const result = await runCli(["formats", "raise", "sync", "0.28.0", "--confirm"], { cwd: home, env: {}, processTable: () => "" });
        expect(result).toContain('"surface":"sync","minReader":"0.28.0"');
        expect(readFormatFloors(home)).toEqual([expect.objectContaining({ surface: "sync", minReader: "0.28.0" })]);
      } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
    },
  }); homes.push(f);
  const rows = [...f.capture().rows.values()];
  expect(rows).toHaveLength(total);
  expect(rows.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row.row)), 0)).toBeGreaterThan(8 * 1024 * 1024);
  const batch = spyOn(journalStorage, "appendPlacementEvents"), single = spyOn(journalStorage, "appendPlacementEvent");
  try {
    const started = performance.now(), result = await syncMemory(f.store, f.opts());
    console.log(`#420 AC1: ${total} rows, sync ${Math.round(performance.now() - started)} ms`);
    expect(result, result.error).toMatchObject({ ok: true, placementPublication: { outcome: "committed", exported: total, withheld: 0 } });
    expect(batch.mock.calls.length).toBeGreaterThan(0);
    expect(single.mock.calls.length).toBe(0);
    const published = f.reachableIds(); expect(published).toHaveLength(total); expect(published).toContain(f.ids.first!);
  } finally { batch.mockRestore(); single.mockRestore(); }
}, 600_000);
