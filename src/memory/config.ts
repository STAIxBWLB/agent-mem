import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createStandalonePolicy, type StandalonePolicy, type StandalonePolicyOptions } from "./policy.ts";

/**
 * F4 (agent-mem#40): standalone policy configuration, with no host. Two files, both plain JSON:
 *
 * - the machine-local `amem.config.json` in the memory home: the person's own policy (deny paths, PII patterns, the SessionStart brief byte
 *   budget, the capture excerpt and path caps, the capture size cap and retention, and where the home lives);
 * - an optional `<repository>/.amem/config`: a repository may only NARROW. It adds deny paths and PII patterns and may lower a byte or count
 *   budget; it can never remove a machine entry, raise a budget, or move the home. A stricter host policy passed through the library wins over both.
 *
 * Either file that exists but is not a bounded plain JSON object of known keys is an error that names it, never a silent default: an unreadable
 * policy must not read as "no policy". Reading is synchronous and does no model, network or storage work.
 */
export const CONFIG_FILE = "amem.config.json";
export const REPO_CONFIG_DIR = ".amem";
export const REPO_CONFIG_FILE = "config";
const MAX_CONFIG_BYTES = 64 * 1024;
const MACHINE_KEYS = ["home", "denyPaths", "piiPatterns", "briefBytes", "excerptBytes", "capturePaths", "capture"] as const;
const REPO_KEYS = ["denyPaths", "piiPatterns", "briefBytes", "excerptBytes", "capturePaths"] as const;

export interface AmemConfig {
  /** The memory home, when the file moves it (a pointer file: see `configuredHome`). `AMEM_HOME` still wins. Machine file only. */
  home?: string;
  denyPaths: string[];
  piiPatterns: string[];
  /** SessionStart brief byte budget; the built-in hook cap is the ceiling. */
  briefBytes?: number;
  /** Capture excerpt cap in bytes-as-characters; the built-in cap is the ceiling. */
  excerptBytes?: number;
  /** Capture path-count cap; the built-in cap is the ceiling. */
  capturePaths?: number;
  /** The capture tier's own R6 bounds. Machine file only (a repository cannot widen the machine's disk use). */
  capture: { capMb?: number; retentionDays?: number };
}
export interface ConfigSource { machine: string | null; repo: string | null }
export interface LoadedConfig { config: AmemConfig; source: ConfigSource }

const fail = (file: string, why: string): never => { throw new Error(`${file}: ${why}; fix or remove it (an unreadable policy is never treated as no policy)`); };

/** One bounded read through one descriptor: a link, a non-file or a growing file refuses, and a missing file is `undefined`. */
function readPlain(path: string, label: string): unknown | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return fail(label, code === "ELOOP" ? "is a symbolic link" : "cannot be read");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return fail(label, `is not a plain file within ${MAX_CONFIG_BYTES} bytes`);
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) return fail(label, `is not a plain file within ${MAX_CONFIG_BYTES} bytes`);
    try { return JSON.parse(text) as unknown; } catch { return fail(label, "does not parse as JSON"); }
  } finally { closeSync(fd); }
}

function listOf(value: unknown, key: string, label: string): string[] {
  if (value === undefined) return [];
  // The standalone policy takes at most 64 literals of 256 bytes without control characters: say so here, by name.
  if (!Array.isArray(value) || value.length > 64 || !value.every(item => typeof item === "string" && item.trim() !== "" && Buffer.byteLength(item) <= 256 && !/[\x00-\x1f\x7f]/.test(item)))
    return fail(label, `${key} is not a list of at most 64 non-empty strings of at most 256 bytes without control characters`);
  return [...new Set(value as string[])];
}
function countOf(value: unknown, key: string, label: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) return fail(label, `${key} is not a whole number from 1 to ${max}`);
  return value;
}

function parseFile(raw: unknown, label: string, keys: readonly string[]): Partial<AmemConfig> & { capture?: AmemConfig["capture"] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(label, "is not a JSON object");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!keys.includes(key)) fail(label, `unknown key "${key}" (known: ${keys.join(", ")})`);
  const out: Partial<AmemConfig> & { capture?: AmemConfig["capture"] } = {
    denyPaths: listOf(body.denyPaths, "denyPaths", label), piiPatterns: listOf(body.piiPatterns, "piiPatterns", label),
  };
  const briefBytes = countOf(body.briefBytes, "briefBytes", label, 1_000_000); if (briefBytes !== undefined) out.briefBytes = briefBytes;
  const excerptBytes = countOf(body.excerptBytes, "excerptBytes", label, 100_000); if (excerptBytes !== undefined) out.excerptBytes = excerptBytes;
  const capturePaths = countOf(body.capturePaths, "capturePaths", label, 1000); if (capturePaths !== undefined) out.capturePaths = capturePaths;
  if (body.home !== undefined) {
    if (typeof body.home !== "string" || !body.home.trim() || body.home.includes("\0") || !body.home.startsWith("/")) return fail(label, "home is not an absolute path");
    // A file that moves the home is a pointer: the policy is read from the file IN the home it names, so any policy key beside `home` here would be silently lost.
    const beside = Object.keys(body).filter(key => key !== "home");
    if (beside.length) return fail(label, `names a home, so it is only a pointer; put ${beside.join(", ")} in ${join(body.home, CONFIG_FILE)}`);
    out.home = body.home;
  }
  if (body.capture !== undefined) {
    const capture = body.capture;
    if (!capture || typeof capture !== "object" || Array.isArray(capture) || Object.keys(capture).some(key => !["capMb", "retentionDays"].includes(key))) return fail(label, "capture takes only capMb and retentionDays");
    const c = capture as Record<string, unknown>;
    out.capture = {};
    const capMb = countOf(c.capMb, "capture.capMb", label, 1_048_576), retentionDays = countOf(c.retentionDays, "capture.retentionDays", label, 36_500);
    if (capMb !== undefined) out.capture.capMb = capMb;
    if (retentionDays !== undefined) out.capture.retentionDays = retentionDays;
  }
  return out;
}

