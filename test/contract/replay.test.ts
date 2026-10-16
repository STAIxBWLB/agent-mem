import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GOAL_STATES, KINDS, MEMORY_SCHEMA, entryId } from "../../src/memory/store.ts";
import { OP_CONTRACTS, V1_OPS, assertSharedV1Op } from "../../src/memory/ops-contract.ts";
import { GOLDEN_FIXTURES, SCHEMA_FIXTURES, GOLDEN_PROJECT, GOLDEN_DEADLINE, GOLDEN_NOW, denyFixtureId, fixture } from "./fixtures.ts";
import { Replay, authoredLogs, derivedTables, fixtureLine, fixturePath } from "./replay.ts";

function semanticTruth(replay: Replay): void {
  const store = replay.store, id = (name: string) => fixture(name).entry.id;
  const all = store.list({ project: GOLDEN_PROJECT, includeSuperseded: true, limit: Number.MAX_SAFE_INTEGER });
  const current = store.list({ project: GOLDEN_PROJECT, limit: Number.MAX_SAFE_INTEGER });
  expect(current.map(row => row.id)).not.toContain(id("v1-note"));
  expect(all.find(row => row.id === id("v1-note"))?.supersededBy).toBe(id("note-replacement"));
  expect(all.some(row => row.id === id("note-forgotten"))).toBe(false);
  expect(all.find(row => row.id === id("note-demoted"))).toMatchObject({ tier: "short", expiresAt: GOLDEN_DEADLINE });
  expect(all.find(row => row.id === id("note-settled"))).toMatchObject({ tier: "short", expiresAt: GOLDEN_DEADLINE });
  expect(current.some(row => row.id === id("note-replacement"))).toBe(true);
  const goal = store.goalOf(id("v1-goal"), GOLDEN_PROJECT)!;
  expect(goal).toMatchObject({ state: "active", title: "fixture goal", milestones: ["deliver"], dependsOn: [], lease: { holder: "fixture-c", until: GOLDEN_DEADLINE, conflict: [], expired: false } });
  expect(goal.links.map(link => link.task)).toEqual(["agent-hub#1@1"]);
  const suggestions = store.suggestions(GOLDEN_PROJECT);
  expect(suggestions.find(row => row.id === id("v1-suggest"))).toMatchObject({ status: "confirmed", from: id("v1-note"), to: id("note-replacement"), rel: "contradicts" });
  expect(suggestions.find(row => row.id === id("suggest-rejected"))).toMatchObject({ status: "rejected", rel: "same_topic" });
}

// Changes in a current op's required fields or omission from the registry cannot silently reduce replay coverage.
test("every implemented v1 op has an explicit payload and semantic contract; reserved ops remain deny-only", () => {
  const expected = ["note", "forget", "supersede", "demote", "settle", "goal", "goal_state", "goal_link", "lease", "lease_force", "suggest", "confirm", "reject"];
  const actual: string[] = [...V1_OPS];
  expect(actual.sort()).toEqual(expected.sort());
  expect(new Set(GOLDEN_FIXTURES.map(row => row.entry.op))).toEqual(new Set(V1_OPS));
  for (const op of V1_OPS) {
    const contract = OP_CONTRACTS[op]!, golden = fixture(`v1-${op}`);
    expect(contract.status).toBe("v1-equal"); expect(contract.implemented).toBe(true);
    expect(contract.payloadVersion.trim().length).toBeGreaterThan(0);
    expect(contract.fixtures).toContain(golden.id);
    expect(golden.entry.op).toBe(op); expect(golden.entry.schema).toBe(MEMORY_SCHEMA);
    expect(golden.payloadVersion).toBe("agent-hub.memory/v1");
    for (const key of contract.required) expect(Object.hasOwn(golden.entry, key)).toBe(true);
    for (const value of [contract.immutableTargets, contract.placement, contract.precedence, contract.identity, contract.crashBoundary]) expect(value.trim().length).toBeGreaterThan(0);
    expect(() => assertSharedV1Op(op)).not.toThrow();
  }
  for (const [op, contract] of Object.entries(OP_CONTRACTS)) if (!contract.implemented) {
    expect(contract.status).toBe("truth-changing");
    expect(contract.fixtures).toContain(denyFixtureId(op));
    expect(GOLDEN_FIXTURES.some(row => row.entry.op === op)).toBe(false);
    expect(() => assertSharedV1Op(op)).toThrow();
  }
  for (const invalid of [undefined, null, {}, "future-unregistered-op"]) expect(() => assertSharedV1Op(invalid)).toThrow();
});

