import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync, fsyncSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { FORMAT_SURFACES, FORMATS_FILE, readFormatFloors, type FormatFloor } from "./formats.ts";
import { acquireMutation } from "./mutation.ts";
import { realPath } from "./platform.ts";

/**
 * #431 AC6: `amem formats raise <surface> <minReader> [--confirm]`. The preview names the exact record and every writer this home
 * knows about; the raise appends that one record and refuses while any known writer is below `minReader`. A writer whose version
 * cannot be read refuses too: an unproven writer is treated as below. Records are never rewritten or removed.
 */
const PLAIN = /^(\d+)\.(\d+)\.(\d+)$/;
const MAX_WRITERS = 256, PACKAGE_BYTES = 64 * 1024, MAX_ANCESTORS = 12;
export type FormatRaiseSurface = typeof FORMAT_SURFACES[number] | "home";
export interface FormatWriter { source: "setup" | "sync-placement" | "running" | "library-host" | "self"; root: string; version: string | null; pid?: number; host?: string }
/** `processArgs`: the process table's argument lines, when it could be read; without them no root is retired as absent. */
export interface FormatWriterInventory { writers: FormatWriter[]; incomplete: string[]; processArgs?: readonly string[] }
export interface FormatRaisePlan {
  /** #660: `absent` lists setup and placement inventory roots removed from disk that no live process runs from; they cannot write here and are not counted. */
  home: string; file: string; record: FormatFloor; writers: FormatWriter[]; below: FormatWriter[]; absent: FormatWriter[]; incomplete: string[];
  existing: FormatFloor[]; alreadyAtLeast: boolean; ready: boolean;
}

