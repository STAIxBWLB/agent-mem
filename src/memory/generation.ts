import { assertNoPublicPruneIntent, readPublicPruneView } from "./public-prune-view.ts";
import { createHash, randomBytes } from "node:crypto";
import { types } from "node:util";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readerAdmissionDatabase } from "./mutation.ts";
import { dirname, join } from "node:path";
import { canonicalPath, processLiveness, processSignature, realPath } from "./platform.ts";

export interface BoundProfile {
  kind: "shared-v1" | "generation";
  /** Canonical direct memory directory, not the historical parent-home option. */
  home: string;
  dir: string;
  generation?: string;
  selectorRevision: string;
  /** Explicit v2 projection only, never inferred from an archive or caller flag. */
  foreignPruneFormat?: "agent-mem.public-prune-witness/v1";
  pruneInputSetHash?: string;
  /** Sharded profiles read only their own legacy input; the root home remains the machine/selector identity. */
  legacyHome?: string;
  /** Public legacy witnesses stay distinct from same-machine private bridge input. */
  legacyMainHome?: string;
  sharded?: boolean;
  shardKey?: string;
  shardUser?: boolean;
}
export type ProfileInput = "shared-v1" | { generation: string };
export type ProfileSelector = { schema: "agent-mem.profile/v1"; kind: "shared-v1" | "generation"; generation?: string }
  | { schema: "agent-mem.profile/v2"; kind: "generation"; generation: string; foreignPruneFormat: "agent-mem.public-prune-witness/v1"; pruneInputSetHash: string };
