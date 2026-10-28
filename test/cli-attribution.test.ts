import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliAttribution, withCliAttribution } from "../src/memory/cli-attribution.ts";
import { rawMemoryCommand, rawGoalCommand } from "../src/memory/commands.ts";
import { MemoryStore } from "../src/memory/store.ts";
import * as api from "../src/index.ts";

test("CLI attribution is immutable and isolated across nested and concurrent async calls", async () => {
  expect(cliAttribution()).toBeUndefined();
  const labels = await Promise.all(["claude", "codex"].map(peer => withCliAttribution({ actor: "agent", peer }, async () => {
    expect(Object.isFrozen(cliAttribution())).toBe(true);
    await Bun.sleep(1);
    expect(cliAttribution()?.peer).toBe(peer);
    withCliAttribution({ actor: "person", peer: "person" }, () => expect(cliAttribution()?.actor).toBe("person"));
    expect(cliAttribution()?.peer).toBe(peer);
    return cliAttribution()?.peer;
  })));
  expect(labels).toEqual(["claude", "codex"]); expect(cliAttribution()).toBeUndefined();
  expect("withCliAttribution" in api).toBe(false);
});

test("raw library writers keep their default actor outside CLI attribution", async () => {
  const base = mkdtempSync(join(tmpdir(), "amem-cli-attribution-")), store = new MemoryStore({ memoryDir: base, deferPromotions: true });
  try {
    const options = { store, open: () => store, readable: (rows: any[]) => rows, importPolicy: () => () => false };
    for (const [actor, peer] of [["user", "legacy"], ["agent", "claude"], ["person", "person"]] as const) {
      const work = async () => {
        const id = store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind: "contract", peer, source: "person", text: `ordinary ${peer} note`, about: [] });
        await rawMemoryCommand(["forget", id], base, { ...options, project: "fixture" });
        await rawGoalCommand(["new", `${peer} goal`], base, { store, open: () => store, project: "fixture", clean: () => true });
      };
      if (actor === "user") await work(); else await withCliAttribution({ actor, peer }, work);
    }
    const tables = JSON.parse(store.dump());
    expect(new Set(tables[1].map((row: any) => row.actor))).toEqual(new Set(["user", "agent", "person"]));
    expect(new Set(tables[3].map((row: any) => row.actor))).toEqual(new Set(["user", "agent", "person"]));
    const before = store.dump(); store.rebuild(); expect(store.dump()).toBe(before);
  } finally { store.close(); rmSync(base, { recursive: true, force: true }); }
});
