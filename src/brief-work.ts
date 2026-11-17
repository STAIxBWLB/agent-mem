import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StandalonePolicyOptions } from "./memory/policy.ts";
import { shardDir, shardMachineDir } from "./memory/shard.ts";
import type { WorkListFields, WorkListView } from "./memory/work-lists.ts";

/** Shared bound for the derived work snapshot; it holds every current list, closed ones included. */
export const WORK_BRIEF_BYTES = 16 * 1024;
const SCHEMA = "agent-mem.brief-work/v1", MAX_FIELDS = 64, MAX_ITEMS = 256;
/** Lists one snapshot keeps; past this the brief reports the work section partial. */
export const WORK_BRIEF_VIEWS = 32;

export interface WorkBriefBinding { base: string; project: string; machine: string }
/** One work-log segment's write frontier: a later append changes `bytes` (and `mtimeMs`), which makes a snapshot stale. */
export interface WorkSegment { key: string; file: string; bytes: number; mtimeMs: number }
export interface WorkBrief {
  schema: typeof SCHEMA; project: string;
  /** The segments the rows were read at; a changed frontier makes the file stale, never wrong. */
  segments: WorkSegment[];
  /** The home policy configuration the rows were screened with; a change invalidates the file. */
  policy: string;
  /** Composed views, sorted by list name, closed lists included so a later write can update one in place. */
  rows: { source: WorkListView }[];
  /** More lists existed than the snapshot keeps. */
  truncated: boolean;
}
export function workBriefFile(binding: WorkBriefBinding): string {
  return join(shardMachineDir(binding.base, binding.project, binding.machine), "brief-work.json");
}

/**
 * The standalone policy inputs that decide which work rows a brief may show. A host policy is left out on purpose: it is
 * applied to every row again at read, so it neither widens nor invalidates a machine-local snapshot.
 */
export function workPolicyRevision(options: StandalonePolicyOptions): string {
  return createHash("sha256").update(JSON.stringify({ schema: "agent-mem.standalone-policy/v1",
    denyPaths: [...(options.denyPaths ?? [])].sort(), piiPatterns: [...(options.piiPatterns ?? [])].sort() })).digest("hex");
}

/**
 * The work log's frontier for a project and its aliases, in stable order. An unsafe segment path answers undefined,
 * which no published snapshot matches.
 */
export function workLogSegments(base: string, project: string, aliases: readonly string[]): WorkSegment[] | undefined {
  const segments: WorkSegment[] = [];
  for (const key of [project, ...aliases]) {
    const directory = join(shardDir(base, key), "work", "log");
    let files: string[];
    try { files = readdirSync(directory).sort(); } catch { continue; }
    for (const file of files) {
      if (!/^[a-f0-9]{16}\.jsonl$/.test(file)) continue;
      const stat = lstatSync(join(directory, file), { throwIfNoEntry: false });
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) return;
      segments.push({ key, file, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return segments;
}

const text = (value: unknown, maximum: number): boolean => typeof value === "string" && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
function validFields(input: unknown): input is WorkListFields {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const entries = Object.entries(input);
  if (entries.length > MAX_FIELDS) return false;
  return entries.every(([key, value]) => text(key, 100) && (value === null || typeof value === "boolean"
    || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 8000 && !value.includes("\0")));
}
/** Cache files are untrusted derived data: require the only view shape `read()` composes before any display. */
export function validCachedWork(source: unknown): source is WorkListView {
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const view = source as WorkListView;
  return text(view.list, 300) && validFields(view.fields) && typeof view.closed === "boolean"
    && Array.isArray(view.items) && view.items.length <= MAX_ITEMS
    && view.items.every(item => !!item && typeof item === "object" && text(item.task, 300) && validFields(item.fields));
}
const validSegments = (input: unknown): input is WorkSegment[] => Array.isArray(input) && input.length <= 64
  && input.every(segment => !!segment && typeof segment === "object" && text(segment.key, 1000) && text(segment.file, 64)
    && Number.isSafeInteger(segment.bytes) && segment.bytes >= 0 && Number.isFinite(segment.mtimeMs));

export function readWorkBrief(binding: WorkBriefBinding): WorkBrief | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(workBriefFile(binding), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size < 1 || stat.size > WORK_BRIEF_BYTES || (stat.mode & 0o077) !== 0) return;
    const bytes = Buffer.alloc(WORK_BRIEF_BYTES + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0); // one bounded read, including an oversize sentinel
    const after = fstatSync(fd);
    if (size !== stat.size || size > WORK_BRIEF_BYTES || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) return;
    const brief = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))) as WorkBrief;
    if (brief.schema !== SCHEMA || brief.project !== binding.project || !validSegments(brief.segments)
      || typeof brief.policy !== "string" || !brief.policy || typeof brief.truncated !== "boolean"
      || !Array.isArray(brief.rows) || brief.rows.length > WORK_BRIEF_VIEWS
      || brief.rows.some(row => !row || !validCachedWork(row.source))) return;
    return brief;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Atomic private replacement; the caller publishes under the work store's own writer lock. */
export function writeWorkBrief(binding: WorkBriefBinding, brief: WorkBrief): boolean {
  const body = JSON.stringify(brief) + "\n";
  if (Buffer.byteLength(body) > WORK_BRIEF_BYTES) return false;
  const file = workBriefFile(binding), temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    return true;
  } finally { rmSync(temporary, { force: true }); }
}
