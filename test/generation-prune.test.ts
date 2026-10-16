import { expect, test } from "bun:test";
import { entryId, type Entry, type NoteEntry, type OpEntry } from "../src/memory/store.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { applyPrune, planPrune, pruneId, pruneRowHash, reducePruneRows, validatePrunePlan, validatePruneRow,
  type PruneAuthorization, type PrunePlan, type PruneRow, type PruneSnapshot, type PruneSourceRow, type PruneStorePort } from "../src/memory/prune.ts";

const G = "1".repeat(32), MACHINE = "2".repeat(16), PROJECT = "synthetic/prune";
const START = Date.parse("2026-10-01T00:00:00.000Z"), EXPIRED = new Date(START).toISOString(), CUTOFF = new Date(START + 1000).toISOString();
function note(index = 0, extra: Partial<NoteEntry> = {}): NoteEntry {
  const row: Omit<NoteEntry, "id"> = { schema: "agent-hub.memory/v1", op: "note", at: new Date(START - 1000).toISOString(), machine: MACHINE,
    project: PROJECT, scope: "project", tier: "short", kind: "finding", peer: "synthetic-peer", text: `synthetic expired note ${index}`, about: [], source: "person", expires: EXPIRED, ...extra };
  const { id: _ignored, ...body } = row as NoteEntry;
  return { ...body, id: entryId(body) };
}
function operation(op: "demote" | "settle", target: string, by: string | null = EXPIRED): OpEntry {
  const body: Omit<OpEntry, "id"> = { schema: "agent-hub.memory/v1", op, target, actor: "person", at: new Date(START - 500).toISOString(), machine: MACHINE, ...(by === null ? {} : { by }) };
  return { ...body, id: entryId(body) };
}
class FakePort implements PruneStorePort {
  generation = G; machine = MACHINE; selector = "3".repeat(64); clock = START + 2000;
  data: PruneSnapshot = { rows: [], expiries: [] };
  durable = new Map<string, { row: PruneRow; line: string }>();
  tail = ""; journal = ""; appendCalls = 0; persisted = 0; refreshed = 0; mutations = 0; locked = false;
  crash: "partial" | "after-durable" | "refresh" | undefined;
  selectorRevision() { return this.selector; }
  now() { return this.clock; }
  snapshot(): PruneSnapshot { return structuredClone({ ...this.data, pruned: [...this.durable.values()].flatMap(item => item.row.targets.map(target => target.id)), durablePruneIds: [...this.durable.keys()] }); }
  withMutation<T>(work: () => T): T { this.mutations++; this.locked = true; try { return work(); } finally { this.locked = false; } }
  persistPrunePlan(plan: PrunePlan): void {
    expect(this.locked).toBe(true); const text = canonicalJSON(plan);
    if (this.journal && this.journal !== text) throw new Error("synthetic journal mismatch");
    this.journal = text; this.persisted++;
  }
  appendPrune(row: PruneRow, line: string, seal: string): "written" | "already-durable" {
    expect(this.locked).toBe(true); expect(this.journal).not.toBe(""); expect(JSON.parse(this.journal).seal).toBe(seal);
    expect(line).toBe(canonicalJSON(row) + "\n"); this.appendCalls++;
    const existing = this.durable.get(row.id);
    if (existing) { expect(existing.line).toBe(line); return "already-durable"; }
    if (this.tail && !line.startsWith(this.tail)) throw new Error("synthetic mismatched tail");
    if (this.crash === "partial") { this.crash = undefined; this.tail = line.slice(0, 19); throw new Error("synthetic partial append"); }
    this.tail = ""; this.durable.set(row.id, { row: structuredClone(row), line });
    if (this.crash === "after-durable") { this.crash = undefined; throw new Error("synthetic durable append before receipt"); }
    return "written";
  }
  refresh(): void { this.refreshed++; if (this.crash === "refresh") { this.crash = undefined; throw new Error("synthetic index failure"); } }
  add(row: Entry, placement: "local" | "synced" = "local", publicWitness = false, basis: Entry = row, expiredAt = EXPIRED): void {
    const source = (value: Entry): PruneSourceRow => ({ row: value, placement, publicWitness });
    this.data.rows = [...this.data.rows, source(row), ...(basis.id === row.id ? [] : [source(basis)])];
    this.data.expiries = [...this.data.expiries, { targetId: row.id, basisId: basis.id, expiredAt }];
  }
}
const authorization = (): PruneAuthorization => ({ project: PROJECT, actor: "person", authorize: () => true });
function publicPolicy() {
  let revision = "synthetic-policy-v1";
  const bindings: unknown[] = [];
  const auth: PruneAuthorization = { ...authorization(), policy: { revision: () => revision,
    classify: source => JSON.stringify(source.row).includes("PRIVATE") ? "private" : "public",
    attest: binding => { bindings.push(structuredClone(binding)); return true; },
  } };
  return { auth, bindings, change: () => { revision = "synthetic-policy-v2"; } };
}
const input = { cutoff: CUTOFF };
function resigned(row: PruneRow): PruneRow { const { id: _id, ...body } = row; return { ...body, id: pruneId(body) }; }
function reseal(plan: PrunePlan): PrunePlan { const { seal: _seal, ...body } = plan; return { ...body, seal: hashJSON(body) }; }
const refusal = (work: () => unknown): string => { try { work(); throw new Error("fixture expected refusal"); } catch (error) { return (error as Error).message; } };

