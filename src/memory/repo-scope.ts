/**
 * #15 T4 / D6: the `repo` scope. Team-shareable knowledge lives in the repository itself, `.amem/log.jsonl`, and travels
 * with git. amem never runs `git add`, `commit` or `push`: the person commits the file through normal review.
 *
 * Trust: the file is ordinary repository content, so a pull request can put any line in it. Every line is strictly
 * validated, its id is recomputed, and every row passes the standalone policy before it reaches a recall, a brief or a
 * search. Writing is a person's act (the CLI refuses agents and non-terminals before it gets here) and goes through
 * the full screen plus a visibility check of every remote.
 *
 * Own schema: `amem.repo/v1`. The `agent-hub.memory/v1` hash domain, scopes and kinds stay frozen; a repo line carries
 * no machine, peer, task or project field, so nothing about this machine or its private projects is committed.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realPath, memoryGitEnv, memoryGitSync } from "./platform.ts";
import { createStandalonePolicy, type MemoryPolicy, type StandalonePolicyOptions } from "./policy.ts";
import { memoryProjectKey } from "./project.ts";
import { resolveAlias } from "./shard.ts";
import { remoteVisibility, type Visibility } from "./sync.ts";
import type { View } from "./store.ts";

export const REPO_SCHEMA = "amem.repo/v1";
export const REPO_DIR = ".amem";
export const REPO_LOG = "log.jsonl";
/** The kinds the spec names for the repo scope: contracts, decisions and `fail` lessons. A finding stays private. */
export const REPO_KINDS = ["decision", "contract", "fail"] as const;
export type RepoKind = (typeof REPO_KINDS)[number];
export const REPO_ATTRIBUTES_LINE = `${REPO_DIR}/${REPO_LOG} merge=union`;

