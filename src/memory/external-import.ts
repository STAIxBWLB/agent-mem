import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { aliasedKeys, resolveAlias } from "./aliases.ts";
import { CandidateQueueFull, CandidateStore, candidateInputId, type CandidateInput } from "./candidates.ts";
import { pendingSummary, type PendingSummary } from "./candidate-pending.ts";
import { realPath } from "./platform.ts";
import { stripPrivateDeep } from "./private-spans.ts";
import { looksSecret } from "./screen.ts";

/** Discovery and read bounds for one import: at most 256 files, 512 directories, 512 entries per directory, 16 directory levels, 1 MiB per file and 100 new candidates. */
export const EXTERNAL_IMPORT_LIMITS = { maxFiles: 256, maxDirectories: 512, maxEntriesPerDirectory: 512, maxDepth: 16, maxFileBytes: 1024 * 1024, maxCandidatesPerRun: 100, candidateTextChars: 3000, titleChars: 200 } as const;

export type ExternalMemorySource = "claude-auto" | "codex";
export interface ExternalImportResult {
  source: ExternalMemorySource;
  project: string;
  files: number;
  read: number;
  added: number;
  queueFull: boolean;
  limitReached: boolean;
  skipped: { rules: number; policy: number; invalid: number; truncated: number };
  pending: PendingSummary;
}

type SourceFile = { path: string; relative: string };
type RawRecord = { text: string; title?: string; line?: number };
type Discovery = { files: SourceFile[]; rules: number };

function entryKind(path: string): "file" | "directory" | "symlink" | "other" | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch { return undefined; }
}

function sourceRoot(path: string): string | undefined {
  if (entryKind(path) !== "directory") return undefined;
  try {
    const root = realPath(path);
    for (let dir = root;; dir = dirname(dir)) {
      if (entryKind(dir) !== "directory") return undefined;
      const parent = dirname(dir);
      if (parent === dir) return root;
    }
  } catch { return undefined; }
}

function names(path: string): string[] {
  let dir;
  try {
    dir = opendirSync(path);
    const output: string[] = [];
    while (output.length < EXTERNAL_IMPORT_LIMITS.maxEntriesPerDirectory) {
      const entry = dir.readSync();
      if (!entry) break;
      output.push(entry.name);
    }
    return output;
  } catch { return []; }
  finally { dir?.closeSync(); }
}

function ruleFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "claude.md" || name === "agents.md" || name === "agents.override.md" || name.endsWith(".local.md");
}

function useful(path: string, source: ExternalMemorySource): boolean {
  const extension = extname(path).toLowerCase();
  return source === "claude-auto" ? extension === ".md" : extension === ".md" || extension === ".txt" || extension === ".jsonl";
}

function discoverClaude(root: string, projectDirectory?: string): Discovery {
  const files: SourceFile[] = [];
  let rules = 0, directories = 1;
  for (const project of projectDirectory === undefined ? names(root) : [projectDirectory]) {
    if (directories >= EXTERNAL_IMPORT_LIMITS.maxDirectories || files.length >= EXTERNAL_IMPORT_LIMITS.maxFiles) break;
    const projectPath = join(root, project), projectKind = entryKind(projectPath);
    if (projectKind === "symlink") { rules++; continue; }
    if (projectKind !== "directory") continue;
    directories++;
    const memoryPath = join(projectPath, "memory"), memoryKind = entryKind(memoryPath);
    if (memoryKind === "symlink") { rules++; continue; }
    if (memoryKind !== "directory") continue;
    if (directories >= EXTERNAL_IMPORT_LIMITS.maxDirectories) break;
    directories++;
    for (const name of names(memoryPath)) {
      if (files.length >= EXTERNAL_IMPORT_LIMITS.maxFiles) break;
      const path = join(memoryPath, name), kind = entryKind(path);
      if (kind === "symlink") { rules++; continue; }
      if (kind !== "file" || !useful(path, "claude-auto")) continue;
      if (ruleFile(path)) { rules++; continue; }
      files.push({ path, relative: [project, "memory", name].join("/") });
    }
  }
  return { files, rules };
}

