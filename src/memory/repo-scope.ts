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
import { dirname, join } from "node:path";
import { realPath, memoryGitEnv, memoryGitSync } from "./platform.ts";
import { createStandalonePolicy, type MemoryPolicy, type StandalonePolicyOptions } from "./policy.ts";
import { memoryProjectKey } from "./project.ts";
import { mentionsPrivatePath, policyEntries } from "./path-glob.ts";
import { resolveAlias } from "./shard.ts";
import type { Visibility } from "./sync.ts";
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
/** C0 (except tab and newline), DEL and C1 controls. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

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
  // C0 and C1 controls other than tab and newline never belong in a shared line: a pull request could carry a terminal escape (ESC, CSI U+009B) that the CLI would print.
  const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= max && !CONTROL.test(v);
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
    // The TAIL window: the log is append-only and read newest first, so a file over the cap keeps its last MAX_FILE_BYTES (the newest lines), never its head.
    const truncated = stat.size > MAX_FILE_BYTES, length = Math.min(stat.size, MAX_FILE_BYTES), start = stat.size - length, buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) { const n = readSync(fd, buffer, filled, length - filled, start + filled); if (n === 0) break; filled += n; }
    let text = buffer.subarray(0, filled).toString("utf8");
    // The window starts mid-line: drop that first piece, whole lines only, and say the read was partial.
    if (truncated) text = text.slice(text.indexOf("\n") + 1);
    return { lines: text.split("\n").filter(line => line.trim() !== ""), partial: truncated };
  } catch { return { unsafe: `${REPO_DIR}/${REPO_LOG} could not be read` }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export interface RepoReadOptions {
  /** Stop once this many screened rows are collected: the brief shows a handful, so it never parses the whole file. */
  limit?: number;
  /** Milliseconds left before the caller's hard deadline (the hook): checked before every line, because the screen's awaits are microtasks and no timer can fire in between. */
  remainingMs?: () => number;
  /** Time held back from `remainingMs` for the caller's own work after the read. */
  reserveMs?: number;
}
/**
 * The valid, screened rows of the repository's `.amem/log.jsonl`, NEWEST FIRST BY FILE POSITION (append order: a line's own `at` is the author's claim and never orders
 * anything, so a line dated in the future cannot pin a brief; its displayed `at` is clamped to now). Duplicates by id collapse to the newest copy (`merge=union` can repeat
 * a line). The policy sees each complete row, as it does a curated one: what it declines is counted, not shown. With a `limit` or a deadline the read stops early and reports `partial`.
 */
export async function readRepoScope(root: string | undefined, policy: MemoryPolicy, options: RepoReadOptions = {}): Promise<RepoRead> {
  const skipped: RepoSkipped = { malformed: 0, mismatched: 0, duplicate: 0, withheld: 0 };
  if (!root) return { state: "absent", views: [], skipped, partial: false };
  const read = readLog(root);
  if ("unsafe" in read) return { state: "unsafe", root, views: [], skipped, partial: true, reason: read.unsafe };
  const views: RepoView[] = [], seen = new Set<string>(), now = Date.now();
  let stoppedEarly = false;
  for (let index = read.lines.length - 1; index >= 0; index--) {
    if (options.limit !== undefined && views.length >= options.limit) { stoppedEarly = true; break; }
    if (options.remainingMs && options.remainingMs() - (options.reserveMs ?? 0) <= 0) { stoppedEarly = true; break; }
    const parsed = parseRepoLine(read.lines[index]!);
    if ("error" in parsed) { skipped[parsed.error]++; continue; }
    if (seen.has(parsed.view.id)) { skipped.duplicate++; continue; }
    seen.add(parsed.view.id);
    if (namesPrivatePath(`${parsed.view.title ?? ""}\n${parsed.view.text}\n${parsed.view.about.join("\n")}`) || !await policy.screen(parsed.view)) { skipped.withheld++; continue; }
    views.push(Date.parse(parsed.view.at) > now ? { ...parsed.view, at: new Date(now).toISOString() } : parsed.view);
  }
  return { state: read.lines.length || plainLog(root).kind === "file" ? "ok" : "absent", root, views, skipped, partial: read.partial || stoppedEarly || skipped.malformed + skipped.mismatched > 0 };
}

