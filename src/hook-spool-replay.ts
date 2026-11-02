/**
 * #217 PR2: off-hook replay of orphaned or parked hook-spool records. CLI-only and lazily loaded: no hook imports it, it
 * starts no resident process and makes no network or model call.
 *
 * Preview (`planHookSpoolReplay`) is read-only and body-free: it creates no directory, cache, database or index and changes
 * no mode. It binds everything the apply step depends on. Apply (`applyHookSpoolReplay`) takes that saved plan, revalidates
 * the whole binding before any effect, and replays only records the plan classified `replayable`.
 *
 * Decision A (owner, 2026-11-02): an opaque legacy root carries no writer or algorithm tag, so an unknown historical device
 * hash does not prove a replacement. Such a record is `physical_identity_unverifiable` (plus `attribution_unproven`); the
 * preview shows its recorded cwd, current project and count, and it is never guessed, rebound or retired automatically.
 * Decision B: the saved plan is the resume token. The claim suffix is hash(plan digest, publication), so the same plan
 * recognizes and resumes its own claims; any other claim (another plan's, or a live hook drainer's random one) is reported
 * `claimed_elsewhere` and left alone. No
 * durable mapping store exists.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { hookCaptureScope, hookLegacyCaptureScope, hookSpoolReplayInternals as spool, type HookSpoolOwnedFile } from "./hook-spool.ts";
import { aliasedKeys, resolveAlias } from "./memory/aliases.ts";
import { CaptureStore, type CaptureInput } from "./memory/capture.ts";
import { configuredPolicyOptions } from "./memory/config.ts";
import { projectState } from "./memory/lifecycle.ts";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { createStandalonePolicy } from "./memory/policy.ts";
import { memoryProjectKey } from "./memory/project.ts";

export const REPLAY_PLAN_SCHEMA = "agent-mem.hook-spool-replay-plan/v1";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export type ReplayClass =
  | "replayable"                       // decoded, scope verified on this boot, project resolved and active, policy-screened
  | "physical_identity_unverifiable"   // decision A: scope mismatch only; applied solely with --confirm-unverifiable
  | "attribution_unproven"             // project identity could not be resolved strictly from the record's own cwd
  | "cwd_missing"                      // the recorded cwd no longer exists; never rebound
  | "project_inactive"                 // the resolved project is archived or forgotten
  | "policy_refused"                   // the record or its capture input fails the configured policy
  | "unknown_schema"                   // #199: a newer or unknown schema stays pending, untouched
  | "undecodable"                      // malformed or oversized: left for the hook path's own retirement rules
  | "claimed_elsewhere";               // decision B: another plan's or a live drainer's claim, left alone

export interface ReplayPlanRecord {
  /** Publication canonical name (without any `.draining-` suffix) and where it was observed. */
  name: string; tier: "active" | "capacity" | "source";
  /** File identity and raw-byte digest bound at preview. */
  dev: number; ino: number; size: number; mtimeMs: number; digest: string;
  class: ReplayClass; reasons: ReplayClass[];
  /** Shown for confirmation, never a body: the recorded cwd, the current project for it, and the scope the hook path would compute now. */
  cwd: string; project: string | null; scope: string | null; event: string | null;
  /** Present when this plan already holds the claim (a resumed plan). */
  claimedBy?: "this_plan";
  /** Decision A: an unverifiable record whose cwd exists, whose strict project resolves and is active, and that passed the
   * full policy screen. Applied only with explicit confirmation of this plan's cwd -> project mapping. */
  confirmable?: true;
}
export interface HookSpoolReplayPlan {
  schema: typeof REPLAY_PLAN_SCHEMA;
  /** Destination home, snapshotted once and used for replay, policy, attribution and receipts alike. */
  home: string;
  source: { kind: "home" | "explicit"; dir: string; dev: number; ino: number }[];
  /** Policy-input revisions (home config, each repository config) and alias/lifecycle revisions bound at preview. */
  revisions: { aliases: string; lifecycle: string; policy: Record<string, string> };
  records: ReplayPlanRecord[];
  counts: Record<ReplayClass, number>;
  /** Decision A: the cwd -> project mappings (with counts) an explicit --confirm-unverifiable would apply, bound in the digest. */
  needsConfirmation: { cwd: string; project: string; count: number }[];
  /** Digest over everything above; the resume token and the claim-suffix seed. */
  digest: string;
}
export interface HookSpoolReplayReceipt {
  plan: string;
  applied: number; spooled: number; retired: number; retained: number;
  /** Planned publications no longer present (a resumed plan's completed records, or ones a drainer took): no effect. */
  absent: number;
  /** Per publication outcome; `applied_cleanup_failed` is still applied, never reported as not applied. */
  outcomes: { name: string; outcome: "applied" | "spooled" | "applied_cleanup_failed" | "retained" | "skipped" | "absent"; reason?: string }[];
}

