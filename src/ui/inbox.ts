/** Compact inbox computation. Run in the background worker, never on the console request loop. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { withPendingCandidates, type Candidate, type CandidateInput } from "../memory/candidates.ts";
import { capacityReport } from "../memory/capacity.ts";
import { configuredPolicy, configuredPolicyOptions } from "../memory/config.ts";
import { openCuratedForRead } from "../memory/curated-read.ts";
import { lifecycleResolver } from "../memory/lifecycle.ts";
import { memoryPolicySnapshot, type StandalonePolicy } from "../memory/policy.ts";
import { DENY_NAMES, DENY_SEGMENTS } from "../memory/platform.ts";
import { aliasedKeys, effectiveAliases } from "../memory/shard.ts";
import type { MemoryStore } from "../memory/store.ts";

export interface InboxItem {
  id: string; group: "candidate" | "alert"; kind: string; title: string; detail?: string; project?: string; at: string;
  chip?: { text: string; tone: "ok" | "warn" | "err" | "neutral" };
  verbs: { id: string; label: string; primary?: boolean; reason?: "optional" | "required" }[];
  link: { panel: string; params?: Record<string, string> };
}
export interface InboxDefaults { names: string[]; segments: string[] }
export function inboxPolicyDefaults(): InboxDefaults {
  const defaults = memoryPolicySnapshot({ names: DENY_NAMES, segments: DENY_SEGMENTS });
  if (!defaults || !Array.isArray(defaults.names) || !Array.isArray(defaults.segments)
    || !defaults.names.every(value => typeof value === "string") || !defaults.segments.every(value => typeof value === "string")) throw Error("inbox policy is unavailable");
  return defaults;
}
export function inboxPolicyVersion(base: string): string {
  return createHash("sha256").update(JSON.stringify({ options: configuredPolicyOptions(base), defaults: inboxPolicyDefaults() })).digest("hex");
}
export const INBOX_MAX_ITEMS = 50, INBOX_MAX_BYTES = 64 * 1024;
export const CAPACITY_CACHE_MS = 5 * 60_000;
const oneLine = (text: string, max = 120) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat; };
export function candidateText(input: CandidateInput): string {
  switch (input.kind) {
    case "memory": return input.title ? `${input.title}: ${input.text}` : input.text;
    case "fail": return `Approach: ${input.approach}\nSymptom: ${input.symptom}\nCause: ${input.cause}\nRetry when: ${input.retryWhen}`;
    case "correction": return `${input.proposedText}\n\nReason: ${input.reason}`;
    case "decay": return input.reason;
    case "promotion": return `Promote mem:${input.target.id} to long-term for goal:${input.goalId}`;
    case "consolidation": return `${input.action}: ${input.text}`;
    case "model-answer": return input.text;
  }
}
export const candidateTargets = (input: CandidateInput) => "targets" in input ? input.targets : "target" in input && input.target ? [input.target] : [];
/** Shared with Review: the candidate, every target, and the promotion goal must pass current policy. */
export function visibleCandidate(candidate: Candidate, project: string, store: MemoryStore | undefined, policy: StandalonePolicy): boolean {
  if (!policy.screenStandalone(candidate)) return false;
  const input = candidate.input, targets = candidateTargets(input);
  if (!targets.length && input.kind !== "promotion") return true;
  if (!store) return false;
  if (targets.some(target => { const view = store.get(target.id, project); return !view || view.project !== project || !policy.screenStandalone(view); })) return false;
  if (input.kind === "promotion") { const goal = store.goalOf(input.goalId, project); if (!goal || !policy.screenStandalone(goal)) return false; }
  return true;
}
export interface CapacityMemo { policy: string; until: number; item: InboxItem | null; captureConfig: string }
export function inboxCaptureConfigVersion(base: string): string { return stamp(base, "capture-config.json") ?? "missing"; }
export interface InboxComputation { items: InboxItem[]; more: number; policy: string; capacity: CapacityMemo }
const order = (a: InboxItem, b: InboxItem) => Number(b.group === "alert") - Number(a.group === "alert") || b.at.localeCompare(a.at) || a.id.localeCompare(b.id);
/** Only row-rendered fields cross the worker boundary; details stay in the item's panel. */
export function computeInbox(base: string, previous?: CapacityMemo): InboxComputation {
  const revision = inboxPolicyVersion(base), policy = configuredPolicy(base), active = lifecycleResolver(base), aliases = effectiveAliases(base);
  const items: InboxItem[] = []; let count = 0;
  const add = (item: InboxItem) => {
    if (!policy.screenStandalone(item)) return;
    count++; items.push(item); items.sort(order); if (items.length > INBOX_MAX_ITEMS) items.pop();
  };
  if (existsSync(join(base, "candidates.db"))) withPendingCandidates(base, reader => {
    const projects = [...new Set(reader.projects().map(project => aliases.get(project) ?? project))].filter(project => active(project) === "active").sort();
    const reuseShared = !existsSync(join(base, "shards.json")) && aliases.size === 0;
    let shared: MemoryStore | undefined, sharedOpened = false;
    try {
      for (const project of projects) {
        let store: MemoryStore | undefined, opened = false;
        try {
          for (const candidate of reader.list([project, ...aliasedKeys(base, project)])) {
            if (!policy.screenStandalone(candidate)) continue;
            if (!opened && (candidateTargets(candidate.input).length || candidate.input.kind === "promotion")) {
              if (reuseShared) {
                if (!sharedOpened) { shared = openCuratedForRead(base, project); sharedOpened = true; }
                store = shared;
              } else store = openCuratedForRead(base, project);
              opened = true;
            }
            if (!visibleCandidate(candidate, project, store, policy)) continue;
            const kind = candidate.input.kind;
            add({ id: candidate.id, group: "candidate", kind, title: oneLine(candidateText(candidate.input)), project, at: candidate.createdAt,
              verbs: [...kind !== "decay" && kind !== "model-answer" ? [{ id: "accept", label: "Accept", primary: true }] : [], { id: "reject", label: "Reject", reason: "optional" }],
              link: { panel: "review", params: { project, id: candidate.id } } });
          }
        } finally { if (!reuseShared) store?.close(); }
      }
    } finally { shared?.close(); }
  });
  let capacity = previous;
  const captureConfig = inboxCaptureConfigVersion(base);
  // ponytail: resource advice is cached for at most five minutes. The Capacity panel/action still computes fresh
  // advice; incremental capture counters and bounded asynchronous native readings are the upgrade path.
  if (!capacity || capacity.policy !== revision || capacity.captureConfig !== captureConfig || Date.now() >= capacity.until) {
    let item: InboxItem | null = null;
    if (existsSync(base)) {
      const report = capacityReport({ memoryDir: base });
      if (policy.screenStandalone(report) && (report.current.capMb !== report.proposal.capMb || report.current.retentionDays !== report.proposal.retentionDays)) {
        item = { id: "capacity:proposal", group: "alert", kind: "capacity", title: oneLine(`Capture capacity: ${report.current.capMb} MB / ${report.current.retentionDays} d, proposed ${report.proposal.capMb} MB / ${report.proposal.retentionDays} d`),
          detail: oneLine(report.proposal.reason, 160), at: new Date().toISOString(), chip: { text: "proposal", tone: "warn" },
          verbs: [{ id: "capacity_apply", label: "Apply..." }], link: { panel: "capacity" } };
      }
    }
    capacity = { policy: revision, until: Date.now() + CAPACITY_CACHE_MS, item, captureConfig };
  }
  if (capacity.item) add(capacity.item);
  while (Buffer.byteLength(JSON.stringify({ items, more: count - items.length })) > INBOX_MAX_BYTES - 512 && items.length) items.pop();
  if (inboxPolicyVersion(base) !== revision) throw Error("inbox policy changed");
  return { items, more: count - items.length, policy: revision, capacity };
}