/** The machine file's `home` before any store exists: the one key read ahead of the home itself. `AMEM_HOME` and the config's `home` name different homes only when the person sets both, and `AMEM_HOME` wins. */
export function machineConfigPath(base: string): string { return join(base, CONFIG_FILE); }
export function repoConfigPath(root: string): string { return join(root, REPO_CONFIG_DIR, REPO_CONFIG_FILE); }

/**
 * The nearest ancestor of `cwd` that holds a `.git` entry, by `lstat` alone: no `git` process, so a hook inside its 150 ms budget can call it.
 * Bounded to 32 levels. Its `.amem/config` (if any) is the repository's narrowing file.
 */
export function repoConfigRoot(cwd: string): string | undefined {
  try {
    for (let dir = cwd, depth = 0; depth < 32; dir = dirname(dir), depth++) {
      if (lstatSync(join(dir, ".git"), { throwIfNoEntry: false })) return dir;
      if (dir === dirname(dir)) return undefined;
    }
  } catch { /* unreadable: no repository file */ }
  return undefined;
}

/**
 * The home the machine configuration redirects to, read from the DEFAULT home's `amem.config.json` only (one level: a redirected home's own file
 * cannot redirect again, so there is no chain and no loop). Undefined when there is no file or it names no `home`. A malformed file throws.
 * That file is a pointer: it carries `home` and nothing else, and the policy lives in the file inside the home it names.
 */
export function configuredHome(defaultHome: string): string | undefined {
  const file = machineConfigPath(defaultHome), raw = readPlain(file, file);
  return raw === undefined ? undefined : parseFile(raw, file, MACHINE_KEYS).home;
}

const lower = (machine: number | undefined, repo: number | undefined) => machine === undefined ? repo : repo === undefined ? machine : Math.min(machine, repo);

/**
 * The effective configuration. The repository file can only narrow: its lists are added to the machine's, and a number counts only when it is
 * lower than the machine's (or the machine has none). It never carries `home` or `capture` (unknown key: an error), so it cannot move the
 * store or widen the disk bounds.
 */
export function loadAmemConfig(base: string, repoRoot?: string): LoadedConfig {
  const machinePath = machineConfigPath(base);
  const machineRaw = readPlain(machinePath, machinePath);
  const machine = machineRaw === undefined ? undefined : parseFile(machineRaw, machinePath, MACHINE_KEYS);
  let repo: ReturnType<typeof parseFile> | undefined, repoPath: string | null = null;
  if (repoRoot !== undefined) {
    const file = repoConfigPath(repoRoot), raw = readPlain(file, file);
    if (raw !== undefined) { repo = parseFile(raw, file, REPO_KEYS); repoPath = file; }
  }
  const union = (a: string[] | undefined, b: string[] | undefined) => [...new Set([...(a ?? []), ...(b ?? [])])];
  const denyPaths = union(machine?.denyPaths, repo?.denyPaths), piiPatterns = union(machine?.piiPatterns, repo?.piiPatterns);
  if (denyPaths.length > 64) fail(machinePath, "denyPaths and the repository's denyPaths name more than 64 entries together");
  if (piiPatterns.length > 64) fail(machinePath, "piiPatterns and the repository's piiPatterns name more than 64 entries together");
  const config: AmemConfig = { denyPaths, piiPatterns, capture: { ...(machine?.capture ?? {}) } };
  if (machine?.home !== undefined) config.home = machine.home;
  for (const key of ["briefBytes", "excerptBytes", "capturePaths"] as const) { const value = lower(machine?.[key], repo?.[key]); if (value !== undefined) config[key] = value; }
  return { config, source: { machine: machineRaw === undefined ? null : machinePath, repo: repoPath } };
}

/**
 * The standalone policy as configured. A host policy passed through the library still wins: it is composed in, never replaced, so the result
 * declines whatever either declines (`createStandalonePolicy` screens the config, then asks the host).
 */
export function configuredPolicyOptions(base: string, cwd?: string, options: StandalonePolicyOptions = {}): StandalonePolicyOptions {
  const { config } = loadAmemConfig(base, cwd === undefined ? undefined : repoConfigRoot(cwd));
  const merge = (a: readonly string[] | undefined, b: readonly string[]) => [...new Set([...(a ?? []), ...b])];
  return { ...options, denyPaths: merge(options.denyPaths, config.denyPaths), piiPatterns: merge(options.piiPatterns, config.piiPatterns) };
}
export function configuredPolicy(base: string, cwd?: string, options: StandalonePolicyOptions = {}): StandalonePolicy {
  return createStandalonePolicy(configuredPolicyOptions(base, cwd, options));
}