const MAX_LINE_BYTES = 16 * 1024, MAX_FILE_BYTES = 1024 * 1024, MAX_TEXT = 4000, MAX_TITLE = 200, MAX_ABOUT = 64, MAX_NODE = 300;
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface RepoView {
  id: string; at: string; kind: RepoKind; title: string | null; text: string; about: string[];
  scope: "repo"; source: "repo";
}
/** No `promotedFrom`: the private entry's id (a hash of its machine and project too) never enters a file that may be public. The line's own id makes a repeat promotion a no-op. */
export interface RepoLine {
  schema: typeof REPO_SCHEMA; op: "note"; id: string; at: string; kind: RepoKind; title?: string; text: string; about: string[]; actor: "person";
}
export interface RepoSkipped { malformed: number; mismatched: number; duplicate: number; withheld: number }
export interface RepoRead {
  /** `absent`: no repository or no file. `unsafe`: the file or its directory is not a plain one (a symlink, a device, a directory). */
  state: "absent" | "ok" | "unsafe";
  root?: string; views: RepoView[]; skipped: RepoSkipped; partial: boolean; reason?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** The same derivation shape as `entryId` (first 32 hex of sha256 over canonical JSON), over this scope's own schema. */
export const repoEntryId = (line: Omit<RepoLine, "id">): string => createHash("sha256").update(canonical(line)).digest("hex").slice(0, 32);

/** The working-tree root of the repository that holds `cwd`, from git itself and never from a name or an entry. Bare or not a repository: undefined. */
export function repoRoot(cwd: string): string | undefined {
  try {
    const result = memoryGitSync(["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: memoryGitEnv(process.env, { repositoryIsolation: true }) });
    const top = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (!top || /[\r\n\0]/.test(top)) return undefined;
    return realPath(top);
  } catch { return undefined; }
}

/**
 * The repository root whose `.amem/` this project may recall: only when the repository's own project key resolves to the
 * bound project (AC3). A server bound to project B started inside repository A reads nothing of A's.
 */
export function boundRepoRoot(cwd: string, base: string, project: string): string | undefined {
  const root = repoRoot(cwd);
  if (!root) return undefined;
  try { return resolveAlias(base, memoryProjectKey(root, { repositoryIsolation: true })) === project ? root : undefined; } catch { return undefined; }
}

export const repoLogPath = (root: string): string => join(root, REPO_DIR, REPO_LOG);

type Plain = { kind: "absent" } | { kind: "unsafe"; why: string } | { kind: "file"; size: number };
/** lstat, never stat: a symlinked `.amem` or `log.jsonl` is refused, not followed out of the repository. */
function plainLog(root: string): Plain {
  try {
    const dir = lstatSync(join(root, REPO_DIR), { throwIfNoEntry: false });
    if (!dir) return { kind: "absent" };
    if (!dir.isDirectory()) return { kind: "unsafe", why: `${REPO_DIR} is not a plain directory` };
    if (realPath(join(root, REPO_DIR)) !== join(root, REPO_DIR)) return { kind: "unsafe", why: `${REPO_DIR} resolves outside the repository root` };
    const file = lstatSync(repoLogPath(root), { throwIfNoEntry: false });
    if (!file) return { kind: "absent" };
    if (!file.isFile()) return { kind: "unsafe", why: `${REPO_DIR}/${REPO_LOG} is not a regular file` };
    return { kind: "file", size: file.size };
  } catch { return { kind: "unsafe", why: `${REPO_DIR} could not be inspected` }; }
}

/** Strict shape and identity check of one line; undefined for anything that is not exactly a repo entry with the id its content hashes to. */
export function parseRepoLine(raw: string): { view: RepoView } | { error: "malformed" | "mismatched" } {
  if (Buffer.byteLength(raw) > MAX_LINE_BYTES) return { error: "malformed" };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { error: "malformed" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "malformed" };
  const e = value as Record<string, unknown>;
  const allowed = new Set(["schema", "op", "id", "at", "kind", "title", "text", "about", "actor"]);
  if (Object.keys(e).some(key => !allowed.has(key))) return { error: "malformed" };
  const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= max;
  if (e.schema !== REPO_SCHEMA || e.op !== "note" || e.actor !== "person") return { error: "malformed" };
  if (typeof e.id !== "string" || !/^[a-f0-9]{32}$/.test(e.id)) return { error: "malformed" };
  if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at)) || new Date(e.at).toISOString() !== e.at) return { error: "malformed" };
  if (typeof e.kind !== "string" || !REPO_KINDS.includes(e.kind as RepoKind)) return { error: "malformed" };
  if (e.title !== undefined && !str(e.title, MAX_TITLE)) return { error: "malformed" };
  if (!str(e.text, MAX_TEXT)) return { error: "malformed" };
  if (!Array.isArray(e.about) || e.about.length > MAX_ABOUT || !e.about.every(n => str(n, MAX_NODE))) return { error: "malformed" };
  const { id, ...rest } = e as unknown as RepoLine;
  if (repoEntryId(rest) !== id) return { error: "mismatched" };
  return { view: { id, at: e.at, kind: e.kind as RepoKind, title: (e.title as string | undefined) ?? null, text: e.text, about: [...(e.about as string[])], scope: "repo", source: "repo" } };
}