/**
 * The repository root that holds `cwd` AND a `.amem/log.jsonl`, found by `lstat` alone: the nearest ancestor with a `.git` (directory or file, so worktrees and submodules count) must
 * be the directory that holds the log. For a caller whose project key was itself resolved from this `cwd` (the SessionStart hook) the "this repository is the bound project" check of
 * `boundRepoRoot` holds by construction, so no git process is spawned on the hook's deadline (two synchronous git processes would otherwise run inside the hook's 140 ms).
 * ponytail: lexical, trusts the `.git` entry on disk; a caller with a project it did not derive from `cwd` must use `boundRepoRoot`.
 */
export function nearestRepoRootWithLog(cwd: string): string | undefined {
  try {
    for (let dir = cwd, depth = 0; depth < 32; dir = dirname(dir), depth++) {
      if (lstatSync(join(dir, ".git"), { throwIfNoEntry: false })) return lstatSync(join(dir, REPO_DIR, REPO_LOG), { throwIfNoEntry: false }) ? realPath(dir) : undefined;
      if (dir === dirname(dir)) return undefined;
    }
  } catch { /* unreadable: no section */ }
  return undefined;
}

/** Whether a repo log exists at all, by lstat only: the brief reserves header room for a section only when there is one. */
export function repoLogPresent(root: string | undefined): boolean { return !!root && plainLog(root).kind !== "absent"; }

/**
 * Whether `.amem/log.jsonl` exists at or above `cwd`, by `lstat` alone (no git, no read). Every brief asks this first, so a repository without a repo scope (almost all
 * of them) costs the hook a few syscalls and never a git process. A symlinked `.amem` directory still counts (its log resolves), so the reader can report it unsafe.
 */
export function repoLogNearby(cwd: string): boolean {
  try {
    for (let dir = cwd, depth = 0; depth < 32; dir = dirname(dir), depth++) {
      if (lstatSync(join(dir, REPO_DIR, REPO_LOG), { throwIfNoEntry: false })) return true;
      if (dir === dirname(dir)) return false;
    }
  } catch { /* unreadable: no section */ }
  return false;
}

/** `git check-ignore`: true when git would ignore the log, so the person is told before they wait for a file that never shows in `git status`. A tracked file is never reported (git shows its changes whatever a pattern says). */
export function repoLogIgnored(root: string): boolean {
  try {
    const result = memoryGitSync(["-C", root, "check-ignore", "-q", `${REPO_DIR}/${REPO_LOG}`], { encoding: "utf8", env: memoryGitEnv(process.env, { repositoryIsolation: true }) });
    return result.status === 0;
  } catch { return false; }
}

/**
 * `local.deny` and `pii.paths` of the repository's own agent-hub config, read as data (no agent-hub import). Anything that exists but is unreadable or
 * malformed refuses. `local.deny` entries are substrings (the hub's `isDenied` extra list); `pii.paths` entries are the hub's bounded globs and
 * subtrees (`policyEntries`, a port of `policyPaths`), matched by `src/memory/path-glob.ts`, never as substrings.
 */
export function repoPolicyOptions(root: string): { denyPaths: string[]; piiPaths: string[] } {
  const denyPaths: string[] = [], piiPaths: string[] = [];
  for (const name of ["config.json", "config.local.json"]) {
    const file = join(root, ".agenthub", name);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    const fix = "; fix it before using the repo scope";
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error(`.agenthub/${name} is not a plain file within ${MAX_CONFIG_BYTES} bytes${fix}`);
    let config: unknown;
    try { config = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`.agenthub/${name} does not parse${fix}`); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`.agenthub/${name} is not a JSON object${fix}`);
    const body = config as { local?: { deny?: unknown }; pii?: { paths?: unknown } };
    if (body.local !== undefined && (typeof body.local !== "object" || body.local === null || Array.isArray(body.local))) throw new Error(`.agenthub/${name}: local is not an object${fix}`);
    if (body.pii !== undefined && (typeof body.pii !== "object" || body.pii === null || Array.isArray(body.pii))) throw new Error(`.agenthub/${name}: pii is not an object${fix}`);
    const deny = body.local?.deny;
    if (deny !== undefined) {
      // The standalone policy takes at most 64 literals of 256 bytes: say so here, so a long list refuses by name instead of as a generic "invalid deny paths".
      if (!Array.isArray(deny) || !deny.every(item => typeof item === "string" && item.trim() !== "" && Buffer.byteLength(item) <= 256 && !/[\x00-\x1f\x7f]/.test(item))) throw new Error(`.agenthub/${name}: local.deny is not a list of non-empty strings of at most 256 bytes${fix}`);
      denyPaths.push(...deny as string[]);
    }
    try { piiPaths.push(...policyEntries(body.pii?.paths, `.agenthub/${name}: pii.paths`)); } catch (error) { throw new Error(`${(error as Error).message}${fix}`); }
  }
  const unique = (list: string[]) => [...new Set(list)];
  if (unique(denyPaths).length > 64) throw new Error(`.agenthub config: local.deny names more than 64 entries across config.json and config.local.json, more than amem's screen holds; trim it${" before using the repo scope"}`);
  return { denyPaths: unique(denyPaths), piiPaths: unique(piiPaths) };
}