/** Every error says what failed and what to do next (REVIEW.md). */
export class ReplayError extends Error {
  constructor(readonly code: string, cause: string, next: string) { super(`${cause}; ${next}`); this.name = "ReplayError"; }
}

const zeroCounts = (): Record<ReplayClass, number> => ({ replayable: 0, physical_identity_unverifiable: 0, attribution_unproven: 0, cwd_missing: 0,
  project_inactive: 0, policy_refused: 0, unknown_schema: 0, undecodable: 0, claimed_elsewhere: 0 });

/** Pure argument and source checks, run before any home, source or store access. */
export function assertReplaySource(source: string): void {
  if (typeof source !== "string" || !source || source.includes("\0")) throw new ReplayError("replay_source_invalid", "the replay source is empty or contains a NUL byte", "pass an absolute path to a private directory");
  if (!isAbsolute(source)) throw new ReplayError("replay_source_relative", "the replay source is a relative path", "pass the absolute path, for example ~/.agenthub/hook-spool-orphans-20261102 expanded");
}

function directoryIdentity(dir: string, kind: "home" | "explicit"): { kind: "home" | "explicit"; dir: string; dev: number; ino: number } | undefined {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ReplayError("replay_source_not_directory", `${dir} is not a real directory`, "pass a directory, not a file or a symbolic link");
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new ReplayError("replay_source_not_private", `${dir} is not a private directory owned by you`, "use the directory as amem created it (mode 0700); do not loosen its permissions");
  return { kind, dir: realPath(dir), dev: stat.dev, ino: stat.ino };
}

/** Bounded directory listing of publication names (and `.draining-` claims), without reading bodies. */
function listPublications(dir: string): { entry: string; stat: Stats }[] {
  const rows: { entry: string; stat: Stats }[] = [], reader = opendirSync(dir);
  try {
    for (let scanned = 0; scanned < spool.MAX_FILES * 4; scanned++) {
      const item = reader.readSync(); if (!item) break;
      if (!spool.namePattern.test(item.name)) continue;
      const stat = lstatSync(join(dir, item.name), { throwIfNoEntry: false });
      if (stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) rows.push({ entry: item.name, stat });
    }
  } finally { reader.closeSync(); }
  return rows.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.entry.localeCompare(b.entry));
}

/** Small, bounded read of a control file's bytes for a revision hash; absent means empty. */
function fileRevision(file: string): string {
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return hash("absent");
    if (!stat.isFile() || stat.size > 1024 * 1024) return hash("unusable");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const bytes = Buffer.alloc(fstatSync(fd).size); readSync(fd, bytes, 0, bytes.length, 0); return hash(bytes); } finally { closeSync(fd); }
  } catch { return hash("unreadable"); }
}

/** Strict, read-only project identity for the record's own cwd. It never touches the hook identity cache. */
function strictProject(cwd: string): string | undefined {
  try { return memoryProjectKey(cwd, { repositoryIsolation: true, strictGitErrors: true }); }
  catch (error) { if (exhausted(error)) throw resourceFailure(error)!; return undefined; }
}

