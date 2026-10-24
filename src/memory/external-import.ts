import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, sep } from "node:path";
import { aliasedKeys, resolveAlias } from "./aliases.ts";
import { CandidateStore, candidateInputId, type CandidateInput } from "./candidates.ts";
import { pendingSummary, type PendingSummary } from "./candidate-pending.ts";
import { looksSecret } from "./screen.ts";

/** Discovery and read bounds for one import: at most 256 files, 512 directories, 512 entries per directory, 16 directory levels and 1 MiB per file. */
export const EXTERNAL_IMPORT_LIMITS = { maxFiles: 256, maxDirectories: 512, maxEntriesPerDirectory: 512, maxDepth: 16, maxFileBytes: 1024 * 1024, candidateTextChars: 3000, titleChars: 200 } as const;

export type ExternalMemorySource = "claude-auto" | "codex";
export interface ExternalImportResult {
  source: ExternalMemorySource;
  project: string;
  files: number;
  read: number;
  added: number;
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

function names(path: string): string[] {
  try { return readdirSync(path).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).slice(0, EXTERNAL_IMPORT_LIMITS.maxEntriesPerDirectory); }
  catch { return []; }
}

function ruleFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "claude.md" || name === "agents.md";
}

function useful(path: string, source: ExternalMemorySource): boolean {
  const extension = extname(path).toLowerCase();
  return source === "claude-auto" ? extension === ".md" : extension === ".md" || extension === ".txt" || extension === ".jsonl";
}

function discoverClaude(root: string): Discovery {
  const files: SourceFile[] = [];
  let rules = 0, directories = 0;
  if (entryKind(root) !== "directory") return { files, rules };
  directories = 1;
  for (const project of names(root)) {
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
  if (entryKind(root) !== "directory") return { files, rules };
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

function readBounded(path: string): { text: string; truncated: boolean } | undefined {
  if (entryKind(path) !== "file") return undefined;
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
  const lines = text.split(/\r?\n/);
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

export async function importExternalMemory(opts: {
  base: string;
  project: string;
  source: ExternalMemorySource;
  from?: string;
  policy: (value: unknown) => boolean | Promise<boolean>;
}): Promise<ExternalImportResult> {
  if (opts.source !== "claude-auto" && opts.source !== "codex") throw new Error("unknown external memory source");
  const root = opts.from ?? (opts.source === "claude-auto" ? join(homedir(), ".claude", "projects") : join(homedir(), ".codex", "memories"));
  const project = resolveAlias(opts.base, opts.project), aliases = aliasedKeys(opts.base, project);
  const discovery = opts.source === "claude-auto" ? discoverClaude(root) : discoverCodex(root);
  const result: ExternalImportResult = { source: opts.source, project, files: 0, read: 0, added: 0, skipped: { rules: discovery.rules, policy: 0, invalid: 0, truncated: 0 }, pending: { count: 0, oldestExpiresInDays: null, dueWithin7Days: 0, unshown: 0 } };
  const store = new CandidateStore({ memoryDir: opts.base, reconcile: { canonical: project, aliases } });
  try {
    for (const file of discovery.files) {
      result.files++;
      const input = readBounded(file.path);
      if (!input) { result.skipped.invalid++; continue; }
      if (input.truncated) result.skipped.truncated++;
      for (const raw of records(file, input.text)) {
        result.read++;
        if (!raw) { result.skipped.invalid++; continue; }
        const parts = chunks(raw.text);
        if (!parts.length) { result.skipped.invalid++; continue; }
        for (let index = 0; index < parts.length; index++) {
          const record: CandidateInput = { project, kind: "memory", text: parts[index]!, title: title(opts.source, { ...file, relative: portable(file.relative) }, raw, index, parts.length), noteKind: "finding" };
          if (looksSecret(`${record.title ?? ""}\n${record.text}`) || !await opts.policy(record)) { result.skipped.policy++; continue; }
          const id = candidateInputId(record);
          if (store.get(id, project)) continue;
          store.put(record, "public");
          result.added++;
        }
      }
    }
  } finally { store.close(); }
  result.pending = pendingSummary(opts.base, [project, ...aliases], Date.now());
  return result;
}
