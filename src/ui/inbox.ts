/** Compact inbox computation. Run in the background worker, never on the console request loop. */
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { join, relative } from "node:path";
import { withPendingCandidates, type Candidate, type CandidateInput } from "../memory/candidates.ts";
import { capacityReport } from "../memory/capacity.ts";
import { configuredPolicy, configuredPolicyOptions } from "../memory/config.ts";
import { openCuratedForRead } from "../memory/curated-read.ts";
import { lifecycleResolver } from "../memory/lifecycle.ts";
import { memoryPolicySnapshot, type StandalonePolicy } from "../memory/policy.ts";
import { DENY_NAMES, DENY_SEGMENTS } from "../memory/platform.ts";
import { aliasedKeys, effectiveAliases } from "../memory/shard.ts";
import type { MemoryStore } from "../memory/store.ts";
import { checkedEntry } from "../memory/bridge.ts";
import { readProfileJSON, readSelector, generationDir } from "../memory/generation.ts";
import { shardDir } from "../memory/shard.ts";
import { readPublicPruneViewForActivation } from "../memory/public-prune-view.ts";

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
export function inboxCaptureConfigVersion(base: string): string { return JSON.stringify(state(base, "capture-config.json")); }
export interface InboxComputation { items: InboxItem[]; more: number; policy: string; capacity: CapacityMemo; expiresAt: number | null }
const order = (a: InboxItem, b: InboxItem) => Number(b.group === "alert") - Number(a.group === "alert") || b.at.localeCompare(a.at) || a.id.localeCompare(b.id);
/** Only row-rendered fields cross the worker boundary; details stay in the item's panel. */
export function computeInbox(base: string, previous?: CapacityMemo, beforeProject?: (project: string) => void): InboxComputation {
  const revision = inboxPolicyVersion(base), policy = configuredPolicy(base), active = lifecycleResolver(base), aliases = effectiveAliases(base);
  const items: InboxItem[] = []; let count = 0, expiresAt: number | null = null;
  const add = (item: InboxItem) => {
    if (!policy.screenStandalone(item)) return;
    count++; items.push(item); items.sort(order); if (items.length > INBOX_MAX_ITEMS) items.pop();
  };
  withPendingCandidates(base, reader => {
    expiresAt = reader.nextExpiry();
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
              beforeProject?.(project);
              if (reuseShared) {
                if (!sharedOpened) { shared = openCuratedForRead(base, project); sharedOpened = true; }
                store = shared;
              } else store = openCuratedForRead(base, project);
              opened = true;
            }
            if (!visibleCandidate(candidate, project, store, policy)) continue;
            for (const target of candidateTargets(candidate.input)) {
              const value = store?.get(target.id, project)?.expiresAt, at = value ? Date.parse(value) : Number.NaN;
              if (Number.isFinite(at) && at > Date.now()) expiresAt = expiresAt === null ? at : Math.min(expiresAt, at);
            }
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
  const bounded = boundedInboxRows(items, count);
  if (inboxPolicyVersion(base) !== revision) throw Error("inbox policy changed");
  return { ...bounded, policy: revision, capacity, expiresAt };
}

/** totalCount counts real visible capacity/candidate rows, never the synthetic overflow hint. */
export function boundedInboxRows(input: readonly InboxItem[], totalCount: number): { items: InboxItem[]; more: number } {
  const previous = input.find(item => item.id === "inbox:more"), real = input.filter(item => item.id !== "inbox:more").sort(order);
  if (!Number.isSafeInteger(totalCount) || totalCount < real.length) throw Error("inbox overflow count is invalid");
  const at = previous?.at ?? new Date().toISOString();
  const make = () => {
    const more = totalCount - real.length;
    const hint: InboxItem = { id: "inbox:more", group: "alert", kind: "status", title: `${more} more in Review`, at, verbs: [], link: { panel: "review" } };
    const capacity = real.filter(item => item.id === "capacity:proposal"), other = real.filter(item => item.id !== "capacity:proposal");
    return { items: [...capacity, ...(more ? [hint] : []), ...other], more };
  };
  while (real.length > INBOX_MAX_ITEMS || totalCount > real.length && real.length >= INBOX_MAX_ITEMS) real.pop();
  let result = make();
  while ((result.items.length > INBOX_MAX_ITEMS || Buffer.byteLength(JSON.stringify(result)) > INBOX_MAX_BYTES - 512) && real.length) { real.pop(); result = make(); }
  if (result.items.length > INBOX_MAX_ITEMS || Buffer.byteLength(JSON.stringify(result)) > INBOX_MAX_BYTES - 512) throw Error("inbox rows exceed their bound");
  return result;
}

export interface InboxSourceState {
  kind: "missing" | "file" | "directory";
  category: "fixed" | "candidate" | "log" | "metadata";
  dev?: string; ino?: string; mode?: string; size?: number; mtimeNs?: string; ctimeNs?: string; names?: string[];
}
export interface InboxSources { paths: string[]; roots: string[]; states: Record<string, InboxSourceState>; version: string }
const MAX_SOURCES = 16_384, MAX_TAIL_BYTES = 256 * 1024;
const fixedFiles = ["amem.config.json", "capture-config.json", "formats.json", "profile.json", "shards.json", "aliases.jsonl", "lifecycle.jsonl", "profile.lock", "public-prune-view.intent.json", "candidates.db", "candidates.db-wal"];
const logDirectory = (value: string) => /(?:^|\/)(?:log|local)$/.test(value);
const evidenceDirectory = (value: string) => /(?:^|\/)(?:public-prune-objects|public-prune-inputs|public-prune-input-sets|bridge-snapshots)(?:\/|$)/.test(value);
function validPath(value: string): void {
  if (typeof value !== "string" || value.startsWith("/") || Buffer.byteLength(value) > 4096 || value !== "" && value.split("/").some(part => !part || part === "." || part === "..")) throw Error("inbox source inventory is invalid");
}
function category(value: string): InboxSourceState["category"] {
  return value === "candidates.db" || value === "candidates.db-wal" ? "candidate" : fixedFiles.includes(value) || value === "" ? "fixed"
    : evidenceDirectory(value) ? "metadata" : /(?:^|\/)(?:log|local)\/[^/]+[.]jsonl$/.test(value) ? "log" : "metadata";
}
function state(base: string, path: string): InboxSourceState {
  validPath(path); const stat = lstatSync(join(base, path), { bigint: true, throwIfNoEntry: false }), type = category(path);
  if (!stat || path === "candidates.db-wal" && stat.size === 0n) return { kind: "missing", category: type };
  if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw Error("inbox source is unavailable");
  return { kind: stat.isDirectory() ? "directory" : "file", category: type, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    ...(stat.isFile() ? { size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } : {}) };
}
function snapshotSources(base: string, roots: readonly string[], budget = { left: MAX_SOURCES }): InboxSources {
  if (roots.length > MAX_SOURCES || new Set(roots).size !== roots.length) throw Error("inbox source inventory exceeds its bound");
  const states: Record<string, InboxSourceState> = Object.create(null), traversed = new Set<string>(); let visited = 0;
  const record = (path: string) => {
    if (!Object.hasOwn(states, path)) { if (++visited > MAX_SOURCES) throw Error("inbox source inventory exceeds its bound"); states[path] = state(base, path); }
    return states[path]!;
  };
  const visit = (path: string, recursive = false) => {
    validPath(path); const parts = path.split("/"); for (let index = 1; index < parts.length; index++) record(parts.slice(0, index).join("/"));
    const current = record(path);
    if (current.kind !== "directory" || traversed.has(path) || !logDirectory(path) && !evidenceDirectory(path) && !recursive) return;
    traversed.add(path);
    const iterator = opendirSync(join(base, path)), names: string[] = [];
    try { for (;;) { const entry = iterator.readSync(); if (!entry) break; if (--budget.left < 0) throw Error("inbox source inventory exceeds its bound");
      if (!recursive && logDirectory(path) && !entry.name.endsWith(".jsonl")) continue;
      names.push(entry.name); visit(path ? `${path}/${entry.name}` : entry.name, recursive || evidenceDirectory(path));
    } } finally { iterator.closeSync(); }
    current.names = names.sort();
  };
  visit(""); for (const file of fixedFiles) visit(file); for (const root of roots) { validPath(root); visit(root); }
  const paths = Object.keys(states).sort(), ordered: Record<string, InboxSourceState> = Object.create(null); for (const path of paths) ordered[path] = states[path]!;
  return { paths, roots: [...roots].sort(), states: ordered, version: createHash("sha256").update(JSON.stringify(ordered)).digest("hex") };
}
export function inboxSources(base: string, roots: readonly string[] = []): InboxSources { return snapshotSources(base, roots); }
/** Compatibility helper for existing metadata-only fixtures; production uses inboxSourceChange with the complete frame. */
export function inboxSourceVersion(base: string, paths: readonly string[]): string {
  return snapshotSources(base, paths.filter(path => path !== "" && !fixedFiles.includes(path))).version;
}
function plainNoteTail(base: string, path: string, before: InboxSourceState | undefined, after: InboxSourceState, budget: { left: number }): boolean {
  const offset = before?.kind === "file" ? before.size! : 0;
  if (after.kind !== "file" || before && before.kind !== "missing" && (before.kind !== "file" || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode)
    || !Number.isSafeInteger(offset) || !Number.isSafeInteger(after.size) || after.size! <= offset || after.size! - offset > budget.left) return false;
  const length = after.size! - offset, file = join(base, path), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (String(opened.dev) !== after.dev || String(opened.ino) !== after.ino || Number(opened.size) !== after.size || String(opened.mtimeNs) !== after.mtimeNs || String(opened.ctimeNs) !== after.ctimeNs) return false;
    const bytes = Buffer.alloc(length); let at = 0; while (at < length) { const count = readSync(fd, bytes, at, length - at, offset + at); if (!count) return false; at += count; }
    budget.left -= length;
    const current = fstatSync(fd, { bigint: true }); if (String(current.ctimeNs) !== after.ctimeNs || Number(current.size) !== after.size || bytes.at(-1) !== 10) return false;
    for (const line of new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).split("\n").slice(0, -1)) {
      const row = checkedEntry(JSON.parse(line));
      if (row.op !== "note" || row.supersedes !== undefined || row.promotedFrom !== undefined) return false;
    }
    return true;
  } catch { return false; } finally { closeSync(fd); }
}
/** Classifies only prior screened data for stale serving, never admits a new body.
 * ponytail: large-file append classification trusts the repository's append-only writer invariant. A same-user
 * raw prefix rewrite plus plain-note suffix is outside that ceiling; a core append-revision proof is the upgrade.
 * Only the complete new tail (256KiB total) is read on the request loop; the worker fully revalidates sources. */