/** One inspected publication. No descriptor outlives its inspection (I3): apply re-opens each record when it reaches it. */
interface Inspected { record: ReplayPlanRecord; path?: string }
/** Descriptor or process-table exhaustion (or any other non-race open failure) must fail the run loudly, never look like a vanished file. */
const RACE_CODES = new Set(["ENOENT", "ELOOP", "ENOTDIR"]);
const exhausted = (error: unknown) => ["EMFILE", "ENFILE"].includes(String((error as { code?: unknown } | null)?.code));
function resourceFailure(error: unknown): ReplayError | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || RACE_CODES.has(code)) return undefined;
  return new ReplayError("replay_resource_exhausted", `reading the spool failed with ${code}${code === "EMFILE" || code === "ENFILE" ? " (too many open files)" : ""}`,
    "raise the open-file limit (ulimit -n) or move part of the source into another private directory, then preview again");
}
async function inspect(home: string, dir: string, tier: ReplayPlanRecord["tier"], entry: string, stat: Stats, planDigest: string | undefined): Promise<Inspected> {
  const match = spool.namePattern.exec(entry)!, name = match[1]!;
  const claimSuffix = /\.draining-([a-f0-9]{24})$/.exec(entry)?.[1];
  const base: Omit<ReplayPlanRecord, "class" | "reasons" | "digest"> = { name, tier, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
    cwd: "", project: null, scope: null, event: null };
  const path = join(dir, entry);
  const finish = (cls: ReplayClass, reasons: ReplayClass[], digest: string, extra: Partial<ReplayPlanRecord> = {}, readable = true): Inspected =>
    ({ record: { ...base, ...extra, class: cls, reasons, digest }, ...(readable ? { path } : {}) });
  if (claimSuffix !== undefined && (planDigest === undefined || claimSuffix !== claimFor(planDigest, name))) return finish("claimed_elsewhere", ["claimed_elsewhere"], "", {}, false);
  const owned = spool.openOwned(path);
  let decoded: ReturnType<typeof spool.decoded>, bytes: Buffer;
  try {
    decoded = spool.decoded(owned);
    bytes = Buffer.alloc(Math.min(owned.initial.size, spool.RECORD_BYTES));
    readSync(owned.fd, bytes, 0, bytes.length, 0);
  } finally { closeSync(owned.fd); }
  const digest = hash(bytes), claimed = claimSuffix !== undefined ? { claimedBy: "this_plan" as const } : {};
  if (!decoded) return finish("undecodable", ["undecodable"], digest, claimed);
  const value = decoded.value, cwd = typeof value.cwd === "string" ? value.cwd : "";
  const event = typeof (value.capture as { event?: unknown } | undefined)?.event === "string" ? (value.capture as { event: string }).event : null;
  if (decoded.unknown) return finish("unknown_schema", ["unknown_schema"], digest, { ...claimed, cwd, event });
  if (value.nonce !== match[4] || value.cwd !== cwd || hash(cwd) !== match[2]) return finish("undecodable", ["undecodable"], digest, { ...claimed, cwd, event });
  if (!lstatSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return finish("cwd_missing", ["cwd_missing"], digest, { ...claimed, cwd, event });
  const physical = realPath(cwd);
  const scope = hookCaptureScope(physical, home) ?? null;
  const project = strictProject(physical);
  const canonical = project === undefined ? null : resolveAlias(home, project);
  const reasons: ReplayClass[] = [];
  // Decision A: the hook path's current scope, or the current-boot legacy device scope it also drains, proves the identity.
  // Any other scope (a previous boot's device, a changed HOME) is a scope mismatch: physical_identity_unverifiable alone.
  const legacy = hookLegacyCaptureScope(physical, home) ?? null;
  const unverifiable = scope === null || value.scope !== scope && value.scope !== legacy;
  // attribution_unproven only when no strict project resolves for the record's own cwd.
  if (canonical === null) reasons.push("attribution_unproven");
  else if (projectState(home, canonical) !== "active") reasons.push("project_inactive");
  if (!reasons.length) {
    const policy = createStandalonePolicy(configuredPolicyOptions(home, physical));
    if (!await policy.screen(value) || !await policy.screen(captureInput(value.capture as never, canonical!))) reasons.push("policy_refused");
  }
  if (unverifiable) reasons.unshift("physical_identity_unverifiable");
  const cls = reasons[0] ?? "replayable";
  const confirmable = unverifiable && reasons.length === 1 ? { confirmable: true as const } : {};
  return finish(cls, reasons.length ? reasons : ["replayable"], digest, { ...claimed, ...confirmable, cwd, event, scope, project: canonical });
}

function captureInput(c: { agent: string; event: string; at: string; paths: string[]; tool: string | null; status: string | null; excerpt: string; session?: string; subagent?: boolean }, project: string): CaptureInput {
  return { project, agent: c.agent, event: c.event, at: c.at, paths: c.paths, ...(c.tool === null ? {} : { tool: c.tool }), ...(c.status === null ? {} : { status: c.status }),
    excerpt: c.excerpt, ...(c.session === undefined ? {} : { session: c.session }), ...(c.subagent === undefined ? {} : { subagent: c.subagent }) };
}

/** Decision B: deterministic per plan and publication, so the same plan finds its own claims after a crash. */
export const claimFor = (planDigest: string, name: string) => hash(`${planDigest}\0${name}`).slice(0, 24);

function sources(home: string, source: string | undefined): { kind: "home" | "explicit"; dir: string; dev: number; ino: number }[] {
  if (source !== undefined) {
    const dir = directoryIdentity(source, "explicit");
    if (!dir) throw new ReplayError("replay_source_missing", `${source} does not exist`, "check the path of the parked directory");
    return [dir];
  }
  return [directoryIdentity(join(home, "hook-spool"), "home"), directoryIdentity(join(home, "hook-spool", ".capacity"), "home")]
    .filter((dir): dir is NonNullable<typeof dir> => dir !== undefined);
}

function bindings(home: string, records: ReplayPlanRecord[]): HookSpoolReplayPlan["revisions"] {
  const policy: Record<string, string> = { home: fileRevision(join(home, "amem.config.json")) };
  for (const cwd of [...new Set(records.map(record => record.cwd).filter(Boolean))].sort()) {
    try { policy[cwd] = hash(JSON.stringify(configuredPolicyOptions(home, realPath(cwd)))); } catch { policy[cwd] = hash("unavailable"); }
  }
  return { aliases: fileRevision(join(home, "aliases.jsonl")), lifecycle: hash(JSON.stringify([...new Set(records.map(r => r.project).filter(Boolean))].sort().map(p => [p, projectState(home, p!), aliasedKeys(home, p!)]))), policy };
}
const planDigest = (plan: Omit<HookSpoolReplayPlan, "digest">) => hash(JSON.stringify(plan));
function confirmationGroups(records: ReplayPlanRecord[]): HookSpoolReplayPlan["needsConfirmation"] {
  const groups = new Map<string, { cwd: string; project: string; count: number }>();
  for (const record of records) if (record.confirmable) {
    const key = JSON.stringify([record.cwd, record.project]), row = groups.get(key) ?? { cwd: record.cwd, project: record.project!, count: 0 };
    row.count++; groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) => a.cwd.localeCompare(b.cwd) || a.project.localeCompare(b.project));
}
/** A record this apply may replay: always a replayable one; a confirmable unverifiable one only with explicit confirmation. */
const applicable = (record: ReplayPlanRecord, confirmUnverifiable: boolean) => record.class === "replayable" || confirmUnverifiable && record.confirmable === true
  && record.class === "physical_identity_unverifiable" && record.reasons.length === 1 && record.project !== null;