test("prune planning is read-only and seals explicit expiry hashes before idempotent apply", () => {
  const port = new FakePort(), row = note(); port.add(row);
  const plan = planPrune(port, input, authorization());
  expect(port.persisted).toBe(0); expect(port.mutations).toBe(0); expect(port.durable.size).toBe(0);
  expect(validatePrunePlan(canonicalJSON(plan))).toEqual(plan);
  expect(plan.rows[0]?.payload.targets).toEqual([{ id: row.id, rowHash: pruneRowHash(row), expiredAt: EXPIRED, basis: { kind: "note", id: row.id, rowHash: pruneRowHash(row) } }]);
  expect(applyPrune(port, plan, authorization()).completed).toEqual([plan.rows[0]!.payload.id]);
  expect(applyPrune(port, canonicalJSON(plan), authorization()).completed).toEqual([plan.rows[0]!.payload.id]);
  expect(port.appendCalls).toBe(2); expect(port.durable.size).toBe(1);
});

test("resume reconfirms complete parsed prune bytes through the durability hook", () => {
  const port = new FakePort(); port.add(note()); const plan = planPrune(port, input, authorization());
  const row = plan.rows[0]!.payload, line = canonicalJSON(row) + "\n";
  // Complete bytes may have been indexed after a crash before their first successful fsync.
  port.journal = canonicalJSON(plan); port.durable.set(row.id, { row, line });
  expect(applyPrune(port, plan, authorization()).completed).toEqual([row.id]);
  expect(port.appendCalls).toBe(1); expect(port.durable.size).toBe(1);
  expect(port.durable.get(row.id)?.line).toBe(line);
});

test("only explicit note expires or demote settle by values can prove expiry", () => {
  for (const kind of ["note", "demote", "settle"] as const) {
    const port = new FakePort(), row = note(0, { expires: kind === "note" ? EXPIRED : undefined, task: `${PROJECT}#1@1` });
    const basis = kind === "note" ? row : operation(kind, kind === "settle" ? row.task! : row.id);
    port.add(row, "local", false, basis);
    expect(planPrune(port, input, authorization()).counts.selected).toBe(1);
  }
  for (const kind of ["backstop", "instance-ttl", "demote-without-by", "settle-without-by"] as const) {
    const port = new FakePort(), row = note(0, { expires: undefined, ...(kind === "backstop" || kind === "settle-without-by" ? { task: `${PROJECT}#1@1` } : {}) });
    const basis = kind === "demote-without-by" || kind === "settle-without-by" ? operation(kind === "demote-without-by" ? "demote" : "settle", kind === "settle-without-by" ? row.task! : row.id, null) : row;
    // Even an external reducer reporting a derived expiry cannot fabricate a serialized proof.
    port.add(row, "local", false, basis);
    expect(planPrune(port, input, authorization()).counts.selected).toBe(0);
    expect(() => planPrune(port, { ...input, targets: [row.id] }, authorization())).toThrow("prune unavailable");
  }
});