/** Every string in a screened value, and its `about` links: what `mentionsPrivatePath` reads. Bounded like the policy's own snapshot. */
function textOf(value: unknown): { text: string; about: string[] } {
  const strings: string[] = []; let budget = 4096;
  const visit = (input: unknown, depth: number) => {
    if (budget-- <= 0 || depth > 16) return;
    if (typeof input === "string") strings.push(input);
    else if (Array.isArray(input)) for (const item of input) visit(item, depth + 1);
    else if (input && typeof input === "object") for (const [key, item] of Object.entries(input)) { strings.push(key); visit(item, depth + 1); }
  };
  visit(value, 0);
  const about = value && typeof value === "object" && Array.isArray((value as { about?: unknown }).about) ? (value as { about: unknown[] }).about.filter((x): x is string => typeof x === "string") : [];
  return { text: strings.join("\n"), about };
}

/** The standalone screen, plus the repository's own `pii.paths` matched with the hub's glob semantics. Either declining declines. */
export function repoPolicy(options: { denyPaths: string[]; piiPaths: string[] }, base: StandalonePolicyOptions = {}): MemoryPolicy {
  const standalone = createStandalonePolicy({ ...base, denyPaths: [...new Set([...(base.denyPaths ?? []), ...options.denyPaths])] });
  return { async screen(value: unknown): Promise<boolean> {
    if (!await standalone.screen(value)) return false;
    if (!options.piiPaths.length) return true;
    const { text, about } = textOf(value);
    return !mentionsPrivatePath(text, about, options.piiPaths);
  } };
}

/** The policy a repo-bound reader applies: the caller's standalone screen (host policy and patterns included) narrowed by this repository's own deny list and `pii.paths`. Unreadable config withholds repo rows (reason), never shows them. */
export function repoReadPolicy(root: string, base: StandalonePolicyOptions = {}): { policy: MemoryPolicy } | { reason: string } {
  try { return { policy: repoPolicy(repoPolicyOptions(root), base) }; } catch (error) { return { reason: (error as Error).message }; }
}