async function survey(home: string, dirs: HookSpoolReplayPlan["source"], digest: string | undefined): Promise<Inspected[]> {
  const out: Inspected[] = [];
  for (const dir of dirs) {
    const tier = dir.kind === "explicit" ? "source" : dir.dir.endsWith("/.capacity") ? "capacity" : "active";
    for (const { entry, stat } of listPublications(dir.dir)) {
      try { out.push(await inspect(home, dir.dir, tier, entry, stat, digest)); }
      catch (error) {
        const failure = resourceFailure(error);
        if (failure) throw failure;
        /* vanished or replaced between list and open: it is simply not in this plan */
      }
    }
  }
  return out;
}

/** Read-only, body-free preview. Creates nothing and changes no mode. */
export async function planHookSpoolReplay(options: { base: string; source?: string }): Promise<HookSpoolReplayPlan> {
  if (options.source !== undefined) assertReplaySource(options.source);
  const home = canonicalPath(options.base);
  if (spool.belowFloor(home)) throw new ReplayError("replay_format_floor", "this home records a hook-spool format floor above this amem", "upgrade amem to the floor's version, then preview again");
  const dirs = sources(home, options.source);
  const inspected = await survey(home, dirs, undefined);
  const records = inspected.map(item => item.record), counts = zeroCounts();
  for (const record of records) counts[record.class]++;
  const body: Omit<HookSpoolReplayPlan, "digest"> = { schema: REPLAY_PLAN_SCHEMA, home, source: dirs, revisions: bindings(home, records), records, counts, needsConfirmation: confirmationGroups(records) };
  return { ...body, digest: planDigest(body) };
}

