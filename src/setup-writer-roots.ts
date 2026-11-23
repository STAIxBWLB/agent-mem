import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { types } from "node:util";
import { realPath } from "./memory/platform.ts";
import { mcpLauncher, mcpRecord, type ConfigImage } from "./setup-owned.ts";
import { SETUP_CONFIG_BYTES } from "./setup-toml.ts";

/**
 * #592: the setup-receipt reader the placement writer inventory needs, split out of setup.ts so that sync and
 * placement modules never import setup's human report (and with it a runtime dependency). setup.ts re-exports all of it.
 */
export const SETUP_TARGETS = ["claude", "codex", "kimi", "pi", "qwen", "jcode", "opencode", "gemini", "agy"] as const;
export type SetupTarget = typeof SETUP_TARGETS[number];
const MAX = SETUP_CONFIG_BYTES;
export const JOURNAL_MAX = 12 * MAX;
type Image = ConfigImage;
interface Change { key: string; path: string; before: Image; after: Image; start?: Image }
interface DirectoryIdentity { dev: number; ino: number }
export interface Receipt { createdDirectory?: DirectoryIdentity; version: 1 | 2; target: SetupTarget; intent: string; phase: "prepared" | "applied"; changes: Change[] }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("setup configuration must be an object");
  return value as Record<string, unknown>;
}
export function decodeReceipt(value: Record<string, unknown>, target: SetupTarget, count: number, strict = false): Receipt {
  if (strict && Object.keys(value).some(key => !["version", "target", "intent", "phase", "changes", "createdDirectory"].includes(key))) throw Error("setup receipt invalid");
  if (value.version !== 1 && value.version !== 2) throw Error("setup receipt version is unsupported; run setup or undo with the release that wrote it");
  if (value.target !== target || typeof value.intent !== "string" || !/^[a-f0-9]{64}$/.test(value.intent) || strict && value.intent.length !== 64 || !["prepared", "applied"].includes(String(value.phase)) || !Array.isArray(value.changes) || value.changes.length !== count && !(target === "jcode" && value.changes.length === 1)) throw Error("setup receipt does not match this installation");
  for (let i = 0; i < value.changes.length; i++) {
    const change = record(value.changes[i]);
    if (change.key !== `${target}:${i}` || strict && (Object.keys(change).some(key => !["key", "path", "before", "after", "start"].includes(key)) || typeof change.path !== "string" || !isAbsolute(change.path) || change.path.length > 4096 || change.path.includes("\0"))) throw Error("setup receipt target mismatch");
    for (const key of ["before", "after", ...(change.start !== undefined ? ["start"] : [])]) {
      const v = record(change[key]);
      if (strict && Object.keys(v).sort().join() !== "bytes,mode" || !Number.isInteger(v.mode) || Number(v.mode) < 0 || Number(v.mode) > 0o777 || v.bytes !== null && (typeof v.bytes !== "string" || v.bytes.length > 2 * MAX || strict && (v.bytes.length > Math.ceil(MAX / 3) * 4 || v.bytes.length / 4 * 3 - (v.bytes.endsWith("==") ? 2 : v.bytes.endsWith("=") ? 1 : 0) > MAX) || Buffer.from(v.bytes, "base64").toString("base64") !== v.bytes)) throw Error("setup receipt invalid");
    }
  }
  if (value.createdDirectory !== undefined) {
    const created = record(value.createdDirectory);
    if (target !== "agy" || Object.keys(created).sort().join() !== "dev,ino" || !Number.isSafeInteger(created.dev) || Number(created.dev) < 0 || !Number.isSafeInteger(created.ino) || Number(created.ino) <= 0) throw Error("setup receipt directory ownership invalid");
  }
  return value as unknown as Receipt;
}

/**
 * #520: the fixed remedy for a receipt whose recorded amem install no longer exists, shared by setup, the placement
 * sync refusal, doctor and the marked diagnostic. It names the target and both commands, never the recorded path.
 */
export function setupReceiptRemedy(target: SetupTarget, applied = false): string {
  return `the ${applied ? "applied " : ""}${target} setup receipt names an amem install that no longer exists; run amem setup ${target} --apply to refresh the receipt or amem setup ${target} --undo to remove it`;
}
/**
 * Fixed safe category only; receipt text, native paths and external error messages are never diagnostics.
 * `target` is set only when an applied receipt names a runtime root whose absence was positively identified, so the
 * refusal can name the setup target and its remedy without exposing the recorded path (#520).
 */