/** The text as a case-insensitive disk and a terminal see it: compatibility forms folded, ignorable code points dropped, backslashes as slashes, lower case. */
const foldText = (text: string): string => text.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").replace(/\\/g, "/").toLowerCase();
const HOME_PATH = [/\/users\/[^/\s"'`]+\//, /\/home\/[^/\s"'`]+\//, /\b[a-z]:\/users\/[^/\s"'`]+\//, /~\/\.(?:ssh|aws|gnupg|config|agenthub|maru|claude|codex|kube|docker|netrc)\b/, /\$\{?home\}?\//, /%(?:userprofile|homepath|appdata|localappdata)%/];
/** A home directory or a credential location, in any text (folded first: `\Users\x\`, a width-folded or zero-width-split spelling, `$HOME/`, `%USERPROFILE%`). Refused when promoting and withheld when reading: a pull request can add such a line too. */
export function namesPrivatePath(text: string): boolean {
  const folded = foldText(text), home = foldText(homedir());
  return HOME_PATH.some(re => re.test(folded)) || (home.length > 3 && folded.includes(home));
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
export async function planRepoPromotion(root: string, note: View, base: StandalonePolicyOptions = {}): Promise<PromotionPlan> {
  const refusals: string[] = [];
  const about = note.about.filter(committableNode), droppedNodes = note.about.filter(node => !committableNode(node));
  const body: Omit<RepoLine, "id"> = { schema: REPO_SCHEMA, op: "note", at: note.at, kind: note.kind as RepoKind, ...(note.title ? { title: note.title } : {}), text: note.text, about: about.slice(0, MAX_ABOUT), actor: "person" };
  const line: RepoLine = { ...body, id: repoEntryId(body) };
  if (note.tier !== "long" || note.local) refusals.push("only a long-term note enters repo scope: promote it to long-term first");
  if (note.supersededBy) refusals.push(`replaced by ${note.supersededBy.slice(0, 8)}: promote that one instead`);
  if (!REPO_KINDS.includes(note.kind as RepoKind)) refusals.push(`a ${note.kind} stays private: repo scope holds ${REPO_KINDS.join(", ")}`);
  if (Buffer.byteLength(note.text) > MAX_TEXT || Buffer.byteLength(note.title ?? "") > MAX_TITLE) refusals.push(`the note is longer than a repo entry may be (title ${MAX_TITLE} bytes, text ${MAX_TEXT} bytes)`);
  const flat = `${note.title ?? ""}\n${note.text}\n${about.join("\n")}`;
  if (namesPrivatePath(flat)) refusals.push("it names a private path (a home directory or a credential location)");
  let policy: MemoryPolicy | undefined;
  try { policy = repoPolicy(repoPolicyOptions(root), base); } catch (error) { refusals.push((error as Error).message); }
  // The policy's shape check refuses `undefined` values, so the screened value is exactly the committed line's own fields.
  const { id: _lineId, ...committed } = line;
  // The writer and every reader must agree: a line the reader's own parser rejects (a byte limit, a shape) is never appended, whatever the checks above said.
  if (!refusals.length && "error" in parseRepoLine(JSON.stringify(line))) refusals.push("the line it would write does not pass the repo reader's own validation (a title, text or link over a limit, or an empty field); shorten it first");
  if (policy && !await policy.screen(committed)) refusals.push("the screen declined it: a secret, personal data, a private path, a local.deny entry or a pii.paths entry");
  const read = readLog(root);
  if ("unsafe" in read) refusals.push(read.unsafe);
  const alreadyPresent = !("unsafe" in read) && read.lines.some(raw => { const parsed = parseRepoLine(raw); return "view" in parsed && parsed.view.id === line.id; });
  return { line, text: JSON.stringify(line), path: repoLogPath(root), droppedNodes, alreadyPresent, refusals };
}

export interface RepoVisibility { state: Visibility; remotes: { name: string; kind: "fetch" | "push"; url: string; visibility: Visibility }[] }
const redact = (url: string) => url.replace(/\/\/[^/@\s]*@/, "//");
/**
 * Every remote's EFFECTIVE fetch and push URLs, each asked through the same visibility check sync uses (`git remote get-url [--push] --all`: it applies `url.<base>.insteadOf`
 * and `pushInsteadOf`, which a raw `remote.*.url` read does not, and it lists every `pushurl`). Only all-private is private; no remote, a remote git cannot resolve or a
 * non-GitHub host is unknown. `internal` visibility counts as private, as `amem sync` always has (a GitHub Enterprise Cloud repository is not public).
 */
export async function repoVisibility(root: string, visibility?: (url: string) => Promise<Visibility>): Promise<RepoVisibility> {
  // ponytail: `sync.ts` drags in the store and the generation code; the brief and hooks import this module on their cold path, so only a promotion loads it. Upgrade: move `remoteVisibility` to a leaf.
  visibility ??= (await import("./sync.ts")).remoteVisibility;
  const env = memoryGitEnv(process.env, { repositoryIsolation: true });
  const git = (...args: string[]) => memoryGitSync(["-C", root, ...args], { encoding: "utf8", env });
  const listed = git("remote");
  if (listed.status !== 0) return { state: "unknown", remotes: [] };
  const names = (listed.stdout ?? "").split("\n").map(line => line.trim()).filter(Boolean);
  const remotes: RepoVisibility["remotes"] = [];
  let unresolved = false;
  for (const name of names) {
    for (const kind of ["fetch", "push"] as const) {
      const got = git("remote", "get-url", ...(kind === "push" ? ["--push"] : []), "--all", name);
      const urls = got.status === 0 ? (got.stdout ?? "").split("\n").map(line => line.trim()).filter(Boolean) : [];
      if (!urls.length) { unresolved = true; continue; }
      for (const url of urls) {
        let state: Visibility = "unknown";
        try { state = await visibility(url); } catch { /* unknown */ }
        remotes.push({ name, kind, url: redact(url), visibility: state });
      }
    }
  }
  const state: Visibility = remotes.length === 0 || unresolved ? "unknown" : remotes.some(r => r.visibility === "public") ? "public" : remotes.every(r => r.visibility === "private") ? "private" : "unknown";
  return { state, remotes };
}

// ponytail: between the `plainLog` check and the open another process with write access to the repository could swap `.amem` for a symlink. `O_NOFOLLOW` covers the file itself and the post-open
// `realPath(dir)` check refuses a directory that resolves elsewhere, but the open of a path THROUGH a swapped directory is not atomic. The ceiling is a local attacker who can already write the repository.
// Upgrade: open the directory first and use `openat` relative to its descriptor (not available in Bun's fs today).
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
