#!/usr/bin/env bun
// NONSHIPPING, one construction attempt. No retries, no cleanup, no production source edits.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const arg = (key: string) => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const childFile = arg("--child-db"), outArg = arg("--out");
const ceiling = 1024 * 1024, magic = Buffer.from("d9d505f920a163d7", "hex");
function requireValue(ok: unknown, reason: string): asserts ok { if (!ok) throw Error(reason); }
function errorClass(e: unknown) { const x = e as { name?: unknown; code?: unknown; errno?: unknown }; return {
  name: ["Error", "SystemError", "SQLiteError", "TypeError"].includes(String(x?.name)) ? String(x.name) : "other",
  code: ["SQLITE_BUSY", "SQLITE_IOERR", "SQLITE_READONLY", "SQLITE_CORRUPT", "EACCES", "ENOSPC", "EIO", "ENOENT"].includes(String(x?.code)) ? String(x.code) : "other",
  errno: typeof x?.errno === "number" ? x.errno : null,
}; }
function raw(file: string, copy: string) {
  if (!existsSync(file)) return { exists: false as const };
  const stat = statSync(file); requireValue(stat.size <= ceiling, "fixture file exceeds unchanged 1 MiB ceiling");
  const bytes = readFileSync(file); writeFileSync(copy, bytes, { mode: 0o600, flag: "wx" });
  let encodedPageSize: number | null = bytes.length >= 18 ? bytes.readUInt16BE(16) : null;
  if (encodedPageSize === 1) encodedPageSize = 65536;
  const magicOffsets: number[] = [];
  for (let at = bytes.indexOf(magic); at >= 0 && magicOffsets.length < 32; at = bytes.indexOf(magic, at + 1)) magicOffsets.push(at);
  return { exists: true as const, size: stat.size, sha256: createHash("sha256").update(bytes).digest("hex"),
    mode: stat.mode & 0o777, nlink: stat.nlink, first64Hex: bytes.subarray(0, 64).toString("hex"),
    magicOffsets, encodedPageSize: copy.endsWith(".db") ? encodedPageSize : null,
    journalHeader: copy.endsWith(".journal") && bytes.length >= 28 ? { magicHex: bytes.subarray(0, 8).toString("hex"), records: bytes.readUInt32BE(8), nonce: bytes.readUInt32BE(12), originalPages: bytes.readUInt32BE(16), sectorSize: bytes.readUInt32BE(20), pageSize: bytes.readUInt32BE(24) } : null,
    // Sector-aligned probes distinguish a zero first header from a later segment containing magic.
    sectorPrefixes: Array.from({ length: Math.min(32, Math.ceil(bytes.length / 512)) }, (_, i) => ({ offset: i * 512, hex: bytes.subarray(i * 512, i * 512 + 28).toString("hex") })),
  };
}