export class SetupWriterRootsError extends Error {
  readonly code = "setup_writer_roots_unavailable";
  constructor(readonly category: "unsafe" | "changed" | "bound" | "unsupported" | "pending" | "unavailable", readonly target?: SetupTarget) {
    super(target
      ? `Setup writer inventory: ${setupReceiptRemedy(target, true)}.`
      : `Setup writer inventory ${category}; inspect setup receipts and rerun setup before activation.`);
    this.name = "SetupWriterRootsError";
  }
}
/** Current managed MCP AFTER images only. Native configuration paths and historical BEFORE/START images are never opened. */
export function readSetupWriterRoots(home: string): string[] {
  function fail(category: SetupWriterRootsError["category"], target?: SetupTarget): never { throw new SetupWriterRootsError(category, target); }
  try {
    const owned = (stat: BigIntStats) => { if (stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o077n) !== 0n) fail("unsafe"); };
    const stamp = (stat: BigIntStats) => JSON.stringify([stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String));
    const base = lstatSync(home, { bigint: true, throwIfNoEntry: false }); if (!base) return []; owned(base); if (!base.isDirectory()) fail("unsafe");
    const directory = join(home, "setup"), initial = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    if (!initial) return [];
    owned(initial); if (!initial.isDirectory()) fail("unsafe");
    // ponytail:256 setup namespace entries and doctor's existing32MiB aggregate receipt-byte ceiling.
    // A reviewed metadata-only setup inventory is required before increasing either ceiling.
    const files: { name: string; stat: BigIntStats }[] = [], namespace: string[] = [], iterator = opendirSync(directory);
    let entries = 0, totalBytes = 0;
    try { for (;;) {
      const entry = iterator.readSync(); if (!entry) break;
      namespace.push(entry.name);
      if (++entries > 256) fail("bound"); if (entry.name === "setup.lock") fail("pending");
      if (!entry.name.endsWith(".json")) continue; // Retained .json.stale-* and unregistered temps are historical, never current authority.
      const stat = lstatSync(join(directory, entry.name), { bigint: true }); owned(stat); if (!stat.isFile() || stat.nlink !== 1n) fail("unsafe");
      if (stat.size > BigInt(JOURNAL_MAX) || totalBytes + Number(stat.size) > 32 * 1024 * 1024) fail("bound");
      totalBytes += Number(stat.size); files.push({ name: entry.name, stat });
    } } finally { iterator.closeSync(); }
    const roots = new Set<string>(), launchers: { entry: string; root: string }[] = [];
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const target = (file.name.startsWith("agy-") && /^agy-[a-f0-9]{64}\.json$/.test(file.name) ? "agy" : file.name.slice(0, -5)) as SetupTarget;
      if (!SETUP_TARGETS.includes(target) || target === "agy" && !/^agy-[a-f0-9]{64}\.json$/.test(file.name)) fail("unsupported");
      const path = join(directory, file.name), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let text: string;
      try {
        const opened = fstatSync(fd, { bigint: true }); owned(opened); if (!opened.isFile() || opened.nlink !== 1n || stamp(opened) !== stamp(file.stat)) fail("changed");
        const data = Buffer.alloc(Number(opened.size) + 1); let count = 0;
        while (count < data.length) { const n = readSync(fd, data, count, data.length - count, count); if (!n) break; count += n; }
        if (count !== Number(opened.size) || stamp(fstatSync(fd, { bigint: true })) !== stamp(opened) || stamp(lstatSync(path, { bigint: true })) !== stamp(opened)) fail("changed");
        text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, count));
      } finally { closeSync(fd); }
      const counts: Record<SetupTarget, number> = { claude: 2, codex: 2, kimi: 2, pi: 2, qwen: 1, jcode: 2, opencode: 1, gemini: 1, agy: 1 };
      let value: Receipt;
      try { value = decodeReceipt(record(JSON.parse(text)), target, counts[target], true); } catch { return fail("unsupported"); }
      if (value.phase !== "applied") fail("pending");
      const runtime = mcpLauncher(mcpRecord(target, value.changes[0]!.after), target);
      if (!runtime || runtime.bun.includes("\0") || runtime.entry.length > 4096 || runtime.entry.includes("\0") || !["/bin/amem.js", "/src/cli.ts"].some(suffix => runtime.entry.endsWith(suffix))
        || target === "opencode" && [runtime.bun, runtime.entry].some(value => /\{(?:env|file):/.test(value))) fail("unsupported");
      // #520: only a positively identified ENOENT/ENOTDIR for the recorded root names its setup target; a non-directory,
      // a permission error and every other unreadable state stay anonymous.
      let root: string;
      try { root = realPath(dirname(dirname(runtime.entry))); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") fail("unavailable", target);
        fail("unavailable");
      }
      if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) fail("unavailable");
      roots.add(root); launchers.push({ entry: runtime.entry, root });
    }
    const finalHome = lstatSync(home, { bigint: true }); owned(finalHome);
    if (!finalHome.isDirectory() || stamp(lstatSync(directory, { bigint: true })) !== stamp(initial) || finalHome.dev !== base.dev || finalHome.ino !== base.ino) fail("changed");
    const finalNames: string[] = [], finalDirectory = opendirSync(directory);
    try { for (;;) { const entry = finalDirectory.readSync(); if (!entry) break; if (finalNames.length >= namespace.length) fail("changed"); finalNames.push(entry.name); } }
    finally { finalDirectory.closeSync(); }
    if (JSON.stringify(finalNames.sort()) !== JSON.stringify(namespace.sort())) fail("changed");
    for (const file of files) if (stamp(lstatSync(join(directory, file.name), { bigint: true })) !== stamp(file.stat)) fail("changed");
    for (const runtime of launchers) if (realPath(dirname(dirname(runtime.entry))) !== runtime.root) fail("changed");
    return [...roots].sort();
  } catch (error) {
    if (error && typeof error === "object" && !types.isProxy(error) && error instanceof SetupWriterRootsError) {
      const category = Object.getOwnPropertyDescriptor(error, "category"), target = Object.getOwnPropertyDescriptor(error, "target")?.value;
      if (category && "value" in category && ["unsafe", "changed", "bound", "unsupported", "pending", "unavailable"].includes(category.value))
        throw new SetupWriterRootsError(category.value, typeof target === "string" && (SETUP_TARGETS as readonly string[]).includes(target) ? target as SetupTarget : undefined);
    }
    throw new SetupWriterRootsError("unavailable");
  }
}