function discoverCodex(root: string): Discovery {
  const files: SourceFile[] = [];
  let rules = 0, directories = 0;
  const pending: { path: string; relative: string; depth: number }[] = [{ path: root, relative: "", depth: 0 }];
  while (pending.length && directories < EXTERNAL_IMPORT_LIMITS.maxDirectories && files.length < EXTERNAL_IMPORT_LIMITS.maxFiles) {
    const current = pending.shift()!;
    if (entryKind(current.path) !== "directory") continue;
    directories++;
    const directoriesToAdd: { path: string; relative: string; depth: number }[] = [];
    for (const name of names(current.path)) {
      if (files.length >= EXTERNAL_IMPORT_LIMITS.maxFiles) break;
      const path = join(current.path, name), relative = current.relative ? `${current.relative}/${name}` : name;
      const kind = entryKind(path);
      if (kind === "symlink") { rules++; continue; }
      if (kind === "directory") {
        if (basename(path).toLowerCase() === "rules") { rules++; continue; }
        if (current.depth < EXTERNAL_IMPORT_LIMITS.maxDepth) directoriesToAdd.push({ path, relative, depth: current.depth + 1 });
        continue;
      }
      if (kind !== "file" || !useful(path, "codex")) continue;
      if (ruleFile(path)) { rules++; continue; }
      files.push({ path, relative });
    }
    pending.push(...directoriesToAdd);
  }
  return { files, rules };
}

function readBounded(path: string, root: string): { text: string; truncated: boolean } | undefined {
  const tail = relative(root, path);
  if (!tail || tail === ".." || tail.startsWith(`..${sep}`) || entryKind(path) !== "file") return undefined;
  for (let dir = dirname(path);; dir = dirname(dir)) {
    if (entryKind(dir) !== "directory") return undefined;
    if (dir === root) break;
    if (dir === dirname(dir)) return undefined;
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.alloc(EXTERNAL_IMPORT_LIMITS.maxFileBytes + 1);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (!count) break;
      read += count;
    }
    return { text: buffer.subarray(0, Math.min(read, EXTERNAL_IMPORT_LIMITS.maxFileBytes)).toString("utf8"), truncated: read > EXTERNAL_IMPORT_LIMITS.maxFileBytes };
  } catch { return undefined; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ } }
}

function records(file: SourceFile, text: string): (RawRecord | undefined)[] {
  if (extname(file.path).toLowerCase() !== ".jsonl") return [text.trim() && !text.includes("\0") ? { text } : undefined];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index): RawRecord | undefined => {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "string") return value.trim() && !value.includes("\0") ? { text: value, line: index + 1 } : undefined;
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const record = value as { text?: unknown; title?: unknown };
      if (typeof record.text !== "string" || !record.text.trim() || record.text.includes("\0") || record.title !== undefined && typeof record.title !== "string") return undefined;
      return { text: record.text, ...(typeof record.title === "string" ? { title: record.title } : {}), line: index + 1 };
    } catch { return undefined; }
  });
}

function chunks(text: string): string[] {
  const output: string[] = [];
  let rest = text.trim();
  while (rest.length > EXTERNAL_IMPORT_LIMITS.candidateTextChars) {
    let end = EXTERNAL_IMPORT_LIMITS.candidateTextChars;
    const newline = rest.lastIndexOf("\n", end);
    if (newline >= Math.floor(end / 2)) end = newline + 1;
    if (end > 0 && /[\uD800-\uDBFF]/.test(rest[end - 1]!)) end--;
    const chunk = rest.slice(0, end).trim();
    if (chunk) output.push(chunk);
    rest = rest.slice(end).trimStart();
  }
  if (rest) output.push(rest);
  return output;
}