test("prune authoring has uniform refusals for identity scope authorization and future cutoff failures", () => {
  const port = new FakePort(), row = note(); port.add(row);
  const failures = [
    () => planPrune(port, { ...input, targets: [row.id.slice(0, 8)] }, authorization()),
    () => planPrune(port, { ...input, targets: ["f".repeat(32)] }, authorization()),
    () => planPrune(port, input, { ...authorization(), actor: "agent" }),
    () => planPrune(port, input, { ...authorization(), authorize: () => false }),
    () => planPrune(port, input, { ...authorization(), project: "synthetic/other-project" }),
    () => planPrune(port, { cutoff: new Date(port.clock + 1).toISOString() }, authorization()),
  ];
  // Auto scans may legitimately find no visible target; explicit other-project requests must refuse.
  failures[4] = () => planPrune(port, { ...input, targets: [row.id] }, { ...authorization(), project: "synthetic/other-project" });
  expect(new Set(failures.map(refusal)).size).toBe(1); expect(port.durable.size).toBe(0); expect(port.persisted).toBe(0);
});

test("prune partitions private target or basis locally and public attestations bind only public rows", () => {
  const port = new FakePort(), local = note(0, { text: "PRIVATE original" }), publicNote = note(1), privateBasisNote = note(2, { expires: undefined });
  port.add(local); port.add(publicNote, "synced", true);
  const basis = operation("demote", privateBasisNote.id);
  port.add(privateBasisNote, "synced", true, basis);
  // A local/private basis cannot be serialized in the public partition.
  port.data.rows = port.data.rows.map(source => source.row.id === basis.id ? { ...source, placement: "local", publicWitness: false } : source);
  const policy = publicPolicy(), plan = planPrune(port, input, policy.auth);
  expect(plan.counts).toMatchObject({ selected: 3, local: 2, synced: 1 });
  const synced = plan.rows.filter(item => item.placement === "synced");
  expect(canonicalJSON(synced)).not.toContain(local.id); expect(canonicalJSON(synced)).not.toContain(basis.id);
  expect(policy.bindings).toContainEqual({ generation: G, project: PROJECT, payloadHash: hashJSON(synced[0]!.payload), policyRevision: "synthetic-policy-v1" });
  expect(planPrune(port, input, authorization()).rows.every(item => item.placement === "local")).toBe(true);
});

test("unpublished root logs and unknown classifications never authorize synced prune", () => {
  const port = new FakePort(), row = note(); port.add(row, "synced", false);
  const policy = publicPolicy();
  expect(planPrune(port, input, policy.auth).rows[0]?.placement).toBe("local");
  port.data.rows = port.data.rows.map(source => ({ ...source, publicWitness: true }));
  policy.auth.policy!.classify = () => "unknown";
  expect(planPrune(port, input, policy.auth).rows[0]?.placement).toBe("local");
});

test("stale selector project policy or changed expiry refuses before journal or append", () => {
  for (const change of ["selector", "project", "machine", "policy", "expiry", "classification"] as const) {
    const port = new FakePort(), row = note(); port.add(row, "synced", true);
    const policy = publicPolicy(), plan = planPrune(port, input, policy.auth);
    if (change === "selector") port.selector = "4".repeat(64);
    if (change === "project") policy.auth.project = "synthetic/other";
    if (change === "machine") port.machine = "4".repeat(16);
    if (change === "policy") policy.change();
    if (change === "expiry") port.data.expiries = [{ targetId: row.id, basisId: row.id, expiredAt: new Date(port.clock + 1000).toISOString() }];
    if (change === "classification") policy.auth.policy!.classify = () => "private";
    expect(() => applyPrune(port, plan, policy.auth)).toThrow("prune unavailable"); expect(port.persisted).toBe(0); expect(port.durable.size).toBe(0);
  }
});

test("prune row shape hashes canonical time ordering placement and byte bounds are strict", () => {
  const port = new FakePort(); port.add(note());
  const row = planPrune(port, input, authorization()).rows[0]!.payload;
  for (const invalid of [ { ...row, id: "0".repeat(32) }, { ...row, generation: "not-a-generation" }, { ...row, privateTitle: "PRIVATE" }, { ...row, at: "2026-10-01" },
    resigned({ ...row, targets: Array.from({ length: 33 }, () => row.targets[0]!) }), resigned({ ...row, targets: [row.targets[0]!, row.targets[0]!] }),
    resigned({ ...row, targets: [{ ...row.targets[0]!, expiredAt: new Date(port.clock + 1).toISOString() }] }),
  ]) expect(() => validatePruneRow(invalid)).toThrow("prune unavailable");
  expect(() => validatePruneRow(row, "9".repeat(32))).toThrow("prune unavailable");
  expect(() => validatePruneRow(row, G, "synced")).toThrow("prune unavailable");
});