if (childFile) {
  requireValue(outArg, "child requires artifact directory"); const out = resolve(outArg);
  let stage = "open";
  try {
    const db = new Database(childFile);
    const read = (pragma: string) => db.query(`PRAGMA ${pragma}`).get();
    const baseline = { sqlite: db.query("SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId").get(),
      compileOptions: db.query("PRAGMA compile_options").all(), beforeCache: read("main.cache_size"), beforeSpill: read("main.cache_spill"),
      pageSize: read("main.page_size"), journalMode: read("journal_mode"), synchronous: read("synchronous"),
      fullfsync: read("fullfsync"), lockingMode: read("locking_mode"), mmapSize: read("mmap_size") };
    stage = "seed";
    const put = db.query("INSERT INTO fallback VALUES (?,?)");
    db.transaction(() => { for (let i = 0; i < 1000; i++) put.run(i.toString(16).padStart(64, "0"), "2026-11-04T00:00:00.000Z"); })();
    const committed = raw(childFile, join(out, "seed-committed.db"));
    const spill = Number(arg("--spill") ?? "1"), cache = Number(arg("--cache") ?? "1");
    requireValue(Number.isSafeInteger(spill) && spill > 0 && spill <= 32 && Number.isSafeInteger(cache) && cache > 0 && cache <= 32, "invalid bounded fixture cache settings");
    db.run(`PRAGMA main.cache_size = ${cache}`); db.run(`PRAGMA main.cache_spill = ${spill}`);
    const configured = { cache: read("main.cache_size"), spill: read("main.cache_spill"), pageCount: read("main.page_count"),
      seedRows: db.query("SELECT COUNT(*) AS count FROM fallback").get(), databaseList: read("database_list") };
    writeSync(1, JSON.stringify({ stage: "configured", baseline, configured, committed }) + "\n");
    stage = "begin"; db.run("BEGIN IMMEDIATE");
    stage = "cursor-update"; db.run("UPDATE cursor SET offset = 1");
    const afterCursor = { db: raw(childFile, join(out, "cursor-uncommitted.db")), journal: raw(childFile + "-journal", join(out, "cursor-uncommitted.journal")) };
    stage = "fallback-update";
    if (arg("--dirty") === "stepped") {
      const update = db.query("UPDATE fallback SET at = ? WHERE digest = ?");
      for (let i = 0; i < 1000; i++) update.run("2099-01-01T00:00:00.000Z", i.toString(16).padStart(64, "0"));
    } else db.run("UPDATE fallback SET at='2099-01-01T00:00:00.000Z'");
    stage = "updated";
    const updated = { changedRows: db.query("SELECT COUNT(*) AS count FROM fallback WHERE at='2099-01-01T00:00:00.000Z'").get(),
      cursor: db.query("SELECT offset FROM cursor WHERE id=1").get(), db: raw(childFile, join(out, "pre-kill.db")), journal: raw(childFile + "-journal", join(out, "pre-kill.journal")) };
    writeFileSync(join(out, "child-state.json"), JSON.stringify({ baseline, configured, afterCursor, updated }, null, 2) + "\n", { mode: 0o600 });
    writeSync(1, JSON.stringify({ stage: "kill-ready", updated }) + "\n");
    process.kill(process.pid, "SIGKILL");
    throw Error("SIGKILL unexpectedly returned");
  } catch (e) { writeSync(2, JSON.stringify({ stage, error: errorClass(e) }) + "\n"); process.exit(2); }
}

