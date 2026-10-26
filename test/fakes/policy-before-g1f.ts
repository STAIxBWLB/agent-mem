// Frozen from eb2ce39:src/memory/policy.ts; only helper import paths are relocated.
// Original source SHA-256: eb31339c5d74eddebd5e509cea307e052d9e9e0ff4838144ab39fcf032774213
import { posix } from "node:path";
import { types } from "node:util";
import { looksSecret } from "../../src/memory/screen.ts";
import { DENY_NAMES, DENY_SEGMENTS, isDenied } from "../../src/memory/platform.ts";
import { nodePath, pathCandidates } from "../../src/memory/project.ts";

/** True means the complete value is public. Hosts may narrow, never replace, standalone policy. */
export interface MemoryPolicy { screen(value: unknown): Promise<boolean> }
/**
 * The standalone policy. `screenStandalone` is its own part only (secrets, default PII, configured PII patterns and deny paths) as a synchronous
 * answer, for callers that cannot await (the store's promotion screen); it never asks the host, so a caller with a host uses `screen`.
 */
export interface StandalonePolicy extends MemoryPolicy {
  screenStandalone(value: unknown): boolean;
  /**
   * Only the personal-data and configured-pattern and deny-path part of `screenStandalone`, without the secret screen, for a caller that counts secrets
   * separately (the claude-mem import reports `pii` and `secret` skips as two numbers). True means the value names personal data or something configured.
   */
  declinesPersonal(text: string): boolean;
}
export interface StandalonePolicyOptions {
  denyPaths?: readonly string[];
  /** Case-insensitive literal substrings, not executable regular expressions. */
  piiPatterns?: readonly string[];
  host?: MemoryPolicy;
}

const MAX_DEPTH = 16, MAX_NODES = 4096, MAX_BYTES = 256 * 1024, MAX_STRING_BYTES = 16 * 1024;
export const fold = (text: string) => text.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").toLowerCase().replace(/\\/g, "/");
const flags = new Set(["private", "pii", "privateturn", "isprivate", "ispii"]);

/** Inspect descriptors, not getters/toJSON, and build the only value a host is allowed to see. */
function snapshot(value: unknown): { value: unknown; texts: string[] } | undefined {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>(), texts: string[] = [];
  const add = (text: string) => {
    const length = Buffer.byteLength(text);
    if (length > MAX_STRING_BYTES || (bytes += length) > MAX_BYTES) throw new Error("policy bound");
    texts.push(text);
  };
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new Error("policy bound");
    if (input === null || typeof input === "boolean") { bytes += 5; return input; }
    if (typeof input === "number") { if (!Number.isFinite(input)) throw new Error("policy shape"); bytes += 24; return input; }
    if (typeof input === "string") { add(input); return input; }
    if (!input || typeof input !== "object" || types.isProxy(input) || seen.has(input)) throw new Error("policy shape");
    const array = Array.isArray(input), prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("policy shape");
    if (Object.getOwnPropertySymbols(input).length) throw new Error("policy shape");
    seen.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (array) {
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length > MAX_NODES || Object.keys(descriptors).length !== length + 1) throw new Error("policy shape");
        const output: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("policy shape");
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      const output: Record<string, unknown> = Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!("value" in descriptor) || !descriptor.enumerable) throw new Error("policy shape");
        add(key);
        const flag = fold(key).replace(/[_-]/g, "");
        if (flags.has(flag) && descriptor.value !== false) throw new Error("private value");
        const item = visit(descriptor.value, depth + 1);
        // A secret may be split between a metadata key and its scalar value.
        if (typeof item === "string") add(`${key}: ${item}`);
        output[key] = item;
      }
      return output;
    } finally { seen.delete(input); }
  };
  try { const copy = visit(value, 0); return bytes <= MAX_BYTES ? { value: copy, texts } : undefined; }
  catch { return undefined; }
}

/** Safe structural data copy for optional readers, before any getters/toJSON can run. It is not a public verdict. */
export function memoryPolicySnapshot<T>(value: T): T | undefined { return snapshot(value)?.value as T | undefined; }

function literals(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 64 || Object.getOwnPropertySymbols(value).length) throw new Error(`invalid ${label}`);
  const descriptors = Object.getOwnPropertyDescriptors(value), result: string[] = [];
  if (Object.keys(descriptors).length !== value.length + 1) throw new Error(`invalid ${label}`);
  for (let i = 0; i < value.length; i++) {
    const item = descriptors[String(i)];
    if (!item || !("value" in item) || typeof item.value !== "string" || !item.value.trim() || Buffer.byteLength(item.value) > 256 || /[\x00-\x1f\x7f]/.test(item.value)) throw new Error(`invalid ${label}`);
    const normalized = fold(item.value);
    if (!normalized.trim()) throw new Error(`invalid ${label}`);
    result.push(normalized);
  }
  return [...new Set(result)];
}

