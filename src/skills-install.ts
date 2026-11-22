import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSetupPaths, type SetupEnvironment } from "./setup-paths.ts";
import type { SetupTarget } from "./setup.ts";

export const SKILL_NAMES = ["amem-status", "amem-recall", "amem-remember", "amem-review", "amem-ops"] as const;
export type SkillAction = { name: string; path: string; change: "install" | "replace" | "remove" | "unchanged" | "absent" | "modified" | "foreign" | "refused"; reason?: string };
export type SkillInstallReport = { root: string; actions: SkillAction[] };
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
function tree(root: string, skipMarker = false): Tree {
  const result: Tree = new Map();
  function visit(dir: string, prefix: string): void {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a real directory");
    const entries = readdirSync(dir).sort();
    if (!entries.length && prefix) throw new Error("empty directory");
    for (const name of entries) {
      if (!prefix && skipMarker && name === markerName) continue;
      const rel = prefix ? `${prefix}/${name}` : name, path = join(dir, name), st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error("symlink refused");
      if (st.isDirectory()) visit(path, rel);
      else if (st.isFile()) {
        if (st.size > maxBytes || result.size >= maxFiles) throw new Error("skill size limit exceeded");
        const data = readFileSync(path);
        if (data.length > maxBytes) throw new Error("skill size limit exceeded");
        result.set(rel, data);
      } else throw new Error("non-regular file refused");
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
  safeRoot(join(packageRoot, "skills", name));
  safeRoot(join(packageRoot, "skills", "_shared", "amem-adapter.md"));
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
function safeRoot(root: string): void {
  let current = resolve(root);
  while (true) { if (exists(current) && lstatSync(current).isSymbolicLink()) throw new Error("symlinked root refused"); const parent = dirname(current); if (parent === current) break; current = parent; }
}
function leftovers(root: string, name: string): string[] {
  if (!exists(root)) return [];
  return readdirSync(root).filter(x => x.startsWith(`.amem-skill-${name}-`)).map(x => join(root, x));
}
export function installSkills(root: string, mode: "preview" | "apply" | "undo", packageRoot = defaultRoot, packageVersion?: string, retryCommand = "amem setup --apply"): SkillInstallReport {
  root = resolve(root);
  const actions: SkillAction[] = [];
  let rootError: string | undefined;
  try { safeRoot(root); if (exists(root) && !lstatSync(root).isDirectory()) throw new Error("root is not a directory"); } catch (e) { rootError = String(e); }
  let version = packageVersion;
  if (mode !== "undo" && version === undefined) { try { version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version; if (typeof version !== "string") throw new Error("invalid version"); } catch (e) { rootError = String(e); } }
  for (const name of SKILL_NAMES) {
    const path = join(root, name);
    const action = (change: SkillAction["change"], reason?: string) => actions.push({ name, path, change, ...(reason ? { reason } : {}) });
    if (rootError) { action("refused", rootError); continue; }
    try {
      const pending = leftovers(root, name);
      // Recover only verified leftovers. A backup is restored if the destination is absent; verified stages and obsolete backups can then be removed.
      if (pending.length) {
        const backups = pending.filter(p => p.includes("-backup-"));
        const stages = pending.filter(p => p.includes("-stage-"));
        const verified = pending.every(p => { try { return !!owned(p); } catch { return false; } });
        if (!verified || backups.length > 1 || stages.length > 1 || backups.length + stages.length !== pending.length) { action("refused", `Unverified or ambiguous interrupted swap; inspect ${root}`); continue; }
        if (mode === "preview") { action("refused", `Interrupted swap requires recovery; run ${retryCommand}`); continue; }
        if (!exists(path) && backups.length === 1) renameSync(backups[0]!, path);
        if (exists(path) && !owned(path)) { action("refused", "Interrupted swap destination is not verified"); continue; }
        for (const item of pending) if (exists(item)) { if (!owned(item)) throw new Error("Interrupted swap changed during recovery"); rmSync(item, { recursive: true }); }
      }
      let old: Marker | undefined;
      if (exists(path)) {
        const st = lstatSync(path);
        if (!st.isDirectory() || st.isSymbolicLink() || !(old = marker(path))) { action("foreign", "Not an amem-owned directory"); continue; }
        try { if (!owned(path)) { action("modified", "Owned skill changed; preserve it"); continue; } } catch { action("modified", "Owned skill contains unsafe or changed files"); continue; }
      }
      if (mode === "undo") {
        if (!old) { action("absent"); continue; }
        if (!matches(path, old)) { action("modified", "Skill changed before removal"); continue; }
        const backup = join(root, `.amem-skill-${name}-backup-${randomUUID()}`);
        renameSync(path, backup);
        if (!matches(backup, old)) { renameSync(backup, path); action("modified", "Skill changed before removal"); continue; }
        rmSync(backup, { recursive: true }); action("remove"); continue;
      }
      const files = packageTree(packageRoot, name), expected = digest(files);
      if (old && old.sha256 === expected && old.version === version) { action("unchanged"); continue; }
      if (mode === "preview") { action(old ? "replace" : "install"); continue; }
      mkdirSync(root, { recursive: true });
      const stage = join(root, `.amem-skill-${name}-stage-${randomUUID()}`), backup = join(root, `.amem-skill-${name}-backup-${randomUUID()}`);
      writeTree(stage, files, version!);
      if (!owned(stage)) throw new Error("staged verification failed");
      if (old) {
        if (!matches(path, old)) { if (owned(stage)) rmSync(stage, { recursive: true }); action("modified", "Skill changed before swap"); continue; }
        renameSync(path, backup);
        if (!matches(backup, old)) { renameSync(backup, path); if (owned(stage)) rmSync(stage, { recursive: true }); action("modified", "Skill changed before swap"); continue; }
      } else if (exists(path)) { if (owned(stage)) rmSync(stage, { recursive: true }); action("foreign", "Destination appeared before install"); continue; }
      try {
        renameSync(stage, path);
        if (!owned(path) || marker(path)?.sha256 !== expected) throw new Error("post-swap verification failed");
        if (old) { if (!matches(backup, old)) throw new Error("backup changed before removal"); rmSync(backup, { recursive: true }); }
        action(old ? "replace" : "install");
      } catch (e) {
        if (exists(path) && matches(path, { tool: "amem", version: version!, sha256: expected })) rmSync(path, { recursive: true });
        if (old && !exists(path) && exists(backup)) renameSync(backup, path);
        if (exists(stage) && owned(stage)) rmSync(stage, { recursive: true });
        action("refused", `${String(e)}; retry ${retryCommand}`);
      }
    } catch (e) { action("refused", `${String(e)}; retry ${retryCommand}`); }
  }
  return { root, actions };
}
export function exportSkills(destination: string, options: { packageRoot?: string; packageVersion?: string } = {}): SkillInstallReport {
  const root = resolve(destination || "."), refuse = (reason: string): SkillInstallReport => ({ root, actions: SKILL_NAMES.map(name => ({ name, path: join(root, name), change: "refused", reason })) });
  if (!destination.trim() || [...destination].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return refuse("Invalid destination");
  try {
    safeRoot(root);
    if (exists(root)) {
      if (!lstatSync(root).isDirectory()) return refuse("Destination is not a directory");
      for (const entry of readdirSync(root)) {
        if ((SKILL_NAMES as readonly string[]).includes(entry)) continue;
        const recognized = SKILL_NAMES.some(name => entry.startsWith(`.amem-skill-${name}-`));
        if (!recognized || !owned(join(root, entry))) return refuse(`Foreign destination entry: ${entry}`);
      }
    }
  } catch (e) { return refuse(String(e)); }
  return installSkills(root, "apply", options.packageRoot, options.packageVersion, `amem skills export '${destination.replace(/'/g, "'\\''")}'`);
}