export interface InboxSources { paths: string[]; version: string }
const MAX_SOURCES = 16_384;
const excludedDirectories = new Set(["machine", "readers", "shard-readers", "hook-spool", "shard-sync", "shard-sync-placement", ".git", "node_modules"]);
function included(name: string): boolean { return name !== "metrics.jsonl" && (!/\.db(?:-wal|-shm)?$/.test(name) || name === "candidates.db" || name === "candidates.db-wal"); }
function stamp(base: string, relative: string, budget = { left: MAX_SOURCES }): string | undefined {
  const file = join(base, relative), stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!stat || relative === "candidates.db-wal" && stat.size === 0n) return undefined;
  if (stat.isSymbolicLink()) throw Error("inbox source is unavailable");
  if (stat.isDirectory()) {
    const names: string[] = [], dir = opendirSync(file);
    try { let entry; while ((entry = dir.readSync())) {
      if (--budget.left < 0) throw Error("inbox source inventory exceeds its bound");
      if (entry.isDirectory() ? excludedDirectories.has(entry.name) : !included(entry.name)) continue;
      if (names.length >= MAX_SOURCES) throw Error("inbox source inventory exceeds its bound");
      if (entry.name === "candidates.db-wal" && !lstatSync(join(file, entry.name), { bigint: true }).size) continue;
      names.push(entry.name);
    } } finally { dir.closeSync(); }
    return JSON.stringify([String(stat.dev), String(stat.ino), String(stat.mode), names.sort()]);
  }
  if (!stat.isFile()) throw Error("inbox source is unavailable");
  return JSON.stringify([String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
}
/** Metadata only on the request loop, never a catalog/store/body scan. Capture DBs/leases/derived indices are excluded.
 * ponytail: at most 16384 source files/directories. Larger homes need a core append-revision protocol instead of
 * relaxing the bound or silently treating an incomplete inventory as an unchanged snapshot. */
export function inboxSourceVersion(base: string, paths: readonly string[]): string {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_SOURCES || !paths.includes("") || new Set(paths).size !== paths.length
    || paths.some(relative => typeof relative !== "string" || relative.startsWith("/") || Buffer.byteLength(relative) > 4096
      || relative !== "" && relative.split("/").some(part => !part || part === "." || part === ".."))) throw Error("inbox source inventory is invalid");
  const hash = createHash("sha256"), budget = { left: MAX_SOURCES }; for (const relative of paths) hash.update(JSON.stringify([relative, stamp(base, relative, budget) ?? null])); return hash.digest("hex");
}
export function inboxSources(base: string): InboxSources {
  const paths: string[] = []; let entries = 0;
  const visit = (relative: string) => {
    if (paths.length >= MAX_SOURCES) throw Error("inbox source inventory exceeds its bound");
    paths.push(relative); const file = join(base, relative), stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return;
    const dir = opendirSync(file);
    try { let entry; while ((entry = dir.readSync())) {
      if (++entries > MAX_SOURCES) throw Error("inbox source inventory exceeds its bound");
      if (entry.isDirectory() ? excludedDirectories.has(entry.name) : !included(entry.name)) continue;
      if (entry.name === "candidates.db-wal" && !lstatSync(join(file, entry.name)).size) continue;
      visit(relative ? `${relative}/${entry.name}` : entry.name);
    } } finally { dir.closeSync(); }
  };
  visit(""); paths.sort(); return { paths, version: inboxSourceVersion(base, paths) };
}
