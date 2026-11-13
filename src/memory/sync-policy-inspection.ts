import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { types } from "node:util";
import { join } from "node:path";
import { SegmentReadBudgetError } from "./bridge.ts";
import { inspectionBoundReceipt, type InspectionBoundReceipt } from "./inspection-bound.ts";
import { DENY_NAMES, DENY_SEGMENTS } from "./platform.ts";
import { memoryPolicySnapshot } from "./policy.ts";
import { loadAmemConfig } from "./config.ts";
import { canonicalJSON, readProfileJSON, selectorRevision } from "./generation.ts";
import { assertFormatFloor } from "./formats.ts";
import type { MemoryStore } from "./store.ts";
import { shardSyncBinding } from "./sync-binding.ts";
import { outboundPolicyEvaluator, visitOwnSegment, SYNC_SCREEN_MAX_BYTES, SYNC_SCREEN_MAX_ROWS, type RowScreen, type SyncPolicyCategory } from "./sync-screen.ts";

export type { SyncPolicyCategory } from "./sync-screen.ts";
export interface SyncPolicyInspectionOptions {
  /** Narrows the machine policy, over the same canonical content projection as SyncOptions.screen. */
  screen?: RowScreen;
  /** Optional host epoch, as in SyncOptions.policyVersion. A change makes the inspection incomplete. */
  policyVersion?: () => string;
}
export interface SyncPolicyDeclinedRow { id: string; categories: SyncPolicyCategory[] }
export type SyncPolicyInspection = {
  complete: true;
  declined: SyncPolicyDeclinedRow[];
  counts: { scanned: number; declined: number; byCategory: Record<SyncPolicyCategory, number> };
  /** SHA-256 over the sorted complete declined IDs/categories, never over private content or policy patterns. */
  fingerprint: string;
} | { complete: false; reason: "input-unavailable" | "input-bound" | "input-changed" | "binding-changed" | "policy-unavailable"; bound?: InspectionBoundReceipt };

const hash = (value: unknown) => createHash("sha256").update(canonicalJSON(value)).digest("hex");