const checkoutArg = arg("--repo"); requireValue(checkoutArg, "usage: bun one-hot-journal-diagnostic.ts --repo /checkout --out /scratch-output [--dirty bulk|stepped] [--cache 1] [--spill 1]");
const checkout = resolve(checkoutArg), out = resolve(outArg ?? mkdtempSync(join(tmpdir(), "task125-one-hot-")));
requireValue(out !== checkout && !out.startsWith(checkout + "/"), "artifact directory must be outside the checkout");
mkdirSync(out, { recursive: true, mode: 0o700 });
const home = join(out, "synthetic-home"); mkdirSync(home, { recursive: true, mode: 0o700 });
Object.assign(process.env, { HOME: home, AMEM_HOME: join(home, "memory"), AGENTHUB_HOME: join(home, "hub"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
const moduleFile = join(checkout, "src/hook-transcript.ts"), source = readFileSync(moduleFile, "utf8");
requireValue(source.split("function cursorDatabase(").length === 2, "cursor helper anchor changed");
Bun.plugin({ name: "task125-one-hot-export-only", setup(b) { b.onLoad({ filter: /[/]hook-transcript\.ts$/ }, ({ path }) => {
  if (resolve(path) !== moduleFile) return; return { loader: "ts", contents: source + "\nexport { cursorDatabase as task125OneHotCursor };\n" };
}); } });
const target = await import(pathToFileURL(moduleFile).href) as { task125OneHotCursor: (file: string, dev: string, ino: string, size: number) => Database };
const dbfile = join(out, "cursor.db"); requireValue(!existsSync(dbfile), "artifact directory already contains cursor.db; select a fresh directory");
target.task125OneHotCursor(dbfile, "1", "1", 1024).close();
const result = Bun.spawnSync([process.execPath, "--smol", fileURLToPath(import.meta.url), "--child-db", dbfile, "--out", out,
  "--cache", arg("--cache") ?? "1", "--spill", arg("--spill") ?? "1", "--dirty", arg("--dirty") ?? "bulk"], {
  env: { PATH: process.env.PATH ?? "", HOME: home, AMEM_HOME: join(home, "memory"), AGENTHUB_HOME: join(home, "hub"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  stdout: "pipe", stderr: "pipe", timeout: 5000, maxBuffer: 128 * 1024,
});
writeFileSync(join(out, "child.stdout.log"), result.stdout, { mode: 0o600 });
writeFileSync(join(out, "child.stderr.log"), result.stderr, { mode: 0o600 });
const post = { db: raw(dbfile, join(out, "post-exit.db")), journal: raw(dbfile + "-journal", join(out, "post-exit.journal")) };
let changedPages: { pageSize: number; beforeBytes: number; afterBytes: number; pages: number[] } | null = null;
if (existsSync(join(out, "seed-committed.db"))) {
  const before = readFileSync(join(out, "seed-committed.db")), after = readFileSync(join(out, "post-exit.db"));
  let pageSize = before.readUInt16BE(16); if (pageSize === 1) pageSize = 65536;
  requireValue(pageSize >= 512 && pageSize <= 65536, "invalid seed database page size");
  const pages: number[] = [];
  for (let at = 0; at < Math.max(before.length, after.length); at += pageSize) if (!before.subarray(at, at + pageSize).equals(after.subarray(at, at + pageSize))) pages.push(at / pageSize + 1);
  changedPages = { pageSize, beforeBytes: before.length, afterBytes: after.length, pages };
}
const stdoutRows = result.stdout.toString().split("\n").filter(Boolean).map(line => JSON.parse(line));
const killed = result.signalCode === "SIGKILL" && stdoutRows.some(x => x.stage === "kill-ready") && result.stderr.length === 0;
const journal = post.journal;
const hotCandidate = killed && journal.exists && journal.size > 512 && journal.journalHeader?.magicHex === magic.toString("hex");
writeFileSync(join(out, "construction.json"), JSON.stringify({ killed, hotCandidate, post, changedPages }, null, 2) + "\n", { mode: 0o600 });
// File copies above precede ANY SQLite recovery. No helper open when construction is invalid.
let recovery: unknown = null;
if (hotCandidate) {
  let db: Database | undefined;
  try { const began = performance.now(); db = target.task125OneHotCursor(dbfile, "1", "1", 1024); const elapsedMs = performance.now() - began;
    const cursor = db.query("SELECT offset FROM cursor WHERE id=1").get() as { offset: number };
    const original = db.query("SELECT COUNT(*) AS count FROM fallback WHERE at='2026-11-04T00:00:00.000Z'").get() as { count: number };
    const changed = db.query("SELECT COUNT(*) AS count FROM fallback WHERE at='2099-01-01T00:00:00.000Z'").get() as { count: number };
    recovery = { elapsedMs, cursor, original, changed, passed: cursor.offset === 0 && original.count === 1000 && changed.count === 0 };
  } catch (e) { recovery = { passed: false, error: errorClass(e) }; } finally { db?.close(); }
}
const report = { diagnostic: "task125-one-hot", bun: Bun.version, platform: process.platform, arch: process.arch,
  sourceSha256: createHash("sha256").update(source).digest("hex"), signal: result.signalCode, exitCode: result.exitCode,
  stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length, killed, hotCandidate, post, changedPages, recovery, acceptance: false,
  note: "One injected construction attempt; all raw files retained; no timing/hosted root-cause acceptance" };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report));
process.exit(hotCandidate && (recovery as { passed: boolean } | null)?.passed ? 0 : 1);
