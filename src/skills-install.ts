import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { memoryHome } from "./memory/home.ts";
import { resolveSetupPaths, type SetupEnvironment } from "./setup-paths.ts";
import type { SetupTarget } from "./setup.ts";

export const SKILL_NAMES = ["amem-status", "amem-recall", "amem-remember", "amem-review", "amem-ops"] as const;
export type SkillAction = { name: string; path: string; change: "install" | "replace" | "remove" | "unchanged" | "absent" | "modified" | "foreign" | "refused"; reason?: string };
export type SkillInstallReport = { root: string; linkedFrom?: string; actions: SkillAction[] };
type RootBinding = { root: string; linkedFrom?: string };
type Marker = { tool: "amem"; version: string; sha256: string };
type Tree = Map<string, Buffer>;
const markerName = ".amem-skill.json";
// ponytail: Limit each skill to 256 files and 1 MiB per file; make these configurable if larger packaged skills are needed.
const maxFiles = 256, maxBytes = 1024 * 1024;
const defaultRoot = fileURLToPath(new URL("..", import.meta.url));

export function skillRoot(target: SetupTarget, env: SetupEnvironment, givenHome?: string): string | undefined {
  const paths = resolveSetupPaths(env, givenHome).paths;
  if (target === "claude") return join(dirname(paths.claude[1]!), "skills");
  if (target === "codex" || target === "kimi" || target === "qwen") return join(dirname(paths[target][0]!), "skills");
  return undefined;
}
function exists(path: string): boolean { try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
class SkillTreeError extends Error {}
function tree(root: string, skipMarker = false): Tree {
  const result: Tree = new Map();
  function visit(dir: string, prefix: string): void {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SkillTreeError(`not a real directory: ${prefix || "."}`);
    const entries = readdirSync(dir).sort();
    if (!entries.length && prefix) throw new SkillTreeError(`empty directory: ${prefix}`);
    for (const name of entries) {
      if (!prefix && skipMarker && name === markerName) continue;
      const rel = prefix ? `${prefix}/${name}` : name, path = join(dir, name), st = lstatSync(path);
      if (st.isSymbolicLink()) throw new SkillTreeError(`symlink refused: ${rel}`);
      if (st.isDirectory()) visit(path, rel);
      else if (st.isFile()) {
        if (st.size > maxBytes) throw new SkillTreeError(`skill file size limit ${maxBytes} bytes exceeded: ${rel}`);
        if (result.size >= maxFiles) throw new SkillTreeError(`skill file count limit ${maxFiles} exceeded: ${rel}`);
        const data = readFileSync(path);
        if (data.length > maxBytes) throw new SkillTreeError(`skill file size limit ${maxBytes} bytes exceeded: ${rel}`);
        result.set(rel, data);
      } else throw new SkillTreeError(`non-regular file refused: ${rel}`);
    }
  }
  visit(root, "");
  return result;
}
function digest(files: Tree): string {
  const hash = createHash("sha256");
  // Contract: sorted UTF-8 slash-separated paths, each framed as decimal byte length, colon, bytes; then the file bytes framed identically.
  for (const [name, data] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const pathBytes = Buffer.from(name, "utf8");
    hash.update(`${pathBytes.length}:`).update(pathBytes).update(`${data.length}:`).update(data);
  }
  return hash.digest("hex");
}
function marker(dir: string): Marker | undefined {
  try {
    const path = join(dir, markerName), st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const m = value as Record<string, unknown>;
    if (m.tool !== "amem" || typeof m.version !== "string" || typeof m.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.sha256)) return undefined;
    return m as Marker;
  } catch { return undefined; }
}
function owned(dir: string): Marker | undefined {
  const m = marker(dir);
  if (!m || digest(tree(dir, true)) !== m.sha256) return undefined;
  return m;
}
function matches(dir: string, expected: Marker): boolean {
  const current = owned(dir);
  return !!current && current.sha256 === expected.sha256 && current.version === expected.version;
}
function packageTree(packageRoot: string, name: string): Tree {
  safeInput(join(packageRoot, "skills", name));
  safeInput(join(packageRoot, "skills", "_shared", "amem-adapter.md"));
  const files = tree(join(packageRoot, "skills", name));
  if (files.has(markerName) || files.has("references/amem-adapter.md")) throw new Error("reserved packaged file");
  const adapter = join(packageRoot, "skills", "_shared", "amem-adapter.md"), st = lstatSync(adapter);
  if (!st.isFile() || st.isSymbolicLink() || st.size > maxBytes || files.size >= maxFiles) throw new Error("invalid adapter");
  files.set("references/amem-adapter.md", readFileSync(adapter));
  return files;
}
function writeTree(dir: string, files: Tree, version: string): void {
  mkdirSync(dir);
  for (const [name, data] of files) { const path = join(dir, ...name.split("/")); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data, { flag: "wx" }); }
  writeFileSync(join(dir, markerName), JSON.stringify({ tool: "amem", version, sha256: digest(files) }) + "\n", { flag: "wx" });
}
function safeInput(path: string): void {
  if (exists(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Package input ${path} is a symlink`);
}
function within(child: string, parent: string): boolean {
  const part = relative(parent, child);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
function safeRoot(root: string, packageRoot: string, env: SetupEnvironment): RootBinding {
  const absolute = resolve(root);
  if (exists(absolute) && lstatSync(absolute).isSymbolicLink()) {
    const target = resolve(dirname(absolute), readlinkSync(absolute));
    let physical: string;
    try { physical = realPath(absolute); }
    catch { throw new Error(`Skill root link ${absolute} targets ${target}, which is unavailable; repair the link and retry`); }
    if (!lstatSync(physical).isDirectory()) throw new Error(`Skill root link ${absolute} targets ${physical}, which is not a directory; choose a directory and retry`);
    const home = canonicalPath(memoryHome(env)), source = canonicalPath(join(packageRoot, "skills"));
    if (within(physical, home) || within(physical, source)) throw new Error(`Skill root link ${absolute} targets ${physical}, inside the memory home or package skills; choose another directory and retry`);
    return { root: physical, linkedFrom: absolute };
  }
  function parentPath(path: string): string {
    if (exists(path)) return realPath(path);
    const parent = dirname(path);
    if (parent === path) throw new Error(`Cannot resolve ${path}`);
    return join(parentPath(parent), basename(path));
  }
  return { root: join(parentPath(dirname(absolute)), basename(absolute)) };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function leftovers(root: string, name: string): string[] {
  if (!exists(root)) return [];
  return readdirSync(root).filter(x => x.startsWith(`.amem-skill-${name}-`)).map(x => join(root, x));
}
export function installSkills(root: string, mode: "preview" | "apply" | "undo", packageRoot = defaultRoot, packageVersion?: string, retryCommand = "amem setup --apply", env: SetupEnvironment = process.env, expectedBinding?: RootBinding): SkillInstallReport {
  root = resolve(root);
  const actions: SkillAction[] = [];
  const requested = root;
  let rootError: string | undefined, binding: RootBinding = { root };
  let identity: { dev: number; ino: number } | undefined;
  try {
    binding = safeRoot(root, packageRoot, env); root = binding.root;
    if (expectedBinding && (expectedBinding.root !== root || expectedBinding.linkedFrom !== binding.linkedFrom)) throw new Error(`Skill root ${requested} changed since preview (target ${root}); inspect it and rerun ${retryCommand}`);
    if (exists(root)) { const st = lstatSync(root); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${root} is not a real directory; choose a directory`); identity = { dev: st.dev, ino: st.ino }; }
  } catch (e) { rootError = message(e); }
  const checkRoot = () => {
    if (binding.linkedFrom) {
      const current = safeRoot(binding.linkedFrom, packageRoot, env);
      if (current.root !== root || current.linkedFrom !== binding.linkedFrom) throw new Error(`Skill root link ${binding.linkedFrom} changed from ${root}; inspect the link and rerun ${retryCommand}`);
    }
    const st = lstatSync(root);
    if (!st.isDirectory() || st.isSymbolicLink() || identity && (st.dev !== identity.dev || st.ino !== identity.ino)) throw new Error(`Skill root ${root} changed; inspect it and rerun ${retryCommand}`);
  };
  let version = packageVersion;
  if (mode !== "undo" && version === undefined) { try { version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version; if (typeof version !== "string") throw new Error("invalid version"); } catch (e) { rootError = `${message(e)}; check the package and rerun ${retryCommand}`; } }
  for (const name of SKILL_NAMES) {
    const path = join(root, name);
    const action = (change: SkillAction["change"], reason?: string) => actions.push({ name, path, change, ...(reason ? { reason: change === "foreign" || change === "modified" ? `${reason} at ${path}; keep it, or move it aside and rerun ${retryCommand}` : reason } : {}) });
    if (rootError) { action("refused", rootError); continue; }
    try {
      const pending = leftovers(root, name);
      // Recover only verified leftovers. A backup is restored if the destination is absent; verified stages and obsolete backups can then be removed.
      if (pending.length) {
        const backups = pending.filter(p => basename(p).startsWith(`.amem-skill-${name}-backup-`));
        const stages = pending.filter(p => basename(p).startsWith(`.amem-skill-${name}-stage-`));
        const verified = pending.every(p => { try { return !!owned(p); } catch { return false; } });
        if (!verified || backups.length > 1 || stages.length > 1 || backups.length + stages.length !== pending.length) { action("refused", `Unverified or ambiguous interrupted swap: ${pending.join(", ")}; inspect and remove the leftovers if no longer needed, then rerun ${retryCommand}`); continue; }
        if (mode === "preview") { action("refused", `Interrupted swap requires recovery; run ${retryCommand}`); continue; }
        checkRoot();
        if (!exists(path) && backups.length === 1) renameSync(backups[0]!, path);
        if (exists(path) && !owned(path)) { action("refused", `Interrupted swap destination ${path} is not verified; keep it, or move it aside and rerun ${retryCommand}`); continue; }
        for (const item of pending) if (exists(item)) { if (!owned(item)) throw new Error("Interrupted swap changed during recovery"); rmSync(item, { recursive: true }); }
      }
      let old: Marker | undefined;
      if (exists(path)) {
        const st = lstatSync(path);
        if (st.isSymbolicLink()) { action("foreign", "Skill target is a symlink"); continue; }
        if (!st.isDirectory()) { action("foreign", "Skill target is not a directory"); continue; }
        if (!(old = marker(path))) { action("foreign", "Skill directory lacks a valid amem ownership marker"); continue; }
        try { if (!owned(path)) { action("modified", "Owned skill changed; preserve it"); continue; } } catch (error) { action("modified", error instanceof SkillTreeError ? `Owned skill contains unsafe files (${error.message})` : "Owned skill contains unsafe or changed files"); continue; }
      }
      if (mode === "undo") {
        if (!old) { action("absent"); continue; }
        if (!matches(path, old)) { action("modified", "Skill changed before removal"); continue; }
        const backup = join(root, `.amem-skill-${name}-backup-${randomUUID()}`);
        checkRoot(); renameSync(path, backup);
        if (!matches(backup, old)) { renameSync(backup, path); action("modified", "Skill changed before removal"); continue; }
        rmSync(backup, { recursive: true }); action("remove"); continue;
      }
      const files = packageTree(packageRoot, name), expected = digest(files);
      if (old && old.sha256 === expected && old.version === version) { action("unchanged"); continue; }
      if (mode === "preview") { action(old ? "replace" : "install"); continue; }
      if (exists(root)) checkRoot();
      mkdirSync(root, { recursive: true });
      if (!identity) { const st = lstatSync(root); identity = { dev: st.dev, ino: st.ino }; }
      checkRoot();
      const stage = join(root, `.amem-skill-${name}-stage-${randomUUID()}`), backup = join(root, `.amem-skill-${name}-backup-${randomUUID()}`);
      writeTree(stage, files, version!);
      if (!owned(stage)) throw new Error("staged verification failed");
      checkRoot();
      if (old) {
        if (!matches(path, old)) { if (owned(stage)) rmSync(stage, { recursive: true }); action("modified", "Skill changed before swap"); continue; }
        renameSync(path, backup);
        if (!matches(backup, old)) { renameSync(backup, path); if (owned(stage)) rmSync(stage, { recursive: true }); action("modified", "Skill changed before swap"); continue; }
      } else if (exists(path)) { if (owned(stage)) rmSync(stage, { recursive: true }); action("foreign", "Destination appeared before install"); continue; }
      try {
        renameSync(stage, path);
        if (!owned(path) || marker(path)?.sha256 !== expected) throw new Error("post-swap verification failed");
        if (old && !matches(backup, old)) throw new Error("backup changed before removal");
      } catch (e) {
        if (exists(path) && matches(path, { tool: "amem", version: version!, sha256: expected })) rmSync(path, { recursive: true });
        if (old && !exists(path) && exists(backup)) renameSync(backup, path);
        if (exists(stage) && owned(stage)) rmSync(stage, { recursive: true });
        action("refused", `${message(e)}; inspect the affected files and rerun ${retryCommand}`);
        continue;
      }
      if (old) {
        try { rmSync(backup, { recursive: true }); }
        catch (e) { action("refused", `Installed skill is verified but backup removal failed at ${backup}: ${message(e)}; inspect and remove the leftover, then rerun ${retryCommand}`); continue; }
      }
      action(old ? "replace" : "install");
    } catch (e) { action("refused", `${message(e)}; inspect the affected files and rerun ${retryCommand}`); }
  }
  return { root, ...(binding.linkedFrom ? { linkedFrom: binding.linkedFrom } : {}), actions };
}
export function exportSkills(destination: string, options: { packageRoot?: string; packageVersion?: string; env?: SetupEnvironment } = {}): SkillInstallReport {
  let root = resolve(destination || ".");
  let binding: RootBinding = { root };
  const retry = `amem skills export '${destination.replace(/'/g, "'\\''")}'`;
  const refuse = (reason: string): SkillInstallReport => ({ root, ...(binding.linkedFrom ? { linkedFrom: binding.linkedFrom } : {}), actions: SKILL_NAMES.map(name => ({ name, path: join(root, name), change: "refused", reason })) });
  if (!destination.trim() || [...destination].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return refuse("Destination is empty or contains control characters; choose a valid directory and rerun amem skills export <dir>");
  try {
    binding = safeRoot(root, options.packageRoot ?? defaultRoot, options.env ?? process.env); root = binding.root;
    if (exists(root)) {
      if (!lstatSync(root).isDirectory()) return refuse(`Destination ${root} is not a directory; choose a directory and rerun ${retry}`);
      for (const entry of readdirSync(root)) {
        if ((SKILL_NAMES as readonly string[]).includes(entry)) continue;
        const recognized = SKILL_NAMES.some(name => entry.startsWith(`.amem-skill-${name}-`));
        if (!recognized) return refuse(`Foreign destination entry ${join(root, entry)}; keep it or move it aside, then rerun ${retry}`);
        let valid = false;
        try { valid = !!owned(join(root, entry)); } catch { /* preserve unverified leftovers */ }
        if (!valid) return refuse(`Unverified interrupted swap ${join(root, entry)}; inspect and remove it if no longer needed, then rerun ${retry}`);
      }
    }
  } catch (e) { return refuse(`${message(e)}; inspect the destination and rerun ${retry}`); }
  return installSkills(destination, "apply", options.packageRoot, options.packageVersion, retry, options.env, binding);
}