function defaultPii(text: string): boolean {
  if (/\b(?:\d{6}-\d{7}|\d{3}-\d{2}-\d{4})\b/.test(text)) return true;
  // Bound each email candidate before matching; arbitrary user regexes are never run.
  for (const token of text.split(/[\s<>()\[\]{}",;:]+/)) if (token.includes("@")) {
    if (token.length > 320 || /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(token)) return true;
  }
  return false;
}

/** No filesystem, model, network or storage work occurs while constructing or screening this policy. */
export function createStandalonePolicy(options: StandalonePolicyOptions = {}): StandalonePolicy {
  if (!options || typeof options !== "object" || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype || Object.getOwnPropertySymbols(options).length) throw new Error("invalid standalone policy options");
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const [key, descriptor] of Object.entries(descriptors)) if (!["denyPaths", "piiPatterns", "host"].includes(key) || !("value" in descriptor)) throw new Error("invalid standalone policy options");
  const deny = literals(descriptors.denyPaths?.value, "deny paths").map(path => posix.normalize(path));
  const pii = literals(descriptors.piiPatterns?.value, "PII patterns");
  const host = descriptors.host?.value as MemoryPolicy | undefined;
  if (host !== undefined && (!host || typeof host.screen !== "function")) throw new Error("invalid host policy");
  // ponytail: retain at most 512 exact strings / 64 KiB per immutable policy configuration.
  // Evict the batch when full; a measured need for better hit rates can upgrade this to an LRU.
  const textChecks = new Map<string, boolean>(); let textBytes = 0;
  let defaultDenyRevision = "";
  const publicText = (text: string): boolean => {
    const cached = textChecks.get(text);
    if (cached !== undefined) return cached;
    const check = () => {
      if (looksSecret(text) || looksSecret(text.replace(/["']/g, ""))) return false;
      const normalized = fold(text);
      if (defaultPii(normalized) || pii.some(pattern => normalized.includes(pattern))) return false;
      const candidates = normalized.includes("/") || /\.[a-z]/.test(normalized) ? pathCandidates(normalized) : [];
      const paths = [normalized, nodePath(normalized), ...candidates, ...normalized.split(/[\s"'`(){}\[\],;:=<>]+/)];
      return ![...new Set(paths)].some(path => path && isDenied(posix.normalize(path), deny));
    };
    const allowed = check(), bytes = Buffer.byteLength(text);
    if (bytes <= 1024) {
      if (textChecks.size >= 512 || textBytes + bytes > 64 * 1024) { textChecks.clear(); textBytes = 0; }
      textChecks.set(text, allowed); textBytes += bytes;
    }
    return allowed;
  };
  const standalone = (value: unknown): { ok: boolean; value?: unknown } => {
    try {
      // The exported default lists can be tightened by a host between calls.
      const revision = JSON.stringify([DENY_NAMES, DENY_SEGMENTS]);
      if (revision !== defaultDenyRevision) { textChecks.clear(); textBytes = 0; defaultDenyRevision = revision; }
      const complete = snapshot(value);
      if (!complete) return { ok: false };
      // Only pure text checks are reused. Shape/bounds/private flags and the host's detached
      // snapshot are fresh on every call; no row or host verdict is cached.
      for (const text of complete.texts) if (!publicText(text)) return { ok: false };
      return { ok: true, value: complete.value };
    } catch { return { ok: false }; }
  };
  const personal = (text: string): boolean => {
    const normalized = fold(text);
    if (defaultPii(normalized) || pii.some(pattern => normalized.includes(pattern))) return true;
    const candidates = normalized.includes("/") || /\.[a-z]/.test(normalized) ? pathCandidates(normalized) : [];
    const paths = [normalized, nodePath(normalized), ...candidates, ...normalized.split(/[\s"'`(){}\[\],;:=<>]+/)];
    return paths.some(path => path && isDenied(posix.normalize(path), deny));
  };
  return {
    screenStandalone: value => standalone(value).ok,
    declinesPersonal: text => personal(text),
    async screen(value: unknown): Promise<boolean> {
      try {
        const own = standalone(value);
        if (!own.ok) return false;
        return host === undefined || await host.screen(own.value) === true;
      } catch { return false; }
    },
  };
}