test("golden ids freeze schema, complete payload identity and immutable op targets", () => {
  expect(fixture("v1-note").entry.id).toBe("ba9c0d804f5894bd57fff65640594281");
  for (const golden of [...GOLDEN_FIXTURES, ...SCHEMA_FIXTURES]) {
    const { id, ...body } = golden.entry;
    expect(entryId(body)).toBe(id);
    expect(entryId({ ...body, schema: "a-future-schema" } as unknown as typeof body)).not.toBe(id);
    if ("target" in body) {
      const changedTarget = { ...body, target: `${body.target}-changed` };
      expect(entryId(changedTarget)).not.toBe(id);
    }
    expect(entryId({ ...body, machine: "different-fixture-machine" })).not.toBe(id);
  }
});

const orders = [GOLDEN_FIXTURES.map((_, index) => index), GOLDEN_FIXTURES.map((_, index) => GOLDEN_FIXTURES.length - index - 1), GOLDEN_FIXTURES.map((_, index) => index).sort((a, b) => ((a * 7) % GOLDEN_FIXTURES.length) - ((b * 7) % GOLDEN_FIXTURES.length))];
for (const [index, order] of orders.entries()) test(`v1 replay semantic truth and all derived tables survive permutation ${index} and duplicates`, () => {
  const replay = new Replay();
  try {
    for (const item of order) {
      replay.append(GOLDEN_FIXTURES[item]!); replay.verify();
      // A byte-for-byte repeated event must not duplicate any semantic row; offsets and heads still advance.
      const before = derivedTables(replay.store.dir);
      replay.append(GOLDEN_FIXTURES[item]!); const after = replay.verify();
      for (const table of ["edges", "entries", "goals", "ops"]) expect(after[table]).toEqual(before[table]);
    }
    semanticTruth(replay);
    const tables = replay.verify();
    expect(Object.keys(tables)).toEqual(["edges", "entries", "goals", "heads", "ops", "segments"]);
    expect(tables.entries!.length).toBe(5); expect(tables.goals!.length).toBe(1); expect(tables.ops!.length).toBe(13);
    for (const [path, bytes] of Object.entries(authoredLogs(replay.store.dir))) {
      expect(tables.segments!.find(row => row.file === path)?.offset).toBe(Buffer.byteLength(bytes));
      expect(tables.heads!.find(row => row.file === path)?.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  } finally { replay.close(); }
});

test("partial newline tail never becomes truth until completed, including a crash before its index write", () => {
  const replay = new Replay(), golden = fixture("v1-note"), line = fixtureLine(golden), middle = Math.floor(line.length / 2);
  try {
    replay.appendBytes(fixturePath(golden), line.slice(0, middle));
    const incomplete = replay.verify();
    expect(incomplete.entries).toEqual([]); expect(incomplete.heads).toEqual([]); expect(incomplete.segments).toEqual([]);
    replay.reopen(); expect(replay.store.list({ project: GOLDEN_PROJECT })).toEqual([]);
    replay.appendBytes(fixturePath(golden), line.slice(middle, -1));
    replay.verify(); expect(replay.store.list({ project: GOLDEN_PROJECT })).toEqual([]);
    replay.appendBytes(fixturePath(golden), "\n");
    replay.reopen();
    expect(replay.store.get(golden.entry.id, GOLDEN_PROJECT)?.text).toBe("preserve the contract");
    expect(replay.verify().entries).toHaveLength(1);
  } finally { replay.close(); }
});

// Each first authoritative write must stand on its own when the following write never happens.
test("crash prefixes preserve base truth before forget, supersede, verdict and forced lease writes", () => {
  const replay = new Replay();
  try {
    for (const name of ["v1-note", "note-replacement", "note-forgotten", "v1-goal", "v1-suggest", "v1-lease", "lease-contender"]) replay.append(fixture(name));
    replay.reopen(); replay.verify();
    expect(replay.store.get(fixture("note-forgotten").entry.id, GOLDEN_PROJECT)).toBeDefined();
    expect(replay.store.get(fixture("v1-note").entry.id, GOLDEN_PROJECT)?.supersededBy).toBeNull();
    expect(replay.store.suggestions(GOLDEN_PROJECT)[0]?.status).toBe("suggested");
    expect(replay.store.goalOf(fixture("v1-goal").entry.id, GOLDEN_PROJECT)?.lease).toMatchObject({ holder: "fixture-a", conflict: ["fixture-b"] });
    for (const name of ["v1-forget", "v1-supersede", "v1-confirm", "v1-lease_force"]) { replay.append(fixture(name)); replay.reopen(); replay.verify(); }
    expect(replay.store.get(fixture("note-forgotten").entry.id, GOLDEN_PROJECT)).toBeUndefined();
    expect(replay.store.get(fixture("v1-note").entry.id, GOLDEN_PROJECT)?.supersededBy).toBe(fixture("note-replacement").entry.id);
    expect(replay.store.suggestions(GOLDEN_PROJECT)[0]?.status).toBe("confirmed");
    expect(replay.store.goalOf(fixture("v1-goal").entry.id, GOLDEN_PROJECT)?.lease).toMatchObject({ holder: "fixture-c", conflict: [] });
  } finally { replay.close(); }
});

test("authored placement and target namespaces stay v1-compatible", () => {
  for (const row of GOLDEN_FIXTURES) {
    const entry = row.entry;
    const local = entry.op === "note" && entry.tier === "short" || entry.op === "settle";
    expect(row.placement).toBe(local ? "local" : "log");
    if (entry.op === "note") expect(entry.project).toBe(GOLDEN_PROJECT);
    if (entry.op === "settle" || entry.op === "goal_link") expect(entry.op === "settle" ? entry.target : entry.by).toBe("agent-hub#1@1");
    if (["goal_state", "goal_link", "lease", "lease_force"].includes(entry.op)) expect("target" in entry && entry.target).toBe(fixture("v1-goal").entry.id);
    if (entry.op === "confirm" || entry.op === "reject") expect(GOLDEN_FIXTURES.some(suggestion => suggestion.entry.op === "suggest" && suggestion.entry.id === entry.target)).toBe(true);
  }
});

test("latest person verdict overrides confirmation and lease force overrides prior conflicting claims", () => {
  const replay = new Replay();
  try {
    for (const name of ["v1-note", "note-replacement", "v1-goal", "v1-suggest", "v1-confirm"]) replay.append(fixture(name));
    replay.verify();
    expect(replay.store.suggestions(GOLDEN_PROJECT)[0]?.status).toBe("confirmed");
    // A new signed reject targets the SAME immutable suggestion, unlike the separate golden rejected suggestion.
    const originalReject = fixture("v1-reject"), { id: _id, ...body } = originalReject.entry;
    if (body.op !== "reject") throw new Error("reject fixture must remain a reject");
    const changed = { ...body, target: fixture("v1-suggest").entry.id };
    const laterReject = { ...originalReject, id: "case-later-reject", entry: { ...changed, id: entryId(changed) } };
    replay.append(laterReject); replay.verify();
    expect(replay.store.suggestions(GOLDEN_PROJECT)[0]?.status).toBe("rejected");
    for (const name of ["v1-lease", "lease-contender"]) replay.append(fixture(name));
    replay.verify();
    expect(replay.store.goalOf(fixture("v1-goal").entry.id, GOLDEN_PROJECT)?.lease).toMatchObject({ holder: "fixture-a", conflict: ["fixture-b"] });
    replay.append(fixture("v1-lease_force")); replay.verify();
    expect(replay.store.goalOf(fixture("v1-goal").entry.id, GOLDEN_PROJECT)?.lease).toMatchObject({ holder: "fixture-c", conflict: [] });
  } finally { replay.close(); }
});

// Declared v1 ceiling, not a durable-prune contract: a backward clock can revive expired authored rows on rebuild.
// P9 must supersede this fixture if it introduces a truth-changing prune op; this harness emits no such payload.
test("clock rollback witnesses the declared v1 pruning ceiling without changing authored bytes", () => {
  const replay = new Replay(), demoted = fixture("note-demoted").entry.id;
  try {
    replay.append(fixture("note-demoted")); replay.append(fixture("v1-demote")); replay.verify();
    expect(replay.store.get(demoted, GOLDEN_PROJECT)).toBeDefined();
    const bytes = authoredLogs(replay.store.dir);
    replay.now = Date.parse(GOLDEN_DEADLINE) + 1;
    expect(replay.store.list({ project: GOLDEN_PROJECT })).toEqual([]);
    const expired = replay.verify(); expect(expired.entries).toEqual([]);
    replay.now = GOLDEN_NOW;
    const incremental = derivedTables(replay.store.dir);
    expect(incremental.entries).toEqual([]);
    replay.store.rebuild();
    const rebuilt = derivedTables(replay.store.dir);
    expect(rebuilt.entries).toHaveLength(1);
    expect(rebuilt.entries).not.toEqual(incremental.entries);
    expect(rebuilt.edges).not.toEqual(incremental.edges);
    expect(rebuilt).not.toEqual(incremental);
    for (const table of ["goals", "heads", "ops", "segments"]) expect(rebuilt[table]).toEqual(incremental[table]);
    expect(replay.store.get(demoted, GOLDEN_PROJECT)).toMatchObject({ tier: "short", expiresAt: GOLDEN_DEADLINE });
    expect(replay.verify()).toEqual(rebuilt);
    expect(authoredLogs(replay.store.dir)).toEqual(bytes);
  } finally { replay.close(); }
});

test("versioned payload schema covers every current field, canonical UTC, ids and normative kinds", () => {
  const payloads = [...GOLDEN_FIXTURES, ...SCHEMA_FIXTURES];
  for (const [op, contract] of Object.entries(OP_CONTRACTS)) {
    const schema = contract.payloadSchema;
    if (!contract.implemented) {
      expect(schema).toBeNull(); expect(contract.payloadVersion).toBe("unimplemented");
      continue;
    }
    if (!schema) throw new Error(`implemented op ${op} needs a payload schema`);
    expect(schema.version).toBe(1);
    const rows = payloads.filter(row => row.entry.op === op);
    expect(rows.length).toBeGreaterThan(0);
    const covered = new Set<string>();
    for (const golden of rows) {
      const entry = golden.entry as unknown as Record<string, unknown>;
      for (const required of schema.required) expect(Object.hasOwn(entry, required)).toBe(true);
      for (const field of Object.keys(entry)) expect(Object.hasOwn(schema.fields, field)).toBe(true);
      for (const [field, rule] of Object.entries(schema.fields)) {
        const value = entry[field];
        if (value === undefined) { expect(schema.required.includes(field) && !schema.legacyOptional.includes(field)).toBe(false); continue; }
        covered.add(field);
        if (rule.type === "string-array") { expect(Array.isArray(value)).toBe(true); expect((value as unknown[]).every(item => typeof item === "string")).toBe(true); }
        else expect(typeof value).toBe("string");
        if (rule.values) expect(rule.values).toContain(value as string);
        if (rule.maxLength !== undefined) expect((value as string | unknown[]).length).toBeLessThanOrEqual(rule.maxLength);
        if (rule.format === "utc") expect(new Date(Date.parse(value as string)).toISOString()).toBe(value as string);
        if (rule.format === "id") expect(value).toMatch(/^[a-f0-9]{32}$/);
      }
    }
    expect([...covered].sort()).toEqual(Object.keys(schema.fields).sort());
    if (op === "note") expect([...(schema.fields.kind?.values ?? [])].sort()).toEqual([...KINDS].sort());
    if (op === "goal_state") expect([...(schema.fields.by?.values ?? [])].sort()).toEqual([...GOAL_STATES].sort());
  }
});
