import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory/store.ts";
import { realPath } from "../src/memory/platform.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { captureSyncPlacementContext } from "../src/memory/sync-placement-capture.ts";
import { PLACEMENT_FORMAT, PLACEMENT_SHARDS_SCHEMA } from "../src/memory/sync-placement-format.ts";
import { planPlacementJournal, preparePlacementJournal, holdPlacementRow, releasePlacementHold, recordPlacementPublication,
  recordPlacementAmbiguity, readPlacementProjection, type PlacementJournalPort, type PlacementEffectRequest } from "../src/memory/sync-placement-journal.ts";
import { type PlacementKey } from "../src/memory/sync-placement-journal-format.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hex = (n: number) => n.toString(16).padStart(64, "0");
async function fixture(activate = true) {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-placement-journal-"))); roots.push(root);
  const home = join(root, "memory"), store = new MemoryStore({ memoryDir: home, deferPromotions: true });
  const common = { op: "note" as const, project: "placement-journal", scope: "project" as const, tier: "long" as const,
    kind: "finding" as const, peer: "person", source: "person" as const, about: [] };
  const allowed = store.note({ ...common, text: "synthetic allowed row" });
  const declined = store.note({ ...common, text: "synthetic private-marker row" });
  const local = store.note({ ...common, tier: "short", task: "placement-journal#42@1000", text: "synthetic intrinsic local row" });
  store.close();
  await migrateShards({ memoryDir: home, generation: "e".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  await activatePublicPruneView({ memoryDir: home, mode: "apply", authorizedPerson: true, tty: true });
  const policy = (patterns: string[]) => writeFileSync(join(home, "amem.config.json"), JSON.stringify({ piiPatterns: patterns }), { mode: 0o600 });
  policy(["private-marker"]);
  let authorized = true, version = "initial", pin = "2".repeat(64), authorityHook: (() => void) | undefined;
  const authorizations: string[] = [];
  const port: PlacementJournalPort = { attest: () => ({ writers: [{ writerId: "1".repeat(64), version: "0.22.0", pin,
    publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true }), policyVersion: () => version,
    authorize: binding => { authorizations.push(binding.action); authorityHook?.(); return authorized; } };
  const capture = captureSyncPlacementContext(home, port), preview = planPlacementJournal(home, port);
  const { epochHash } = preparePlacementJournal(home, preview, port);
  // This is a fixture of a future activation writer, not an activation API under test.
  if (activate) {
    const old = JSON.parse(readFileSync(join(home, "shards.json"), "utf8"));
    const profile = preview.plan.targetProfile;
    writeFileSync(join(home, "profile.json"), canonicalJSON(profile) + "\n", { mode: 0o600 });
    writeFileSync(join(home, "shards.json"), canonicalJSON({ ...old, schema: PLACEMENT_SHARDS_SCHEMA,
      selectorRevision: hashJSON(profile), publicationFormat: PLACEMENT_FORMAT, placementHead: epochHash }) + "\n", { mode: 0o600 });
  }
  const key = (id: string): PlacementKey => {
    const source = [...capture.rows.values()].find(row => row.row.id === id);
    if (!source) throw Error("missing synthetic source"); return source.key;
  };
  const state = () => readPlacementProjection(home, epochHash);
  let serial = 1;
  const request = (id = allowed): PlacementEffectRequest => ({ epochHash, expectedHead: state().headHash, requestId: hex(serial++), key: key(id) });
  return { home, port, epochHash, allowed, declined, local, policy, state, request, authorizations,
    deny: () => { authorized = false; }, setVersion: () => { version = "changed"; }, setPin: () => { pin = "3".repeat(64); },
    onAuthorize: (hook: () => void) => { authorityHook = hook; } };
}

test("policy hold is narrowing, sticky after loosening, and release requires current policy and person intent", async () => {
  const f = await fixture(); f.authorizations.length = 0;
  holdPlacementRow(f.home, f.request(f.declined), f.port);
  expect(f.authorizations).toEqual([]);
  expect(f.state().states[0]).toMatchObject({ held: true, reasons: ["personal-data"], exposure: "unknown" });
  expect(JSON.stringify(f.state())).not.toContain("private-marker");
  expect(JSON.stringify(f.state())).not.toContain("synthetic");
  const blocked = f.request(f.declined);
  expect(() => releasePlacementHold(f.home, blocked, f.port)).toThrow();
  expect(f.state().sequence).toBe(1);
  f.policy([]);
  expect(f.state().states[0]?.held).toBe(true);
  releasePlacementHold(f.home, f.request(f.declined), f.port);
  expect(f.authorizations).toEqual(["release"]);
  expect(f.state().states[0]).toMatchObject({ held: false, reasons: [], exposure: "unknown" });
});

test("person holds require authority and policy cannot masquerade as person intent", async () => {
  const f = await fixture();
  expect(() => holdPlacementRow(f.home, f.request(), f.port)).toThrow();
  expect(f.state().sequence).toBe(0);
  holdPlacementRow(f.home, f.request(), f.port, "person");
  expect(f.state().states[0]).toMatchObject({ held: true, reasons: ["person-local"] });
  f.deny();
  expect(() => releasePlacementHold(f.home, f.request(), f.port)).toThrow();
  expect(() => holdPlacementRow(f.home, f.request(f.declined), f.port, "person")).toThrow();
  expect(f.state().sequence).toBe(1);
});

test("an old release retry cannot resurrect publication after a newer hold", async () => {
  const f = await fixture();
  holdPlacementRow(f.home, f.request(), f.port, "person");
  const release = f.request(); releasePlacementHold(f.home, release, f.port);
  holdPlacementRow(f.home, f.request(), f.port, "person");
  const before = f.state();
  expect(() => releasePlacementHold(f.home, release, f.port)).toThrow();
  expect(f.state()).toEqual(before);
  expect(f.state().states[0]?.held).toBe(true);
});

test("verified publication evidence and ambiguity never erase a sticky hold or downgrade known exposure", async () => {
  const f = await fixture(); holdPlacementRow(f.home, f.request(), f.port, "person");
  const outcome = { attemptHash: hex(100), remoteHash: hex(101), refHash: hex(102), commit: "a".repeat(40), proofHash: hex(103) };
  const refused = f.request();
  expect(() => recordPlacementPublication(f.home, refused, f.port, outcome, () => false)).toThrow();
  expect(f.state().sequence).toBe(1);
  let verification = 0;
  recordPlacementPublication(f.home, f.request(), f.port, outcome, binding => {
    verification++; expect(binding.effectHash).toHaveLength(64); expect(binding.outcome).toEqual(outcome); return true;
  });
  recordPlacementAmbiguity(f.home, f.request(), f.port, { attemptHash: hex(104), remoteHash: hex(101), refHash: hex(102) });
  expect(verification).toBe(1);
  expect(f.state().states[0]).toMatchObject({ held: true, reasons: ["person-local"], exposure: "published" });
  expect(f.state().states[0]?.attempts).toHaveLength(2);
});

test("prepared v2 is inert and a wrong realm key never selects another row", async () => {
  const inert = await fixture(false);
  expect(() => holdPlacementRow(inert.home, inert.request(), inert.port, "person")).toThrow();
  expect(inert.state().sequence).toBe(0);
  const f = await fixture(), wrong = f.request(); wrong.key = { ...wrong.key, realm: { scope: "user" } };
  expect(() => holdPlacementRow(f.home, wrong, f.port, "person")).toThrow();
  expect(f.state().sequence).toBe(0);
});

test("intrinsically local source can be held but person intent cannot release it", async () => {
  const f = await fixture(); holdPlacementRow(f.home, f.request(f.local), f.port, "person");
  const before = f.state();
  expect(() => releasePlacementHold(f.home, f.request(f.local), f.port)).toThrow();
  expect(f.state()).toEqual(before);
  expect(f.state().states[0]?.sourcePlacement).toBe("local");
});

for (const change of ["policy", "host", "source"] as const) test(`a ${change} mutation inside authorization rejects the append`, async () => {
  const f = await fixture(), before = f.state();
  f.onAuthorize(() => {
    if (change === "policy") f.policy(["changed-pattern"]);
    if (change === "host") f.setVersion();
    if (change === "source") {
      const findSegment = (dir: string): string | undefined => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const file = join(dir, entry.name);
          if (entry.isDirectory()) { const nested = findSegment(file); if (nested) return nested; }
          else if (entry.name.endsWith(".jsonl")) return file;
        }
        return undefined;
      };
      const segment = findSegment(join(f.home, "projects"));
      if (!segment) throw Error("missing synthetic segment");
      // A physical append must invalidate the earlier proof even when the new line is empty.
      appendFileSync(segment, "\n");
    }
  });
  expect(() => holdPlacementRow(f.home, f.request(), f.port, "person")).toThrow();
  expect(f.state()).toEqual(before);
});

test("a changed sharing-writer pin invalidates the prepared epoch even after marker installation", async () => {
  const f = await fixture(), before = f.state(); f.setPin();
  expect(() => holdPlacementRow(f.home, f.request(), f.port, "person")).toThrow();
  expect(f.state()).toEqual(before);
});
