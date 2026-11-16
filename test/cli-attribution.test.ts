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
  expect(api.withCliAttribution).toBe(withCliAttribution); expect(api.cliAttribution).toBe(cliAttribution);
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

test("#270: the root API attributes a write inside the scope to the agent and its peer, and a write outside it to the person", async () => {
  const base = mkdtempSync(join(tmpdir(), "amem-root-attribution-")), store = new api.MemoryStore({ memoryDir: base, deferPromotions: true, screen: () => "promote" }), candidates = new api.CandidateStore({ memoryDir: base });
  try {
    const project = "fixture", policy = api.createStandalonePolicy();
    const accept = (id: string, actor: "person" | "agent") => candidates.accept(id, { project, actor, verdict: "public", store, policy: () => true, policyVersion: () => "fixed" });
    const a = candidates.put({ project, kind: "memory", text: "accepted inside the agent scope" } as api.CandidateInput, "public");
    const p = candidates.put({ project, kind: "memory", text: "accepted outside any scope" } as api.CandidateInput, "public");
    const inside = api.withCliAttribution({ actor: "agent", peer: "codex", policy: () => policy }, () => accept(a, "agent"));
    const outside = accept(p, "person");
    expect(store.get(inside.noteId, project)).toMatchObject({ peer: "codex", source: "person" });
    expect(store.get(outside.noteId, project)).toMatchObject({ peer: "person", source: "person" });
    expect(api.noteDisplayActor("codex")).toBe("agent"); expect(api.noteDisplayActor("person")).toBe("person");
    // Documented boundary: a direct MemoryStore.note is not attributed; it keeps the peer its caller passes, inside the scope too.
    const direct = api.withCliAttribution({ actor: "agent", peer: "codex", policy: () => policy }, () => store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "legacy", source: "person", text: "direct store note", about: [] }));
    expect(store.get(direct, project)?.peer).toBe("legacy");
    // An agent-scoped forget records actor agent in the operation log; an unscoped one keeps the library default.
    const options = { store, open: () => store, readable: (rows: api.View[]) => rows, importPolicy: () => () => false, project };
    await api.withCliAttribution({ actor: "agent", peer: "codex", policy: () => policy }, () => api.rawMemoryCommand(["forget", inside.noteId], base, options));
    await api.rawMemoryCommand(["forget", outside.noteId], base, options);
    expect(JSON.parse(store.dump())[1].map((row: { actor: string }) => row.actor).sort()).toEqual(["agent", "user"]);
  } finally { candidates.close(); store.close(); rmSync(base, { recursive: true, force: true }); }
});

test("#270: a scope without an agent identity refuses before running its work", () => {
  let ran = 0;
  for (const identity of [{ actor: "agent", peer: "" }, { actor: "agent", peer: "  " }, { actor: "agent", peer: "a\nb" }, { actor: "robot", peer: "codex" }, { actor: "agent" }] as unknown as api.CliAttribution[])
    expect(() => api.withCliAttribution(identity, () => { ran++; })).toThrow(/needs actor person or agent|no agent identity; nothing was run\. Pass the session's peer id/);
  expect(ran).toBe(0); expect(api.cliAttribution()).toBeUndefined();
});