function readLog(root: string): { lines: string[]; partial: boolean } | { unsafe: string } {
  const plain = plainLog(root);
  if (plain.kind === "absent") return { lines: [], partial: false };
  if (plain.kind === "unsafe") return { unsafe: plain.why };
  let fd: number | undefined;
  try {
    fd = openSync(repoLogPath(root), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { unsafe: `${REPO_DIR}/${REPO_LOG} is not a regular file` };
    const length = Math.min(stat.size, MAX_FILE_BYTES), buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) { const n = readSync(fd, buffer, filled, length - filled, filled); if (n === 0) break; filled += n; }
    let text = buffer.subarray(0, filled).toString("utf8");
    const truncated = stat.size > MAX_FILE_BYTES;
    // A cut file ends mid-line: keep whole lines only, and say the read was partial.
    if (truncated) text = text.slice(0, text.lastIndexOf("\n") + 1);
    return { lines: text.split("\n").filter(line => line.trim() !== ""), partial: truncated };
  } catch { return { unsafe: `${REPO_DIR}/${REPO_LOG} could not be read` }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Every valid, screened row of the repository's `.amem/log.jsonl`, newest first. Duplicates by id collapse (`merge=union`
 * can repeat a line). The policy sees each complete row, as it does a curated one: what it declines is counted, not shown.
 */
export async function readRepoScope(root: string | undefined, policy: MemoryPolicy): Promise<RepoRead> {
  const skipped: RepoSkipped = { malformed: 0, mismatched: 0, duplicate: 0, withheld: 0 };
  if (!root) return { state: "absent", views: [], skipped, partial: false };
  const read = readLog(root);
  if ("unsafe" in read) return { state: "unsafe", root, views: [], skipped, partial: true, reason: read.unsafe };
  const views: RepoView[] = [], seen = new Set<string>();
  for (const raw of read.lines) {
    const parsed = parseRepoLine(raw);
    if ("error" in parsed) { skipped[parsed.error]++; continue; }
    if (seen.has(parsed.view.id)) { skipped.duplicate++; continue; }
    seen.add(parsed.view.id);
    if (namesPrivatePath(`${parsed.view.title ?? ""}\n${parsed.view.text}\n${parsed.view.about.join("\n")}`) || !await policy.screen(parsed.view)) { skipped.withheld++; continue; }
    views.push(parsed.view);
  }
  views.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1));
  return { state: read.lines.length || plainLog(root).kind === "file" ? "ok" : "absent", root, views, skipped, partial: read.partial || skipped.malformed + skipped.mismatched > 0 };
}

/** Whether a repo log exists at all, by lstat only: the brief reserves header room for a section only when there is one. */
export function repoLogPresent(root: string | undefined): boolean { return !!root && plainLog(root).kind !== "absent"; }

/** `local.deny` and `pii.paths` of the repository's own agent-hub config, read as data (no agent-hub import). Anything that exists but is unreadable or malformed refuses. */
export function repoPolicyOptions(root: string): { denyPaths: string[] } {
  const denyPaths: string[] = [];
  for (const name of ["config.json", "config.local.json"]) {
    const file = join(root, ".agenthub", name);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error(`.agenthub/${name} is not a plain file within ${MAX_CONFIG_BYTES} bytes; fix it before promoting to repo scope`);
    let config: unknown;
    try { config = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`.agenthub/${name} does not parse; fix it before promoting to repo scope`); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`.agenthub/${name} is not a JSON object; fix it before promoting to repo scope`);
    const strings = (value: unknown, label: string): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error(`.agenthub/${name}: ${label} is not a list of strings; fix it before promoting to repo scope`);
      return value as string[];
    };
    const body = config as { local?: { deny?: unknown }; pii?: { paths?: unknown } };
    if (body.local !== undefined && (typeof body.local !== "object" || body.local === null || Array.isArray(body.local))) throw new Error(`.agenthub/${name}: local is not an object; fix it before promoting to repo scope`);
    if (body.pii !== undefined && (typeof body.pii !== "object" || body.pii === null || Array.isArray(body.pii))) throw new Error(`.agenthub/${name}: pii is not an object; fix it before promoting to repo scope`);
    denyPaths.push(...strings(body.local?.deny, "local.deny"), ...strings(body.pii?.paths, "pii.paths"));
  }
  return { denyPaths: [...new Set(denyPaths)] };
}

/** The policy a repo-bound reader applies: the caller's standalone screen (host policy and patterns included) narrowed by this repository's own deny list. Unreadable config withholds repo rows (reason), never shows them. */
export function repoReadPolicy(root: string, base: StandalonePolicyOptions = {}): { policy: MemoryPolicy } | { reason: string } {
  try {
    const repo = repoPolicyOptions(root);
    return { policy: createStandalonePolicy({ ...base, denyPaths: [...new Set([...(base.denyPaths ?? []), ...repo.denyPaths])] }) };
  } catch (error) { return { reason: (error as Error).message }; }
}