test("whole prune plan bounds refuse explicit oversize but auto scan returns a deterministic prefix", () => {
  const port = new FakePort(); for (let i = 0; i < 260; i++) port.add(note(i));
  const plan = planPrune(port, input, authorization());
  expect(plan.counts).toMatchObject({ eligible: 260, selected: 256 }); expect(plan.hasMore).toBe(true);
  expect(plan.rows.flatMap(item => item.payload.targets.map(target => target.id))).toEqual(port.data.rows.map(source => source.row.id).sort().slice(0, 256));
  expect(planPrune(port, input, authorization())).toEqual(plan);
  expect(() => planPrune(port, { ...input, targets: port.data.rows.slice(0, 257).map(source => source.row.id) }, authorization())).toThrow("prune unavailable");
  expect(() => validatePrunePlan(" ".repeat(262145))).toThrow("prune unavailable");
  expect(() => validatePrunePlan({ ...plan, counts: { ...plan.counts, selected: 1 } })).toThrow("prune unavailable");
  expect(() => validatePrunePlan(reseal({ ...plan, counts: { ...plan.counts, selected: 1 } }))).toThrow("prune unavailable");
});

test("exact-entry reducer waits for witnesses and cannot be reversed by clock or later deadlines", () => {
  const port = new FakePort(), row = note(); port.add(row);
  const payload = planPrune(port, input, authorization()).rows[0]!.payload;
  const inputRows = [{ row: payload, placement: "local" as const }];
  expect(reducePruneRows(inputRows, { rows: [], expiries: [] }, G).pending).toEqual([payload.id]);
  port.clock = START - 100_000; port.data.expiries = [{ targetId: row.id, basisId: row.id, expiredAt: new Date(START + 999_999).toISOString() }];
  const replay = reducePruneRows([...inputRows, ...inputRows], port.snapshot(), G);
  expect([...replay.targets]).toEqual([row.id]); expect(replay.pending).toEqual([]); expect(replay.invalid).toBe(0);
  const different = note(2, { promotedFrom: row.id }); port.add(different);
  expect([...reducePruneRows(inputRows, port.snapshot(), G).targets]).toEqual([row.id]);
});

test("reducer rejects wrong full-row or basis proof and never masks sibling or ancestry ids", () => {
  const port = new FakePort(), row = note(0, { promotedFrom: "9".repeat(32) }); port.add(row);
  const payload = planPrune(port, input, authorization()).rows[0]!.payload;
  expect([...reducePruneRows([{ row: payload, placement: "local" }], port.snapshot(), G).targets]).toEqual([row.id]);
  const wrong = resigned({ ...payload, targets: [{ ...payload.targets[0]!, rowHash: "0".repeat(64) }] });
  expect(reducePruneRows([{ row: wrong, placement: "local" }], port.snapshot(), G)).toMatchObject({ invalid: 1, pending: [] });
  expect(reducePruneRows([{ row: wrong, placement: "local" }], port.snapshot(), G).targets.size).toBe(0);
});

for (const crash of ["partial", "after-durable", "refresh"] as const) test(`exact persisted prune plan resumes after ${crash} without duplicate complete rows`, () => {
  const port = new FakePort(); port.add(note()); const plan = planPrune(port, input, authorization()); port.crash = crash;
  expect(() => applyPrune(port, plan, authorization())).toThrow("prune unavailable");
  expect(port.journal).toBe(canonicalJSON(plan));
  expect(applyPrune(port, plan, authorization()).completed).toEqual([plan.rows[0]!.payload.id]);
  expect(port.durable.size).toBe(1); expect(port.tail).toBe("");
  expect([...port.durable.values()][0]?.line).toBe(canonicalJSON(plan.rows[0]!.payload) + "\n");
});

test("a mismatched partial tail refuses and preserves authored bytes", () => {
  const port = new FakePort(); port.add(note()); const plan = planPrune(port, input, authorization()); port.tail = "unrelated partial bytes";
  expect(() => applyPrune(port, plan, authorization())).toThrow("prune unavailable");
  expect(port.tail).toBe("unrelated partial bytes"); expect(port.durable.size).toBe(0);
});
