import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { memoryGitSync } from "../src/memory/platform.ts";
import { migrate } from "../src/memory/migrate.ts";
import { applyPrune, planPrune } from "../src/memory/prune.ts";
import { canonicalJSON, writeProfileJSON } from "../src/memory/generation.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amem-gen-durability-")), now = Date.parse("2030-01-01T00:00:00.000Z");
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const legacy = new MemoryStore({ home, now: () => now - 10000 });
  const id = legacy.note({ op: "note", project: "agent-hub", scope: "project", tier: "short", kind: "finding", peer: "person", text: "synthetic durable expiry", about: [], source: "person", expires: new Date(now - 5000).toISOString() });
  legacy.close();
  await migrate({ memoryDir: join(home, "memory"), mode: "apply", generation: "d".repeat(32), authorizedPerson: true, tty: true });
  const store = new MemoryStore({ home, now: () => now, deferPromotions: true }); cleanup.push(() => store.close());
  const port = store.prunePort(), auth = { project: "agent-hub", actor: "person" as const, authorize: () => true };
  const plan = planPrune(port, { cutoff: new Date(now - 1).toISOString() }, auth), row = plan.rows[0]!.payload;
  const line = canonicalJSON(row) + "\n", file = join(store.dir, "local", `${store.machine.id}.jsonl`), pending = join(store.dir, "prune-plans", `pending-local-${store.machine.id}.json`);
  port.withMutation(() => port.persistPrunePlan(plan));
  return { store, port, auth, plan, row, line, file, pending, id, now };
}
function interrupted(f: Awaited<ReturnType<typeof fixture>>, bytes: string): void {
  // A real process crash seam: persisted plan/claim, then only part (or all) of the intended append, no fsync receipt.
  writeProfileJSON(f.pending, { schema: "agent-mem.prune-append/v1", seal: f.plan.seal, rowId: f.row.id, lineHash: hash(Buffer.from(f.line)), offset: 0, prefixHash: hash(Buffer.alloc(0)) });
  appendFileSync(f.file, bytes);
}

test("prune partial-tail recovery is bound to its original plan and blocks unrelated generation writes", async () => {
  const f = await fixture(); interrupted(f, f.line.slice(0, 19));
  const other = planPrune(f.port, { cutoff: new Date(f.now - 2).toISOString() }, f.auth);
  expect(other.seal).not.toBe(f.plan.seal);
  expect(() => applyPrune(f.port, other, f.auth)).toThrow("prune unavailable");
  expect(readFileSync(f.file, "utf8")).toBe(f.line.slice(0, 19));
  expect(() => f.store.note({ op: "note", project: "agent-hub", scope: "project", tier: "short", kind: "finding", peer: "person", text: "must not append after partial prune", about: [], source: "person" })).toThrow();
  expect(applyPrune(f.port, f.plan, f.auth).completed).toEqual([f.row.id]);
  expect(readFileSync(f.file, "utf8")).toBe(f.line); expect(existsSync(f.pending)).toBe(false);
  expect(f.store.get(f.id)).toBeUndefined();
});

test("complete but unacknowledged prune bytes resume through the fsync fence and clear their pending claim", async () => {
  const f = await fixture(); interrupted(f, f.line);
  expect(f.port.snapshot().durablePruneIds).toContain(f.row.id); // Parsed is not sufficient: the pending claim still exists.
  expect(existsSync(f.pending)).toBe(true);
  expect(applyPrune(f.port, f.plan, f.auth).completed).toEqual([f.row.id]);
  expect(existsSync(f.pending)).toBe(false); expect(readFileSync(f.file, "utf8")).toBe(f.line);
  expect(applyPrune(f.port, f.plan, f.auth).completed).toEqual([f.row.id]);
  expect(readFileSync(f.file, "utf8")).toBe(f.line);
});


test("actual mixed prune publishes only attested public targets and private masks never reach another generation home", async () => {
  const f = await fixture(); let now = f.now;
  const writer = new MemoryStore({ home: dirname(f.store.profile.home), ttlMs: 1, now: () => now, deferPromotions: true }); cleanup.push(() => writer.close());
  const id = writer.note({ op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "contract", peer: "person", text: "synthetic public expiry", about: [], source: "person" }); writer.demote(id, "person"); now += 2;
  const bindings: string[] = [], auth = { ...f.auth, policy: { revision: () => "policy-v1", classify: (source: import("../src/memory/prune.ts").PruneSourceRow) => source.publicWitness && source.placement === "synced" ? "public" as const : "private" as const,
    attest: (binding: import("../src/memory/prune.ts").PrunePolicyBinding) => { bindings.push(binding.payloadHash); return true; } } };
  const plan = planPrune(writer.prunePort(), { cutoff: new Date(now).toISOString() }, auth);
  expect(plan.counts).toMatchObject({ selected: 2, local: 1, synced: 1 });
  applyPrune(writer.prunePort(), plan, auth); expect(bindings.length).toBeGreaterThan(0);
  const remote = join(dirname(f.store.profile.home), "private-remote.git");
  const init = memoryGitSync(["init", "--bare", "-q", remote], { cwd: dirname(remote), encoding: "utf8" }); expect(init.status).toBe(0);
  const visibility = async () => "private" as const;
  expect(await syncMemory(writer, { remote, visibility })).toMatchObject({ ok: true, pushed: true });
  const show = memoryGitSync(["--git-dir", remote, "show", `refs/heads/amem/gen/${writer.profile.generation}:log/${writer.machine.id}.jsonl`], { cwd: dirname(remote), encoding: "utf8" });
  expect(show.status).toBe(0); expect(show.stdout).toContain(id); expect(show.stdout).not.toContain(f.id);
  const peerHome = mkdtempSync(join(tmpdir(), "amem-gen-public-peer-")); cleanup.push(() => rmSync(peerHome, { recursive: true, force: true }));
  const legacy = new MemoryStore({ home: peerHome }); legacy.close();
  await migrate({ memoryDir: join(peerHome, "memory"), mode: "apply", generation: writer.profile.generation, authorizedPerson: true, tty: true });
  const peer = new MemoryStore({ home: peerHome, now: () => f.now - 1, deferPromotions: true }); cleanup.push(() => peer.close());
  expect(await syncMemory(peer, { remote, visibility })).toMatchObject({ ok: true });
  expect(peer.get(id)).toBeUndefined(); expect(peer.get(f.id)).toBeUndefined();
  expect(peer.prunePort().snapshot().pruned).toContain(id);
  expect(JSON.stringify(peer.prunePort().snapshot())).not.toContain(f.id);
});