const parts = (version: string) => PLAIN.exec(version)!.slice(1, 4).map(Number);
export function versionBelow(version: string, floor: string): boolean {
  const a = parts(version), b = parts(floor);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/**
 * #634/#660: an install whose root no longer exists (ENOENT or ENOTDIR on the root itself). An existing root with a missing or
 * unreadable package.json is not absent: it can still run, so a floor check keeps refusing it.
 */
export function installAbsent(root: string): boolean {
  try { lstatSync(root); return false; } catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ENOTDIR"; }
}

/** The version of an amem install root, or null when it is not a readable `@staix/agent-mem` package with a plain release version. */
export function installVersion(root: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(join(root, "package.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > PACKAGE_BYTES) return null;
    const data = Buffer.alloc(stat.size); let at = 0;
    while (at < data.length) { const n = readSync(fd, data, at, data.length - at, at); if (n <= 0) return null; at += n; }
    const value = JSON.parse(data.toString("utf8")) as { name?: unknown; version?: unknown };
    return value.name === "@staix/agent-mem" && typeof value.version === "string" && PLAIN.test(value.version) ? value.version : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Install roots of running processes that load agent-mem: an amem CLI (`<root>/bin/amem.js` or `<root>/src/cli.ts`), or a host that embeds
 * it as a library (ahub, vmem), found as `node_modules/@staix/agent-mem` in an ancestor of a script path on its command line. Bounded.
 * `embedded(dir)` answers whether `dir/node_modules/@staix/agent-mem` exists; it defaults to the filesystem.
 */
const defaultEmbedded = (dir: string) => existsSync(join(dir, "node_modules", "@staix", "agent-mem", "package.json"));
/** #660: the `node_modules/@staix/agent-mem` in the nearest of a script's ancestors (at most MAX_ANCESTORS), or null. Bounded, no crawl. */
export function embeddedAmemRoot(script: string, embedded: (dir: string) => boolean = defaultEmbedded, memo = new Map<string, string | null>()): string | null {
  let dir = dirname(script);
  for (let depth = 0; depth < MAX_ANCESTORS && dir !== dirname(dir); depth++, dir = dirname(dir)) {
    if (memo.has(dir)) return memo.get(dir)!;
    let found: string | null = null;
    try { if (embedded(dir)) found = join(dir, "node_modules", "@staix", "agent-mem"); } catch { /* unreadable: look further up */ }
    if (found) { memo.set(dir, found); return found; }
  }
  return null;
}
export function runningAmemRoots(table: () => string, embedded: (dir: string) => boolean = defaultEmbedded): { pid: number; root: string; host?: string }[] {
  const out: { pid: number; root: string; host?: string }[] = [], memo = new Map<string, string | null>();
  const library = (script: string) => embeddedAmemRoot(script, embedded, memo);
  for (const line of table().split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line); if (!match) continue;
    const pid = Number(match[1]); if (pid === process.pid) continue;
    const tokens = match[2]!.split(/\s+/);
    const cli = tokens.map(token => /^(\/.+)\/(?:bin\/amem\.js|src\/cli\.ts)$/.exec(token)).find(Boolean);
    if (cli) out.push({ pid, root: cli[1]! });
    else for (const token of tokens) {
      if (!token.startsWith("/") || !/\.(?:[cm]?[jt]s)$/.test(token)) continue;
      const root = library(token); if (!root) continue;
      out.push({ pid, root, host: token }); break;
    }
    if (out.length >= MAX_WRITERS) break;
  }
  return out;
}

export function planFormatRaise(home: string, surface: string, minReader: string, inventory: FormatWriterInventory, now: () => Date = () => new Date()): FormatRaisePlan {
  if (surface !== "home" && !(FORMAT_SURFACES as readonly string[]).includes(surface)) throw new Error(`unknown format surface ${surface}; use one of home, ${FORMAT_SURFACES.join(", ")}`);
  if (!PLAIN.test(minReader)) throw new Error("minReader must be a plain release version such as 0.27.0");
  const base = realPath(home), existing = readFormatFloors(base) ?? [];
  const record: FormatFloor = { surface, minReader, since: now().toISOString().slice(0, 10) };
  const live = new Set(inventory.writers.filter(writer => writer.source === "running" || writer.source === "library-host" || writer.source === "self").map(writer => writer.root));
  // A deleted bundle can still be loaded by a surviving host: an argument under the root, or a host script whose bounded
  // ancestor layout (the one discovery uses) places this root as its embedded bundle, keeps it counted.
  const scripts = inventory.processArgs?.flatMap(line => line.split(/\s+/).filter(token => token.startsWith("/"))) ?? [];
  const referenced = (root: string) => inventory.processArgs!.some(line => line.includes(`${root}/`))
    || scripts.some(script => embeddedAmemRoot(script, dir => join(dir, "node_modules", "@staix", "agent-mem") === root) === root);
  const absent = inventory.processArgs === undefined ? [] : inventory.writers.filter(writer => (writer.source === "setup" || writer.source === "sync-placement") && writer.version === null
    && !live.has(writer.root) && installAbsent(writer.root) && !referenced(writer.root));
  const below = inventory.writers.filter(writer => !absent.includes(writer) && (writer.version === null || versionBelow(writer.version, minReader)));
  const alreadyAtLeast = existing.some(floor => floor.surface === surface && PLAIN.test(floor.minReader) && !versionBelow(floor.minReader, minReader));
  return { home: base, file: join(base, FORMATS_FILE), record, writers: inventory.writers, below, absent, incomplete: inventory.incomplete, existing, alreadyAtLeast,
    ready: !below.length && !inventory.incomplete.length && !alreadyAtLeast };
}

export function formatRaiseRefusal(plan: FormatRaisePlan): string | undefined {
  if (plan.alreadyAtLeast) return `formats.json already records a ${plan.record.surface} floor at or above ${plan.record.minReader}; nothing to raise`;
  if (plan.incomplete.length) return `the writer inventory is incomplete (${plan.incomplete.join("; ")}); fix it before raising a floor`;
  if (plan.below.length) return `writers below ${plan.record.minReader}: ${plan.below.map(writer => `${writer.source} ${writer.root}${writer.pid ? ` (pid ${writer.pid}${writer.host ? `, ${writer.host}` : ""})` : ""} at ${writer.version ?? "unknown version"}`).join("; ")}. Upgrade or stop them, then rerun`;
  return undefined;
}

/** Appends the planned record under the home's mutation fence after rechecking the floors and the inventory are unchanged. */
export function applyFormatRaise(plan: FormatRaisePlan, recheck: () => FormatRaisePlan): FormatFloor {
  const refusal = formatRaiseRefusal(plan); if (refusal) throw new Error(refusal);
  const release = acquireMutation(plan.home); if (!release) throw new Error("another memory writer holds this home; rerun when it finishes");
  try {
    const fresh = recheck();
    if (JSON.stringify(fresh.existing) !== JSON.stringify(plan.existing) || JSON.stringify(fresh.writers) !== JSON.stringify(plan.writers)) throw new Error("formats.json or the writer inventory changed since the preview; rerun the preview");
    const again = formatRaiseRefusal(fresh); if (again) throw new Error(again);
    const stat = lstatSync(plan.file, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error(`${plan.file} is not a regular file`);
    const text = JSON.stringify([...plan.existing, plan.record], null, 2) + "\n", temporary = join(dirname(plan.file), `.${FORMATS_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      const fd = openSync(temporary, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, plan.file);
    } catch (error) { rmSync(temporary, { force: true }); throw error; }
    const read = readFormatFloors(plan.home) ?? [];
    if (JSON.stringify(read.at(-1)) !== JSON.stringify(plan.record)) throw new Error("formats.json did not read back the appended record");
    return plan.record;
  } finally { release(); }
}