/** Bounded, read-only inspection of exactly the opened sync targets. No refresh, rebind, publication or transport. */
export function inspectSyncPolicy(store: MemoryStore, options: SyncPolicyInspectionOptions = {}): SyncPolicyInspection {
  let failure: Extract<SyncPolicyInspection, {complete: false}>["reason"] = "input-unavailable";
  try {
    assertFormatFloor(store.profile.home, "sync");
    const targets = [...store.openedSyncTargets()];
    const metadata = [...new Set([join(store.profile.home, "profile.json"), join(store.profile.home, "shards.json"), join(store.profile.home, "aliases.jsonl"), join(store.profile.home, "amem.config.json"), join(store.profile.home, "machine.json"), ...targets.flatMap(target => [join(target.dir, "machine.json"), join(target.dir, "project.json"), ...(target.profile.kind === "generation" ? [join(target.dir, "generation.json"), join(target.dir, "generation-seal.json"), join(target.dir, "migration-sources.json")] : [])])])];
    const stamps = () => metadata.map(file => {
      const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (!stat) return "absent";
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(SYNC_SCREEN_MAX_BYTES)) throw new Error("metadata unavailable");
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    });
    const binding = () => hash({
      stamps: stamps(),
      root: store.profile,
      selector: selectorRevision(store.profile.home),
      ...(store.profile.sharded ? { shards: shardSyncBinding(store) } : {}),
      targets: targets.map(target => ({ profile: target.profile, machine: target.machine,
        selector: selectorRevision(target.profile.home),
        machineFile: readProfileJSON(join(target.dir, "machine.json"), 4096),
        ...(target.profile.kind === "generation" ? {
          generation: readProfileJSON(join(target.dir, "generation.json"), 4096),
          seal: readProfileJSON(join(target.dir, "generation-seal.json")),
        } : {}),
      })),
    });
    // Stale handles are not silently rebound, including a monotone selector change supported by sync itself.
    if (targets.some(target => selectorRevision(target.profile.home) !== target.profile.selectorRevision)) return { complete: false, reason: "binding-changed" };
    if (targets.some(target => (readProfileJSON(join(target.dir, "machine.json"), 4096) as {id?: unknown} | undefined)?.id !== target.machine.id)) return { complete: false, reason: "binding-changed" };
    const epoch = binding();
    failure = "policy-unavailable";
    const policyVersion = options.policyVersion?.();
    if (options.policyVersion !== undefined && typeof policyVersion !== "string") throw new Error("host policy unavailable");
    const defaults = () => {
      const value = memoryPolicySnapshot({ names: DENY_NAMES, segments: DENY_SEGMENTS });
      if (!value) throw new Error("policy unavailable");
      return hash(value);
    };
    const defaultEpoch = defaults();
    const policy = () => hash({ config: loadAmemConfig(store.profile.home).config, defaults: defaults() });
    failure = "policy-unavailable";
    const policyEpoch = policy(), evaluate = outboundPolicyEvaluator(store.profile.home, options.screen);
    const assertCurrent = () => {
      failure = "binding-changed";
      if (binding() !== epoch || canonicalJSON(store.openedSyncTargets().map(target => [target.dir, target.machine.id])) !== canonicalJSON(targets.map(target => [target.dir, target.machine.id]))) throw new Error("binding changed");
      failure = "policy-unavailable";
      if (policy() !== policyEpoch || options.policyVersion?.() !== policyVersion) throw new Error("policy changed");
    };
    const ids = new Map<string, { hash: string; categories: Set<SyncPolicyCategory> }>();
    let scanned = 0;
    const visit = (row: Record<string, unknown>) => {
      scanned++; // Admission is per target, matching actual generation/shard screening.
      failure = "input-unavailable";
      if (typeof row.id !== "string" || !/^[a-f0-9]{32}$/.test(row.id)) throw new Error("row id unavailable");
      const rowHash = hash(row), prior = ids.get(row.id);
      if (prior && prior.hash !== rowHash) throw new Error("row identity changed");
      failure = "policy-unavailable";
      if (defaults() !== defaultEpoch) throw new Error("default policy changed");
      const verdict = evaluate(row);
      if (defaults() !== defaultEpoch) throw new Error("default policy changed");
      const item = prior ?? { hash: rowHash, categories: new Set<SyncPolicyCategory>() };
      if (!verdict.ok) item.categories.add(verdict.category);
      ids.set(row.id, item);
      if (options.policyVersion?.() !== policyVersion) { failure = "policy-unavailable"; throw new Error("host policy changed"); }
    };
    const checks: (() => void)[] = [];
    for (const target of targets) {
      assertCurrent(); failure = "input-unavailable";
      if (target.profile.kind === "generation") checks.push(target.inspectOutboundRows(visit, { maxBytes: SYNC_SCREEN_MAX_BYTES, maxRows: SYNC_SCREEN_MAX_ROWS }));
      else checks.push(visitOwnSegment(target.dir, target.machine.id, visit));
      assertCurrent();
    }
    for (const check of checks) { failure = "input-changed"; check(); }
    assertCurrent();
    const declined = [...ids].filter(([, item]) => item.categories.size > 0).sort(([a], [b]) => a.localeCompare(b))
      .map(([id, item]) => ({ id, categories: [...item.categories].sort() }));
    const byCategory: Record<SyncPolicyCategory, number> = { secret: 0, "personal-data": 0, "deny-path": 0, "private-or-invalid": 0, host: 0 };
    for (const row of declined) for (const category of row.categories) byCategory[category]++;
    return { complete: true, declined, counts: { scanned, declined: declined.length, byCategory }, fingerprint: hash(declined) };
  } catch (error) {
    let reason: Extract<SyncPolicyInspection, { complete: false }>["reason"] = failure;
    // Caller errors are not trusted diagnostics: never read message, getters or proxy properties.
    try {
      if (error && typeof error === "object" && !types.isProxy(error)) {
        const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
        if (["input-unavailable", "input-bound", "input-changed"].includes(code)) reason = code;
        else if (error instanceof SegmentReadBudgetError) reason = "input-bound";
      }
    } catch { /* An exotic caller exception cannot escape as a data-bearing error. */ }
    const bound = reason === "input-bound" ? inspectionBoundReceipt(error) : undefined;
    return { complete: false, reason, ...(bound ? { bound } : {}) };
  }
}