/** Validate the saved plan's own shape and digest before using any of it. */
export function parseReplayPlan(value: unknown): HookSpoolReplayPlan {
  const plan = value as HookSpoolReplayPlan;
  if (!plan || typeof plan !== "object" || plan.schema !== REPLAY_PLAN_SCHEMA || !Array.isArray(plan.records) || !Array.isArray(plan.needsConfirmation) || typeof plan.digest !== "string")
    throw new ReplayError("replay_plan_invalid", "the file is not an amem spool replay plan", "run `amem spool replay --json > plan.json` and pass that file");
  const { digest, ...body } = plan;
  if (planDigest(body) !== digest) throw new ReplayError("replay_plan_altered", "the plan file was edited after the preview", "preview again and apply the new, unedited plan");
  return plan;
}

/**
 * Apply a saved plan. The whole binding (home, source directories, revisions, and every record's identity, digest and class)
 * is revalidated first; any change refuses with no effect. Records are replayed oldest first through one CaptureStore at a
 * time; the durable append (or the capture spool's acknowledgement) completes before the exact owned claim retires.
 */
export async function applyHookSpoolReplay(options: { base: string; plan: HookSpoolReplayPlan; confirmUnverifiable?: boolean }): Promise<HookSpoolReplayReceipt> {
  const plan = parseReplayPlan(options.plan), home = canonicalPath(options.base), confirm = options.confirmUnverifiable === true;
  if (plan.home !== home) throw new ReplayError("replay_home_changed", "the plan was made for another memory home", "run the preview again from this home");
  if (spool.belowFloor(home)) throw new ReplayError("replay_format_floor", "this home records a hook-spool format floor above this amem", "upgrade amem to the floor's version, then preview again");
  const dirs = plan.source.map(dir => directoryIdentity(dir.dir, dir.kind));
  if (dirs.some((dir, index) => !dir || dir.dev !== plan.source[index]!.dev || dir.ino !== plan.source[index]!.ino))
    throw new ReplayError("replay_source_changed", "a source directory was replaced since the preview", "preview again and apply the new plan");
  const current = await survey(home, plan.source, plan.digest);
  {
    const byName = new Map(current.map(item => [item.record.name, item]));
    for (const planned of plan.records) {
      if (!applicable(planned, confirm)) continue;
      const now = byName.get(planned.name)?.record;
      // I2: a planned publication that is gone (no source name and no claim under this plan's suffix) has no effect here.
      // It was retired by an earlier run of this plan or taken by a live drainer that captured it; nothing is appended for it.
      if (!now) continue;
      if (now.dev !== planned.dev || now.ino !== planned.ino || now.size !== planned.size || now.digest !== planned.digest
        || now.class !== planned.class || JSON.stringify(now.reasons) !== JSON.stringify(planned.reasons) || now.confirmable !== planned.confirmable
        || now.project !== planned.project || now.scope !== planned.scope || now.cwd !== planned.cwd)
        throw new ReplayError("replay_plan_stale", `${planned.name} changed since the preview (identity, bytes, scope, project or policy)`, "preview again and apply the new plan");
    }
    // Recompute the same bindings over the plan's own cwds and projects: any policy, alias or lifecycle change refuses.
    if (JSON.stringify(bindings(home, plan.records)) !== JSON.stringify(plan.revisions))
      throw new ReplayError("replay_plan_stale", "a policy, alias or lifecycle input changed since the preview", "preview again and apply the new plan");

    const receipt: HookSpoolReplayReceipt = { plan: plan.digest, applied: 0, spooled: 0, retired: 0, retained: 0, absent: 0, outcomes: [] };
    const planned = plan.records.filter(record => applicable(record, confirm)).sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    let store: CaptureStore | undefined, storeProject: string | undefined, held: HookSpoolOwnedFile | undefined;
    try {
      for (const record of planned) {
        const item = byName.get(record.name);
        if (!item) { receipt.absent++; receipt.outcomes.push({ name: record.name, outcome: "absent", reason: "completed by an earlier run of this plan, or removed or drained by someone else; nothing was appended for it" }); continue; }
        const retain = (reason: string) => { receipt.retained++; receipt.outcomes.push({ name: record.name, outcome: "retained", reason }); };
        if (!item.path) { retain("unavailable"); continue; }
        // I3: one descriptor at a time. Re-open here and require the same inode, size, mtime and bytes the plan bound.
        let owned: HookSpoolOwnedFile;
        try { owned = spool.openOwned(item.path); }
        catch (error) { const failure = resourceFailure(error); if (failure) throw failure; retain("unavailable"); continue; }
        held = owned;
        if (owned.initial.dev !== record.dev || owned.initial.ino !== record.ino || owned.initial.size !== record.size || owned.initial.mtimeMs !== record.mtimeMs) { retain("identity_changed"); closeSync(owned.fd); held = undefined; continue; }
        // Decision B: claim under the plan's own deterministic suffix (an existing own claim is already that name).
        const claim = item.record.claimedBy === "this_plan" ? owned : spool.claimAs(owned, `${record.name}`, claimFor(plan.digest, record.name));
        if (!claim) { retain("claim_lost"); closeSync(owned.fd); held = undefined; continue; }
        held = claim;
        const decoded = spool.decoded(claim);
        if (!decoded || decoded.unknown || hash(decoded.bytes) !== record.digest) { retain("decode_changed"); closeSync(claim.fd); held = undefined; continue; }
        // One CaptureStore at a time: close the previous project's store before opening the next one.
        if (storeProject !== record.project) { store?.close(); store = new CaptureStore({ memoryDir: home, project: record.project!, cwd: realPath(record.cwd) }); storeProject = record.project!; }
        const result = store!.append(captureInput(decoded.value.capture as never, record.project!), { receipt: hash(decoded.bytes) });
        const spooled = "spooled" in result;
        if (spooled) receipt.spooled++; else receipt.applied++;
        const retired = spool.retireOwned(claim);
        closeSync(claim.fd); held = undefined;
        if (retired) { receipt.retired++; receipt.outcomes.push({ name: record.name, outcome: spooled ? "spooled" : "applied" }); }
        else receipt.outcomes.push({ name: record.name, outcome: "applied_cleanup_failed", reason: "the claim changed after the append; the row is recorded and the claim is kept" });
      }
    } finally { store?.close(); if (held) try { closeSync(held.fd); } catch { /* already closed */ } }
    for (const record of plan.records) if (!applicable(record, confirm)) receipt.outcomes.push({ name: record.name, outcome: "skipped",
      reason: record.confirmable ? "physical_identity_unverifiable: needs --confirm-unverifiable" : record.class });
    return receipt;
  }
}