export interface GenerationDescriptor { schema: "agent-mem.generation/v1"; generation: string; legacySchema: "agent-hub.memory/v1" }
export interface GenerationSeal { schema: "agent-mem.generation-seal/v1"; generation: string; descriptorHash: string; sourceDigest: string }
export const PROFILE_LOCK_TIMEOUT_MS = 3000;
export const LOCAL_METADATA_MAX_BYTES = 262_144;
export const validGeneration = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJSON(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const hashJSON = (value: unknown): string => createHash("sha256").update(canonicalJSON(value)).digest("hex");
const unavailable = (): never => { throw new Error("memory profile metadata unavailable or invalid; inspect the local profile before continuing"); };

/** Fixed metadata paths are regular files; absent means absent, never unreadable or a symlink. */
export function readProfileJSON(path: string, limit = LOCAL_METADATA_MAX_BYTES): unknown | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return unavailable();
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return unavailable(); }
}
function keys(value: object, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
export function readSelector(memoryDir: string): { selector?: ProfileSelector; revision: string } {
  assertNoPublicPruneIntent(memoryDir);
  const value = readProfileJSON(join(memoryDir, "profile.json"));
  if (value === undefined) return { revision: "absent" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const selector = value as ProfileSelector;
  if (selector.schema === "agent-mem.profile/v2") {
    if (Object.keys(selector).length !== 5 || !keys(selector, ["schema", "kind", "generation", "foreignPruneFormat", "pruneInputSetHash"])
      || selector.kind !== "generation" || !validGeneration(selector.generation) || selector.generation.length !== 32
      || selector.foreignPruneFormat !== "agent-mem.public-prune-witness/v1" || typeof selector.pruneInputSetHash !== "string"
      || selector.pruneInputSetHash.length !== 64 || !/^[a-f0-9]+$/.test(selector.pruneInputSetHash)) return unavailable();
    const shard = readProfileJSON(join(memoryDir, "shards.json")) as Record<string, unknown> | undefined;
    if (!shard || shard.schema !== "agent-mem.shards/v2" || shard.phase !== "active" || shard.generation !== selector.generation || shard.selectorRevision !== hashJSON(selector)) return unavailable();
    readPublicPruneView(memoryDir, selector.pruneInputSetHash, selector.generation);
  } else if (selector.schema !== "agent-mem.profile/v1" || !keys(selector, ["schema", "kind", "generation"])
    || !["shared-v1", "generation"].includes(selector.kind) || (selector.kind === "generation" ? !validGeneration(selector.generation) : selector.generation !== undefined)) return unavailable();
  else if ((readProfileJSON(join(memoryDir, "shards.json")) as {schema?:unknown}|undefined)?.schema === "agent-mem.shards/v2") return unavailable();
  return { selector, revision: hashJSON(selector) };
}

export const selectorRevision = (memoryDir: string): string => readSelector(memoryDir).revision;
export function generationDescriptor(generation: string): GenerationDescriptor {
  if (!validGeneration(generation)) return unavailable();
  return { schema: "agent-mem.generation/v1", generation, legacySchema: "agent-hub.memory/v1" };
}
export function generationDir(memoryDir: string, generation: string): string {
  if (!validGeneration(generation)) return unavailable();
  const generations = join(memoryDir, "generations"), dir = join(generations, generation);
  for (const path of [generations, dir]) if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) return unavailable();
  return dir;
}
export function validateGeneration(memoryDir: string, generation: string): string {
  const dir = generationDir(memoryDir, generation), expected = generationDescriptor(generation);
  for (const folder of ["log", "local"]) {
    const path = join(dir, folder);
    if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return unavailable();
  }
  if (canonicalJSON(readProfileJSON(join(dir, "generation.json"), 4096)) !== canonicalJSON(expected)) return unavailable();
  const seal = readProfileJSON(join(dir, "generation-seal.json"), 4096) as GenerationSeal | undefined;
  if (!seal || !keys(seal, ["schema", "generation", "descriptorHash", "sourceDigest"]) || seal.schema !== "agent-mem.generation-seal/v1" || seal.generation !== generation
    || seal.descriptorHash !== hashJSON(expected) || !/^[a-f0-9]{64}$/.test(seal.sourceDigest)) return unavailable();
  const sources = readProfileJSON(join(dir, "migration-sources.json")) as { schema?: unknown; sources?: unknown; legacyCommit?: unknown } | undefined;
  if (!sources || sources.schema !== "agent-mem.migration-sources/v1" || !Array.isArray(sources.sources) || seal.sourceDigest !== hashJSON({ sources: sources.sources, legacyCommit: sources.legacyCommit })) return unavailable();
  const machine = readProfileJSON(join(dir, "machine.json"), 4096) as { id?: unknown; label?: unknown } | undefined;
  if (!machine || typeof machine.id !== "string" || !/^[a-f0-9]{16}$/.test(machine.id) || typeof machine.label !== "string") return unavailable();
  return dir;
}
export function resolveProfile(memoryDir: string, explicit?: ProfileInput): BoundProfile {
  const home = existsSync(memoryDir) ? realPath(memoryDir) : canonicalPath(memoryDir), selected = readSelector(home);
  if (explicit !== undefined && explicit !== "shared-v1" && (!explicit || typeof explicit !== "object" || !keys(explicit, ["generation"]) || !validGeneration(explicit.generation))) return unavailable();
  if (selected.selector?.schema === "agent-mem.profile/v2" && explicit !== undefined) return unavailable();
  const generation = explicit === "shared-v1" ? undefined : explicit?.generation ?? (selected.selector?.kind === "generation" ? selected.selector.generation : undefined);
  return generation ? { kind: "generation", home, dir: validateGeneration(home, generation), generation, selectorRevision: selected.revision, ...(selected.selector?.schema === "agent-mem.profile/v2" ? { foreignPruneFormat: selected.selector.foreignPruneFormat, pruneInputSetHash: selected.selector.pruneInputSetHash } : {}) }
    : { kind: "shared-v1", home, dir: home, selectorRevision: selected.revision };
}

export function fsyncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
/** Caller owns the home-wide profile lock for selector updates and generation fences for generation metadata. */
export function writeProfileJSON(path: string, value: unknown): void {
  let serialized: string;
  try {
    serialized = canonicalJSON(value) + "\n";
    JSON.parse(serialized);
    if (Buffer.byteLength(serialized, "utf8") > LOCAL_METADATA_MAX_BYTES) return unavailable();
  } catch { return unavailable(); }
  // Match the reader's byte limit, including newline, before creating any temporary or replacing existing metadata.
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path); fsyncDirectory(dirname(path));
}
export async function withProfileLock<T>(memoryDir: string, work: () => T | Promise<T>): Promise<T> {
  const signature = processSignature(process.pid);
  if (!signature) throw new Error("cannot establish profile lock ownership");
  const file = join(memoryDir, "profile.lock"), owner = canonicalJSON({ pid: process.pid, signature, token: randomBytes(16).toString("hex") });
  const deadline = Date.now() + PROFILE_LOCK_TIMEOUT_MS;
  for (;;) {
    let acquired = false;
    const fence = readerAdmissionDatabase(memoryDir);
    let fenced = false;
    try {
      // Serialize the complete stale-owner probe/unlink/recreate sequence, then release before waiting on a live owner.
      fence.run(`PRAGMA busy_timeout = ${Math.max(1, Math.min(25, deadline - Date.now()))}`);
      try { fence.run("BEGIN IMMEDIATE"); fenced = true; } catch { /* bounded contention: retry after releasing connection */ }
      if (fenced) for (let probe = 0; probe < 2; probe++) {
        let fd: number;
        try { fd = openSync(file, "wx", 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("profile lock unavailable");
          try {
            if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) break;
            const previous = readFileSync(file, "utf8"), record = JSON.parse(previous) as { pid?: unknown; signature?: unknown };
            if (typeof record.signature === "string" && record.signature && processLiveness(record.pid, record.signature) === "gone" && readFileSync(file, "utf8") === previous) {
              unlinkSync(file); continue;
            }
          } catch { /* live, malformed or unknown owner cannot be stolen */ }
          break;
        }
        try { writeFileSync(fd, owner); fsyncSync(fd); acquired = true; } finally { closeSync(fd); }
        break;
      }
    } finally {
      if (fenced) fence.run("ROLLBACK");
      fence.close();
    }
    if (!acquired) {
      if (Date.now() >= deadline) throw new Error("profile lock held by a live or unknown owner");
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      continue;
    }
    try { return await work(); }
    finally {
      // A live owner's token cannot be reclaimed; do not remove a file another actor replaced.
      if (existsSync(file) && !lstatSync(file).isSymbolicLink() && readFileSync(file, "utf8") === owner) { unlinkSync(file); fsyncDirectory(memoryDir); }
    }
  }
}