export function inboxSourceChange(base: string, previous: InboxSources): { sources: InboxSources; changed: boolean; hard: boolean } {
  const sources = snapshotSources(base, previous.roots); if (sources.version === previous.version) return { sources, changed: false, hard: false };
  let hard = false; const budget = { left: MAX_TAIL_BYTES }, changes = new Set([...previous.paths, ...sources.paths]);
  for (const path of changes) {
    const before = previous.states[path], after = sources.states[path]; if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (after?.category === "candidate" && (path === "candidates.db-wal" && (after.kind === "missing" || after.kind === "file") && (!before || before.kind === "missing" || before.kind === "file")
      || (!before || before.kind === "missing") && after.kind === "file"
      || before?.kind === "file" && after.kind === "file" && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && after.size! >= before.size!)) continue;
    if (after?.category === "log" && plainNoteTail(base, path, before, after, budget)) continue;
    // A log namespace may grow only when every added file is itself a verified plain-note tail.
    if (before?.kind === "directory" && after?.kind === "directory" && logDirectory(path) && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
      && (before.names ?? []).every(name => after.names?.includes(name))) continue;
    hard = true;
  }
  return { sources, changed: true, hard };
}
function projectRoots(base: string, project: string): string[] {
  const roots = new Set<string>(), selected = readSelector(base).selector;
  const view = selected?.schema === "agent-mem.profile/v2" || selected?.schema === "agent-mem.profile/v3"
    ? readPublicPruneViewForActivation(base, selected.pruneInputSetHash, selected.generation) : undefined;
  const add = (value: string) => { const path = relative(base, value); validPath(path); roots.add(path); };
  add(join(base, "machine.json"));
  const raw = (dir: string) => { add(dir); for (const folder of ["log", "local"]) add(join(dir, folder)); };
  const metadata = (dir: string) => { for (const name of ["project.json", "generation.json", "generation-seal.json", "migration-sources.json", "machine.json", "prune-translations.jsonl"]) add(join(dir, name)); };
  const bridge = (dir: string, generation: string) => {
    const pointer = join(dir, "generations", generation, "bridge-snapshot.json"); add(pointer);
    const value = readProfileJSON(pointer, 4096) as { commit?: unknown } | undefined;
    if (value?.commit !== undefined) { if (typeof value.commit !== "string" || value.commit.length !== 40 || !/^[a-f0-9]+$/.test(value.commit)) throw Error("inbox bridge source is invalid"); add(join(dir, "generations", generation, "bridge-snapshots", value.commit)); }
  };
  if (existsSync(join(base, "shards.json"))) {
    const keys = [project, ...aliasedKeys(base, project)];
    for (const { dir, key } of [{ dir: join(base, "user"), key: "user" }, ...keys.map(key => ({ dir: shardDir(base, key), key: `project:${key}` }))]) {
      raw(dir); metadata(dir);
      for (const legacy of [join(dir, "legacy"), join(dir, "legacy-main")]) { raw(legacy); add(join(legacy, "machine.json")); }
      if (view?.realms[key]) for (const folder of ["public-prune-objects", "public-prune-inputs", "public-prune-input-sets"]) add(join(dir, folder));
    }
  } else {
    raw(base);
    if (selected?.kind === "generation" && selected.generation) { const dir = generationDir(base, selected.generation); raw(dir); metadata(dir); bridge(base, selected.generation); }
  }
  if (selected?.schema === "agent-mem.profile/v2" || selected?.schema === "agent-mem.profile/v3") add(join(base, "public-prune-input-sets", `${selected.pruneInputSetHash}.json`));
  if (selected?.schema === "agent-mem.profile/v3") {
    add(join(base, "sync-placement", "active.json"));
    for (const name of ["epoch.json", "activation.json"]) add(join(base, "sync-placement", "epochs", selected.placementHead, name));
  }
  return [...roots].sort();
}
export function createInboxSourceTracker(base: string) {
  const initial = snapshotSources(base, []), frames: InboxSources[] = [], roots = new Set<string>(), projects = new Set<string>(), budget = { left: MAX_SOURCES };
  return { beforeProject(project: string) {
    if (projects.has(project)) return; projects.add(project); const added = projectRoots(base, project).filter(path => !roots.has(path));
    for (const path of added) roots.add(path); if (added.length) frames.push(snapshotSources(base, added, budget));
  }, before(): InboxSources {
    const states: Record<string, InboxSourceState> = Object.assign(Object.create(null), initial.states);
    for (const frame of frames) for (const path of frame.paths) if (!Object.hasOwn(states, path)) states[path] = frame.states[path]!;
    const paths = Object.keys(states).sort(); if (paths.length > MAX_SOURCES) throw Error("inbox source inventory exceeds its bound");
    const ordered: Record<string, InboxSourceState> = Object.create(null); for (const path of paths) ordered[path] = states[path]!;
    return { paths, roots: [...roots].sort(), states: ordered, version: createHash("sha256").update(JSON.stringify(ordered)).digest("hex") };
  }, after() { return snapshotSources(base, [...roots]); } };
}