function cleanTitle(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

function boundedTitle(text: string): string {
  const clean = cleanTitle(text), max = EXTERNAL_IMPORT_LIMITS.titleChars;
  if (clean.length <= max) return clean;
  let left = 80, right = max - left - 3;
  if (/[\uD800-\uDBFF]/.test(clean[left - 1]!)) left--;
  let tail = clean.length - right;
  if (tail > 0 && /[\uDC00-\uDFFF]/.test(clean[tail]!)) tail++;
  return `${clean.slice(0, left)}...${clean.slice(tail)}`;
}

function title(source: ExternalMemorySource, file: SourceFile, record: RawRecord, part: number, parts: number): string {
  const location = `${file.relative}${record.line === undefined ? "" : `#${record.line}`}`;
  const suffix = parts > 1 ? ` (part ${part + 1}/${parts})` : "";
  return boundedTitle(`${source}: ${location}${record.title?.trim() ? `: ${record.title}` : ""}${suffix}`);
}

function portable(path: string): string { return path.split(sep).join("/"); }
function claudeProjectDirectory(cwd: string): string { return realPath(cwd).replace(/[/.]/g, "-"); }

export async function importExternalMemory(opts: {
  base: string;
  project: string;
  source: ExternalMemorySource;
  from?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  policy: (value: unknown) => boolean | Promise<boolean>;
}): Promise<ExternalImportResult> {
  if (opts.source !== "claude-auto" && opts.source !== "codex") throw new Error("unknown external memory source");
  const env = opts.env ?? process.env, home = env.HOME || homedir();
  const configured = opts.source === "claude-auto" ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME;
  const source = opts.from ?? (configured?.trim() ? join(configured, opts.source === "claude-auto" ? "projects" : "memories") : join(home, opts.source === "claude-auto" ? ".claude/projects" : ".codex/memories"));
  const root = sourceRoot(source), project = resolveAlias(opts.base, opts.project), aliases = aliasedKeys(opts.base, project);
  const projectDirectory = opts.from === undefined && opts.source === "claude-auto" ? claudeProjectDirectory(opts.cwd ?? process.cwd()) : undefined;
  const discovery = root ? opts.source === "claude-auto" ? discoverClaude(root, projectDirectory) : discoverCodex(root) : { files: [], rules: 0 };
  const result: ExternalImportResult = { source: opts.source, project, files: 0, read: 0, added: 0, queueFull: false, limitReached: false, skipped: { rules: discovery.rules, policy: 0, invalid: 0, truncated: 0 }, pending: { count: 0, oldestExpiresInDays: null, dueWithin7Days: 0, unshown: 0 } };
  const store = new CandidateStore({ memoryDir: opts.base, reconcile: { canonical: project, aliases } });
  try {
    for (const file of discovery.files) {
      result.files++;
      const input = readBounded(file.path, root!);
      if (!input) { result.skipped.invalid++; continue; }
      if (input.truncated) result.skipped.truncated++;
      for (const raw of records(file, input.text)) {
        result.read++;
        if (!raw) { result.skipped.invalid++; continue; }
        const parts = chunks(raw.text);
        if (!parts.length) { result.skipped.invalid++; continue; }
        for (let index = 0; index < parts.length; index++) {
          if (result.added >= EXTERNAL_IMPORT_LIMITS.maxCandidatesPerRun) { result.limitReached = true; break; }
          const record = stripPrivateDeep<CandidateInput>({ project, kind: "memory", text: parts[index]!, title: title(opts.source, { ...file, relative: portable(file.relative) }, raw, index, parts.length), noteKind: "finding" });
          if (record.kind !== "memory" || !record.text.trim() || record.title !== undefined && !record.title.trim()) { result.skipped.invalid++; continue; }
          if (looksSecret(`${record.title ?? ""}\n${record.text}`) || !await opts.policy(record)) { result.skipped.policy++; continue; }
          const id = candidateInputId(record);
          if (store.get(id, project)) continue;
          try { store.put(record, "public"); }
          catch (error) {
            if (!(error instanceof CandidateQueueFull)) throw error;
            result.queueFull = true;
            break;
          }
          result.added++;
        }
        if (result.queueFull || result.limitReached) break;
      }
      if (result.queueFull || result.limitReached) break;
    }
  } finally { store.close(); }
  result.pending = pendingSummary(opts.base, [project, ...aliases], Date.now());
  return result;
}