const HOME_PATH = [/\/Users\/[^/\s"'`]+\//, /\/home\/[^/\s"'`]+\//, /[A-Za-z]:\\Users\\[^\\\s"'`]+\\/, /~\/\.(?:ssh|aws|gnupg|config|agenthub|maru|claude|codex)\b/];
/** A home directory or a credential location, in any text. Refused when promoting and withheld when reading: a pull request can add such a line to the file too. */
export function namesPrivatePath(text: string): boolean {
  return HOME_PATH.some(re => re.test(text)) || (homedir().length > 3 && text.includes(homedir()));
}
const SAFE_NODE = /^(?:path|symbol|issue):/;
/** A graph node that may be committed: a repository-relative path or symbol, or an issue. Private task, goal and memory references and absolute or escaping paths stay out. */
function committableNode(node: string): boolean {
  if (!SAFE_NODE.test(node)) return false;
  const where = node.startsWith("path:") ? node.slice(5) : node.startsWith("symbol:") && node.includes("@") ? node.slice(node.lastIndexOf("@") + 1) : "";
  if (!where) return !node.startsWith("path:") && !node.startsWith("symbol:");
  return !/^(?:\/|~|[A-Za-z]:[\\/])/.test(where) && !where.split(/[\\/]/).includes("..");
}

export interface PromotionPlan {
  line: RepoLine; text: string; path: string; droppedNodes: string[]; alreadyPresent: boolean; refusals: string[];
}
/**
 * What `amem promote <id> --to repo` would commit, and why it may not. Pure of effects: nothing is written, no remote is asked.
 * `refusals` is empty only for a long-term decision, contract or fail note that passes the full screen.
 */
export async function planRepoPromotion(root: string, note: View): Promise<PromotionPlan> {
  const refusals: string[] = [];
  const about = note.about.filter(committableNode), droppedNodes = note.about.filter(node => !committableNode(node));
  const body: Omit<RepoLine, "id"> = { schema: REPO_SCHEMA, op: "note", at: note.at, kind: note.kind as RepoKind, ...(note.title ? { title: note.title } : {}), text: note.text, about: about.slice(0, MAX_ABOUT), actor: "person" };
  const line: RepoLine = { ...body, id: repoEntryId(body) };
  if (note.tier !== "long" || note.local) refusals.push("only a long-term note enters repo scope: promote it to long-term first");
  if (note.supersededBy) refusals.push(`replaced by ${note.supersededBy.slice(0, 8)}: promote that one instead`);
  if (!REPO_KINDS.includes(note.kind as RepoKind)) refusals.push(`a ${note.kind} stays private: repo scope holds ${REPO_KINDS.join(", ")}`);
  if (Buffer.byteLength(note.text) > MAX_TEXT || (note.title?.length ?? 0) > MAX_TITLE) refusals.push("the note is longer than a repo entry may be");
  const flat = `${note.title ?? ""}\n${note.text}\n${about.join("\n")}`;
  if (namesPrivatePath(flat)) refusals.push("it names a private path (a home directory or a credential location)");
  let policy: MemoryPolicy | undefined;
  try { policy = createStandalonePolicy(repoPolicyOptions(root)); } catch (error) { refusals.push((error as Error).message); }
  // The policy's shape check refuses `undefined` values, so the screened value is exactly the committed line's own fields.
  const { id: _lineId, ...committed } = line;
  if (policy && !await policy.screen(committed)) refusals.push("the screen declined it: a secret, personal data, a private path or a local.deny entry");
  const read = readLog(root);
  if ("unsafe" in read) refusals.push(read.unsafe);
  const alreadyPresent = !("unsafe" in read) && read.lines.some(raw => { const parsed = parseRepoLine(raw); return "view" in parsed && parsed.view.id === line.id; });
  return { line, text: JSON.stringify(line), path: repoLogPath(root), droppedNodes, alreadyPresent, refusals };
}

export interface RepoVisibility { state: Visibility; remotes: { name: string; url: string; visibility: Visibility }[] }
const redact = (url: string) => url.replace(/\/\/[^/@\s]*@/, "//");
/** Every remote URL and push URL of the repository, each asked through the same visibility check sync uses. Only all-private is private; no remote or an unreadable config is unknown. */
export async function repoVisibility(root: string, visibility: (url: string) => Promise<Visibility> = remoteVisibility): Promise<RepoVisibility> {
  const result = memoryGitSync(["-C", root, "config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"], { encoding: "utf8", env: memoryGitEnv(process.env, { repositoryIsolation: true }) });
  if (result.status !== 0 && result.status !== 1) return { state: "unknown", remotes: [] };
  const remotes: RepoVisibility["remotes"] = [];
  for (const row of (result.stdout ?? "").split("\n").filter(Boolean)) {
    const split = row.indexOf(" "), key = row.slice(0, split), url = row.slice(split + 1).trim();
    if (!url) continue;
    let state: Visibility = "unknown";
    try { state = await visibility(url); } catch { /* unknown */ }
    remotes.push({ name: key.replace(/^remote\./, "").replace(/\.(url|pushurl)$/, ""), url: redact(url), visibility: state });
  }
  const state: Visibility = remotes.length === 0 ? "unknown" : remotes.some(r => r.visibility === "public") ? "public" : remotes.every(r => r.visibility === "private") ? "private" : "unknown";
  return { state, remotes };
}

/** Append one line to `.amem/log.jsonl`: O_NOFOLLOW, a regular file, the directory inside the repository, a newline first when the file lacks one. Never runs git. */
export function appendRepoLine(root: string, line: RepoLine): { path: string; created: boolean } {
  const dir = join(root, REPO_DIR), path = repoLogPath(root);
  if (!lstatSync(dir, { throwIfNoEntry: false })) mkdirSync(dir, { mode: 0o755 });
  const plain = plainLog(root);
  if (plain.kind === "unsafe") throw new Error(plain.why);
  if (plain.kind === "file" && plain.size + Buffer.byteLength(JSON.stringify(line)) > MAX_FILE_BYTES) throw new Error(`${REPO_DIR}/${REPO_LOG} would exceed ${MAX_FILE_BYTES} bytes: split or prune it through review first`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${REPO_DIR}/${REPO_LOG} is not a regular file`);
    if (realPath(dir) !== dir) throw new Error(`${REPO_DIR} resolves outside the repository root`);
    let prefix = "";
    if (info.size > 0) { const check = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const last = Buffer.alloc(1); readSync(check, last, 0, 1, info.size - 1); if (last[0] !== 0x0a) prefix = "\n"; } finally { closeSync(check); } }
    writeSync(fd, `${prefix}${JSON.stringify(line)}\n`);
    return { path, created: info.size === 0 };
  } finally { closeSync(fd); }
}

