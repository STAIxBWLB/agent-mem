import { expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { placementActivationFixture, activationOwnRoot } from "./fakes/sync-placement-activation.ts";
import { createInspectionRemote } from "./fakes/sync-placement-inspection.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { entryId, openShardStore } from "../src/memory/store.ts";
import { activePlacementWriterContext } from "../src/sync-placement-writer-context.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { previewPlacementCheckpoint, PlacementCheckpointError } from "../src/memory/sync-placement-checkpoint-person.ts";

// The #470-scale source is an opt-in resource proof: never use a real home or remote.
test.skipIf(process.env.AMEM_CHECKPOINT_LARGE !== "1")("#288: an actual oversized prospective publication cannot be unblocked by one checkpoint", async () => {
  const f = await placementActivationFixture();
  try {
    await activateSyncPlacement(f.options("apply"));
    const remote = createInspectionRemote(f.root), attest = () => activePlacementWriterContext(f.base, activationOwnRoot).attest();
    const sync = async () => {
      const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
      try { return await syncMemory(store, { remote, visibility: async () => "private", placementAttestation: attest }); } finally { store.close(); }
    };
    expect((await sync()).ok).toBe(true);
    const writer = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
    let log: string;
    try {
      writer.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "synthetic large plan seed", about: [] });
      log = join(writer.dir, "log", `${writer.machine.id}.jsonl`);
    } finally { writer.close(); }
    const first = readFileSync(log!, "utf8").trim().split("\n")[0]!, { id: _id, ...template } = JSON.parse(first);
    for (let block = 0; block < 80; block++) {
      let text = "";
      for (let offset = 0; offset < 100; offset++) {
        const i = block * 100 + offset;
        const payload = Array.from({ length: 100 }, (_, j) => createHash("sha256").update(`synthetic ${i} ${j}`).digest("hex")).join(" ");
        const body = { ...template, text: `synthetic row ${i} ${payload}` };
        text += JSON.stringify({ ...body, id: entryId(body) }) + "\n";
      }
      appendFileSync(log!, text);
    }
    const failure = await previewPlacementCheckpoint(f.base, { writerRoots: [activationOwnRoot], ownRoot: activationOwnRoot }).then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(PlacementCheckpointError);
    expect(failure.causeClass).toBe("headroom");
    expect(failure.message).toContain("single checkpoint cannot unblock");
    expect(failure.message).toContain("multi-plan split");
    const match = /needs (\d+) of 256 objects \((\d+) after the checkpoint, (\d+) for the next renewal, (\d+) for the largest observed plan and (\d+) for its reserved journal chunks\), (\d+) over the limit/.exec(failure.message);
    expect(match).not.toBeNull();
    const [required, live, renewal, slots, reserved, shortfall] = match!.slice(1).map(Number);
    expect(required).toBe(live! + renewal! + slots! + reserved!);
    expect(shortfall).toBe(required! - 256);
    const actual = await sync();
    expect(actual.failure?.cause).toBe("bound");
    expect(actual.placementPublication?.bound?.kind).toBe("journal-objects");
    expect(actual.placementPublication?.journalObjects?.newPlan?.slots).toBe(slots);
  } finally { f.close(); }
}, 900_000);