export interface VaultLinkRow {
  schema: "agent-mem.vault-link/v1"; op: "vault_link"; generation: string;
  id: string; at: string; machine: string; actor: "person"; placement: "local";
  target: string; rowHash: string; project: string; path: string;
}
export interface VaultLink { id: string; target: string; rowHash: string; project: string; path: string; at: string }
const invalidVaultLink = (): never => { throw new Error("invalid vault link or unavailable exact entry"); };
export const vaultLinkId = (body: unknown): string => createHash("sha256").update(canonicalJSON(body)).digest("hex").slice(0, 32);

/** Metadata only: this path is never resolved, opened, copied or written by amem. */
export function validVaultPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && Buffer.byteLength(path) <= 512 && path.endsWith(".md")
    && !/[\\:\p{Cc}]/u.test(path) && !path.startsWith("/") && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
export function validateVaultLinkRow(value: unknown, generation: string | undefined, placement: "local" | "synced"): VaultLinkRow {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return invalidVaultLink();
  const expected = ["schema", "op", "generation", "id", "at", "machine", "actor", "placement", "target", "rowHash", "project", "path"].sort();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (canonicalJSON(Object.keys(descriptors).sort()) !== canonicalJSON(expected) || Object.values(descriptors).some(field => !("value" in field) || !field.enumerable || typeof field.value !== "string")) return invalidVaultLink();
  const row = value as VaultLinkRow;
  if (row.schema !== "agent-mem.vault-link/v1" || row.op !== "vault_link" || row.generation !== generation || !/^[a-f0-9]{32}$/.test(row.generation)
    || row.placement !== "local" || placement !== "local" || row.actor !== "person" || !/^[a-f0-9]{16}$/.test(row.machine)
    || !/^[a-f0-9]{32}$/.test(row.id) || !/^[a-f0-9]{32}$/.test(row.target) || !/^[a-f0-9]{64}$/.test(row.rowHash)
    || !row.project.trim() || row.project.length > 400 || /\p{Cc}/u.test(row.project) || !validVaultPath(row.path)
    || !Number.isFinite(Date.parse(row.at)) || new Date(row.at).toISOString() !== row.at || Buffer.byteLength(canonicalJSON(row)) > 4096) return invalidVaultLink();
  const { id, ...body } = row;
  if (id !== vaultLinkId(body)) return invalidVaultLink();
  return row;
}