/** `.gitattributes` at the repository root gains `.amem/log.jsonl merge=union`, only when the person asks. */
export function planGitattributes(root: string): { path: string; present: boolean; unsafe?: string } {
  const path = join(root, ".gitattributes");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { path, present: false };
  if (!stat.isFile()) return { path, present: false, unsafe: ".gitattributes is not a regular file" };
  if (stat.size > MAX_CONFIG_BYTES) return { path, present: false, unsafe: ".gitattributes is larger than expected" };
  const present = readFileSync(path, "utf8").split(/\r?\n/).some(row => row.trim().split(/\s+/).join(" ") === REPO_ATTRIBUTES_LINE);
  return { path, present };
}
export function appendGitattributes(root: string): { path: string; added: boolean } {
  const plan = planGitattributes(root);
  if (plan.unsafe) throw new Error(plan.unsafe);
  if (plan.present) return { path: plan.path, added: false };
  const fd = openSync(plan.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(".gitattributes is not a regular file");
    let prefix = "";
    if (info.size > 0) { const check = openSync(plan.path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const last = Buffer.alloc(1); readSync(check, last, 0, 1, info.size - 1); if (last[0] !== 0x0a) prefix = "\n"; } finally { closeSync(check); } }
    writeSync(fd, `${prefix}${REPO_ATTRIBUTES_LINE}\n`);
  } finally { closeSync(fd); }
  return { path: plan.path, added: true };
}
